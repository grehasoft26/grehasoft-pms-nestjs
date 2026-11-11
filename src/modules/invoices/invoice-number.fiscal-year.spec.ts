import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { InvoicesService } from './invoices.service';
import { PrismaService } from '../../core/prisma.service';
import { PdfService } from '../../core/pdf.service';
import { MailerService } from '../../core/mailer.service';
import { fiscalYearLabel, invoiceNumberPrefix } from './invoice-status';

/**
 * Invoice number prefix = financial year (April 1 - March 31) of today in Asia/Kolkata, whatever the server's time zone.
 * The same IST instant must give the same prefix with a UTC, an IST, a US and an Australian process clock.
 */

const IST_INSTANTS: { iso: string; label: string; fy: string }[] = [
  { iso: '2027-03-31T18:29:59Z', label: '31 Mar 2027 23:59:59 IST', fy: '2026-27' },
  { iso: '2027-03-31T18:30:00Z', label: '1 Apr 2027 00:00:00 IST', fy: '2027-28' }, // UTC still says 31 March
  { iso: '2027-04-01T05:00:00Z', label: '1 Apr 2027 10:30 IST', fy: '2027-28' },
  { iso: '2028-03-31T18:29:59Z', label: '31 Mar 2028 23:59:59 IST', fy: '2027-28' },
  { iso: '2028-03-31T18:30:00Z', label: '1 Apr 2028 00:00:00 IST', fy: '2028-29' }, // UTC still says 31 March
  { iso: '2026-12-31T18:29:59Z', label: '31 Dec 2026 23:59:59 IST', fy: '2026-27' },
  { iso: '2026-12-31T18:30:00Z', label: '1 Jan 2027 00:00:00 IST', fy: '2026-27' }, // calendar year changes, financial year does not
  { iso: '2027-01-01T00:00:00Z', label: '1 Jan 2027 05:30 IST', fy: '2026-27' },
  { iso: '2026-03-31T18:30:00Z', label: '1 Apr 2026 00:00:00 IST', fy: '2026-27' },
  { iso: '2099-03-31T18:30:00Z', label: '1 Apr 2099 00:00:00 IST', fy: '2099-00' }, // two-digit end year wraps like the existing format
];
const PROCESS_TIME_ZONES = ['UTC', 'Asia/Kolkata', 'America/Los_Angeles', 'Pacific/Auckland'];

describe('Invoice number financial-year prefix (Asia/Kolkata)', () => {
  const originalTz = process.env.TZ;
  let service: InvoicesService;
  let prisma: { invoice: { findFirst: jest.Mock } };

  beforeEach(async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'] });
    prisma = { invoice: { findFirst: jest.fn(async () => null) } };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        { provide: PrismaService, useValue: prisma },
        { provide: PdfService, useValue: {} },
        { provide: MailerService, useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn() } },
      ],
    }).compile();
    service = module.get(InvoicesService);
  });

  afterEach(() => {
    process.env.TZ = originalTz;
    jest.useRealTimers();
  });

  describe('fiscalYearLabel / invoiceNumberPrefix', () => {
    for (const tz of PROCESS_TIME_ZONES) {
      it(`${tz} process: every IST instant gets its financial year (31 Mar 23:59 IST, 1 Apr 00:00 IST, Dec 31 / Jan 1)`, () => {
        process.env.TZ = tz;
        for (const { iso, label, fy } of IST_INSTANTS) {
          expect([label, fiscalYearLabel(new Date(iso))]).toEqual([label, fy]);
          expect(invoiceNumberPrefix(new Date(iso))).toBe(`GSI/${fy}`);
        }
      });
    }

    it('the result does not change with the server time zone for the same IST instant', () => {
      for (const { iso } of IST_INSTANTS) {
        const results = PROCESS_TIME_ZONES.map((tz) => {
          process.env.TZ = tz;
          return fiscalYearLabel(new Date(iso));
        });
        expect(new Set(results).size).toBe(1);
      }
    });

    it('the date format stays "YYYY-YY" with the existing "GSI/" prefix', () => {
      expect(invoiceNumberPrefix(new Date('2026-11-17T06:30:00Z'))).toMatch(/^GSI\/\d{4}-\d{2}$/);
      expect(invoiceNumberPrefix(new Date('2026-11-17T06:30:00Z'))).toBe('GSI/2026-27');
      expect(invoiceNumberPrefix(new Date('2027-02-10T06:30:00Z'))).toBe('GSI/2026-27'); // Jan-Mar belongs to the year that started in April
    });
  });

  describe('both generators use the same logic', () => {
    for (const tz of PROCESS_TIME_ZONES) {
      it(`${tz} process: getNextInvoiceNumber and generateNextInvoiceNumber agree with the IST financial year`, async () => {
        process.env.TZ = tz;
        for (const { iso, label, fy } of IST_INSTANTS) {
          jest.setSystemTime(new Date(iso));
          expect([label, await service.getNextInvoiceNumber()]).toEqual([label, `GSI/${fy}/001`]);
          expect([label, service.generateNextInvoiceNumber()]).toEqual([label, `GSI/${fy}/001`]);
        }
      });
    }

    it('with a UTC server, 00:00 IST on 1 April is the new financial year (the old code gave 2026-27 here)', async () => {
      process.env.TZ = 'UTC';
      jest.setSystemTime(new Date('2027-03-31T18:30:00Z'));
      expect(await service.getNextInvoiceNumber()).toBe('GSI/2027-28/001');
      expect(service.generateNextInvoiceNumber()).toBe('GSI/2027-28/001');
    });
  });

  describe('sequence and format are preserved', () => {
    const last = (invoice_number: string) => prisma.invoice.findFirst.mockResolvedValueOnce({ invoice_number });

    it('continues the numbering of the current financial year, zero-padded to three digits', async () => {
      process.env.TZ = 'UTC';
      jest.setSystemTime(new Date('2026-11-17T06:30:00Z'));
      last('GSI/2026-27/009');
      expect(await service.getNextInvoiceNumber()).toBe('GSI/2026-27/010');
      last('GSI/2026-27/099');
      expect(await service.getNextInvoiceNumber()).toBe('GSI/2026-27/100');
      last('GSI/2026-27/1234');
      expect(await service.getNextInvoiceNumber()).toBe('GSI/2026-27/1235');
      last('GSI/2026-27/xyz'); // unparsable last number: falls back to 001, as before
      expect(await service.getNextInvoiceNumber()).toBe('GSI/2026-27/001');
    });

    it('looks for the latest number with the financial year prefix (startsWith), newest first', async () => {
      process.env.TZ = 'UTC';
      jest.setSystemTime(new Date('2027-03-31T19:00:00Z')); // 00:30 IST on 1 Apr 2027
      await service.getNextInvoiceNumber();
      expect(prisma.invoice.findFirst).toHaveBeenCalledWith({
        where: { invoice_number: { startsWith: 'GSI/2027-28' } },
        orderBy: { invoice_number: 'desc' },
      });
    });

    it('a new financial year starts again at 001 and never touches earlier numbers', async () => {
      process.env.TZ = 'UTC';
      jest.setSystemTime(new Date('2027-03-31T18:30:00Z'));
      prisma.invoice.findFirst.mockImplementation(async ({ where }: any) =>
        where.invoice_number.startsWith === 'GSI/2026-27' ? { invoice_number: 'GSI/2026-27/187' } : null,
      );
      expect(await service.getNextInvoiceNumber()).toBe('GSI/2027-28/001');
      jest.setSystemTime(new Date('2027-03-31T18:29:59Z')); // one second earlier: still the old year's sequence
      expect(await service.getNextInvoiceNumber()).toBe('GSI/2026-27/188');
      expect(prisma.invoice.findFirst).toHaveBeenCalledTimes(2); // reads only; the service never writes numbers here
    });
  });
});
