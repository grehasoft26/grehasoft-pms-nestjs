import { isSuperAdmin } from './role-access.util';
import { resolveClientForUser } from './client-scope.util';

/**
 * Record-level project scope shared by the project and task modules.
 *
 * - Super admins (active SUPER_ADMIN role or is_superuser): every project.
 * - CLIENT users: projects of their own client (users.client_id, see resolveClientForUser).
 * - Everyone else: projects they are a member of, manage (project_manager_id) or created.
 *   This is the definition the task-files list and the team-member dashboard already used.
 *
 * Holding MANAGE_PROJECTS / MANAGE_TASKS or an ADMIN / PROJECT_MANAGER role does not widen
 * the scope; those only decide what a user may do inside projects they can access.
 */

/** Matches no rows (Prisma treats `in: []` as always false). */
export const NO_PROJECTS = { id: { in: [] as number[] } };

/** Roles that existing task/comment/review rules treat as project managers (unchanged). */
export const PROJECT_MANAGER_ROLE_NAMES = ['SUPER_ADMIN', 'ADMIN', 'PROJECT_MANAGER'];

export function isProjectManagerRole(user: any): boolean {
  return !!user?.is_superuser || PROJECT_MANAGER_ROLE_NAMES.includes(user?.role?.name);
}

export function isClientUser(user: any): boolean {
  return user?.role?.name === 'CLIENT' || user?.role_name === 'CLIENT';
}

/** Project `where` fragment for staff (non-client) users; null means unrestricted. */
export function staffProjectScope(user: any): Record<string, any> | null {
  if (isSuperAdmin(user)) return null;
  if (!user?.id) return NO_PROJECTS;
  return {
    OR: [
      { members: { some: { user_id: user.id } } },
      { project_manager_id: user.id },
      { created_by_id: user.id },
    ],
  };
}

/** Project `where` fragment for any user; null means unrestricted. */
export async function projectScopeFor(prisma: any, user: any): Promise<Record<string, any> | null> {
  if (isClientUser(user)) {
    const client = await resolveClientForUser(prisma, user);
    return client ? { client_id: client.id } : NO_PROJECTS;
  }
  return staffProjectScope(user);
}

/** True when the (non-deleted) project exists and is inside the user's scope. */
export async function canAccessProject(prisma: any, user: any, projectId: unknown): Promise<boolean> {
  const id = Number(projectId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const scope = await projectScopeFor(prisma, user);
  const count = await prisma.project.count({ where: { id, deleted_at: null, ...(scope ? { AND: [scope] } : {}) } });
  return count > 0;
}
