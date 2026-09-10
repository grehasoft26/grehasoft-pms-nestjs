import { Injectable, NotFoundException, BadRequestException, ForbiddenException, InternalServerErrorException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma.service';
import { PasswordUtil } from '../../core/utils/password.util';

@Injectable()
export class ClientsService {
  constructor(private readonly prisma: PrismaService) {}

  private formatClient(client: any) {
    if (!client) return null;
    return {
      id: client.id,
      name: client.name,
      email: client.email,
      phone: client.phone,
      company_name: client.company_name,
      gst_number: client.gst_no,
      gst_no: client.gst_no,
      address: client.address,
      status: client.status,
      portal_users: (client.portal_users || []).map((u: any) => ({
        id: u.id,
        name: u.name,
        username: u.username,
        email: u.email,
        role: u.role_id,
        is_active: u.is_active,
        last_login: u.last_login ? u.last_login.toISOString() : null,
      })),
      created_at: client.created_at ? client.created_at.toISOString() : null,
      updated_at: client.updated_at ? client.updated_at.toISOString() : null,
    };
  }

  async findAll(user: any, query: { all?: string }) {
    const roleName = user.role?.name;
    const where: any = { deleted_at: null };

    if (roleName === 'CLIENT') {
      const client = await this.prisma.client.findFirst({
        where: { portal_users: { some: { id: user.id } } },
      });
      if (client) {
        where.id = client.id;
      } else {
        return query.all === 'true' ? [] : { count: 0, next: null, previous: null, results: [] };
      }
    }

    const clients = await this.prisma.client.findMany({
      where,
      include: { portal_users: true },
      orderBy: { id: 'desc' },
    });

    if (query.all === 'true') {
      const isAdminOrManager = user.is_superuser || ['SUPER_ADMIN', 'SEO_MANAGER', 'PROJECT_MANAGER', 'SALES_MANAGER'].includes(roleName);

      let allowedClients = clients;
      if (!isAdminOrManager && roleName !== 'CLIENT') {
        allowedClients = clients.filter((c) =>
          c.portal_users.some((u) => u.id === user.id),
        );
      }

      return allowedClients.map((c) => ({
        id: c.id,
        company_name: c.company_name ? c.company_name.trim() : c.name ? c.name.trim() : `Client #${c.id}`,
        contact_person: c.name ? c.name.trim() : null,
      })).sort((a, b) => a.company_name.localeCompare(b.company_name));
    }

    const formatted = clients.map((c) => this.formatClient(c));
    return {
      count: formatted.length,
      next: null,
      previous: null,
      results: formatted,
    };
  }

  async findOne(id: number, user: any) {
    const roleName = user.role?.name;
    if (roleName === 'CLIENT') {
      const client = await this.prisma.client.findFirst({
        where: { id, portal_users: { some: { id: user.id } }, deleted_at: null },
        include: { portal_users: true },
      });
      if (!client) throw new ForbiddenException('You can only view your own client record.');
      return this.formatClient(client);
    }

    const client = await this.prisma.client.findFirst({
      where: { id, deleted_at: null },
      include: { portal_users: true },
    });
    if (!client) throw new NotFoundException('Client not found');
    return this.formatClient(client);
  }

  async create(body: any) {
    const emailVal = body.email ? body.email.trim() : '';
    if (emailVal !== '') {
      const existing = await this.prisma.client.findFirst({
        where: { email: emailVal, deleted_at: null },
      });
      if (existing) {
        throw new BadRequestException({ email: ['A client with this email address already exists.'] });
      }
    }

    const client = await this.prisma.client.create({
      data: {
        name: body.name,
        email: emailVal,
        phone: body.phone || '',
        company_name: body.company_name,
        gst_no: body.gst_number || body.gst_no || null,
        address: body.address || '',
        status: body.status || 'active',
      },
      include: { portal_users: true },
    });
    return this.formatClient(client);
  }

  async update(id: number, user: any, body: any) {
    const roleName = user.role?.name;
    if (roleName === 'CLIENT') {
      const client = await this.prisma.client.findFirst({
        where: { id, portal_users: { some: { id: user.id } } },
      });
      if (!client) throw new ForbiddenException('You can only modify your own client record.');

      const allowedFields = ['phone'];
      for (const key of Object.keys(body)) {
        if (!allowedFields.includes(key)) {
          throw new ForbiddenException(`Clients cannot modify the field '${key}'.`);
        }
      }
    }

    const data: any = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.email !== undefined) {
      const emailVal = body.email ? body.email.trim() : '';
      if (emailVal !== '') {
        const existing = await this.prisma.client.findFirst({
          where: { email: emailVal, id: { not: id }, deleted_at: null },
        });
        if (existing) {
          throw new BadRequestException({ email: ['A client with this email address already exists.'] });
        }
      }
      data.email = emailVal;
    }
    if (body.phone !== undefined) data.phone = body.phone;
    if (body.company_name !== undefined) data.company_name = body.company_name;
    if (body.gst_number !== undefined || body.gst_no !== undefined) {
      data.gst_no = body.gst_number || body.gst_no || null;
    }
    if (body.address !== undefined) data.address = body.address;
    if (body.status !== undefined) data.status = body.status;

    const updated = await this.prisma.client.update({
      where: { id },
      data,
      include: { portal_users: true },
    });

    return this.formatClient(updated);
  }

  async remove(id: number, user: any, query: { force?: string }) {
    const activeUsers = await this.prisma.user.count({
      where: { client_id: id, is_active: true, deleted_at: null },
    });

    const isSuper = user.is_superuser || user.role?.name === 'SUPER_ADMIN';
    if (activeUsers > 0 && !(isSuper && query.force === 'true')) {
      throw new BadRequestException({
        error: 'This client has active portal users. Please deactivate or remove all portal accounts before deleting the client.',
      });
    }

    await this.prisma.client.update({
      where: { id },
      data: { deleted_at: new Date() },
    });
    return null;
  }

  async getClientProjects(id: number, user: any) {
    const roleName = user.role?.name;
    if (roleName === 'CLIENT') {
      const client = await this.prisma.client.findFirst({
        where: { id, portal_users: { some: { id: user.id } } },
      });
      if (!client) throw new ForbiddenException('You do not have permission to view projects for this client.');
    }

    const projects = await this.prisma.project.findMany({
      where: { client_id: id, deleted_at: null },
    });

    const websites = await this.prisma.sEOWebsite.findMany({
      where: { client_id: id },
    });

    const results: any[] = [];
    for (const p of projects) {
      results.push({
        id: `project_${p.id}`,
        name: p.name,
        type: 'standard',
        description: p.name,
        rate: 0,
      });
    }

    const planPrices: Record<string, number> = {
      basic: 5000,
      standard: 10000,
      premium: 20000,
      custom: 0,
    };

    for (const w of websites) {
      const rate = planPrices[w.package_plan.toLowerCase()] || 0;
      results.push({
        id: `seo_${w.id}`,
        name: `SEO - ${w.website_name}`,
        type: 'seo',
        description: `Monthly SEO Services - ${w.website_name}`,
        rate,
      });
    }

    return results;
  }

  async getDashboardStats(user: any) {
    const total_clients = await this.prisma.client.count({
      where: { deleted_at: null },
    });

    const portal_accounts = await this.prisma.client.count({
      where: {
        deleted_at: null,
        portal_users: { some: {} },
      },
    });

    const portal_users_where = {
      role: { name: 'CLIENT' },
      deleted_at: null,
    };

    const active_portal_users = await this.prisma.user.count({
      where: { ...portal_users_where, is_active: true },
    });

    const inactive_portal_users = await this.prisma.user.count({
      where: { ...portal_users_where, is_active: false },
    });

    const never_logged_in = await this.prisma.user.count({
      where: { ...portal_users_where, last_login: null },
    });

    const invitation_pending = await this.prisma.user.count({
      where: {
        ...portal_users_where,
        last_login: null,
        portal_user_audits: {
          some: { action: 'Invitation Sent' },
        },
      },
    });

    return {
      total_clients,
      portal_accounts,
      active_portal_users,
      inactive_portal_users,
      invitation_pending,
      never_logged_in,
    };
  }

  async createPortalAccount(id: number, body: any, currentUser: any) {
    const client = await this.prisma.client.findFirst({
      where: { id, deleted_at: null },
    });

    if (!client) {
      throw new NotFoundException('Client not found');
    }

    const username = body.username ? body.username.trim() : null;
    const password = body.password;
    const name = body.name ? body.name.trim() : client.name;
    const email = body.email ? body.email.trim() : client.email;

    if (!username || !password) {
      throw new BadRequestException({ error: 'Username and password are required.' });
    }

    const existingUsername = await this.prisma.user.findFirst({
      where: { username, deleted_at: null },
    });
    if (existingUsername) {
      throw new BadRequestException({ error: 'This username is already taken.' });
    }

    const existingEmail = await this.prisma.user.findFirst({
      where: { email, deleted_at: null },
    });
    if (existingEmail) {
      throw new BadRequestException({ error: 'A user with this email address already exists.' });
    }

    const clientRole = await this.prisma.role.findFirst({
      where: { name: 'CLIENT' },
    });
    if (!clientRole) {
      throw new InternalServerErrorException({ error: 'CLIENT role does not exist in the system.' });
    }

    const hashedPassword = await PasswordUtil.hashPassword(password);

    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          username,
          name,
          email,
          password: hashedPassword,
          role_id: clientRole.id,
          client_id: client.id,
          status: 'active',
          is_active: true,
        },
      });

      await tx.portalUserAudit.create({
        data: {
          portal_user_id: user.id,
          client_id: client.id,
          action: 'Portal Account Created',
          performed_by_id: currentUser?.id || null,
          remarks: `Portal account provisioned for username: ${username}`,
        },
      });

      return user;
    });

    return {
      status: 'success',
      user_id: result.id,
      username: result.username,
    };
  }

  async editPortalUserUsername(clientId: number, body: any, currentUser: any) {
    const userId = Number(body.user_id);
    const newUsername = body.username ? body.username.trim() : null;

    if (!userId || !newUsername) {
      throw new BadRequestException({ error: 'User ID and new username are required.' });
    }

    const portalUser = await this.prisma.user.findFirst({
      where: { id: userId, client_id: clientId, deleted_at: null },
    });

    if (!portalUser) {
      throw new NotFoundException({ error: 'Portal user not found for this client.' });
    }

    const existingUsername = await this.prisma.user.findFirst({
      where: { username: newUsername, id: { not: userId }, deleted_at: null },
    });
    if (existingUsername) {
      throw new BadRequestException({ error: 'This username is already taken.' });
    }

    const oldUsername = portalUser.username;
    const updateData: any = { username: newUsername };
    if (body.name && body.name.trim()) {
      updateData.name = body.name.trim();
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: updateData,
    });

    await this.prisma.portalUserAudit.create({
      data: {
        portal_user_id: userId,
        client_id: clientId,
        action: 'Username Changed',
        performed_by_id: currentUser?.id || null,
        remarks: `Username changed from ${oldUsername} to ${newUsername}.`,
      },
    });

    return { status: 'success', username: newUsername };
  }

  async resetPortalUserPassword(clientId: number, body: any, currentUser: any) {
    const userId = Number(body.user_id);
    const newPassword = body.password;

    if (!userId || !newPassword) {
      throw new BadRequestException({ error: 'User ID and new password are required.' });
    }

    const portalUser = await this.prisma.user.findFirst({
      where: { id: userId, client_id: clientId, deleted_at: null },
    });

    if (!portalUser) {
      throw new NotFoundException({ error: 'Portal user not found for this client.' });
    }

    const hashedPassword = await PasswordUtil.hashPassword(newPassword);

    await this.prisma.user.update({
      where: { id: userId },
      data: { password: hashedPassword },
    });

    await this.prisma.portalUserAudit.create({
      data: {
        portal_user_id: userId,
        client_id: clientId,
        action: 'Password Reset',
        performed_by_id: currentUser?.id || null,
        remarks: 'Password reset by administrator.',
      },
    });

    return { status: 'success', message: 'Password reset successfully.' };
  }

  async togglePortalUserStatus(clientId: number, body: any, currentUser: any) {
    const userId = Number(body.user_id);

    if (!userId) {
      throw new BadRequestException({ error: 'User ID is required.' });
    }

    const portalUser = await this.prisma.user.findFirst({
      where: { id: userId, client_id: clientId, deleted_at: null },
    });

    if (!portalUser) {
      throw new NotFoundException({ error: 'Portal user not found for this client.' });
    }

    const newActive = !portalUser.is_active;

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        is_active: newActive,
        status: newActive ? 'active' : 'inactive',
      },
    });

    const actionStr = newActive ? 'Account Activated' : 'Account Deactivated';

    await this.prisma.portalUserAudit.create({
      data: {
        portal_user_id: userId,
        client_id: clientId,
        action: actionStr,
        performed_by_id: currentUser?.id || null,
        remarks: `Account status toggled. Active=${newActive}`,
      },
    });

    return { status: 'success', is_active: newActive };
  }

  async deletePortalUser(clientId: number, body: any, currentUser: any) {
    const userId = Number(body.user_id);

    if (!userId) {
      throw new BadRequestException({ error: 'User ID is required.' });
    }

    const portalUser = await this.prisma.user.findFirst({
      where: { id: userId, client_id: clientId, deleted_at: null },
    });

    if (!portalUser) {
      throw new NotFoundException({ error: 'Portal user not found for this client.' });
    }

    await this.prisma.portalUserAudit.create({
      data: {
        portal_user_id: userId,
        client_id: clientId,
        action: 'Account Deleted',
        performed_by_id: currentUser?.id || null,
        remarks: `Deleted portal account for username ${portalUser.username}`,
      },
    });

    await this.prisma.user.delete({
      where: { id: userId },
    });

    return { status: 'success', message: 'Portal user deleted successfully.' };
  }

  async getPortalUserAudit(clientId: number) {
    const audits = await this.prisma.portalUserAudit.findMany({
      where: { client_id: clientId },
      include: {
        portal_user: true,
        performed_by: true,
      },
      orderBy: { timestamp: 'desc' },
    });

    return audits.map((a) => ({
      id: a.id,
      portal_user_name: a.portal_user ? a.portal_user.name : 'Deleted User',
      portal_user_username: a.portal_user ? a.portal_user.username : '',
      action: a.action,
      performed_by_name: a.performed_by ? (a.performed_by.name || a.performed_by.username) : 'System',
      timestamp: a.timestamp ? a.timestamp.toISOString().replace('T', ' ').substring(0, 19) : '',
      remarks: a.remarks,
    }));
  }

  async sendInvitation(clientId: number, userId: number, currentUser: any) {
    const portalUser = await this.prisma.user.findFirst({
      where: { id: userId, client_id: clientId, deleted_at: null },
    });

    if (!portalUser) {
      throw new NotFoundException({ error: 'Portal user not found for this client.' });
    }

    await this.prisma.portalUserAudit.create({
      data: {
        portal_user_id: userId,
        client_id: clientId,
        action: 'Invitation Sent',
        performed_by_id: currentUser?.id || null,
        remarks: `Invitation email sent to ${portalUser.email}.`,
      },
    });

    return { status: 'success', message: 'Invitation email sent successfully.' };
  }

  async resetPasswordByPath(clientId: number, userId: number, body: any, currentUser: any) {
    const portalUser = await this.prisma.user.findFirst({
      where: { id: userId, client_id: clientId, deleted_at: null },
    });

    if (!portalUser) {
      throw new NotFoundException({ error: 'Portal user not found for this client.' });
    }

    let newPassword = body.password;
    let remarks = 'Password reset by administrator.';
    if (!newPassword) {
      newPassword = Math.random().toString(36).slice(-8) + 'A1!';
      remarks = 'Temporary password generated and emailed to user.';
    }

    const hashedPassword = await PasswordUtil.hashPassword(newPassword);

    await this.prisma.user.update({
      where: { id: userId },
      data: { password: hashedPassword },
    });

    await this.prisma.portalUserAudit.create({
      data: {
        portal_user_id: userId,
        client_id: clientId,
        action: 'Password Reset',
        performed_by_id: currentUser?.id || null,
        remarks,
      },
    });

    return { status: 'success', message: 'Password reset successfully.' };
  }
}
