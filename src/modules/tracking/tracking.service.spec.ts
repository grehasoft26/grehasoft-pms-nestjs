import { Test, TestingModule } from '@nestjs/testing';
import { TrackingService } from './tracking.service';
import { PrismaService } from '../../core/prisma.service';

describe('TrackingService — Daily Productive Time Parity Tests', () => {
  let service: TrackingService;
  let workSessionsDb: any[];
  let usersDb: any[];
  let appActivitiesDb: any[];

  beforeEach(async () => {
    workSessionsDb = [];
    usersDb = [
      {
        id: 1,
        name: 'User One',
        username: 'user1',
        email: 'user1@example.com',
        tracking_profile: { is_tracking_enabled: true, screenshots_enabled: true },
      },
      {
        id: 2,
        name: 'User Two',
        username: 'user2',
        email: 'user2@example.com',
        tracking_profile: { is_tracking_enabled: true, screenshots_enabled: true },
      },
    ];
    appActivitiesDb = [];

    const mockPrismaService = {
      user: {
        findMany: jest.fn().mockImplementation(({ where }) => {
          let matches = [...usersDb];
          if (where?.id) {
            if (typeof where.id === 'number') matches = matches.filter((u) => u.id === where.id);
            else if (where.id.in) matches = matches.filter((u) => where.id.in.includes(u.id));
          }
          if (where?.department_id) {
            matches = matches.filter((u) => u.employee?.department_id === where.department_id || u.department_id === where.department_id);
          }
          if (where?.OR) {
            matches = matches.filter((u) => {
              return where.OR.some((cond: any) => {
                if (cond.name?.contains && u.name.includes(cond.name.contains)) return true;
                if (cond.username?.contains && u.username.includes(cond.username.contains)) return true;
                if (cond.email?.contains && u.email.includes(cond.email.contains)) return true;
                return false;
              });
            });
          }
          return Promise.resolve(matches);
        }),
        findUnique: jest.fn().mockImplementation(({ where }) => {
          return Promise.resolve(usersDb.find((u) => u.id === where.id) || null);
        }),
      },
      trackingUserProfile: {
        findUnique: jest.fn().mockImplementation(({ where }) => {
          return Promise.resolve({
            id: 1,
            user_id: where.user_id,
            is_tracking_enabled: true,
            screenshots_enabled: true,
          });
        }),
      },
      workSession: {
        findFirst: jest.fn().mockImplementation(({ where, orderBy }) => {
          let matches = workSessionsDb.filter((s) => s.user_id === where.user_id);
          if (where.is_active_session !== undefined) {
            matches = matches.filter((s) => s.is_active_session === where.is_active_session);
          }
          if (where.login_time?.gte) {
            matches = matches.filter((s) => s.login_time >= where.login_time.gte);
          }
          if (orderBy?.login_time === 'asc') {
            matches.sort((a, b) => a.login_time.getTime() - b.login_time.getTime());
          } else if (orderBy?.login_time === 'desc') {
            matches.sort((a, b) => b.login_time.getTime() - a.login_time.getTime());
          } else if (orderBy?.last_ping === 'desc') {
            matches.sort((a, b) => b.last_ping.getTime() - a.last_ping.getTime());
          }
          return Promise.resolve(matches[0] || null);
        }),
        findMany: jest.fn().mockImplementation(({ where }) => {
          let matches = [...workSessionsDb];
          if (where?.user_id) {
            if (typeof where.user_id === 'number') {
              matches = matches.filter((s) => s.user_id === where.user_id);
            } else if (where.user_id.in) {
              matches = matches.filter((s) => where.user_id.in.includes(s.user_id));
            }
          }
          if (where?.login_time) {
            if (where.login_time.gte) matches = matches.filter((s) => s.login_time >= where.login_time.gte);
            if (where.login_time.lte) matches = matches.filter((s) => s.login_time <= where.login_time.lte);
          }
          if (where?.OR) {
            matches = matches.filter((s) => {
              return where.OR.some((cond: any) => {
                if (cond.login_time?.gte && s.login_time >= cond.login_time.gte) return true;
                if (cond.is_active_session !== undefined && s.is_active_session === cond.is_active_session) return true;
                return false;
              });
            });
          }
          return Promise.resolve(matches);
        }),
      },
      appActivity: {
        findFirst: jest.fn().mockImplementation(({ where }) => {
          let matches = appActivitiesDb.filter((a) => a.session_id === where.session_id);
          if (where.user_id) matches = matches.filter((a) => a.user_id === where.user_id);
          return Promise.resolve(matches[matches.length - 1] || null);
        }),
        findMany: jest.fn().mockImplementation(({ where }) => {
          let matches = appActivitiesDb;
          if (where.session_id) matches = matches.filter((a) => a.session_id === where.session_id);
          if (where.user_id) matches = matches.filter((a) => a.user_id === where.user_id);
          return Promise.resolve(matches);
        }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TrackingService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    service = module.get<TrackingService>(TrackingService);
  });

  it('A-E: should persist Session 1 productive time and retain it after Session 2 starts with near 0 session timer', async () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const session1Login = new Date(today.getTime() + 10 * 60 * 1000); // 00:10 AM
    const session1LastPing = new Date(today.getTime() + 17 * 60 * 1000); // 00:17 AM

    // Session 1: Worked 7 mins (420 seconds productive time), now closed
    workSessionsDb.push({
      id: 101,
      user_id: 1,
      login_time: session1Login,
      last_ping: session1LastPing,
      logout_time: session1LastPing,
      is_active_session: false,
      device_id: 'device_win1',
      productive_seconds: 420,
      idle_seconds: 0,
      mouse_moves: 100,
      key_presses: 200,
      clicks: 50,
      is_desktop_idle: false,
      last_desktop_ping: session1LastPing,
    });

    // Session 2: User starts tracking again currently
    const session2NowPing = new Date();
    const session2Login = new Date(session2NowPing.getTime() - 6000); // 6 seconds ago

    workSessionsDb.push({
      id: 102,
      user_id: 1,
      login_time: session2Login,
      last_ping: session2NowPing,
      logout_time: null,
      is_active_session: true,
      device_id: 'device_win1',
      productive_seconds: 6,
      idle_seconds: 0,
      mouse_moves: 10,
      key_presses: 15,
      clicks: 2,
      is_desktop_idle: false,
      last_desktop_ping: session2NowPing,
    });

    const status: any = await service.getEmployeeStatus(1);

    // Verify Session Timer / login_time belongs to Session 2
    expect(status.login_time).toBe(session2Login.toISOString());
    expect(status.session_id).toBe(102);

    // Verify today's Productive Time contains Session 1 (420s) + Session 2 (6s) = 426s -> 00:07:06
    expect(status.productive_time).toBe('00:07:06');
    expect(status.total_work_time).toBe('00:07:06');
  });

  it('F: should accumulate Productive Time as Session 2 progresses (Session 1 + Session 2)', async () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const session1Login = new Date(today.getTime() + 10 * 60 * 1000);
    workSessionsDb.push({
      id: 101,
      user_id: 1,
      login_time: session1Login,
      last_ping: new Date(today.getTime() + 17 * 60 * 1000),
      logout_time: new Date(today.getTime() + 17 * 60 * 1000),
      is_active_session: false,
      device_id: 'device_win1',
      productive_seconds: 420,
      idle_seconds: 0,
      mouse_moves: 100,
      key_presses: 200,
      clicks: 50,
    });

    const session2Login = new Date(today.getTime() + 30 * 60 * 1000);
    const session2Now = new Date();
    workSessionsDb.push({
      id: 102,
      user_id: 1,
      login_time: session2Login,
      last_ping: session2Now,
      logout_time: null,
      is_active_session: true,
      device_id: 'device_win1',
      productive_seconds: 180, // 3 mins in Session 2
      idle_seconds: 30,
      mouse_moves: 80,
      key_presses: 120,
      clicks: 30,
      is_desktop_idle: false,
      last_desktop_ping: session2Now,
    });

    const status: any = await service.getEmployeeStatus(1);

    // Session 1 (420s) + Session 2 (180s) = 600s -> 00:10:00
    expect(status.productive_time).toBe('00:10:00');
    expect(status.total_work_time).toBe('00:10:00');
  });

  it('G-H: should accumulate Productive Time and Idle Time correctly across 3 sessions', async () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    workSessionsDb.push(
      {
        id: 201,
        user_id: 1,
        login_time: new Date(today.getTime() + 1 * 3600 * 1000),
        last_ping: new Date(today.getTime() + 2 * 3600 * 1000),
        logout_time: new Date(today.getTime() + 2 * 3600 * 1000),
        is_active_session: false,
        device_id: 'device_win1',
        productive_seconds: 1800, // 30m
        idle_seconds: 300, // 5m
        mouse_moves: 500,
        key_presses: 1000,
        clicks: 200,
      },
      {
        id: 202,
        user_id: 1,
        login_time: new Date(today.getTime() + 3 * 3600 * 1000),
        last_ping: new Date(today.getTime() + 4 * 3600 * 1000),
        logout_time: new Date(today.getTime() + 4 * 3600 * 1000),
        is_active_session: false,
        device_id: 'device_win1',
        productive_seconds: 1200, // 20m
        idle_seconds: 600, // 10m
        mouse_moves: 300,
        key_presses: 600,
        clicks: 100,
      },
      {
        id: 203,
        user_id: 1,
        login_time: new Date(today.getTime() + 5 * 3600 * 1000),
        last_ping: new Date(),
        logout_time: null,
        is_active_session: true,
        device_id: 'device_win1',
        productive_seconds: 600, // 10m
        idle_seconds: 300, // 5m
        mouse_moves: 200,
        key_presses: 400,
        clicks: 80,
        is_desktop_idle: false,
        last_desktop_ping: new Date(),
      },
    );

    const status: any = await service.getEmployeeStatus(1);

    // Productive: 1800 + 1200 + 600 = 3600s -> 01:00:00
    expect(status.productive_time).toBe('01:00:00');
    expect(status.total_work_time).toBe('01:00:00');

    // Idle: 300 + 600 + 300 = 1200s -> 00:20:00
    expect(status.idle_time).toBe('00:20:00');
    expect(status.non_productive_time).toBe('00:20:00');
  });

  it('I: should isolate metrics between different users', async () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // User 1 session
    workSessionsDb.push({
      id: 301,
      user_id: 1,
      login_time: new Date(today.getTime() + 1 * 3600 * 1000),
      last_ping: new Date(),
      logout_time: null,
      is_active_session: true,
      device_id: 'dev1',
      productive_seconds: 300, // 5 mins
      idle_seconds: 60,
      mouse_moves: 50,
      key_presses: 100,
      clicks: 20,
      is_desktop_idle: false,
      last_desktop_ping: new Date(),
    });

    // User 2 session
    workSessionsDb.push({
      id: 302,
      user_id: 2,
      login_time: new Date(today.getTime() + 1 * 3600 * 1000),
      last_ping: new Date(),
      logout_time: null,
      is_active_session: true,
      device_id: 'dev2',
      productive_seconds: 3600, // 60 mins
      idle_seconds: 300,
      mouse_moves: 500,
      key_presses: 1000,
      clicks: 200,
      is_desktop_idle: false,
      last_desktop_ping: new Date(),
    });

    const statusUser1: any = await service.getEmployeeStatus(1);
    const statusUser2: any = await service.getEmployeeStatus(2);

    expect(statusUser1.productive_time).toBe('00:05:00');
    expect(statusUser2.productive_time).toBe('01:00:00');
  });

  describe('Reports & Analytics Parity Tests (A-M)', () => {
    const todayStr = new Date().toISOString().split('T')[0];

    beforeEach(() => {
      usersDb[0].employee = { department_id: 10, department: { id: 10, name: 'Engineering' } };
      usersDb[1].employee = { department_id: 20, department: { id: 20, name: 'Sales' } };
    });

    it('A & C-E: Today report returns correct productive, idle, activity % for single session', async () => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      workSessionsDb.push({
        id: 401,
        user_id: 1,
        login_time: new Date(today.getTime() + 9 * 3600 * 1000),
        last_ping: new Date(today.getTime() + 10 * 3600 * 1000),
        logout_time: new Date(today.getTime() + 10 * 3600 * 1000),
        is_active_session: false,
        device_id: 'dev1',
        productive_seconds: 2700, // 45m
        idle_seconds: 900, // 15m
      });

      const report = await service.getDailyReport({ date: todayStr });
      expect(report.length).toBe(1);
      expect(report[0].user_id).toBe(1);
      expect(report[0].productive_time).toBe('00:45:00');
      expect(report[0].idle_time).toBe('00:15:00');
      expect(report[0].activity_percentage).toBe(75);
    });

    it('B: Today report aggregates multiple WorkSessions for same user', async () => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      workSessionsDb.push(
        {
          id: 402,
          user_id: 1,
          login_time: new Date(today.getTime() + 9 * 3600 * 1000),
          last_ping: new Date(today.getTime() + 10 * 3600 * 1000),
          logout_time: new Date(today.getTime() + 10 * 3600 * 1000),
          is_active_session: false,
          device_id: 'dev1',
          productive_seconds: 1800, // 30m
          idle_seconds: 600, // 10m
        },
        {
          id: 403,
          user_id: 1,
          login_time: new Date(today.getTime() + 11 * 3600 * 1000),
          last_ping: new Date(today.getTime() + 12 * 3600 * 1000),
          logout_time: new Date(today.getTime() + 12 * 3600 * 1000),
          is_active_session: false,
          device_id: 'dev1',
          productive_seconds: 1800, // 30m
          idle_seconds: 600, // 10m
        },
      );

      const report = await service.getDailyReport({ date: todayStr });
      expect(report.length).toBe(1);
      expect(report[0].productive_time).toBe('01:00:00');
      expect(report[0].idle_time).toBe('00:20:00');
      expect(report[0].activity_percentage).toBe(75);
    });

    it('F: Multiple users remain isolated in report', async () => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      workSessionsDb.push(
        {
          id: 404,
          user_id: 1,
          login_time: new Date(today.getTime() + 9 * 3600 * 1000),
          last_ping: new Date(today.getTime() + 10 * 3600 * 1000),
          logout_time: new Date(today.getTime() + 10 * 3600 * 1000),
          is_active_session: false,
          device_id: 'dev1',
          productive_seconds: 3600, // 60m
          idle_seconds: 0,
        },
        {
          id: 405,
          user_id: 2,
          login_time: new Date(today.getTime() + 9 * 3600 * 1000),
          last_ping: new Date(today.getTime() + 10 * 3600 * 1000),
          logout_time: new Date(today.getTime() + 10 * 3600 * 1000),
          is_active_session: false,
          device_id: 'dev2',
          productive_seconds: 1800, // 30m
          idle_seconds: 1800, // 30m
        },
      );

      const report = await service.getDailyReport({ date: todayStr });
      expect(report.length).toBe(2);

      const r1 = report.find((r: any) => r.user_id === 1);
      const r2 = report.find((r: any) => r.user_id === 2);

      expect(r1.productive_time).toBe('01:00:00');
      expect(r2.productive_time).toBe('00:30:00');
    });

    it('G: Date range filtering works', async () => {
      const pastDate = new Date('2026-01-15T09:00:00Z');
      workSessionsDb.push({
        id: 406,
        user_id: 1,
        login_time: pastDate,
        last_ping: new Date(pastDate.getTime() + 3600 * 1000),
        logout_time: new Date(pastDate.getTime() + 3600 * 1000),
        is_active_session: false,
        device_id: 'dev1',
        productive_seconds: 3600,
        idle_seconds: 0,
      });

      const reportPast = await service.getDailyReport({ start_date: '2026-01-15', end_date: '2026-01-15' });
      expect(reportPast.length).toBe(1);
      expect(reportPast[0].date).toBe('2026-01-15');

      const reportToday = await service.getDailyReport({ date: todayStr });
      expect(reportToday.length).toBe(0);
    });

    it('H: Department filtering works', async () => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      workSessionsDb.push(
        {
          id: 407,
          user_id: 1,
          login_time: new Date(today.getTime() + 9 * 3600 * 1000),
          last_ping: new Date(today.getTime() + 10 * 3600 * 1000),
          logout_time: new Date(today.getTime() + 10 * 3600 * 1000),
          is_active_session: false,
          device_id: 'dev1',
          productive_seconds: 3600,
          idle_seconds: 0,
        },
        {
          id: 408,
          user_id: 2,
          login_time: new Date(today.getTime() + 9 * 3600 * 1000),
          last_ping: new Date(today.getTime() + 10 * 3600 * 1000),
          logout_time: new Date(today.getTime() + 10 * 3600 * 1000),
          is_active_session: false,
          device_id: 'dev2',
          productive_seconds: 1800,
          idle_seconds: 0,
        },
      );

      const reportDept10 = await service.getDailyReport({ date: todayStr, department_id: 10 });
      expect(reportDept10.length).toBe(1);
      expect(reportDept10[0].user_id).toBe(1);
    });

    it('I: Employee search/filter works', async () => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      workSessionsDb.push({
        id: 409,
        user_id: 1,
        login_time: new Date(today.getTime() + 9 * 3600 * 1000),
        last_ping: new Date(today.getTime() + 10 * 3600 * 1000),
        logout_time: new Date(today.getTime() + 10 * 3600 * 1000),
        is_active_session: false,
        device_id: 'dev1',
        productive_seconds: 3600,
        idle_seconds: 0,
      });

      const reportSearch = await service.getDailyReport({ date: todayStr, search: 'user1' });
      expect(reportSearch.length).toBe(1);
      expect(reportSearch[0].username).toBe('user1');
    });

    it('J, K, L: CSV, Excel, PDF exports return valid content and response headers', async () => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      workSessionsDb.push({
        id: 410,
        user_id: 1,
        login_time: new Date(today.getTime() + 9 * 3600 * 1000),
        last_ping: new Date(today.getTime() + 10 * 3600 * 1000),
        logout_time: new Date(today.getTime() + 10 * 3600 * 1000),
        is_active_session: false,
        device_id: 'dev1',
        productive_seconds: 3600,
        idle_seconds: 0,
      });

      let csvHeader: any = {};
      let csvData = '';
      const mockCsvRes = {
        set: (h: any) => Object.assign(csvHeader, h),
        send: (d: any) => (csvData = d),
      };
      await service.exportReport(mockCsvRes, { type: 'daily', format: 'csv', date: todayStr });
      expect(csvHeader['Content-Type']).toBe('text/csv');
      expect(csvData).toContain('Employee Name');
      expect(csvData).toContain('User One');

      let excelHeader: any = {};
      let excelData: Buffer | null = null;
      const mockExcelRes = {
        set: (h: any) => Object.assign(excelHeader, h),
        send: (d: any) => (excelData = d),
      };
      await service.exportReport(mockExcelRes, { type: 'daily', format: 'excel', date: todayStr });
      expect(excelHeader['Content-Type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      expect(excelData).toBeDefined();

      let pdfHeader: any = {};
      let pdfData: Buffer | null = null;
      const mockPdfRes = {
        set: (h: any) => Object.assign(pdfHeader, h),
        send: (d: any) => (pdfData = d),
      };
      await service.exportReport(mockPdfRes, { type: 'daily', format: 'pdf', date: todayStr });
      expect(pdfHeader['Content-Type']).toBe('application/pdf');
      expect(pdfData).toBeDefined();
    });

    it('M: Empty date range returns empty report rows gracefully', async () => {
      const report = await service.getDailyReport({ start_date: '2020-01-01', end_date: '2020-01-01' });
      expect(report).toEqual([]);

      const weekly = await service.getWeeklyReport({ start_date: '2020-01-01', end_date: '2020-01-07' });
      expect(weekly.attendance_days).toBe(0);
      expect(weekly.total_weekly_hours).toBe('00:00:00');
    });
  });
});
