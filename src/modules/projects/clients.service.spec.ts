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
    client: {
      findFirst: jest.fn().mockImplementation(async ({ where }) => {
        const clients = Object.values(mockClientsDb).filter((c: any) => c.deleted_at === null);
        
        if (where.email !== undefined) {
          const matched = clients.find((c: any) => {
            if (c.email !== where.email) return false;
            if (where.id?.not !== undefined && c.id === where.id.not) return false;
            return true;
          });
          return matched || null;
        }

        if (where.id !== undefined) {
          const matched = clients.find((c: any) => c.id === where.id);
          return matched || null;
        }

        return null;
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

    it('should reject creation if email is a duplicate of an existing non-empty email', async () => {
      await service.create({
        name: 'Client 1',
        company_name: 'Corp 1',
        email: 'dup@company.com',
      });

      await expect(
        service.create({
          name: 'Client 2',
          company_name: 'Corp 2',
          email: 'dup@company.com',
        }),
      ).rejects.toThrow(BadRequestException);
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
});
