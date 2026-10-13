import { Test, TestingModule } from '@nestjs/testing';
import { ClientsService } from './clients.service';
import { PrismaService } from '../../core/prisma.service';
import { BadRequestException } from '@nestjs/common';

describe('ClientsService', () => {
  let service: ClientsService;
  let prisma: any;

  const mockClientsDb: Record<number, any> = {};
  let nextId = 1;

  const mockPrismaService = {
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ lock_result: 1 }]),
    invoice: {
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
    invoicePayment: {
      update: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
    user: {
      count: jest.fn().mockResolvedValue(0),
    },
    client: {
      findFirst: jest.fn().mockImplementation(async ({ where }) => {
        let clients = Object.values(mockClientsDb);
        if (where?.deleted_at === null) {
          clients = clients.filter((c: any) => c.deleted_at === null);
        }

        if (where?.email !== undefined) {
          clients = clients.filter((c: any) => c.email === where.email);
        }

        if (where?.company_name !== undefined) {
          const rawName =
            typeof where.company_name === 'string'
              ? where.company_name
              : where.company_name.equals || where.company_name;
          clients = clients.filter(
            (c: any) => String(c.company_name).toLowerCase() === String(rawName).toLowerCase(),
          );
        }

        if (where?.id?.not !== undefined) {
          clients = clients.filter((c: any) => c.id !== where.id.not);
        } else if (where?.id !== undefined && typeof where.id === 'number') {
          clients = clients.filter((c: any) => c.id === where.id);
        }

        return clients[0] || null;
      }),

      create: jest.fn().mockImplementation(async ({ data }) => {
        const newClient = {
          id: nextId++,
          name: data.name,
          email: data.email,
          phone: data.phone || '',
          company_name: data.company_name || '',
          gst_no: data.gst_no || null,
          address: data.address || '',
          status: data.status || 'active',
          created_at: new Date(),
          updated_at: new Date(),
          deleted_at: null,
          portal_users: [],
        };
        mockClientsDb[newClient.id] = newClient;
        return newClient;
      }),

      update: jest.fn().mockImplementation(async ({ where, data }) => {
        const existing = mockClientsDb[where.id];
        if (!existing) throw new Error('Not found');

        const updated = {
          ...existing,
          ...data,
          updated_at: new Date(),
        };
        mockClientsDb[where.id] = updated;
        return updated;
      }),

      findMany: jest.fn().mockImplementation(async ({ where, skip, take }) => {
        let clients = Object.values(mockClientsDb).filter((c: any) => c.deleted_at === null);
        if (where?.OR && Array.isArray(where.OR)) {
          clients = clients.filter((c: any) => {
            return where.OR.some((condition: any) => {
              for (const field of Object.keys(condition)) {
                const val = c[field];
                const searchStr = condition[field]?.contains;
                if (val && searchStr && String(val).toLowerCase().includes(String(searchStr).toLowerCase())) {
                  return true;
                }
              }
              return false;
            });
          });
        }
        clients.sort((a: any, b: any) => b.id - a.id);
        if (skip !== undefined || take !== undefined) {
          const start = skip || 0;
          const end = take ? start + take : undefined;
          clients = clients.slice(start, end);
        }
        return clients;
      }),

      count: jest.fn().mockImplementation(async ({ where }) => {
        let clients = Object.values(mockClientsDb).filter((c: any) => c.deleted_at === null);
        if (where?.OR && Array.isArray(where.OR)) {
          clients = clients.filter((c: any) => {
            return where.OR.some((condition: any) => {
              for (const field of Object.keys(condition)) {
                const val = c[field];
                const searchStr = condition[field]?.contains;
                if (val && searchStr && String(val).toLowerCase().includes(String(searchStr).toLowerCase())) {
                  return true;
                }
              }
              return false;
            });
          });
        }
        return clients.length;
      }),
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    Object.keys(mockClientsDb).forEach((k) => delete mockClientsDb[Number(k)]);
    nextId = 1;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClientsService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    service = module.get<ClientsService>(ClientsService);
    prisma = module.get(PrismaService);
  });

  describe('findAll', () => {
    const adminUser = { id: 1, is_superuser: true, role: { name: 'SUPER_ADMIN' } };

    beforeEach(async () => {
      await service.create({ name: 'Rahul Nair', company_name: 'KSFE D H ROAD ERNAKULAM', email: 'ksfe@example.com', phone: '9847012345', gst_number: '32AAAAA0000A1Z5', address: 'MG Road Ernakulam' });
      await service.create({ name: 'Anil Kumar', company_name: 'Tech Solutions', email: 'anil@tech.com', phone: '9847054321', gst_number: '32BBBBB1111B1Z6', address: 'Kaloor Kochi' });
      await service.create({ name: 'Suresh Mani', company_name: 'Global Corp', email: 'suresh@global.com', phone: '9847099999', gst_number: '32CCCCC2222C1Z7', address: 'KSFE Building Thrissur' });
    });

    it('should search case-insensitively across company_name, name, email, phone, gst_no, and address', async () => {
      // Search by company_name partial case-insensitive match
      const res1: any = await service.findAll(adminUser, { search: 'ksfe' });
      expect(res1.count).toBe(2); // Match KSFE D H ROAD ERNAKULAM and KSFE Building Thrissur
      expect(res1.results.length).toBe(2);

      // Search by GST number
      const res2: any = await service.findAll(adminUser, { search: '32AAAAA' });
      expect(res2.count).toBe(1);
      expect(res2.results[0].company_name).toBe('KSFE D H ROAD ERNAKULAM');

      // Search by Phone
      const res3: any = await service.findAll(adminUser, { search: '54321' });
      expect(res3.count).toBe(1);
      expect(res3.results[0].name).toBe('Anil Kumar');

      // Search by Address
      const res4: any = await service.findAll(adminUser, { search: 'MG Road' });
      expect(res4.count).toBe(1);
      expect(res4.results[0].email).toBe('ksfe@example.com');
    });

    it('should return correct filtered count and paginated results for search', async () => {
      const res: any = await service.findAll(adminUser, { search: 'ksfe', page: '1', limit: '1' });
      expect(res.count).toBe(2);
      expect(res.results.length).toBe(1);
      expect(res.next).toContain('page=2');
      expect(res.next).toContain('search=ksfe');
    });

    it('should return full list and total count when search is empty', async () => {
      const res: any = await service.findAll(adminUser, { search: '', page: '1', limit: '10' });
      expect(res.count).toBe(3);
      expect(res.results.length).toBe(3);
    });
  });

  describe('create', () => {
    it('should create a client successfully with a valid email and company name', async () => {
      const payload = {
        name: 'John Doe',
        company_name: 'Tech Corp',
        email: 'john@techcorp.com',
        phone: '1234567890',
        address: '123 Main St',
      };

      const result = await service.create(payload);

      expect(result).toBeDefined();
      expect(result.id).toBe(1);
      expect(result.name).toBe('John Doe');
      expect(result.company_name).toBe('Tech Corp');
      expect(result.email).toBe('john@techcorp.com');
    });

    it('should create a client successfully with blank contact_person when company_name is provided', async () => {
      const payload = {
        name: '',
        company_name: 'Tech Corp Only',
        email: 'individual@domain.com',
      };

      const result = await service.create(payload);

      expect(result).toBeDefined();
      expect(result.name).toBe('');
      expect(result.company_name).toBe('Tech Corp Only');
    });

    it('should reject creation when company_name is blank', async () => {
      const payload = {
        name: 'John Doe',
        company_name: '',
        email: 'john@domain.com',
      };

      await expect(service.create(payload)).rejects.toThrow(BadRequestException);
    });

    it('should create a client successfully with a blank/empty email', async () => {
      const payload = {
        name: 'Jane Smith',
        company_name: 'No Email Corp',
        email: '',
        phone: '9876543210',
        address: '456 Side St',
      };

      const result = await service.create(payload);

      expect(result).toBeDefined();
      expect(result.id).toBe(1);
      expect(result.name).toBe('Jane Smith');
      expect(result.company_name).toBe('No Email Corp');
      expect(result.email).toBe('');
    });

    it('should create multiple clients with blank email without triggering duplicate error', async () => {
      const payload1 = {
        name: 'Client 1',
        company_name: 'Corp 1',
        email: '',
      };
      const payload2 = {
        name: 'Client 2',
        company_name: 'Corp 2',
        email: '',
      };

      const result1 = await service.create(payload1);
      const result2 = await service.create(payload2);

      expect(result1.email).toBe('');
      expect(result2.email).toBe('');
    });

    it('should reject creation when company name already exists with a different email', async () => {
      await service.create({
        name: 'Client 1',
        company_name: 'Acme Corp',
        email: 'first@acme.com',
      });

      await expect(
        service.create({
          name: 'Client 2',
          company_name: 'Acme Corp',
          email: 'second@acme.com',
        }),
      ).rejects.toMatchObject({
        response: { company_name: ['This company name is already registered.'] },
      });
    });

    it('should reject creation when company name already exists with the same email', async () => {
      await service.create({
        name: 'Client 1',
        company_name: 'Acme Corp',
        email: 'shared@acme.com',
      });

      await expect(
        service.create({
          name: 'Client 2',
          company_name: 'Acme Corp',
          email: 'shared@acme.com',
        }),
      ).rejects.toMatchObject({
        response: { company_name: ['This company name is already registered.'] },
      });
    });

    it('should allow creation when email is reused with a different company name', async () => {
      await service.create({
        name: 'Client 1',
        company_name: 'Corp 1',
        email: 'shared@company.com',
      });

      const result = await service.create({
        name: 'Client 2',
        company_name: 'Corp 2',
        email: 'shared@company.com',
      });

      expect(result.company_name).toBe('Corp 2');
      expect(result.email).toBe('shared@company.com');
    });

    it('should reject concurrent creation of the same company name', async () => {
      const payload = {
        name: 'Concurrent',
        company_name: 'Lock Corp',
        email: 'one@lock.com',
      };
      const payload2 = {
        name: 'Concurrent 2',
        company_name: 'Lock Corp',
        email: 'two@lock.com',
      };

      const results = await Promise.allSettled([service.create(payload), service.create(payload2)]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        response: { company_name: ['This company name is already registered.'] },
      });
    });
  });

  describe('update', () => {
    it('should allow updating client email to blank', async () => {
      const created = await service.create({
        name: 'Client Initial',
        company_name: 'Corp Initial',
        email: 'initial@company.com',
      });

      const user = { id: 1, role: { name: 'SUPER_ADMIN' } };
      const updated = await service.update(created.id, user, { email: '' });

      expect(updated.email).toBe('');
    });

    it('should reject update if company_name is cleared to blank', async () => {
      const created = await service.create({
        name: 'Client Initial',
        company_name: 'Corp Initial',
        email: 'initial@company.com',
      });

      const user = { id: 1, role: { name: 'SUPER_ADMIN' } };
      await expect(service.update(created.id, user, { company_name: '' })).rejects.toThrow(BadRequestException);
    });

    it('should allow updating email to an email already used by another client', async () => {
      const first = await service.create({
        name: 'Client A',
        company_name: 'Alpha Ltd',
        email: 'alpha@company.com',
      });
      const second = await service.create({
        name: 'Client B',
        company_name: 'Beta Ltd',
        email: 'beta@company.com',
      });

      const user = { id: 1, role: { name: 'SUPER_ADMIN' } };
      const updated = await service.update(second.id, user, { email: first.email });

      expect(updated.email).toBe('alpha@company.com');
    });

    it('should reject update if company_name duplicates another client', async () => {
      await service.create({
        name: 'Client A',
        company_name: 'Alpha Ltd',
        email: 'alpha@company.com',
      });
      const second = await service.create({
        name: 'Client B',
        company_name: 'Beta Ltd',
        email: 'beta@company.com',
      });

      const user = { id: 1, role: { name: 'SUPER_ADMIN' } };
      await expect(service.update(second.id, user, { company_name: 'Alpha Ltd' })).rejects.toMatchObject({
        response: { company_name: ['This company name is already registered.'] },
      });
    });

    it('should allow clearing contact_person name on update', async () => {
      const created = await service.create({
        name: 'Client Initial',
        company_name: 'Corp Initial',
      });

      const user = { id: 1, role: { name: 'SUPER_ADMIN' } };
      const updated = await service.update(created.id, user, { name: '' });

      expect(updated.name).toBe('');
    });
  });

  describe('remove', () => {
    const user = { id: 1, is_superuser: true, role: { name: 'SUPER_ADMIN' } };
    const BLOCK_MESSAGE = 'Cannot delete this client because invoices are associated with this client.';

    beforeEach(() => {
      prisma.invoice.count.mockResolvedValue(0);
      prisma.user.count.mockResolvedValue(0);
    });

    it('rejects deletion with 400 and the exact message when the client has invoices', async () => {
      const created = await service.create({ name: 'A', company_name: 'Has Invoices' });
      prisma.invoice.count.mockResolvedValue(2);

      const promise = service.remove(created.id, user, {});
      await expect(promise).rejects.toBeInstanceOf(BadRequestException);
      await expect(promise).rejects.toMatchObject({
        status: 400,
        response: { error: BLOCK_MESSAGE },
      });

      expect(prisma.invoice.count).toHaveBeenCalledWith({ where: { client_id: created.id } });
      expect(mockClientsDb[created.id].deleted_at).toBeNull();
      expect(prisma.client.update).not.toHaveBeenCalled();
    });

    it('blocks deletion even when a super admin passes force=true', async () => {
      const created = await service.create({ name: 'A', company_name: 'Forced' });
      prisma.invoice.count.mockResolvedValue(1);

      await expect(service.remove(created.id, user, { force: 'true' })).rejects.toMatchObject({
        response: { error: BLOCK_MESSAGE },
      });
      expect(mockClientsDb[created.id].deleted_at).toBeNull();
    });

    it('does not modify or delete any invoices or payments when deletion is blocked', async () => {
      const created = await service.create({ name: 'A', company_name: 'Protected' });
      prisma.invoice.count.mockResolvedValue(3);
      prisma.client.update.mockClear();

      await expect(service.remove(created.id, user, {})).rejects.toBeInstanceOf(BadRequestException);

      for (const model of [prisma.invoice, prisma.invoicePayment]) {
        expect(model.update).not.toHaveBeenCalled();
        expect(model.updateMany).not.toHaveBeenCalled();
        expect(model.delete).not.toHaveBeenCalled();
        expect(model.deleteMany).not.toHaveBeenCalled();
      }
      expect(prisma.client.update).not.toHaveBeenCalled();
    });

    it('still deletes (soft-deletes) a client that has no invoices', async () => {
      const created = await service.create({ name: 'B', company_name: 'No Invoices' });

      const result = await service.remove(created.id, user, {});

      expect(result).toBeNull();
      expect(prisma.client.update).toHaveBeenCalledWith({
        where: { id: created.id },
        data: { deleted_at: expect.any(Date) },
      });
      expect(mockClientsDb[created.id].deleted_at).toBeInstanceOf(Date);
      expect(prisma.invoice.update).not.toHaveBeenCalled();
      expect(prisma.invoice.deleteMany).not.toHaveBeenCalled();
    });
  });
});
