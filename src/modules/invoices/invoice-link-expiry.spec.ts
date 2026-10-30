import { ForbiddenException } from '@nestjs/common';
import { INVOICE_SECURE_LINK_TTL_SECONDS, InvoiceSigning, InvoicesService } from './invoices.service';
import { InvoicePaymentsService, ReceiptSigning } from './invoice-payments.service';
import { HrService, OfferLetterSigning } from '../hr/hr.service';

/**
 * Secure-link expiry: invoice links shared via WhatsApp are valid for exactly 30 days; receipt and
 * offer-letter links keep 48 hours. Expiry is signed into each token, so links issued before the
 * change keep their original expiry.
 */
const SECRET = 'test-link-secret';
const config = { get: jest.fn(() => SECRET) };
const T0 = Date.UTC(2026, 9, 30, 6, 0, 0); // fixed "now" (ms)
const T0_SECONDS = T0 / 1000;
const THIRTY_DAYS = 2592000;
const FORTY_EIGHT_HOURS = 172800;

const tokenFrom = (link: string, prefix: string) =>
  decodeURIComponent(link.slice(link.indexOf(prefix) + prefix.length).replace(/\/download\/$/, ''));
const expiryOf = (token: string) => Number(token.split('.')[1]);

describe('Invoice secure link expiry (30 days)', () => {
  let now: number;
  let prisma: any;
  let invoices: InvoicesService;

  beforeEach(() => {
    now = T0;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    prisma = {
      invoice: { findUnique: jest.fn(async () => ({ id: 77, invoice_number: 'GSI/2026-27/077', client: {}, items: [], payments: [] })) },
      invoicePayment: { findUnique: jest.fn(async () => ({ id: 5 })) },
    };
    invoices = new InvoicesService(prisma, { generateInvoicePdf: jest.fn(async () => Buffer.from('%PDF')) } as any, {} as any, config as any);
  });

  afterEach(() => jest.restoreAllMocks());

  it('the TTL constant is exactly 30 days', () => {
    expect(INVOICE_SECURE_LINK_TTL_SECONDS).toBe(THIRTY_DAYS);
  });

  it('a new invoice link expires at exactly now + 2,592,000 seconds and expires_at is the signed expiry', async () => {
    const res: any = await invoices.generateSecureLink(77, { get: () => 'pms-api.example.test', protocol: 'https' });
    const token = tokenFrom(res.secure_pdf_link, '/api/v1/invoices/public/');
    expect(expiryOf(token)).toBe(T0_SECONDS + THIRTY_DAYS);
    expect(res.expires_at).toBe(new Date((T0_SECONDS + THIRTY_DAYS) * 1000).toISOString());
    expect(res.expires_at).toBe('2026-11-29T06:00:00.000Z');
    expect(Date.parse(res.expires_at) / 1000).toBe(expiryOf(token));
    expect(InvoiceSigning.verifyToken(token, SECRET)).toEqual({ valid: true, invoiceId: 77 });
  });

  it('a 30-day link still downloads at its last second and is refused one second later', async () => {
    const res: any = await invoices.generateSecureLink(77);
    const token = tokenFrom(res.secure_pdf_link, '/api/v1/invoices/public/');

    now = (T0_SECONDS + THIRTY_DAYS - 1) * 1000; // 29 days 23:59:59 later
    await expect(invoices.generatePdfStreamFromPublicToken(token)).resolves.toMatchObject({ filename: expect.stringContaining('.pdf') });
    now = (T0_SECONDS + THIRTY_DAYS) * 1000; // exactly at expiry: still valid (refused only after it)
    expect(InvoiceSigning.verifyToken(token, SECRET).valid).toBe(true);
    now = (T0_SECONDS + THIRTY_DAYS + 1) * 1000;
    await expect(invoices.generatePdfStreamFromPublicToken(token)).rejects.toThrow(new ForbiddenException('This secure link has expired.'));
  });

  it('a 48-hour invoice link issued before the change keeps its original expiry', () => {
    const oldToken = InvoiceSigning.generateToken(77, SECRET, FORTY_EIGHT_HOURS); // as issued previously
    expect(expiryOf(oldToken)).toBe(T0_SECONDS + FORTY_EIGHT_HOURS);
    now = (T0_SECONDS + FORTY_EIGHT_HOURS) * 1000;
    expect(InvoiceSigning.verifyToken(oldToken, SECRET).valid).toBe(true);
    now = (T0_SECONDS + FORTY_EIGHT_HOURS + 1) * 1000;
    expect(InvoiceSigning.verifyToken(oldToken, SECRET)).toEqual({ valid: false, error: 'This secure link has expired.' });
  });

  it('changing the signed expiry breaks the signature (an old link cannot be extended)', () => {
    const oldToken = InvoiceSigning.generateToken(77, SECRET, FORTY_EIGHT_HOURS);
    const [id, , hmac] = oldToken.split('.');
    const extended = `${id}.${T0_SECONDS + THIRTY_DAYS}.${hmac}`;
    expect(InvoiceSigning.verifyToken(extended, SECRET)).toEqual({ valid: false, error: 'Invalid signature token.' });
  });

  it('the signers keep their 48-hour default', () => {
    expect(expiryOf(InvoiceSigning.generateToken(1, SECRET))).toBe(T0_SECONDS + FORTY_EIGHT_HOURS);
    expect(expiryOf(ReceiptSigning.generateToken(1, SECRET))).toBe(T0_SECONDS + FORTY_EIGHT_HOURS);
    expect(expiryOf(OfferLetterSigning.generateToken({ name: 'x' }, SECRET))).toBe(T0_SECONDS + FORTY_EIGHT_HOURS);
  });

  it('receipt links are unchanged: 48 hours, and no expires_at in the response', async () => {
    const payments = new InvoicePaymentsService(prisma, {} as any, {} as any, config as any);
    const res: any = await payments.generateSecureLink(5);
    expect(Object.keys(res)).toEqual(['secure_pdf_link']);
    const token = tokenFrom(res.secure_pdf_link, '/api/v1/invoice-payments/public/');
    expect(expiryOf(token)).toBe(T0_SECONDS + FORTY_EIGHT_HOURS);
  });

  it('offer-letter links are unchanged: 48 hours, and no expires_at in the response', async () => {
    const hr = new HrService({} as any, {} as any, {} as any, config as any);
    const res: any = await hr.generateOfferLetterSecureLink({ candidate_name: 'Test' });
    expect(Object.keys(res)).toEqual(['secure_pdf_link']);
    const token = tokenFrom(res.secure_pdf_link, '/api/v1/hr-documents/public/offer-letter/');
    expect(expiryOf(token)).toBe(T0_SECONDS + FORTY_EIGHT_HOURS);
  });
});
