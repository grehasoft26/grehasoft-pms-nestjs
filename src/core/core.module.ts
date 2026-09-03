import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from './prisma.service';
import { EncryptionService } from './encryption.service';
import { PdfService } from './pdf.service';
import { MailerService } from './mailer.service';

@Global()
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  providers: [PrismaService, EncryptionService, PdfService, MailerService],
  exports: [PrismaService, EncryptionService, PdfService, MailerService],
})
export class CoreModule {}
