import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from './permissions.guard';
import { getActiveRolePermissions, isActiveRole, isSuperAdmin, isSuperAdminRole } from '../utils/role-access.util';

const DELETED = new Date('2026-10-01T00:00:00.000Z');

const role = (name: string, permissions: string[] = [], deleted_at: Date | null = null) => ({ id: 1, name, permissions, deleted_at });

describe('role-access util', () => {
  it('7. is_superuser grants super-admin independent of the role name', () => {
    expect(isSuperAdmin({ is_superuser: true, role: null })).toBe(true);
    expect(isSuperAdmin({ is_superuser: true, role: role('TEAM_MEMBER') })).toBe(true);
    expect(isSuperAdmin({ is_superuser: true, role: role('ANYTHING', [], DELETED) })).toBe(true);
  });

  it('recognises the active SUPER_ADMIN role', () => {
    expect(isSuperAdmin({ is_superuser: false, role: role('SUPER_ADMIN') })).toBe(true);
    expect(isSuperAdminRole(role('SUPER_ADMIN'))).toBe(true);
  });

  it('8/9. a soft-deleted SUPER_ADMIN role grants nothing', () => {
    expect(isSuperAdmin({ is_superuser: false, role: role('SUPER_ADMIN', [], DELETED) })).toBe(false);
    expect(isSuperAdminRole(role('SUPER_ADMIN', [], DELETED))).toBe(false);
  });

  it('8. a renamed former SUPER_ADMIN role is not super-admin', () => {
    expect(isSuperAdmin({ is_superuser: false, role: role('OWNER') })).toBe(false);
  });

  it('9. deleted or missing roles grant no permissions', () => {
    expect(getActiveRolePermissions({ role: role('ADMIN', ['MANAGE_USERS'], DELETED) })).toEqual([]);
    expect(getActiveRolePermissions({ role: null })).toEqual([]);
    expect(getActiveRolePermissions(null)).toEqual([]);
    expect(isActiveRole(role('ADMIN', [], DELETED))).toBe(false);
  });

  it('normalises permission names and ignores malformed entries', () => {
    expect(getActiveRolePermissions({ role: role('X', ['manage_users', 5 as any, null as any]) })).toEqual(['MANAGE_USERS']);
    expect(getActiveRolePermissions({ role: { name: 'X', permissions: 'MANAGE_USERS' } as any })).toEqual([]);
  });
});

describe('PermissionsGuard', () => {
  const guardFor = (required: string[] | undefined, isPublic = false, clientAccess = false) =>
    new PermissionsGuard({
      getAllAndOverride: (key: string) =>
        key === 'isPublic' ? isPublic : key === 'clientAccess' ? clientAccess : required,
    } as unknown as Reflector);

  const ctx = (user: any) =>
    ({
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as any;

  const check = (user: any, required: string[]) => guardFor(required).canActivate(ctx(user));

  it('allows is_superuser accounts regardless of role', () => {
    expect(check({ is_superuser: true, role: null }, ['MANAGE_SETTINGS'])).toBe(true);
  });

  it('allows the active SUPER_ADMIN role', () => {
    expect(check({ role: role('SUPER_ADMIN') }, ['MANAGE_SETTINGS'])).toBe(true);
  });

  it('8. denies a soft-deleted SUPER_ADMIN role', () => {
    expect(() => check({ role: role('SUPER_ADMIN', ['MANAGE_SETTINGS'], DELETED) }, ['MANAGE_SETTINGS'])).toThrow(ForbiddenException);
  });

  it('9. denies permissions from a soft-deleted role', () => {
    expect(() => check({ role: role('ADMIN', ['MANAGE_USERS'], DELETED) }, ['MANAGE_USERS'])).toThrow(ForbiddenException);
  });

  it('allows when the active role has any one of the required permissions', () => {
    expect(check({ role: role('ADMIN', ['MANAGE_USERS']) }, ['MANAGE_SETTINGS', 'MANAGE_USERS'])).toBe(true);
  });

  it('denies when the active role has none of them', () => {
    expect(() => check({ role: role('ADMIN', ['MANAGE_USERS']) }, ['MANAGE_SETTINGS'])).toThrow(ForbiddenException);
  });

  describe('Phase 2.2: CLIENT access only on @ClientAccess() routes', () => {
    const clientRoute = (user: any, required: string[]) => guardFor(required, false, true).canActivate(ctx(user));

    it('an active CLIENT passes routes marked @ClientAccess() (any method)', () => {
      expect(clientRoute({ role: role('CLIENT') }, ['VIEW_TASKS'])).toBe(true);
      expect(clientRoute({ role: role('CLIENT') }, ['VIEW_CLIENTS'])).toBe(true);
    });

    it('a CLIENT no longer passes unmarked VIEW_-only routes (e.g. financial reports, leads)', () => {
      expect(() => check({ role: role('CLIENT') }, ['VIEW_FINANCIAL_REPORTS'])).toThrow(ForbiddenException);
      expect(() => check({ role: role('CLIENT') }, ['VIEW_LEADS'])).toThrow(ForbiddenException);
      expect(() => check({ role: role('CLIENT') }, ['VIEW_CLIENTS'])).toThrow(ForbiddenException);
      expect(() => check({ role: role('CLIENT') }, ['MANAGE_INVOICES'])).toThrow(ForbiddenException);
    });

    it('a deleted CLIENT role gets nothing, even on marked routes', () => {
      expect(() => clientRoute({ role: role('CLIENT', [], DELETED) }, ['VIEW_TASKS'])).toThrow(ForbiddenException);
    });

    it('the marker does not open routes to other roles', () => {
      expect(() => clientRoute({ role: role('TEAM_MEMBER', ['VIEW_DASHBOARD']) }, ['VIEW_TASKS'])).toThrow(ForbiddenException);
    });

    it('a CLIENT whose role actually holds the permission still passes unmarked routes', () => {
      expect(check({ role: role('CLIENT', ['VIEW_FINANCIAL_REPORTS']) }, ['VIEW_FINANCIAL_REPORTS'])).toBe(true);
    });
  });

  it('allows routes without required permissions and public routes', () => {
    expect(guardFor(undefined).canActivate(ctx({ role: null }))).toBe(true);
    expect(guardFor(['MANAGE_SETTINGS'], true).canActivate(ctx(null))).toBe(true);
  });

  it('rejects a missing user', () => {
    expect(() => check(undefined, ['MANAGE_USERS'])).toThrow(ForbiddenException);
  });
});
