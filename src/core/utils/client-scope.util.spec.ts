import { NotFoundException } from '@nestjs/common';
import { resolveClientForUser } from './client-scope.util';
import { ClientPortalService } from '../../modules/client-portal/client-portal.service';

/**
 * Phase 2.2: client resolution for CLIENT portal users. The old lookup matched
 * `client.id === user.id`, which handed a portal user an unrelated client's data.
 */
const CLIENTS = [
  { id: 1, email: 'acme@x.test', deleted_at: null },
  { id: 2, email: 'shared@x.test', deleted_at: null },
  { id: 3, email: 'shared@x.test', deleted_at: null },
  { id: 4, email: 'gone@x.test', deleted_at: new Date('2026-09-01') },
  // Same number as the portal user's id below; must never be picked for that reason
  { id: 77, email: 'other@x.test', deleted_at: null },
];

const buildPrisma = () => {
  const matches = (c: any, where: any) =>
    Object.entries(where).every(([k, v]) => (v === null ? c[k] === null : c[k] === v));
  return {
    client: {
      findFirst: jest.fn(async ({ where }: any) => CLIENTS.find((c) => matches(c, where)) ?? null),
      findMany: jest.fn(async ({ where, take }: any) => CLIENTS.filter((c) => matches(c, where)).slice(0, take)),
    },
  };
};

describe('resolveClientForUser', () => {
  it('uses users.client_id when present', async () => {
    const prisma = buildPrisma();
    await expect(resolveClientForUser(prisma, { client_id: 1, email: 'shared@x.test' })).resolves.toMatchObject({ id: 1 });
  });

  it('ignores a soft-deleted linked client', async () => {
    await expect(resolveClientForUser(buildPrisma(), { client_id: 4 })).resolves.toBeNull();
  });

  it('falls back to a unique email match', async () => {
    await expect(resolveClientForUser(buildPrisma(), { email: ' acme@x.test ' })).resolves.toMatchObject({ id: 1 });
  });

  it('returns null when the email matches several clients', async () => {
    await expect(resolveClientForUser(buildPrisma(), { email: 'shared@x.test' })).resolves.toBeNull();
  });

  it('never matches a client by the user id', async () => {
    const prisma = buildPrisma();
    const user: any = { id: 77, email: 'nobody@x.test' };
    await expect(resolveClientForUser(prisma, user)).resolves.toBeNull();
    for (const call of [...prisma.client.findFirst.mock.calls, ...prisma.client.findMany.mock.calls]) {
      expect(JSON.stringify(call[0].where)).not.toContain('77');
    }
  });

  it('returns null without a user, link or email', async () => {
    await expect(resolveClientForUser(buildPrisma(), null)).resolves.toBeNull();
    await expect(resolveClientForUser(buildPrisma(), { email: '' })).resolves.toBeNull();
  });
});

describe('ClientPortalService client resolution', () => {
  it('denies a portal user whose id equals an unrelated client id', async () => {
    const service = new ClientPortalService(buildPrisma() as any);
    const user = { id: 77, email: 'nobody@x.test', role: { name: 'CLIENT' } };
    await expect((service as any).resolveAssociatedClient(user)).rejects.toThrow(NotFoundException);
  });

  it('resolves the linked client for a portal user', async () => {
    const service = new ClientPortalService(buildPrisma() as any);
    const user = { id: 77, client_id: 1, email: 'nobody@x.test', role: { name: 'CLIENT' } };
    await expect((service as any).resolveAssociatedClient(user)).resolves.toMatchObject({ id: 1 });
  });
});
