import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma.service';

@Injectable()
export class LeadFollowupsService {
  constructor(private readonly prisma: PrismaService) {}

  private formatFollowup(f: any) {
    if (!f) return null;
    return {
      id: f.id,
      lead: f.lead_id,
      followup_type: f.followup_type,
      notes: f.notes,
      next_followup: f.next_followup ? f.next_followup.toISOString().split('T')[0] : null,
      status: f.status,
      created_by: f.created_by_id,
      created_by_name: f.created_by ? f.created_by.name || f.created_by.username : 'User',
      created_at: f.created_at ? f.created_at.toISOString() : null,
    };
  }

  async findAll(query: { lead?: string; lead_id?: string; status?: string; followup_type?: string }) {
    const leadId = Number(query.lead || query.lead_id);
    const where: any = {};
    if (leadId) where.lead_id = leadId;
    if (query.status) where.status = query.status;
    if (query.followup_type) where.followup_type = query.followup_type;

    const followups = await this.prisma.leadFollowup.findMany({
      where,
      include: { created_by: true },
      orderBy: { id: 'desc' },
    });

    return followups.map((f) => this.formatFollowup(f));
  }

  async findOne(id: number) {
    const followup = await this.prisma.leadFollowup.findUnique({
      where: { id },
      include: { created_by: true },
    });
    if (!followup) throw new NotFoundException('Lead followup not found');
    return this.formatFollowup(followup);
  }

  async create(user: any, body: any) {
    const leadId = Number(body.lead || body.lead_id);
    const followup = await this.prisma.leadFollowup.create({
      data: {
        lead_id: leadId,
        followup_type: body.followup_type || 'call',
        notes: body.notes || '',
        next_followup: new Date(body.next_followup),
        status: body.status || 'pending',
        created_by_id: user.id,
      },
      include: { created_by: true },
    });

    return this.formatFollowup(followup);
  }

  async update(id: number, body: any) {
    const existing = await this.prisma.leadFollowup.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Lead followup not found');

    const data: any = {};
    if (body.followup_type !== undefined) data.followup_type = body.followup_type;
    if (body.notes !== undefined) data.notes = body.notes;
    if (body.next_followup !== undefined) data.next_followup = new Date(body.next_followup);
    if (body.status !== undefined) data.status = body.status;

    const updated = await this.prisma.leadFollowup.update({
      where: { id },
      data,
      include: { created_by: true },
    });

    return this.formatFollowup(updated);
  }

  async remove(id: number) {
    const existing = await this.prisma.leadFollowup.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Lead followup not found');
    await this.prisma.leadFollowup.delete({ where: { id } });
    return null;
  }
}
