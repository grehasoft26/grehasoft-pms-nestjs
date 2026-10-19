import { Test } from '@nestjs/testing';
import { CanActivate, ExecutionContext, INestApplication, UnauthorizedException } from '@nestjs/common';
import * as request from 'supertest';
import { JwtAuthGuard } from './jwt-auth.guard';
import { ClientsController } from '../../modules/projects/clients.controller';
import { ProjectsController } from '../../modules/projects/projects.controller';
import { TasksController } from '../../modules/tasks/tasks.controller';
import { TaskCommentsController } from '../../modules/tasks/task-comments.controller';
import { LeadsController } from '../../modules/crm/leads.controller';
import { ServersController, DomainsController, CredentialsController } from '../../modules/infrastructure/infrastructure.controller';
import { InvoicesController } from '../../modules/invoices/invoices.controller';
import { InvoicePaymentsController } from '../../modules/invoices/invoice-payments.controller';
import { TrackingController, TrackingProfilesController } from '../../modules/tracking/tracking.controller';
import { ReportsController } from '../../modules/reports/reports.controller';
import { FinancialReportsController } from '../../modules/financial-reports/financial-reports.controller';
import { SeoReportsController } from '../../modules/seo-reports/seo-reports.controller';
import { ClientPortalController } from '../../modules/client-portal/client-portal.controller';
import { MilestonesController } from '../../modules/projects/milestones.controller';
import { TaskFilesController } from '../../modules/tasks/task-files.controller';
import { TaskReviewsController } from '../../modules/tasks/task-reviews.controller';
import { InfrastructureSummaryController } from '../../modules/infrastructure/infrastructure.controller';

/**
 * Phase 2.2: route-level authorization matrix. Real controllers and the real PermissionsGuard;
 * every service is an auto-mock, so a 403 can only come from the guard. Roles mirror
 * prisma/seed.ts (ADMIN, TEAM_MEMBER, CLIENT) plus custom roles holding a single permission.
 */
const ADMIN_PERMS = [
  'MANAGE_USERS', 'MANAGE_ROLES', 'MANAGE_DEPARTMENTS', 'MANAGE_PROJECTS', 'MANAGE_TASKS', 'MANAGE_LEADS',
  'MANAGE_PROPOSALS', 'MANAGE_INVOICES', 'MANAGE_SEO', 'GENERATE_HR_DOCS', 'VIEW_DASHBOARD',
];

const role = (name: string, permissions: string[]) => ({ id: name.length, name, permissions, deleted_at: null });
const USERS: Record<string, any> = {
  super: { id: 1, is_superuser: false, role: role('SUPER_ADMIN', []) },
  admin: { id: 2, is_superuser: false, role: role('ADMIN', ADMIN_PERMS) },
  member: { id: 3, is_superuser: false, role: role('TEAM_MEMBER', ['VIEW_DASHBOARD', 'VIEW_PROJECTS', 'VIEW_TASKS', 'MANAGE_TASKS']) },
  client: { id: 4, is_superuser: false, client_id: 1, role: role('CLIENT', ['VIEW_DASHBOARD']) },
  ops: { id: 5, is_superuser: false, role: role('OPS', ['MANAGE_INFRASTRUCTURE']) },
  settings: { id: 6, is_superuser: false, role: role('SETTINGS_ADMIN', ['MANAGE_SETTINGS']) },
  billing: { id: 7, is_superuser: false, role: role('BILLING_VIEWER', ['VIEW_INVOICES']) },
  finance: { id: 8, is_superuser: false, role: role('FINANCE', ['VIEW_FINANCIAL_REPORTS']) },
  leadsViewer: { id: 9, is_superuser: false, role: role('LEADS_VIEWER', ['VIEW_LEADS']) },
  // A role literally named CLIENT is only trusted while active
  deletedClient: { id: 10, is_superuser: false, client_id: 1, role: { ...role('CLIENT', ['VIEW_DASHBOARD']), deleted_at: new Date('2026-09-01') } },
};

// Any service method resolves to an empty object; 'then' stays undefined so Nest does not treat mocks as promises
const autoMock = () =>
  new Proxy({} as Record<string | symbol, unknown>, {
    get: (target, prop) => {
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      if (!(prop in target)) target[prop] = jest.fn(async () => ({}));
      return target[prop];
    },
  });

type Case = [method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, allowed: string[], denied: string[]];

const CASES: Record<string, Case[]> = {
  'CLIENT is limited to @ClientAccess() client routes': [
    ['get', '/api/v1/clients', ['super', 'client'], ['member', 'deletedClient']],
    ['get', '/api/v1/clients/1', ['super', 'client'], ['member']],
    ['patch', '/api/v1/clients/1', ['super', 'client'], ['member']],
    ['post', '/api/v1/clients', ['super'], ['client', 'member']],
    ['put', '/api/v1/clients/1', ['super'], ['client']],
    ['delete', '/api/v1/clients/1', ['super'], ['client']],
    ['get', '/api/v1/clients/dashboard-stats', ['super'], ['client']],
    ['get', '/api/v1/clients/1/projects', ['super'], ['client']],
    ['post', '/api/v1/clients/1/create-portal-account', ['super'], ['client']],
    ['post', '/api/v1/clients/1/edit-portal-user-username', ['super'], ['client']],
    ['post', '/api/v1/clients/1/reset-portal-user-password', ['super'], ['client']],
    ['post', '/api/v1/clients/1/toggle-portal-user-status', ['super'], ['client']],
    ['post', '/api/v1/clients/1/delete-portal-user', ['super'], ['client']],
    ['get', '/api/v1/clients/1/portal-user-audit', ['super'], ['client']],
    ['post', '/api/v1/clients/1/portal-users/2/send-invitation', ['super'], ['client']],
    ['post', '/api/v1/clients/1/portal-users/2/reset-password', ['super'], ['client']],
  ],
  'CLIENT cannot reach project/task writes or unmarked reads': [
    ['get', '/api/v1/projects', ['member', 'client'], []],
    ['get', '/api/v1/projects/1', ['member', 'client'], []],
    ['get', '/api/v1/projects/1/members', ['member'], ['client']],
    ['post', '/api/v1/projects', ['admin'], ['client', 'member']],
    ['get', '/api/v1/tasks', ['member', 'client'], []],
    ['get', '/api/v1/tasks/1', ['member'], ['client']],
    ['post', '/api/v1/tasks', ['member'], ['client']],
    ['patch', '/api/v1/tasks/1', ['member'], ['client']],
    ['delete', '/api/v1/tasks/1', ['member'], ['client']],
    ['get', '/api/v1/task-comments', ['member', 'client'], []],
    ['post', '/api/v1/task-comments', ['member', 'client'], []],
    ['patch', '/api/v1/task-comments/1', ['member'], ['client']],
    ['delete', '/api/v1/task-comments/1', ['member'], ['client']],
  ],
  // Every request the client portal pages make (pages/client/*) passes the guard for CLIENT;
  // record-level scoping is tested in project-task-scope.http.spec. The by-id staff routes below
  // are not used by the portal and stay closed to CLIENT (no @ClientAccess, no bypass).
  'client portal workflow routes': [
    ['get', '/api/v1/client/dashboard/overview', ['client'], []],
    ['get', '/api/v1/client/projects/1/activity', ['client'], []],
    ['get', '/api/v1/dashboard/documents', ['client'], []],
    ['get', '/api/v1/dashboard/client-notifications', ['client'], []],
    ['get', '/api/v1/milestones', ['client'], []],
    ['get', '/api/v1/task-files', ['client'], []],
    ['get', '/api/v1/invoices/1/download', ['client'], []],
    ['get', '/api/v1/milestones/1', ['member'], ['client']],
    ['get', '/api/v1/task-files/1', ['member'], ['client']],
    ['get', '/api/v1/task-comments/1', ['member'], ['client']],
    ['get', '/api/v1/task-reviews', ['member'], ['client']],
    ['get', '/api/v1/task-reviews/1', ['member'], ['client']],
    ['post', '/api/v1/task-reviews', [], ['client', 'member']],
  ],
  'CLIENT cannot read leads or financial reports': [
    ['get', '/api/v1/leads', ['super', 'leadsViewer'], ['client', 'member']],
    ['get', '/api/v1/leads/1', ['super', 'leadsViewer'], ['client', 'member']],
    ['post', '/api/v1/leads/1/convert_to_project', ['admin'], ['client', 'leadsViewer']],
    ['get', '/api/v1/financial/dashboard', ['finance'], ['client', 'member']],
    ['get', '/api/v1/financial/reports/income-expense', ['finance'], ['client']],
    ['get', '/api/v1/seo-reports', ['super', 'client'], ['member']],
  ],
  'infrastructure writes require MANAGE_INFRASTRUCTURE': [
    ['get', '/api/v1/infrastructure/domains', ['member', 'ops'], []],
    // Overview totals: same access as the lists (scoped in the service)
    ['get', '/api/v1/infrastructure/summary', ['member', 'ops', 'super', 'client'], []],
    ['post', '/api/v1/infrastructure/servers', ['ops', 'super'], ['member', 'admin', 'client']],
    ['put', '/api/v1/infrastructure/servers/1', ['ops'], ['member']],
    ['patch', '/api/v1/infrastructure/servers/1', ['ops'], ['member']],
    ['delete', '/api/v1/infrastructure/servers/1', ['ops'], ['member', 'admin']],
    ['post', '/api/v1/infrastructure/domains', ['ops'], ['member']],
    // Name availability for the domain form: same permission as saving a domain
    ['get', '/api/v1/infrastructure/domains/check-name?name=a.test', ['ops', 'super'], ['member', 'client']],
    ['patch', '/api/v1/infrastructure/domains/1', ['ops'], ['member']],
    ['delete', '/api/v1/infrastructure/domains/1', ['ops'], ['member']],
    ['post', '/api/v1/infrastructure/credentials', ['ops'], ['member']],
    ['put', '/api/v1/infrastructure/credentials/1', ['ops'], ['member']],
    ['delete', '/api/v1/infrastructure/credentials/1', ['ops'], ['member', 'client']],
  ],
  'invoices and payments require invoice permissions': [
    ['get', '/api/v1/invoices', ['admin', 'billing', 'leadsViewer', 'client'], ['member', 'finance']],
    ['get', '/api/v1/invoices/1', ['admin', 'billing', 'client'], ['member']],
    ['get', '/api/v1/invoices/next-number', ['admin', 'billing'], ['member', 'client']],
    ['get', '/api/v1/invoices/analytics', ['admin', 'billing'], ['member', 'client']],
    ['post', '/api/v1/invoices', ['admin', 'leadsViewer'], ['member', 'client', 'billing']],
    ['put', '/api/v1/invoices/1', ['admin'], ['member', 'client', 'billing']],
    ['patch', '/api/v1/invoices/1', ['admin'], ['member', 'client']],
    ['delete', '/api/v1/invoices/1', ['admin'], ['member', 'client', 'billing']],
    ['get', '/api/v1/invoices/1/secure-link', ['admin'], ['member', 'client', 'billing']],
    ['post', '/api/v1/invoices/1/send_email', ['admin'], ['member', 'client']],
    ['post', '/api/v1/invoices/preview', [], ['member', 'client', 'billing']],
    ['get', '/api/v1/invoices/1/download', [], ['member']],
    ['get', '/api/v1/invoice-payments', ['admin', 'billing'], ['member', 'client']],
    ['get', '/api/v1/invoice-payments/1', ['admin', 'billing'], ['member', 'client']],
    ['post', '/api/v1/invoice-payments', ['admin'], ['member', 'client', 'billing']],
    ['patch', '/api/v1/invoice-payments/1', ['admin'], ['member', 'client']],
    ['delete', '/api/v1/invoice-payments/1', ['admin'], ['member', 'client']],
    ['get', '/api/v1/invoice-payments/1/secure-link', ['admin'], ['member', 'client', 'billing']],
    ['get', '/api/v1/invoice-payments/1/receipt', [], ['member', 'client']],
  ],
  'tracking administration requires MANAGE_SETTINGS': [
    ['get', '/api/v1/tracking/employee-status', ['settings', 'super'], ['member', 'admin', 'client']],
    ['get', '/api/v1/tracking/employee-status/3', ['settings'], ['member']],
    ['post', '/api/v1/tracking/toggle-tracking/3', ['settings'], ['member', 'admin']],
    ['get', '/api/v1/tracking/reports/daily', ['settings'], ['member']],
    ['get', '/api/v1/tracking/reports/weekly', ['settings'], ['member']],
    ['get', '/api/v1/tracking/reports/monthly', ['settings'], ['member']],
    ['get', '/api/v1/tracking/reports/employee-analytics', ['settings'], ['member']],
    ['get', '/api/v1/tracking/profiles', ['settings'], ['member', 'admin']],
    ['get', '/api/v1/tracking/profiles/1', ['settings'], ['member']],
    // Self-service tracking used by every signed-in employee stays open
    ['post', '/api/v1/tracking/heartbeat', ['member', 'admin'], []],
    ['get', '/api/v1/tracking/user-status', ['member'], []],
  ],
};

describe('RBAC route matrix (HTTP, Phase 2.2)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    class TestAuthGuard implements CanActivate {
      canActivate(context: ExecutionContext) {
        const req = context.switchToHttp().getRequest();
        const user = USERS[String(req.headers['x-test-user'])];
        if (!user) throw new UnauthorizedException();
        req.user = user;
        return true;
      }
    }
    const moduleRef = await Test.createTestingModule({
      controllers: [
        ClientsController, ProjectsController, TasksController, TaskCommentsController, LeadsController,
        ServersController, DomainsController, CredentialsController, InvoicesController, InvoicePaymentsController,
        TrackingController, TrackingProfilesController, ReportsController, FinancialReportsController, SeoReportsController,
        ClientPortalController, MilestonesController, TaskFilesController, TaskReviewsController, InfrastructureSummaryController,
      ],
    })
      .useMocker(() => autoMock())
      .overrideGuard(JwtAuthGuard)
      .useClass(TestAuthGuard)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const call = (method: Case[0], path: string, who: string) =>
    request(app.getHttpServer())[method](path).set('x-test-user', who).send({}).timeout(3000);

  for (const [group, cases] of Object.entries(CASES)) {
    describe(group, () => {
      for (const [method, path, allowed, denied] of cases) {
        for (const who of denied) {
          it(`${method.toUpperCase()} ${path} denies ${who}`, async () => {
            const res = await call(method, path, who);
            expect(res.status).toBe(403);
          });
        }
        for (const who of allowed) {
          it(`${method.toUpperCase()} ${path} allows ${who}`, async () => {
            const res = await call(method, path, who);
            // 404 would mean the route is not registered here, so nothing was checked
            expect([401, 403, 404]).not.toContain(res.status);
          });
        }
      }
    });
  }

  it('rejects unauthenticated requests', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/invoices');
    expect(res.status).toBe(401);
  });
});
