import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma.service';
import { formatUserResponse } from '../users/user.serializer';

@Injectable()
export class LeadsService {
  constructor(private readonly prisma: PrismaService) {}

  private formatLead(l: any) {
    if (!l) return null;
    return {
      id: l.id,
      name: l.name || '',
      email: l.email || '',
      phone: l.phone || '',
      source: l.source || 'Website',
      status: l.status || 'new',
      client: l.client_id,
      client_name: l.client ? l.client.name : null,
      converted_project: l.converted_project_id,
      converted_project_name: l.converted_project ? l.converted_project.name : null,
      enquiry_from: l.enquiry_from || null,
      how_contacted: l.how_contacted || null,
      contacted_person: l.contacted_person || null,
      reference_person: l.reference_person || null,
      company_name: l.company_name || null,
      service_required: Array.isArray(l.service_required) ? l.service_required : [],
      client_requirements: l.client_requirements || null,
      details_given: l.details_given || null,
      competitor_websites: l.competitor_websites || null,
      documents_given: Array.isArray(l.documents_given) ? l.documents_given : [],
      login_credentials: Array.isArray(l.login_credentials) ? l.login_credentials : [],
      followups: (l.followups || []).map((f: any) => ({
        id: f.id,
        lead: f.lead_id,
        followup_type: f.followup_type,
        notes: f.notes,
        next_followup: f.next_followup ? f.next_followup.toISOString().split('T')[0] : null,
        status: f.status,
        created_by: f.created_by_id,
        created_by_name: f.created_by ? f.created_by.name || f.created_by.username : 'User',
        created_at: f.created_at ? f.created_at.toISOString() : null,
      })),
      assignments: (l.assignments || []).map((a: any) => ({
        id: a.id,
        lead: a.lead_id,
        sales_exec: a.sales_exec_id,
        assigned_at: a.assigned_at ? a.assigned_at.toISOString() : null,
        sales_exec_details: a.sales_exec ? formatUserResponse(a.sales_exec) : null,
      })),
      created_at: l.created_at ? l.created_at.toISOString() : null,
      updated_at: l.updated_at ? l.updated_at.toISOString() : null,
    };
  }

  async findAll(user: any, query: { status?: string; search?: string; all?: string }) {
    const roleName = user.role?.name;
    const where: any = { deleted_at: null };

    if (query.status) {
      where.status = query.status;
    }

    if (query.search) {
      where.OR = [
        { name: { contains: query.search } },
        { company_name: { contains: query.search } },
        { email: { contains: query.search } },
        { phone: { contains: query.search } },
      ];
    }

    if (roleName !== 'SUPER_ADMIN' && roleName !== 'SALES_MANAGER' && !user.is_superuser) {
      where.assignments = {
        some: {
          sales_exec_id: user.id,
        },
      };
    }

    const leads = await this.prisma.lead.findMany({
      where,
      include: {
        client: true,
        converted_project: true,
        followups: { include: { created_by: true } },
        assignments: {
          include: { sales_exec: { include: { role: true, department: true, client: true } } },
        },
      },
      orderBy: { id: 'desc' },
    });

    const formatted = leads.map((l) => this.formatLead(l));

    if (query.all === 'true') {
      return formatted;
    }

    return {
      count: formatted.length,
      next: null,
      previous: null,
      results: formatted,
    };
  }

  async findOne(id: number, user: any) {
    const lead = await this.prisma.lead.findFirst({
      where: { id, deleted_at: null },
      include: {
        client: true,
        converted_project: true,
        followups: { include: { created_by: true } },
        assignments: {
          include: { sales_exec: { include: { role: true, department: true, client: true } } },
        },
      },
    });

    if (!lead) throw new NotFoundException('Lead not found');

    return this.formatLead(lead);
  }

  async create(user: any, body: any) {
    const roleName = user.role?.name;
    if (roleName === 'CLIENT') {
      throw new ForbiddenException('Clients do not have permission to modify lead data.');
    }

    const companyName = (body.company_name || body.name || 'Unnamed Lead').trim();

    const lead = await this.prisma.lead.create({
      data: {
        name: body.name || '',
        email: body.email || '',
        phone: body.phone || '',
        source: body.source || 'Website',
        status: body.status || 'new',
        client_id: body.client ? Number(body.client) : null,
        enquiry_from: body.enquiry_from || null,
        how_contacted: body.how_contacted || null,
        contacted_person: body.contacted_person || null,
        reference_person: body.reference_person || null,
        company_name: companyName,
        service_required: Array.isArray(body.service_required) ? body.service_required : [],
        client_requirements: body.client_requirements || null,
        details_given: body.details_given || null,
        competitor_websites: body.competitor_websites || null,
        documents_given: Array.isArray(body.documents_given) ? body.documents_given : [],
        login_credentials: Array.isArray(body.login_credentials) ? body.login_credentials : [],
      },
      include: {
        client: true,
        converted_project: true,
        followups: { include: { created_by: true } },
        assignments: {
          include: { sales_exec: { include: { role: true, department: true, client: true } } },
        },
      },
    });

    return this.formatLead(lead);
  }

  async update(id: number, user: any, body: any) {
    const roleName = user.role?.name;
    if (roleName === 'CLIENT') {
      throw new ForbiddenException('Clients do not have permission to modify lead data.');
    }

    await this.findOne(id, user);

    const data: any = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.email !== undefined) data.email = body.email;
    if (body.phone !== undefined) data.phone = body.phone;
    if (body.source !== undefined) data.source = body.source;
    if (body.status !== undefined) data.status = body.status;
    if (body.client !== undefined) data.client_id = body.client ? Number(body.client) : null;
    if (body.enquiry_from !== undefined) data.enquiry_from = body.enquiry_from;
    if (body.how_contacted !== undefined) data.how_contacted = body.how_contacted;
    if (body.contacted_person !== undefined) data.contacted_person = body.contacted_person;
    if (body.reference_person !== undefined) data.reference_person = body.reference_person;
    if (body.company_name !== undefined) data.company_name = body.company_name;
    if (body.service_required !== undefined) {
      data.service_required = Array.isArray(body.service_required) ? body.service_required : [];
    }
    if (body.client_requirements !== undefined) data.client_requirements = body.client_requirements;
    if (body.details_given !== undefined) data.details_given = body.details_given;
    if (body.competitor_websites !== undefined) data.competitor_websites = body.competitor_websites;
    if (body.documents_given !== undefined) {
      data.documents_given = Array.isArray(body.documents_given) ? body.documents_given : [];
    }
    if (body.login_credentials !== undefined) {
      data.login_credentials = Array.isArray(body.login_credentials) ? body.login_credentials : [];
    }

    const updated = await this.prisma.lead.update({
      where: { id },
      data,
      include: {
        client: true,
        converted_project: true,
        followups: { include: { created_by: true } },
        assignments: {
          include: { sales_exec: { include: { role: true, department: true, client: true } } },
        },
      },
    });

    return this.formatLead(updated);
  }

  async remove(id: number, user: any) {
    const roleName = user.role?.name;
    if (roleName === 'CLIENT') {
      throw new ForbiddenException('Clients do not have permission to modify lead data.');
    }

    await this.findOne(id, user);

    await this.prisma.lead.update({
      where: { id },
      data: { deleted_at: new Date() },
    });

    return null;
  }

  async convertToProject(id: number, user: any, body: any) {
    const roleName = user.role?.name;
    if (roleName === 'CLIENT') {
      throw new ForbiddenException('Clients do not have permission to modify lead data.');
    }

    const lead = await this.prisma.lead.findFirst({
      where: { id, deleted_at: null },
      include: { client: true },
    });

    if (!lead) throw new NotFoundException('Lead not found');

    if (lead.status === 'converted') {
      throw new BadRequestException({ error: 'Lead already converted' });
    }

    let client = lead.client;
    if (!client) {
      // Find active client or create
      client = await this.prisma.client.findFirst({
        where: { email: lead.email, deleted_at: null },
      });

      if (!client) {
        client = await this.prisma.client.create({
          data: {
            name: lead.name || 'Converted Lead',
            email: lead.email || `client_${Date.now()}@example.com`,
            phone: lead.phone || '',
            company_name: lead.company_name || lead.name || 'Converted Company',
            address: body.client_address || '',
            status: 'active',
          },
        });
      }

      await this.prisma.lead.update({
        where: { id },
        data: { client_id: client.id },
      });
    }

    // Create project
    const project = await this.prisma.project.create({
      data: {
        name: body.name || `Project - ${lead.company_name || lead.name}`,
        client_id: client.id,
        department_id: body.department ? Number(body.department) : null,
        project_manager_id: body.project_manager ? Number(body.project_manager) : null,
        created_by_id: user.id,
        start_date: new Date(body.start_date || new Date()),
        end_date: new Date(body.end_date || new Date(Date.now() + 30 * 86400000)),
        status: body.status || 'not_started',
        progress_percentage: body.progress_percentage || 0,
      },
    });

    await this.prisma.lead.update({
      where: { id },
      data: {
        status: 'converted',
        converted_project_id: project.id,
      },
    });

    return {
      message: 'Lead converted successfully',
      project_id: project.id,
    };
  }
}
