import { Module } from '@nestjs/common';
import { TrackingService } from './tracking.service';
import {
  TrackingController,
  TrackingProfilesController,
  WorkSessionsController,
} from './tracking.controller';

@Module({
  controllers: [
    TrackingController,
    TrackingProfilesController,
    WorkSessionsController,
  ],
  providers: [TrackingService],
  exports: [TrackingService],
})
export class TrackingModule {}
