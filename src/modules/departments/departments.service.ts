import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma.service';

@Injectable()
export class DepartmentsService {
  constructor(private readonly prisma: PrismaService) {}

  private formatDepartment(dept: any) {
    if (!dept) return null;
    return {
      id: dept.id,
      name: dept.name,
      parent: dept.parent_id,
      parent_name: dept.parent ? dept.parent.name : null,
      created_at: dept.created_at ? dept.created_at.toISOString() : null,
      updated_at: dept.updated_at ? dept.updated_at.toISOString() : null,
    };
  }

  async findAll(query: { page?: string; limit?: string; search?: string; all?: string } = {}) {
    const where: any = { deleted_at: null };

    if (query.search) {
      where.name = { contains: query.search, mode: 'insensitive' };
    }

    if (query.all === 'true') {
      const depts = await this.prisma.department.findMany({
        where,
        include: { parent: true },
        orderBy: { id: 'asc' },
      });
      return depts.map((d) => this.formatDepartment(d));
    }

    const pageNum = Math.max(1, Number(query.page) || 1);
    const limitNum = Math.max(1, Number(query.limit) || 5);
    const skip = (pageNum - 1) * limitNum;

    const count = await this.prisma.department.count({ where });

    const depts = await this.prisma.department.findMany({
      where,
      include: { parent: true },
      orderBy: { id: 'desc' },
      skip,
      take: limitNum,
    });

    const formatted = depts.map((d) => this.formatDepartment(d));

    return {
      count,
      next: pageNum * limitNum < count ? `/api/departments?page=${pageNum + 1}` : null,
      previous: pageNum > 1 ? `/api/departments?page=${pageNum - 1}` : null,
      results: formatted,
    };
  }

  async findOne(id: number) {
    const dept = await this.prisma.department.findFirst({
      where: { id, deleted_at: null },
      include: { parent: true },
    });
    if (!dept) throw new NotFoundException('Department not found');
    return this.formatDepartment(dept);
  }

  async create(body: { name: string; parent?: number }) {
    const created = await this.prisma.department.create({
      data: {
        name: body.name,
        parent_id: body.parent || null,
      },
      include: { parent: true },
    });
    return this.formatDepartment(created);
  }

  async update(id: number, body: { name?: string; parent?: number }) {
    await this.findOne(id);
    const data: any = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.parent !== undefined) data.parent_id = body.parent;

    const updated = await this.prisma.department.update({
      where: { id },
      data,
      include: { parent: true },
    });
    return this.formatDepartment(updated);
  }

  async remove(id: number) {
    await this.findOne(id);
    await this.prisma.department.update({
      where: { id },
      data: { deleted_at: new Date() },
    });
    return null;
  }
}
