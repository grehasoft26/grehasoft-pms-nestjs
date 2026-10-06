import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma.service';
import { PasswordUtil } from '../../core/utils/password.util';
import { formatUserResponse } from './user.serializer';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async getMe(user: any) {
    const freshUser = await this.prisma.user.findFirst({
      where: { id: user.id, deleted_at: null },
      include: { role: true, department: true, client: true },
    });
    if (!freshUser) throw new NotFoundException('User not found');
    return formatUserResponse(freshUser);
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

      const formatted = users.map((u) => formatUserResponse(u));
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

    const formatted = users.map((u) => formatUserResponse(u));

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
    return formatUserResponse(user);
  }

  async create(reqUser: any, body: any) {
    const reqIsSuper = reqUser.is_superuser || reqUser.role?.name === 'SUPER_ADMIN';

    let roleObj = null;
    if (body.role) {
      roleObj = await this.prisma.role.findFirst({
        where: { OR: [{ id: Number(body.role) || -1 }, { name: String(body.role) }] },
      });
    }

    if (roleObj && roleObj.name === 'SUPER_ADMIN' && !reqIsSuper) {
      throw new BadRequestException({ role: 'Only Super Admins can assign the SUPER_ADMIN role.' });
    }

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

    return formatUserResponse(created);
  }

  async update(reqUser: any, id: number, body: any) {
    const existing = await this.prisma.user.findFirst({
      where: { id, deleted_at: null },
      include: { role: true },
    });
    if (!existing) throw new NotFoundException('User not found');

    const reqIsSuper = reqUser.is_superuser || reqUser.role?.name === 'SUPER_ADMIN';
    const tgtIsSuper = existing.is_superuser || existing.role?.name === 'SUPER_ADMIN';

    if (tgtIsSuper && reqUser.id !== existing.id && !reqIsSuper) {
      throw new ForbiddenException({ role: 'Only Super Admins can modify other Super Admin accounts.' });
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
    if (body.role !== undefined) data.role_id = Number(body.role) || null;
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

    return formatUserResponse(updated);
  }

  async remove(id: number) {
    const existing = await this.prisma.user.findFirst({
      where: { id, deleted_at: null },
    });
    if (!existing) throw new NotFoundException('User not found');

    await this.prisma.user.update({
      where: { id },
      data: { deleted_at: new Date() },
    });
    return null;
  }
}
