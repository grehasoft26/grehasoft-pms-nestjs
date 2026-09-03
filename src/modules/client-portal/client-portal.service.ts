import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma.service';

@Injectable()
export class ClientPortalService {
  constructor(private readonly prisma: PrismaService) {}

  private async resolveAssociatedClient(user: any) {
    const roleName = user.role?.name || user.role_name;
    if (roleName !== 'CLIENT') {
      throw new ForbiddenException('Unauthorized: User must have CLIENT role');
    }

    const client = await this.prisma.client.findFirst({
      where: {
        OR: [
          { email: user.email },
          { id: user.id },
        ],
      },
    });

    if (!client) {
      throw new NotFoundException('Associated client not found.');
    }

    return client;
  }

  private calculateInvoiceStatus(inv: any): string {
    const total = Number(inv.total || 0);
    const paid = (inv.payments || []).reduce((acc: number, p: any) => acc + Number(p.amount || 0), 0);

    if (total > 0 && paid >= total) return 'paid';
    if (paid > 0 && paid < total) return 'partially_paid';

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (inv.due_date && new Date(inv.due_date) < today) return 'overdue';

    return 'unpaid';
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

    const pending_invoices = invoices.filter((i) => this.calculateInvoiceStatus(i) !== 'paid').length;
    const paid_invoices = invoices.filter((i) => this.calculateInvoiceStatus(i) === 'paid').length;

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
        url: tf.file_path || tf.file,
        download_url: tf.file_path || tf.file,
      })),
      recent_notifications: unreadNotifications.map((n) => ({
        id: n.id,
        title: n.title,
        message: n.message,
        notification_type: n.notification_type,
        read: n.read,
        created_at: n.created_at.toISOString().replace('T', ' ').substring(0, 19),
      })),
      invoices: invoices.map((inv) => ({
        id: inv.id,
        invoice_number: inv.invoice_number,
        total: String(inv.total),
        status: this.calculateInvoiceStatus(inv),
        issue_date: inv.issue_date.toISOString().split('T')[0],
        due_date: inv.due_date.toISOString().split('T')[0],
      })),
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
  async getClientDocuments(user: any, query: any) {
    const client = await this.resolveAssociatedClient(user);

    const projects = await this.prisma.project.findMany({
      where: { client_id: client.id },
      select: { id: true, name: true },
    });
    const projectIds = projects.map((p) => p.id);

    const taskFiles = await this.prisma.taskFile.findMany({
      where: { task: { project_id: { in: projectIds } } },
      include: { task: { include: { project: true } } },
      orderBy: { uploaded_at: 'desc' },
    });

    return taskFiles.map((tf) => ({
      id: `taskfile-${tf.id}`,
      name: tf.file ? tf.file.split('/').pop() : 'File',
      type: 'Task File',
      project_name: tf.task?.project?.name || 'Project',
      date: tf.uploaded_at.toISOString().split('T')[0],
      url: tf.file_path || tf.file,
      download_url: tf.file_path || tf.file,
      file_size: 'Unknown',
    }));
  }
}
