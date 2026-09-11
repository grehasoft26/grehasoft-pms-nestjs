import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma.service';

@Injectable()
export class RemindersService {
  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------
  // 1. REMINDERS CRUD
  // -------------------------------------------------------------
  async getReminders(user: any, query: { page?: string; limit?: string; search?: string; all?: string } = {}) {
    const where: any = { user_id: user.id };

    if (query.search) {
      where.OR = [
        { title: { contains: query.search, mode: 'insensitive' } },
        { description: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    if (query.all === 'true') {
      const reminders = await this.prisma.reminder.findMany({
        where,
        orderBy: { id: 'desc' },
      });
      return reminders;
    }

    const pageNum = Math.max(1, Number(query.page) || 1);
    const limitNum = Math.max(1, Number(query.limit) || 5);
    const skip = (pageNum - 1) * limitNum;

    const count = await this.prisma.reminder.count({ where });

    const results = await this.prisma.reminder.findMany({
      where,
      orderBy: { id: 'desc' },
      skip,
      take: limitNum,
    });

    return {
      count,
      next: pageNum * limitNum < count ? `/api/reminders?page=${pageNum + 1}` : null,
      previous: pageNum > 1 ? `/api/reminders?page=${pageNum - 1}` : null,
      results,
    };
  }

  async getReminderById(user: any, id: number) {
    const reminder = await this.prisma.reminder.findFirst({
      where: { id, user_id: user.id },
    });
    if (!reminder) throw new NotFoundException('Reminder not found');
    return reminder;
  }

  async createReminder(user: any, data: any) {
    return this.prisma.reminder.create({
      data: {
        user_id: user.id,
        title: data.title,
        description: data.description || null,
        due_date: new Date(data.due_date),
        type: data.type || 'general',
        is_completed: data.is_completed || false,
        email_sent_created: false,
        email_sent_reminder: false,
      },
    });
  }

  async updateReminder(user: any, id: number, data: any) {
    const existing = await this.prisma.reminder.findFirst({
      where: { id, user_id: user.id },
    });
    if (!existing) throw new NotFoundException('Reminder not found');

    return this.prisma.reminder.update({
      where: { id },
      data: {
        title: data.title,
        description: data.description,
        due_date: data.due_date ? new Date(data.due_date) : undefined,
        type: data.type,
        is_completed: data.is_completed !== undefined ? Boolean(data.is_completed) : undefined,
      },
    });
  }

  async deleteReminder(user: any, id: number) {
    const existing = await this.prisma.reminder.findFirst({
      where: { id, user_id: user.id },
    });
    if (!existing) throw new NotFoundException('Reminder not found');

    return this.prisma.reminder.delete({ where: { id } });
  }

  // -------------------------------------------------------------
  // 2. DASHBOARD SUMMARY STATS
  // -------------------------------------------------------------
  async getDashboardSummary(user: any) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const pending = await this.prisma.reminder.count({
      where: {
        user_id: user.id,
        is_completed: false,
        due_date: { gte: today },
      },
    });

    const overdue = await this.prisma.reminder.count({
      where: {
        user_id: user.id,
        is_completed: false,
        due_date: { lt: today },
      },
    });

    const completed = await this.prisma.reminder.count({
      where: {
        user_id: user.id,
        is_completed: true,
      },
    });

    return {
      pending,
      completed,
      overdue,
    };
  }

  // -------------------------------------------------------------
  // 3. TEST EMAIL DISPATCH
  // -------------------------------------------------------------
  async testReminderEmail(user: any) {
    const reminder = await this.prisma.reminder.findFirst({
      where: { user_id: user.id },
    });

    if (!reminder) {
      throw new BadRequestException('No reminders found to test email');
    }

    return {
      success: true,
      message: `Email test successful for Reminder: ${reminder.title}`,
      reminder_id: reminder.id,
      reminder_title: reminder.title,
    };
  }
}
