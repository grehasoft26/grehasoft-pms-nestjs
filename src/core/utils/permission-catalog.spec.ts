import * as fs from 'fs';
import * as path from 'path';
import {
  BUILT_IN_ROLE_NAMES,
  KNOWN_PERMISSIONS,
  PERMISSION_CATEGORIES,
  PERMISSION_DEFINITIONS,
  ROLE_MANAGEMENT_PERMISSION,
  isBuiltInRoleName,
  isKnownPermission,
} from './permission-catalog';

/**
 * Keeps the permission catalog and built-in role list in sync with the code that uses them.
 * Reads source files only (no database).
 */
const SRC = path.resolve(__dirname, '..', '..');
const ROOT = path.resolve(SRC, '..');

const sourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts') ? [full] : [];
  });

const read = (file: string) => fs.readFileSync(file, 'utf8');
const quoted = (text: string) => [...text.matchAll(/'([A-Z][A-Z_]+)'/g)].map((m) => m[1]);

describe('permission catalog consistency', () => {
  const files = sourceFiles(SRC).filter((f) => !f.endsWith('permission-catalog.ts'));

  it('has no duplicate entries', () => {
    expect(new Set(KNOWN_PERMISSIONS).size).toBe(KNOWN_PERMISSIONS.length);
    expect(new Set(BUILT_IN_ROLE_NAMES).size).toBe(BUILT_IN_ROLE_NAMES.length);
  });

  it('includes every permission required by a backend guard (@Permissions)', () => {
    const used = new Set(files.flatMap((f) => [...read(f).matchAll(/@Permissions\(([^)]*)\)/g)].flatMap((m) => quoted(m[1]))));
    expect(used.size).toBeGreaterThan(10);
    expect([...used].filter((p) => !isKnownPermission(p))).toEqual([]);
  });

  it('includes every permission granted in prisma/seed.ts', () => {
    const seed = read(path.join(ROOT, 'prisma', 'seed.ts'));
    const granted = [...seed.matchAll(/permissions:\s*\[([^\]]*)\]/g)].flatMap((m) => quoted(m[1]));
    expect(granted.length).toBeGreaterThan(10);
    expect([...new Set(granted)].filter((p) => !isKnownPermission(p))).toEqual([]);
  });

  it('built-in roles are exactly the seeded roles', () => {
    const seed = read(path.join(ROOT, 'prisma', 'seed.ts'));
    const seeded = [...seed.matchAll(/name:\s*'([A-Z_]+)',\s*\n\s*description:/g)].map((m) => m[1]);
    expect([...seeded].sort()).toEqual([...BUILT_IN_ROLE_NAMES].sort());
  });

  it('every role name compared in backend code is a built-in (protected) role', () => {
    const roleContext = /(role\??\.name|roleName|role_name|\.includes\(roleName\)|SUPER_ADMIN:)/;
    const compared = new Set<string>();
    for (const f of files) {
      for (const line of read(f).split('\n')) {
        if (!roleContext.test(line)) continue;
        for (const name of quoted(line)) {
          if (/^(VIEW|MANAGE|GENERATE|IMPORT|EXPORT|PUBLISH)_/.test(name)) continue;
          compared.add(name);
        }
      }
    }
    expect(compared.has('CLIENT')).toBe(true);
    expect([...compared].filter((n) => !isBuiltInRoleName(n))).toEqual([]);
  });

  it('matches the frontend Permission identifiers when the frontend repository is present', () => {
    const typesFile = path.resolve(ROOT, '..', 'grehasoft-pms-frontend', 'src', 'types.ts');
    if (!fs.existsSync(typesFile)) return;
    // Phase 2.5: the enum became a type-only union of the identifiers the UI checks
    const types = read(typesFile);
    const enumBody =
      types.match(/export enum Permission \{([\s\S]*?)\}/)?.[1] ?? types.match(/export type Permission =([\s\S]*?);/)?.[1] ?? '';
    const frontend = quoted(enumBody);
    expect(frontend.length).toBeGreaterThan(10);
    expect(frontend.filter((p) => !isKnownPermission(p))).toEqual([]);
  });

  it('role management is guarded by MANAGE_ROLES only (not MANAGE_SETTINGS)', () => {
    expect(isKnownPermission(ROLE_MANAGEMENT_PERMISSION)).toBe(true);
    expect(ROLE_MANAGEMENT_PERMISSION).toBe('MANAGE_ROLES');
    for (const file of ['roles.controller.ts', 'permissions.controller.ts']) {
      const text = read(path.join(SRC, 'modules', 'roles', file));
      expect(text).toContain('@Permissions(ROLE_MANAGEMENT_PERMISSION');
      expect(text).not.toContain('MANAGE_SETTINGS');
    }
  });

  it('every catalog entry has a label, description and a known category', () => {
    for (const p of PERMISSION_DEFINITIONS) {
      expect(p.label.trim()).not.toBe('');
      expect(p.description.trim()).not.toBe('');
      expect(PERMISSION_CATEGORIES).toContain(p.category);
    }
  });

  it('isBuiltInRoleName is case-insensitive and rejects custom names', () => {
    expect(isBuiltInRoleName('admin')).toBe(true);
    expect(isBuiltInRoleName(' Project_Manager ')).toBe(true);
    expect(isBuiltInRoleName('CONTENT_WRITER')).toBe(false);
    expect(isBuiltInRoleName(null)).toBe(false);
  });
});
