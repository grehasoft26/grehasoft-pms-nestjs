import { Controller, Get, Post, Patch, Delete, Param, Query, Body, UseGuards, ParseIntPipe, HttpCode, HttpStatus } from '@nestjs/common';
import { ClientsService } from './clients.service';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../core/guards/permissions.guard';
import { Permissions } from '../../core/decorators/permissions.decorator';
import { CurrentUser } from '../../core/decorators/current-user.decorator';

@Controller('api/v1/clients')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ClientsController {
  constructor(private readonly clientsService: ClientsService) {}

  @Get()
  @Permissions('VIEW_CLIENTS')
  async findAll(@CurrentUser() user: any, @Query() query: any) {
    return this.clientsService.findAll(user, query);
  }

  @Get('dashboard-stats')
  @Permissions('VIEW_CLIENTS')
  async getDashboardStats(@CurrentUser() user: any) {
    return this.clientsService.getDashboardStats(user);
  }

  @Post(':id/create-portal-account')
  @Permissions('VIEW_CLIENTS')
  async createPortalAccount(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: any,
    @CurrentUser() user: any,
  ) {
    return this.clientsService.createPortalAccount(id, body, user);
  }

  @Get(':id')
  @Permissions('VIEW_CLIENTS')
  async findOne(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.clientsService.findOne(id, user);
  }

  @Post()
  @Permissions('VIEW_CLIENTS')
  async create(@Body() body: any) {
    return this.clientsService.create(body);
  }

  @Patch(':id')
  @Permissions('VIEW_CLIENTS')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
    @Body() body: any,
  ) {
    return this.clientsService.update(id, user, body);
  }

  @Delete(':id')
  @Permissions('VIEW_CLIENTS')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
    @Query() query: any,
  ) {
    return this.clientsService.remove(id, user, query);
  }

  @Get(':id/projects')
  @Permissions('VIEW_CLIENTS')
  async getClientProjects(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.clientsService.getClientProjects(id, user);
  }

  @Post(':id/edit-portal-user-username')
  @Permissions('VIEW_CLIENTS')
  async editPortalUserUsername(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: any,
    @CurrentUser() user: any,
  ) {
    return this.clientsService.editPortalUserUsername(id, body, user);
  }

  @Post(':id/reset-portal-user-password')
  @Permissions('VIEW_CLIENTS')
  async resetPortalUserPassword(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: any,
    @CurrentUser() user: any,
  ) {
    return this.clientsService.resetPortalUserPassword(id, body, user);
  }

  @Post(':id/toggle-portal-user-status')
  @Permissions('VIEW_CLIENTS')
  async togglePortalUserStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: any,
    @CurrentUser() user: any,
  ) {
    return this.clientsService.togglePortalUserStatus(id, body, user);
  }

  @Post(':id/delete-portal-user')
  @Permissions('VIEW_CLIENTS')
  async deletePortalUser(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: any,
    @CurrentUser() user: any,
  ) {
    return this.clientsService.deletePortalUser(id, body, user);
  }

  @Get(':id/portal-user-audit')
  @Permissions('VIEW_CLIENTS')
  async getPortalUserAudit(@Param('id', ParseIntPipe) id: number) {
    return this.clientsService.getPortalUserAudit(id);
  }

  @Post(':id/portal-users/:userId/send-invitation')
  @Permissions('VIEW_CLIENTS')
  async sendInvitation(
    @Param('id', ParseIntPipe) id: number,
    @Param('userId', ParseIntPipe) userId: number,
    @CurrentUser() user: any,
  ) {
    return this.clientsService.sendInvitation(id, userId, user);
  }

  @Post(':id/portal-users/:userId/reset-password')
  @Permissions('VIEW_CLIENTS')
  async resetPasswordByPath(
    @Param('id', ParseIntPipe) id: number,
    @Param('userId', ParseIntPipe) userId: number,
    @Body() body: any,
    @CurrentUser() user: any,
  ) {
    return this.clientsService.resetPasswordByPath(id, userId, body, user);
  }
}
