import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BackupsService } from './backups.service';

/**
 * The renewal history (asset_renewals) in backups. FULL backups restore the whole database from
 * mysqldump (every table, so asset_renewals too); the JSON snapshots written next to it feed the
 * backup explorer and must include the table. CATEGORY backups/restores cover no infrastructure
 * tables (servers, domains), so the history is not restored on its own without its assets.
 */
describe('BackupsService - renewal history (asset_renewals)', () => {
  const renewal = {
    id: 1,
    asset_type: 'domain',
    asset_id: 10,
    asset_name: 'example.com',
    event: 'renewed',
    previous_expiry_date: new Date('2026-10-21T00:00:00.000Z'),
    new_expiry_date: new Date('2027-10-21T00:00:00.000Z'),
    cost: '1200.50',
    performed_by_name: 'Admin User',
  };

  // Every model delegate returns no rows, except the renewal history
  const prisma: any = new Proxy(
    { assetRenewal: { findMany: jest.fn(async () => [renewal]) } },
    {
      get: (target: any, prop) =>
        prop in target ? target[prop] : typeof prop === 'string' ? { findMany: jest.fn(async () => []) } : undefined,
    },
  );
  const service = new BackupsService(prisma, {} as any);

  let workDir: string;
  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'renewal-backup-'));
  });
  afterEach(() => fs.rmSync(workDir, { recursive: true, force: true }));

  it('FULL snapshots include asset_renewals.json with every history row', async () => {
    const dataDir = path.join(workDir, 'data');
    const docsDir = path.join(workDir, 'documents');
    fs.mkdirSync(dataDir);
    fs.mkdirSync(docsDir);
    const entityCounts: Record<string, number> = {};

    await (service as any).exportFullSnapshotsAndDocuments(dataDir, docsDir, entityCounts, {});

    const rows = JSON.parse(fs.readFileSync(path.join(dataDir, 'asset_renewals.json'), 'utf8'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ asset_type: 'domain', asset_id: 10, asset_name: 'example.com', event: 'renewed', cost: '1200.50' });
    expect(entityCounts.asset_renewals).toBe(1);
    // The existing snapshots are still written
    for (const table of ['servers', 'domains', 'reminders', 'website_credentials']) {
      expect(fs.existsSync(path.join(dataDir, `${table}.json`))).toBe(true);
    }
  });

  it('the backup explorer lists the history with a readable name', async () => {
    const cacheDir = path.join(workDir, 'cache');
    fs.mkdirSync(path.join(cacheDir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'manifest.json'), JSON.stringify({ manifest_version: '2.0', filename: 'b.zip' }));
    fs.writeFileSync(path.join(cacheDir, 'data', 'asset_renewals.json'), JSON.stringify([renewal]));
    jest.spyOn(service as any, 'ensureExtractedCache').mockResolvedValue(cacheDir);

    const summary = await service.getExplorerSummary(1);
    expect(summary.entities).toContainEqual({ name: 'asset_renewals', display_name: 'Domain & Server Renewal History', count: 1 });
  });

  it('CATEGORY restores do not restore the history (no category contains servers or domains)', () => {
    const tables: string[] = (service as any).categoryTopologicalTables;
    expect(tables).not.toContain('asset_renewals');
    expect(tables).not.toContain('domains');
    expect(tables).not.toContain('servers');
  });
});
