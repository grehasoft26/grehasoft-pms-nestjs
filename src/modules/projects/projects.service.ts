import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma.service';

@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  private formatProject(p: any) {
    if (!p) return null;
    return {
      id: p.id,
      name: p.name,
      description: p.description || '',
      client: p.client
        ? {
            id: p.client.id,
            company_name: p.client.company_name,
            name: p.client.name,
            email: p.client.email,
          }
        : null,
      client_name: p.client ? p.client.name : null,
      client_company: p.client ? p.client.company_name : null,
      client_email: p.client ? p.client.email : null,
      department: p.department_id,
      project_manager: p.project_manager_id,
      project_manager_name: p.project_manager ? (p.project_manager.name || p.project_manager.username) : null,
      created_by: p.created_by_id,
      start_date: p.start_date ? p.start_date.toISOString().split('T')[0] : null,
      end_date: p.end_date ? p.end_date.toISOString().split('T')[0] : null,
      status: p.status,
      progress_percentage: p.progress_percentage || 0,
      milestones: (p.milestones || []).map((m: any) => ({
        id: m.id,
        project: m.project_id,
        title: m.title,
        due_date: m.due_date ? m.due_date.toISOString().split('T')[0] : null,
        status: m.status,
        progress: m.progress,
        progress_percentage: m.progress,
        created_at: m.created_at ? m.created_at.toISOString() : null,
      })),
    };
  }

  async findAll(user: any, query: { status?: string; client?: string; search?: string; project_id?: string; project?: string; page?: string; limit?: string; all?: string }) {
    const roleName = user.role?.name;
    const where: any = { deleted_at: null };

    const projectId = query.project_id || query.project;
    if (projectId && projectId !== 'all') {
      where.id = Number(projectId);
    }

    if (query.status) {
      where.status = query.status;
    }

    if (query.client) {
      where.client_id = Number(query.client);
    }

    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { description: { contains: query.search, mode: 'insensitive' } },
        { client: { name: { contains: query.search, mode: 'insensitive' } } },
        { client: { company_name: { contains: query.search, mode: 'insensitive' } } },
      ];
    }

    if (roleName === 'CLIENT') {
      const client = await this.prisma.client.findFirst({
        where: {
          OR: [
            { portal_users: { some: { id: user.id } } },
            { email: user.email },
            { id: user.client_id || 0 },
          ],
        },
      });
      if (client) {
        where.client_id = client.id;
      } else {
        return { count: 0, next: null, previous: null, results: [] };
      }
    } else if (roleName !== 'SUPER_ADMIN' && !user.is_superuser) {
      // Non-admin users see projects they belong to as members
      where.members = {
        some: {
          user_id: user.id,
        },
      };
    }

    if (query.all === 'true') {
      const projects = await this.prisma.project.findMany({
        where,
        include: {
          client: true,
          project_manager: true,
          milestones: true,
          members: { include: { user: true } },
        },
        orderBy: { id: 'desc' },
      });

      const formatted = projects.map((p) => this.formatProject(p));
      return {
        count: formatted.length,
        next: null,
        previous: null,
        results: formatted,
      };
    }

    const pageNum = Math.max(1, Number(query.page) || 1);
    const limitNum = Math.max(1, Number(query.limit) || 5);
    const skip = (pageNum - 1) * limitNum;

    const count = await this.prisma.project.count({ where });

    const projects = await this.prisma.project.findMany({
      where,
      include: {
        client: true,
        project_manager: true,
        milestones: true,
        members: { include: { user: true } },
      },
      orderBy: { id: 'desc' },
      skip,
      take: limitNum,
    });

    const formatted = projects.map((p) => this.formatProject(p));
    return {
      count,
      next: pageNum * limitNum < count ? `/api/projects?page=${pageNum + 1}` : null,
      previous: pageNum > 1 ? `/api/projects?page=${pageNum - 1}` : null,
      results: formatted,
    };
  }

  async findOne(id: number, user: any) {
    const roleName = user.role?.name;
    const project = await this.prisma.project.findFirst({
      where: { id, deleted_at: null },
      include: {
        client: true,
        milestones: true,
        members: { include: { user: true } },
      },
    });

    if (!project) throw new NotFoundException('Project not found');

    if (roleName === 'CLIENT') {
      const client = await this.prisma.client.findFirst({
        where: { portal_users: { some: { id: user.id } } },
      });
      if (!client || project.client_id !== client.id) {
        throw new ForbiddenException('You do not have permission to view this project.');
      }
    }

    return this.formatProject(project);
  }

  async create(user: any, body: any) {
    const roleName = user.role?.name;
    if (roleName === 'CLIENT') {
      throw new ForbiddenException('Clients do not have permission to modify project data.');
    }

    const clientId = body.client_id || body.client;
    if (!clientId) {
      throw new BadRequestException({ client: ['Client is required.'] });
    }

    const project = await this.prisma.project.create({
      data: {
        name: body.name,
        client_id: Number(clientId),
        department_id: body.department ? Number(body.department) : null,
        project_manager_id: body.project_manager ? Number(body.project_manager) : null,
        created_by_id: user.id,
        start_date: new Date(body.start_date),
        end_date: new Date(body.end_date),
        status: body.status || 'not_started',
        progress_percentage: body.progress_percentage || 0,
      },
      include: {
        client: true,
        milestones: true,
      },
    });

    return this.formatProject(project);
  }

  async update(id: number, user: any, body: any) {
    const roleName = user.role?.name;
    if (roleName === 'CLIENT') {
      throw new ForbiddenException('Clients do not have permission to modify project data.');
    }

    await this.findOne(id, user);

    const data: any = {};
    if (body.name !== undefined) data.name = body.name;
    const clientId = body.client_id || body.client;
    if (clientId !== undefined) data.client_id = Number(clientId);
    if (body.department !== undefined) data.department_id = body.department ? Number(body.department) : null;
    if (body.project_manager !== undefined) data.project_manager_id = body.project_manager ? Number(body.project_manager) : null;
    if (body.start_date !== undefined) data.start_date = new Date(body.start_date);
    if (body.end_date !== undefined) data.end_date = new Date(body.end_date);
    if (body.status !== undefined) data.status = body.status;
    if (body.progress_percentage !== undefined) data.progress_percentage = body.progress_percentage;

    const updated = await this.prisma.project.update({
      where: { id },
      data,
      include: {
        client: true,
        milestones: true,
      },
    });

    return this.formatProject(updated);
  }

  async remove(id: number, user: any) {
    const roleName = user.role?.name;
    if (roleName === 'CLIENT') {
      throw new ForbiddenException('Clients do not have permission to modify project data.');
    }

    await this.findOne(id, user);

    await this.prisma.project.update({
      where: { id },
      data: { deleted_at: new Date() },
    });

    return null;
  }

  async findProjectMembers(id: number) {
    const members = await this.prisma.projectMember.findMany({
      where: { project_id: id, user: { is_active: true, deleted_at: null } },
      include: { user: true },
    });

    return members.map((m) => ({
      id: m.user.id,
      name: m.user.name,
      username: m.user.username,
      email: m.user.email,
      role: m.user.role_id,
      is_active: m.user.is_active,
      last_login: m.user.last_login ? m.user.last_login.toISOString() : null,
    }));
  }
}
