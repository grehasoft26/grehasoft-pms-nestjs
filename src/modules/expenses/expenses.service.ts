import { Injectable, NotFoundException, BadRequestException, ForbiddenException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../core/prisma.service';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { UpdateExpenseDto } from './dto/update-expense.dto';
import { CreateExpenseCategoryDto } from './dto/create-expense-category.dto';
import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_CATEGORIES = [
  { name: 'Office Rent', description: 'Office premises rental and lease costs' },
  { name: 'Electricity and Utilities', description: 'Electricity, water, and utility bills' },
  { name: 'Internet and Telephone', description: 'Broadband, ISP, and phone bills' },
  { name: 'Marketing — Meta Ads and Google Ads', description: 'Digital advertising and marketing campaigns' },
  { name: 'Hosting, Domains and Software Subscriptions', description: 'Cloud servers, domains, SaaS subscriptions' },
  { name: 'Laptop and Office Equipment', description: 'Computers, office hardware, and peripherals' },
  { name: 'Travel and Transportation', description: 'Business travel, fuel, and transit' },
  { name: 'Employee Reimbursements', description: 'Staff out-of-pocket expenses and allowances' },
  { name: 'Client Meetings and Business Development', description: 'Client entertainment and sales meetings' },
  { name: 'Office Events and Celebrations', description: 'Team celebrations, snacks, and company events' },
  { name: 'Professional Fees', description: 'Legal, accounting, and consulting fees' },
  { name: 'Bank Charges', description: 'Bank processing, gateway, and service charges' },
  { name: 'Maintenance and Repairs', description: 'Office repairs and IT equipment maintenance' },
  { name: 'Miscellaneous', description: 'General uncategorized business expenses' },
];

@Injectable()
export class ExpensesService implements OnModuleInit {
  private readonly uploadDir = path.join(process.cwd(), 'media', 'expenses');

  constructor(private readonly prisma: PrismaService) {
    if (!fs.existsSync(this.uploadDir)) {
      fs.mkdirSync(this.uploadDir, { recursive: true });
    }
  }

  async onModuleInit() {
    await this.seedDefaultCategories();
  }

  async seedDefaultCategories() {
    for (const cat of DEFAULT_CATEGORIES) {
      await this.prisma.expenseCategory.upsert({
        where: { name: cat.name },
        update: {},
        create: cat,
      });
    }
  }

  // -------------------------------------------------------------
  // CATEGORIES
  // -------------------------------------------------------------

  async findAllCategories() {
    return this.prisma.expenseCategory.findMany({
      where: { deleted_at: null },
      orderBy: { name: 'asc' },
    });
  }

  async createCategory(dto: CreateExpenseCategoryDto) {
    const existing = await this.prisma.expenseCategory.findUnique({
      where: { name: dto.name.trim() },
    });
    if (existing) {
      if (existing.deleted_at) {
        return this.prisma.expenseCategory.update({
          where: { id: existing.id },
          data: { deleted_at: null, description: dto.description || existing.description, is_active: dto.is_active ?? true },
        });
      }
      throw new BadRequestException('Expense category with this name already exists.');
    }
    return this.prisma.expenseCategory.create({
      data: {
        name: dto.name.trim(),
        description: dto.description || '',
        is_active: dto.is_active ?? true,
      },
    });
  }

  async updateCategory(id: number, dto: CreateExpenseCategoryDto) {
    const category = await this.prisma.expenseCategory.findUnique({ where: { id } });
    if (!category || category.deleted_at) {
      throw new NotFoundException('Expense category not found.');
    }
    return this.prisma.expenseCategory.update({
      where: { id },
      data: {
        name: dto.name ? dto.name.trim() : category.name,
        description: dto.description !== undefined ? dto.description : category.description,
        is_active: dto.is_active !== undefined ? dto.is_active : category.is_active,
      },
    });
  }

  async deleteCategory(id: number) {
    const category = await this.prisma.expenseCategory.findUnique({
      where: { id },
      include: { expenses: { where: { deleted_at: null } } },
    });
    if (!category || category.deleted_at) {
      throw new NotFoundException('Expense category not found.');
    }
    if (category.expenses.length > 0) {
      throw new BadRequestException('Cannot delete category because it has linked expenses.');
    }
    return this.prisma.expenseCategory.update({
      where: { id },
      data: { deleted_at: new Date() },
    });
  }

  // -------------------------------------------------------------
  // EXPENSES
  // -------------------------------------------------------------

  private formatExpense(exp: any) {
    if (!exp) return null;
    const amount = exp.amount ? Number(exp.amount) : 0;
    const amount_paid = exp.amount_paid ? Number(exp.amount_paid) : 0;
    const outstanding_amount = exp.outstanding_amount !== undefined && exp.outstanding_amount !== null
      ? Number(exp.outstanding_amount)
      : Math.max(0, amount - amount_paid);

    return {
      id: exp.id,
      title: exp.title,
      category_id: exp.category_id,
      category_name: exp.category ? exp.category.name : null,
      client_id: exp.client_id || null,
      client_name: exp.client ? (exp.client.company_name || exp.client.name) : null,
      project_id: exp.project_id || null,
      project_name: exp.project ? exp.project.name : null,
      invoice_id: exp.invoice_id || null,
      invoice_number: exp.invoice ? exp.invoice.invoice_number : null,
      payment_account_source: exp.payment_account_source || null,
      amount,
      expense_date: exp.expense_date ? exp.expense_date.toISOString().split('T')[0] : null,
      vendor: exp.vendor || '',
      reference_number: exp.reference_number || '',
      payment_method: exp.payment_method || 'cash',
      payment_status: exp.payment_status || 'paid',
      amount_paid,
      outstanding_amount,
      gst_number: exp.gst_number || '',
      gst_amount: exp.gst_amount ? Number(exp.gst_amount) : 0,
      notes: exp.notes || '',
      receipt_file: exp.receipt_file || null,
      receipt_filename: exp.receipt_filename || null,
      employee_id: exp.employee_id || null,
      employee_name: exp.employee && exp.employee.user ? exp.employee.user.name : null,
      user_id: exp.user_id || null,
      approval_status: exp.approval_status || 'approved',
      created_by_id: exp.created_by_id,
      created_by_name: exp.created_by ? exp.created_by.name : null,
      created_at: exp.created_at ? exp.created_at.toISOString() : null,
      updated_at: exp.updated_at ? exp.updated_at.toISOString() : null,
    };
  }

  async findAll(user: any, query: {
    search?: string;
    category?: string;
    client_id?: string;
    project_id?: string;
    invoice_id?: string;
    payment_account_source?: string;
    payment_status?: string;
    vendor?: string;
    approval_status?: string;
    start_date?: string;
    end_date?: string;
    all?: string;
    page?: string;
    limit?: string;
  }) {
    const where: any = { deleted_at: null };

    if (query.search) {
      const searchStr = query.search.trim();
      if (searchStr) {
        where.OR = [
          { title: { contains: searchStr } },
          { vendor: { contains: searchStr } },
          { reference_number: { contains: searchStr } },
          { notes: { contains: searchStr } },
        ];
      }
    }

    if (query.category) {
      where.category_id = Number(query.category);
    }

    if (query.client_id) {
      where.client_id = Number(query.client_id);
    }

    if (query.project_id) {
      where.project_id = Number(query.project_id);
    }

    if (query.invoice_id) {
      where.invoice_id = Number(query.invoice_id);
    }

    if (query.payment_account_source) {
      where.payment_account_source = query.payment_account_source as any;
    }

    if (query.payment_status && query.payment_status !== 'all') {
      where.payment_status = query.payment_status as any;
    }

    if (query.vendor) {
      where.vendor = { contains: query.vendor.trim() };
    }

    if (query.approval_status && query.approval_status !== 'all') {
      where.approval_status = query.approval_status as any;
    }

    if (query.start_date || query.end_date) {
      where.expense_date = {};
      if (query.start_date) where.expense_date.gte = new Date(query.start_date);
      if (query.end_date) where.expense_date.lte = new Date(query.end_date);
    }

    const includeRelations = {
      category: true,
      created_by: true,
      employee: { include: { user: true } },
      client: { select: { id: true, name: true, company_name: true } },
      project: { select: { id: true, name: true, client_id: true } },
      invoice: { select: { id: true, invoice_number: true, client_id: true } },
    };

    if (query.all === 'true') {
      const expenses = await this.prisma.expense.findMany({
        where,
        include: includeRelations,
        orderBy: { expense_date: 'desc' },
      });
      return expenses.map((e) => this.formatExpense(e));
    }

    const page = Math.max(1, parseInt(query.page as string, 10) || 1);
    const limit = Math.max(1, parseInt(query.limit as string, 10) || 10);
    const skip = (page - 1) * limit;

    const [totalCount, expenses] = await Promise.all([
      this.prisma.expense.count({ where }),
      this.prisma.expense.findMany({
        where,
        include: includeRelations,
        orderBy: [{ expense_date: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
      }),
    ]);

    return {
      count: totalCount,
      next: page * limit < totalCount ? `/api/v1/expenses?page=${page + 1}` : null,
      previous: page > 1 ? `/api/v1/expenses?page=${page - 1}` : null,
      results: expenses.map((e) => this.formatExpense(e)),
    };
  }

  async findOne(id: number, user: any) {
    const expense = await this.prisma.expense.findUnique({
      where: { id },
      include: {
        category: true,
        created_by: true,
        employee: { include: { user: true } },
        client: { select: { id: true, name: true, company_name: true } },
        project: { select: { id: true, name: true, client_id: true } },
        invoice: { select: { id: true, invoice_number: true, client_id: true } },
      },
    });

    if (!expense || expense.deleted_at) {
      throw new NotFoundException('Expense record not found.');
    }

    return this.formatExpense(expense);
  }

  private async validateExpenseRelationships(
    clientId?: number | null,
    projectId?: number | null,
    invoiceId?: number | null,
  ) {
    let client: any = null;
    let project: any = null;
    let invoice: any = null;

    if (clientId) {
      client = await this.prisma.client.findUnique({ where: { id: clientId } });
      if (!client || client.deleted_at) {
        throw new BadRequestException(`Client with ID ${clientId} does not exist.`);
      }
    }

    if (projectId) {
      project = await this.prisma.project.findUnique({ where: { id: projectId } });
      if (!project || project.deleted_at) {
        throw new BadRequestException(`Project with ID ${projectId} does not exist.`);
      }
      if (clientId && project.client_id && project.client_id !== clientId) {
        throw new BadRequestException('Selected project does not belong to the selected client.');
      }
    }

    if (invoiceId) {
      invoice = await this.prisma.invoice.findUnique({ where: { id: invoiceId } });
      if (!invoice) {
        throw new BadRequestException(`Invoice with ID ${invoiceId} does not exist.`);
      }
      if (clientId && invoice.client_id && invoice.client_id !== clientId) {
        throw new BadRequestException('Selected invoice does not belong to the selected client.');
      }
    }
  }

  async create(user: any, dto: CreateExpenseDto, file?: any) {
    const category_id = Number(dto.category_id);
    if (!category_id || isNaN(category_id)) {
      throw new BadRequestException('Invalid expense category specified.');
    }

    const category = await this.prisma.expenseCategory.findUnique({
      where: { id: category_id },
    });
    if (!category || category.deleted_at) {
      throw new BadRequestException('Invalid expense category specified.');
    }

    const amount = Number(dto.amount);
    if (isNaN(amount) || amount <= 0) {
      throw new BadRequestException('Amount must be a positive number.');
    }

    let payment_status = dto.payment_status || 'paid';
    let amount_paid = dto.amount_paid !== undefined && dto.amount_paid !== '' && dto.amount_paid !== null
      ? Number(dto.amount_paid)
      : (payment_status === 'paid' ? amount : 0);
    if (isNaN(amount_paid) || amount_paid < 0) {
      throw new BadRequestException('Amount paid must be a non-negative number.');
    }

    if (amount_paid > amount) {
      throw new BadRequestException('Amount paid cannot exceed total expense amount.');
    }

    if (amount_paid >= amount && amount > 0) {
      payment_status = 'paid';
    } else if (amount_paid > 0 && amount_paid < amount) {
      payment_status = 'partially_paid';
    } else {
      payment_status = 'pending';
    }

    const outstanding_amount = Math.max(0, amount - amount_paid);

    // Validate relationships if provided
    const client_id = dto.client_id ? Number(dto.client_id) : null;
    const project_id = dto.project_id ? Number(dto.project_id) : null;
    const invoice_id = dto.invoice_id ? Number(dto.invoice_id) : null;
    await this.validateExpenseRelationships(client_id, project_id, invoice_id);

    const payment_account_source = dto.payment_account_source ? (dto.payment_account_source as any) : null;

    let receipt_file: string | null = null;
    let receipt_filename: string | null = null;

    if (file) {
      const ext = path.extname(file.originalname);
      const filename = `expense_${Date.now()}_${Math.random().toString(36).substr(2, 6)}${ext}`;
      const filePath = path.join(this.uploadDir, filename);
      fs.writeFileSync(filePath, file.buffer);
      receipt_file = `/media/expenses/${filename}`;
      receipt_filename = file.originalname;
    }

    const employee_id = dto.employee_id && dto.employee_id !== '' && !isNaN(Number(dto.employee_id))
      ? Number(dto.employee_id)
      : null;
    const user_id = dto.user_id && dto.user_id !== '' && !isNaN(Number(dto.user_id))
      ? Number(dto.user_id)
      : null;
    const created_by_id = Number(user.id);

    const expense_date = dto.expense_date ? new Date(dto.expense_date) : new Date();
    if (isNaN(expense_date.getTime())) {
      throw new BadRequestException('Invalid expense date provided.');
    }

    const created = await this.prisma.expense.create({
      data: {
        title: dto.title.trim(),
        category_id,
        client_id,
        project_id,
        invoice_id,
        payment_account_source,
        amount,
        expense_date,
        vendor: dto.vendor && dto.vendor.trim() ? dto.vendor.trim() : null,
        reference_number: dto.reference_number && dto.reference_number.trim() ? dto.reference_number.trim() : null,
        payment_method: (dto.payment_method as any) || 'cash',
        payment_status: payment_status as any,
        amount_paid,
        outstanding_amount,
        gst_number: dto.gst_number && dto.gst_number.trim() ? dto.gst_number.trim() : null,
        gst_amount: dto.gst_amount !== undefined && dto.gst_amount !== '' && dto.gst_amount !== null ? Number(dto.gst_amount) : 0,
        notes: dto.notes && dto.notes.trim() ? dto.notes.trim() : null,
        receipt_file,
        receipt_filename,
        employee_id,
        user_id,
        approval_status: (dto.approval_status as any) || 'approved',
        created_by_id,
      },
      include: {
        category: true,
        created_by: true,
        employee: { include: { user: true } },
        client: { select: { id: true, name: true, company_name: true } },
        project: { select: { id: true, name: true, client_id: true } },
        invoice: { select: { id: true, invoice_number: true, client_id: true } },
      },
    });

    return this.formatExpense(created);
  }

  async update(id: number, user: any, dto: UpdateExpenseDto, file?: any) {
    const existing = await this.prisma.expense.findUnique({ where: { id } });
    if (!existing || existing.deleted_at) {
      throw new NotFoundException('Expense record not found.');
    }

    const data: any = {};

    if (dto.category_id !== undefined && dto.category_id !== '') {
      const category_id = Number(dto.category_id);
      if (isNaN(category_id)) {
        throw new BadRequestException('Invalid expense category specified.');
      }
      const category = await this.prisma.expenseCategory.findUnique({ where: { id: category_id } });
      if (!category || category.deleted_at) {
        throw new BadRequestException('Invalid expense category specified.');
      }
      data.category_id = category_id;
    }

    const client_id = dto.client_id !== undefined ? (dto.client_id ? Number(dto.client_id) : null) : existing.client_id;
    const project_id = dto.project_id !== undefined ? (dto.project_id ? Number(dto.project_id) : null) : existing.project_id;
    const invoice_id = dto.invoice_id !== undefined ? (dto.invoice_id ? Number(dto.invoice_id) : null) : existing.invoice_id;

    await this.validateExpenseRelationships(client_id, project_id, invoice_id);

    if (dto.client_id !== undefined) data.client_id = client_id;
    if (dto.project_id !== undefined) data.project_id = project_id;
    if (dto.invoice_id !== undefined) data.invoice_id = invoice_id;
    if (dto.payment_account_source !== undefined) data.payment_account_source = dto.payment_account_source ? (dto.payment_account_source as any) : null;

    if (dto.title !== undefined) data.title = dto.title.trim();
    if (dto.expense_date !== undefined) {
      const parsedDate = new Date(dto.expense_date);
      if (isNaN(parsedDate.getTime())) {
        throw new BadRequestException('Invalid expense date provided.');
      }
      data.expense_date = parsedDate;
    }
    if (dto.vendor !== undefined) data.vendor = dto.vendor && dto.vendor.trim() ? dto.vendor.trim() : null;
    if (dto.reference_number !== undefined) data.reference_number = dto.reference_number && dto.reference_number.trim() ? dto.reference_number.trim() : null;
    if (dto.payment_method !== undefined) data.payment_method = dto.payment_method;
    if (dto.gst_number !== undefined) data.gst_number = dto.gst_number && dto.gst_number.trim() ? dto.gst_number.trim() : null;
    if (dto.gst_amount !== undefined && dto.gst_amount !== '') data.gst_amount = Number(dto.gst_amount);
    if (dto.notes !== undefined) data.notes = dto.notes && dto.notes.trim() ? dto.notes.trim() : null;
    if (dto.employee_id !== undefined) data.employee_id = dto.employee_id && dto.employee_id !== '' ? Number(dto.employee_id) : null;
    if (dto.user_id !== undefined) data.user_id = dto.user_id && dto.user_id !== '' ? Number(dto.user_id) : null;
    if (dto.approval_status !== undefined) data.approval_status = dto.approval_status;

    const amount = dto.amount !== undefined ? Number(dto.amount) : Number(existing.amount);
    const amount_paid = dto.amount_paid !== undefined && dto.amount_paid !== '' ? Number(dto.amount_paid) : Number(existing.amount_paid);

    if (isNaN(amount) || amount <= 0) {
      throw new BadRequestException('Amount must be a positive number.');
    }
    if (isNaN(amount_paid) || amount_paid < 0) {
      throw new BadRequestException('Amount paid must be a non-negative number.');
    }
    if (amount_paid > amount) {
      throw new BadRequestException('Amount paid cannot exceed total expense amount.');
    }

    data.amount = amount;
    data.amount_paid = amount_paid;
    data.outstanding_amount = Math.max(0, amount - amount_paid);

    if (amount_paid >= amount && amount > 0) {
      data.payment_status = 'paid';
    } else if (amount_paid > 0 && amount_paid < amount) {
      data.payment_status = 'partially_paid';
    } else {
      data.payment_status = 'pending';
    }

    if (file) {
      const ext = path.extname(file.originalname);
      const filename = `expense_${Date.now()}_${Math.random().toString(36).substr(2, 6)}${ext}`;
      const filePath = path.join(this.uploadDir, filename);
      fs.writeFileSync(filePath, file.buffer);
      data.receipt_file = `/media/expenses/${filename}`;
      data.receipt_filename = file.originalname;
    }

    const updated = await this.prisma.expense.update({
      where: { id },
      data,
      include: {
        category: true,
        created_by: true,
        employee: { include: { user: true } },
        client: { select: { id: true, name: true, company_name: true } },
        project: { select: { id: true, name: true, client_id: true } },
        invoice: { select: { id: true, invoice_number: true, client_id: true } },
      },
    });

    return this.formatExpense(updated);
  }

  async remove(id: number, user: any) {
    const existing = await this.prisma.expense.findUnique({ where: { id } });
    if (!existing || existing.deleted_at) {
      throw new NotFoundException('Expense record not found.');
    }
    await this.prisma.expense.update({
      where: { id },
      data: { deleted_at: new Date() },
    });
    return null;
  }

  async getReceiptFile(id: number, user: any): Promise<{ buffer: Buffer; filename: string; mimeType: string }> {
    const expense = await this.prisma.expense.findUnique({ where: { id } });
    if (!expense || expense.deleted_at || !expense.receipt_file) {
      throw new NotFoundException('Receipt file not found for this expense.');
    }

    const relPath = expense.receipt_file.replace('/media/expenses/', '');
    const fullPath = path.join(this.uploadDir, relPath);

    if (!fs.existsSync(fullPath)) {
      throw new NotFoundException('Receipt file artifact does not exist on disk.');
    }

    const buffer = fs.readFileSync(fullPath);
    const ext = path.extname(fullPath).toLowerCase();
    let mimeType = 'application/octet-stream';
    if (ext === '.pdf') mimeType = 'application/pdf';
    else if (ext === '.png') mimeType = 'image/png';
    else if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
    else if (ext === '.webp') mimeType = 'image/webp';

    return {
      buffer,
      filename: expense.receipt_filename || `receipt_${id}${ext}`,
      mimeType,
    };
  }
}
