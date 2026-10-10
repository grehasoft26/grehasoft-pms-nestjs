import { Controller, Get, Post, Put, Patch, Delete, Param, Body, UseGuards, ParseIntPipe, HttpCode, HttpStatus } from '@nestjs/common';
import { ExpensesService } from './expenses.service';
import { CreateExpenseCategoryDto } from './dto/create-expense-category.dto';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../core/guards/permissions.guard';
import { Permissions } from '../../core/decorators/permissions.decorator';

@Controller('api/v1/expense-categories')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ExpenseCategoriesController {
  constructor(private readonly expensesService: ExpensesService) {}

  @Get()
  @Permissions('VIEW_EXPENSES', 'MANAGE_EXPENSES', 'MANAGE_SETTINGS')
  async findAll() {
    return this.expensesService.findAllCategories();
  }

  @Post()
  @Permissions('MANAGE_EXPENSES', 'MANAGE_SETTINGS')
  async create(@Body() dto: CreateExpenseCategoryDto) {
    return this.expensesService.createCategory(dto);
  }

  @Put([':id', ':id/'])
  @Patch([':id', ':id/'])
  @Permissions('MANAGE_EXPENSES', 'MANAGE_SETTINGS')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateExpenseCategoryDto,
  ) {
    return this.expensesService.updateCategory(id, dto);
  }

  @Delete([':id', ':id/'])
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permissions('MANAGE_EXPENSES', 'MANAGE_SETTINGS')
  async remove(@Param('id', ParseIntPipe) id: number) {
    return this.expensesService.deleteCategory(id);
  }
}
