import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { MailerService } from './mailer.service';

describe('MailerService', () => {
  let service: MailerService;
  let mockTransporter: any;

  beforeEach(async () => {
    jest.clearAllMocks();

    const mockConfigService = {
      get: jest.fn((key: string) => {
        if (key === 'EMAIL_HOST') return 'smtp.example.com';
        if (key === 'EMAIL_PORT') return 587;
        if (key === 'EMAIL_HOST_USER') return 'user@example.com';
        if (key === 'EMAIL_HOST_PASSWORD') return 'secret';
        if (key === 'DEFAULT_FROM_EMAIL') return 'Grehasoft <noreply@grehasoft.com>';
        return null;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MailerService,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<MailerService>(MailerService);

    mockTransporter = {
      sendMail: jest.fn(),
    };
    (service as any).transporter = mockTransporter;
  });

  it('should return true when nodemailer sendMail succeeds', async () => {
    mockTransporter.sendMail.mockResolvedValue({ messageId: 'msg-123' });

    const result = await service.sendMail({
      to: 'client@example.com',
      subject: 'Test Subject',
      text: 'Test Body',
    });

    expect(result).toBe(true);
    expect(mockTransporter.sendMail).toHaveBeenCalledWith({
      from: 'Grehasoft <noreply@grehasoft.com>',
      to: 'client@example.com',
      subject: 'Test Subject',
      text: 'Test Body',
      html: undefined,
      attachments: undefined,
    });
  });

  it('should log error and return false when nodemailer sendMail fails/rejects', async () => {
    mockTransporter.sendMail.mockRejectedValue(new Error('SMTP Connection Failed'));

    const result = await service.sendMail({
      to: 'client@example.com',
      subject: 'Test Subject',
      text: 'Test Body',
    });

    expect(result).toBe(false);
  });
});
