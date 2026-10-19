import { Injectable, NotFoundException, ForbiddenException, UnsupportedMediaTypeException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { PrismaService } from '../../core/prisma.service';
import { canAccessProject, isClientUser, isProjectManagerRole, projectScopeFor } from '../../core/utils/project-scope.util';

@Injectable()
export class TaskFilesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Same layout as the original Django app: MEDIA_ROOT/task_files/, stored in task_files.file as `task_files/<name>`. */
  private readonly mediaRoot = path.resolve(process.cwd(), 'media');
  private readonly uploadDir = path.join(this.mediaRoot, 'task_files');

  /**
   * Types that may be shown inline. Everything else is download-only: an uploaded HTML or SVG
   * file opened inline would run script in the application's origin.
   */
  private static readonly PREVIEW_TYPES: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain; charset=utf-8',
  };

  /** Absolute path of a stored file, or null when it is missing or points outside media/task_files. */
  private resolveStoredPath(stored: string | null | undefined): string | null {
    if (!stored) return null;
    const relative = String(stored).replace(/\\/g, '/').replace(/^\/+/, '').replace(/^media\//, '');
    const absolute = path.resolve(this.mediaRoot, relative);
    if (!absolute.startsWith(this.uploadDir + path.sep)) return null;
    return absolute;
  }

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
    const where: any = { deleted_at: null };

    if (query.task) {
      where.task_id = Number(query.task);
    }

    // Files of tasks in projects inside the caller's scope. Previously ADMIN, PROJECT_MANAGER
    // and SALES_MANAGER saw every file.
    const scope = await projectScopeFor(this.prisma, user);
    if (scope) where.task = { project: scope };

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

    if (!(await canAccessProject(this.prisma, user, file.task.project_id))) {
      if (isClientUser(user)) throw new ForbiddenException('Clients do not have access to this file.');
      throw new NotFoundException('Task file not found');
    }

    return this.formatTaskFile(file);
  }

  async create(user: any, body: any, file?: any) {
    const roleName = user.role?.name;
    if (roleName === 'CLIENT') {
      throw new ForbiddenException('Clients do not have permission to modify task files.');
    }

    const taskId = Number(body.task || body.task_id);
    // Uploads need access to the task's project (previously any task id was accepted)
    const task = await this.prisma.task.findFirst({ where: { id: taskId, deleted_at: null }, select: { project_id: true } });
    if (!task || !(await canAccessProject(this.prisma, user, task.project_id))) {
      throw new NotFoundException('Task not found');
    }
    const fileName = file ? file.originalname || file.filename : body.file_path || body.name || 'uploaded_file';
    const fileType = file ? file.mimetype : body.file_type || 'application/octet-stream';

    // Previously the uploaded bytes were discarded, so files could never be downloaded.
    // Stored under a generated name; the original name is kept only as the display name.
    let storedFile: string | null = null;
    let absolutePath: string | null = null;
    if (file?.buffer) {
      const ext = path.extname(String(file.originalname || '')).toLowerCase();
      const safeExt = /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : '';
      const name = `task_${taskId}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}${safeExt}`;
      fs.mkdirSync(this.uploadDir, { recursive: true });
      absolutePath = path.join(this.uploadDir, name);
      fs.writeFileSync(absolutePath, file.buffer);
      storedFile = `task_files/${name}`;
    }

    // Calculate revision_no for same filename on this task
    const existingRevisions = await this.prisma.taskFile.count({
      where: { task_id: taskId, file_path: fileName },
    });

    let created: any;
    try {
      created = await this.prisma.taskFile.create({
        data: {
          task_id: taskId,
          uploaded_by_id: user.id,
          file: storedFile,
          file_path: fileName,
          file_type: fileType,
          revision_no: existingRevisions + 1,
        },
      });
    } catch (error) {
      if (absolutePath) fs.rmSync(absolutePath, { force: true });
      throw error;
    }

    return this.formatTaskFile(created);
  }

  /**
   * File content for GET /task-files/:id/download and /preview, with the same project scope as
   * the other task-file endpoints (clients: own projects; staff: their projects; super admins: all).
   * Never returns the storage path.
   */
  async getFileContent(id: number, user: any, mode: 'download' | 'preview') {
    const file = await this.prisma.taskFile.findFirst({
      where: { id, deleted_at: null },
      include: { task: { select: { project_id: true, deleted_at: true } } },
    });
    if (!file || !file.task || file.task.deleted_at) throw new NotFoundException('Task file not found');

    if (!(await canAccessProject(this.prisma, user, file.task.project_id))) {
      if (isClientUser(user)) throw new ForbiddenException('Clients do not have access to this file.');
      throw new NotFoundException('Task file not found');
    }

    const absolute = this.resolveStoredPath(file.file);
    if (!absolute || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      throw new NotFoundException('The file content is not available.');
    }

    let contentType = 'application/octet-stream';
    if (mode === 'preview') {
      const previewType = TaskFilesService.PREVIEW_TYPES[path.extname(absolute).toLowerCase()];
      if (!previewType) {
        throw new UnsupportedMediaTypeException('Preview is not available for this file type. Download it instead.');
      }
      contentType = previewType;
    }

    return {
      buffer: fs.readFileSync(absolute),
      filename: file.file_path || path.basename(absolute),
      contentType,
      inline: mode === 'preview',
    };
  }

  async remove(id: number, user: any) {
    const roleName = user.role?.name;
    if (roleName === 'CLIENT') {
      throw new ForbiddenException('Clients do not have permission to modify task files.');
    }

    const existing = await this.findOne(id, user);
    // Only the uploader or a project manager role (within scope) may delete a file
    if (!isProjectManagerRole(user) && existing?.uploaded_by !== user.id) {
      throw new ForbiddenException('You can only delete files you uploaded.');
    }

    await this.prisma.taskFile.update({
      where: { id },
      data: { deleted_at: new Date() },
    });

    return null;
  }
}
