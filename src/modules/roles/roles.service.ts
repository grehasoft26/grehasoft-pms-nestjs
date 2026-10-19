import { Injectable, BadRequestException, NotFoundException, ForbiddenException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma.service';
import { getActiveRolePermissions, isSuperAdmin, isSuperAdminRole } from '../../core/utils/role-access.util';
import {
  PERMISSION_CATEGORIES,
  PERMISSION_DEFINITIONS,
  isBuiltInRoleName,
  isKnownPermission,
} from '../../core/utils/permission-catalog';
import { PermissionCatalogResponseDto } from './dto/permission-catalog.dto';

/** Matches the roles.name column (VarChar(50)) and the frontend's NAME_FORMAT. */
const ROLE_NAME_PATTERN = /^[A-Z0-9_]+$/;
const ROLE_NAME_MAX_LENGTH = 50;

const isUniqueConstraintError = (error: any) => error?.code === 'P2002';

@Injectable()
export class RolesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(query: { page?: string; limit?: string; search?: string; all?: string } = {}) {
    const where: any = { deleted_at: null };

    const search = typeof query.search === 'string' ? query.search.trim() : '';
    if (search) {
      // roles.name/description use utf8mb4_unicode_ci, so MySQL LIKE is already
      // case-insensitive; Prisma's `mode: 'insensitive'` is not supported on MySQL.
      where.OR = [{ name: { contains: search } }, { description: { contains: search } }];
    }

    if (query.all === 'true') {
      const roles = await this.prisma.role.findMany({
        where,
        orderBy: { id: 'asc' },
      });
      return roles;
    }

    const pageNum = Math.max(1, Number(query.page) || 1);
    const limitNum = Math.max(1, Number(query.limit) || 5);
    const skip = (pageNum - 1) * limitNum;

    const count = await this.prisma.role.count({ where });

    const roles = await this.prisma.role.findMany({
      where,
      orderBy: { id: 'desc' },
      skip,
      take: limitNum,
    });

    return {
      count,
      next: pageNum * limitNum < count ? `/api/roles?page=${pageNum + 1}` : null,
      previous: pageNum > 1 ? `/api/roles?page=${pageNum - 1}` : null,
      results: roles,
    };
  }

  /**
   * Canonical permission catalog for the role UI. `assignable` reflects the delegation
   * rule: super admins may grant everything; other role managers only what they hold.
   */
  getPermissionCatalog(reqUser?: any): PermissionCatalogResponseDto {
    const superAdmin = isSuperAdmin(reqUser);
    const held = new Set(getActiveRolePermissions(reqUser));
    return {
      categories: [...PERMISSION_CATEGORIES],
      permissions: PERMISSION_DEFINITIONS.map((p) => ({
        id: p.id,
        label: p.label,
        category: p.category,
        description: p.description,
        assignable: superAdmin || held.has(p.id),
      })),
    };
  }

  async findOne(id: number) {
    const role = await this.prisma.role.findFirst({
      where: { id, deleted_at: null },
    });
    if (!role) throw new NotFoundException('Role not found');
    return role;
  }

  async create(body: { name?: unknown; description?: unknown; permissions?: unknown }, reqUser?: any) {
    const name = this.normalizeName(body?.name);
    const permissions = body?.permissions === undefined ? [] : this.normalizePermissions(body.permissions);
    const description = this.normalizeDescription(body?.description) ?? '';

    // Built-in role names drive authorization and behaviour; only super admins may (re)create them
    if (isBuiltInRoleName(name) && !isSuperAdmin(reqUser)) {
      throw new ForbiddenException(`The ${name} role name is reserved for the built-in role.`);
    }

    // roles.name is unique across active AND soft-deleted rows (case-insensitive collation)
    const existing = await this.prisma.role.findFirst({ where: { name } });

    if (existing && !existing.deleted_at) {
      throw new ConflictException(`A role named ${existing.name} already exists.`);
    }

    if (existing) {
      // Deleted role names are never reused; the deleted role is left untouched
      throw new ConflictException('This role name has already been used and cannot be reused, even if the role was deleted.');
    }

    this.assertCanGrant(reqUser, permissions);

    try {
      const created = await this.prisma.role.create({
        data: { name, description, permissions },
      });
      return { data: created, created: true };
    } catch (error) {
      if (isUniqueConstraintError(error)) throw new ConflictException(`A role named ${name} already exists.`);
      throw error;
    }
  }

  async update(id: number, body: { name?: unknown; description?: unknown; permissions?: unknown }, reqUser?: any) {
    const role = await this.findOne(id);

    if (isSuperAdminRole(role) && !isSuperAdmin(reqUser)) {
      throw new ForbiddenException('Only Super Admins can modify the SUPER_ADMIN role.');
    }
    this.assertNotOwnRole(reqUser, role, 'modify');

    const data: any = {};

    if (body?.name !== undefined && body?.name !== null && body?.name !== '') {
      const newName = this.normalizeName(body.name);
      if (newName !== role.name) {
        if (isBuiltInRoleName(role.name)) {
          throw new BadRequestException(`The built-in ${role.name} role cannot be renamed.`);
        }
        if (isBuiltInRoleName(newName)) {
          throw new BadRequestException(`The ${newName} role name is reserved for the built-in role.`);
        }
        const conflict = await this.prisma.role.findFirst({ where: { name: newName, NOT: { id } } });
        if (conflict) {
          throw new ConflictException(
            conflict.deleted_at
              ? `The name ${newName} is used by a deleted role.`
              : `A role named ${conflict.name} already exists.`,
          );
        }
        data.name = newName;
      }
    }

    const description = this.normalizeDescription(body?.description);
    if (description !== undefined) data.description = description;
    if (body?.permissions !== undefined) {
      data.permissions = this.normalizePermissions(body.permissions);
      this.assertCanGrant(reqUser, data.permissions, Array.isArray(role.permissions) ? (role.permissions as string[]) : []);
    }

    try {
      return await this.prisma.role.update({ where: { id }, data });
    } catch (error) {
      if (isUniqueConstraintError(error)) throw new ConflictException(`A role named ${data.name} already exists.`);
      throw error;
    }
  }

  async remove(id: number, reqUser?: any) {
    const role = await this.findOne(id);

    if (isSuperAdminRole(role)) {
      throw new ForbiddenException('The built-in SUPER_ADMIN role cannot be deleted.');
    }
    if (isBuiltInRoleName(role.name) && !isSuperAdmin(reqUser)) {
      throw new ForbiddenException(`Only Super Admins can delete the built-in ${role.name} role.`);
    }
    this.assertNotOwnRole(reqUser, role, 'delete');

    // Deleting a role in use would leave users on a deleted role; require reassignment first
    const assignedUsers = await this.prisma.user.count({ where: { role_id: id, deleted_at: null } });
    if (assignedUsers > 0) {
      throw new ConflictException(
        `Cannot delete role ${role.name}: ${assignedUsers} user(s) are still assigned to it. Reassign them first.`,
      );
    }

    await this.prisma.role.update({
      where: { id },
      data: { deleted_at: new Date() },
    });
    return null;
  }

  /**
   * Delegation rule: a non-super-admin role manager may only ADD permissions they hold
   * themselves (removing permissions is allowed). Prevents granting a role more access
   * than the manager has and then using it, e.g. via a user created with that role.
   */
  private assertCanGrant(reqUser: any, permissions: string[], previous: string[] = []) {
    if (isSuperAdmin(reqUser)) return;
    const held = new Set(getActiveRolePermissions(reqUser));
    const before = new Set(previous.map((p) => String(p).toUpperCase()));
    const notHeld = permissions.filter((p) => !before.has(p) && !held.has(p));
    if (notHeld.length > 0) {
      throw new ForbiddenException(`You cannot grant permissions you do not have: ${notHeld.join(', ')}.`);
    }
  }

  /** Non-super-admins cannot change or delete the role assigned to their own account. */
  private assertNotOwnRole(reqUser: any, role: { id: number }, action: 'modify' | 'delete') {
    if (isSuperAdmin(reqUser)) return;
    const ownRoleId = reqUser?.role_id ?? reqUser?.role?.id;
    if (ownRoleId !== undefined && ownRoleId !== null && ownRoleId === role.id) {
      throw new ForbiddenException(`You cannot ${action} the role assigned to your own account.`);
    }
  }

  /** "content editor" -> "CONTENT_EDITOR"; letters, digits and underscores, max 50 characters. */
  private normalizeName(raw: unknown): string {
    if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) {
      throw new BadRequestException('Role name is required.');
    }
    if (typeof raw !== 'string') {
      throw new BadRequestException('Role name must be text.');
    }
    const name = raw.trim().replace(/\s+/g, '_').toUpperCase();
    if (name.length > ROLE_NAME_MAX_LENGTH) {
      throw new BadRequestException(`Role name must be at most ${ROLE_NAME_MAX_LENGTH} characters.`);
    }
    if (!ROLE_NAME_PATTERN.test(name)) {
      throw new BadRequestException('Role name may contain only letters, numbers and underscores.');
    }
    return name;
  }

  /** Returns undefined when not provided; null/'' become ''. */
  private normalizeDescription(raw: unknown): string | undefined {
    if (raw === undefined) return undefined;
    if (raw === null) return '';
    if (typeof raw !== 'string') throw new BadRequestException('Description must be text.');
    return raw;
  }

  /** Array of known permission names; upper-cased and de-duplicated (first occurrence kept). */
  private normalizePermissions(raw: unknown): string[] {
    if (!Array.isArray(raw)) {
      throw new BadRequestException('Permissions must be an array of permission names.');
    }
    if (raw.some((p) => typeof p !== 'string' || !p.trim())) {
      throw new BadRequestException('Each permission must be a non-empty permission name.');
    }
    const normalized = raw.map((p: string) => p.trim().toUpperCase());
    const unknown = [...new Set(normalized.filter((p) => !isKnownPermission(p)))];
    if (unknown.length > 0) {
      throw new BadRequestException(`Unknown permission(s): ${unknown.join(', ')}.`);
    }
    return [...new Set(normalized)];
  }
}
