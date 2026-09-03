import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CoreModule } from './core/core.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { RolesModule } from './modules/roles/roles.module';
import { DepartmentsModule } from './modules/departments/departments.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { CrmModule } from './modules/crm/crm.module';
import { ProposalsModule } from './modules/proposals/proposals.module';
import { InvoicesModule } from './modules/invoices/invoices.module';
import { SeoModule } from './modules/seo/seo.module';
import { InfrastructureModule } from './modules/infrastructure/infrastructure.module';
import { HrModule } from './modules/hr/hr.module';
import { TrackingModule } from './modules/tracking/tracking.module';
import { RemindersModule } from './modules/reminders/reminders.module';
import { ClientPortalModule } from './modules/client-portal/client-portal.module';
import { ReportsModule } from './modules/reports/reports.module';

@Module({
  imports: [
    CoreModule,
    AuthModule,
    UsersModule,
    RolesModule,
    DepartmentsModule,
    ProjectsModule,
    TasksModule,
    CrmModule,
    ProposalsModule,
    InvoicesModule,
    SeoModule,
    InfrastructureModule,
    HrModule,
    TrackingModule,
    RemindersModule,
    ClientPortalModule,
    ReportsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
