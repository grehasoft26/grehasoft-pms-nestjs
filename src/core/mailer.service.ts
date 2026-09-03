import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  private transporter: nodemailer.Transporter;
  private readonly defaultFromEmail: string;

  constructor(private readonly configService: ConfigService) {
    const host = this.configService.get<string>('EMAIL_HOST') || 'smtp.gmail.com';
    const port = Number(this.configService.get<number>('EMAIL_PORT')) || 587;
    const user = this.configService.get<string>('EMAIL_HOST_USER');
    const pass = this.configService.get<string>('EMAIL_HOST_PASSWORD');
    this.defaultFromEmail = this.configService.get<string>('DEFAULT_FROM_EMAIL') || 'Grehasoft PMS <noreply@grehasoft.com>';

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: user && pass ? { user, pass } : undefined,
    });
  }

  /**
   * Send basic email message
   */
  async sendMail(options: {
    to: string | string[];
    subject: string;
    text?: string;
    html?: string;
    attachments?: Array<{ filename: string; content: Buffer | string }>;
  }): Promise<boolean> {
    try {
      const info = await this.transporter.sendMail({
        from: this.defaultFromEmail,
        to: options.to,
        subject: options.subject,
        text: options.text,
        html: options.html,
        attachments: options.attachments,
      });
      this.logger.log(`[SUCCESS] Email sent: ${info.messageId} to ${options.to}`);
      return true;
    } catch (error) {
      this.logger.error(`[ERROR] Failed to send email to ${options.to}:`, error);
      return false;
    }
  }

  /**
   * Send Invoice Email with PDF Attachment
   */
  async sendInvoiceEmail(to: string, invoiceNumber: string, pdfBuffer: Buffer): Promise<boolean> {
    return this.sendMail({
      to,
      subject: `Invoice #${invoiceNumber} from Grehasoft`,
      text: `Dear Client,\n\nPlease find attached your invoice #${invoiceNumber}.\n\nThank you,\nGrehasoft Team`,
      attachments: [
        {
          filename: `Invoice_${invoiceNumber}.pdf`,
          content: pdfBuffer,
        },
      ],
    });
  }

  /**
   * Send Domain Alert Email to Admins
   */
  async sendDomainAlertEmail(adminEmails: string[], domainName: string, alertType: string, expiryDate: string): Promise<boolean> {
    const subject = `Grehasoft PMS - Domain Alert (${alertType})`;
    const message = `Grehasoft PMS Domain Alert\n\nAlert Type: ${alertType}\nDomain Name: ${domainName}\nExpiry Date: ${expiryDate}\n\nPlease login to Grehasoft PMS to renew the domain.`;
    return this.sendMail({
      to: adminEmails,
      subject,
      text: message,
    });
  }
}
