import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../core/prisma.service';

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------
  // 1. DASHBOARD STATS REPORT
  // -------------------------------------------------------------
  async getDashboardStats(user: any) {
    const roleName = user.role?.name || user.role_name;
    const userId = Number(user.id);
    const today = new Date().toISOString().split('T')[0];

    // CLIENT USER DASHBOARD STATS
    if (roleName === 'CLIENT') {
      const clientId = user.client_id || user.client?.id;

      if (!clientId) {
        return {
          is_client: true,
          metrics: {
            active_projects: 0,
            completed_projects: 0,
            total_projects: 0,
            avg_progress: 0,
            completed_tasks: 0,
            pending_tasks: 0,
            current_milestone: 'N/A',
            latest_work_update: 'N/A',
            latest_report: 'N/A',
          },
          recent_activities: [],
        };
      }

      const projects = await this.prisma.project.findMany({
        where: { client_id: clientId },
      });

      const activeProjectsCount = projects.filter((p) => p.status === 'in_progress').length;
      const completedProjectsCount = projects.filter((p) => p.status === 'completed').length;
      const totalProjectsCount = projects.length;

      const totalProgress = projects.reduce((sum, p) => sum + Number(p.progress_percentage || 0), 0);
      const avgProgress = totalProjectsCount > 0 ? Math.round((totalProgress / totalProjectsCount) * 10) / 10 : 0;

      const projectIds = projects.map((p) => p.id);
      const tasks = await this.prisma.task.findMany({
        where: { project_id: { in: projectIds } },
      });

      const completedTasksCount = tasks.filter((t) => t.status === 'done').length;
      const pendingTasksCount = tasks.filter((t) => t.status !== 'done').length;

      const currentMilestone = await this.prisma.milestone.findFirst({
        where: { project_id: { in: projectIds }, status: 'in_progress' },
      }) || await this.prisma.milestone.findFirst({
        where: { project_id: { in: projectIds } },
        orderBy: { id: 'desc' },
      });

      const currentMilestoneTitle = currentMilestone ? currentMilestone.title : 'No active milestones';

      const recentLogs = await this.prisma.projectActivityLog.findMany({
        where: { project_id: { in: projectIds } },
        include: { project: true },
        orderBy: { created_at: 'desc' },
        take: 10,
      });

      const recentActivities = recentLogs.map((log) => ({
        id: log.id,
        action: log.action,
        created_at: log.created_at,
        project_name: log.project ? log.project.name : null,
      }));

      return {
        is_client: true,
        metrics: {
          active_projects: activeProjectsCount,
          completed_projects: completedProjectsCount,
          total_projects: totalProjectsCount,
          avg_progress: avgProgress,
          completed_tasks: completedTasksCount,
          pending_tasks: pendingTasksCount,
          current_milestone: currentMilestoneTitle,
          latest_work_update: 'No work updates yet',
          latest_report: 'No documents uploaded',
        },
        recent_activities: recentActivities,
      };
    }

    // TEAM_MEMBER (EMPLOYEE) DASHBOARD STATS
    if (roleName === 'TEAM_MEMBER') {
      const memberRows = await this.prisma.projectMember.findMany({
        where: { user_id: userId },
        select: { project_id: true },
      });

      const userProjects = await this.prisma.project.findMany({
        where: {
          OR: [
            { created_by_id: userId },
            { project_manager_id: userId },
            { id: { in: memberRows.map((m) => m.project_id) } },
          ],
        },
      });

      const activeProjects = userProjects.filter((p) => p.status === 'in_progress').length;
      const completedProjects = userProjects.filter((p) => p.status === 'completed').length;
      const totalProjects = userProjects.length;

      const taskAssignments = await this.prisma.taskAssignment.findMany({
        where: { employee_id: userId },
        select: { task_id: true },
      });
      const taskIds = taskAssignments.map((ta) => ta.task_id);

      const assignedTasks = await this.prisma.task.findMany({
        where: { id: { in: taskIds } },
      });

      const completedTasks = assignedTasks.filter((t) => t.status === 'done').length;
      const pendingTasks = assignedTasks.filter((t) => t.status !== 'done').length;
      const totalTasks = completedTasks + pendingTasks;
      const productivity = totalTasks > 0 ? Math.floor((completedTasks / totalTasks) * 100) : 0;

      const reminders = await this.prisma.reminder.findMany({
        where: { user_id: userId },
      });

      const pendingReminders = reminders.filter((r) => !r.is_completed && new Date(r.due_date).toISOString().split('T')[0] >= today).length;
      const overdueReminders = reminders.filter((r) => !r.is_completed && new Date(r.due_date).toISOString().split('T')[0] < today).length;
      const completedReminders = reminders.filter((r) => r.is_completed).length;

      return {
        projects: {
          active: activeProjects,
          completed: completedProjects,
          total: totalProjects,
        },
        tasks: {
          completed: completedTasks,
          pending: pendingTasks,
        },
        reminders: {
          pending: pendingReminders,
          overdue: overdueReminders,
          completed: completedReminders,
        },
        clients: {
          active: 0,
        },
        productivity,
      };
    }

    // ADMIN / SUPER_ADMIN / MANAGER DASHBOARD STATS
    const allProjects = await this.prisma.project.findMany();
    const activeProjects = allProjects.filter((p) => p.status === 'in_progress').length;
    const completedProjects = allProjects.filter((p) => p.status === 'completed').length;
    const totalProjects = allProjects.length;

    const allTasks = await this.prisma.task.findMany();
    const completedTasks = allTasks.filter((t) => t.status === 'done').length;
    const pendingTasks = allTasks.filter((t) => t.status !== 'done').length;

    const activeClientsCount = await this.prisma.client.count({
      where: {
        projects: {
          some: {
            status: 'in_progress',
          },
        },
      },
    });

    const allReminders = await this.prisma.reminder.findMany();
    const pendingReminders = allReminders.filter((r) => !r.is_completed && new Date(r.due_date).toISOString().split('T')[0] >= today).length;
    const overdueReminders = allReminders.filter((r) => !r.is_completed && new Date(r.due_date).toISOString().split('T')[0] < today).length;
    const completedReminders = allReminders.filter((r) => r.is_completed).length;

    return {
      projects: {
        active: activeProjects,
        completed: completedProjects,
        total: totalProjects,
      },
      tasks: {
        completed: completedTasks,
        pending: pendingTasks,
      },
      reminders: {
        pending: pendingReminders,
        overdue: overdueReminders,
        completed: completedReminders,
      },
      clients: {
        active: activeClientsCount,
      },
    };
  }

  // -------------------------------------------------------------
  // 2. QUARTERLY REPORT
  // -------------------------------------------------------------
  async getQuarterlyReport() {
    const currentYear = new Date().getFullYear();
    const startDate = new Date(`${currentYear}-04-01T00:00:00.000Z`);
    const endDate = new Date(`${currentYear}-06-30T23:59:59.999Z`);

    const projects = await this.prisma.project.findMany({
      where: {
        created_at: {
          gte: startDate,
          lte: endDate,
        },
      },
    });

    const tasks = await this.prisma.task.findMany({
      where: {
        created_at: {
          gte: startDate,
          lte: endDate,
        },
      },
    });

    const completedTasks = tasks.filter((t) => t.status === 'done').length;
    const efficiency = tasks.length > 0 ? Math.floor((completedTasks / tasks.length) * 100) : 0;

    const invoices = await this.prisma.invoice.findMany({
      where: {
        created_at: {
          gte: startDate,
          lte: endDate,
        },
      },
    });

    const revenue = invoices.reduce((sum, inv) => sum + Number(inv.total || 0), 0);

    return {
      project_summary: projects.filter((p) => p.status === 'in_progress').length,
      efficiency,
      tasks_created: tasks.length,
      tasks_done: completedTasks,
      revenue,
      satisfaction: 4.5,
    };
  }

  // -------------------------------------------------------------
  // 3. INVOICE ANALYTICS REPORT
  // -------------------------------------------------------------
  async getInvoiceAnalytics() {
    const invoices = await this.prisma.invoice.findMany({
      include: { payments: true },
    });

    let totalBilled = 0;
    let totalPaid = 0;
    let totalPending = 0;

    for (const inv of invoices) {
      const total = Number(inv.total || 0);
      totalBilled += total;

      const advance = Number(inv.advance || 0);
      const paid = advance + inv.payments.reduce((acc, p) => acc + Number(p.amount || 0), 0);
      totalPaid += paid;
      totalPending += Math.max(0, total - paid);
    }

    return {
      total_billed: Math.round(totalBilled * 100) / 100,
      total_paid: Math.round(totalPaid * 100) / 100,
      total_pending: Math.round(totalPending * 100) / 100,
      invoice_count: invoices.length,
    };
  }
}
