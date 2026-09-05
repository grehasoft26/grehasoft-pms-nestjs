import { Module } from '@nestjs/common';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { InvoicePaymentsController } from './invoice-payments.controller';
import { InvoicePaymentsService } from './invoice-payments.service';
import { PdfService } from '../../core/pdf.service';

@Module({
  controllers: [InvoicesController, InvoicePaymentsController],
  providers: [InvoicesService, InvoicePaymentsService, PdfService],
  exports: [InvoicesService, InvoicePaymentsService],
})
export class InvoicesModule {}
