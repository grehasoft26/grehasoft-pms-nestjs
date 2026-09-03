import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma.service';
import { PdfService } from '../../core/pdf.service';

@Injectable()
export class HrService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdfService: PdfService,
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

    const ctx = {
      date: new Date().toISOString().split('T')[0],
      employee_name: employeeName,
      address,
      position: data.position,
      joining_date: data.joining_date,
      salary_monthly: data.salary_monthly,
      department: data.department,
    };

    return this.pdfService.generateHrDocumentPdf('Offer Letter', ctx);
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
