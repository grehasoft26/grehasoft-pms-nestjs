import { Controller, Get, Post, Patch, Delete, Param, Query, Body, UseGuards, ParseIntPipe, HttpCode, HttpStatus } from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../core/guards/permissions.guard';
import { Permissions } from '../../core/decorators/permissions.decorator';
import { CurrentUser } from '../../core/decorators/current-user.decorator';

@Controller('api/v1/projects')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Get()
  @Permissions('VIEW_PROJECTS')
  async findAll(@CurrentUser() user: any, @Query() query: any) {
    return this.projectsService.findAll(user, query);
  }

  @Get(':id')
  @Permissions('VIEW_PROJECTS')
  async findOne(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.projectsService.findOne(id, user);
  }

  @Post()
  @Permissions('MANAGE_PROJECTS')
  async create(@CurrentUser() user: any, @Body() body: any) {
    return this.projectsService.create(user, body);
  }

  @Patch(':id')
  @Permissions('MANAGE_PROJECTS')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
    @Body() body: any,
  ) {
    return this.projectsService.update(id, user, body);
  }

  @Delete(':id')
  @Permissions('MANAGE_PROJECTS')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.projectsService.remove(id, user);
  }

  @Get(':id/members')
  @Permissions('VIEW_PROJECTS')
  async getProjectMembers(@Param('id', ParseIntPipe) id: number) {
    return this.projectsService.findProjectMembers(id);
  }
}
