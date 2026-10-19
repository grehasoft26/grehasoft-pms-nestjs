import { Test } from '@nestjs/testing';
import { CanActivate, ExecutionContext, INestApplication, UnauthorizedException } from '@nestjs/common';
import * as request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import { PrismaService } from '../../core/prisma.service';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { ProjectMembersController } from './members.controller';
import { ProjectMembersService } from './members.service';
import { MilestonesController } from './milestones.controller';
import { MilestonesService } from './milestones.service';
import { ProjectActivityLogsController } from './activity-logs.controller';
import { ProjectActivityLogsService } from './services/project-activity-logs.service';
import { ProgressAggregationService } from './services/progress-aggregation.service';
import { TasksController } from '../tasks/tasks.controller';
import { TasksService } from '../tasks/tasks.service';
import { TaskCommentsController } from '../tasks/task-comments.controller';
import { TaskCommentsService } from '../tasks/task-comments.service';
import { TaskFilesController } from '../tasks/task-files.controller';
import { TaskFilesService } from '../tasks/task-files.service';
import { TaskReviewsController } from '../tasks/task-reviews.controller';
import { TaskReviewsService } from '../tasks/task-reviews.service';
import { ReportsController } from '../reports/reports.controller';
import { ReportsService } from '../reports/reports.service';

/**
 * Phase 2.3: record-level authorization for projects, tasks and their nested resources.
 * Real controllers, services and PermissionsGuard over a small relational in-memory Prisma
 * fake (no database).
 *
 * Fixture
 *   Client 1 -> Project 1 (PM: pm1, not a member; members: admin, tm1, tm2)
 *   Client 2 -> Project 2 (PM: pm2; member: tm3)
 *   Task 1 (P1, assigned tm1, milestone 1), Task 2 (P1, unassigned), Task 3 (P2, assigned tm3)
 *   File 1 on task 1 (by tm1), file 2 on task 3 (by tm3); comment 1 on task 1, comment 2 on task 3;
 *   review 1 on file 1 (by pm1), review 2 on file 2 (by pm2).
 *
 * Roles: TEAM_MEMBER / SEO_EXECUTIVE as seeded. Seeded ADMIN and PROJECT_MANAGER hold only
 * MANAGE_PROJECTS / MANAGE_TASKS; here they also hold VIEW_PROJECTS / VIEW_TASKS, as a super
 * admin would grant for them to use the project screens (the frontend role defaults assume it).
 * `pmSeed` keeps the exact seeded permissions.
 */

// ----------------------------------------------------------------- in-memory Prisma fake
type Rel = { model: string; kind: 'one' | 'many'; fk: string };
const one = (model: string, fk: string): Rel => ({ model, kind: 'one', fk });
const many = (model: string, fk: string): Rel => ({ model, kind: 'many', fk });
const RELATIONS: Record<string, Record<string, Rel>> = {
  user: { role: one('role', 'role_id'), department: one('department', 'department_id'), client: one('client', 'client_id') },
  client: { portal_users: many('user', 'client_id'), projects: many('project', 'client_id') },
  project: {
    client: one('client', 'client_id'),
    project_manager: one('user', 'project_manager_id'),
    members: many('projectMember', 'project_id'),
    milestones: many('milestone', 'project_id'),
    tasks: many('task', 'project_id'),
  },
  projectMember: { project: one('project', 'project_id'), user: one('user', 'user_id') },
  milestone: { project: one('project', 'project_id') },
  task: {
    project: one('project', 'project_id'),
    task_type: one('taskType', 'task_type_id'),
    assignments: many('taskAssignment', 'task_id'),
    files: many('taskFile', 'task_id'),
    comments: many('taskComment', 'task_id'),
    progress_history: many('taskProgress', 'task_id'),
  },
  taskAssignment: { task: one('task', 'task_id'), employee: one('user', 'employee_id') },
  taskFile: { task: one('task', 'task_id') },
  taskComment: { task: one('task', 'task_id'), user: one('user', 'user_id') },
  taskReview: { task_file: one('taskFile', 'task_file_id'), reviewer: one('user', 'reviewer_id') },
  projectActivityLog: { project: one('project', 'project_id'), user: one('user', 'user_id') },
};

const buildFakePrisma = (tables: Record<string, any[]>) => {
  let nextId = 1000;
  const rows = (model: string) => (tables[model] ??= []);
  const related = (model: string, row: any, rel: Rel) =>
    rel.kind === 'one'
      ? rows(rel.model).find((r) => r.id === row[rel.fk]) ?? null
      : rows(rel.model).filter((r) => r[rel.fk] === row.id);

  const fieldMatches = (val: any, cond: any): boolean => {
    if (cond === null) return val === null || val === undefined;
    if (cond instanceof Date) return val instanceof Date && val.getTime() === cond.getTime();
    if (typeof cond !== 'object') return val === cond;
    return Object.entries(cond).every(([op, arg]: [string, any]) => {
      if (op === 'in') return arg.includes(val);
      if (op === 'notIn') return !arg.includes(val);
      if (op === 'not') return !fieldMatches(val, arg);
      if (op === 'equals') return val === arg;
      if (op === 'contains') return String(val ?? '').includes(arg);
      if (op === 'gte') return val >= arg;
      if (op === 'lte') return val <= arg;
      if (op === 'mode') return true;
      throw new Error(`fake prisma: unsupported operator ${op}`);
    });
  };

  const matches = (model: string, row: any, where: any = {}): boolean =>
    Object.entries(where).every(([key, cond]: [string, any]) => {
      if (cond === undefined) return true;
      if (key === 'AND') return (Array.isArray(cond) ? cond : [cond]).every((w) => matches(model, row, w));
      if (key === 'OR') return cond.some((w: any) => matches(model, row, w));
      if (key === 'NOT') return !matches(model, row, cond);
      const rel = RELATIONS[model]?.[key];
      if (!rel) return fieldMatches(row[key], cond);
      if (rel.kind === 'one') {
        const target = related(model, row, rel);
        return cond === null ? !target : !!target && matches(rel.model, target, cond);
      }
      const items = related(model, row, rel) as any[];
      if (cond.some) return items.some((i) => matches(rel.model, i, cond.some));
      if (cond.none) return !items.some((i) => matches(rel.model, i, cond.none));
      if (cond.every) return items.every((i) => matches(rel.model, i, cond.every));
      throw new Error(`fake prisma: unsupported list filter on ${model}.${key}`);
    });

  const shape = (model: string, row: any, args: any = {}): any => {
    if (!row) return row;
    const resolve = (key: string, sub: any) => {
      const rel = RELATIONS[model]?.[key];
      if (!rel) return row[key];
      const subArgs = sub === true ? {} : sub;
      if (rel.kind === 'one') {
        const t = related(model, row, rel);
        return t ? shape(rel.model, t, subArgs) : null;
      }
      return (related(model, row, rel) as any[])
        .filter((i) => matches(rel.model, i, subArgs.where))
        .map((i) => shape(rel.model, i, subArgs));
    };
    if (args.select) {
      return Object.fromEntries(Object.entries(args.select).filter(([, v]) => v).map(([k, v]) => [k, resolve(k, v)]));
    }
    const out = { ...row };
    for (const [k, v] of Object.entries(args.include ?? {})) if (v) out[k] = resolve(k, v);
    return out;
  };

  // @@unique constraints from prisma/schema.prisma; soft-deleted rows still count, as in MySQL
  const UNIQUE: Record<string, string[]> = {
    taskAssignment: ['task_id', 'employee_id'],
    projectMember: ['project_id', 'user_id'],
  };
  const assertUnique = (model: string, candidate: any, self?: any) => {
    const keys = UNIQUE[model];
    if (!keys) return;
    const clash = rows(model).find((r) => r !== self && keys.every((k) => r[k] === candidate[k]));
    if (clash) throw Object.assign(new Error(`Unique constraint failed on ${model}(${keys.join(', ')})`), { code: 'P2002' });
  };

  const delegate = (model: string) => ({
    findMany: jest.fn(async (args: any = {}) => {
      const found = rows(model).filter((r) => matches(model, r, args.where));
      const start = args.skip ?? 0;
      const sliced = found.slice(start, args.take !== undefined ? start + args.take : undefined);
      return sliced.map((r) => shape(model, r, args));
    }),
    findFirst: jest.fn(async (args: any = {}) => shape(model, rows(model).find((r) => matches(model, r, args.where)), args) ?? null),
    findUnique: jest.fn(async (args: any = {}) => shape(model, rows(model).find((r) => matches(model, r, args.where)), args) ?? null),
    count: jest.fn(async (args: any = {}) => rows(model).filter((r) => matches(model, r, args.where)).length),
    create: jest.fn(async (args: any) => {
      const now = new Date('2026-10-17T10:00:00.000Z');
      const row = { id: ++nextId, created_at: now, updated_at: now, deleted_at: null, ...args.data };
      assertUnique(model, row);
      rows(model).push(row);
      return shape(model, row, args);
    }),
    update: jest.fn(async (args: any) => {
      const row = rows(model).find((r) => matches(model, r, args.where));
      if (!row) throw new Error(`fake prisma: ${model} not found for update`);
      assertUnique(model, { ...row, ...args.data }, row);
      Object.assign(row, args.data);
      return shape(model, row, args);
    }),
    updateMany: jest.fn(async (args: any) => {
      const found = rows(model).filter((r) => matches(model, r, args.where));
      found.forEach((r) => Object.assign(r, args.data));
      return { count: found.length };
    }),
    delete: jest.fn(async (args: any) => {
      const list = rows(model);
      const idx = list.findIndex((r) => matches(model, r, args.where));
      const [removed] = list.splice(idx, 1);
      return removed;
    }),
  });

  return new Proxy({} as Record<string, any>, {
    get: (target, prop: string) => (target[prop] ??= delegate(prop)),
  });
};

// ----------------------------------------------------------------- fixture
const D = (s: string) => new Date(`${s}T00:00:00.000Z`);
const ADMIN_PERMS = [
  'MANAGE_USERS', 'MANAGE_ROLES', 'MANAGE_DEPARTMENTS', 'MANAGE_PROJECTS', 'MANAGE_TASKS', 'MANAGE_LEADS',
  'MANAGE_PROPOSALS', 'MANAGE_INVOICES', 'MANAGE_SEO', 'GENERATE_HR_DOCS', 'VIEW_DASHBOARD',
];
const VIEW = ['VIEW_PROJECTS', 'VIEW_TASKS'];

const buildTables = () => {
  const role = (id: number, name: string, permissions: string[]) => ({ id, name, permissions, deleted_at: null });
  const roles = [
    role(1, 'SUPER_ADMIN', []),
    role(2, 'ADMIN', [...ADMIN_PERMS, ...VIEW]),
    role(3, 'PROJECT_MANAGER', ['MANAGE_PROJECTS', 'MANAGE_TASKS', ...VIEW]),
    role(4, 'TEAM_MEMBER', ['VIEW_PROJECTS', 'VIEW_TASKS', 'MANAGE_TASKS']),
    role(5, 'CLIENT', []),
    role(6, 'SEO_EXECUTIVE', ['VIEW_PROJECTS', 'VIEW_TASKS', 'VIEW_SEO_TASKS']),
    role(7, 'PROJECT_MANAGER_SEEDED', ['MANAGE_PROJECTS', 'MANAGE_TASKS']),
  ];
  const user = (id: number, username: string, role_id: number, extra: any = {}) => ({
    id, username, name: username, email: `${username}@x.test`, role_id, is_superuser: false, is_active: true,
    department_id: null, client_id: null, deleted_at: null, created_at: D('2026-01-01'), last_login: null, ...extra,
  });
  const users = [
    user(1, 'super', 1),
    user(2, 'admin', 2),
    user(3, 'pm1', 3),
    user(4, 'pm2', 3),
    user(5, 'tm1', 4),
    user(6, 'tm2', 4),
    user(7, 'tm3', 4),
    user(8, 'client1', 5, { client_id: 1 }),
    user(9, 'client2', 5, { client_id: 2 }),
    user(10, 'seo', 6),
    user(11, 'adminOutsider', 2),
    // Same person as pm1 but with exactly the seeded PROJECT_MANAGER permissions
    user(12, 'pmSeed', 7),
  ];
  const project = (id: number, client_id: number, project_manager_id: number) => ({
    id, name: `Project ${id}`, description: '', client_id, department_id: null, project_manager_id, created_by_id: 1,
    start_date: D('2026-09-01'), end_date: D('2026-12-31'), status: 'in_progress', progress_percentage: 0,
    created_at: D('2026-09-01'), updated_at: D('2026-09-01'), deleted_at: null,
  });
  const task = (id: number, project_id: number, milestone_id: number | null) => ({
    id, project_id, milestone_id, task_type_id: 1, title: `Task ${id}`, description: '', priority: 'medium', status: 'todo',
    board_order: 0, due_date: D('2026-11-01'), created_by_id: 1, created_at: D('2026-09-02'), updated_at: D('2026-09-02'), deleted_at: null,
  });
  return {
    role: roles,
    user: users,
    client: [
      { id: 1, name: 'Acme', company_name: 'Acme', email: 'acme@x.test', deleted_at: null },
      { id: 2, name: 'Globex', company_name: 'Globex', email: 'globex@x.test', deleted_at: null },
    ],
    department: [{ id: 1, name: 'Engineering', deleted_at: null }],
    project: [project(1, 1, 3), project(2, 2, 4)],
    projectMember: [
      { id: 1, project_id: 1, user_id: 2, role_in_project: 'Member' },
      { id: 2, project_id: 1, user_id: 5, role_in_project: 'Developer' },
      { id: 3, project_id: 1, user_id: 6, role_in_project: 'Developer' },
      { id: 4, project_id: 2, user_id: 7, role_in_project: 'Developer' },
    ],
    milestone: [
      { id: 1, project_id: 1, title: 'M1', due_date: D('2026-10-30'), status: 'in_progress', progress: 0, created_at: D('2026-09-01') },
      { id: 2, project_id: 2, title: 'M2', due_date: D('2026-10-30'), status: 'in_progress', progress: 0, created_at: D('2026-09-01') },
    ],
    taskType: [{ id: 1, name: 'Development' }],
    task: [task(1, 1, 1), task(2, 1, null), task(3, 2, 2)],
    taskAssignment: [
      { id: 1, task_id: 1, employee_id: 5, assigned_by_id: 3, assigned_at: D('2026-09-02'), deleted_at: null },
      { id: 2, task_id: 3, employee_id: 7, assigned_by_id: 4, assigned_at: D('2026-09-02'), deleted_at: null },
    ],
    taskProgress: [],
    taskFile: [
      { id: 1, task_id: 1, uploaded_by_id: 5, file: 'task_files/a.png', file_path: 'a.png', file_type: 'image/png', revision_no: 1, uploaded_at: D('2026-09-03'), deleted_at: null },
      { id: 2, task_id: 3, uploaded_by_id: 7, file: 'task_files/b.png', file_path: 'b.png', file_type: 'image/png', revision_no: 1, uploaded_at: D('2026-09-03'), deleted_at: null },
    ],
    taskComment: [
      { id: 1, task_id: 1, user_id: 5, comment: 'P1 comment', created_at: D('2026-09-03'), deleted_at: null },
      { id: 2, task_id: 3, user_id: 7, comment: 'P2 comment', created_at: D('2026-09-03'), deleted_at: null },
    ],
    taskReview: [
      { id: 1, task_file_id: 1, reviewer_id: 3, reviewed_by_role: 'PM', review_version: 1, comments: '', status: 'changes_requested', reviewed_at: D('2026-09-04') },
      { id: 2, task_file_id: 2, reviewer_id: 4, reviewed_by_role: 'PM', review_version: 1, comments: '', status: 'changes_requested', reviewed_at: D('2026-09-04') },
    ],
    reminder: [
      { id: 1, user_id: 5, title: 'tm1 reminder', due_date: D('2099-01-01'), is_completed: false },
      { id: 2, user_id: 3, title: 'pm1 reminder', due_date: D('2099-01-01'), is_completed: false },
      { id: 3, user_id: 4, title: 'pm2 reminder', due_date: D('2000-01-01'), is_completed: false },
    ],
    invoice: [],
    projectActivityLog: [
      { id: 1, project_id: 1, user_id: 3, action: 'P1 log', created_at: D('2026-09-05') },
      { id: 2, project_id: 2, user_id: 4, action: 'P2 log', created_at: D('2026-09-05') },
    ],
  };
};

// ----------------------------------------------------------------- app
describe('Project and task record-level authorization (HTTP, Phase 2.3)', () => {
  let app: INestApplication;
  let tables: ReturnType<typeof buildTables>;
  // Task files live under <cwd>/media/task_files; point cwd at a temp dir so tests never touch ./media
  let workDir: string;

  beforeEach(async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-task-files-'));
    fs.mkdirSync(path.join(workDir, 'media', 'task_files'), { recursive: true });
    fs.writeFileSync(path.join(workDir, 'media', 'task_files', 'a.png'), 'PNG-ONE');
    fs.writeFileSync(path.join(workDir, 'media', 'task_files', 'b.png'), 'PNG-TWO');
    jest.spyOn(process, 'cwd').mockReturnValue(workDir);

    tables = buildTables();
    const prisma = buildFakePrisma(tables as any);
    class TestAuthGuard implements CanActivate {
      canActivate(context: ExecutionContext) {
        const req = context.switchToHttp().getRequest();
        const u = tables.user.find((x) => x.username === req.headers['x-test-user']);
        if (!u) throw new UnauthorizedException();
        req.user = { ...u, role: tables.role.find((r) => r.id === u.role_id) };
        return true;
      }
    }
    const moduleRef = await Test.createTestingModule({
      controllers: [
        ProjectsController, ProjectMembersController, MilestonesController, ProjectActivityLogsController,
        TasksController, TaskCommentsController, TaskFilesController, TaskReviewsController, ReportsController,
      ],
      providers: [
        ProjectsService, ProjectMembersService, MilestonesService, ProjectActivityLogsService, ProgressAggregationService,
        TasksService, TaskCommentsService, TaskFilesService, TaskReviewsService, ReportsService,
        { provide: PrismaService, useValue: prisma },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(TestAuthGuard)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  const as = (who: string) => ({
    get: (url: string) => request(app.getHttpServer()).get(url).set('x-test-user', who),
    post: (url: string, body: any = {}) => request(app.getHttpServer()).post(url).set('x-test-user', who).send(body),
    patch: (url: string, body: any = {}) => request(app.getHttpServer()).patch(url).set('x-test-user', who).send(body),
    delete: (url: string) => request(app.getHttpServer()).delete(url).set('x-test-user', who),
  });
  const ids = (body: any) => (Array.isArray(body) ? body : body.results).map((r: any) => r.id).sort();

  // --------------------------------------------------------------- projects
  describe('projects', () => {
    it.each([
      ['tm1', [1]], ['tm3', [2]], ['pm1', [1]], ['pm2', [2]], ['admin', [1]], ['adminOutsider', []],
      ['seo', []], ['client1', [1]], ['client2', [2]], ['super', [1, 2]],
    ])('GET /projects lists only projects in scope for %s', async (who, expected) => {
      const res = await as(who as string).get('/api/v1/projects?all=true');
      expect(res.status).toBe(200);
      expect(ids(res.body)).toEqual(expected);
    });

    it('a ?project_id= filter cannot reach an out-of-scope project', async () => {
      const res = await as('tm1').get('/api/v1/projects?all=true&project_id=2');
      expect(ids(res.body)).toEqual([]);
    });

    it.each([['tm1'], ['pm1'], ['admin'], ['seo']])('GET /projects/2 is 404 for %s (outside scope)', async (who) => {
      expect((await as(who).get('/api/v1/projects/2')).status).toBe(404);
    });

    it('GET /projects/:id works for members, the project manager, the owning client and super admins', async () => {
      expect((await as('tm3').get('/api/v1/projects/2')).status).toBe(200);
      expect((await as('pm2').get('/api/v1/projects/2')).status).toBe(200);
      expect((await as('client2').get('/api/v1/projects/2')).status).toBe(200);
      expect((await as('super').get('/api/v1/projects/2')).status).toBe(200);
      expect((await as('client1').get('/api/v1/projects/2')).status).toBe(403);
    });

    it('project managers can update only projects they manage or belong to', async () => {
      expect((await as('pm1').patch('/api/v1/projects/2', { name: 'Hijack' })).status).toBe(404);
      expect(tables.project.find((p) => p.id === 2)!.name).toBe('Project 2');
      expect((await as('pm1').patch('/api/v1/projects/1', { name: 'Renamed' })).status).toBe(200);
      expect(tables.project.find((p) => p.id === 1)!.name).toBe('Renamed');
    });

    it('the seeded PROJECT_MANAGER permissions still allow managing an in-scope project', async () => {
      tables.project[0].project_manager_id = 12;
      expect((await as('pmSeed').patch('/api/v1/projects/1', { status: 'on_hold' })).status).toBe(200);
      expect((await as('pmSeed').patch('/api/v1/projects/2', { status: 'on_hold' })).status).toBe(404);
    });

    it('ADMIN cannot delete or edit projects outside its scope; super admins can', async () => {
      expect((await as('admin').delete('/api/v1/projects/2')).status).toBe(404);
      expect((await as('adminOutsider').patch('/api/v1/projects/1', { name: 'x' })).status).toBe(404);
      expect(tables.project.find((p) => p.id === 2)!.deleted_at).toBeNull();
      expect((await as('super').delete('/api/v1/projects/2')).status).toBe(204);
    });

    it('rejects project manager, client and department ids that do not exist or are not staff', async () => {
      expect((await as('pm1').patch('/api/v1/projects/1', { project_manager: 8 })).status).toBe(400); // a CLIENT user
      expect((await as('pm1').patch('/api/v1/projects/1', { project_manager: 999 })).status).toBe(400);
      expect((await as('pm1').patch('/api/v1/projects/1', { client: 999 })).status).toBe(400);
      expect((await as('pm1').patch('/api/v1/projects/1', { department: 999 })).status).toBe(400);
      expect((await as('pm1').patch('/api/v1/projects/1', { project_manager: 4, department: 1 })).status).toBe(200);
    });

    it('a project created by a PM is in that PM\'s scope', async () => {
      const res = await as('pm1').post('/api/v1/projects', {
        name: 'New', client: 2, start_date: '2026-10-01', end_date: '2026-12-01',
      });
      expect(res.status).toBe(201);
      expect((await as('pm1').get(`/api/v1/projects/${res.body.id}`)).status).toBe(200);
      expect((await as('pm2').get(`/api/v1/projects/${res.body.id}`)).status).toBe(404);
    });

    it('GET /projects/:id/members requires project scope', async () => {
      expect((await as('tm1').get('/api/v1/projects/2/members')).status).toBe(404);
      const res = await as('tm1').get('/api/v1/projects/1/members');
      expect(res.status).toBe(200);
      expect(res.body.map((m: any) => m.id).sort()).toEqual([2, 5, 6]);
    });
  });

  // --------------------------------------------------------------- members
  describe('project members', () => {
    it('lists members of in-scope projects only', async () => {
      const all = await as('pm1').get('/api/v1/members');
      expect(all.body.results.map((m: any) => m.project)).toEqual([1, 1, 1]);
      expect((await as('pm1').get('/api/v1/members?project=2')).body).toEqual([]);
      expect((await as('super').get('/api/v1/members')).body.results).toHaveLength(4);
    });

    it('membership by id, update and delete are scoped', async () => {
      expect((await as('tm1').get('/api/v1/members/4')).status).toBe(404);
      expect((await as('pm1').patch('/api/v1/members/4', { role_in_project: 'Owner' })).status).toBe(404);
      expect((await as('pm1').delete('/api/v1/members/4')).status).toBe(404);
      expect(tables.projectMember).toHaveLength(4);
      expect((await as('pm1').patch('/api/v1/members/2', { role_in_project: 'Lead' })).status).toBe(200);
      expect((await as('pm1').delete('/api/v1/members/3')).status).toBe(204);
    });

    it('cannot add members to an out-of-scope project, or add client / unknown users', async () => {
      expect((await as('pm1').post('/api/v1/members', { project: 2, user: 5 })).status).toBe(404);
      expect((await as('pm1').post('/api/v1/members', { project: 1, user: 8 })).status).toBe(400);
      expect((await as('pm1').post('/api/v1/members', { project: 1, user: 999 })).status).toBe(400);
      expect(tables.projectMember).toHaveLength(4);
      expect((await as('pm1').post('/api/v1/members', { project: 1, user: 7, role_in_project: 'QA' })).status).toBe(201);
    });
  });

  // --------------------------------------------------------------- milestones & activity
  describe('milestones and activity logs', () => {
    it('milestone lists and reads are scoped', async () => {
      expect((await as('pm1').get('/api/v1/milestones')).body.results.map((m: any) => m.id)).toEqual([1]);
      expect((await as('pm1').get('/api/v1/milestones?project=2')).body).toEqual([]);
      expect((await as('client1').get('/api/v1/milestones')).body.results.map((m: any) => m.id)).toEqual([1]);
      expect((await as('pm1').get('/api/v1/milestones/2')).status).toBe(404);
      expect((await as('pm1').get('/api/v1/milestones/1')).status).toBe(200);
    });

    it('milestone writes are scoped', async () => {
      expect((await as('pm1').post('/api/v1/milestones', { project: 2, title: 'X', due_date: '2026-11-01' })).status).toBe(404);
      expect((await as('pm1').patch('/api/v1/milestones/2', { status: 'completed' })).status).toBe(404);
      expect((await as('admin').delete('/api/v1/milestones/2')).status).toBe(404);
      expect(tables.milestone.find((m) => m.id === 2)!.status).toBe('in_progress');
      expect((await as('pm1').patch('/api/v1/milestones/1', { status: 'completed' })).status).toBe(200);
      expect((await as('pm1').post('/api/v1/milestones', { project: 1, title: 'M3', due_date: '2026-11-01' })).status).toBe(201);
    });

    it('activity logs require project scope', async () => {
      expect((await as('tm1').get('/api/v1/project-activity-logs?project=2')).status).toBe(404);
      const own = await as('tm1').get('/api/v1/project-activity-logs?project=1');
      expect(own.body.map((l: any) => l.action)).toEqual(['P1 log']);
      // Not a client-portal route (the portal uses /client/projects/:id/activity)
      expect((await as('client1').get('/api/v1/project-activity-logs?project=1')).status).toBe(403);
    });
  });

  // --------------------------------------------------------------- tasks
  describe('tasks', () => {
    it.each([
      ['pm1', [1, 2]], ['tm1', [1, 2]], ['tm3', [3]], ['seo', []], ['client1', [1, 2]], ['super', [1, 2, 3]],
    ])('GET /tasks lists tasks of in-scope projects for %s', async (who, expected) => {
      const res = await as(who as string).get('/api/v1/tasks?all=true');
      expect(res.status).toBe(200);
      expect(ids(res.body)).toEqual(expected);
    });

    it('a ?project= filter cannot reach an out-of-scope project', async () => {
      expect(ids((await as('tm1').get('/api/v1/tasks?project=2')).body)).toEqual([]);
      expect(ids((await as('pm1').get('/api/v1/tasks?project=2')).body)).toEqual([]);
    });

    it('GET /tasks/:id requires project scope', async () => {
      expect((await as('tm1').get('/api/v1/tasks/3')).status).toBe(404);
      expect((await as('pm1').get('/api/v1/tasks/3')).status).toBe(404);
      expect((await as('client1').get('/api/v1/tasks/3')).status).toBe(403);
      expect((await as('tm3').get('/api/v1/tasks/3')).status).toBe(200);
      expect((await as('tm2').get('/api/v1/tasks/1')).status).toBe(200); // project member, not assigned
    });

    it('team members change status only on tasks assigned to them, inside their projects', async () => {
      expect((await as('tm1').patch('/api/v1/tasks/1', { status: 'in_progress' })).status).toBe(200);
      expect((await as('tm1').patch('/api/v1/tasks/2', { status: 'done' })).status).toBe(403); // unassigned
      expect((await as('tm1').patch('/api/v1/tasks/3', { status: 'done' })).status).toBe(404); // other project
      expect((await as('tm1').patch('/api/v1/tasks/1', { title: 'x' })).status).toBe(403);
      expect(tables.task.map((t) => t.status)).toEqual(['in_progress', 'todo', 'todo']);
    });

    it('project managers edit tasks only inside their scope (Kanban reorder is per-task too)', async () => {
      const statuses = await Promise.all([1, 2, 3].map((id) => as('pm1').patch(`/api/v1/tasks/${id}`, { board_order: 5 })));
      expect(statuses.map((r) => r.status)).toEqual([200, 200, 404]);
      expect(tables.task.find((t) => t.id === 3)!.board_order).toBe(0);
      expect((await as('pm1').patch('/api/v1/tasks/3', { title: 'Hijack' })).status).toBe(404);
    });

    it('task edits cannot attach a foreign milestone or a non-member assignee', async () => {
      expect((await as('pm1').patch('/api/v1/tasks/1', { milestone: 2 })).status).toBe(400);
      expect((await as('pm1').patch('/api/v1/tasks/1', { assignees: [7] })).status).toBe(400);
      expect(tables.task.find((t) => t.id === 1)!.milestone_id).toBe(1);
      expect((await as('pm1').patch('/api/v1/tasks/2', { assignees: [6] })).status).toBe(200);
    });

    it('tasks can only be created in in-scope projects with in-project references', async () => {
      const body = { title: 'T', task_type: 1, due_date: '2026-11-15' };
      expect((await as('pm1').post('/api/v1/tasks', { ...body, project: 2 })).status).toBe(404);
      expect((await as('seo').post('/api/v1/tasks', { ...body, project: 1 })).status).toBe(404);
      expect((await as('pm1').post('/api/v1/tasks', { ...body, project: 1, milestone: 2 })).status).toBe(400);
      expect((await as('tm1').post('/api/v1/tasks', { ...body, project: 1 })).status).toBe(403); // existing rule
      expect(tables.task).toHaveLength(3);
      const ok = await as('pm1').post('/api/v1/tasks', { ...body, project: 1, milestone: 1, assignees: [5] });
      expect(ok.status).toBe(201);
      expect(ok.body.assignees).toEqual([5]);
    });

    it('task deletion requires a manager role and project scope', async () => {
      expect((await as('pm1').delete('/api/v1/tasks/3')).status).toBe(404);
      expect((await as('tm1').delete('/api/v1/tasks/1')).status).toBe(403);
      expect((await as('admin').delete('/api/v1/tasks/2')).status).toBe(204);
      expect((await as('super').delete('/api/v1/tasks/3')).status).toBe(204);
    });
  });

  // --------------------------------------------------------------- comments, files, reviews
  describe('task comments', () => {
    it('lists and reads comments only within scope', async () => {
      expect(ids((await as('tm1').get('/api/v1/task-comments')).body)).toEqual([1]);
      expect(ids((await as('tm1').get('/api/v1/task-comments?task=3')).body)).toEqual([]);
      expect((await as('tm1').get('/api/v1/task-comments/2')).status).toBe(404);
      expect((await as('tm2').get('/api/v1/task-comments/1')).status).toBe(200);
      expect(ids((await as('client2').get('/api/v1/task-comments')).body)).toEqual([2]);
    });

    it('commenting requires project scope; members may comment on unassigned tasks', async () => {
      expect((await as('tm1').post('/api/v1/task-comments', { task: 3, comment: 'x' })).status).toBe(404);
      expect((await as('client2').post('/api/v1/task-comments', { task: 1, comment: 'x' })).status).toBe(403);
      expect((await as('tm2').post('/api/v1/task-comments', { task: 1, comment: 'on it' })).status).toBe(201);
      expect((await as('client1').post('/api/v1/task-comments', { task: 1, comment: 'thanks' })).status).toBe(201);
    });

    it('editing or deleting comments is scoped, and staff may only change their own', async () => {
      expect((await as('pm1').patch('/api/v1/task-comments/2', { comment: 'x' })).status).toBe(404);
      expect((await as('tm2').delete('/api/v1/task-comments/1')).status).toBe(403);
      expect((await as('pm1').patch('/api/v1/task-comments/1', { comment: 'edited' })).status).toBe(200);
      expect((await as('tm1').delete('/api/v1/task-comments/1')).status).toBe(204);
    });
  });

  describe('task files', () => {
    it('lists and reads files only within scope (PM/ADMIN no longer see every file)', async () => {
      expect(ids((await as('pm1').get('/api/v1/task-files')).body)).toEqual([1]);
      expect(ids((await as('admin').get('/api/v1/task-files')).body)).toEqual([1]);
      expect((await as('pm1').get('/api/v1/task-files/2')).status).toBe(404);
      expect((await as('client1').get('/api/v1/task-files/2')).status).toBe(403);
      expect((await as('tm3').get('/api/v1/task-files/2')).status).toBe(200);
    });

    it('client portal: a client lists only its own projects\' files, even when filtering by another client\'s task', async () => {
      expect(ids((await as('client1').get('/api/v1/task-files')).body)).toEqual([1]);
      expect(ids((await as('client2').get('/api/v1/task-files')).body)).toEqual([2]);
      expect(ids((await as('client1').get('/api/v1/task-files?task=1')).body)).toEqual([1]);
      expect(ids((await as('client1').get('/api/v1/task-files?task=3')).body)).toEqual([]);
    });

    it('uploads require project scope', async () => {
      expect((await as('tm1').post('/api/v1/task-files', { task: 3, name: 'x.txt' })).status).toBe(404);
      expect((await as('tm2').post('/api/v1/task-files', { task: 1, name: 'notes.txt' })).status).toBe(201);
    });

    it('only the uploader or a manager role inside the scope can delete a file', async () => {
      expect((await as('tm2').delete('/api/v1/task-files/1')).status).toBe(403);
      expect((await as('pm1').delete('/api/v1/task-files/2')).status).toBe(404);
      expect(tables.taskFile.every((f) => f.deleted_at === null)).toBe(true);
      expect((await as('tm1').delete('/api/v1/task-files/1')).status).toBe(204);
      expect((await as('pm2').delete('/api/v1/task-files/2')).status).toBe(204);
    });
  });

  describe('task reviews', () => {
    it('lists and reads reviews only within scope', async () => {
      expect(ids((await as('pm1').get('/api/v1/task-reviews')).body)).toEqual([1]);
      expect(ids((await as('pm1').get('/api/v1/task-reviews?task=3')).body)).toEqual([]);
      expect((await as('pm1').get('/api/v1/task-reviews/2')).status).toBe(404);
      expect((await as('tm1').get('/api/v1/task-reviews/1')).status).toBe(200);
    });

    it('reviews can only be created for in-scope files', async () => {
      expect((await as('pm1').post('/api/v1/task-reviews', { task_file: 2, status: 'approved' })).status).toBe(404);
      expect(tables.taskReview).toHaveLength(2);
      expect((await as('pm1').post('/api/v1/task-reviews', { task_file: 1, status: 'approved' })).status).toBe(201);
    });

    it('reviewers keep editing their own in-scope reviews', async () => {
      expect((await as('pm2').patch('/api/v1/task-reviews/2', { comments: 'ok' })).status).toBe(200);
      expect((await as('pm1').patch('/api/v1/task-reviews/2', { comments: 'x' })).status).toBe(404);
    });
  });

  // --------------------------------------------------------------- Phase 2.4
  describe('task assignee updates (Phase 2.4: unique task/person constraint)', () => {
    const active = (taskId: number) =>
      tables.taskAssignment.filter((a) => a.task_id === taskId && !a.deleted_at).map((a) => a.employee_id).sort();
    const rowsFor = (taskId: number, userId: number) =>
      tables.taskAssignment.filter((a) => a.task_id === taskId && a.employee_id === userId);

    it('re-saving a task with unchanged assignees works and keeps the original assignment', async () => {
      for (let i = 0; i < 2; i++) {
        const res = await as('pm1').patch('/api/v1/tasks/1', { title: `Task 1 v${i}`, assignees: [5] });
        expect(res.status).toBe(200);
        expect(res.body.assignees).toEqual([5]);
      }
      expect(rowsFor(1, 5)).toEqual([expect.objectContaining({ id: 1, deleted_at: null, assigned_at: D('2026-09-02') })]);
    });

    it('adds and removes assignees; removal is a soft delete with unassigned_at', async () => {
      expect((await as('pm1').patch('/api/v1/tasks/1', { assignees: [5, 6] })).status).toBe(200);
      expect(active(1)).toEqual([5, 6]);

      const res = await as('pm1').patch('/api/v1/tasks/1', { assignees: [6] });
      expect(res.status).toBe(200);
      expect(res.body.assignees).toEqual([6]);
      expect(rowsFor(1, 5)).toEqual([expect.objectContaining({ deleted_at: expect.any(Date), unassigned_at: expect.any(Date) })]);
    });

    it('re-adding a previously removed assignee restores the row instead of duplicating it', async () => {
      expect((await as('pm1').patch('/api/v1/tasks/1', { assignees: [] })).status).toBe(200);
      expect(active(1)).toEqual([]);
      const res = await as('pm1').patch('/api/v1/tasks/1', { assignees: [5] });
      expect(res.status).toBe(200);
      expect(rowsFor(1, 5)).toHaveLength(1);
      expect(rowsFor(1, 5)[0]).toMatchObject({ deleted_at: null, unassigned_at: null, assigned_by_id: 3 });
    });

    it('duplicate ids are collapsed on update and create', async () => {
      expect((await as('pm1').patch('/api/v1/tasks/2', { assignees: [6, 6, '6'] })).status).toBe(200);
      expect(rowsFor(2, 6)).toHaveLength(1);
      const created = await as('pm1').post('/api/v1/tasks', { project: 1, title: 'T', task_type: 1, due_date: '2026-11-15', assignees: [5, 5] });
      expect(created.status).toBe(201);
      expect(created.body.assignees).toEqual([5]);
    });

    it('rejects invalid assignees without changing existing assignments', async () => {
      expect((await as('pm1').patch('/api/v1/tasks/1', { assignees: [7] })).status).toBe(400); // other project
      expect((await as('pm1').patch('/api/v1/tasks/1', { assignees: ['abc'] })).status).toBe(400);
      expect((await as('pm1').patch('/api/v1/tasks/1', { assignees: [999] })).status).toBe(400);
      expect(active(1)).toEqual([5]);
    });
  });

  describe('Kanban updates by team members (Phase 2.4)', () => {
    it('assignees may change status and progress of their own task', async () => {
      expect((await as('tm1').patch('/api/v1/tasks/1', { status: 'in_progress' })).status).toBe(200);
      expect((await as('tm1').patch('/api/v1/tasks/1', { progress_percentage: 50 })).status).toBe(200);
      expect(tables.taskProgress).toEqual([expect.objectContaining({ task_id: 1, progress_percentage: 50, updated_by_id: 5 })]);
    });

    it('team members cannot reorder the board or update tasks they are not assigned to', async () => {
      expect((await as('tm1').patch('/api/v1/tasks/1', { board_order: 3 })).status).toBe(403);
      expect((await as('tm1').patch('/api/v1/tasks/1', { status: 'done', board_order: 1 })).status).toBe(403);
      expect((await as('tm2').patch('/api/v1/tasks/1', { progress_percentage: 50 })).status).toBe(403);
      expect((await as('tm2').patch('/api/v1/tasks/1', { status: 'done' })).status).toBe(403);
      expect(tables.task.find((t) => t.id === 1)).toMatchObject({ status: 'todo', board_order: 0 });
      expect(tables.taskProgress).toEqual([]);
    });

    it('project managers can reorder tasks in their projects', async () => {
      expect((await as('pm1').patch('/api/v1/tasks/2', { board_order: 0 })).status).toBe(200);
      expect((await as('pm1').patch('/api/v1/tasks/1', { board_order: 1 })).status).toBe(200);
    });
  });

  describe('task file download and preview (Phase 2.4)', () => {
    const binary = (req: request.Test) =>
      req.buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    const addFile = (row: any) =>
      tables.taskFile.push({ task_id: 1, uploaded_by_id: 5, file_type: 'text/html', revision_no: 1, uploaded_at: D('2026-09-03'), deleted_at: null, ...row });

    it('project members download files as attachments without exposing the storage path', async () => {
      const res = await binary(as('tm2').get('/api/v1/task-files/1/download/'));
      expect(res.status).toBe(200);
      expect(res.body.toString()).toBe('PNG-ONE');
      expect(res.headers['content-type']).toBe('application/octet-stream');
      expect(res.headers['content-disposition']).toContain('attachment; filename="a.png"');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(JSON.stringify(res.headers)).not.toContain('task_files');
    });

    it('previews safe types inline', async () => {
      const res = await binary(as('pm1').get('/api/v1/task-files/1/preview'));
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['content-disposition']).toMatch(/^inline;/);
    });

    it.each([
      ['tm1', 404], ['pm1', 404], ['seo', 404], ['admin', 404], ['client1', 403],
      ['tm3', 200], ['pm2', 200], ['client2', 200], ['super', 200],
    ])('download of a file in project 2 by %s -> %i', async (who, status) => {
      expect((await binary(as(who as string).get('/api/v1/task-files/2/download'))).status).toBe(status);
      expect((await binary(as(who as string).get('/api/v1/task-files/2/preview'))).status).toBe(status);
    });

    it('guessed, deleted or missing files return 404', async () => {
      expect((await as('super').get('/api/v1/task-files/999/download')).status).toBe(404);
      tables.taskFile[0].deleted_at = D('2026-10-01');
      expect((await as('tm1').get('/api/v1/task-files/1/download')).status).toBe(404);
      addFile({ id: 30, file: 'task_files/gone.png', file_path: 'gone.png' });
      expect((await as('tm1').get('/api/v1/task-files/30/download')).status).toBe(404);
      addFile({ id: 31, file: null, file_path: 'legacy.png' });
      expect((await as('tm1').get('/api/v1/task-files/31/download')).status).toBe(404);
    });

    it('stored paths outside media/task_files are never served', async () => {
      fs.writeFileSync(path.join(workDir, 'secret.txt'), 'SECRET');
      fs.writeFileSync(path.join(workDir, 'media', 'other.txt'), 'OTHER');
      addFile({ id: 32, file: '../secret.txt', file_path: 'x.txt' });
      addFile({ id: 33, file: 'task_files/../../secret.txt', file_path: 'x.txt' });
      addFile({ id: 34, file: 'other.txt', file_path: 'x.txt' });
      addFile({ id: 35, file: path.join(workDir, 'secret.txt'), file_path: 'x.txt' });
      for (const id of [32, 33, 34, 35]) {
        const res = await binary(as('super').get(`/api/v1/task-files/${id}/download`));
        expect(res.status).toBe(404);
        expect(res.body.toString()).not.toContain('SECRET');
      }
    });

    it('active content is download-only (no inline preview)', async () => {
      fs.writeFileSync(path.join(workDir, 'media', 'task_files', 'page.html'), '<script>alert(1)</script>');
      addFile({ id: 36, file: 'task_files/page.html', file_path: 'page.html' });
      expect((await as('tm1').get('/api/v1/task-files/36/preview')).status).toBe(415);
      const res = await binary(as('tm1').get('/api/v1/task-files/36/download'));
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/octet-stream');
    });

    it('uploads are stored under a generated name and can be downloaded again', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/task-files')
        .set('x-test-user', 'tm2')
        .field('task', '1')
        .attach('file', Buffer.from('hello notes'), 'notes.txt');
      expect(res.status).toBe(201);
      expect(res.body.file_path).toBe('notes.txt');
      expect(JSON.stringify(res.body)).not.toContain('task_files');
      const row = tables.taskFile.find((f) => f.id === res.body.id)!;
      expect(row.file).toMatch(/^task_files\/task_1_\d+_[0-9a-f]{12}\.txt$/);

      const download = await binary(as('tm1').get(`/api/v1/task-files/${res.body.id}/download`));
      expect(download.body.toString()).toBe('hello notes');
      const preview = await binary(as('tm1').get(`/api/v1/task-files/${res.body.id}/preview`));
      expect(preview.headers['content-type']).toBe('text/plain; charset=utf-8');
    });

    it('uploads to out-of-scope tasks are refused and nothing is written', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/task-files')
        .set('x-test-user', 'tm1')
        .field('task', '3')
        .attach('file', Buffer.from('x'), 'x.txt');
      expect(res.status).toBe(404);
      expect(fs.readdirSync(path.join(workDir, 'media', 'task_files')).sort()).toEqual(['a.png', 'b.png']);
    });
  });

  describe('dashboard counts (Phase 2.4)', () => {
    const stats = async (who: string) => {
      const res = await as(who).get('/api/v1/dashboard/stats');
      expect(res.status).toBe(200);
      return res.body;
    };
    const summary = (b: any) => ({
      projects: b.projects.total,
      tasks: b.tasks.completed + b.tasks.pending,
      clients: b.clients.active,
      reminders: b.reminders.pending + b.reminders.overdue + b.reminders.completed,
    });

    it('super admins keep company-wide totals', async () => {
      expect(summary(await stats('super'))).toEqual({ projects: 2, tasks: 3, clients: 2, reminders: 3 });
    });

    it.each([
      ['pm1', { projects: 1, tasks: 2, clients: 1, reminders: 1 }],
      ['pm2', { projects: 1, tasks: 1, clients: 1, reminders: 1 }],
      ['admin', { projects: 1, tasks: 2, clients: 1, reminders: 0 }],
      ['adminOutsider', { projects: 0, tasks: 0, clients: 0, reminders: 0 }],
      ['seo', { projects: 0, tasks: 0, clients: 0, reminders: 0 }],
    ])('other staff (%s) only count their projects and own reminders', async (who, expected) => {
      expect(summary(await stats(who as string))).toEqual(expected);
    });

    it('team members count their projects and current assignments only', async () => {
      const before = await stats('tm1');
      expect(before.projects.total).toBe(1);
      expect(before.tasks.completed + before.tasks.pending).toBe(1);
      tables.taskAssignment[0].deleted_at = D('2026-10-01'); // removed from task 1
      const after = await stats('tm1');
      expect(after.tasks.completed + after.tasks.pending).toBe(0);
    });

    it('soft-deleted projects and tasks are not counted', async () => {
      tables.project[1].deleted_at = D('2026-10-01');
      tables.task[1].deleted_at = D('2026-10-01');
      expect(summary(await stats('super'))).toMatchObject({ projects: 1, tasks: 1, clients: 1 });
      expect((await stats('client2')).metrics.total_projects).toBe(0);
      expect((await stats('client1')).metrics).toMatchObject({ total_projects: 1, completed_tasks: 0, pending_tasks: 1 });
    });

    it('the company-wide quarterly report requires MANAGE_SETTINGS', async () => {
      for (const who of ['tm1', 'pm1', 'admin', 'seo']) {
        expect((await as(who).get('/api/v1/dashboard/quarterly-report')).status).toBe(403);
      }
      expect((await as('super').get('/api/v1/dashboard/quarterly-report')).status).toBe(200);
    });
  });

  describe('task creation policy (Phase 2.4)', () => {
    const body = { project: 1, title: 'T', task_type: 1, due_date: '2026-11-15' };

    it('VIEW_TASKS alone no longer allows creating tasks, even inside the user\'s project', async () => {
      tables.projectMember.push({ id: 50, project_id: 1, user_id: 10, role_in_project: 'SEO' });
      expect((await as('seo').get('/api/v1/tasks/1')).status).toBe(200); // in scope
      expect((await as('seo').post('/api/v1/tasks', body)).status).toBe(403);
      expect(tables.task).toHaveLength(3);
    });

    it('MANAGE_PROJECTS holders and super admins still create tasks', async () => {
      expect((await as('pm1').post('/api/v1/tasks', body)).status).toBe(201);
      expect((await as('admin').post('/api/v1/tasks', body)).status).toBe(201);
      expect((await as('super').post('/api/v1/tasks', { ...body, project: 2 })).status).toBe(201);
    });
  });

  it('super admins keep full access across projects', async () => {
    const s = as('super');
    expect((await s.get('/api/v1/tasks/3')).status).toBe(200);
    expect((await s.patch('/api/v1/tasks/3', { title: 'Renamed' })).status).toBe(200);
    expect((await s.get('/api/v1/task-files/2')).status).toBe(200);
    expect((await s.post('/api/v1/members', { project: 2, user: 5 })).status).toBe(201);
    expect((await s.get('/api/v1/project-activity-logs?project=2')).status).toBe(200);
  });
});
