import { Controller, Get, Post, Put, Patch, Delete, Param, Query, Body, UseGuards, ParseIntPipe, HttpCode, HttpStatus, Res, Header } from '@nestjs/common';
import { Response } from 'express';
import { ProposalsService } from './proposals.service';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../core/guards/permissions.guard';
import { Permissions } from '../../core/decorators/permissions.decorator';
import { CurrentUser } from '../../core/decorators/current-user.decorator';

@Controller('api/v1/proposals')
export class ProposalsController {
  constructor(private readonly proposalsService: ProposalsService) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  async findAll(@CurrentUser() user: any, @Query() query: any) {
    return this.proposalsService.findAll(user, query);
  }

  @Post('preview_pdf')
  @UseGuards(JwtAuthGuard)
  async previewPdf(
    @CurrentUser() user: any,
    @Body() body: any,
    @Res() res: Response,
  ) {
    const pdfBuffer = await this.proposalsService.previewPdfStream(user, body);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="proposal_preview.pdf"');
    res.send(pdfBuffer);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  async findOne(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.proposalsService.findOne(id, user);
  }

  @Post()
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('VIEW_LEADS')
  async create(@CurrentUser() user: any, @Body() body: any) {
    return this.proposalsService.create(user, body);
  }

  @Put(':id')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('VIEW_LEADS')
  async updatePut(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
    @Body() body: any,
  ) {
    return this.proposalsService.update(id, user, body);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('VIEW_LEADS')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
    @Body() body: any,
  ) {
    return this.proposalsService.update(id, user, body);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('VIEW_LEADS')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.proposalsService.remove(id, user);
  }

  @Post(':id/convert')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('VIEW_LEADS')
  async convertToProject(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.proposalsService.convertToProject(id, user);
  }

  @Post(':id/send')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('VIEW_LEADS')
  async sendEmail(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.proposalsService.sendEmail(id, user);
  }

  @Get(':id/download_pdf')
  @UseGuards(JwtAuthGuard)
  async downloadPdfGet(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
    @Res() res: Response,
  ) {
    const pdfBuffer = await this.proposalsService.generatePdfStream(id, user);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="proposal_${id}.pdf"`);
    res.send(pdfBuffer);
  }

  @Post(':id/download_pdf')
  @UseGuards(JwtAuthGuard)
  async downloadPdfPost(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
    @Body() body: any,
    @Res() res: Response,
  ) {
    const pdfBuffer = await this.proposalsService.generatePdfStream(id, user, body);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="proposal_${id}.pdf"`);
    res.send(pdfBuffer);
  }
}
