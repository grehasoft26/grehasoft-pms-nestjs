import { Module } from '@nestjs/common';
import { RemindersService } from './reminders.service';
import { RemindersController, DashboardSummaryController } from './reminders.controller';

@Module({
  controllers: [RemindersController, DashboardSummaryController],
  providers: [RemindersService],
  exports: [RemindersService],
})
export class RemindersModule {}
