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
          company_name: data.company_name,
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

  describe('create', () => {
    it('should create a client successfully with a valid email', async () => {
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
  });
});
