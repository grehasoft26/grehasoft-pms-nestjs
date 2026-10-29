import { BadRequestException } from '@nestjs/common';
import { LEAD_NOTES_MAX_LENGTH, LeadsService } from './leads.service';

/**
 * Lead form fields: company email/phone (separate from the contact person's), lead-level
 * "Last Notes" (separate from follow-ups), legacy fields that are no longer on the form, legacy
 * source values, and the contact -> company fallback when a lead is converted.
 */
const STORED = {
  id: 1,
  name: 'Asha',
  email: 'asha@contact.test',
  phone: '+91 98765 43210',
  source: 'Web',
  status: 'new',
  client_id: null,
  client: null,
  converted_project_id: null,
  enquiry_from: 'WhatsApp',
  how_contacted: 'Reference',
  contacted_person: 'Ravi',
  reference_person: null,
  company_name: 'Acme',
  company_email: null,
  company_phone: null,
  service_required: ['SEO'],
  notes: null,
  documents_given: [],
  login_credentials: [],
  deleted_at: null,
  assignments: [],
  followups: [],
};

const buildPrisma = (lead: any = STORED) => {
  const stored = { ...lead };
  return {
    stored,
    lead: {
      findFirst: jest.fn(async () => stored),
      create: jest.fn(async ({ data }: any) => ({ id: 2, followups: [], assignments: [], ...data })),
      update: jest.fn(async ({ data }: any) => Object.assign(stored, data)),
    },
    leadFollowup: { create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), delete: jest.fn(), deleteMany: jest.fn() },
    client: {
      findFirst: jest.fn(async (): Promise<any> => null),
      create: jest.fn(async ({ data }: any) => ({ id: 50, ...data })),
    },
    project: { create: jest.fn(async (_args: any) => ({ id: 30 })) },
  };
};

const admin = { id: 1, role: { name: 'SUPER_ADMIN' } };
const badRequest = async (promise: Promise<unknown>, field: string) => {
  const error = await promise.then(() => null, (e) => e);
  expect(error).toBeInstanceOf(BadRequestException);
  expect(Object.keys(error.getResponse())).toEqual([field]);
};

describe('LeadsService lead form fields', () => {
  let prisma: ReturnType<typeof buildPrisma>;
  let service: LeadsService;

  beforeEach(() => {
    prisma = buildPrisma();
    service = new LeadsService(prisma as any);
  });

  describe('create', () => {
    it('stores company email, company phone and notes (trimmed) and returns them', async () => {
      const lead: any = await service.create(admin, {
        name: 'Asha',
        email: 'asha@contact.test',
        company_name: 'Acme',
        company_email: '  info@acme.test ',
        company_phone: ' +44 (20) 7946-0958 ',
        notes: '  Wants a call next week  ',
        source: 'ChatGPT Ads',
      });
      expect(prisma.lead.create.mock.calls[0][0].data).toMatchObject({
        email: 'asha@contact.test',
        company_email: 'info@acme.test',
        company_phone: '+44 (20) 7946-0958',
        notes: 'Wants a call next week',
        source: 'ChatGPT Ads',
      });
      expect(lead).toMatchObject({
        email: 'asha@contact.test',
        company_email: 'info@acme.test',
        company_phone: '+44 (20) 7946-0958',
        notes: 'Wants a call next week',
        source: 'ChatGPT Ads',
      });
    });

    it('saves blank or missing values as null', async () => {
      await service.create(admin, { company_name: 'Acme', company_email: '   ', company_phone: '', notes: '\n ' });
      await service.create(admin, { company_name: 'Acme' });
      for (const call of prisma.lead.create.mock.calls) {
        expect(call[0].data).toMatchObject({ company_email: null, company_phone: null, notes: null });
      }
    });

    it('still accepts the legacy enquiry fields from older clients of the API', async () => {
      await service.create(admin, { company_name: 'Acme', enquiry_from: 'Call', how_contacted: 'Direct', contacted_person: 'Ravi' });
      expect(prisma.lead.create.mock.calls[0][0].data).toMatchObject({ enquiry_from: 'Call', how_contacted: 'Direct', contacted_person: 'Ravi' });
    });

    it.each([
      ['company_email', 'not-an-email'],
      ['company_email', 'a b@acme.test'],
      ['company_email', `${'a'.repeat(140)}@acme.test.com`],
      ['company_email', 42],
      ['company_phone', 'call me'],
      ['company_phone', '12345'],
      ['company_phone', '+1 234 567 890 123 456'],
      ['company_phone', '1234567890123456'],
      ['notes', 'x'.repeat(LEAD_NOTES_MAX_LENGTH + 1)],
    ])('rejects an invalid %s (%p) with a 400 and saves nothing', async (field, value) => {
      await badRequest(service.create(admin, { company_name: 'Acme', [field]: value }), field);
      expect(prisma.lead.create).not.toHaveBeenCalled();
    });

    it('accepts international phone formats and the longest allowed notes', async () => {
      for (const phone of ['+971 4 123 4567', '(020) 7946 0958', '+1-202-555-0143', '0484.2345678', '+919876543210']) {
        await service.create(admin, { company_name: 'Acme', company_phone: phone });
      }
      await service.create(admin, { company_name: 'Acme', notes: 'x'.repeat(LEAD_NOTES_MAX_LENGTH) });
      expect(prisma.lead.create).toHaveBeenCalledTimes(6);
    });
  });

  describe('update (PATCH)', () => {
    it('updates the new fields, trimming and turning blanks into null', async () => {
      const lead: any = await service.update(1, admin, { company_email: ' sales@acme.test ', company_phone: '', notes: ' Follow up on quote ' });
      expect(prisma.lead.update.mock.calls[0][0].data).toEqual({
        company_email: 'sales@acme.test',
        company_phone: null,
        notes: 'Follow up on quote',
      });
      expect(lead).toMatchObject({ company_email: 'sales@acme.test', company_phone: null, notes: 'Follow up on quote' });
    });

    it('leaves omitted fields unchanged: the legacy enquiry fields, source and the new fields', async () => {
      // What the edit form now sends: no enquiry_from / how_contacted / contacted_person
      const lead: any = await service.update(1, admin, { name: 'Asha K', company_name: 'Acme Ltd', source: 'Web' });
      const data = prisma.lead.update.mock.calls[0][0].data;
      for (const field of ['enquiry_from', 'how_contacted', 'contacted_person', 'company_email', 'company_phone', 'notes']) {
        expect(data).not.toHaveProperty(field);
      }
      expect(lead).toMatchObject({ enquiry_from: 'WhatsApp', how_contacted: 'Reference', contacted_person: 'Ravi', source: 'Web' });
    });

    it('keeps legacy source values (no allowlist) and stores new labels exactly', async () => {
      for (const source of ['Web', 'Website', 'Ads', 'Referral', 'Direct', 'Meta Ads', 'ChatGPT Ads', 'Other']) {
        await service.update(1, admin, { source });
      }
      expect(prisma.lead.update.mock.calls.map((c: any) => c[0].data.source)).toEqual(['Web', 'Website', 'Ads', 'Referral', 'Direct', 'Meta Ads', 'ChatGPT Ads', 'Other']);
    });

    it('rejects invalid values with a 400 before writing anything', async () => {
      await badRequest(service.update(1, admin, { name: 'Changed', company_email: 'nope' }), 'company_email');
      await badRequest(service.update(1, admin, { company_phone: 'abc1234567' }), 'company_phone');
      await badRequest(service.update(1, admin, { notes: 'x'.repeat(LEAD_NOTES_MAX_LENGTH + 1) }), 'notes');
      expect(prisma.lead.update).not.toHaveBeenCalled();
    });

    it('Last Notes never touch follow-up records', async () => {
      await service.update(1, admin, { notes: 'New lead-level note' });
      await service.create(admin, { company_name: 'Acme', notes: 'Another' });
      for (const fn of Object.values(prisma.leadFollowup)) expect(fn).not.toHaveBeenCalled();
      expect(prisma.lead.update.mock.calls[0][0].data).toEqual({ notes: 'New lead-level note' });
    });
  });

  describe('response mapping', () => {
    it('returns the new fields as null for existing leads that have none', async () => {
      const lead: any = await service.findOne(1, admin);
      expect(lead).toMatchObject({ company_email: null, company_phone: null, notes: null, source: 'Web' });
    });
  });

  describe('convertToProject: contact details first, company details as fallback', () => {
    const convert = async (lead: Partial<typeof STORED>) => {
      prisma = buildPrisma({ ...STORED, ...lead });
      service = new LeadsService(prisma as any);
      await service.convertToProject(1, admin, { name: 'Project' });
      return prisma.client.create.mock.calls[0]?.[0].data;
    };

    it('uses the contact person email and phone when present', async () => {
      const data = await convert({ company_email: 'info@acme.test', company_phone: '+91 484 2345678' });
      expect(prisma.client.findFirst).toHaveBeenCalledWith({ where: { email: 'asha@contact.test', deleted_at: null } });
      expect(data).toMatchObject({ email: 'asha@contact.test', phone: '+91 98765 43210' });
    });

    it('falls back to company email and phone when the contact ones are blank', async () => {
      const data = await convert({ email: '  ', phone: '', company_email: 'info@acme.test', company_phone: '+91 484 2345678' });
      expect(prisma.client.findFirst).toHaveBeenCalledWith({ where: { email: 'info@acme.test', deleted_at: null } });
      expect(data).toMatchObject({ email: 'info@acme.test', phone: '+91 484 2345678' });
    });

    it('falls back for each field independently', async () => {
      const data = await convert({ email: 'asha@contact.test', phone: ' ', company_email: 'info@acme.test', company_phone: '0484 2345678' });
      expect(data).toMatchObject({ email: 'asha@contact.test', phone: '0484 2345678' });
    });

    it('links an existing client found by the fallback company email', async () => {
      prisma = buildPrisma({ ...STORED, email: '', company_email: 'info@acme.test' });
      prisma.client.findFirst.mockResolvedValue({ id: 77 });
      service = new LeadsService(prisma as any);
      await service.convertToProject(1, admin, {});
      expect(prisma.client.create).not.toHaveBeenCalled();
      expect(prisma.project.create.mock.calls[0][0].data.client_id).toBe(77);
    });

    it('without any email it never matches an existing client and keeps the placeholder email', async () => {
      // A client stored without an email must not be picked up by an empty-email lookup
      prisma = buildPrisma({ ...STORED, email: '', phone: '', company_email: null, company_phone: null });
      prisma.client.findFirst.mockResolvedValue({ id: 99, email: '' });
      service = new LeadsService(prisma as any);
      await service.convertToProject(1, admin, {});
      expect(prisma.client.findFirst).not.toHaveBeenCalled();
      const data = prisma.client.create.mock.calls[0][0].data;
      expect(data.email).toMatch(/^client_\d+@example\.com$/);
      expect(data.phone).toBe('');
      expect(prisma.project.create.mock.calls[0][0].data.client_id).toBe(50);
    });
  });
});
