import { Injectable, NotFoundException, BadRequestException, InternalServerErrorException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { PrismaService } from '../../core/prisma.service';
import { PdfService } from '../../core/pdf.service';
import { MailerService } from '../../core/mailer.service';

export class OfferLetterSigning {
  static generateToken(payloadObj: any, secret: string, expiresInSeconds: number = 172800): string {
    const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const jsonStr = JSON.stringify(payloadObj || {});
    const base64Payload = Buffer.from(jsonStr).toString('base64url');
    const signaturePayload = `${base64Payload}:${expiresAt}`;
    const hmac = crypto.createHmac('sha256', secret).update(signaturePayload).digest('hex');
    return `${base64Payload}.${expiresAt}.${hmac}`;
  }

  static verifyToken(token: string, secret: string): { valid: boolean; payload?: any; error?: string } {
    if (!token) {
      return { valid: false, error: 'Token is required.' };
    }

    const parts = token.split('.');
    if (parts.length !== 3) {
      return { valid: false, error: 'Invalid signature token.' };
    }

    const [base64Payload, expiresAtStr, hmacStr] = parts;
    const expiresAt = parseInt(expiresAtStr, 10);

    if (isNaN(expiresAt)) {
      return { valid: false, error: 'Invalid signature token.' };
    }

    const currentTimestamp = Math.floor(Date.now() / 1000);
    if (currentTimestamp > expiresAt) {
      return { valid: false, error: 'This secure link has expired.' };
    }

    const signaturePayload = `${base64Payload}:${expiresAt}`;
    const expectedHmac = crypto.createHmac('sha256', secret).update(signaturePayload).digest('hex');

    try {
      const hmacBuffer = Buffer.from(hmacStr, 'hex');
      const expectedBuffer = Buffer.from(expectedHmac, 'hex');

      if (hmacBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(hmacBuffer, expectedBuffer)) {
        return { valid: false, error: 'Invalid signature token.' };
      }

      const jsonStr = Buffer.from(base64Payload, 'base64url').toString('utf8');
      const payload = JSON.parse(jsonStr);
      return { valid: true, payload };
    } catch {
      return { valid: false, error: 'Invalid signature token.' };
    }
  }
}

@Injectable()
export class HrService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdfService: PdfService,
    private readonly mailerService: MailerService,
    private readonly configService: ConfigService,
  ) {}

  // -------------------------------------------------------------
  // 1. EMPLOYEES CRUD
  // -------------------------------------------------------------
  async getEmployees() {
    return this.prisma.employee.findMany({
      include: {
        user: { select: { id: true, name: true, email: true, username: true } },
        department: { select: { id: true, name: true } },
      },
      orderBy: { created_at: 'desc' },
    });
  }

  async getEmployeeById(id: number) {
    const emp = await this.prisma.employee.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, name: true, email: true, username: true } },
        department: { select: { id: true, name: true } },
      },
    });
    if (!emp) throw new NotFoundException('Employee not found');
    return emp;
  }

  async createEmployee(data: any) {
    return this.prisma.employee.create({
      data: {
        user_id: Number(data.user_id || data.user),
        address: data.address || '',
        position: data.position,
        joining_date: new Date(data.joining_date),
        salary_monthly: Number(data.salary_monthly),
        department_id: data.department_id || data.department ? Number(data.department_id || data.department) : null,
      },
      include: { user: true, department: true },
    });
  }

  async updateEmployee(id: number, data: any) {
    const emp = await this.prisma.employee.findUnique({ where: { id } });
    if (!emp) throw new NotFoundException('Employee not found');

    return this.prisma.employee.update({
      where: { id },
      data: {
        user_id: data.user_id || data.user ? Number(data.user_id || data.user) : undefined,
        address: data.address,
        position: data.position,
        joining_date: data.joining_date ? new Date(data.joining_date) : undefined,
        salary_monthly: data.salary_monthly !== undefined ? Number(data.salary_monthly) : undefined,
        department_id: data.department_id !== undefined ? (data.department_id || data.department ? Number(data.department_id || data.department) : null) : undefined,
      },
      include: { user: true, department: true },
    });
  }

  async deleteEmployee(id: number) {
    const emp = await this.prisma.employee.findUnique({ where: { id } });
    if (!emp) throw new NotFoundException('Employee not found');
    return this.prisma.employee.delete({ where: { id } });
  }

  // -------------------------------------------------------------
  // 2. HR DOCUMENTS LOG CRUD
  // -------------------------------------------------------------
  async getHrDocuments() {
    return this.prisma.hRDocument.findMany({
      include: {
        employee: { include: { user: true } },
        created_by: { select: { id: true, name: true, username: true } },
      },
      orderBy: { created_at: 'desc' },
    });
  }

  async getHrDocumentById(id: number) {
    const doc = await this.prisma.hRDocument.findUnique({
      where: { id },
      include: {
        employee: { include: { user: true } },
        created_by: { select: { id: true, name: true, username: true } },
      },
    });
    if (!doc) throw new NotFoundException('HR Document log not found');
    return doc;
  }

  async createHrDocument(user: any, data: any) {
    return this.prisma.hRDocument.create({
      data: {
        employee_id: Number(data.employee_id || data.employee),
        doc_type: data.doc_type,
        issued_on: data.issued_on ? new Date(data.issued_on) : new Date(),
        payload: data.payload || {},
        created_by_id: user.id,
        pdf_file: data.pdf_file || null,
      },
      include: { employee: true, created_by: true },
    });
  }

  async deleteHrDocument(id: number) {
    const doc = await this.prisma.hRDocument.findUnique({ where: { id } });
    if (!doc) throw new NotFoundException('HR Document log not found');
    return this.prisma.hRDocument.delete({ where: { id } });
  }

  private numToWordsInr(num: any): string {
    try {
      const n = Math.round(Number(num) || 0);
      if (n <= 0) return 'Zero Rupees Only';

      const units = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
                     'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
      const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

      const convertBelowThousand = (val: number): string => {
        let res = '';
        if (val >= 100) {
          res += units[Math.floor(val / 100)] + ' Hundred ';
          val %= 100;
        }
        if (val >= 20) {
          res += tens[Math.floor(val / 10)] + ' ';
          val %= 10;
        }
        if (val > 0) {
          res += units[val] + ' ';
        }
        return res;
      };

      let val = n;
      const crore = Math.floor(val / 10000000);
      val %= 10000000;
      const lakh = Math.floor(val / 100000);
      val %= 100000;
      const thousand = Math.floor(val / 1000);
      val %= 1000;
      const hundreds = val;

      let words = '';
      if (crore > 0) words += convertBelowThousand(crore).trim() + ' Crore ';
      if (lakh > 0) words += convertBelowThousand(lakh).trim() + ' Lakh ';
      if (thousand > 0) words += convertBelowThousand(thousand).trim() + ' Thousand ';
      if (hundreds > 0) words += convertBelowThousand(hundreds).trim();

      return words.trim() + ' Rupees Only';
    } catch {
      return '';
    }
  }

  // -------------------------------------------------------------
  // 3. GENERATE OFFER LETTER PDF
  // -------------------------------------------------------------
  async generateOfferLetterPdf(data: any): Promise<Buffer> {
    let employeeName = data.employee_name || '';
    let address = data.address || '';

    if (data.employee_id) {
      const u = await this.prisma.user.findUnique({
        where: { id: Number(data.employee_id) },
      });
      if (u) {
        employeeName = employeeName || u.name || u.username;
      }
    }

    const salMonthly = Number(data.salary_monthly || 0);

    const ctx = {
      date: new Date().toISOString().split('T')[0],
      employee_name: employeeName,
      address,
      position: data.position,
      joining_date: data.joining_date,
      salary_monthly: salMonthly,
      salary_in_words: this.numToWordsInr(salMonthly),
      salary_annual: salMonthly * 12,
      department: data.department,
      custom_sections: Array.isArray(data.custom_sections) && data.custom_sections.length > 0 ? data.custom_sections : undefined,
    };

    return this.pdfService.generateHrDocumentPdf('Offer Letter', ctx);
  }

  private getSigningSecret(): string {
    return (
      this.configService?.get<string>('HR_LINK_SECRET') ||
      this.configService?.get<string>('SECRET_KEY') ||
      this.configService?.get<string>('JWT_SECRET') ||
      'grehasoft-hr-link-signing-secret-default'
    );
  }

  private getBaseUrl(req?: any): string {
    if (req) {
      const host = req.get ? req.get('host') : req.headers?.host;
      const protocol = req.protocol || (req.connection?.encrypted ? 'https' : 'http');
      if (host) {
        return `${protocol}://${host}`;
      }
    }
    const configuredUrl =
      this.configService?.get<string>('API_BASE_URL') ||
      this.configService?.get<string>('SITE_URL');
    if (configuredUrl) {
      return configuredUrl.replace(/\/$/, '');
    }
    return 'http://localhost:3000';
  }

  async generateOfferLetterSecureLink(data: any, req?: any): Promise<{ secure_pdf_link: string }> {
    const secret = this.getSigningSecret();
    const token = OfferLetterSigning.generateToken(data, secret, 172800);
    const baseUrl = this.getBaseUrl(req);
    const securePdfLink = `${baseUrl}/api/v1/hr-documents/public/offer-letter/${encodeURIComponent(token)}/download/`;

    return { secure_pdf_link: securePdfLink };
  }

  async generateOfferLetterPdfFromPublicToken(token: string): Promise<{ pdfBuffer: Buffer; filename: string }> {
    const secret = this.getSigningSecret();
    const verification = OfferLetterSigning.verifyToken(token, secret);

    if (!verification.valid || !verification.payload) {
      throw new ForbiddenException(verification.error || 'Invalid or expired signature token.');
    }

    const pdfBuffer = await this.generateOfferLetterPdf(verification.payload);
    const employeeName = verification.payload.employee_name || 'Employee';
    const safeName = String(employeeName).replace(/[^a-zA-Z0-9_\-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'Employee';
    const filename = `Offer_Letter_${safeName}.pdf`;

    return { pdfBuffer, filename };
  }

  async sendOfferLetterEmail(data: any): Promise<{ message: string }> {
    let employeeName = data.employee_name || '';
    let email = data.email || '';

    if (data.employee_id) {
      const u = await this.prisma.user.findUnique({
        where: { id: Number(data.employee_id) },
      });
      if (u) {
        employeeName = employeeName || u.name || u.username;
        email = email || u.email;
      }
    }

    if (!email || !String(email).trim()) {
      throw new BadRequestException('Email address is not available for this employee.');
    }

    const pdfBuffer = await this.generateOfferLetterPdf(data);
    const safeName = String(employeeName).replace(/[^a-zA-Z0-9_\-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'Employee';
    const filename = `Offer_Letter_${safeName}.pdf`;

    const mailSent = await this.mailerService.sendMail({
      to: String(email).trim(),
      subject: 'Your Job Offer Letter – Grehasoft',
      text: `Dear ${employeeName || 'Employee'},\n\nPlease find attached your Job Offer Letter from Grehasoft.\n\nKindly review the terms and conditions outlined in the offer letter.\n\nIf you have any questions, please contact the HR team.\n\nRegards,\n\nGrehasoft HR`,
      attachments: [
        {
          filename,
          content: pdfBuffer,
        },
      ],
    });

    if (!mailSent) {
      throw new InternalServerErrorException('Failed to send offer letter email. Please check server email configuration.');
    }

    return { message: 'Email sent successfully' };
  }

  // -------------------------------------------------------------
  // 4. GENERATE APPRAISAL LETTER PDF
  // -------------------------------------------------------------
  async generateAppraisalLetterPdf(data: any): Promise<Buffer> {
    const empUser = await this.prisma.user.findUnique({
      where: { id: Number(data.employee_id) },
    });
    if (!empUser) throw new NotFoundException('Employee user not found');

    const empRecord = await this.prisma.employee.findUnique({
      where: { user_id: empUser.id },
    });

    const oldSalary = Number(empUser.salary_monthly || empRecord?.salary_monthly || 0);
    let newSalary = 0;
    let increasePct = 0;

    if (data.new_monthly_salary !== undefined && data.new_monthly_salary !== null) {
      newSalary = Number(data.new_monthly_salary);
      increasePct = oldSalary > 0 ? Number((((newSalary - oldSalary) / oldSalary) * 100).toFixed(2)) : 0;
    } else {
      increasePct = Number(data.increase_percentage || 0);
      newSalary = Number((oldSalary * (1 + increasePct / 100)).toFixed(2));
    }

    const effective = data.effective_date || `${new Date().getFullYear()}-03-31`;

    const ctx = {
      date: new Date().toISOString().split('T')[0],
      employee_name: empUser.name || empUser.username,
      effective_date: effective,
      increase_percentage: String(increasePct),
      old_salary_monthly: oldSalary,
      new_salary_monthly: newSalary,
    };

    return this.pdfService.generateHrDocumentPdf('Salary Appraisal', ctx);
  }

  // -------------------------------------------------------------
  // 5. GENERATE EXPERIENCE CERTIFICATE PDF
  // -------------------------------------------------------------
  async generateExperienceCertificatePdf(data: any): Promise<Buffer> {
    const empUser = await this.prisma.user.findUnique({
      where: { id: Number(data.employee_id) },
    });
    if (!empUser) throw new NotFoundException('Employee user not found');

    const ctx = {
      date: new Date().toISOString().split('T')[0],
      employee_name: empUser.name || empUser.username,
      role: data.role,
      start_date: data.start_date,
      end_date: data.end_date,
    };

    return this.pdfService.generateHrDocumentPdf('Experience Certificate', ctx);
  }

  // -------------------------------------------------------------
  // 6. GENERATE SALARY CERTIFICATE PDF
  // -------------------------------------------------------------
  async generateSalaryCertificatePdf(data: any): Promise<Buffer> {
    const empUser = await this.prisma.user.findUnique({
      where: { id: Number(data.employee_id) },
    });
    if (!empUser) throw new NotFoundException('Employee user not found');

    const empRecord = await this.prisma.employee.findUnique({
      where: { user_id: empUser.id },
    });

    const ctx = {
      company_name: data.company_name || 'GREHASOFT',
      issue_date: data.issue_date || new Date().toISOString().split('T')[0],
      employee_name: empUser.name || empUser.username,
      position: empUser.position || empRecord?.position || 'Employee',
      salary_monthly: empUser.salary_monthly || empRecord?.salary_monthly || 0,
      joining_date: empUser.joining_date ? empUser.joining_date.toISOString().split('T')[0] : (empRecord?.joining_date ? empRecord.joining_date.toISOString().split('T')[0] : ''),
    };

    return this.pdfService.generateHrDocumentPdf('Salary Certificate', ctx);
  }

  // -------------------------------------------------------------
  // 7. GENERATE INTERNSHIP CERTIFICATE PDF
  // -------------------------------------------------------------
  async generateInternshipCertificatePdf(data: any): Promise<Buffer> {
    const ctx = {
      intern_name: data.intern_name,
      college_name: data.college_name,
      position: data.position,
      start_date: data.start_date,
      end_date: data.end_date,
      issue_date: data.issue_date,
      company_name: data.company_name || 'GREHASOFT',
      hr_name: data.hr_name,
    };

    return this.pdfService.generateHrDocumentPdf('Internship Certificate', ctx);
  }
}
