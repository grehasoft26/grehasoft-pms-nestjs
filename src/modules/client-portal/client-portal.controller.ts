import {
  Controller,
  Get,
  Patch,
  Param,
  Query,
  UseGuards,
  Request,
  ParseIntPipe,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { Response } from 'express';
import * as fs from 'fs';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import { contentDisposition } from '../../core/utils/content-disposition.util';
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

  // One vault document (Authorization header only, like every route; the page downloads it as a
  // blob). Always an attachment of opaque type, so an uploaded HTML/SVG file can never render.
  @Get([
    'api/v1/dashboard/documents/:id/download',
    'api/v1/dashboard/documents/:id/download/',
  ])
  async downloadDocument(
    @Request() req: any,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const file = await this.clientPortalService.getClientDocumentFile(
      req.user,
      id,
    );
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': contentDisposition('attachment', file.filename),
      'Content-Length': String(file.size),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, no-store',
    });
    return new StreamableFile(fs.createReadStream(file.absolute));
  }
}
