export class CreateInvoiceTemplateDto {
  name: string;
  description: string;
  rate: number;
  is_active?: boolean;
}
