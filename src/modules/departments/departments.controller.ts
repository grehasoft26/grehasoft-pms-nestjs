import { Controller, Get, Post, Patch, Delete, Param, Query, Body, UseGuards, ParseIntPipe, HttpCode, HttpStatus } from '@nestjs/common';
import { DepartmentsService } from './departments.service';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../core/guards/permissions.guard';
import { Permissions } from '../../core/decorators/permissions.decorator';

@Controller('api/v1/departments')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class DepartmentsController {
  constructor(private readonly departmentsService: DepartmentsService) {}

  @Get()
  @Permissions('MANAGE_USERS')
  async findAll(@Query() query: { all?: string }) {
    return this.departmentsService.findAll(query);
  }

  @Get(':id')
  @Permissions('MANAGE_USERS')
  async findOne(@Param('id', ParseIntPipe) id: number) {
    return this.departmentsService.findOne(id);
  }

  @Post()
  @Permissions('MANAGE_USERS')
  async create(@Body() body: any) {
    return this.departmentsService.create(body);
  }

  @Patch(':id')
  @Permissions('MANAGE_USERS')
  async update(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.departmentsService.update(id, body);
  }

  @Delete(':id')
  @Permissions('MANAGE_USERS')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseIntPipe) id: number) {
    return this.departmentsService.remove(id);
  }
}
