import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  Request,
  Response,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import { TrackingService } from './tracking.service';

// -------------------------------------------------------------
// 1. TRACKING CONTROLLER (/api/v1/tracking/)
// -------------------------------------------------------------
@Controller('api/v1/tracking')
@UseGuards(JwtAuthGuard)
export class TrackingController {
  constructor(private readonly trackingService: TrackingService) {}

  @Post('heartbeat')
  async heartbeat(@Request() req: any, @Body() body: any) {
    return this.trackingService.handleHeartbeat(req.user.id, body);
  }

  @Post('activity-batch-sync')
  async activityBatchSync(@Request() req: any, @Body() body: any) {
    return this.trackingService.handleActivityBatchSync(req.user.id, body);
  }

  @Post('logout')
  async logout(@Request() req: any) {
    return this.trackingService.handleLogout(req.user.id);
  }

  @Get('user-status')
  async getUserStatus(@Request() req: any) {
    return this.trackingService.getOrCreateProfile(req.user.id);
  }

  @Get('employee-status')
  async getAllEmployeeStatus() {
    return this.trackingService.getEmployeeStatus();
  }

  @Get('employee-status/:userId')
  async getSingleEmployeeStatus(@Param('userId', ParseIntPipe) userId: number) {
    return this.trackingService.getEmployeeStatus(userId);
  }

  @Post('toggle-tracking/:userId')
  async toggleTracking(
    @Request() req: any,
    @Param('userId', ParseIntPipe) userId: number,
    @Body('enabled') enabled?: boolean,
  ) {
    return this.trackingService.toggleTrackingForUser(req.user, userId, enabled);
  }

  @Post('set-track-enable')
  async setTrackEnable(@Request() req: any, @Body('enabled') enabled: boolean) {
    return this.trackingService.setTrackingEnabled(req.user.id, enabled);
  }

  @Get('reports/daily')
  async getDailyReport(@Query() query: any) {
    return this.trackingService.getDailyReport(query);
  }

  @Get('reports/weekly')
  async getWeeklyReport(@Query() query: any) {
    return this.trackingService.getWeeklyReport(query);
  }

  @Get('reports/monthly')
  async getMonthlyReport(@Query() query: any) {
    return this.trackingService.getMonthlyReport(query);
  }

  @Get('reports/employee-analytics')
  async getEmployeeAnalytics(@Query() query: any) {
    return this.trackingService.getEmployeeAnalytics(query);
  }

  @Get('reports/export')
  async exportReport(@Query() query: any, @Response() res: any) {
    return this.trackingService.exportReport(res, query);
  }
}

// -------------------------------------------------------------
// 2. TRACKING PROFILES CONTROLLER (/api/v1/tracking/profiles/)
// -------------------------------------------------------------
@Controller('api/v1/tracking/profiles')
@UseGuards(JwtAuthGuard)
export class TrackingProfilesController {
  constructor(private readonly trackingService: TrackingService) {}

  @Get()
  async findAll() {
    return this.trackingService.getProfiles();
  }

  @Get(':id')
  async findOne(@Param('id', ParseIntPipe) id: number) {
    return this.trackingService.getProfileById(id);
  }
}

// -------------------------------------------------------------
// 3. WORK SESSIONS CONTROLLER (/api/v1/tracking/sessions/)
// -------------------------------------------------------------
@Controller('api/v1/tracking/sessions')
@UseGuards(JwtAuthGuard)
export class WorkSessionsController {
  constructor(private readonly trackingService: TrackingService) {}

  @Get()
  async findAll(@Request() req: any) {
    return this.trackingService.getUserSessions(req.user);
  }

  @Get('today')
  async findToday(@Request() req: any) {
    return this.trackingService.getUserSessions(req.user, 'today');
  }

  @Get('active')
  async findActive(@Request() req: any) {
    return this.trackingService.getUserSessions(req.user, 'active');
  }
}
