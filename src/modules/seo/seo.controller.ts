import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  Request,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import { SeoService } from './seo.service';

// -------------------------------------------------------------
// 1. WEBSITES CONTROLLER (/api/v1/websites/)
// -------------------------------------------------------------
@Controller('api/v1/websites')
@UseGuards(JwtAuthGuard)
export class WebsitesController {
  constructor(private readonly seoService: SeoService) {}

  @Get()
  async findAll(@Request() req: any) {
    return this.seoService.getWebsites(req.user);
  }

  @Get(':id')
  async findOne(@Request() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.seoService.getWebsiteById(req.user, id);
  }

  @Post()
  async create(@Request() req: any, @Body() body: any) {
    return this.seoService.createWebsite(req.user, body);
  }

  @Put(':id')
  async updatePut(@Request() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.seoService.updateWebsite(req.user, id, body);
  }

  @Patch(':id')
  async updatePatch(@Request() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.seoService.updateWebsite(req.user, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Request() req: any, @Param('id', ParseIntPipe) id: number) {
    await this.seoService.deleteWebsite(req.user, id);
  }
}

// -------------------------------------------------------------
// 2. SEO ACTIVITY TYPES CONTROLLER (/api/v1/seo/activity-types/)
// -------------------------------------------------------------
@Controller('api/v1/seo/activity-types')
@UseGuards(JwtAuthGuard)
export class SeoActivityTypesController {
  constructor(private readonly seoService: SeoService) {}

  @Get()
  async findAll(@Request() req: any, @Query('active') active?: string) {
    return this.seoService.getActivityTypes(req.user, active);
  }

  @Post()
  async create(@Request() req: any, @Body() body: any) {
    return this.seoService.createActivityType(req.user, body);
  }

  @Put(':id')
  async updatePut(@Request() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.seoService.updateActivityType(req.user, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Request() req: any, @Param('id', ParseIntPipe) id: number) {
    await this.seoService.deleteActivityType(req.user, id);
  }
}

// -------------------------------------------------------------
// 3. SEO KEYWORDS CONTROLLER (/api/v1/seo-keywords/)
// -------------------------------------------------------------
@Controller('api/v1/seo-keywords')
@UseGuards(JwtAuthGuard)
export class SeoKeywordsController {
  constructor(private readonly seoService: SeoService) {}

  @Get()
  async findAll(@Request() req: any, @Query() query: any) {
    return this.seoService.getKeywords(req.user, query);
  }

  @Post()
  async create(@Request() req: any, @Body() body: any) {
    return this.seoService.createKeyword(req.user, body);
  }

  @Put(':id')
  async updatePut(@Request() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.seoService.updateKeyword(req.user, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Request() req: any, @Param('id', ParseIntPipe) id: number) {
    await this.seoService.deleteKeyword(req.user, id);
  }
}

// -------------------------------------------------------------
// 4. SEO DAILY WORK LOGS CONTROLLER (/api/v1/seo-daily-logs/)
// -------------------------------------------------------------
@Controller('api/v1/seo-daily-logs')
@UseGuards(JwtAuthGuard)
export class SeoDailyLogsController {
  constructor(private readonly seoService: SeoService) {}

  @Get()
  async findAll(@Request() req: any, @Query() query: any) {
    return this.seoService.getDailyLogs(req.user, query);
  }

  @Get('dashboard')
  async getDashboard(@Request() req: any) {
    return this.seoService.getDashboard(req.user);
  }

  @Get('team-performance')
  async getTeamPerformance(@Request() req: any) {
    return this.seoService.getTeamPerformance(req.user);
  }

  @Get(':id')
  async findOne(@Request() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.seoService.getDailyLogById(req.user, id);
  }

  @Post()
  async create(@Request() req: any, @Body() body: any) {
    return this.seoService.createDailyLog(req.user, body);
  }

  @Post('add-items')
  async addItems(@Request() req: any, @Body() body: any) {
    return this.seoService.addItemsToDailyLog(req.user, body);
  }

  @Patch(':id')
  async updatePatch(@Request() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.seoService.updateDailyLog(req.user, id, body);
  }

  @Post(':id/approve')
  async approve(@Request() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.seoService.approveDailyLog(req.user, id);
  }

  @Post(':id/reject')
  async reject(@Request() req: any, @Param('id', ParseIntPipe) id: number, @Body('remarks_by_manager') remarks: string) {
    return this.seoService.rejectDailyLog(req.user, id, remarks);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Request() req: any, @Param('id', ParseIntPipe) id: number) {
    await this.seoService.deleteDailyLog(req.user, id);
  }
}

// -------------------------------------------------------------
// 5. SEO MONTHLY TARGETS CONTROLLER (/api/v1/seo-monthly-targets/)
// -------------------------------------------------------------
@Controller('api/v1/seo-monthly-targets')
@UseGuards(JwtAuthGuard)
export class SeoMonthlyTargetsController {
  constructor(private readonly seoService: SeoService) {}

  @Get()
  async findAll(@Request() req: any) {
    return this.seoService.getMonthlyTargets(req.user);
  }

  @Post()
  async create(@Request() req: any, @Body() body: any) {
    return this.seoService.createMonthlyTarget(req.user, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Request() req: any, @Param('id', ParseIntPipe) id: number) {
    await this.seoService.deleteMonthlyTarget(req.user, id);
  }
}

// -------------------------------------------------------------
// 6. SEO TASKS CONTROLLER (/api/v1/seo-tasks/)
// -------------------------------------------------------------
@Controller('api/v1/seo-tasks')
@UseGuards(JwtAuthGuard)
export class SeoTasksController {
  constructor(private readonly seoService: SeoService) {}

  @Get()
  async findAll(@Request() req: any, @Query() query: any) {
    return this.seoService.getTasks(req.user, query);
  }

  @Post()
  async create(@Request() req: any, @Body() body: any) {
    return this.seoService.createTask(req.user, body);
  }

  @Put(':id')
  async updatePut(@Request() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.seoService.updateTask(req.user, id, body);
  }

  @Patch(':id')
  async updatePatch(@Request() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.seoService.updateTask(req.user, id, body);
  }

  @Post(':id/review')
  async review(
    @Request() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body('action') actionType: string,
    @Body('remarks') remarks?: string,
  ) {
    return this.seoService.reviewTask(req.user, id, actionType, remarks);
  }

  @Post(':id/ready-for-review')
  async markReadyForReview(@Request() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.seoService.markTaskReadyForReview(req.user, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Request() req: any, @Param('id', ParseIntPipe) id: number) {
    await this.seoService.deleteTask(req.user, id);
  }
}

// -------------------------------------------------------------
// 7. SEO REMINDERS CONTROLLER (/api/v1/seo-reminders/)
// -------------------------------------------------------------
@Controller('api/v1/seo-reminders')
@UseGuards(JwtAuthGuard)
export class SeoRemindersController {
  constructor(private readonly seoService: SeoService) {}

  @Get()
  async findAll(@Request() req: any) {
    return this.seoService.getReminders(req.user);
  }

  @Post()
  async create(@Request() req: any, @Body() body: any) {
    return this.seoService.createReminder(req.user, body);
  }

  @Patch(':id')
  async updatePatch(@Request() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.seoService.updateReminder(req.user, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Request() req: any, @Param('id', ParseIntPipe) id: number) {
    await this.seoService.deleteReminder(req.user, id);
  }
}

// -------------------------------------------------------------
// 8. SEO CREDENTIALS CONTROLLER (/api/v1/seo-credentials/)
// -------------------------------------------------------------
@Controller('api/v1/seo-credentials')
@UseGuards(JwtAuthGuard)
export class SeoCredentialsController {
  constructor(private readonly seoService: SeoService) {}

  @Get()
  async findAll(@Request() req: any) {
    return this.seoService.getCredentials(req.user);
  }

  @Post()
  async create(@Request() req: any, @Body() body: any) {
    return this.seoService.createCredential(req.user, body);
  }

  @Put(':id')
  async updatePut(@Request() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.seoService.updateCredential(req.user, id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Request() req: any, @Param('id', ParseIntPipe) id: number) {
    await this.seoService.deleteCredential(req.user, id);
  }
}
