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

  async findAll(query: { all?: string }) {
    const depts = await this.prisma.department.findMany({
      where: { deleted_at: null },
      include: { parent: true },
      orderBy: { id: 'asc' },
    });

    const formatted = depts.map((d) => this.formatDepartment(d));

    if (query.all === 'true') {
      return formatted;
    }

    return {
      count: formatted.length,
      next: null,
      previous: null,
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
