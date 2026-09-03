import { Injectable, ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma.service';
import * as crypto from 'crypto';

@Injectable()
export class SeoService {
  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------
  // HELPER: ROLE CHECKS
  // -------------------------------------------------------------
  private isPrivileged(user: any): boolean {
    const role = user.role?.name || user.role_name;
    return user.is_superuser || role === 'SUPER_ADMIN' || role === 'SEO_MANAGER';
  }

  private isExecutive(user: any): boolean {
    const role = user.role?.name || user.role_name;
    return role === 'SEO_EXECUTIVE';
  }

  private isClient(user: any): boolean {
    const role = user.role?.name || user.role_name;
    return role === 'CLIENT';
  }

  // -------------------------------------------------------------
  // 1. SEO ACTIVITY TYPES
  // -------------------------------------------------------------
  async getActivityTypes(user: any, activeParam?: string) {
    const isPriv = this.isPrivileged(user);
    const where: any = {};

    if (!isPriv) {
      where.is_active = true;
    } else if (activeParam !== undefined) {
      where.is_active = ['true', '1', 'yes'].includes(activeParam.toLowerCase());
    }

    return this.prisma.sEOActivityType.findMany({
      where,
      orderBy: [{ display_order: 'asc' }, { name: 'asc' }],
    });
  }

  async createActivityType(user: any, data: any) {
    if (!this.isPrivileged(user)) {
      throw new ForbiddenException('You do not have permission to manage SEO activity types.');
    }
    return this.prisma.sEOActivityType.create({ data });
  }

  async updateActivityType(user: any, id: number, data: any) {
    if (!this.isPrivileged(user)) {
      throw new ForbiddenException('You do not have permission to manage SEO activity types.');
    }
    return this.prisma.sEOActivityType.update({
      where: { id },
      data,
    });
  }

  async deleteActivityType(user: any, id: number) {
    if (!this.isPrivileged(user)) {
      throw new ForbiddenException('You do not have permission to manage SEO activity types.');
    }
    return this.prisma.sEOActivityType.delete({ where: { id } });
  }

  // -------------------------------------------------------------
  // 2. SEO WEBSITES
  // -------------------------------------------------------------
  async getWebsites(user: any) {
    if (this.isClient(user)) {
      const client = await this.prisma.client.findFirst({
        where: {
          OR: [
            { portal_users: { some: { id: user.id } } },
            { email: user.email },
            { id: user.client_id || 0 },
          ],
        },
      });
      if (!client) return [];
      return this.prisma.sEOWebsite.findMany({
        where: { client_id: client.id },
        include: { client: true, assigned_executive: true, assigned_by: true },
        orderBy: { created_at: 'desc' },
      });
    }

    if (this.isExecutive(user)) {
      return this.prisma.sEOWebsite.findMany({
        where: { assigned_executive_id: user.id },
        include: { client: true, assigned_executive: true, assigned_by: true },
        orderBy: { created_at: 'desc' },
      });
    }

    // Admins & Managers see all
    return this.prisma.sEOWebsite.findMany({
      include: { client: true, assigned_executive: true, assigned_by: true },
      orderBy: { created_at: 'desc' },
    });
  }

  async getWebsiteById(user: any, id: number) {
    const website = await this.prisma.sEOWebsite.findUnique({
      where: { id },
      include: { client: true, assigned_executive: true, assigned_by: true },
    });
    if (!website) throw new NotFoundException('Website not found');

    if (this.isClient(user) && website.client_id !== user.client_id) {
      throw new ForbiddenException('Access denied');
    }
    if (this.isExecutive(user) && website.assigned_executive_id !== user.id) {
      throw new ForbiddenException('Access denied');
    }
    return website;
  }

  async createWebsite(user: any, data: any) {
    if (this.isClient(user)) {
      throw new ForbiddenException('Clients do not have permission to modify websites.');
    }
    if (!this.isPrivileged(user)) {
      throw new ForbiddenException('Only SEO Managers and Admins can create websites.');
    }

    const payload: any = {
      client_id: Number(data.client_id || data.client),
      website_name: data.website_name,
      domain_url: data.domain_url,
      start_date: data.start_date ? new Date(data.start_date) : null,
      package_plan: data.package_plan || 'basic',
      google_search_console_id: data.google_search_console_id || null,
      google_analytics_id: data.google_analytics_id || null,
      sitemap_url: data.sitemap_url || null,
      target_country: data.target_country || null,
      status: data.status || 'active',
      notes: data.notes || null,
    };

    const assignedExecId = data.assigned_executive_id || data.assigned_executive;
    if (assignedExecId) {
      payload.assigned_executive_id = Number(assignedExecId);
      payload.assigned_by_id = user.id;
      payload.assigned_date = new Date();
    }

    return this.prisma.sEOWebsite.create({
      data: payload,
      include: { client: true, assigned_executive: true },
    });
  }

  async updateWebsite(user: any, id: number, data: any) {
    if (this.isClient(user)) {
      throw new ForbiddenException('Clients do not have permission to modify websites.');
    }
    if (!this.isPrivileged(user)) {
      throw new ForbiddenException('Only SEO Managers and Admins can update websites.');
    }

    const website = await this.prisma.sEOWebsite.findUnique({ where: { id } });
    if (!website) throw new NotFoundException('Website not found');

    const payload: any = {};
    if (data.client_id || data.client) payload.client_id = Number(data.client_id || data.client);
    if (data.website_name !== undefined) payload.website_name = data.website_name;
    if (data.domain_url !== undefined) payload.domain_url = data.domain_url;
    if (data.start_date !== undefined) payload.start_date = data.start_date ? new Date(data.start_date) : null;
    if (data.package_plan !== undefined) payload.package_plan = data.package_plan;
    if (data.google_search_console_id !== undefined) payload.google_search_console_id = data.google_search_console_id;
    if (data.google_analytics_id !== undefined) payload.google_analytics_id = data.google_analytics_id;
    if (data.sitemap_url !== undefined) payload.sitemap_url = data.sitemap_url;
    if (data.target_country !== undefined) payload.target_country = data.target_country;
    if (data.status !== undefined) payload.status = data.status;
    if (data.notes !== undefined) payload.notes = data.notes;

    const newExecId = data.assigned_executive_id !== undefined ? data.assigned_executive_id : data.assigned_executive;
    if (newExecId !== undefined) {
      const parsedExecId = newExecId ? Number(newExecId) : null;
      if (parsedExecId !== website.assigned_executive_id) {
        payload.assigned_executive_id = parsedExecId;
        payload.assigned_by_id = user.id;
        payload.assigned_date = new Date();
      }
    }

    return this.prisma.sEOWebsite.update({
      where: { id },
      data: payload,
      include: { client: true, assigned_executive: true },
    });
  }

  async deleteWebsite(user: any, id: number) {
    if (this.isClient(user)) {
      throw new ForbiddenException('Clients do not have permission to modify websites.');
    }
    if (!this.isPrivileged(user)) {
      throw new ForbiddenException('Only SEO Managers and Admins can delete websites.');
    }
    return this.prisma.sEOWebsite.delete({ where: { id } });
  }

  // -------------------------------------------------------------
  // 3. SEO KEYWORDS
  // -------------------------------------------------------------
  async getKeywords(user: any, websiteId?: number) {
    const where: any = {};
    if (websiteId) where.website_id = Number(websiteId);

    if (this.isClient(user)) {
      if (!user.client_id) return [];
      where.website = { client_id: user.client_id };
    } else if (this.isExecutive(user)) {
      where.website = { assigned_executive_id: user.id };
    }

    return this.prisma.sEOKeyword.findMany({
      where,
      include: { website: true },
      orderBy: { keyword: 'asc' },
    });
  }

  async createKeyword(user: any, data: any) {
    if (this.isClient(user)) {
      throw new ForbiddenException('Clients do not have permission to modify target keywords.');
    }
    if (!this.isPrivileged(user)) {
      throw new ForbiddenException('Only SEO Managers and Admins can add target keywords.');
    }

    return this.prisma.sEOKeyword.create({
      data: {
        website_id: Number(data.website_id || data.website),
        keyword: data.keyword,
        search_volume: Number(data.search_volume || 0),
        difficulty_score: Number(data.difficulty_score || 0),
        priority: data.priority || 'medium',
        target_rank: data.target_rank ? Number(data.target_rank) : null,
        current_rank: data.current_rank ? Number(data.current_rank) : null,
        notes: data.notes || null,
      },
      include: { website: true },
    });
  }

  async updateKeyword(user: any, id: number, data: any) {
    if (this.isClient(user)) {
      throw new ForbiddenException('Clients do not have permission to modify target keywords.');
    }
    if (!this.isPrivileged(user)) {
      throw new ForbiddenException('Only SEO Managers and Admins can update target keywords.');
    }

    return this.prisma.sEOKeyword.update({
      where: { id },
      data: {
        keyword: data.keyword,
        search_volume: data.search_volume !== undefined ? Number(data.search_volume) : undefined,
        difficulty_score: data.difficulty_score !== undefined ? Number(data.difficulty_score) : undefined,
        priority: data.priority,
        target_rank: data.target_rank !== undefined ? (data.target_rank ? Number(data.target_rank) : null) : undefined,
        current_rank: data.current_rank !== undefined ? (data.current_rank ? Number(data.current_rank) : null) : undefined,
        notes: data.notes,
      },
      include: { website: true },
    });
  }

  async deleteKeyword(user: any, id: number) {
    if (this.isClient(user)) {
      throw new ForbiddenException('Clients do not have permission to modify target keywords.');
    }
    if (!this.isPrivileged(user)) {
      throw new ForbiddenException('Only SEO Managers and Admins can delete target keywords.');
    }
    return this.prisma.sEOKeyword.delete({ where: { id } });
  }

  // -------------------------------------------------------------
  // 4. SEO DAILY WORK LOGS
  // -------------------------------------------------------------
  private formatDailyLog(log: any) {
    if (!log) return null;
    const exec = log.executive;
    const web = log.website;
    const createdBy = log.created_by;
    const approvedBy = log.approved_by;
    const rejectedBy = log.rejected_by;

    const items = Array.isArray(log.items)
      ? log.items.map((it: any) => ({
          ...it,
          activity_type: it.activity_type_id || (it.activity_type ? it.activity_type.id : undefined),
          activity_type_name: it.activity_type ? it.activity_type.name : '',
          password: it.password ? this.decryptPassword(it.password) : '',
          decrypted_password: it.password ? this.decryptPassword(it.password) : '',
        }))
      : [];

    return {
      ...log,
      website: log.website_id,
      executive: log.executive_id,
      website_name: web ? web.website_name : '',
      executive_name: exec ? (exec.name || exec.username) : '',
      created_by_name: createdBy ? (createdBy.name || createdBy.username) : '',
      approved_by_name: approvedBy ? (approvedBy.name || approvedBy.username) : '',
      rejected_by_name: rejectedBy ? (rejectedBy.name || rejectedBy.username) : '',
      items,
    };
  }

  async getDailyLogs(user: any, query: any) {
    const where: any = {};

    if (this.isClient(user)) {
      if (!user.client_id) return [];
      where.website = { client_id: user.client_id };
      where.status = 'approved';
    } else if (this.isExecutive(user)) {
      where.executive_id = user.id;
    }

    if (query.status) where.status = query.status;
    if (query.website) where.website_id = Number(query.website);
    if (query.executive) where.executive_id = Number(query.executive);
    if (query.seo_task) where.seo_task_id = Number(query.seo_task);
    if (query.start_date) where.log_date = { gte: new Date(query.start_date) };
    if (query.end_date) {
      where.log_date = { ...(where.log_date || {}), lte: new Date(query.end_date) };
    }
    if (query.activity_type || query.keyword) {
      where.items = {
        some: {
          ...(query.activity_type ? { activity_type_id: Number(query.activity_type) } : {}),
          ...(query.keyword ? { keyword: { contains: query.keyword } } : {}),
        },
      };
    }

    const logs = await this.prisma.sEODailyWorkLog.findMany({
      where,
      include: {
        website: true,
        executive: true,
        created_by: true,
        updated_by: true,
        approved_by: true,
        rejected_by: true,
        items: { include: { activity_type: true } },
        proof_files: true,
      },
      orderBy: [{ log_date: 'desc' }, { created_at: 'desc' }],
    });

    return logs.map((l) => this.formatDailyLog(l));
  }

  async getDailyLogById(user: any, id: number) {
    const log = await this.prisma.sEODailyWorkLog.findUnique({
      where: { id },
      include: {
        website: true,
        executive: true,
        created_by: true,
        updated_by: true,
        approved_by: true,
        rejected_by: true,
        items: { include: { activity_type: true } },
        proof_files: true,
      },
    });
    if (!log) throw new NotFoundException('Daily work log not found');
    return this.formatDailyLog(log);
  }

  async createDailyLog(user: any, data: any) {
    if (this.isClient(user)) {
      throw new ForbiddenException('Clients do not have permission to modify daily work logs.');
    }

    const website_id = Number(data.website_id || data.website);
    const log_date = new Date(data.log_date);
    const executive_id = data.executive_id || data.executive ? Number(data.executive_id || data.executive) : user.id;

    // Check if existing log for (executive, website, date)
    const existingLog = await this.prisma.sEODailyWorkLog.findFirst({
      where: { executive_id, website_id, log_date },
    });

    if (existingLog) {
      return this.addItemsToDailyLog(user, {
        website: website_id,
        log_date: data.log_date,
        items: data.items,
        remarks: data.remarks,
        status: data.status,
      });
    }

    const itemsData = Array.isArray(data.items) ? data.items : [];
    let totalCount = 0;
    const itemsCreate = itemsData.map((item: any) => {
      const count = Number(item.count || 1);
      totalCount += count;
      return {
        activity_type_id: Number(item.activity_type_id || item.activity_type),
        count,
        keyword: item.keyword || null,
        submission_url: item.submission_url || null,
        domain_authority: item.domain_authority ? Number(item.domain_authority) : null,
        spam_score: item.spam_score ? Number(item.spam_score) : null,
        time_spent_minutes: item.time_spent_minutes ? Number(item.time_spent_minutes) : null,
        username: item.username || null,
        password: item.password ? this.encryptPassword(item.password) : null,
      };
    });

    const createdLog = await this.prisma.sEODailyWorkLog.create({
      data: {
        website_id,
        log_date,
        executive_id,
        created_by_id: user.id,
        remarks: data.remarks || null,
        total_count: totalCount,
        status: data.status || 'draft',
        seo_task_id: data.seo_task_id || data.seo_task ? Number(data.seo_task_id || data.seo_task) : null,
        items: { create: itemsCreate },
      },
      include: {
        website: true,
        executive: true,
        created_by: true,
        updated_by: true,
        approved_by: true,
        rejected_by: true,
        items: { include: { activity_type: true } },
        proof_files: true,
      },
    });

    return this.formatDailyLog(createdLog);
  }

  async addItemsToDailyLog(user: any, data: any) {
    const website_id = Number(data.website_id || data.website);
    const log_date = new Date(data.log_date);
    const executive_id = user.id;

    let log = await this.prisma.sEODailyWorkLog.findFirst({
      where: { executive_id, website_id, log_date },
    });

    if (!log) {
      log = await this.prisma.sEODailyWorkLog.create({
        data: {
          website_id,
          log_date,
          executive_id,
          created_by_id: user.id,
          remarks: data.remarks || '',
          status: data.status || 'submitted',
          seo_task_id: data.seo_task_id || data.seo_task ? Number(data.seo_task_id || data.seo_task) : null,
          total_count: 0,
        },
      });
    }

    const itemsData = Array.isArray(data.items) ? data.items : [];
    let addedCount = 0;

    for (const item of itemsData) {
      const count = Number(item.count || 1);
      addedCount += count;
      await this.prisma.sEODailyWorkLogItem.create({
        data: {
          work_log_id: log.id,
          activity_type_id: Number(item.activity_type_id || item.activity_type),
          count,
          keyword: item.keyword || null,
          submission_url: item.submission_url || null,
          domain_authority: item.domain_authority ? Number(item.domain_authority) : null,
          spam_score: item.spam_score ? Number(item.spam_score) : null,
          time_spent_minutes: item.time_spent_minutes ? Number(item.time_spent_minutes) : null,
          username: item.username || null,
          password: item.password ? this.encryptPassword(item.password) : null,
        },
      });
    }

    const newTotal = log.total_count + addedCount;
    const updatedLog = await this.prisma.sEODailyWorkLog.update({
      where: { id: log.id },
      data: {
        total_count: newTotal,
        remarks: data.remarks !== undefined ? data.remarks : log.remarks,
        status: data.status !== undefined ? data.status : log.status,
        updated_by_id: user.id,
      },
      include: {
        website: true,
        executive: true,
        created_by: true,
        updated_by: true,
        approved_by: true,
        rejected_by: true,
        items: { include: { activity_type: true } },
        proof_files: true,
      },
    });

    return this.formatDailyLog(updatedLog);
  }

  async updateDailyLog(user: any, id: number, data: any) {
    if (this.isClient(user)) {
      throw new ForbiddenException('Clients do not have permission to modify daily work logs.');
    }

    const log = await this.prisma.sEODailyWorkLog.findUnique({ where: { id } });
    if (!log) throw new NotFoundException('Daily work log not found');

    if (this.isExecutive(user)) {
      if (log.executive_id !== user.id) {
        throw new ForbiddenException('You can only edit your own logs.');
      }
      if (!['draft', 'rejected'].includes(log.status)) {
        throw new ForbiddenException('You can only edit logs in Draft or Rejected status.');
      }
      if (data.status && !['draft', 'submitted'].includes(data.status)) {
        throw new BadRequestException('You can only save as draft or submit.');
      }
    }

    const updatePayload: any = { updated_by_id: user.id };
    if (data.remarks !== undefined) updatePayload.remarks = data.remarks;
    if (data.status !== undefined) updatePayload.status = data.status;

    const updatedLog = await this.prisma.sEODailyWorkLog.update({
      where: { id },
      data: updatePayload,
      include: {
        website: true,
        executive: true,
        created_by: true,
        updated_by: true,
        approved_by: true,
        rejected_by: true,
        items: { include: { activity_type: true } },
        proof_files: true,
      },
    });

    return this.formatDailyLog(updatedLog);
  }

  async deleteDailyLog(user: any, id: number) {
    if (this.isClient(user)) {
      throw new ForbiddenException('Clients do not have permission to modify daily work logs.');
    }
    const log = await this.prisma.sEODailyWorkLog.findUnique({ where: { id } });
    if (!log) throw new NotFoundException('Daily work log not found');

    if (this.isExecutive(user) && log.executive_id !== user.id) {
      throw new ForbiddenException('You can only delete your own logs.');
    }
    return this.prisma.sEODailyWorkLog.delete({ where: { id } });
  }

  async approveDailyLog(user: any, id: number) {
    if (!this.isPrivileged(user)) {
      throw new ForbiddenException('Only SEO Managers and Admins can approve logs.');
    }

    const log = await this.prisma.sEODailyWorkLog.findUnique({
      where: { id },
      include: { seo_task: true, executive: true },
    });
    if (!log) throw new NotFoundException('Daily work log not found');

    await this.prisma.sEODailyWorkLog.update({
      where: { id },
      data: {
        status: 'approved',
        approved_by_id: user.id,
        approved_date: new Date(),
      },
    });

    if (log.seo_task_id) {
      const execName = user.name || user.username;
      await this.prisma.sEOTaskTimeline.create({
        data: {
          task_id: log.seo_task_id,
          user_id: user.id,
          user_name: execName,
          action: 'Manager Approved Work Log',
          remarks: `Log date: ${log.log_date.toISOString().split('T')[0]}. Approved by manager.`,
        },
      });

      // Automatically complete task if all daily logs are approved
      const otherLogs = await this.prisma.sEODailyWorkLog.findMany({
        where: { seo_task_id: log.seo_task_id, NOT: { id: log.id } },
      });
      const hasUnapproved = otherLogs.some((l) => ['submitted', 'rejected'].includes(l.status));
      if (!hasUnapproved) {
        await this.prisma.sEOTask.update({
          where: { id: log.seo_task_id },
          data: { status: 'completed', review_status: 'approved' },
        });
        await this.prisma.sEOTaskTimeline.create({
          data: {
            task_id: log.seo_task_id,
            user_id: user.id,
            user_name: execName,
            action: 'Manager Marked Task as Completed',
            remarks: `Automatically completed after approving the final work log for log date ${log.log_date.toISOString().split('T')[0]}.`,
          },
        });
      }
    }

    return { status: 'approved' };
  }

  async rejectDailyLog(user: any, id: number, remarks: string) {
    if (!this.isPrivileged(user)) {
      throw new ForbiddenException('Only SEO Managers and Admins can reject logs.');
    }
    if (!remarks) throw new BadRequestException('Rejection remarks are required.');

    const log = await this.prisma.sEODailyWorkLog.findUnique({ where: { id } });
    if (!log) throw new NotFoundException('Daily work log not found');

    await this.prisma.sEODailyWorkLog.update({
      where: { id },
      data: {
        status: 'rejected',
        remarks_by_manager: remarks,
        rejected_by_id: user.id,
        rejected_date: new Date(),
      },
    });

    if (log.seo_task_id) {
      await this.prisma.sEOTask.update({
        where: { id: log.seo_task_id },
        data: {
          status: 'in_progress',
          review_status: 'rejected',
          manager_remarks: remarks,
        },
      });

      const execName = user.name || user.username;
      await this.prisma.sEOTaskTimeline.create({
        data: {
          task_id: log.seo_task_id,
          user_id: user.id,
          user_name: execName,
          action: 'Manager Rejected Work Log',
          remarks: `Log date: ${log.log_date.toISOString().split('T')[0]}. Rejection remarks: ${remarks}.`,
        },
      });
      await this.prisma.sEOTaskTimeline.create({
        data: {
          task_id: log.seo_task_id,
          user_id: user.id,
          user_name: execName,
          action: 'Manager Returned Task to In Progress',
          remarks: `Returned to in_progress after rejecting work log of ${log.log_date.toISOString().split('T')[0]}. Remarks: ${remarks}`,
        },
      });
    }

    return { status: 'rejected' };
  }

  // -------------------------------------------------------------
  // 5. SEO DASHBOARD & TEAM PERFORMANCE
  // -------------------------------------------------------------
  async getDashboard(user: any) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const isPriv = this.isPrivileged(user);

    if (isPriv) {
      const total_clients = await this.prisma.client.count({
        where: { seo_websites: { some: {} } },
      });
      const total_websites = await this.prisma.sEOWebsite.count();
      const active_projects = await this.prisma.sEOWebsite.count({ where: { status: 'active' } });

      const logsToday = await this.prisma.sEODailyWorkLog.findMany({
        where: { log_date: today },
        select: { total_count: true },
      });
      const activities_today = logsToday.reduce((sum, l) => sum + l.total_count, 0);

      const pending_reviews = await this.prisma.sEODailyWorkLog.count({ where: { status: 'submitted' } });

      return {
        kpis: {
          total_clients,
          total_websites,
          active_projects,
          activities_today,
          activities_this_month: activities_today,
          pending_reviews,
          target_completion_pct: 100,
          top_performing_executive: 'SEO Team',
        },
        monthly_trend: [{ month: 'Mar', activities: activities_today }],
        activities_by_type: [],
        activities_by_website: [],
        activities_by_executive: [],
      };
    } else {
      const myLogsToday = await this.prisma.sEODailyWorkLog.findMany({
        where: { executive_id: user.id, log_date: today },
        select: { total_count: true },
      });
      const today_count = myLogsToday.reduce((sum, l) => sum + l.total_count, 0);

      const assigned_websites = await this.prisma.sEOWebsite.count({
        where: { assigned_executive_id: user.id, status: 'active' },
      });
      const pending_tasks = await this.prisma.sEOTask.count({
        where: { assigned_executive_id: user.id, status: 'pending' },
      });
      const pending_reminders = await this.prisma.sEOReminder.count({
        where: { assigned_executive_id: user.id, status: 'pending' },
      });

      return {
        kpis: {
          today_count,
          progress_pct: 100,
          assigned_websites,
          pending_tasks,
          pending_reminders,
        },
        targets: [],
      };
    }
  }

  async getTeamPerformance(user: any) {
    if (!this.isPrivileged(user)) {
      throw new ForbiddenException('Only SEO Managers and Admins can view team performance.');
    }

    const execs = await this.prisma.user.findMany({
      where: { role: { name: 'SEO_EXECUTIVE' } },
      select: { id: true, name: true, username: true },
    });

    const leaderboard = await Promise.all(
      execs.map(async (exec) => {
        const assigned_websites = await this.prisma.sEOWebsite.count({
          where: { assigned_executive_id: exec.id, status: 'active' },
        });
        const logs = await this.prisma.sEODailyWorkLog.findMany({
          where: { executive_id: exec.id },
          select: { total_count: true },
        });
        const total = logs.reduce((s, l) => s + l.total_count, 0);

        return {
          id: exec.id,
          name: exec.name || exec.username,
          activities_today: total,
          activities_this_week: total,
          activities_this_month: total,
          approval_rate: 100,
          assigned_websites,
          breakdown: {},
        };
      }),
    );

    return leaderboard.sort((a, b) => b.activities_this_month - a.activities_this_month);
  }

  // -------------------------------------------------------------
  // 6. SEO MONTHLY TARGETS
  // -------------------------------------------------------------
  private formatMonthlyTarget(target: any) {
    if (!target) return null;
    const exec = target.executive;
    const web = target.website;
    const act = target.activity_type;

    return {
      ...target,
      executive_name: exec ? (exec.name || exec.username) : '',
      website_name: web ? web.website_name : 'Overall',
      activity_type_name: act ? act.name : '',
    };
  }

  async getMonthlyTargets(user: any) {
    const where: any = {};
    if (this.isExecutive(user)) {
      where.executive_id = user.id;
    }
    const targets = await this.prisma.sEOMonthlyTarget.findMany({
      where,
      include: { executive: true, website: true, activity_type: true },
      orderBy: [{ month: 'desc' }, { executive: { username: 'asc' } }],
    });
    return targets.map((t) => this.formatMonthlyTarget(t));
  }

  async createMonthlyTarget(user: any, data: any) {
    if (!this.isPrivileged(user)) {
      throw new ForbiddenException('Only SEO Managers and Admins can create targets.');
    }
    const created = await this.prisma.sEOMonthlyTarget.create({
      data: {
        executive_id: Number(data.executive_id || data.executive),
        website_id: data.website_id || data.website ? Number(data.website_id || data.website) : null,
        month: data.month,
        activity_type_id: Number(data.activity_type_id || data.activity_type),
        target_count: Number(data.target_count || 0),
      },
      include: { executive: true, website: true, activity_type: true },
    });
    return this.formatMonthlyTarget(created);
  }

  async deleteMonthlyTarget(user: any, id: number) {
    if (!this.isPrivileged(user)) {
      throw new ForbiddenException('Only SEO Managers and Admins can delete targets.');
    }
    return this.prisma.sEOMonthlyTarget.delete({ where: { id } });
  }

  // -------------------------------------------------------------
  // 7. SEO TASKS
  // -------------------------------------------------------------
  async getTasks(user: any, query: any) {
    const where: any = {};
    if (this.isExecutive(user)) {
      where.assigned_executive_id = user.id;
    }

    if (query.website) where.website_id = Number(query.website);
    if (query.executive) where.assigned_executive_id = Number(query.executive);
    if (query.priority) where.priority = query.priority;
    if (query.activity_type) where.activity_type_id = Number(query.activity_type);

    if (query.search) {
      where.OR = [
        { title: { contains: query.search } },
        { description: { contains: query.search } },
        { website: { website_name: { contains: query.search } } },
      ];
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (query.status) {
      if (query.status === 'overdue') {
        where.due_date = { lt: today };
        where.NOT = { status: 'completed' };
      } else {
        where.status = query.status;
      }
    }

    const page = Number(query.page || 1);
    const pageSize = Number(query.page_size || 10);

    const [tasks, total] = await Promise.all([
      this.prisma.sEOTask.findMany({
        where,
        include: {
          website: true,
          assigned_executive: true,
          created_by: true,
          activity_type: true,
          timeline: { orderBy: { event_time: 'asc' } },
        },
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.sEOTask.count({ where }),
    ]);

    const stats_qs: any = { ...(where.status ? {} : where) };
    const statsTotal = await this.prisma.sEOTask.count({ where: stats_qs });
    const pending = await this.prisma.sEOTask.count({ where: { ...stats_qs, status: 'pending' } });
    const in_progress = await this.prisma.sEOTask.count({ where: { ...stats_qs, status: 'in_progress' } });
    const ready_for_review = await this.prisma.sEOTask.count({ where: { ...stats_qs, status: 'ready_for_review' } });
    const completed = await this.prisma.sEOTask.count({ where: { ...stats_qs, status: 'completed' } });
    const overdue = await this.prisma.sEOTask.count({
      where: { ...stats_qs, due_date: { lt: today }, NOT: { status: 'completed' } },
    });

    return {
      count: total,
      next: page * pageSize < total ? `/api/v1/seo-tasks/?page=${page + 1}` : null,
      previous: page > 1 ? `/api/v1/seo-tasks/?page=${page - 1}` : null,
      results: tasks,
      stats: {
        total: statsTotal,
        pending,
        in_progress,
        ready_for_review,
        completed,
        overdue,
        avg_completion_time: 0,
        avg_review_time: 0,
      },
    };
  }

  async createTask(user: any, data: any) {
    if (!this.isPrivileged(user)) {
      throw new ForbiddenException('Only SEO Managers and Admins can assign SEO tasks.');
    }

    const assignedExecId = Number(data.assigned_executive_id || data.assigned_executive);
    const execUser = await this.prisma.user.findUnique({ where: { id: assignedExecId } });

    const task = await this.prisma.sEOTask.create({
      data: {
        title: data.title,
        description: data.description,
        website_id: Number(data.website_id || data.website),
        assigned_executive_id: assignedExecId,
        due_date: new Date(data.due_date),
        priority: data.priority || 'medium',
        status: data.status || 'pending',
        activity_type_id: data.activity_type_id || data.activity_type ? Number(data.activity_type_id || data.activity_type) : null,
        created_by_id: user.id,
      },
      include: { website: true, assigned_executive: true, created_by: true },
    });

    await this.prisma.sEOTaskTimeline.create({
      data: {
        task_id: task.id,
        user_id: user.id,
        user_name: user.name || user.username,
        action: 'Task Assigned',
        remarks: `Assigned to ${execUser?.name || execUser?.username || 'Executive'}`,
      },
    });

    return task;
  }

  async updateTask(user: any, id: number, data: any) {
    const oldTask = await this.prisma.sEOTask.findUnique({ where: { id } });
    if (!oldTask) throw new NotFoundException('Task not found');

    const updateData: any = {};
    if (data.title !== undefined) updateData.title = data.title;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.website_id || data.website) updateData.website_id = Number(data.website_id || data.website);
    if (data.assigned_executive_id || data.assigned_executive) {
      updateData.assigned_executive_id = Number(data.assigned_executive_id || data.assigned_executive);
    }
    if (data.due_date) updateData.due_date = new Date(data.due_date);
    if (data.priority) updateData.priority = data.priority;
    if (data.status) updateData.status = data.status;

    const updatedTask = await this.prisma.sEOTask.update({
      where: { id },
      data: updateData,
      include: { website: true, assigned_executive: true },
    });

    if (updateData.assigned_executive_id && updateData.assigned_executive_id !== oldTask.assigned_executive_id) {
      const newExec = updatedTask.assigned_executive;
      await this.prisma.sEOTaskTimeline.create({
        data: {
          task_id: updatedTask.id,
          user_id: user.id,
          user_name: user.name || user.username,
          action: 'Task Reassigned',
          remarks: `Reassigned to ${newExec?.name || newExec?.username}`,
        },
      });
    }

    return updatedTask;
  }

  async deleteTask(user: any, id: number) {
    if (!this.isPrivileged(user)) {
      throw new ForbiddenException('Only SEO Managers and Admins can delete SEO tasks.');
    }
    return this.prisma.sEOTask.delete({ where: { id } });
  }

  async reviewTask(user: any, id: number, actionType: string, remarks?: string) {
    if (!this.isPrivileged(user)) {
      throw new ForbiddenException('Only SEO Managers and Admins can review tasks.');
    }
    const task = await this.prisma.sEOTask.findUnique({ where: { id } });
    if (!task) throw new NotFoundException('Task not found');

    const execName = user.name || user.username;

    if (actionType === 'approve') {
      await this.prisma.sEOTask.update({
        where: { id },
        data: {
          status: 'completed',
          review_status: 'approved',
          manager_remarks: remarks || null,
        },
      });
      await this.prisma.sEODailyWorkLog.updateMany({
        where: { seo_task_id: id, status: 'submitted' },
        data: {
          status: 'approved',
          approved_by_id: user.id,
          approved_date: new Date(),
        },
      });
      await this.prisma.sEOTaskTimeline.create({
        data: {
          task_id: id,
          user_id: user.id,
          user_name: execName,
          action: 'Manager Marked Task as Completed',
          remarks: remarks || 'Approved and completed by manager.',
        },
      });
      return { status: 'completed', review_status: 'approved' };
    } else if (actionType === 'reject') {
      await this.prisma.sEOTask.update({
        where: { id },
        data: {
          status: 'in_progress',
          review_status: 'rejected',
          manager_remarks: remarks || null,
        },
      });
      await this.prisma.sEODailyWorkLog.updateMany({
        where: { seo_task_id: id, status: 'submitted' },
        data: {
          status: 'rejected',
          rejected_by_id: user.id,
          rejected_date: new Date(),
          remarks_by_manager: remarks || null,
        },
      });
      await this.prisma.sEOTaskTimeline.create({
        data: {
          task_id: id,
          user_id: user.id,
          user_name: execName,
          action: 'Manager Returned Task to In Progress',
          remarks: remarks || 'Returned to in_progress by manager.',
        },
      });
      return { status: 'in_progress', review_status: 'rejected' };
    } else {
      throw new BadRequestException("Invalid action. Must be 'approve' or 'reject'.");
    }
  }

  async markTaskReadyForReview(user: any, id: number) {
    const task = await this.prisma.sEOTask.findUnique({ where: { id } });
    if (!task) throw new NotFoundException('Task not found');

    if (task.assigned_executive_id !== user.id && !this.isPrivileged(user)) {
      throw new ForbiddenException('You are not authorized to mark this task as ready for review.');
    }

    await this.prisma.sEOTask.update({
      where: { id },
      data: { status: 'ready_for_review', review_status: 'pending' },
    });

    await this.prisma.sEOTaskTimeline.create({
      data: {
        task_id: id,
        user_id: user.id,
        user_name: user.name || user.username,
        action: 'Marked Ready for Review',
        remarks: 'Task submitted by executive for manager review.',
      },
    });

    return { status: 'ready_for_review', review_status: 'pending' };
  }

  // -------------------------------------------------------------
  // 8. SEO REMINDERS
  // -------------------------------------------------------------
  async getReminders(user: any) {
    const where: any = {};
    if (this.isExecutive(user)) {
      where.assigned_executive_id = user.id;
    }
    return this.prisma.sEOReminder.findMany({
      where,
      include: { website: true, assigned_executive: true, created_by: true },
      orderBy: { due_date: 'asc' },
    });
  }

  async createReminder(user: any, data: any) {
    if (!this.isPrivileged(user)) {
      throw new ForbiddenException('Only SEO Managers and Admins can set SEO reminders.');
    }
    return this.prisma.sEOReminder.create({
      data: {
        title: data.title,
        description: data.description || null,
        website_id: Number(data.website_id || data.website),
        assigned_executive_id: Number(data.assigned_executive_id || data.assigned_executive),
        due_date: new Date(data.due_date),
        priority: data.priority || 'medium',
        status: data.status || 'pending',
        created_by_id: user.id,
      },
      include: { website: true, assigned_executive: true, created_by: true },
    });
  }

  async updateReminder(user: any, id: number, data: any) {
    return this.prisma.sEOReminder.update({
      where: { id },
      data: {
        status: data.status,
        title: data.title,
        description: data.description,
      },
      include: { website: true, assigned_executive: true },
    });
  }

  async deleteReminder(user: any, id: number) {
    return this.prisma.sEOReminder.delete({ where: { id } });
  }

  // -------------------------------------------------------------
  // 9. SEO CREDENTIALS
  // -------------------------------------------------------------
  async getCredentials(user: any) {
    const where: any = {};
    if (this.isExecutive(user)) {
      where.website = { assigned_executive_id: user.id };
    }
    const creds = await this.prisma.sEOCredential.findMany({
      where,
      include: { website: true },
      orderBy: [{ website_id: 'asc' }, { platform: 'asc' }],
    });

    return creds.map((c) => ({
      ...c,
      password: this.decryptPassword(c.password),
    }));
  }

  async createCredential(user: any, data: any) {
    if (!this.isPrivileged(user)) {
      throw new ForbiddenException('Only SEO Managers and Admins can create credentials.');
    }
    const cred = await this.prisma.sEOCredential.create({
      data: {
        website_id: Number(data.website_id || data.website),
        platform: data.platform,
        username: data.username,
        password: this.encryptPassword(data.password),
        notes: data.notes || null,
      },
      include: { website: true },
    });
    return { ...cred, password: data.password };
  }

  async updateCredential(user: any, id: number, data: any) {
    if (!this.isPrivileged(user)) {
      throw new ForbiddenException('Only SEO Managers and Admins can update credentials.');
    }
    const payload: any = {};
    if (data.platform) payload.platform = data.platform;
    if (data.username) payload.username = data.username;
    if (data.password) payload.password = this.encryptPassword(data.password);
    if (data.notes !== undefined) payload.notes = data.notes;

    const cred = await this.prisma.sEOCredential.update({
      where: { id },
      data: payload,
      include: { website: true },
    });
    return { ...cred, password: data.password || this.decryptPassword(cred.password) };
  }

  async deleteCredential(user: any, id: number) {
    if (!this.isPrivileged(user)) {
      throw new ForbiddenException('Only SEO Managers and Admins can delete credentials.');
    }
    return this.prisma.sEOCredential.delete({ where: { id } });
  }

  // -------------------------------------------------------------
  // HELPER: ENCRYPTION / DECRYPTION
  // -------------------------------------------------------------
  private encryptPassword(text: string): string {
    if (!text) return '';
    try {
      const cipher = crypto.createCipheriv(
        'aes-256-cbc',
        Buffer.from('12345678901234567890123456789012'),
        Buffer.from('1234567890123456'),
      );
      let encrypted = cipher.update(text, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      return encrypted;
    } catch {
      return text;
    }
  }

  private decryptPassword(text: string): string {
    if (!text) return '';
    try {
      const decipher = crypto.createDecipheriv(
        'aes-256-cbc',
        Buffer.from('12345678901234567890123456789012'),
        Buffer.from('1234567890123456'),
      );
      let decrypted = decipher.update(text, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch {
      return text;
    }
  }
}
