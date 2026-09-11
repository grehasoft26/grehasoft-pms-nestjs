import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma.service';
import * as crypto from 'crypto';

@Injectable()
export class InfrastructureService {
  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------
  // HELPER: ROLE CHECKS & PROJECT SCOPING
  // -------------------------------------------------------------
  private isAdmin(user: any): boolean {
    const role = user.role?.name || user.role_name;
    return user.is_superuser || role === 'SUPER_ADMIN';
  }

  private async getAccessibleProjectIds(user: any): Promise<number[]> {
    if (this.isAdmin(user)) return [];
    const members = await this.prisma.projectMember.findMany({
      where: { user_id: user.id },
      select: { project_id: true },
    });
    return members.map((m) => m.project_id);
  }

  // -------------------------------------------------------------
  // 1. SERVERS
  // -------------------------------------------------------------
  async getServers(user: any, query: { page?: string; limit?: string; search?: string; all?: string } = {}) {
    const where: any = {};

    if (!this.isAdmin(user)) {
      const projectIds = await this.getAccessibleProjectIds(user);
      if (projectIds.length === 0) {
        return query.all === 'true' ? [] : { count: 0, next: null, previous: null, results: [] };
      }
      where.domains = {
        some: {
          project_id: { in: projectIds },
        },
      };
    }

    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { provider: { contains: query.search, mode: 'insensitive' } },
        { ip_address: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    if (query.all === 'true') {
      const servers = await this.prisma.server.findMany({
        where,
        orderBy: { name: 'asc' },
      });
      return servers;
    }

    const pageNum = Math.max(1, Number(query.page) || 1);
    const limitNum = Math.max(1, Number(query.limit) || 5);
    const skip = (pageNum - 1) * limitNum;

    const count = await this.prisma.server.count({ where });

    const results = await this.prisma.server.findMany({
      where,
      orderBy: { id: 'desc' },
      skip,
      take: limitNum,
    });

    return {
      count,
      next: pageNum * limitNum < count ? `/api/infrastructure/servers?page=${pageNum + 1}` : null,
      previous: pageNum > 1 ? `/api/infrastructure/servers?page=${pageNum - 1}` : null,
      results,
    };
  }

  async getServerById(user: any, id: number) {
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (!server) throw new NotFoundException('Server not found');
    return server;
  }

  async createServer(user: any, data: any) {
    return this.prisma.server.create({
      data: {
        name: data.name,
        provider: data.provider || '',
        owner: data.owner || '',
        server_ip: data.server_ip || '',
        ip_address: data.ip_address || '',
        notes: data.notes || '',
      },
    });
  }

  async updateServer(user: any, id: number, data: any) {
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (!server) throw new NotFoundException('Server not found');

    return this.prisma.server.update({
      where: { id },
      data: {
        name: data.name,
        provider: data.provider,
        owner: data.owner,
        server_ip: data.server_ip,
        ip_address: data.ip_address,
        notes: data.notes,
      },
    });
  }

  async deleteServer(user: any, id: number) {
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (!server) throw new NotFoundException('Server not found');
    return this.prisma.server.delete({ where: { id } });
  }

  // -------------------------------------------------------------
  // 2. DOMAINS
  // -------------------------------------------------------------
  async getDomains(user: any, query: { page?: string; limit?: string; search?: string; all?: string } | string = {}) {
    const queryObj = typeof query === 'string' ? { search: query } : query;
    const where: any = {};

    if (!this.isAdmin(user)) {
      const projectIds = await this.getAccessibleProjectIds(user);
      if (projectIds.length === 0) {
        return queryObj.all === 'true' ? [] : { count: 0, next: null, previous: null, results: [] };
      }
      where.project_id = { in: projectIds };
    }

    const search = queryObj.search;
    if (search) {
      where.OR = [
        { domain_name: { contains: search, mode: 'insensitive' } },
        { provider: { contains: search, mode: 'insensitive' } },
        { project: { name: { contains: search, mode: 'insensitive' } } },
      ];
    }

    if (queryObj.all === 'true') {
      const domains = await this.prisma.domain.findMany({
        where,
        include: {
          project: { select: { id: true, name: true } },
          server: { select: { id: true, name: true } },
        },
        orderBy: { expiry_date: 'desc' },
      });

      return domains.map((d) => ({
        ...d,
        project: d.project_id,
        server: d.server_id,
        project_name: d.project?.name || null,
        server_name: d.server?.name || null,
      }));
    }

    const pageNum = Math.max(1, Number(queryObj.page) || 1);
    const limitNum = Math.max(1, Number(queryObj.limit) || 5);
    const skip = (pageNum - 1) * limitNum;

    const count = await this.prisma.domain.count({ where });

    const domains = await this.prisma.domain.findMany({
      where,
      include: {
        project: { select: { id: true, name: true } },
        server: { select: { id: true, name: true } },
      },
      orderBy: { id: 'desc' },
      skip,
      take: limitNum,
    });

    const formatted = domains.map((d) => ({
      ...d,
      project: d.project_id,
      server: d.server_id,
      project_name: d.project?.name || null,
      server_name: d.server?.name || null,
    }));

    return {
      count,
      next: pageNum * limitNum < count ? `/api/infrastructure/domains?page=${pageNum + 1}` : null,
      previous: pageNum > 1 ? `/api/infrastructure/domains?page=${pageNum - 1}` : null,
      results: formatted,
    };
  }

  async getDomainById(user: any, id: number) {
    const domain = await this.prisma.domain.findUnique({
      where: { id },
      include: {
        project: { select: { id: true, name: true } },
        server: { select: { id: true, name: true } },
      },
    });
    if (!domain) throw new NotFoundException('Domain not found');

    return {
      ...domain,
      project: domain.project_id,
      server: domain.server_id,
      project_name: domain.project?.name || null,
      server_name: domain.server?.name || null,
    };
  }

  async createDomain(user: any, data: any) {
    const expiryDate = data.expiry_date ? new Date(data.expiry_date) : null;

    const domain = await this.prisma.domain.create({
      data: {
        project_id: Number(data.project_id || data.project),
        domain_name: data.domain_name,
        provider: data.provider || '',
        purchase_date: data.purchase_date ? new Date(data.purchase_date) : null,
        expiry_date: expiryDate,
        renewal_cost: data.renewal_cost ? Number(data.renewal_cost) : null,
        server_id: data.server_id || data.server ? Number(data.server_id || data.server) : null,
        notes: data.notes || '',
      },
      include: { project: true, server: true },
    });

    if (expiryDate) {
      await this.scheduleRenewalReminder(user, domain.domain_name, expiryDate);
    }

    return {
      ...domain,
      project: domain.project_id,
      server: domain.server_id,
      project_name: domain.project?.name || null,
      server_name: domain.server?.name || null,
    };
  }

  async updateDomain(user: any, id: number, data: any) {
    const existing = await this.prisma.domain.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Domain not found');

    const expiryDate = data.expiry_date !== undefined ? (data.expiry_date ? new Date(data.expiry_date) : null) : existing.expiry_date;

    const domain = await this.prisma.domain.update({
      where: { id },
      data: {
        project_id: data.project_id || data.project ? Number(data.project_id || data.project) : undefined,
        domain_name: data.domain_name,
        provider: data.provider,
        purchase_date: data.purchase_date !== undefined ? (data.purchase_date ? new Date(data.purchase_date) : null) : undefined,
        expiry_date: expiryDate,
        renewal_cost: data.renewal_cost !== undefined ? (data.renewal_cost ? Number(data.renewal_cost) : null) : undefined,
        server_id: data.server_id !== undefined ? (data.server_id || data.server ? Number(data.server_id || data.server) : null) : undefined,
        notes: data.notes,
      },
      include: { project: true, server: true },
    });

    if (expiryDate) {
      await this.scheduleRenewalReminder(user, domain.domain_name, expiryDate);
    }

    return {
      ...domain,
      project: domain.project_id,
      server: domain.server_id,
      project_name: domain.project?.name || null,
      server_name: domain.server?.name || null,
    };
  }

  async deleteDomain(user: any, id: number) {
    const domain = await this.prisma.domain.findUnique({ where: { id } });
    if (!domain) throw new NotFoundException('Domain not found');
    return this.prisma.domain.delete({ where: { id } });
  }

  private async scheduleRenewalReminder(user: any, domainName: string, expiryDate: Date) {
    const due_date = new Date(expiryDate.getTime() - 30 * 24 * 60 * 60 * 1000);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (due_date > today) {
      await this.prisma.reminder.create({
        data: {
          user_id: user.id,
          title: `Domain Renewal: ${domainName}`,
          description: 'Renew domain before expiry',
          due_date,
          type: 'general',
        },
      });
    }
  }

  // -------------------------------------------------------------
  // 3. WEBSITE CREDENTIALS
  private formatCredential(c: any, isAdm: boolean) {
    const res: any = {
      ...c,
      project: c.project_id,
      domain: c.domain_id,
      project_name: c.project?.name || null,
      domain_name: c.domain?.domain_name || null,
    };

    if (!isAdm) {
      if (res.admin_password) res.admin_password = '••••••••';
      if (res.cpanel_password) res.cpanel_password = '••••••••';
      if (res.ftp_password) res.ftp_password = '••••••••';
      if (res.client_email_password) res.client_email_password = '••••••••';
      if (res.business_email_password) res.business_email_password = '••••••••';
    } else {
      if (res.admin_password) res.admin_password = this.decryptPassword(res.admin_password);
      if (res.cpanel_password) res.cpanel_password = this.decryptPassword(res.cpanel_password);
      if (res.ftp_password) res.ftp_password = this.decryptPassword(res.ftp_password);
      if (res.client_email_password) res.client_email_password = this.decryptPassword(res.client_email_password);
      if (res.business_email_password) res.business_email_password = this.decryptPassword(res.business_email_password);
    }

    return res;
  }

  // -------------------------------------------------------------
  // 3. WEBSITE CREDENTIALS
  // -------------------------------------------------------------
  async getCredentials(user: any, query: { page?: string; limit?: string; search?: string; all?: string } = {}) {
    const where: any = {};

    if (!this.isAdmin(user)) {
      const projectIds = await this.getAccessibleProjectIds(user);
      if (projectIds.length === 0) {
        return query.all === 'true' ? [] : { count: 0, next: null, previous: null, results: [] };
      }
      where.project_id = { in: projectIds };
    }

    if (query.search) {
      where.OR = [
        { url: { contains: query.search, mode: 'insensitive' } },
        { username: { contains: query.search, mode: 'insensitive' } },
        { project: { name: { contains: query.search, mode: 'insensitive' } } },
      ];
    }

    const isAdm = this.isAdmin(user);

    if (query.all === 'true') {
      const credentials = await this.prisma.websiteCredential.findMany({
        where,
        include: {
          project: { select: { id: true, name: true } },
          domain: { select: { id: true, domain_name: true } },
        },
        orderBy: { created_at: 'desc' },
      });

      return credentials.map((c) => this.formatCredential(c, isAdm));
    }

    const pageNum = Math.max(1, Number(query.page) || 1);
    const limitNum = Math.max(1, Number(query.limit) || 5);
    const skip = (pageNum - 1) * limitNum;

    const count = await this.prisma.websiteCredential.count({ where });

    const credentials = await this.prisma.websiteCredential.findMany({
      where,
      include: {
        project: { select: { id: true, name: true } },
        domain: { select: { id: true, domain_name: true } },
      },
      orderBy: { id: 'desc' },
      skip,
      take: limitNum,
    });

    const formatted = credentials.map((c) => this.formatCredential(c, isAdm));

    return {
      count,
      next: pageNum * limitNum < count ? `/api/infrastructure/credentials?page=${pageNum + 1}` : null,
      previous: pageNum > 1 ? `/api/infrastructure/credentials?page=${pageNum - 1}` : null,
      results: formatted,
    };
  }

  async getCredentialById(user: any, id: number) {
    const c = await this.prisma.websiteCredential.findUnique({
      where: { id },
      include: {
        project: { select: { id: true, name: true } },
        domain: { select: { id: true, domain_name: true } },
      },
    });
    if (!c) throw new NotFoundException('Credential not found');

    const isAdm = this.isAdmin(user);
    const res: any = {
      ...c,
      project: c.project_id,
      domain: c.domain_id,
      project_name: c.project?.name || null,
      domain_name: c.domain?.domain_name || null,
    };

    if (!isAdm) {
      if (res.admin_password) res.admin_password = '••••••••';
      if (res.cpanel_password) res.cpanel_password = '••••••••';
      if (res.ftp_password) res.ftp_password = '••••••••';
      if (res.client_email_password) res.client_email_password = '••••••••';
      if (res.business_email_password) res.business_email_password = '••••••••';
    } else {
      if (res.admin_password) res.admin_password = this.decryptPassword(res.admin_password);
      if (res.cpanel_password) res.cpanel_password = this.decryptPassword(res.cpanel_password);
      if (res.ftp_password) res.ftp_password = this.decryptPassword(res.ftp_password);
      if (res.client_email_password) res.client_email_password = this.decryptPassword(res.client_email_password);
      if (res.business_email_password) res.business_email_password = this.decryptPassword(res.business_email_password);
    }

    return res;
  }

  async createCredential(user: any, data: any) {
    const cred = await this.prisma.websiteCredential.create({
      data: {
        project_id: Number(data.project_id || data.project),
        domain_id: Number(data.domain_id || data.domain),
        admin_url: data.admin_url || '',
        admin_username: data.admin_username || '',
        admin_password: data.admin_password ? this.encryptPassword(data.admin_password) : '',
        cpanel_url: data.cpanel_url || '',
        cpanel_username: data.cpanel_username || '',
        cpanel_password: data.cpanel_password ? this.encryptPassword(data.cpanel_password) : '',
        ftp_host: data.ftp_host || '',
        ftp_username: data.ftp_username || '',
        ftp_password: data.ftp_password ? this.encryptPassword(data.ftp_password) : '',
        contact_form_email: data.contact_form_email || '',
        client_email: data.client_email || '',
        client_email_password: data.client_email_password ? this.encryptPassword(data.client_email_password) : '',
        business_email: data.business_email || null,
        business_email_password: data.business_email_password ? this.encryptPassword(data.business_email_password) : null,
        business_email_type: data.business_email_type || null,
        notes: data.notes || '',
      },
      include: { project: true, domain: true },
    });

    return {
      ...cred,
      project: cred.project_id,
      domain: cred.domain_id,
      project_name: cred.project?.name || null,
      domain_name: cred.domain?.domain_name || null,
      admin_password: data.admin_password || '',
      cpanel_password: data.cpanel_password || '',
      ftp_password: data.ftp_password || '',
      client_email_password: data.client_email_password || '',
      business_email_password: data.business_email_password || '',
    };
  }

  async updateCredential(user: any, id: number, data: any) {
    const existing = await this.prisma.websiteCredential.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Credential not found');

    const cred = await this.prisma.websiteCredential.update({
      where: { id },
      data: {
        project_id: data.project_id || data.project ? Number(data.project_id || data.project) : undefined,
        domain_id: data.domain_id || data.domain ? Number(data.domain_id || data.domain) : undefined,
        admin_url: data.admin_url,
        admin_username: data.admin_username,
        admin_password: data.admin_password !== undefined ? (data.admin_password ? this.encryptPassword(data.admin_password) : '') : undefined,
        cpanel_url: data.cpanel_url,
        cpanel_username: data.cpanel_username,
        cpanel_password: data.cpanel_password !== undefined ? (data.cpanel_password ? this.encryptPassword(data.cpanel_password) : '') : undefined,
        ftp_host: data.ftp_host,
        ftp_username: data.ftp_username,
        ftp_password: data.ftp_password !== undefined ? (data.ftp_password ? this.encryptPassword(data.ftp_password) : '') : undefined,
        contact_form_email: data.contact_form_email,
        client_email: data.client_email,
        client_email_password: data.client_email_password !== undefined ? (data.client_email_password ? this.encryptPassword(data.client_email_password) : '') : undefined,
        business_email: data.business_email,
        business_email_password: data.business_email_password !== undefined ? (data.business_email_password ? this.encryptPassword(data.business_email_password) : null) : undefined,
        business_email_type: data.business_email_type,
        notes: data.notes,
      },
      include: { project: true, domain: true },
    });

    return {
      ...cred,
      project: cred.project_id,
      domain: cred.domain_id,
      project_name: cred.project?.name || null,
      domain_name: cred.domain?.domain_name || null,
    };
  }

  async deleteCredential(user: any, id: number) {
    const cred = await this.prisma.websiteCredential.findUnique({ where: { id } });
    if (!cred) throw new NotFoundException('Credential not found');
    return this.prisma.websiteCredential.delete({ where: { id } });
  }

  // -------------------------------------------------------------
  // ENCRYPTION HELPERS
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
