import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma.service';

@Injectable()
export class TaskFilesService {
  constructor(private readonly prisma: PrismaService) {}

  private formatTaskFile(f: any) {
    if (!f) return null;
    return {
      id: f.id,
      task: f.task_id,
      uploaded_by: f.uploaded_by_id,
      file: f.file_path,
      file_path: f.file_path,
      file_type: f.file_type,
      revision_no: f.revision_no,
      uploaded_at: f.uploaded_at ? f.uploaded_at.toISOString() : null,
    };
  }

  async findAll(user: any, query: { task?: string }) {
    const roleName = user.role?.name;
    const where: any = { deleted_at: null };

    if (query.task) {
      where.task_id = Number(query.task);
    }

    if (roleName === 'CLIENT') {
      const client = await this.prisma.client.findFirst({
        where: { portal_users: { some: { id: user.id } } },
      });
      if (client) {
        where.task = { project: { client_id: client.id } };
      } else {
        return [];
      }
    } else if (!['SUPER_ADMIN', 'ADMIN', 'PROJECT_MANAGER', 'SALES_MANAGER'].includes(roleName)) {
      where.task = {
        project: {
          OR: [
            { members: { some: { user_id: user.id } } },
            { project_manager_id: user.id },
            { created_by_id: user.id },
          ],
        },
      };
    }

    const files = await this.prisma.taskFile.findMany({
      where,
      orderBy: { id: 'desc' },
    });

    return files.map((f) => this.formatTaskFile(f));
  }

  async findOne(id: number, user: any) {
    const file = await this.prisma.taskFile.findFirst({
      where: { id, deleted_at: null },
      include: { task: { include: { project: { include: { members: true } } } } },
    });
    if (!file) throw new NotFoundException('Task file not found');

    const roleName = user.role?.name;
    if (roleName === 'CLIENT') {
      const client = await this.prisma.client.findFirst({
        where: { portal_users: { some: { id: user.id } } },
      });
      if (!client || file.task.project.client_id !== client.id) {
        throw new ForbiddenException('Clients do not have access to this file.');
      }
    }

    return this.formatTaskFile(file);
  }

  async create(user: any, body: any, file?: any) {
    const roleName = user.role?.name;
    if (roleName === 'CLIENT') {
      throw new ForbiddenException('Clients do not have permission to modify task files.');
    }

    const taskId = Number(body.task || body.task_id);
    const fileName = file ? file.originalname || file.filename : body.file_path || body.name || 'uploaded_file';
    const fileType = file ? file.mimetype : body.file_type || 'application/octet-stream';

    // Calculate revision_no for same filename on this task
    const existingRevisions = await this.prisma.taskFile.count({
      where: { task_id: taskId, file_path: fileName },
    });

    const created = await this.prisma.taskFile.create({
      data: {
        task_id: taskId,
        uploaded_by_id: user.id,
        file_path: fileName,
        file_type: fileType,
        revision_no: existingRevisions + 1,
      },
    });

    return this.formatTaskFile(created);
  }

  async remove(id: number, user: any) {
    const roleName = user.role?.name;
    if (roleName === 'CLIENT') {
      throw new ForbiddenException('Clients do not have permission to modify task files.');
    }

    await this.findOne(id, user);

    await this.prisma.taskFile.update({
      where: { id },
      data: { deleted_at: new Date() },
    });

    return null;
  }
}
