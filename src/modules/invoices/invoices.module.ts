import { Module } from '@nestjs/common';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { InvoicePaymentsController } from './invoice-payments.controller';
import { InvoicePaymentsService } from './invoice-payments.service';

@Module({
  controllers: [InvoicesController, InvoicePaymentsController],
  providers: [InvoicesService, InvoicePaymentsService],
  exports: [InvoicesService, InvoicePaymentsService],
})
export class InvoicesModule {}
