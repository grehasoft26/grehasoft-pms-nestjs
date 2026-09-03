import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma.service';

@Injectable()
export class RolesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(query: { all?: string }) {
    const roles = await this.prisma.role.findMany({
      where: { deleted_at: null },
      orderBy: { id: 'asc' },
    });

    if (query.all === 'true') {
      return roles;
    }

    return {
      count: roles.length,
      next: null,
      previous: null,
      results: roles,
    };
  }

  async findOne(id: number) {
    const role = await this.prisma.role.findFirst({
      where: { id, deleted_at: null },
    });
    if (!role) throw new NotFoundException('Role not found');
    return role;
  }

  async create(body: { name?: string; description?: string; permissions?: string[] }) {
    const { name, description = '', permissions = [] } = body;
    if (!name || !name.trim()) {
      throw new BadRequestException({ error: 'Name is required' });
    }

    const upperName = name.trim().toUpperCase();

    // Check if role exists (including soft-deleted)
    const existing = await this.prisma.role.findFirst({
      where: { name: upperName },
    });

    if (existing) {
      if (existing.deleted_at) {
        // Restore soft-deleted role
        const restored = await this.prisma.role.update({
          where: { id: existing.id },
          data: {
            deleted_at: null,
            description,
            permissions: permissions as any,
          },
        });
        return { data: restored, created: false };
      }
      return { data: existing, created: false };
    }

    const created = await this.prisma.role.create({
      data: {
        name: upperName,
        description,
        permissions: permissions as any,
      },
    });

    return { data: created, created: true };
  }

  async update(id: number, body: { name?: string; description?: string; permissions?: string[] }) {
    await this.findOne(id);
    const data: any = {};
    if (body.name) data.name = body.name.trim().toUpperCase();
    if (body.description !== undefined) data.description = body.description;
    if (body.permissions !== undefined) data.permissions = body.permissions as any;

    return this.prisma.role.update({
      where: { id },
      data,
    });
  }

  async remove(id: number) {
    await this.findOne(id);
    await this.prisma.role.update({
      where: { id },
      data: { deleted_at: new Date() },
    });
    return null;
  }
}
