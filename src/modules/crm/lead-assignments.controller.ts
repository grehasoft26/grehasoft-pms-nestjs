import { Controller, Get, Post, Delete, Param, Query, Body, UseGuards, ParseIntPipe, HttpCode, HttpStatus } from '@nestjs/common';
import { LeadAssignmentsService } from './lead-assignments.service';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../core/guards/permissions.guard';
import { Permissions } from '../../core/decorators/permissions.decorator';

@Controller('api/v1/lead-assignments')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class LeadAssignmentsController {
  constructor(private readonly leadAssignmentsService: LeadAssignmentsService) {}

  @Get()
  @Permissions('VIEW_LEADS')
  async findAll(@Query() query: any) {
    return this.leadAssignmentsService.findAll(query);
  }

  @Get(':id')
  @Permissions('VIEW_LEADS')
  async findOne(@Param('id', ParseIntPipe) id: number) {
    return this.leadAssignmentsService.findOne(id);
  }

  @Post()
  @Permissions('MANAGE_LEADS')
  async create(@Body() body: any) {
    return this.leadAssignmentsService.create(body);
  }

  @Delete(':id')
  @Permissions('MANAGE_LEADS')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseIntPipe) id: number) {
    return this.leadAssignmentsService.remove(id);
  }
}
