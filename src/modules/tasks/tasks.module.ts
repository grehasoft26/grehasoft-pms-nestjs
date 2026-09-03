import { Module } from '@nestjs/common';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { TaskTypesController } from './task-types.controller';
import { TaskTypesService } from './task-types.service';
import { TaskFilesController } from './task-files.controller';
import { TaskFilesService } from './task-files.service';
import { TaskCommentsController } from './task-comments.controller';
import { TaskCommentsService } from './task-comments.service';
import { TaskReviewsController } from './task-reviews.controller';
import { TaskReviewsService } from './task-reviews.service';
import { ProjectsModule } from '../projects/projects.module';

@Module({
  imports: [ProjectsModule],
  controllers: [
    TasksController,
    TaskTypesController,
    TaskFilesController,
    TaskCommentsController,
    TaskReviewsController,
  ],
  providers: [
    TasksService,
    TaskTypesService,
    TaskFilesService,
    TaskCommentsService,
    TaskReviewsService,
  ],
  exports: [
    TasksService,
    TaskTypesService,
    TaskFilesService,
    TaskCommentsService,
    TaskReviewsService,
  ],
})
export class TasksModule {}
