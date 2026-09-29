export class CreateInvoiceServiceDto {
  template_id?: number;
  name: string;
  description?: string;
  rate?: number;
  is_active?: boolean;
}
