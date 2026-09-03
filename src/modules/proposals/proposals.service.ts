import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma.service';
import { PdfService } from '../../core/pdf.service';
import { MailerService } from '../../core/mailer.service';
import { formatUserResponse } from '../users/user.serializer';

@Injectable()
export class ProposalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdfService: PdfService,
    private readonly mailerService: MailerService,
  ) {}

  private formatProposal(p: any) {
    if (!p) return null;
    return {
      id: p.id,
      lead: p.lead_id,
      leadId: p.lead_id,
      leadName: p.lead ? p.lead.name : null,
      leadEmail: p.lead ? p.lead.email : null,
      leadPhone: p.lead ? p.lead.phone : null,
      title: p.title,
      description: p.description || '',
      project_overview: p.project_overview || '',
      subtotal: p.subtotal ? Number(p.subtotal) : 0,
      discount: p.discount ? Number(p.discount) : 0,
      amount: p.amount ? Number(p.amount) : 0,
      status: p.status || 'draft',
      client: p.client_id,
      project: p.project_id,
      is_converted: p.is_converted || false,
      builder_config: p.builder_config || {},
      created_at: p.created_at ? p.created_at.toISOString() : null,
      last_sent_at: p.last_sent_at ? p.last_sent_at.toISOString() : null,
      items: (p.items || []).map((item: any) => ({
        id: item.id,
        service: item.service,
        description: item.description || '',
        cost: item.cost ? Number(item.cost) : 0,
      })),
      secure_pdf_link: `/api/v1/proposals/${p.id}/download_pdf/`,
    };
  }

  async findAll(user: any, query: { lead?: string; leadId?: string; all?: string }) {
    const roleName = user.role?.name;
    const where: any = {};

    const leadId = Number(query.lead || query.leadId);
    if (leadId) {
      where.lead_id = leadId;
    }

    if (roleName === 'CLIENT') {
      const client = await this.prisma.client.findFirst({
        where: { portal_users: { some: { id: user.id } } },
      });
      if (client) {
        where.client_id = client.id;
      } else {
        return query.all === 'true' ? [] : { count: 0, next: null, previous: null, results: [] };
      }
    }

    const proposals = await this.prisma.proposal.findMany({
      where,
      include: {
        lead: true,
        items: true,
        client: true,
      },
      orderBy: { created_at: 'desc' },
    });

    const formatted = proposals.map((p) => this.formatProposal(p));

    if (query.all === 'true' || leadId) {
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
    const roleName = user.role?.name;
    const proposal = await this.prisma.proposal.findUnique({
      where: { id },
      include: {
        lead: true,
        items: true,
        client: true,
      },
    });

    if (!proposal) throw new NotFoundException('Proposal not found');

    if (roleName === 'CLIENT') {
      const client = await this.prisma.client.findFirst({
        where: { portal_users: { some: { id: user.id } } },
      });
      if (!client || proposal.client_id !== client.id) {
        throw new ForbiddenException('You do not have permission to access this proposal.');
      }
    }

    return this.formatProposal(proposal);
  }

  async create(user: any, body: any) {
    const roleName = user.role?.name;
    if (roleName === 'CLIENT') {
      throw new ForbiddenException('Clients do not have permission to modify proposals.');
    }

    const leadId = Number(body.lead || body.leadId);
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) throw new BadRequestException({ lead: ['Invalid lead specified.'] });

    const itemsData = body.items || [];
    let subtotal = 0;
    for (const item of itemsData) {
      subtotal += Number(item.cost || 0);
    }

    const discount = Number(body.discount || 0);
    const amount = Number(body.amount !== undefined ? body.amount : subtotal - discount);

    const created = await this.prisma.proposal.create({
      data: {
        lead_id: leadId,
        client_id: lead.client_id || (body.client ? Number(body.client) : null),
        title: body.title || `${lead.company_name || lead.name} Proposal`,
        description: body.description || '',
        project_overview: body.project_overview || '',
        subtotal,
        discount,
        amount,
        status: body.status || 'draft',
        builder_config: body.builder_config || {},
      },
    });

    // Create items
    for (const item of itemsData) {
      await this.prisma.proposalItem.create({
        data: {
          proposal_id: created.id,
          service: item.service,
          description: item.description || '',
          cost: Number(item.cost || 0),
        },
      });
    }

    return this.findOne(created.id, user);
  }

  async update(id: number, user: any, body: any) {
    const roleName = user.role?.name;
    if (roleName === 'CLIENT') {
      throw new ForbiddenException('Clients do not have permission to modify proposals.');
    }

    const existing = await this.prisma.proposal.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Proposal not found');

    const data: any = {};
    if (body.title !== undefined) data.title = body.title;
    if (body.description !== undefined) data.description = body.description;
    if (body.project_overview !== undefined) data.project_overview = body.project_overview;
    if (body.subtotal !== undefined) data.subtotal = Number(body.subtotal);
    if (body.discount !== undefined) data.discount = Number(body.discount);
    if (body.amount !== undefined) data.amount = Number(body.amount);
    if (body.status !== undefined) data.status = body.status;
    if (body.builder_config !== undefined) data.builder_config = body.builder_config;

    await this.prisma.proposal.update({
      where: { id },
      data,
    });

    if (body.items !== undefined && Array.isArray(body.items)) {
      await this.prisma.proposalItem.deleteMany({
        where: { proposal_id: id },
      });

      for (const item of body.items) {
        await this.prisma.proposalItem.create({
          data: {
            proposal_id: id,
            service: item.service,
            description: item.description || '',
            cost: Number(item.cost || 0),
          },
        });
      }
    }

    return this.findOne(id, user);
  }

  async remove(id: number, user: any) {
    const roleName = user.role?.name;
    if (roleName === 'CLIENT') {
      throw new ForbiddenException('Clients do not have permission to modify proposals.');
    }

    const existing = await this.prisma.proposal.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Proposal not found');

    await this.prisma.proposal.delete({ where: { id } });
    return null;
  }

  async convertToProject(id: number, user: any) {
    const roleName = user.role?.name;
    if (roleName === 'CLIENT') {
      throw new ForbiddenException('Clients do not have permission to convert proposals.');
    }

    const proposal = await this.prisma.proposal.findUnique({
      where: { id },
      include: { lead: true, client: true },
    });

    if (!proposal) throw new NotFoundException('Proposal not found');

    if (proposal.is_converted) {
      const existingProject = proposal.project_id
        ? await this.prisma.project.findUnique({ where: { id: proposal.project_id }, include: { client: true } })
        : null;

      return {
        message: 'Proposal already converted',
        project: existingProject,
        client: proposal.client_id,
      };
    }

    let client = proposal.client || (proposal.lead ? (proposal.lead as any).client : null);
    if (!client && proposal.lead) {
      client = await this.prisma.client.findFirst({
        where: { email: proposal.lead.email, deleted_at: null },
      });

      if (!client) {
        client = await this.prisma.client.create({
          data: {
            name: proposal.lead.name || 'Proposal Client',
            email: proposal.lead.email || `proposal_${Date.now()}@example.com`,
            phone: proposal.lead.phone || '',
            company_name: proposal.lead.company_name || proposal.lead.name || proposal.title,
            address: '',
            status: 'active',
          },
        });
      }

      await this.prisma.proposal.update({
        where: { id },
        data: { client_id: client.id },
      });

      if (proposal.lead) {
        await this.prisma.lead.update({
          where: { id: proposal.lead.id },
          data: { client_id: client.id },
        });
      }
    }

    // Create project from proposal
    const project = await this.prisma.project.create({
      data: {
        name: proposal.title,
        client_id: client ? client.id : 1,
        created_by_id: user.id,
        start_date: new Date(),
        end_date: new Date(Date.now() + 30 * 86400000),
        status: 'not_started',
        progress_percentage: 0,
      },
      include: { client: true },
    });

    await this.prisma.proposal.update({
      where: { id },
      data: {
        is_converted: true,
        project_id: project.id,
        status: 'accepted',
      },
    });

    if (proposal.lead) {
      await this.prisma.lead.update({
        where: { id: proposal.lead.id },
        data: {
          status: 'converted',
          converted_project_id: project.id,
        },
      });
    }

    return {
      message: 'Proposal converted successfully',
      project: {
        id: project.id,
        name: project.name,
        client: project.client_id,
        status: project.status,
      },
      client: client ? client.id : null,
    };
  }

  async sendEmail(id: number, user: any) {
    const proposal = await this.findOne(id, user);
    if (!proposal.leadEmail) {
      throw new BadRequestException({ error: 'No email for this lead' });
    }

    const isResend = proposal.status === 'sent';

    const pdfBuffer = await this.pdfService.generateProposalPdf(proposal);
    await this.mailerService.sendMail({
      to: proposal.leadEmail,
      subject: `Business Proposal - ${proposal.title}`,
      text: `Hello ${proposal.leadName || 'Client'},\n\nPlease find attached our business proposal for ${proposal.title}.\n\nRegards,\nGrehasoft Smart IT Solutions`,
      attachments: [
        {
          filename: `proposal_${proposal.id}.pdf`,
          content: pdfBuffer,
        } as any,
      ],
    });

    await this.prisma.proposal.update({
      where: { id },
      data: {
        status: 'sent',
        last_sent_at: new Date(),
      },
    });

    return {
      message: isResend ? 'Proposal resent successfully.' : 'Proposal sent successfully.',
    };
  }

  async generatePdfStream(id: number, user: any, customConfig?: any): Promise<Buffer> {
    const proposal = await this.findOne(id, user);
    return this.pdfService.generateProposalPdf(proposal, customConfig);
  }

  async previewPdfStream(user: any, body: any): Promise<Buffer> {
    try {
      let proposal: any = {};
      if (body.id) {
        try {
          proposal = await this.findOne(Number(body.id), user);
        } catch {
          proposal = {
            title: body.title || 'Project Proposal',
            subtotal: body.subtotal || 0,
            discount: body.discount || 0,
            amount: body.amount || 0,
            items: body.items || [],
          };
        }
      } else {
        proposal = {
          title: body.title || 'Project Proposal',
          subtotal: body.subtotal || 0,
          discount: body.discount || 0,
          amount: body.amount || 0,
          items: body.items || [],
        };
      }

      return await this.pdfService.generateProposalPdf(proposal, body.builder_config || body);
    } catch (err) {
      console.error('PREVIEW_PDF_STREAM_ERROR:', err);
      throw err;
    }
  }
}
