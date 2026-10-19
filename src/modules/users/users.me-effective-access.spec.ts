import { UsersService } from './users.service';
import { KNOWN_PERMISSIONS } from '../../core/utils/permission-catalog';
import { getEffectiveAccess } from '../../core/utils/role-access.util';
import { PermissionsGuard } from '../../core/guards/permissions.guard';
import { Reflector } from '@nestjs/core';

/**
 * Phase 2.5: GET /users/me returns the signed-in user's effective access (what PermissionsGuard
 * allows), so the frontend no longer needs role-name defaults. role_permissions is unchanged.
 */
const role = (name: string, permissions: unknown, deleted_at: Date | null = null) => ({ id: 1, name, permissions, deleted_at });
const account = (extra: any) => ({
  id: 7, name: 'U', username: 'u', email: 'u@x.test', is_superuser: false, deleted_at: null,
  created_at: new Date('2026-01-01'), department: null, client: null, ...extra,
});

const me = async (user: any) => {
  const prisma = { user: { findFirst: jest.fn(async () => user) } };
  return (await new UsersService(prisma as any).getMe({ id: user.id })) as any;
};

describe('GET /users/me effective access (Phase 2.5)', () => {
  it('returns the active role\'s catalog permissions, normalised, de-duplicated and validated', async () => {
    const body = await me(account({ role: role('TEAM_MEMBER', ['view_tasks', 'VIEW_TASKS', 'BOGUS_PERMISSION', 5, null, 'MANAGE_TASKS']) }));
    expect(body.is_super_admin).toBe(false);
    expect(body.effective_permissions).toEqual(['VIEW_TASKS', 'MANAGE_TASKS']);
    // Existing contract preserved
    expect(body.role_permissions).toEqual(['view_tasks', 'VIEW_TASKS', 'BOGUS_PERMISSION', 5, null, 'MANAGE_TASKS']);
    expect(body.role_name).toBe('TEAM_MEMBER');
  });

  it('the active SUPER_ADMIN role is a super admin even without is_superuser, with every catalog permission', async () => {
    const body = await me(account({ role: role('SUPER_ADMIN', ['MANAGE_PROJECTS']) }));
    expect(body.is_super_admin).toBe(true);
    expect(body.effective_permissions).toEqual([...KNOWN_PERMISSIONS]);
  });

  it('is_superuser accounts are super admins regardless of role', async () => {
    expect(await me(account({ is_superuser: true, role: null }))).toMatchObject({ is_super_admin: true });
  });

  it('a deleted role, a missing role or malformed permissions grant nothing', async () => {
    for (const r of [role('ADMIN', ['MANAGE_USERS'], new Date('2026-09-01')), null, role('ADMIN', 'MANAGE_USERS'), role('SUPER_ADMIN', [], new Date('2026-09-01'))]) {
      const body = await me(account({ role: r }));
      expect(body.is_super_admin).toBe(false);
      expect(body.effective_permissions).toEqual([]);
    }
  });

  it('matches PermissionsGuard for every catalog permission', () => {
    const users = [
      account({ role: role('ADMIN', ['MANAGE_USERS', 'manage_roles', 'NOT_REAL']) }),
      account({ role: role('SUPER_ADMIN', []) }),
      account({ role: role('ADMIN', ['MANAGE_USERS'], new Date('2026-09-01')) }),
      account({ is_superuser: true, role: null }),
    ];
    for (const user of users) {
      const { effective_permissions } = getEffectiveAccess(user);
      for (const permission of KNOWN_PERMISSIONS) {
        const guard = new PermissionsGuard({ getAllAndOverride: (key: string) => (key === 'permissions' ? [permission] : undefined) } as unknown as Reflector);
        const ctx = { getHandler: () => undefined, getClass: () => undefined, switchToHttp: () => ({ getRequest: () => ({ user }) }) } as any;
        let allowed: boolean;
        try {
          allowed = guard.canActivate(ctx);
        } catch {
          allowed = false;
        }
        expect({ permission, allowed }).toEqual({ permission, allowed: effective_permissions.includes(permission) });
      }
    }
  });
});
