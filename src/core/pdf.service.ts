import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile, spawnSync } from 'child_process';
const PDFDocument = require('pdfkit');

@Injectable()
export class PdfService {
  private cachedPythonExec: string | null = null;

  /**
   * Resolves a working Python executable path or command name.
   * Priority:
   * 1. process.env.PYTHON_BIN
   * 2. process.env.PYTHON_PATH
   * 3. 'python3' (Linux / Hostinger standard)
   * 4. 'python' (Windows / Local standard)
   * 5. 'py' (Windows launcher)
   * 6. Common Linux system paths (/usr/bin/python3, /usr/local/bin/python3, /usr/bin/python)
   */
  getPythonExecutable(forceRefresh = false): string {
    if (!forceRefresh && this.cachedPythonExec) {
      return this.cachedPythonExec;
    }

    const candidates: string[] = [];

    if (process.env.PYTHON_BIN && process.env.PYTHON_BIN.trim()) {
      candidates.push(process.env.PYTHON_BIN.trim());
    }
    if (process.env.PYTHON_PATH && process.env.PYTHON_PATH.trim()) {
      candidates.push(process.env.PYTHON_PATH.trim());
    }

    candidates.push(
      'python3',
      'python',
      'py',
      '/usr/bin/python3',
      '/usr/local/bin/python3',
      '/usr/bin/python',
    );

    for (const candidate of candidates) {
      if (this.isPythonExecutableValid(candidate)) {
        this.cachedPythonExec = candidate;
        return candidate;
      }
    }

    throw new Error(
      `Python executable not found. Tested environment variables (PYTHON_BIN, PYTHON_PATH) and system binaries (${candidates.join(
        ', ',
      )}). ` +
        `Please ensure Python 3 is installed and accessible in PATH, or set the PYTHON_BIN environment variable to your Python executable path.`,
    );
  }

  private isPythonExecutableValid(cmd: string): boolean {
    try {
      if (path.isAbsolute(cmd) && !fs.existsSync(cmd)) {
        return false;
      }

      const res = spawnSync(cmd, ['--version'], {
        encoding: 'utf-8',
        timeout: 5000,
        shell: false,
      });

      if (res.error || res.status !== 0) {
        return false;
      }

      const output = `${res.stdout || ''} ${res.stderr || ''}`;

      // Reject Windows App Execution Alias redirect notice ("Python was not found...")
      if (
        output.includes('Python was not found') ||
        output.includes('App execution aliases')
      ) {
        return false;
      }

      if (output.toLowerCase().includes('python')) {
        return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  private resolveScriptPath(scriptName: string): string {
    const possibleScriptPaths = [
      path.join(process.cwd(), 'scripts', scriptName),
      path.join(process.cwd(), 'dist', 'scripts', scriptName),
      path.join(__dirname, '..', 'scripts', scriptName),
      path.join(__dirname, '..', '..', 'scripts', scriptName),
      path.join(__dirname, '..', '..', '..', 'scripts', scriptName),
      path.join(__dirname, 'scripts', scriptName),
    ];

    for (const p of possibleScriptPaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    return possibleScriptPaths[0];
  }

  private resolveMediaRoot(): string {
    const possibleMediaRoots = [
      path.join(process.cwd(), 'media'),
      path.join(process.cwd(), 'dist', 'media'),
      path.join(__dirname, '..', 'media'),
      path.join(__dirname, '..', '..', 'media'),
      path.join(__dirname, '..', '..', '..', 'media'),
      path.join(__dirname, 'media'),
    ];

    for (const m of possibleMediaRoots) {
      if (fs.existsSync(m)) {
        return m;
      }
    }

    return possibleMediaRoots[0];
  }

  /**
   * Helper to execute python script with resolved executable and ENOENT handling
   */
  private runPythonScript(
    scriptPath: string,
    inputPath: string,
    outputPath: string,
    generatorName: string,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      let pythonExec: string;
      try {
        pythonExec = this.getPythonExecutable();
      } catch (err) {
        try {
          if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        } catch {}
        return reject(err);
      }

      execFile(
        pythonExec,
        [scriptPath, inputPath, outputPath],
        (error, stdout, stderr) => {
          try {
            if (fs.existsSync(inputPath)) {
              fs.unlinkSync(inputPath);
            }
          } catch {}

          if (error) {
            try {
              if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
            } catch {}

            if ((error as any).code === 'ENOENT') {
              const actionableError = new Error(
                `Failed to execute ${generatorName}: Python binary "${pythonExec}" was not found (spawn ENOENT). Please check system installation or set PYTHON_BIN environment variable.`,
              );
              console.error(
                `ReportLab ${generatorName} ENOENT Error:`,
                actionableError,
                stderr,
              );
              return reject(actionableError);
            }

            console.error(
              `ReportLab ${generatorName} Error:`,
              error,
              stderr,
            );
            return reject(error);
          }

          try {
            if (fs.existsSync(outputPath)) {
              const pdfBuffer = fs.readFileSync(outputPath);
              try {
                fs.unlinkSync(outputPath);
              } catch {}
              return resolve(pdfBuffer);
            } else {
              return reject(
                new Error(
                  `PDF output file was not created by ReportLab ${generatorName}.`,
                ),
              );
            }
          } catch (readErr) {
            return reject(readErr);
          }
        },
      );
    });
  }

  /**
   * Render Invoice PDF using Python ReportLab generator for 1:1 exact parity
   */
  async generateInvoicePdf(invoiceData: any): Promise<Buffer> {
    const tempDir = os.tmpdir();
    const inputPath = path.join(
      tempDir,
      `inv_in_${Date.now()}_${Math.random().toString(36).substring(7)}.json`,
    );
    const outputPath = path.join(
      tempDir,
      `inv_out_${Date.now()}_${Math.random().toString(36).substring(7)}.pdf`,
    );

    const mediaRoot = this.resolveMediaRoot();
    const payload = {
      invoice: invoiceData,
      media_root: mediaRoot,
    };

    fs.writeFileSync(inputPath, JSON.stringify(payload), 'utf-8');

    const scriptPath = this.resolveScriptPath('generate_invoice_pdf.py');

    return this.runPythonScript(
      scriptPath,
      inputPath,
      outputPath,
      'Invoice PDF Generator',
    );
  }

  /**
   * Render Receipt PDF using Python ReportLab generator with Poppins typography
   */
  async generateReceiptPdf(receiptData: any): Promise<Buffer> {
    const tempDir = os.tmpdir();
    const inputPath = path.join(
      tempDir,
      `rct_in_${Date.now()}_${Math.random().toString(36).substring(7)}.json`,
    );
    const outputPath = path.join(
      tempDir,
      `rct_out_${Date.now()}_${Math.random().toString(36).substring(7)}.pdf`,
    );

    const mediaRoot = this.resolveMediaRoot();
    const payload = {
      receipt: receiptData,
      media_root: mediaRoot,
    };

    fs.writeFileSync(inputPath, JSON.stringify(payload), 'utf-8');

    const scriptPath = this.resolveScriptPath('generate_receipt_pdf.py');

    return this.runPythonScript(
      scriptPath,
      inputPath,
      outputPath,
      'Receipt PDF Generator',
    );
  }

  /**
   * Render Proposal PDF using Python ReportLab generator for 1:1 exact parity
   */
  async generateProposalPdf(
    proposalData: any,
    customConfig?: any,
  ): Promise<Buffer> {
    const tempDir = os.tmpdir();
    const inputPath = path.join(
      tempDir,
      `prop_in_${Date.now()}_${Math.random().toString(36).substring(7)}.json`,
    );
    const outputPath = path.join(
      tempDir,
      `prop_out_${Date.now()}_${Math.random().toString(36).substring(7)}.pdf`,
    );

    const mediaRoot = this.resolveMediaRoot();
    const payload = {
      proposal: proposalData,
      builder_config: customConfig || proposalData.builder_config || {},
      media_root: mediaRoot,
    };

    fs.writeFileSync(inputPath, JSON.stringify(payload), 'utf-8');

    const scriptPath = this.resolveScriptPath('generate_proposal_pdf.py');

    return this.runPythonScript(
      scriptPath,
      inputPath,
      outputPath,
      'Proposal PDF Generator',
    );
  }

  /**
   * Render HR Document PDF using Python ReportLab generator for 1:1 exact parity
   */
  async generateHrDocumentPdf(
    docTypeTitle: string,
    ctx: any,
  ): Promise<Buffer> {
    const tempDir = os.tmpdir();
    const inputPath = path.join(
      tempDir,
      `hr_in_${Date.now()}_${Math.random().toString(36).substring(7)}.json`,
    );
    const outputPath = path.join(
      tempDir,
      `hr_out_${Date.now()}_${Math.random().toString(36).substring(7)}.pdf`,
    );

    const mediaRoot = this.resolveMediaRoot();
    const payload = {
      doc_type: docTypeTitle,
      ctx,
      media_root: mediaRoot,
    };

    fs.writeFileSync(inputPath, JSON.stringify(payload), 'utf-8');

    const scriptPath = this.resolveScriptPath('generate_hr_pdf.py');

    return this.runPythonScript(
      scriptPath,
      inputPath,
      outputPath,
      'HR Document PDF Generator',
    );
  }
}

