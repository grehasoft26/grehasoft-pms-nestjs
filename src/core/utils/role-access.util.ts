/**
 * Shared, deletion-aware role checks used by authorization code.
 *
 * Super-admin privileges come from:
 *   - the immutable `User.is_superuser` flag, or
 *   - an ACTIVE (not soft-deleted) role named SUPER_ADMIN.
 *
 * The SUPER_ADMIN role name is reserved and protected by RolesService (it cannot be
 * renamed, deleted, or taken by another role), so the name is a stable identifier.
 * A soft-deleted role grants no permissions and no super-admin bypass.
 */

import { KNOWN_PERMISSIONS, isKnownPermission } from './permission-catalog';

export const SUPER_ADMIN_ROLE_NAME = 'SUPER_ADMIN';

type RoleLike = { name?: string | null; permissions?: unknown; deleted_at?: Date | string | null } | null | undefined;
type UserLike = { is_superuser?: boolean | null; role?: RoleLike } | null | undefined;

/** True when the role exists and has not been soft-deleted. */
export function isActiveRole(role: RoleLike): boolean {
  return !!role && !role.deleted_at;
}

/** True when the role is the (active) built-in SUPER_ADMIN role. */
export function isSuperAdminRole(role: RoleLike): boolean {
  return isActiveRole(role) && String(role?.name || '').toUpperCase() === SUPER_ADMIN_ROLE_NAME;
}

/** True for `is_superuser` accounts and users holding the active SUPER_ADMIN role. */
export function isSuperAdmin(user: UserLike): boolean {
  if (!user) return false;
  return user.is_superuser === true || isSuperAdminRole(user.role);
}

export const DEACTIVATED_ROLE_MESSAGE = 'Your assigned role has been deactivated. Please contact an administrator.';

/**
 * Authentication-time handling of soft-deleted roles (fail closed).
 * Many services compare role NAMES (e.g. CLIENT scoping, ADMIN/PROJECT_MANAGER rights), so a
 * user still assigned to a deleted role is refused rather than given that role or no role.
 * is_superuser accounts keep access with the deleted role removed.
 * Returns the user to attach to the request, or null when the user must be refused.
 */
export function applyRoleStatus<T extends { is_superuser?: boolean | null; role?: RoleLike }>(user: T): T | null {
  if (!user.role || isActiveRole(user.role)) return user;
  return user.is_superuser === true ? { ...user, role: null } : null;
}

/** Upper-cased permission names granted by the user's role; empty for missing or deleted roles. */
export function getActiveRolePermissions(user: UserLike): string[] {
  const role = user?.role;
  if (!isActiveRole(role) || !Array.isArray(role?.permissions)) return [];
  return (role!.permissions as unknown[])
    .filter((p): p is string => typeof p === 'string')
    .map((p) => p.toUpperCase());
}

/**
 * The signed-in user's effective access, computed the same way PermissionsGuard decides:
 * super admins (is_superuser or the active SUPER_ADMIN role) pass every permission check, so
 * they get every catalog permission; everyone else gets their active role's permissions that
 * exist in the catalog (deleted roles, unknown and malformed entries grant nothing).
 * Returned only for the user's own account (GET /users/me, /users/profile).
 */
export function getEffectiveAccess(user: UserLike): { is_super_admin: boolean; effective_permissions: string[] } {
  const superAdmin = isSuperAdmin(user);
  const granted = superAdmin ? [...KNOWN_PERMISSIONS] : getActiveRolePermissions(user).filter(isKnownPermission);
  return { is_super_admin: superAdmin, effective_permissions: [...new Set(granted)] };
}
