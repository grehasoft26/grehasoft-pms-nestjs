import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma.service';

@Injectable()
export class TaskTypesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(query: { all?: string }) {
    const types = await this.prisma.taskType.findMany({
      where: { deleted_at: null },
      orderBy: { id: 'asc' },
    });

    if (query.all === 'true') {
      return types;
    }

    return {
      count: types.length,
      next: null,
      previous: null,
      results: types,
    };
  }

  async findOne(id: number) {
    const taskType = await this.prisma.taskType.findFirst({
      where: { id, deleted_at: null },
    });
    if (!taskType) throw new NotFoundException('Task type not found');
    return taskType;
  }

  async create(body: { name?: string; description?: string }) {
    const name = (body.name || '').trim().toUpperCase();
    const description = body.description || '';

    if (!name) {
      throw new BadRequestException({ error: 'Name is required.' });
    }

    const existing = await this.prisma.taskType.findFirst({
      where: { name },
    });

    if (existing) {
      if (existing.deleted_at) {
        const restored = await this.prisma.taskType.update({
          where: { id: existing.id },
          data: { deleted_at: null, description },
        });
        return { data: restored, restored: true };
      }
      throw new BadRequestException({ error: 'Task type already exists.' });
    }

    const created = await this.prisma.taskType.create({
      data: { name, description },
    });

    return { data: created, created: true };
  }

  async update(id: number, body: { name?: string; description?: string }) {
    await this.findOne(id);
    const data: any = {};
    if (body.name) {
      const name = body.name.trim().toUpperCase();
      const existing = await this.prisma.taskType.findFirst({
        where: { name, id: { not: id }, deleted_at: null },
      });
      if (existing) {
        throw new BadRequestException({ name: ['Task type with this name already exists.'] });
      }
      data.name = name;
    }
    if (body.description !== undefined) data.description = body.description;

    return this.prisma.taskType.update({
      where: { id },
      data,
    });
  }

  async remove(id: number) {
    await this.findOne(id);
    await this.prisma.taskType.update({
      where: { id },
      data: { deleted_at: new Date() },
    });
    return null;
  }
}
