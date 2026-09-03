import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../core/prisma.service';

@Injectable()
export class ProgressAggregationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Recalculates progress & status of a Milestone based on its active tasks
   */
  async recalculateMilestoneProgress(milestoneId: number): Promise<void> {
    const milestone = await this.prisma.milestone.findUnique({
      where: { id: milestoneId },
    });
    if (!milestone) return;

    const tasks = await this.prisma.task.findMany({
      where: {
        milestone_id: milestoneId,
        deleted_at: null,
      },
    });

    const totalTasks = tasks.length;
    const blockedTasks = tasks.filter((t) => t.status === 'blocked').length;

    const taskProgressMap: Record<string, number> = {
      todo: 0,
      in_progress: 50,
      done: 100,
      blocked: 0,
    };

    let progress = 0;
    if (totalTasks > 0) {
      const totalProgress = tasks.reduce(
        (sum, t) => sum + (taskProgressMap[t.status] || 0),
        0,
      );
      progress = Math.floor(totalProgress / totalTasks);
    }

    let status: 'not_started' | 'in_progress' | 'blocked' | 'completed' = 'not_started';
    if (blockedTasks > 0) {
      status = 'blocked';
    } else if (progress === 0) {
      status = 'not_started';
    } else if (progress < 100) {
      status = 'in_progress';
    } else if (progress === 100) {
      status = 'completed';
    }

    await this.prisma.milestone.update({
      where: { id: milestoneId },
      data: { progress, status },
    });

    if (milestone.project_id) {
      await this.recalculateProjectProgress(milestone.project_id);
    }
  }

  /**
   * Recalculates overall progress & status of a Project based on its Milestones
   */
  async recalculateProjectProgress(projectId: number): Promise<void> {
    const milestones = await this.prisma.milestone.findMany({
      where: { project_id: projectId },
    });

    const totalMilestones = milestones.length;
    const blockedMilestones = milestones.filter((m) => m.status === 'blocked').length;

    let progressPercentage = 0;
    if (totalMilestones > 0) {
      const totalProgress = milestones.reduce((sum, m) => sum + m.progress, 0);
      progressPercentage = Math.floor(totalProgress / totalMilestones);
    }

    let status: 'not_started' | 'in_progress' | 'on_hold' | 'completed' | 'blocked' = 'not_started';
    if (blockedMilestones > 0) {
      status = 'blocked';
    } else if (progressPercentage === 0) {
      status = 'not_started';
    } else if (progressPercentage < 100) {
      status = 'in_progress';
    } else if (progressPercentage === 100) {
      status = 'completed';
    }

    await this.prisma.project.update({
      where: { id: projectId },
      data: { progress_percentage: progressPercentage, status },
    });
  }
}
