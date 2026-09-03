import {
  Controller,
  Get,
  Patch,
  Param,
  Query,
  UseGuards,
  Request,
  ParseIntPipe,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import { ClientPortalService } from './client-portal.service';

@Controller()
@UseGuards(JwtAuthGuard)
export class ClientPortalController {
  constructor(private readonly clientPortalService: ClientPortalService) {}

  // ---------------- NOTIFICATIONS ENDPOINTS ----------------
  @Get('api/v1/dashboard/client-notifications')
  async getNotifications(@Request() req: any) {
    return this.clientPortalService.getClientNotifications(req.user);
  }

  @Patch('api/v1/dashboard/client-notifications/:id/mark-read')
  async markRead(@Request() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.clientPortalService.markNotificationRead(req.user, id);
  }

  @Patch('api/v1/dashboard/client-notifications/mark-all-read')
  async markAllRead(@Request() req: any) {
    return this.clientPortalService.markAllNotificationsRead(req.user);
  }

  // ---------------- CLIENT PORTAL ENDPOINTS ----------------
  @Get('api/v1/client/dashboard/overview')
  async getOverview(@Request() req: any) {
    return this.clientPortalService.getClientDashboardOverview(req.user);
  }

  @Get('api/v1/client/projects/:id/activity')
  async getProjectActivity(@Request() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.clientPortalService.getClientProjectActivity(req.user, id);
  }

  @Get('api/v1/dashboard/documents')
  async getDocuments(@Request() req: any, @Query() query: any) {
    return this.clientPortalService.getClientDocuments(req.user, query);
  }
}
