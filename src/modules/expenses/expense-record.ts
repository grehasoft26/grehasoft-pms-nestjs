import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CreateExpenseDto } from './dto/create-expense.dto';

/** Expense payment methods (Prisma enum ExpensePaymentMethod; differs from the invoice PaymentMode enum). */
export const EXPENSE_PAYMENT_METHODS = ['cash', 'upi', 'bank_transfer', 'company_card', 'other'] as const;

/**
 * Validates client / project / invoice links of an expense. `db` is the Prisma client or a transaction client, so the
 * same rules apply inside the invoice-payment transaction.
 */
export async function validateExpenseRelationships(
  db: any,
  clientId?: number | null,
  projectId?: number | null,
  invoiceId?: number | null,
): Promise<void> {
  if (clientId) {
    const client = await db.client.findUnique({ where: { id: clientId } });
    if (!client || client.deleted_at) {
      throw new BadRequestException(`Client with ID ${clientId} does not exist.`);
    }
  }

  if (projectId) {
    const project = await db.project.findUnique({ where: { id: projectId } });
    if (!project || project.deleted_at) {
      throw new BadRequestException(`Project with ID ${projectId} does not exist.`);
    }
    if (clientId && project.client_id && project.client_id !== clientId) {
      throw new BadRequestException('Selected project does not belong to the selected client.');
    }
  }

  if (invoiceId) {
    const invoice = await db.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) {
      throw new BadRequestException(`Invoice with ID ${invoiceId} does not exist.`);
    }
    if (clientId && invoice.client_id && invoice.client_id !== clientId) {
      throw new BadRequestException('Selected invoice does not belong to the selected client.');
    }
  }
}

/**
 * The single implementation of expense-creation rules (category, amount, amount paid and payment status, links,
 * employee / user, expense date, approval default). Returns the data for `expense.create`, without receipt fields.
 * Used by ExpensesService.create and by invoice payments that also record an expense (inside their transaction).
 * Nothing is written here.
 */
export async function prepareExpenseData(db: any, user: any, dto: CreateExpenseDto): Promise<Prisma.ExpenseUncheckedCreateInput> {
  const category_id = Number(dto.category_id);
  if (!category_id || isNaN(category_id)) {
    throw new BadRequestException('Invalid expense category specified.');
  }

  const category = await db.expenseCategory.findUnique({
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
  const amount_paid = dto.amount_paid !== undefined && dto.amount_paid !== '' && dto.amount_paid !== null
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
  await validateExpenseRelationships(db, client_id, project_id, invoice_id);

  const payment_account_source = dto.payment_account_source ? (dto.payment_account_source as any) : null;

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

  return {
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
    employee_id,
    user_id,
    approval_status: (dto.approval_status as any) || 'approved',
    created_by_id,
  };
}
