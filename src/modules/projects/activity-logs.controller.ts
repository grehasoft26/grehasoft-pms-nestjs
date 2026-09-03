import { Controller, Get, Query, UseGuards, BadRequestException } from '@nestjs/common';
import { ProjectActivityLogsService } from './services/project-activity-logs.service';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../core/guards/permissions.guard';
import { Permissions } from '../../core/decorators/permissions.decorator';
import { CurrentUser } from '../../core/decorators/current-user.decorator';

@Controller('api/v1/project-activity-logs')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ProjectActivityLogsController {
  constructor(private readonly activityLogsService: ProjectActivityLogsService) {}

  @Get()
  @Permissions('VIEW_PROJECTS')
  async findByProject(@CurrentUser() user: any, @Query() query: { project?: string }) {
    if (!query.project) {
      throw new BadRequestException('project query parameter is required');
    }
    return this.activityLogsService.findByProject(Number(query.project), user);
  }
}
