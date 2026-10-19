import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma.service';
import { PasswordUtil } from '../../core/utils/password.util';
import { formatUserResponse } from './user.serializer';
import { getActiveRolePermissions, getEffectiveAccess, isSuperAdmin } from '../../core/utils/role-access.util';
import { isPrivilegedRoleName } from '../../core/utils/permission-catalog';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async getMe(user: any) {
    const freshUser = await this.prisma.user.findFirst({
      where: { id: user.id, deleted_at: null },
      include: { role: true, department: true, client: true },
    });
    if (!freshUser) throw new NotFoundException('User not found');
    // role_permissions stays as stored; effective access is what the backend guards actually allow
    return { ...formatUserResponse(freshUser), ...getEffectiveAccess(freshUser) };
  }

  async updateProfile(user: any, body: any, file?: any) {
    const roleName = user.role?.name;
    if (roleName === 'CLIENT') {
      const allowedFields = ['profile_photo'];
      for (const key of Object.keys(body)) {
        if (!allowedFields.includes(key)) {
          throw new ForbiddenException(`Clients cannot modify the field '${key}'.`);
        }
      }
    }

    const data: any = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.username !== undefined) data.username = body.username;
    if (body.email !== undefined) data.email = body.email;
    if (body.address !== undefined) data.address = body.address;
    if (file) {
      data.profile_photo = file.filename || file.path;
    } else if (body.profile_photo !== undefined) {
      data.profile_photo = body.profile_photo;
    }

    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data,
      include: { role: true, department: true, client: true },
    });

    return formatUserResponse(updated);
  }

  async changePassword(user: any, body: { currentPassword?: string; newPassword?: string }) {
    const { currentPassword, newPassword } = body;
    if (!currentPassword || !newPassword) {
      throw new BadRequestException({ error: 'currentPassword and newPassword are required' });
    }

    const dbUser = await this.prisma.user.findUnique({ where: { id: user.id } });
    if (!dbUser) throw new NotFoundException('User not found');

    const isValid = await PasswordUtil.verifyPassword(currentPassword, dbUser.password);
    if (!isValid) {
      throw new BadRequestException({ error: 'Current password is incorrect' });
    }

    const hashedPassword = await PasswordUtil.hashPassword(newPassword);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { password: hashedPassword },
    });

    return { message: 'Password updated successfully' };
  }

  async findProjectManagers() {
    const eligibleRoles = ['PROJECT_MANAGER', 'SUPER_ADMIN'];
    const pms = await this.prisma.user.findMany({
      where: {
        deleted_at: null,
        is_active: true,
        role: {
          name: { in: eligibleRoles },
        },
      },
      include: { role: true },
      orderBy: { name: 'asc' },
    });

    return pms.map((user) => ({
      id: user.id,
      name: user.name,
      username: user.username,
      email: user.email,
      role: user.role_id,
      is_active: user.is_active,
      last_login: user.last_login ? user.last_login.toISOString() : null,
    }));
  }

  async findAll(query: { department?: string; role?: string; role_name?: string; is_active?: string; search?: string; page?: string; limit?: string; all?: string }) {
    const where: any = { deleted_at: null };

    if (query.department) {
      where.department_id = Number(query.department);
    }

    if (query.role) {
      if (!isNaN(Number(query.role))) {
        where.role_id = Number(query.role);
      } else if (query.role === 'PROJECT_MANAGER') {
        where.role = { name: { in: ['PROJECT_MANAGER', 'SUPER_ADMIN'] } };
      } else {
        where.role = { name: query.role };
      }
    }

    if (query.role_name) {
      const names = query.role_name.split(',').map((r) => r.trim());
      where.role = { name: { in: names } };
    }

    if (query.is_active !== undefined) {
      where.is_active = query.is_active.toLowerCase() === 'true';
    }

    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { username: { contains: query.search, mode: 'insensitive' } },
        { email: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    if (query.all === 'true') {
      const users = await this.prisma.user.findMany({
        where,
        include: { role: true, department: true, client: true },
        orderBy: { name: 'asc' },
      });

      const userIds = users.map(u => u.id);
      const employees = await this.prisma.employee.findMany({
        where: { user_id: { in: userIds } },
      });
      const empMap = new Map(employees.map(e => [e.user_id, e]));

      const formatted = users.map((u) => formatUserResponse({ ...u, employee: empMap.get(u.id) }));
      return formatted;
    }

    const pageNum = Math.max(1, Number(query.page) || 1);
    const limitNum = Math.max(1, Number(query.limit) || 5);
    const skip = (pageNum - 1) * limitNum;

    const count = await this.prisma.user.count({ where });

    const users = await this.prisma.user.findMany({
      where,
      include: { role: true, department: true, client: true },
      orderBy: { id: 'desc' },
      skip,
      take: limitNum,
    });

    const userIds = users.map(u => u.id);
    const employees = await this.prisma.employee.findMany({
      where: { user_id: { in: userIds } },
    });
    const empMap = new Map(employees.map(e => [e.user_id, e]));

    const formatted = users.map((u) => formatUserResponse({ ...u, employee: empMap.get(u.id) }));

    return {
      count,
      next: pageNum * limitNum < count ? `/api/users?page=${pageNum + 1}` : null,
      previous: pageNum > 1 ? `/api/users?page=${pageNum - 1}` : null,
      results: formatted,
    };
  }

  async findOne(id: number) {
    const user = await this.prisma.user.findFirst({
      where: { id, deleted_at: null },
      include: { role: true, department: true, client: true },
    });
    if (!user) throw new NotFoundException('User not found');
    const emp = await this.prisma.employee.findUnique({ where: { user_id: id } });
    return formatUserResponse({ ...user, employee: emp });
  }

  async create(reqUser: any, body: any) {
    const reqIsSuper = isSuperAdmin(reqUser);

    let roleObj = null;
    if (body.role) {
      roleObj = await this.prisma.role.findFirst({
        where: {
          deleted_at: null,
          OR: [{ id: Number(body.role) || -1 }, { name: String(body.role) }],
        },
      });
      if (!roleObj) {
        throw new BadRequestException({ role: 'Role not found or has been deleted.' });
      }
    }

    this.assertCanAssignRole(reqUser, reqIsSuper, roleObj);

    const hashedPassword = await PasswordUtil.hashPassword(body.password || 'password123');

    const created = await this.prisma.user.create({
      data: {
        username: body.username,
        email: body.email,
        password: hashedPassword,
        name: body.name || body.username,
        address: body.address || null,
        role_id: roleObj ? roleObj.id : null,
        department_id: body.department ? Number(body.department) : null,
        position: body.position || null,
        joining_date: body.joining_date ? new Date(body.joining_date) : null,
        salary_monthly: body.salary_monthly ? Number(body.salary_monthly) : null,
        status: body.status || 'active',
        client_id: body.client ? Number(body.client) : null,
        profile_photo: body.profile_photo || null,
      },
      include: { role: true, department: true, client: true },
    });

    const phoneVal = body.phone !== undefined ? body.phone : body.mobile;
    if (phoneVal !== undefined || body.position || body.joining_date || body.salary_monthly || body.address) {
      const empPhone = phoneVal ? String(phoneVal).trim() : null;
      await this.prisma.employee.upsert({
        where: { user_id: created.id },
        create: {
          user_id: created.id,
          phone: empPhone,
          position: body.position || 'Employee',
          joining_date: body.joining_date ? new Date(body.joining_date) : new Date(),
          salary_monthly: body.salary_monthly ? Number(body.salary_monthly) : 0,
          address: body.address || '',
          department_id: body.department ? Number(body.department) : null,
        },
        update: {
          phone: empPhone !== null ? empPhone : undefined,
          position: body.position || undefined,
          joining_date: body.joining_date ? new Date(body.joining_date) : undefined,
          salary_monthly: body.salary_monthly ? Number(body.salary_monthly) : undefined,
          address: body.address || undefined,
          department_id: body.department ? Number(body.department) : undefined,
        },
      });
      return this.findOne(created.id);
    }

    return formatUserResponse(created);
  }

  async update(reqUser: any, id: number, body: any) {
    const existing = await this.prisma.user.findFirst({
      where: { id, deleted_at: null },
      include: { role: true },
    });
    if (!existing) throw new NotFoundException('User not found');

    const reqIsSuper = isSuperAdmin(reqUser);
    const tgtIsSuper = isSuperAdmin(existing);

    if (tgtIsSuper && reqUser.id !== existing.id && !reqIsSuper) {
      throw new ForbiddenException({ role: 'Only Super Admins can modify other Super Admin accounts.' });
    }

    // Protected accounts (ADMIN role, or a role granting permissions the requester lacks):
    // non-super managers may not change login or access fields (password reset or email change
    // would let them take the account over and inherit its permissions)
    const protection = reqUser.id !== existing.id ? this.accountProtection(reqUser, reqIsSuper, existing) : null;
    if (protection) {
      const changing = (key: string, current: any) =>
        body[key] !== undefined && String(body[key] ?? '') !== String(current ?? '');
      const sensitive = [
        body.password ? 'password' : null,
        changing('email', existing.email) ? 'email' : null,
        changing('username', existing.username) ? 'username' : null,
        body.is_active !== undefined && Boolean(body.is_active) !== Boolean(existing.is_active) ? 'is_active' : null,
        changing('status', existing.status) ? 'status' : null,
        changing('department', existing.department_id) ? 'department' : null,
        changing('client', existing.client_id) ? 'client' : null,
      ].filter(Boolean);
      if (sensitive.length > 0) {
        throw new ForbiddenException(`Only Super Admins can change ${sensitive.join(', ')} of ${protection}.`);
      }
    }

    const data: any = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.username !== undefined) data.username = body.username;
    if (body.email !== undefined) data.email = body.email;
    if (body.address !== undefined) data.address = body.address;
    if (body.position !== undefined) data.position = body.position;
    if (body.joining_date !== undefined) data.joining_date = body.joining_date ? new Date(body.joining_date) : null;
    if (body.salary_monthly !== undefined) data.salary_monthly = body.salary_monthly !== null && body.salary_monthly !== '' ? Number(body.salary_monthly) : null;
    if (body.status !== undefined) data.status = body.status;
    if (body.is_active !== undefined) data.is_active = body.is_active;
    if (body.role !== undefined) {
      const roleId = await this.resolveRoleChange(reqUser, reqIsSuper, existing, body.role);
      if (roleId !== undefined) data.role_id = roleId;
    }
    if (body.department !== undefined) data.department_id = body.department ? Number(body.department) : null;
    if (body.client !== undefined) data.client_id = body.client ? Number(body.client) : null;
    if (body.profile_photo !== undefined) data.profile_photo = body.profile_photo;

    if (body.password) {
      data.password = await PasswordUtil.hashPassword(body.password);
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data,
      include: { role: true, department: true, client: true },
    });

    const phoneVal = body.phone !== undefined ? body.phone : body.mobile;
    if (phoneVal !== undefined || body.position !== undefined || body.joining_date !== undefined || body.salary_monthly !== undefined || body.address !== undefined) {
      const empPhone = phoneVal ? String(phoneVal).trim() : null;
      const existingEmp = await this.prisma.employee.findUnique({ where: { user_id: id } });
      if (existingEmp) {
        await this.prisma.employee.update({
          where: { user_id: id },
          data: {
            phone: phoneVal !== undefined ? empPhone : undefined,
            position: body.position || undefined,
            joining_date: body.joining_date ? new Date(body.joining_date) : undefined,
            salary_monthly: body.salary_monthly !== undefined && body.salary_monthly !== '' ? Number(body.salary_monthly) : undefined,
            address: body.address !== undefined ? body.address : undefined,
          },
        });
      } else if (phoneVal) {
        await this.prisma.employee.create({
          data: {
            user_id: id,
            phone: empPhone,
            position: body.position || 'Employee',
            joining_date: body.joining_date ? new Date(body.joining_date) : new Date(),
            salary_monthly: body.salary_monthly ? Number(body.salary_monthly) : 0,
            address: body.address || '',
            department_id: body.department ? Number(body.department) : null,
          },
        });
      }
      return this.findOne(id);
    }

    return formatUserResponse(updated);
  }

  /**
   * Validates a requested role change (PATCH /users/:id).
   * Returns the new role id (or null to clear it), or undefined when the role is unchanged.
   * - The role must exist and not be soft-deleted.
   * - Only super admins can assign the SUPER_ADMIN role.
   * - Nobody can change their own role through this endpoint.
   */
  private async resolveRoleChange(reqUser: any, reqIsSuper: boolean, target: any, rawRole: any): Promise<number | null | undefined> {
    const clearing = rawRole === null || rawRole === '' || rawRole === 0 || rawRole === '0';
    const requestedId = clearing ? null : Number(rawRole);

    // Unchanged role (e.g. an edit form re-sending the current value) is not a role change
    if (requestedId === (target.role_id ?? null)) return undefined;

    if (target.id === reqUser.id) {
      throw new ForbiddenException({ role: 'You cannot change your own role.' });
    }

    // Only super admins may change (or clear) the role of a privileged account
    // ...or of an account whose role grants permissions the requester does not hold (checked
    // after the requested role itself, so its more specific error is reported first)
    const assertTargetNotProtected = () => {
      const protection = this.accountProtection(reqUser, reqIsSuper, target);
      if (protection) {
        throw new ForbiddenException({ role: `Only Super Admins can change the role of ${protection}.` });
      }
    };

    if (requestedId === null) {
      assertTargetNotProtected();
      return null;
    }

    if (!Number.isInteger(requestedId) || requestedId <= 0) {
      throw new BadRequestException({ role: 'Invalid role.' });
    }

    const role = await this.prisma.role.findFirst({ where: { id: requestedId, deleted_at: null } });
    if (!role) {
      throw new BadRequestException({ role: 'Role not found or has been deleted.' });
    }

    this.assertCanAssignRole(reqUser, reqIsSuper, role);
    assertTargetNotProtected();

    return role.id;
  }

  /**
   * Role-assignment policy (create and update), using the role record from the database:
   * - Super admins may assign any active role, including SUPER_ADMIN and ADMIN.
   * - Others may not assign privileged roles (SUPER_ADMIN, ADMIN).
   * - Others may only assign a role whose permissions they all hold themselves
   *   (prevents escalation via roles a super admin granted extra permissions).
   */
  private assertCanAssignRole(reqUser: any, reqIsSuper: boolean, role: { name: string; permissions?: unknown } | null) {
    if (!role || reqIsSuper) return;

    if (isPrivilegedRoleName(role.name)) {
      throw new ForbiddenException({ role: `Only Super Admins can assign the ${role.name} role.` });
    }

    const notHeld = this.permissionsNotHeld(reqUser, role);
    if (notHeld.length > 0) {
      throw new ForbiddenException({
        role: `You cannot assign the ${role.name} role because it grants permissions you do not have: ${notHeld.join(', ')}.`,
      });
    }
  }

  /** Permissions the role grants that the requester's own active role does not. */
  private permissionsNotHeld(reqUser: any, role: { permissions?: unknown } | null | undefined): string[] {
    const held = new Set(getActiveRolePermissions(reqUser));
    const rolePermissions = Array.isArray(role?.permissions)
      ? (role!.permissions as unknown[]).filter((p): p is string => typeof p === 'string').map((p) => p.toUpperCase())
      : [];
    return [...new Set(rolePermissions.filter((p) => !held.has(p)))];
  }

  /**
   * Why a non-super-admin may not take over (password, email, login and access fields), re-role
   * or delete `target`; null when they may. Least privilege, like assertCanAssignRole: besides
   * super admins and the privileged role names, any account whose role grants a permission the
   * requester does not hold is protected, whatever the role is called. The target role's
   * permissions are read even if it is soft-deleted, so a restored role cannot be exploited.
   * Callers skip this for the requester's own account.
   */
  private accountProtection(reqUser: any, reqIsSuper: boolean, target: any): string | null {
    if (reqIsSuper) return null;
    if (isSuperAdmin(target)) return 'a Super Admin account';
    if (isPrivilegedRoleName(target.role?.name)) return `an account that has the ${target.role.name} role`;
    const notHeld = this.permissionsNotHeld(reqUser, target.role);
    if (notHeld.length > 0) {
      return `an account whose role grants permissions you do not have (${notHeld.join(', ')})`;
    }
    return null;
  }

  async remove(reqUser: any, id: number) {
    const existing = await this.prisma.user.findFirst({
      where: { id, deleted_at: null },
      include: { role: true },
    });
    if (!existing) throw new NotFoundException('User not found');

    if (reqUser && existing.id === reqUser.id) {
      throw new ForbiddenException('You cannot delete your own account.');
    }
    if (isSuperAdmin(existing) && !isSuperAdmin(reqUser)) {
      throw new ForbiddenException('Only Super Admins can delete Super Admin accounts.');
    }
    if (isPrivilegedRoleName(existing.role?.name) && !isSuperAdmin(reqUser)) {
      throw new ForbiddenException(`Only Super Admins can delete accounts that have the ${existing.role.name} role.`);
    }
    const protection = this.accountProtection(reqUser, isSuperAdmin(reqUser), existing);
    if (protection) {
      throw new ForbiddenException(`Only Super Admins can delete ${protection}.`);
    }

    await this.prisma.user.update({
      where: { id },
      data: { deleted_at: new Date() },
    });
    return null;
  }
}
