import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  Request,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import { RemindersService } from './reminders.service';

// -------------------------------------------------------------
// 1. REMINDERS CONTROLLER (/api/v1/reminders/)
// -------------------------------------------------------------
@Controller('api/v1/reminders')
@UseGuards(JwtAuthGuard)
export class RemindersController {
  constructor(private readonly remindersService: RemindersService) {}

  @Get()
  async findAll(@Request() req: any, @Query() query: any) {
    return this.remindersService.getReminders(req.user, query);
  }

  @Get(':id')
  async findOne(@Request() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.remindersService.getReminderById(req.user, id);
  }

  @Post()
  async create(@Request() req: any, @Body() body: any) {
    return this.remindersService.createReminder(req.user, body);
  }

  @Put(':id')
  async updatePut(@Request() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.remindersService.updateReminder(req.user, id, body);
  }

  @Patch(':id')
  async updatePatch(@Request() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.remindersService.updateReminder(req.user, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Request() req: any, @Param('id', ParseIntPipe) id: number) {
    await this.remindersService.deleteReminder(req.user, id);
  }

  @Post('test-email')
  async testEmail(@Request() req: any) {
    return this.remindersService.testReminderEmail(req.user);
  }
}

// -------------------------------------------------------------
// 2. DASHBOARD SUMMARY CONTROLLER (/api/v1/dashboard-summary/)
// -------------------------------------------------------------
@Controller('api/v1/dashboard-summary')
@UseGuards(JwtAuthGuard)
export class DashboardSummaryController {
  constructor(private readonly remindersService: RemindersService) {}

  @Get()
  async getSummary(@Request() req: any) {
    return this.remindersService.getDashboardSummary(req.user);
  }
}
