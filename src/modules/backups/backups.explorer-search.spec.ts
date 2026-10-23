import * as fs from 'fs';
import * as path from 'path';
import { BackupsService } from './backups.service';

/**
 * Backup explorer "Search records...": matches record values (partial, ignoring case, trimmed, at
 * any depth), never field names or JSON syntax. In-memory archive; nothing is read from disk.
 */
const CACHE = path.join(path.sep, 'virtual-explorer-search');
const DOMAINS = [
  { id: 1, domain_name: 'royalkangan.com', provider: 'GoDaddy', notes: 'Renew via client portal', expiry_date: '2027-01-11T00:00:00.000Z' },
  { id: 2, domain_name: 'example.org', provider: 'Client', notes: '', expiry_date: null },
  { id: 3, domain_name: 'alpha.io', provider: null, notes: null, project: { id: 7, name: 'Royal Portal' } },
];

describe('Backup explorer record search', () => {
  let service: BackupsService;

  beforeEach(() => {
    jest.spyOn(BackupsService.prototype as any, 'ensureDirectoryExists').mockImplementation(() => undefined);
    const prisma: any = { backupRecord: { findUnique: jest.fn() } };
    service = new BackupsService(prisma, {} as any);
    jest.spyOn(service as any, 'ensureExtractedCache').mockResolvedValue(CACHE);
    const file = path.join(CACHE, 'data', 'domains.json');
    const realExists = fs.existsSync;
    const realRead = fs.readFileSync;
    jest.spyOn(fs, 'existsSync').mockImplementation((p: any) => (path.resolve(String(p)) === path.resolve(file) ? true : realExists(p)));
    jest.spyOn(fs, 'readFileSync').mockImplementation(((p: any, ...rest: any[]) =>
      path.resolve(String(p)) === path.resolve(file) ? JSON.stringify(DOMAINS) : (realRead as any)(p, ...rest)) as any);
  });

  afterEach(() => jest.restoreAllMocks());

  const search = async (term: any, extra: any = {}) => {
    const res = await service.getExplorerEntityRecords(1, 'domains', { search: term, ...extra });
    return { ids: res.records.map((r: any) => r.id), total: res.total_count };
  };

  it('finds a record by a value: partial and mixed case', async () => {
    expect((await search('KANGAN')).ids).toEqual([1]);
    expect((await search('godaddy')).ids).toEqual([1]);
    expect((await search('client')).ids).toEqual([1, 2]); // "Client" provider and "client portal" note
  });

  it('a field name alone does not match', async () => {
    for (const term of ['domain_name', 'provider', 'notes', 'expiry_date', 'project']) {
      expect({ term, total: (await search(term)).total }).toEqual({ term, total: 0 });
    }
  });

  it('JSON syntax does not match every record', async () => {
    for (const term of ['{', '":', '","', 'null']) expect({ term, total: (await search(term)).total }).toEqual({ term, total: 0 });
  });

  it('matches values of nested related records', async () => {
    expect((await search('royal portal')).ids).toEqual([3]);
    expect((await search('royal')).ids).toEqual([1, 3]);
  });

  it('trims the term; empty or blank means no search', async () => {
    expect((await search('  example  ')).ids).toEqual([2]);
    for (const term of ['', '   ', undefined]) expect((await search(term)).total).toBe(3);
  });

  it('paginates the matches (total is the number of matches)', async () => {
    expect(await search('royal', { page: '2', limit: '1' })).toEqual({ ids: [3], total: 2 });
  });

  it('invalid page/limit fall back to the defaults (not an empty page); the limit is capped at 100', async () => {
    const res = await service.getExplorerEntityRecords(1, 'domains', { page: 'abc', limit: 'xyz' });
    expect({ page: res.page, limit: res.limit, ids: res.records.map((r: any) => r.id) }).toEqual({ page: 1, limit: 10, ids: [1, 2, 3] });
    expect((await service.getExplorerEntityRecords(1, 'domains', { limit: '5000' })).limit).toBe(100);
    expect((await service.getExplorerEntityRecords(1, 'domains', { page: '-4', limit: '0' })).page).toBe(1);
    expect((await service.getExplorerEntityRecords(1, 'domains', { limit: '0' })).limit).toBe(1);
    expect((await service.getExplorerEntityRecords(1, 'domains', { limit: '50' })).limit).toBe(50);
  });
});
