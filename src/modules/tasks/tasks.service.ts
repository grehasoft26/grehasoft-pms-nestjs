import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma.service';
import { ProgressAggregationService } from '../projects/services/progress-aggregation.service';
import { ProjectActivityLogsService } from '../projects/services/project-activity-logs.service';
import { formatUserResponse } from '../users/user.serializer';

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly progressAggregation: ProgressAggregationService,
    private readonly activityLogs: ProjectActivityLogsService,
  ) {}

  private formatTask(t: any) {
    if (!t) return null;

    const firstAssignment = (t.assignments || [])[0];
    const assigneeEmployee = firstAssignment ? firstAssignment.employee : null;

    const latestProgressRecord = (t.progress_history || []).sort(
      (a: any, b: any) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    )[0];

    return {
      id: t.id,
      project: t.project_id,
      project_name: t.project ? t.project.name : null,
      title: t.title,
      description: t.description || '',
      milestone: t.milestone_id,
      task_type: t.task_type_id,
      task_type_name: t.task_type ? t.task_type.name : null,
      priority: t.priority,
      status: t.status,
      board_order: t.board_order || 0,
      due_date: t.due_date ? t.due_date.toISOString().split('T')[0] : null,
      created_by: t.created_by_id,
      created_at: t.created_at ? t.created_at.toISOString() : null,
      updated_at: t.updated_at ? t.updated_at.toISOString() : null,
      latest_progress: latestProgressRecord ? latestProgressRecord.progress_percentage : 0,
      assignee_id: assigneeEmployee ? assigneeEmployee.id : null,
      assignees: (t.assignments || []).map((a: any) => a.employee_id),
      assignee_name: assigneeEmployee ? assigneeEmployee.name || assigneeEmployee.username : null,
      assignee_email: assigneeEmployee ? assigneeEmployee.email : null,
      assignments: (t.assignments || []).map((a: any) => ({
        id: a.id,
        task: a.task_id,
        employee: a.employee_id,
        assigned_by: a.assigned_by_id,
        assigned_at: a.assigned_at ? a.assigned_at.toISOString() : null,
        unassigned_at: a.unassigned_at ? a.unassigned_at.toISOString() : null,
        employee_details: a.employee ? formatUserResponse(a.employee) : null,
      })),
      files: (t.files || []).map((f: any) => ({
        id: f.id,
        task: f.task_id,
        uploaded_by: f.uploaded_by_id,
        file: f.file_path,
        file_path: f.file_path,
        file_type: f.file_type,
        revision_no: f.revision_no,
        uploaded_at: f.uploaded_at ? f.uploaded_at.toISOString() : null,
      })),
      comments: (t.comments || []).map((c: any) => ({
        id: c.id,
        task: c.task_id,
        user: c.user_id,
        user_name: c.user ? c.user.name || c.user.username : 'User',
        comment: c.comment,
        created_at: c.created_at ? c.created_at.toISOString() : null,
      })),
    };
  }

  async findAll(
    user: any,
    query: {
      project?: string;
      all?: string;
      search?: string;
      status?: string;
      priority?: string;
      page?: string;
      limit?: string;
    },
  ) {
    const roleName = user.role?.name;
    const where: any = { deleted_at: null };

    if (query.project) {
      where.project_id = Number(query.project);
    }

    if (query.status && query.status !== 'all') {
      where.status = query.status;
    }

    if (query.priority && query.priority !== 'all') {
      where.priority = query.priority;
    }

    if (query.search) {
      where.OR = [
        { title: { contains: query.search, mode: 'insensitive' } },
        { description: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    if (roleName === 'CLIENT') {
      const client = await this.prisma.client.findFirst({
        where: { portal_users: { some: { id: user.id } } },
      });
      if (client) {
        where.project = { client_id: client.id };
      } else {
        return query.project || query.all === 'true'
          ? []
          : { count: 0, next: null, previous: null, results: [] };
      }
    } else if (roleName !== 'SUPER_ADMIN' && roleName !== 'PROJECT_MANAGER' && !user.is_superuser) {
      where.project = {
        members: {
          some: { user_id: user.id },
        },
      };
    }

    if (query.all === 'true' || (query.project && !query.page)) {
      const tasks = await this.prisma.task.findMany({
        where,
        include: {
          project: true,
          task_type: true,
          assignments: {
            where: { deleted_at: null },
            include: { employee: { include: { role: true, department: true, client: true } } },
          },
          files: { where: { deleted_at: null } },
          comments: {
            where: { deleted_at: null },
            include: { user: true },
          },
          progress_history: true,
        },
        orderBy: { id: 'desc' },
      });

      const formatted = tasks.map((t) => this.formatTask(t));
      return formatted;
    }

    const pageNum = Math.max(1, Number(query.page) || 1);
    const limitNum = Math.max(1, Number(query.limit) || 5);
    const skip = (pageNum - 1) * limitNum;

    const count = await this.prisma.task.count({ where });

    const tasks = await this.prisma.task.findMany({
      where,
      include: {
        project: true,
        task_type: true,
        assignments: {
          where: { deleted_at: null },
          include: { employee: { include: { role: true, department: true, client: true } } },
        },
        files: { where: { deleted_at: null } },
        comments: {
          where: { deleted_at: null },
          include: { user: true },
        },
        progress_history: true,
      },
      orderBy: { id: 'desc' },
      skip,
      take: limitNum,
    });

    const formatted = tasks.map((t) => this.formatTask(t));

    return {
      count,
      next: pageNum * limitNum < count ? `/api/tasks?page=${pageNum + 1}` : null,
      previous: pageNum > 1 ? `/api/tasks?page=${pageNum - 1}` : null,
      results: formatted,
    };
  }

  async findOne(id: number, user: any) {
    const roleName = user.role?.name;
    const task = await this.prisma.task.findFirst({
      where: { id, deleted_at: null },
      include: {
        project: true,
        task_type: true,
        assignments: {
          where: { deleted_at: null },
          include: { employee: { include: { role: true, department: true, client: true } } },
        },
        files: { where: { deleted_at: null } },
        comments: {
          where: { deleted_at: null },
          include: { user: true },
        },
        progress_history: true,
      },
    });

    if (!task) throw new NotFoundException('Task not found');

    if (roleName === 'CLIENT') {
      const client = await this.prisma.client.findFirst({
        where: { portal_users: { some: { id: user.id } } },
      });
      if (!client || task.project.client_id !== client.id) {
        throw new ForbiddenException('Clients do not have access to this task.');
      }
    }

    return this.formatTask(task);
  }

  async create(user: any, body: any) {
    const roleName = user.role?.name;
    if (roleName === 'CLIENT') {
      throw new ForbiddenException('Clients do not have permission to modify task data.');
    }
    if (roleName === 'TEAM_MEMBER') {
      throw new ForbiddenException('Team Members do not have permission to create or delete tasks.');
    }

    const projectId = Number(body.project || body.project_id);
    const assignees: number[] = body.assignees || [];

    // Validate assigned users belong to project
    if (assignees.length > 0) {
      const validMembers = await this.prisma.projectMember.findMany({
        where: { project_id: projectId },
      });
      const validUserIds = new Set(validMembers.map((m) => m.user_id));
      for (const empId of assignees) {
        if (!validUserIds.has(Number(empId))) {
          throw new BadRequestException({ assignee: 'This user is not a member of the selected project.' });
        }
      }
    }

    const task = await this.prisma.task.create({
      data: {
        project_id: projectId,
        title: body.title,
        description: body.description || '',
        milestone_id: body.milestone ? Number(body.milestone) : null,
        task_type_id: Number(body.task_type || body.task_type_id),
        priority: body.priority || 'medium',
        status: body.status || 'todo',
        board_order: body.board_order || 0,
        due_date: new Date(body.due_date),
        created_by_id: user.id,
      },
      include: {
        project: true,
        task_type: true,
      },
    });

    // Create assignments
    for (const empId of assignees) {
      await this.prisma.taskAssignment.create({
        data: {
          task_id: task.id,
          employee_id: Number(empId),
          assigned_by_id: user.id,
        },
      });
    }

    await this.activityLogs.logActivity(
      projectId,
      user.id,
      `Created task: ${task.title}`,
    );

    if (task.milestone_id) {
      await this.progressAggregation.recalculateMilestoneProgress(task.milestone_id);
    } else {
      await this.progressAggregation.recalculateProjectProgress(projectId);
    }

    return this.findOne(task.id, user);
  }

  async update(id: number, user: any, body: any) {
    const roleName = user.role?.name;
    if (roleName === 'CLIENT') {
      throw new ForbiddenException('Clients do not have permission to modify task data.');
    }

    const existing = await this.prisma.task.findFirst({
      where: { id, deleted_at: null },
      include: { assignments: { where: { deleted_at: null } } },
    });

    if (!existing) throw new NotFoundException('Task not found');

    const isSuperOrAdmin = user.is_superuser || ['SUPER_ADMIN', 'ADMIN', 'PROJECT_MANAGER'].includes(roleName);

    // Team Member restrictions
    if (!isSuperOrAdmin) {
      const isAssigned = existing.assignments.some((a) => a.employee_id === user.id);
      if (!isAssigned) {
        throw new ForbiddenException('You can only modify tasks assigned to you.');
      }

      const allowedFields = new Set(['status', 'progress_percentage']);
      const bodyKeys = Object.keys(body);
      const unauthorized = bodyKeys.filter((k) => !allowedFields.has(k));
      if (unauthorized.length > 0) {
        throw new ForbiddenException(
          `Team Members can only update status and progress. Unauthorized fields: ${unauthorized.join(', ')}`,
        );
      }
    }

    const data: any = {};
    if (body.title !== undefined) data.title = body.title;
    if (body.description !== undefined) data.description = body.description || '';
    if (body.milestone !== undefined) data.milestone_id = body.milestone ? Number(body.milestone) : null;
    if (body.task_type !== undefined) data.task_type_id = Number(body.task_type);
    if (body.priority !== undefined) data.priority = body.priority;
    if (body.status !== undefined) data.status = body.status;
    if (body.board_order !== undefined) data.board_order = body.board_order;
    if (body.due_date !== undefined) data.due_date = new Date(body.due_date);

    const updated = await this.prisma.task.update({
      where: { id },
      data,
    });

    // Handle progress percentage
    if (body.progress_percentage !== undefined) {
      const lastProgress = await this.prisma.taskProgress.findFirst({
        where: { task_id: id },
        orderBy: { updated_at: 'desc' },
      });
      const currentVal = lastProgress ? lastProgress.progress_percentage : 0;

      if (body.progress_percentage !== currentVal) {
        await this.prisma.taskProgress.create({
          data: {
            task_id: id,
            progress_percentage: Number(body.progress_percentage),
            updated_by_id: user.id,
          },
        });
      }
    }

    // Handle assignees update
    if (body.assignees !== undefined && Array.isArray(body.assignees)) {
      await this.prisma.taskAssignment.updateMany({
        where: { task_id: id, deleted_at: null },
        data: { deleted_at: new Date() },
      });

      for (const empId of body.assignees) {
        await this.prisma.taskAssignment.create({
          data: {
            task_id: id,
            employee_id: Number(empId),
            assigned_by_id: user.id,
          },
        });
      }
    }

    await this.activityLogs.logActivity(
      updated.project_id,
      user.id,
      `Updated task: ${updated.title}`,
    );

    if (updated.milestone_id) {
      await this.progressAggregation.recalculateMilestoneProgress(updated.milestone_id);
    } else {
      await this.progressAggregation.recalculateProjectProgress(updated.project_id);
    }

    return this.findOne(id, user);
  }

  async remove(id: number, user: any) {
    const roleName = user.role?.name;
    const isSuperOrAdmin = user.is_superuser || ['SUPER_ADMIN', 'ADMIN', 'PROJECT_MANAGER'].includes(roleName);
    if (!isSuperOrAdmin) {
      throw new ForbiddenException('Only Project Managers or Administrators can delete tasks.');
    }

    const existing = await this.prisma.task.findFirst({
      where: { id, deleted_at: null },
    });
    if (!existing) throw new NotFoundException('Task not found');

    await this.prisma.task.update({
      where: { id },
      data: { deleted_at: new Date() },
    });

    await this.activityLogs.logActivity(
      existing.project_id,
      user.id,
      `Deleted task: ${existing.title}`,
    );

    if (existing.milestone_id) {
      await this.progressAggregation.recalculateMilestoneProgress(existing.milestone_id);
    } else {
      await this.progressAggregation.recalculateProjectProgress(existing.project_id);
    }

    return null;
  }
}
