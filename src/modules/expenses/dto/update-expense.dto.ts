import { ExpensePaymentMethodType, ExpensePaymentStatusType, ExpenseApprovalStatusType } from './create-expense.dto';

export class UpdateExpenseDto {
  title?: string;
  category_id?: number | string;
  amount?: number | string;
  expense_date?: string;
  vendor?: string;
  reference_number?: string;
  payment_method?: ExpensePaymentMethodType;
  payment_status?: ExpensePaymentStatusType;
  amount_paid?: number | string;
  gst_number?: string;
  gst_amount?: number | string;
  notes?: string;
  employee_id?: number | string;
  user_id?: number | string;
  client_id?: number | string;
  project_id?: number | string;
  invoice_id?: number | string;
  payment_account_source?: string;
  approval_status?: ExpenseApprovalStatusType;
}
