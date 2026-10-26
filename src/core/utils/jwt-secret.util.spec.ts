import * as fs from 'fs';
import * as path from 'path';
import * as jsonwebtoken from 'jsonwebtoken';
import { ConfigService } from '@nestjs/config';

// @nestjs/jwt ships as an ES module this Jest setup cannot load (auth.refresh-token.spec mocks it
// too); JwtService signs and verifies with jsonwebtoken, used directly below with the same options
jest.mock('@nestjs/jwt', () => ({ JwtModule: { registerAsync: () => class MockJwtModule {} }, JwtService: class {} }));
import { JWT_SECRET_MISSING_MESSAGE, requireJwtSecret } from './jwt-secret.util';
import { JwtStrategy } from '../guards/jwt.strategy';
import { jwtModuleOptionsFactory } from '../../modules/auth/auth.module';

/** JWT_SECRET has no fallback: missing or blank fails closed in both places that use it. */
const configOf = (env: Record<string, string | undefined>) => ({ get: (k: string) => env[k] }) as unknown as ConfigService;
const SECRET = 'unit-test-jwt-secret-' + 'x'.repeat(20);

describe('JWT secret configuration', () => {
  it('returns a configured secret unchanged (existing tokens stay valid)', () => {
    expect(requireJwtSecret(configOf({ JWT_SECRET: SECRET }))).toBe(SECRET);
    expect(requireJwtSecret(configOf({ JWT_SECRET: ` ${SECRET} ` }))).toBe(` ${SECRET} `);
  });

  it.each([
    ['missing', {}],
    ['empty', { JWT_SECRET: '' }],
    ['whitespace only', { JWT_SECRET: '   ' }],
  ])('fails closed when JWT_SECRET is %s', (_label, env) => {
    expect(() => requireJwtSecret(configOf(env as any))).toThrow(JWT_SECRET_MISSING_MESSAGE);
  });

  it('the error never contains a secret value', () => {
    try {
      requireJwtSecret(configOf({ JWT_SECRET: '  ' }));
    } catch (error) {
      expect((error as Error).message).toBe(JWT_SECRET_MISSING_MESSAGE);
    }
  });

  describe('AuthModule JwtModule options', () => {
    it('use the configured secret and keep the 1 day expiry', () => {
      expect(jwtModuleOptionsFactory(configOf({ JWT_SECRET: SECRET }))).toEqual({ secret: SECRET, signOptions: { expiresIn: '1d' } });
    });

    it('refuse to build without JWT_SECRET (application startup fails)', () => {
      expect(() => jwtModuleOptionsFactory(configOf({}))).toThrow(JWT_SECRET_MISSING_MESSAGE);
      expect(() => jwtModuleOptionsFactory(configOf({ JWT_SECRET: '' }))).toThrow(JWT_SECRET_MISSING_MESSAGE);
    });

    it('tokens signed with the configured secret verify; tokens signed with anything else do not', () => {
      const options = jwtModuleOptionsFactory(configOf({ JWT_SECRET: SECRET }));
      const secret = options.secret as string;
      const token = jsonwebtoken.sign({ sub: 7, username: 'u' }, secret, options.signOptions as jsonwebtoken.SignOptions);
      expect(jsonwebtoken.verify(token, secret)).toMatchObject({ sub: 7, username: 'u' });

      const forged = jsonwebtoken.sign({ sub: 7 }, 'grehasoft-jwt-secret-key-production-change-me');
      expect(() => jsonwebtoken.verify(forged, secret)).toThrow();
    });
  });

  describe('JwtStrategy', () => {
    const prisma: any = { user: { findFirst: jest.fn() } };

    it('constructs with a configured secret', () => {
      expect(() => new JwtStrategy(configOf({ JWT_SECRET: SECRET }), prisma)).not.toThrow();
    });

    it('refuses to construct without JWT_SECRET (application startup fails)', () => {
      expect(() => new JwtStrategy(configOf({}), prisma)).toThrow(JWT_SECRET_MISSING_MESSAGE);
      expect(() => new JwtStrategy(configOf({ JWT_SECRET: '   ' }), prisma)).toThrow(JWT_SECRET_MISSING_MESSAGE);
    });
  });

  it('no hard-coded JWT secret fallback remains in the backend source', () => {
    const src = path.resolve(__dirname, '..', '..');
    const files = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) return files(full);
        return e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts') ? [full] : [];
      });
    // The old hard-coded JWT secret appears nowhere
    const withLiteral = files(src).filter((f) => fs.readFileSync(f, 'utf8').includes('grehasoft-jwt-secret-key-production-change-me'));
    expect(withLiteral.map((f) => path.relative(src, f))).toEqual([]);

    // JWT authentication (signing and verification) reads JWT_SECRET only through requireJwtSecret.
    // (HR and invoice link signing still use JWT_SECRET as a later fallback: a separate cleanup task.)
    for (const file of ['core/guards/jwt.strategy.ts', 'modules/auth/auth.module.ts']) {
      const text = fs.readFileSync(path.join(src, file), 'utf8');
      expect(text).toContain('requireJwtSecret(');
      expect(text).not.toMatch(/JWT_SECRET'\)\s*\|\|/);
    }
  });
});
