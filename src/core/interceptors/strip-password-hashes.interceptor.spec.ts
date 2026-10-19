import { lastValueFrom, of } from 'rxjs';
import { isPasswordHash, stripPasswordHashes, StripPasswordHashesInterceptor } from './strip-password-hashes.interceptor';

/** Phase 2.2: login password hashes must not leak through `include: { user: true }` responses. */
const BCRYPT = '$2b$12$' + 'a'.repeat(53);
const PBKDF2 = 'pbkdf2_sha256$600000$salt123$aGFzaGhhc2hoYXNo';

describe('stripPasswordHashes', () => {
  it('recognises bcrypt and Django pbkdf2 hashes only', () => {
    expect(isPasswordHash(BCRYPT)).toBe(true);
    expect(isPasswordHash(PBKDF2)).toBe(true);
    expect(isPasswordHash('9f86d081884c7d659a2feaa0c55ad015')).toBe(false); // AES hex ciphertext
    expect(isPasswordHash('••••••••')).toBe(false);
    expect(isPasswordHash('plain')).toBe(false);
  });

  it('removes nested user password hashes and keeps everything else', () => {
    const body = {
      id: 1,
      assigned_to: { id: 5, username: 'm', password: BCRYPT },
      members: [{ user: { id: 6, password: PBKDF2, email: 'x@y.z' } }],
      credential: { password: '9f86d081884c7d659a2feaa0c55ad015' },
    };
    const out: any = stripPasswordHashes(body);
    expect(out.assigned_to).toEqual({ id: 5, username: 'm' });
    expect(out.members[0].user).toEqual({ id: 6, email: 'x@y.z' });
    expect(out.credential.password).toBe('9f86d081884c7d659a2feaa0c55ad015');
    expect(JSON.stringify(out)).not.toContain(BCRYPT);
  });

  it('leaves non-plain values untouched and survives cycles', () => {
    const buf = Buffer.from('pdf');
    const date = new Date('2026-10-17T00:00:00.000Z');
    const cyclic: any = { password: BCRYPT };
    cyclic.self = cyclic;
    const out: any = stripPasswordHashes({ buf, date, cyclic });
    expect(out.buf).toBe(buf);
    expect(out.date).toBe(date);
    expect(out.cyclic.password).toBeUndefined();
  });

  it('is applied by the interceptor', async () => {
    const interceptor = new StripPasswordHashesInterceptor();
    const result = await lastValueFrom(interceptor.intercept({} as any, { handle: () => of([{ password: BCRYPT, id: 1 }]) }));
    expect(result).toEqual([{ id: 1 }]);
  });
});
