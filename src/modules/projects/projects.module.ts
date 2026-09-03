import { Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { ClientsController } from './clients.controller';
import { ClientsService } from './clients.service';
import { MilestonesController } from './milestones.controller';
import { MilestonesService } from './milestones.service';
import { ProjectMembersController } from './members.controller';
import { ProjectMembersService } from './members.service';
import { ProjectActivityLogsController } from './activity-logs.controller';
import { ProjectActivityLogsService } from './services/project-activity-logs.service';
import { ProgressAggregationService } from './services/progress-aggregation.service';

@Module({
  controllers: [
    ProjectsController,
    ClientsController,
    MilestonesController,
    ProjectMembersController,
    ProjectActivityLogsController,
  ],
  providers: [
    ProjectsService,
    ClientsService,
    MilestonesService,
    ProjectMembersService,
    ProjectActivityLogsService,
    ProgressAggregationService,
  ],
  exports: [
    ProjectsService,
    ClientsService,
    MilestonesService,
    ProjectMembersService,
    ProjectActivityLogsService,
    ProgressAggregationService,
  ],
})
export class ProjectsModule {}
