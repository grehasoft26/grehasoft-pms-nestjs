import { Injectable, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '../../core/prisma.service';
import { computeInvoiceFinancials, dateOnlyKey } from '../invoices/invoice-status';
import { resolveClientForUser } from '../../core/utils/client-scope.util';
import { parseDateOnly } from '../../core/utils/date-only.util';

/** Document types the vault page filters by (ClientDocumentsPage). */
export const CLIENT_DOCUMENT_TYPES = ['proposal', 'invoice', 'taskfile', 'seo_report'] as const;
/** The vault page shows 10 documents per page. */
const CLIENT_DOCUMENTS_PAGE_SIZE = 10;
/** Task files are stored as `task_files/<name>` under media/ (same layout as TaskFilesService). */
const MEDIA_ROOT = path.resolve(process.cwd(), 'media');
const TASK_FILES_DIR = path.join(MEDIA_ROOT, 'task_files');
/** Authenticated download of one vault document (the API never hands out storage paths). */
export const clientDocumentDownloadPath = (taskFileId: number) =>
  `/api/v1/dashboard/documents/taskfile-${taskFileId}/download/`;

@Injectable()
export class ClientPortalService {
  constructor(private readonly prisma: PrismaService) {}

  private async resolveAssociatedClient(user: any) {
    const roleName = user.role?.name || user.role_name;
    if (roleName !== 'CLIENT') {
      throw new ForbiddenException('Unauthorized: User must have CLIENT role');
    }

    // users.client_id link (never `client.id === user.id`, which matched unrelated clients)
    const client = await resolveClientForUser(this.prisma, user);

    if (!client) {
      throw new NotFoundException('Associated client not found.');
    }

    return client;
  }

  /** Shared invoice calculation (same rules as the main invoices API). */
  private invoiceFinancials(inv: any) {
    return computeInvoiceFinancials({
      total: inv.total,
      advance: inv.advance,
      payments: inv.payments,
      due_date: inv.due_date,
    });
  }

  // -------------------------------------------------------------
  // 1. CLIENT NOTIFICATIONS
  // -------------------------------------------------------------
  async getClientNotifications(user: any) {
    const roleName = user.role?.name || user.role_name;
    if (roleName !== 'CLIENT') {
      throw new ForbiddenException('Unauthorized');
    }

    const notifications = await this.prisma.clientNotification.findMany({
      where: { user_id: user.id },
      orderBy: { created_at: 'desc' },
    });

    return notifications.map((n) => ({
      id: n.id,
      title: n.title,
      message: n.message,
      notification_type: n.notification_type,
      read: n.read,
      created_at: n.created_at ? n.created_at.toISOString().replace('T', ' ').substring(0, 19) : '',
    }));
  }

  async markNotificationRead(user: any, id: number) {
    const roleName = user.role?.name || user.role_name;
    if (roleName !== 'CLIENT') {
      throw new ForbiddenException('Unauthorized');
    }

    const notification = await this.prisma.clientNotification.findFirst({
      where: { id, user_id: user.id },
    });
    if (!notification) {
      throw new NotFoundException('Notification not found.');
    }

    await this.prisma.clientNotification.update({
      where: { id },
      data: { read: true },
    });

    return { status: 'success', message: 'Notification marked as read.' };
  }

  async markAllNotificationsRead(user: any) {
    const roleName = user.role?.name || user.role_name;
    if (roleName !== 'CLIENT') {
      throw new ForbiddenException('Unauthorized');
    }

    await this.prisma.clientNotification.updateMany({
      where: { user_id: user.id, read: false },
      data: { read: true },
    });

    return { status: 'success', message: 'All notifications marked as read.' };
  }

  // -------------------------------------------------------------
  // 2. CLIENT DASHBOARD OVERVIEW
  // -------------------------------------------------------------
  async getClientDashboardOverview(user: any) {
    const client = await this.resolveAssociatedClient(user);

    const profile = {
      id: client.id,
      name: client.name,
      company_name: client.company_name || '',
      email: client.email || '',
      phone: client.phone || '',
    };

    const projects = await this.prisma.project.findMany({
      where: { client_id: client.id },
      include: { department: true },
    });

    const websites = await this.prisma.sEOWebsite.findMany({
      where: { client_id: client.id },
    });

    const total_projects = projects.length + websites.length;
    const active_projects = projects.filter((p) => p.status === 'in_progress').length + websites.filter((w) => w.status === 'active').length;
    const completed_projects = projects.filter((p) => p.status === 'completed').length;

    const web_dev_count = projects.filter((p) => (p.name || '').toLowerCase().includes('website') || (p.name || '').toLowerCase().includes('development')).length;
    const mobile_app_count = projects.filter((p) => (p.name || '').toLowerCase().includes('mobile') || (p.name || '').toLowerCase().includes('app')).length;
    const seo_proj_count = websites.length;
    const branding_count = projects.filter((p) => (p.name || '').toLowerCase().includes('branding') || (p.name || '').toLowerCase().includes('design')).length;

    const projectIds = projects.map((p) => p.id);
    const websiteIds = websites.map((w) => w.id);

    const tasks = await this.prisma.task.findMany({
      where: { project_id: { in: projectIds } },
    });

    const seoTasks = await this.prisma.sEOTask.findMany({
      where: { website_id: { in: websiteIds } },
    });

    const pending_tasks = tasks.filter((t) => t.status !== 'done').length;
    const completed_tasks = tasks.filter((t) => t.status === 'done').length;
    const pending_seo_tasks = seoTasks.filter((t) => t.status === 'pending').length;
    const completed_seo_tasks = seoTasks.filter((t) => t.status === 'completed').length;

    const invoices = await this.prisma.invoice.findMany({
      where: { client_id: client.id },
      include: { payments: true },
    });

    const invoiceFinancials = invoices.map((i) => this.invoiceFinancials(i));
    // Pending = an outstanding balance remains (zero-total invoices are neither paid nor pending)
    const pending_invoices = invoiceFinancials.filter((f) => f.balance_paise > 0).length;
    const paid_invoices = invoiceFinancials.filter((f) => f.payment_status === 'paid').length;

    const taskFiles = await this.prisma.taskFile.findMany({
      where: { task: { project_id: { in: projectIds } } },
      orderBy: { uploaded_at: 'desc' },
    });

    const metrics = {
      total_projects,
      active_projects,
      completed_projects,
      website_development_projects: web_dev_count,
      mobile_app_projects: mobile_app_count,
      seo_projects: seo_proj_count,
      branding_projects: branding_count,
      pending_project_tasks: pending_tasks,
      completed_project_tasks: completed_tasks,
      pending_seo_tasks: pending_seo_tasks,
      completed_seo_tasks: completed_seo_tasks,
      today_work_updates: 0,
      files_uploaded: taskFiles.length,
      latest_report: taskFiles[0]?.file ? taskFiles[0].file.split('/').pop() : 'No Reports',
      current_milestone: 'N/A',
      pending_invoices,
      paid_invoices,
    };

    const unreadNotifications = await this.prisma.clientNotification.findMany({
      where: { user_id: user.id, read: false },
      orderBy: { created_at: 'desc' },
      take: 10,
    });

    return {
      profile,
      metrics,
      recent_activities: [],
      recent_documents: taskFiles.map((tf) => ({
        id: `taskfile-${tf.id}`,
        name: tf.file ? tf.file.split('/').pop() : 'File',
        type: 'Task File',
        project_name: 'Project',
        date: tf.uploaded_at.toISOString().split('T')[0],
        url: clientDocumentDownloadPath(tf.id),
        download_url: clientDocumentDownloadPath(tf.id),
      })),
      recent_notifications: unreadNotifications.map((n) => ({
        id: n.id,
        title: n.title,
        message: n.message,
        notification_type: n.notification_type,
        read: n.read,
        created_at: n.created_at.toISOString().replace('T', ' ').substring(0, 19),
      })),
      invoices: invoices.map((inv, idx) => {
        const f = invoiceFinancials[idx];
        return {
          id: inv.id,
          invoice_number: inv.invoice_number,
          total: String(inv.total),
          status: f.status,
          payment_status: f.payment_status,
          is_overdue: f.is_overdue,
          total_paid: f.total_paid,
          balance: f.balance,
          issue_date: dateOnlyKey(inv.issue_date),
          due_date: dateOnlyKey(inv.due_date),
        };
      }),
      latest_reports: [],
      upcoming_deadlines: [],
    };
  }

  // -------------------------------------------------------------
  // 3. CLIENT PROJECT ACTIVITY & ISOLATION CHECK
  // -------------------------------------------------------------
  async getClientProjectActivity(user: any, projectId: number) {
    const client = await this.resolveAssociatedClient(user);

    const project = await this.prisma.project.findFirst({
      where: { id: projectId, client_id: client.id },
    });

    if (!project) {
      throw new NotFoundException('Project not found.');
    }

    const activityLogs = await this.prisma.projectActivityLog.findMany({
      where: { project_id: projectId },
      include: { user: { select: { name: true, username: true } } },
      orderBy: { created_at: 'desc' },
    });

    return activityLogs.map((l) => ({
      module: 'projects',
      activity_type: 'project_activity',
      title: l.action,
      description: `Action on project ${project.name}`,
      status: 'completed',
      performed_by: l.user?.name || l.user?.username || 'System',
      project: project.name,
      website: null,
      timestamp: l.created_at.toISOString().replace('T', ' ').substring(0, 19),
    }));
  }

  // -------------------------------------------------------------
  // 4. CLIENT DOCUMENTS LIST
  // -------------------------------------------------------------
  /**
   * Document vault list (GET /dashboard/documents), paginated like the page expects
   * ({ count, next, previous, results }, 10 per page). Filters, all combined:
   * - search: file name (original or stored) or project name; partial and case-insensitive through
   *   the columns' *_ci collation;
   * - type: the page's types; the vault holds task deliverables only ("taskfile"), so the other
   *   types have no documents here yet;
   * - start_date / end_date: inclusive calendar days of the upload date shown (UTC).
   * Always limited to the projects of the user's own client (no client or project id is read);
   * soft-deleted projects, tasks and files are not listed.
   */
  async getClientDocuments(user: any, query: any = {}) {
    const client = await this.resolveAssociatedClient(user);

    // Validated before any document query (400 on bad values)
    const type = String(query.type ?? '').trim();
    if (type && !(CLIENT_DOCUMENT_TYPES as readonly string[]).includes(type)) {
      throw new BadRequestException(`type must be one of: ${CLIENT_DOCUMENT_TYPES.join(', ')}.`);
    }
    const start = parseDateOnly(query.start_date || undefined, 'Start date');
    const end = parseDateOnly(query.end_date || undefined, 'End date');
    if (start && end && start > end) throw new BadRequestException('Start date cannot be after end date.');
    const page = Math.max(1, Math.floor(Number(query.page)) || 1);
    const limit = Math.min(100, Math.max(1, Math.floor(Number(query.limit)) || CLIENT_DOCUMENTS_PAGE_SIZE));
    const search = String(query.search ?? '').trim();

    const empty = { count: 0, next: null, previous: null, results: [] };
    if (type && type !== 'taskfile') return empty;

    // Soft-deleted projects, tasks and files are left out, like every other task-file read
    const projects = await this.prisma.project.findMany({
      where: { client_id: client.id, deleted_at: null },
      select: { id: true },
    });
    const projectIds = projects.map((p) => p.id);
    if (projectIds.length === 0) return empty;

    const where: any = { deleted_at: null, task: { deleted_at: null, project_id: { in: projectIds } } };
    if (search) {
      where.OR = [
        { file_path: { contains: search } },
        { file: { contains: search } },
        { task: { project: { name: { contains: search } } } },
      ];
    }
    if (start || end) {
      where.uploaded_at = {
        ...(start ? { gte: start } : {}),
        ...(end ? { lt: new Date(end.getTime() + 24 * 60 * 60 * 1000) } : {}),
      };
    }

    const [count, taskFiles] = await Promise.all([
      this.prisma.taskFile.count({ where }),
      this.prisma.taskFile.findMany({
        where,
        include: { task: { include: { project: true } } },
        orderBy: [{ uploaded_at: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const link = (p: number) => `/api/v1/dashboard/documents/?page=${p}`;
    return {
      count,
      next: page * limit < count ? link(page + 1) : null,
      previous: page > 1 ? link(page - 1) : null,
      results: taskFiles.map((tf) => this.formatTaskFileDocument(tf)),
    };
  }

  private formatTaskFileDocument(tf: any) {
    return {
      id: `taskfile-${tf.id}`,
      name: tf.file ? tf.file.split('/').pop() : 'File',
      type: 'Task File',
      project_name: tf.task?.project?.name || 'Project',
      date: tf.uploaded_at.toISOString().split('T')[0],
      url: clientDocumentDownloadPath(tf.id),
      download_url: clientDocumentDownloadPath(tf.id),
      file_size: 'Unknown',
    };
  }

  /**
   * One vault document's content (GET /dashboard/documents/:id/download), for CLIENT users only.
   * The file, its task and its project must not be deleted and the project must belong to the
   * user's own client; another client's document and an unknown id are the same 404, so ids
   * cannot be probed. The stored path is used only when it resolves (symlinks included) to a
   * regular file inside media/task_files.
   */
  async getClientDocumentFile(user: any, documentId: unknown) {
    const client = await this.resolveAssociatedClient(user);
    const notFound = () => new NotFoundException('Document not found.');
    // "taskfile-<id>" as listed (a bare id is accepted too); the vault holds task files only
    const match = /^(?:taskfile-)?([1-9]\d{0,9})$/.exec(
      String(documentId ?? ''),
    );
    const id = match ? Number(match[1]) : NaN;
    if (!Number.isSafeInteger(id) || id > 2147483647) throw notFound();

    const file = await this.prisma.taskFile.findFirst({
      where: {
        id,
        deleted_at: null,
        task: {
          deleted_at: null,
          project: { client_id: client.id, deleted_at: null },
        },
      },
      select: { id: true, file: true, file_path: true },
    });
    if (!file) throw notFound();

    const absolute = this.resolveTaskFilePath(file.file);
    if (!absolute)
      throw new NotFoundException('The file content is not available.');
    // Only the base name is used for the download name (never a directory from the record)
    const filename =
      path.basename(String(file.file_path || absolute).replace(/\\/g, '/')) ||
      'download';
    return { absolute, size: fs.statSync(absolute).size, filename };
  }

  /** Real path of a stored task file, or null when missing, not a file or outside media/task_files. */
  private resolveTaskFilePath(stored: unknown): string | null {
    if (!stored) return null;
    const relative = String(stored)
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .replace(/^media\//, '');
    const absolute = path.resolve(MEDIA_ROOT, relative);
    if (!absolute.startsWith(TASK_FILES_DIR + path.sep)) return null;
    try {
      // A symlink inside task_files must not lead anywhere else
      const real = fs.realpathSync(absolute);
      const realDir = fs.realpathSync(TASK_FILES_DIR);
      if (!real.startsWith(realDir + path.sep) || !fs.statSync(real).isFile())
        return null;
      return real;
    } catch {
      return null;
    }
  }
}
