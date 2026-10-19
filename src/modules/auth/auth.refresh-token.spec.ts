import { UnauthorizedException } from '@nestjs/common';

// @nestjs/jwt ships ESM-only helpers Jest cannot load here; the service only needs the injected instance
jest.mock('@nestjs/jwt', () => ({ JwtService: class {} }));

import { AuthService } from './auth.service';

/**
 * POST /api/token/refresh must apply the same rules as JwtStrategy: no new access token for
 * deleted or inactive users, or for users still assigned to a soft-deleted role
 * (is_superuser accounts keep access, as in JwtStrategy).
 */
const DELETED = new Date('2026-10-01T00:00:00.000Z');

const buildService = (rows: any[]) => {
  const prisma = {
    user: {
      findFirst: jest.fn(async ({ where }: any) =>
        rows.find((u) => u.id === where.id && u.deleted_at === null && u.is_active === true) ?? null,
      ),
    },
  };
  const jwt = {
    verify: jest.fn((token: string) => {
      if (!token.startsWith('valid:')) throw new Error('bad token');
      return { sub: Number(token.slice(6)) };
    }),
    sign: jest.fn(() => 'new-access-token'),
  };
  return { service: new AuthService(prisma as any, jwt as any), prisma, jwt };
};

const user = (id: number, extra: any = {}) => ({
  id, username: `u${id}`, email: `u${id}@x.test`, is_active: true, deleted_at: null, is_superuser: false,
  role: { id: 4, name: 'TEAM_MEMBER', permissions: ['VIEW_TASKS'], deleted_at: null }, ...extra,
});

describe('AuthService.refreshToken role validation (no-reload sync stage 1)', () => {
  it('issues a new access token for an active user with an active role', async () => {
    const { service, prisma } = buildService([user(1)]);
    await expect(service.refreshToken('valid:1')).resolves.toEqual({ access: 'new-access-token' });
    expect(prisma.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({ include: { role: true } }));
  });

  it('refuses users whose role was soft-deleted', async () => {
    const { service, jwt } = buildService([user(2, { role: { id: 9, name: 'OLD', permissions: [], deleted_at: DELETED } })]);
    await expect(service.refreshToken('valid:2')).rejects.toThrow(UnauthorizedException);
    expect(jwt.sign).not.toHaveBeenCalled();
  });

  it('refuses inactive or deleted users and unknown ids', async () => {
    const { service, jwt } = buildService([user(3, { is_active: false }), user(4, { deleted_at: DELETED })]);
    for (const token of ['valid:3', 'valid:4', 'valid:99']) {
      await expect(service.refreshToken(token)).rejects.toThrow(UnauthorizedException);
    }
    expect(jwt.sign).not.toHaveBeenCalled();
  });

  it('keeps is_superuser accounts working even when their role was deleted (same as JwtStrategy)', async () => {
    const { service } = buildService([user(5, { is_superuser: true, role: { id: 9, name: 'OLD', permissions: [], deleted_at: DELETED } })]);
    await expect(service.refreshToken('valid:5')).resolves.toEqual({ access: 'new-access-token' });
  });

  it('rejects missing or invalid refresh tokens', async () => {
    const { service } = buildService([user(1)]);
    await expect(service.refreshToken('')).rejects.toThrow(UnauthorizedException);
    await expect(service.refreshToken('forged')).rejects.toThrow(UnauthorizedException);
  });
});
