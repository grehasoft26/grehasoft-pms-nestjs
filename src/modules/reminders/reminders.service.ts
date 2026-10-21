import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma.service';
import { parseDateOnly } from '../../core/utils/date-only.util';

/** Values of the ReminderType enum (prisma/schema.prisma). */
const REMINDER_TYPES = ['general', 'invoice', 'payment', 'proposal', 'followup'] as const;

@Injectable()
export class RemindersService {
  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------
  // 1. REMINDERS CRUD
  // -------------------------------------------------------------
  async getReminders(
    user: any,
    query: { page?: string; limit?: string; search?: string; status?: string; all?: string } = {},
  ) {
    const where: any = { user_id: user.id };

    // Title and description (case-insensitive through the columns' *_ci collation; Prisma's
    // `mode: 'insensitive'` is not supported on MySQL and made every search fail with a 500),
    // plus the category when the term matches a reminder type
    const search = String(query.search ?? '').trim();
    if (search) {
      const types = REMINDER_TYPES.filter((t) => t.includes(search.toLowerCase()));
      where.OR = [
        { title: { contains: search } },
        { description: { contains: search } },
        ...(types.length ? [{ type: { in: types } }] : []),
      ];
    }

    // Completion filter on the existing is_completed field: ?status=pending | completed
    const status = String(query.status ?? '').toLowerCase();
    if (status === 'completed') where.is_completed = true;
    else if (status === 'pending') where.is_completed = false;

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

  /** due_date is a required DATE: date-only parsing, 400 when missing or invalid (was a 500). */
  private parseDueDate(value: any, required: boolean): Date | undefined {
    const date = parseDateOnly(value, 'Due date');
    if (date === null || (required && date === undefined)) {
      throw new BadRequestException('Due date is required.');
    }
    return date;
  }

  async createReminder(user: any, data: any) {
    const dueDate = this.parseDueDate(data.due_date, true);
    return this.prisma.reminder.create({
      data: {
        user_id: user.id,
        title: data.title,
        description: data.description || null,
        due_date: dueDate!,
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
        due_date: this.parseDueDate(data.due_date, false),
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
