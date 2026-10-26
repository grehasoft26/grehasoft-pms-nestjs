import {
  Controller,
  Get,
  INestApplication,
  Param,
  Request,
  UseGuards,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import * as jwt from 'jsonwebtoken';
import * as request from 'supertest';
import { JwtStrategy } from './jwt.strategy';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PrismaService } from '../prisma.service';
import { Public } from '../decorators/public.decorator';

/**
 * JWTs are accepted only from the Authorization header. A token in the URL (?token=) leaks into
 * server and proxy logs, browser history and Referer headers, so it no longer authenticates any
 * route. Public routes, including the signed invoice links (their own purpose-limited token in
 * the path, not a JWT), are unaffected. Real strategy and guard, real signed tokens.
 */
const SECRET = 'test-jwt-secret-for-query-token-spec';
const user = {
  id: 7,
  username: 'staff',
  is_active: true,
  deleted_at: null,
  role: { id: 2, name: 'DEVELOPER', permissions: [], deleted_at: null },
};

@Controller('probe')
@UseGuards(JwtAuthGuard)
class ProbeController {
  @Get('me')
  me(@Request() req: any) {
    return { id: req.user.id };
  }

  // Stand-in for a file download route: authenticated like every other route
  @Get('files/:id/download')
  download(@Param('id') id: string) {
    return { file: id };
  }

  // Stand-in for invoices/public/:token/download (signed link checked by its own service)
  @Public()
  @Get('public/:linkToken/download')
  publicDownload(@Param('linkToken') linkToken: string) {
    return { link: linkToken.length };
  }
}

describe('JWT transport: Authorization header only (no ?token=)', () => {
  let app: INestApplication;
  const findFirst = jest.fn(async ({ where }: any) =>
    where.id === user.id ? user : null,
  );
  const sign = (payload: object, secret = SECRET) =>
    jwt.sign(payload, secret, { expiresIn: '5m' });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [ProbeController],
      providers: [
        JwtStrategy,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => (key === 'JWT_SECRET' ? SECRET : undefined),
          },
        },
        { provide: PrismaService, useValue: { user: { findFirst } } },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => findFirst.mockClear());

  it('a valid token in the Authorization header authenticates', async () => {
    const res = await request(app.getHttpServer())
      .get('/probe/me')
      .set('Authorization', `Bearer ${sign({ sub: 7 })}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 7 });
  });

  it('the same valid token in ?token= is refused (401) on ordinary routes', async () => {
    const token = sign({ sub: 7 });
    for (const path of [
      `/probe/me?token=${token}`,
      `/probe/files/3/download?token=${token}`,
    ]) {
      const res = await request(app.getHttpServer()).get(path);
      expect({ path: path.split('?')[0], status: res.status }).toEqual({
        path: path.split('?')[0],
        status: 401,
      });
    }
    // The token in the URL was never even used to look up a user
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('a header token still works when a (junk) ?token= is also sent; the query value is ignored', async () => {
    const res = await request(app.getHttpServer())
      .get('/probe/me?token=not-a-jwt')
      .set('Authorization', `Bearer ${sign({ sub: 7 })}`);
    expect(res.status).toBe(200);
  });

  it('no token, a bad header token, or an expired header token: 401', async () => {
    expect((await request(app.getHttpServer()).get('/probe/me')).status).toBe(
      401,
    );
    expect(
      (
        await request(app.getHttpServer())
          .get('/probe/me')
          .set('Authorization', `Bearer ${sign({ sub: 7 }, 'wrong-secret')}`)
      ).status,
    ).toBe(401);
    const expired = jwt.sign(
      { sub: 7, exp: Math.floor(Date.now() / 1000) - 60 },
      SECRET,
    );
    expect(
      (
        await request(app.getHttpServer())
          .get('/probe/me')
          .set('Authorization', `Bearer ${expired}`)
      ).status,
    ).toBe(401);
  });

  it('public routes (e.g. signed invoice links) still work without a JWT', async () => {
    const res = await request(app.getHttpServer()).get(
      '/probe/public/abc.def/download',
    );
    expect(res.status).toBe(200);
  });

  it('the strategy is configured with the Authorization-header extractor only', () => {
    const strategy: any = app.get(JwtStrategy);
    const token = sign({ sub: 7 });
    expect(
      strategy._jwtFromRequest({
        headers: {},
        query: { token },
        url: `/x?token=${token}`,
      }),
    ).toBeNull();
    expect(
      strategy._jwtFromRequest({
        headers: { authorization: `Bearer ${token}` },
        query: {},
      }),
    ).toBe(token);
  });
});
