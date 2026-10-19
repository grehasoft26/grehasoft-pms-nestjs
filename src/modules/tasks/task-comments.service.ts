import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma.service';
import { canAccessProject, isClientUser, isProjectManagerRole, projectScopeFor } from '../../core/utils/project-scope.util';

@Injectable()
export class TaskCommentsService {
  constructor(private readonly prisma: PrismaService) {}

  private formatComment(c: any) {
    if (!c) return null;
    return {
      id: c.id,
      task: c.task_id,
      user: c.user_id,
      user_name: c.user ? c.user.name || c.user.username : 'User',
      comment: c.comment,
      created_at: c.created_at ? c.created_at.toISOString() : null,
    };
  }

  async findAll(user: any, query: { task?: string }) {
    const where: any = { deleted_at: null };

    if (query.task) {
      where.task_id = Number(query.task);
    }

    // Comments on tasks of projects in the caller's scope (previously staff saw every comment)
    const scope = await projectScopeFor(this.prisma, user);
    if (scope) where.task = { project: scope };

    const comments = await this.prisma.taskComment.findMany({
      where,
      include: { user: true },
      orderBy: { id: 'asc' },
    });

    return comments.map((c) => this.formatComment(c));
  }

  /** The comment's task project must be inside the caller's scope; 404 otherwise. */
  private async assertCommentInScope(user: any, taskId: number) {
    const task = await this.prisma.task.findFirst({ where: { id: taskId, deleted_at: null }, select: { project_id: true } });
    if (!task || !(await canAccessProject(this.prisma, user, task.project_id))) {
      throw new NotFoundException('Task comment not found');
    }
  }

  async findOne(id: number, user: any) {
    const comment = await this.prisma.taskComment.findFirst({
      where: { id, deleted_at: null },
      include: { user: true },
    });
    if (!comment) throw new NotFoundException('Task comment not found');
    await this.assertCommentInScope(user, comment.task_id);
    return this.formatComment(comment);
  }

  async create(user: any, body: any) {
    const taskId = Number(body.task || body.task_id);

    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: { project: true },
    });
    if (!task || task.deleted_at) throw new NotFoundException('Task not found');

    // Commenting requires access to the task's project (clients: own projects; staff: their scope)
    if (!(await canAccessProject(this.prisma, user, task.project_id))) {
      if (isClientUser(user)) throw new ForbiddenException('You can only comment on tasks of your own projects.');
      throw new NotFoundException('Task not found');
    }

    const comment = await this.prisma.taskComment.create({
      data: {
        task_id: taskId,
        user_id: user.id,
        comment: body.comment,
      },
      include: { user: true },
    });

    // Log Activity
    await this.prisma.projectActivityLog.create({
      data: {
        project_id: task.project_id,
        user_id: user.id,
        action: `Added comment on task '${task.title}'`,
      },
    });

    return this.formatComment(comment);
  }

  async update(id: number, user: any, body: any) {
    const roleName = user.role?.name;
    if (roleName === 'CLIENT') {
      throw new ForbiddenException('Clients do not have permission to edit or delete comments.');
    }

    const existing = await this.prisma.taskComment.findFirst({
      where: { id, deleted_at: null },
    });
    if (!existing) throw new NotFoundException('Task comment not found');
    await this.assertCommentInScope(user, existing.task_id);

    const isSuperOrAdmin = isProjectManagerRole(user);
    if (!isSuperOrAdmin && existing.user_id !== user.id) {
      throw new ForbiddenException('You can only modify or delete your own comments.');
    }

    const updated = await this.prisma.taskComment.update({
      where: { id },
      data: { comment: body.comment },
      include: { user: true },
    });

    return this.formatComment(updated);
  }

  async remove(id: number, user: any) {
    const roleName = user.role?.name;
    if (roleName === 'CLIENT') {
      throw new ForbiddenException('Clients do not have permission to edit or delete comments.');
    }

    const existing = await this.prisma.taskComment.findFirst({
      where: { id, deleted_at: null },
    });
    if (!existing) throw new NotFoundException('Task comment not found');
    await this.assertCommentInScope(user, existing.task_id);

    const isSuperOrAdmin = isProjectManagerRole(user);
    if (!isSuperOrAdmin && existing.user_id !== user.id) {
      throw new ForbiddenException('You can only modify or delete your own comments.');
    }

    await this.prisma.taskComment.update({
      where: { id },
      data: { deleted_at: new Date() },
    });

    return null;
  }
}
