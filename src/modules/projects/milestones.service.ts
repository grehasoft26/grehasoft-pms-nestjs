import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma.service';
import { ProgressAggregationService } from './services/progress-aggregation.service';
import { ProjectActivityLogsService } from './services/project-activity-logs.service';

@Injectable()
export class MilestonesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly progressAggregation: ProgressAggregationService,
    private readonly activityLogs: ProjectActivityLogsService,
  ) {}

  private formatMilestone(m: any) {
    if (!m) return null;
    return {
      id: m.id,
      project: m.project_id,
      title: m.title,
      due_date: m.due_date ? m.due_date.toISOString().split('T')[0] : null,
      status: m.status,
      progress: m.progress,
      progress_percentage: m.progress,
      created_at: m.created_at ? m.created_at.toISOString() : null,
    };
  }

  async findAll(user: any, query: { project?: string }) {
    const roleName = user.role?.name;
    const where: any = {};

    if (query.project) {
      where.project_id = Number(query.project);
    }

    if (roleName === 'CLIENT') {
      const client = await this.prisma.client.findFirst({
        where: { portal_users: { some: { id: user.id } } },
      });
      if (client) {
        where.project = { client_id: client.id };
      } else {
        return query.project ? [] : { count: 0, next: null, previous: null, results: [] };
      }
    } else if (roleName === 'TEAM_MEMBER') {
      where.project = {
        members: {
          some: { user_id: user.id },
        },
      };
    }

    const milestones = await this.prisma.milestone.findMany({
      where,
      orderBy: { id: 'asc' },
    });

    const formatted = milestones.map((m) => this.formatMilestone(m));

    // When query param ?project= is supplied, return unpaginated list
    if (query.project) {
      return formatted;
    }

    return {
      count: formatted.length,
      next: null,
      previous: null,
      results: formatted,
    };
  }

  async findOne(id: number, user: any) {
    const milestone = await this.prisma.milestone.findUnique({
      where: { id },
    });
    if (!milestone) throw new NotFoundException('Milestone not found');
    return this.formatMilestone(milestone);
  }

  async create(user: any, body: any) {
    const roleName = user.role?.name;
    if (roleName === 'CLIENT') {
      throw new ForbiddenException('Clients do not have permission to modify milestones.');
    }

    const projectId = Number(body.project || body.project_id);
    const created = await this.prisma.milestone.create({
      data: {
        project_id: projectId,
        title: body.title,
        due_date: new Date(body.due_date),
        status: body.status || 'not_started',
        progress: body.progress || 0,
      },
    });

    await this.activityLogs.logActivity(
      projectId,
      user.id,
      `Created milestone: ${created.title}`,
    );

    await this.progressAggregation.recalculateProjectProgress(projectId);

    return this.formatMilestone(created);
  }

  async update(id: number, user: any, body: any) {
    const roleName = user.role?.name;
    if (roleName === 'CLIENT') {
      throw new ForbiddenException('Clients do not have permission to modify milestones.');
    }

    const existing = await this.prisma.milestone.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Milestone not found');

    const data: any = {};
    if (body.title !== undefined) data.title = body.title;
    if (body.due_date !== undefined) data.due_date = new Date(body.due_date);
    if (body.status !== undefined) data.status = body.status;
    if (body.progress !== undefined) data.progress = body.progress;

    const updated = await this.prisma.milestone.update({
      where: { id },
      data,
    });

    await this.activityLogs.logActivity(
      updated.project_id,
      user.id,
      `Updated milestone: ${updated.title}`,
    );

    await this.progressAggregation.recalculateProjectProgress(updated.project_id);

    return this.formatMilestone(updated);
  }

  async remove(id: number, user: any) {
    const roleName = user.role?.name;
    if (roleName === 'CLIENT') {
      throw new ForbiddenException('Clients do not have permission to modify milestones.');
    }

    const existing = await this.prisma.milestone.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Milestone not found');

    await this.prisma.milestone.delete({ where: { id } });

    await this.activityLogs.logActivity(
      existing.project_id,
      user.id,
      `Deleted milestone: ${existing.title}`,
    );

    await this.progressAggregation.recalculateProjectProgress(existing.project_id);

    return null;
  }
}
