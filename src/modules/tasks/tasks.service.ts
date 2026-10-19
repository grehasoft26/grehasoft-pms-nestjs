import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma.service';
import { ProgressAggregationService } from '../projects/services/progress-aggregation.service';
import { ProjectActivityLogsService } from '../projects/services/project-activity-logs.service';
import { formatUserResponse } from '../users/user.serializer';
import { canAccessProject, isClientUser, isProjectManagerRole, projectScopeFor } from '../../core/utils/project-scope.util';
import { getActiveRolePermissions, isSuperAdmin } from '../../core/utils/role-access.util';

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

    // Tasks of projects in the caller's scope. Previously PROJECT_MANAGER saw every task;
    // other staff saw member projects only. Unresolvable clients get an empty result.
    const scope = await projectScopeFor(this.prisma, user);
    if (scope) where.project = scope;

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

  /** A task is only reachable through its project's scope (knowing the task id grants nothing). */
  private async assertTaskProjectAccess(user: any, projectId: number) {
    if (await canAccessProject(this.prisma, user, projectId)) return;
    if (isClientUser(user)) throw new ForbiddenException('Clients do not have access to this task.');
    throw new NotFoundException('Task not found');
  }

  /** Milestone and assignee ids from the form must belong to the task's project. */
  private async validateProjectReferences(projectId: number, body: any) {
    if (body.milestone) {
      const milestone = await this.prisma.milestone.findFirst({ where: { id: Number(body.milestone), project_id: projectId } });
      if (!milestone) throw new BadRequestException({ milestone: 'This milestone does not belong to the selected project.' });
    }
    const assignees: unknown[] = Array.isArray(body.assignees) ? body.assignees : [];
    if (assignees.length > 0) {
      const validMembers = await this.prisma.projectMember.findMany({
        where: { project_id: projectId },
      });
      const validUserIds = new Set(validMembers.map((m: any) => m.user_id));
      for (const empId of assignees) {
        if (!validUserIds.has(Number(empId))) {
          throw new BadRequestException({ assignee: 'This user is not a member of the selected project.' });
        }
      }
    }
  }

  /**
   * Makes the task's active assignments match `assigneeIds` (already validated as project members).
   * task_assignments has a unique (task_id, employee_id) key that includes soft-deleted rows, so
   * rows are never re-inserted: unchanged assignees are left as they are (keeping assigned_at and
   * assigned_by), removed ones are soft-deleted with unassigned_at, and a returning assignee's
   * old row is restored. Previously every save soft-deleted and re-created all rows, which hit
   * the unique key whenever an assignee was kept or re-added.
   */
  private async syncAssignments(taskId: number, assigneeIds: unknown[], assignedById: number) {
    const wanted = new Set(assigneeIds.map((v) => Number(v)));
    const existing = await this.prisma.taskAssignment.findMany({ where: { task_id: taskId } });
    const now = new Date();

    for (const row of existing) {
      if (wanted.has(row.employee_id) && row.deleted_at) {
        await this.prisma.taskAssignment.update({
          where: { id: row.id },
          data: { deleted_at: null, unassigned_at: null, assigned_at: now, assigned_by_id: assignedById },
        });
      } else if (!wanted.has(row.employee_id) && !row.deleted_at) {
        await this.prisma.taskAssignment.update({
          where: { id: row.id },
          data: { deleted_at: now, unassigned_at: now },
        });
      }
    }

    const known = new Set(existing.map((row: any) => row.employee_id));
    for (const employeeId of wanted) {
      if (known.has(employeeId)) continue;
      await this.prisma.taskAssignment.create({
        data: { task_id: taskId, employee_id: employeeId, assigned_by_id: assignedById },
      });
    }
  }

  async findOne(id: number, user: any) {
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
    await this.assertTaskProjectAccess(user, task.project_id);

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

    // The target project must be inside the caller's scope (previously any project id was accepted)
    if (!(await canAccessProject(this.prisma, user, projectId))) {
      throw new NotFoundException('Project not found');
    }
    // Creating tasks needs MANAGE_PROJECTS (the permission the "New Task" buttons use), on top of
    // the route's VIEW_TASKS. Previously every role with VIEW_TASKS (e.g. SEO roles) could create tasks.
    if (!isSuperAdmin(user) && !getActiveRolePermissions(user).includes('MANAGE_PROJECTS')) {
      throw new ForbiddenException('You do not have permission to create tasks.');
    }
    // Validate milestone and assigned users belong to project
    await this.validateProjectReferences(projectId, body);

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
    if (Array.isArray(body.assignees)) {
      await this.syncAssignments(task.id, body.assignees, user.id);
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
    await this.assertTaskProjectAccess(user, existing.project_id);

    // Manager roles may edit any field, but only inside projects in their scope (checked above)
    const isSuperOrAdmin = isProjectManagerRole(user);

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

    await this.validateProjectReferences(existing.project_id, body);

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
      await this.syncAssignments(id, body.assignees, user.id);
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
    if (!isProjectManagerRole(user)) {
      throw new ForbiddenException('Only Project Managers or Administrators can delete tasks.');
    }

    const existing = await this.prisma.task.findFirst({
      where: { id, deleted_at: null },
    });
    if (!existing) throw new NotFoundException('Task not found');
    await this.assertTaskProjectAccess(user, existing.project_id);

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
