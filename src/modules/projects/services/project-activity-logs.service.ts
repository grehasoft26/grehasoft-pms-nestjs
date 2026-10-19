import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../core/prisma.service';
import { canAccessProject, isClientUser } from '../../../core/utils/project-scope.util';

@Injectable()
export class ProjectActivityLogsService {
  constructor(private readonly prisma: PrismaService) {}

  async logActivity(projectId: number, userId: number, action: string) {
    try {
      return await this.prisma.projectActivityLog.create({
        data: {
          project_id: projectId,
          user_id: userId,
          action,
        },
      });
    } catch (err) {
      console.error('Failed to log project activity:', err);
    }
  }

  async findByProject(projectId: number, user: any) {
    // Clients: own projects (empty list otherwise, as before). Staff: projects in their scope.
    if (!(await canAccessProject(this.prisma, user, projectId))) {
      if (isClientUser(user)) return [];
      throw new NotFoundException('Project not found');
    }

    const logs = await this.prisma.projectActivityLog.findMany({
      where: { project_id: projectId },
      include: { user: true },
      orderBy: { created_at: 'desc' },
    });

    return logs.map((log) => ({
      id: log.id,
      project: log.project_id,
      user: log.user_id,
      user_name: log.user ? log.user.name || log.user.username : 'System',
      action: log.action,
      description: log.action,
      created_at: log.created_at.toISOString(),
    }));
  }
}
