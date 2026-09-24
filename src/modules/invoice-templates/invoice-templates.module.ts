import { Module } from '@nestjs/common';
import { InvoiceTemplatesController } from './invoice-templates.controller';
import { InvoiceTemplatesService } from './invoice-templates.service';
import { PrismaService } from '../../core/prisma.service';

@Module({
  controllers: [InvoiceTemplatesController],
  providers: [InvoiceTemplatesService, PrismaService],
  exports: [InvoiceTemplatesService],
})
export class InvoiceTemplatesModule {}
