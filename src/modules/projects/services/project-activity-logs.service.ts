import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../core/prisma.service';

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
    const roleName = user.role?.name;
    if (roleName === 'CLIENT') {
      const client = await this.prisma.client.findFirst({
        where: { portal_users: { some: { id: user.id } } },
      });
      if (client) {
        const project = await this.prisma.project.findFirst({
          where: { id: projectId, client_id: client.id },
        });
        if (!project) return [];
      } else {
        return [];
      }
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
