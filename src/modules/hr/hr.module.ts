import { Module } from '@nestjs/common';
import { HrService } from './hr.service';
import { EmployeesController, HrDocumentsController } from './hr.controller';

@Module({
  controllers: [EmployeesController, HrDocumentsController],
  providers: [HrService],
  exports: [HrService],
})
export class HrModule {}
