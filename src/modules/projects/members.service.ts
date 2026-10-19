import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma.service';
import { ProjectActivityLogsService } from './services/project-activity-logs.service';
import { formatUserResponse } from '../users/user.serializer';
import { canAccessProject, projectScopeFor } from '../../core/utils/project-scope.util';

@Injectable()
export class ProjectMembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activityLogs: ProjectActivityLogsService,
  ) {}

  private formatMember(m: any) {
    if (!m) return null;
    return {
      id: m.id,
      project: m.project_id,
      user: m.user_id,
      role_in_project: m.role_in_project,
      user_details: m.user ? formatUserResponse(m.user) : null,
    };
  }

  async findAll(user: any, query: { project?: string }) {
    const roleName = user.role?.name;
    const where: any = {};

    if (query.project) {
      where.project_id = Number(query.project);
    }

    if (roleName === 'CLIENT') {
      return query.project ? [] : { count: 0, next: null, previous: null, results: [] };
    }
    // Members of projects in the caller's scope only (previously only TEAM_MEMBER was scoped)
    const scope = await projectScopeFor(this.prisma, user);
    if (scope) where.project = scope;

    const members = await this.prisma.projectMember.findMany({
      where,
      include: {
        user: {
          include: { role: true, department: true, client: true },
        },
      },
      orderBy: { id: 'asc' },
    });

    const formatted = members.map((m) => this.formatMember(m));

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

  /** The membership's project must be inside the caller's scope; 404 otherwise. */
  private async assertProjectInScope(user: any, projectId: number, message = 'Project member not found') {
    if (!(await canAccessProject(this.prisma, user, projectId))) throw new NotFoundException(message);
  }

  async findOne(id: number, user: any) {
    const member = await this.prisma.projectMember.findUnique({
      where: { id },
      include: { user: { include: { role: true, department: true, client: true } } },
    });
    if (!member) throw new NotFoundException('Project member not found');
    await this.assertProjectInScope(user, member.project_id);
    return this.formatMember(member);
  }

  async create(user: any, body: any) {
    const roleName = user.role?.name;
    if (roleName === 'CLIENT') {
      throw new ForbiddenException('Clients do not have permission to modify project members.');
    }

    const projectId = Number(body.project || body.project_id);
    const userId = Number(body.user || body.user_id);

    // Project and user ids come from the form: the project must be one the caller manages
    // (in scope), and the user must be an existing, non-deleted, non-client account
    await this.assertProjectInScope(user, projectId, 'Project not found');
    const member = await this.prisma.user.findFirst({ where: { id: userId, deleted_at: null }, include: { role: true } });
    if (!member || member.role?.name === 'CLIENT') {
      throw new BadRequestException({ user: 'User not found.' });
    }

    const existing = await this.prisma.projectMember.findFirst({
      where: { project_id: projectId, user_id: userId },
    });

    if (existing) {
      throw new BadRequestException({ error: 'This user is already assigned to this project.' });
    }

    const created = await this.prisma.projectMember.create({
      data: {
        project_id: projectId,
        user_id: userId,
        role_in_project: body.role_in_project || 'Member',
      },
      include: { user: { include: { role: true, department: true, client: true } } },
    });

    const userName = created.user ? created.user.name || created.user.username : 'User';
    await this.activityLogs.logActivity(
      projectId,
      user.id,
      `Added member: ${userName}`,
    );

    return this.formatMember(created);
  }

  async update(id: number, user: any, body: any) {
    const roleName = user.role?.name;
    if (roleName === 'CLIENT') {
      throw new ForbiddenException('Clients do not have permission to modify project members.');
    }

    const existing = await this.prisma.projectMember.findUnique({
      where: { id },
      include: { user: true },
    });
    if (!existing) throw new NotFoundException('Project member not found');
    await this.assertProjectInScope(user, existing.project_id);

    const updated = await this.prisma.projectMember.update({
      where: { id },
      data: {
        role_in_project: body.role_in_project !== undefined ? body.role_in_project : existing.role_in_project,
      },
      include: { user: { include: { role: true, department: true, client: true } } },
    });

    const userName = updated.user ? updated.user.name || updated.user.username : 'User';
    await this.activityLogs.logActivity(
      updated.project_id,
      user.id,
      `Updated role of ${userName}`,
    );

    return this.formatMember(updated);
  }

  async remove(id: number, user: any) {
    const roleName = user.role?.name;
    if (roleName === 'CLIENT') {
      throw new ForbiddenException('Clients do not have permission to modify project members.');
    }

    const existing = await this.prisma.projectMember.findUnique({
      where: { id },
      include: { user: true },
    });
    if (!existing) throw new NotFoundException('Project member not found');
    await this.assertProjectInScope(user, existing.project_id);

    await this.prisma.projectMember.delete({ where: { id } });

    const userName = existing.user ? existing.user.name || existing.user.username : 'User';
    await this.activityLogs.logActivity(
      existing.project_id,
      user.id,
      `Removed member: ${userName}`,
    );

    return null;
  }
}
