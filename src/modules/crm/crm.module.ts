import { Module } from '@nestjs/common';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';
import { LeadFollowupsController } from './lead-followups.controller';
import { LeadFollowupsService } from './lead-followups.service';
import { LeadAssignmentsController } from './lead-assignments.controller';
import { LeadAssignmentsService } from './lead-assignments.service';

@Module({
  controllers: [
    LeadsController,
    LeadFollowupsController,
    LeadAssignmentsController,
  ],
  providers: [
    LeadsService,
    LeadFollowupsService,
    LeadAssignmentsService,
  ],
  exports: [
    LeadsService,
    LeadFollowupsService,
    LeadAssignmentsService,
  ],
})
export class CrmModule {}
