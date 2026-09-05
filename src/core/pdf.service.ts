import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
const PDFDocument = require('pdfkit');

@Injectable()
export class PdfService {
  /**
   * Render Invoice PDF using Python ReportLab generator for 1:1 exact parity
   */
  async generateInvoicePdf(invoiceData: any): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const tempDir = os.tmpdir();
      const inputPath = path.join(tempDir, `inv_in_${Date.now()}_${Math.random().toString(36).substring(7)}.json`);
      const outputPath = path.join(tempDir, `inv_out_${Date.now()}_${Math.random().toString(36).substring(7)}.pdf`);

      const possibleMediaRoots = [
        path.join(process.cwd(), 'media'),
        path.join(__dirname, '..', '..', '..', 'media'),
        path.join(__dirname, '..', '..', 'media'),
      ];
      let mediaRoot = possibleMediaRoots[0];
      for (const m of possibleMediaRoots) {
        if (fs.existsSync(m)) {
          mediaRoot = m;
          break;
        }
      }

      const payload = {
        invoice: invoiceData,
        media_root: mediaRoot,
      };

      fs.writeFileSync(inputPath, JSON.stringify(payload), 'utf-8');

      const possibleScriptPaths = [
        path.join(process.cwd(), 'scripts', 'generate_invoice_pdf.py'),
        path.join(__dirname, '..', '..', '..', 'scripts', 'generate_invoice_pdf.py'),
        path.join(__dirname, '..', '..', 'scripts', 'generate_invoice_pdf.py'),
      ];
      let scriptPath = possibleScriptPaths[0];
      for (const p of possibleScriptPaths) {
        if (fs.existsSync(p)) {
          scriptPath = p;
          break;
        }
      }

      execFile('python', [scriptPath, inputPath, outputPath], (error, stdout, stderr) => {
        try {
          if (fs.existsSync(inputPath)) {
            fs.unlinkSync(inputPath);
          }
        } catch {}

        if (error) {
          try {
            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
          } catch {}
          console.error('ReportLab Invoice PDF Generator Error:', error, stderr);
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
            return reject(new Error('PDF output file was not created by ReportLab invoice generator.'));
          }
        } catch (readErr) {
          return reject(readErr);
        }
      });
    });
  }

  /**
   * Render Receipt PDF using Python ReportLab generator with Poppins typography
   */
  async generateReceiptPdf(receiptData: any): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const tempDir = os.tmpdir();
      const inputPath = path.join(tempDir, `rct_in_${Date.now()}_${Math.random().toString(36).substring(7)}.json`);
      const outputPath = path.join(tempDir, `rct_out_${Date.now()}_${Math.random().toString(36).substring(7)}.pdf`);

      const possibleMediaRoots = [
        path.join(process.cwd(), 'media'),
        path.join(__dirname, '..', '..', '..', 'media'),
        path.join(__dirname, '..', '..', 'media'),
      ];
      let mediaRoot = possibleMediaRoots[0];
      for (const m of possibleMediaRoots) {
        if (fs.existsSync(m)) {
          mediaRoot = m;
          break;
        }
      }

      const payload = {
        receipt: receiptData,
        media_root: mediaRoot,
      };

      fs.writeFileSync(inputPath, JSON.stringify(payload), 'utf-8');

      const possibleScriptPaths = [
        path.join(process.cwd(), 'scripts', 'generate_receipt_pdf.py'),
        path.join(__dirname, '..', '..', '..', 'scripts', 'generate_receipt_pdf.py'),
        path.join(__dirname, '..', '..', 'scripts', 'generate_receipt_pdf.py'),
      ];
      let scriptPath = possibleScriptPaths[0];
      for (const p of possibleScriptPaths) {
        if (fs.existsSync(p)) {
          scriptPath = p;
          break;
        }
      }

      execFile('python', [scriptPath, inputPath, outputPath], (error, stdout, stderr) => {
        try {
          if (fs.existsSync(inputPath)) {
            fs.unlinkSync(inputPath);
          }
        } catch {}

        if (error) {
          try {
            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
          } catch {}
          console.error('ReportLab Receipt PDF Generator Error:', error, stderr);
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
            return reject(new Error('PDF output file was not created by ReportLab receipt generator.'));
          }
        } catch (readErr) {
          return reject(readErr);
        }
      });
    });
  }

  /**
   * Render Proposal PDF using Python ReportLab generator for 1:1 exact parity
   */
  async generateProposalPdf(proposalData: any, customConfig?: any): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const tempDir = os.tmpdir();
      const inputPath = path.join(tempDir, `prop_in_${Date.now()}_${Math.random().toString(36).substring(7)}.json`);
      const outputPath = path.join(tempDir, `prop_out_${Date.now()}_${Math.random().toString(36).substring(7)}.pdf`);

      const possibleMediaRoots = [
        path.join(process.cwd(), 'media'),
        path.join(__dirname, '..', '..', '..', 'media'),
        path.join(__dirname, '..', '..', 'media'),
      ];
      let mediaRoot = possibleMediaRoots[0];
      for (const m of possibleMediaRoots) {
        if (fs.existsSync(m)) {
          mediaRoot = m;
          break;
        }
      }

      const payload = {
        proposal: proposalData,
        builder_config: customConfig || proposalData.builder_config || {},
        media_root: mediaRoot,
      };

      fs.writeFileSync(inputPath, JSON.stringify(payload), 'utf-8');

      const possibleScriptPaths = [
        path.join(process.cwd(), 'scripts', 'generate_proposal_pdf.py'),
        path.join(__dirname, '..', '..', '..', 'scripts', 'generate_proposal_pdf.py'),
        path.join(__dirname, '..', '..', 'scripts', 'generate_proposal_pdf.py'),
      ];
      let scriptPath = possibleScriptPaths[0];
      for (const p of possibleScriptPaths) {
        if (fs.existsSync(p)) {
          scriptPath = p;
          break;
        }
      }

      execFile('python', [scriptPath, inputPath, outputPath], (error, stdout, stderr) => {
        try {
          if (fs.existsSync(inputPath)) {
            fs.unlinkSync(inputPath);
          }
        } catch {}

        if (error) {
          try {
            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
          } catch {}
          console.error('ReportLab PDF Generator Error:', error, stderr);
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
            return reject(new Error('PDF output file was not created by ReportLab generator.'));
          }
        } catch (readErr) {
          return reject(readErr);
        }
      });
    });
  }

  /**
   * Render HR Document PDF using Python ReportLab generator for 1:1 exact parity
   */
  async generateHrDocumentPdf(docTypeTitle: string, ctx: any): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const tempDir = os.tmpdir();
      const inputPath = path.join(tempDir, `hr_in_${Date.now()}_${Math.random().toString(36).substring(7)}.json`);
      const outputPath = path.join(tempDir, `hr_out_${Date.now()}_${Math.random().toString(36).substring(7)}.pdf`);

      const possibleMediaRoots = [
        path.join(process.cwd(), 'media'),
        path.join(__dirname, '..', '..', '..', 'media'),
        path.join(__dirname, '..', '..', 'media'),
      ];
      let mediaRoot = possibleMediaRoots[0];
      for (const m of possibleMediaRoots) {
        if (fs.existsSync(m)) {
          mediaRoot = m;
          break;
        }
      }

      const payload = {
        doc_type: docTypeTitle,
        ctx,
        media_root: mediaRoot,
      };

      fs.writeFileSync(inputPath, JSON.stringify(payload), 'utf-8');

      const possibleScriptPaths = [
        path.join(process.cwd(), 'scripts', 'generate_hr_pdf.py'),
        path.join(__dirname, '..', '..', '..', 'scripts', 'generate_hr_pdf.py'),
        path.join(__dirname, '..', '..', 'scripts', 'generate_hr_pdf.py'),
      ];
      let scriptPath = possibleScriptPaths[0];
      for (const p of possibleScriptPaths) {
        if (fs.existsSync(p)) {
          scriptPath = p;
          break;
        }
      }

      execFile('python', [scriptPath, inputPath, outputPath], (error, stdout, stderr) => {
        try {
          if (fs.existsSync(inputPath)) {
            fs.unlinkSync(inputPath);
          }
        } catch {}

        if (error) {
          try {
            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
          } catch {}
          console.error('ReportLab HR PDF Generator Error:', error, stderr);
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
            return reject(new Error('PDF output file was not created by ReportLab HR generator.'));
          }
        } catch (readErr) {
          return reject(readErr);
        }
      });
    });
  }
}
