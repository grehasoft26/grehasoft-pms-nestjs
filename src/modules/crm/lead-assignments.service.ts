import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma.service';
import { formatUserResponse } from '../users/user.serializer';

@Injectable()
export class LeadAssignmentsService {
  constructor(private readonly prisma: PrismaService) {}

  private formatAssignment(a: any) {
    if (!a) return null;
    return {
      id: a.id,
      lead: a.lead_id,
      sales_exec: a.sales_exec_id,
      assigned_at: a.assigned_at ? a.assigned_at.toISOString() : null,
      sales_exec_details: a.sales_exec ? formatUserResponse(a.sales_exec) : null,
    };
  }

  async findAll(query: { lead_id?: string; lead?: string }) {
    const leadId = Number(query.lead_id || query.lead);
    const where: any = {};
    if (leadId) {
      where.lead_id = leadId;
    }

    const assignments = await this.prisma.leadAssignment.findMany({
      where,
      include: {
        sales_exec: {
          include: { role: true, department: true, client: true },
        },
      },
      orderBy: { id: 'desc' },
    });

    return assignments.map((a) => this.formatAssignment(a));
  }

  async findOne(id: number) {
    const assignment = await this.prisma.leadAssignment.findUnique({
      where: { id },
      include: {
        sales_exec: {
          include: { role: true, department: true, client: true },
        },
      },
    });
    if (!assignment) throw new NotFoundException('Lead assignment not found');
    return this.formatAssignment(assignment);
  }

  async create(body: any) {
    const leadId = Number(body.lead || body.lead_id);
    const salesExecId = Number(body.sales_exec || body.sales_exec_id);

    const assignment = await this.prisma.leadAssignment.create({
      data: {
        lead_id: leadId,
        sales_exec_id: salesExecId,
      },
      include: {
        sales_exec: {
          include: { role: true, department: true, client: true },
        },
      },
    });

    return this.formatAssignment(assignment);
  }

  async remove(id: number) {
    const existing = await this.prisma.leadAssignment.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Lead assignment not found');
    await this.prisma.leadAssignment.delete({ where: { id } });
    return null;
  }
}
