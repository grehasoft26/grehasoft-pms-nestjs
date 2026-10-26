import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from './prisma.service';
import { EncryptionService } from './encryption.service';
import { CredentialCryptoService } from './credential-crypto.service';
import { PdfService } from './pdf.service';
import { MailerService } from './mailer.service';

@Global()
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  providers: [PrismaService, EncryptionService, CredentialCryptoService, PdfService, MailerService],
  exports: [PrismaService, EncryptionService, CredentialCryptoService, PdfService, MailerService],
})
export class CoreModule {}
