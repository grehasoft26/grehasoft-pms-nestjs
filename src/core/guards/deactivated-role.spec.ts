import { UnauthorizedException } from '@nestjs/common';

// The installed @nestjs/jwt is published as ESM, which this Jest setup does not transform.
// AuthService only needs `sign`, so a stub is enough for these tests.
jest.mock('@nestjs/jwt', () => ({
  JwtService: class {
    sign(payload: any) {
      return `token-for-${payload.sub}`;
    }
  },
}));

import { JwtService } from '@nestjs/jwt';
import { JwtStrategy } from './jwt.strategy';
import { AuthService } from '../../modules/auth/auth.service';
import { PasswordUtil } from '../utils/password.util';
import { DEACTIVATED_ROLE_MESSAGE, applyRoleStatus } from '../utils/role-access.util';

/**
 * Users still assigned to a soft-deleted role are refused at login and on every request
 * (fail closed), so role-NAME checks in services cannot grant that role's behaviour.
 * is_superuser accounts keep access with the deleted role removed.
 */
const DELETED = new Date('2026-09-01T00:00:00.000Z');
const activeRole = { id: 3, name: 'TEAM_MEMBER', permissions: ['VIEW_TASKS'], deleted_at: null };
const deletedAdminRole = { id: 2, name: 'ADMIN', permissions: ['MANAGE_USERS'], deleted_at: DELETED };
const deletedClientRole = { id: 7, name: 'CLIENT', permissions: [], deleted_at: DELETED };

describe('applyRoleStatus', () => {
  it('keeps users with an active role or no role unchanged', () => {
    const u1 = { id: 1, is_superuser: false, role: activeRole };
    const u2 = { id: 2, is_superuser: false, role: null };
    expect(applyRoleStatus(u1)).toBe(u1);
    expect(applyRoleStatus(u2)).toBe(u2);
  });

  it('refuses users on a deleted role (including deleted CLIENT, which would otherwise lose client scoping)', () => {
    expect(applyRoleStatus({ id: 1, is_superuser: false, role: deletedAdminRole })).toBeNull();
    expect(applyRoleStatus({ id: 2, is_superuser: false, role: deletedClientRole })).toBeNull();
  });

  it('keeps is_superuser accounts, removing the deleted role', () => {
    expect(applyRoleStatus({ id: 1, is_superuser: true, role: deletedAdminRole })).toEqual({ id: 1, is_superuser: true, role: null });
  });
});

describe('JwtStrategy.validate with deleted roles', () => {
  const strategyFor = (user: any) =>
    new JwtStrategy({ get: () => 'test-secret' } as any, { user: { findFirst: jest.fn().mockResolvedValue(user) } } as any);

  it('returns users with an active role', async () => {
    const user = { id: 5, is_superuser: false, role: activeRole };
    await expect(strategyFor(user).validate({ sub: 5 })).resolves.toBe(user);
  });

  it('rejects users on a deleted role with a clear message', async () => {
    const error = await strategyFor({ id: 6, is_superuser: false, role: deletedAdminRole }).validate({ sub: 6 }).catch((e) => e);
    expect(error).toBeInstanceOf(UnauthorizedException);
    expect(error.message).toBe(DEACTIVATED_ROLE_MESSAGE);
  });

  it('lets is_superuser accounts through without the deleted role', async () => {
    const result: any = await strategyFor({ id: 7, is_superuser: true, role: deletedAdminRole }).validate({ sub: 7 });
    expect(result).toMatchObject({ id: 7, is_superuser: true, role: null });
  });
});

describe('AuthService.login with deleted roles', () => {
  let passwordHash: string;
  beforeAll(async () => {
    passwordHash = await PasswordUtil.hashPassword('secret-pass');
  });

  const serviceFor = (user: any) =>
    new AuthService(
      { user: { findFirst: jest.fn().mockResolvedValue(user), update: jest.fn().mockResolvedValue(user) } } as any,
      new (JwtService as any)(),
    );

  it('refuses login for a user on a deleted role', async () => {
    const user = { id: 8, username: 'u', email: 'u@x.test', password: passwordHash, is_active: true, is_superuser: false, role: deletedAdminRole };
    await expect(serviceFor(user).login({ username: 'u', password: 'secret-pass' })).rejects.toThrow(DEACTIVATED_ROLE_MESSAGE);
  });

  it('still logs in users with an active role', async () => {
    const user = { id: 9, username: 'v', email: 'v@x.test', password: passwordHash, is_active: true, is_superuser: false, role: activeRole };
    const result: any = await serviceFor(user).login({ username: 'v', password: 'secret-pass' });
    expect(result.access).toEqual(expect.any(String));
  });
});
