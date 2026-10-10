import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
  UseInterceptors,
  UploadedFile,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { ExpensesService } from './expenses.service';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { UpdateExpenseDto } from './dto/update-expense.dto';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../core/guards/permissions.guard';
import { Permissions } from '../../core/decorators/permissions.decorator';
import { CurrentUser } from '../../core/decorators/current-user.decorator';

@Controller('api/v1/expenses')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ExpensesController {
  constructor(private readonly expensesService: ExpensesService) {}

  @Get()
  @Permissions('VIEW_EXPENSES', 'MANAGE_EXPENSES', 'VIEW_FINANCIAL_REPORTS')
  async findAll(@CurrentUser() user: any, @Query() query: any) {
    return this.expensesService.findAll(user, query);
  }

  @Get([':id/receipt', ':id/receipt/'])
  @Permissions('VIEW_EXPENSES', 'MANAGE_EXPENSES')
  async getReceipt(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
    @Res() res: Response,
  ) {
    const { buffer, filename, mimeType } = await this.expensesService.getReceiptFile(id, user);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.send(buffer);
  }

  @Get([':id', ':id/'])
  @Permissions('VIEW_EXPENSES', 'MANAGE_EXPENSES')
  async findOne(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.expensesService.findOne(id, user);
  }

  @Post()
  @Permissions('MANAGE_EXPENSES')
  @UseInterceptors(FileInterceptor('receipt_file'))
  async create(
    @CurrentUser() user: any,
    @Body() dto: CreateExpenseDto,
    @UploadedFile() file?: any,
  ) {
    return this.expensesService.create(user, dto, file);
  }

  @Put([':id', ':id/'])
  @Permissions('MANAGE_EXPENSES')
  @UseInterceptors(FileInterceptor('receipt_file'))
  async updatePut(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
    @Body() dto: UpdateExpenseDto,
    @UploadedFile() file?: any,
  ) {
    return this.expensesService.update(id, user, dto, file);
  }

  @Patch([':id', ':id/'])
  @Permissions('MANAGE_EXPENSES')
  @UseInterceptors(FileInterceptor('receipt_file'))
  async update(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
    @Body() dto: UpdateExpenseDto,
    @UploadedFile() file?: any,
  ) {
    return this.expensesService.update(id, user, dto, file);
  }

  @Delete([':id', ':id/'])
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permissions('MANAGE_EXPENSES')
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.expensesService.remove(id, user);
  }
}
