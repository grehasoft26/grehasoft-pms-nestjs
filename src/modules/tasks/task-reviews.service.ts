import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma.service';
import { canAccessProject, projectScopeFor } from '../../core/utils/project-scope.util';

@Injectable()
export class TaskReviewsService {
  constructor(private readonly prisma: PrismaService) {}

  private formatReview(r: any) {
    if (!r) return null;
    return {
      id: r.id,
      task_file: r.task_file_id,
      reviewer: r.reviewer_id,
      reviewer_name: r.reviewer ? r.reviewer.name || r.reviewer.username : 'Reviewer',
      reviewed_by_role: r.reviewed_by_role,
      review_version: r.review_version,
      comments: r.comments,
      status: r.status,
      reviewed_at: r.reviewed_at ? r.reviewed_at.toISOString() : null,
    };
  }

  async findAll(user: any, query: { task?: string }) {
    const roleName = user.role?.name;
    if (roleName === 'CLIENT') {
      return [];
    }

    const where: any = {};
    const taskFileWhere: any = {};
    if (query.task) taskFileWhere.task_id = Number(query.task);
    // Reviews of files in projects inside the caller's scope (previously every review)
    const scope = await projectScopeFor(this.prisma, user);
    if (scope) taskFileWhere.task = { project: scope };
    if (Object.keys(taskFileWhere).length) where.task_file = taskFileWhere;

    const reviews = await this.prisma.taskReview.findMany({
      where,
      include: { reviewer: true },
      orderBy: { id: 'desc' },
    });

    return reviews.map((r) => this.formatReview(r));
  }

  /** The reviewed file's project must be inside the caller's scope; 404 otherwise. */
  private async assertFileInScope(user: any, taskFileId: number, message: string) {
    const file = await this.prisma.taskFile.findFirst({
      where: { id: taskFileId, deleted_at: null },
      select: { task: { select: { project_id: true } } },
    });
    if (!file?.task || !(await canAccessProject(this.prisma, user, file.task.project_id))) {
      throw new NotFoundException(message);
    }
  }

  async findOne(id: number, user: any) {
    const review = await this.prisma.taskReview.findUnique({
      where: { id },
      include: { reviewer: true },
    });
    if (!review) throw new NotFoundException('Task review not found');
    await this.assertFileInScope(user, review.task_file_id, 'Task review not found');
    return this.formatReview(review);
  }

  async create(user: any, body: any) {
    const roleName = user.role?.name;
    if (roleName === 'CLIENT') {
      throw new ForbiddenException('Clients do not have permission to modify task reviews.');
    }

    const roleMap: Record<string, string> = {
      SUPER_ADMIN: 'ADMIN',
      ADMIN: 'ADMIN',
      PROJECT_MANAGER: 'PM',
    };

    const reviewedByRole = roleMap[roleName] || (user.is_superuser ? 'ADMIN' : null);
    if (!reviewedByRole) {
      throw new ForbiddenException('Only SUPER_ADMIN and PROJECT_MANAGER can review files.');
    }

    const taskFileId = Number(body.task_file || body.task_file_id);
    await this.assertFileInScope(user, taskFileId, 'Task file not found');
    const existingApproved = await this.prisma.taskReview.findFirst({
      where: { task_file_id: taskFileId, status: 'approved' },
    });

    if (existingApproved) {
      throw new BadRequestException({ non_field_errors: ['This file is already approved and locked.'] });
    }

    const existingCount = await this.prisma.taskReview.count({
      where: { task_file_id: taskFileId },
    });

    const review = await this.prisma.taskReview.create({
      data: {
        task_file_id: taskFileId,
        reviewer_id: user.id,
        reviewed_by_role: reviewedByRole as any,
        review_version: existingCount + 1,
        comments: body.comments || '',
        status: body.status,
      },
      include: { reviewer: true },
    });

    return this.formatReview(review);
  }

  async update(id: number, user: any, body: any) {
    const existing = await this.prisma.taskReview.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Task review not found');
    await this.assertFileInScope(user, existing.task_file_id, 'Task review not found');

    if (existing.reviewer_id !== user.id && !user.is_superuser) {
      throw new ForbiddenException('You can edit only your own review.');
    }

    const updated = await this.prisma.taskReview.update({
      where: { id },
      data: {
        comments: body.comments !== undefined ? body.comments : existing.comments,
        status: body.status !== undefined ? body.status : existing.status,
      },
      include: { reviewer: true },
    });

    return this.formatReview(updated);
  }

  async remove(id: number, user: any) {
    const existing = await this.prisma.taskReview.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Task review not found');
    await this.assertFileInScope(user, existing.task_file_id, 'Task review not found');

    if (existing.reviewer_id !== user.id && !user.is_superuser) {
      throw new ForbiddenException('You can delete only your own review.');
    }

    await this.prisma.taskReview.delete({ where: { id } });
    return null;
  }
}
