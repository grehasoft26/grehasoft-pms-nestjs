import { BackfillRejected, applyApprovedLinks, parseApprovedPairs, reportLegacyReminders } from './reminder-link-backfill';

/**
 * Legacy reminder linking against an in-memory fake that evaluates the module's SQL and rolls a
 * failed transaction back. (The same code is also run against a disposable MySQL instance; see
 * prisma/runbooks/RENEWAL_MIGRATION_RUNBOOK.md.)
 */
const buildFake = () => {
  const db = {
    domains: [
      { id: 10, domain_name: 'example.com' },
      { id: 11, domain_name: 'Shared.com' },
      { id: 12, domain_name: ' shared.COM' },
    ],
    reminders: [
      { id: 1, title: 'Domain Renewal: example.com', domain_id: null as number | null, server_id: null as number | null },
      { id: 2, title: 'Domain Renewal:  EXAMPLE.com ', domain_id: null, server_id: null },
      { id: 3, title: 'Domain Renewal: shared.com', domain_id: null, server_id: null },
      { id: 4, title: 'Domain Renewal: deleted.test', domain_id: null, server_id: null },
      { id: 5, title: 'Call Acme', domain_id: null, server_id: null },
      { id: 6, title: 'Domain Renewal: example.com', domain_id: 10, server_id: null },
    ],
  };
  const matching = (name: string) => db.domains.filter((d) => d.domain_name.trim().toLowerCase() === name);
  const client = (journal?: Array<() => void>) => ({
    $queryRaw: jest.fn(async (sql: any) => {
      if (/FROM reminders WHERE id = \?/.test(sql.sql)) {
        const r = db.reminders.find((x) => x.id === sql.values[0]);
        return r ? [{ ...r }] : [];
      }
      if (/FROM domains WHERE LOWER\(TRIM\(domain_name\)\) = \?/.test(sql.sql)) return matching(sql.values[0]).map((d) => ({ id: d.id }));
      throw new Error(`unexpected query: ${sql.sql}`);
    }),
    $executeRaw: jest.fn(async (sql: any) => {
      const [domainId, reminderId] = sql.values;
      const r = db.reminders.find((x) => x.id === reminderId && x.domain_id === null && x.server_id === null);
      if (!r) return 0;
      journal?.push(() => (r.domain_id = null));
      r.domain_id = domainId;
      return 1;
    }),
  });
  const prisma: any = {
    ...client(),
    $transaction: jest.fn(async (fn: any) => {
      const journal: Array<() => void> = [];
      try {
        return await fn(client(journal));
      } catch (error) {
        journal.reverse().forEach((undo) => undo());
        throw error;
      }
    }),
  };
  return { prisma, db };
};

describe('parseApprovedPairs', () => {
  it('accepts positive integer pairs', () => {
    expect(parseApprovedPairs([{ reminder_id: 1, domain_id: 10 }, { reminder_id: '2', domain_id: '10' }])).toEqual([
      { reminder_id: 1, domain_id: 10 },
      { reminder_id: 2, domain_id: 10 },
    ]);
  });

  it.each([[[]], [{}], [[{ reminder_id: 1 }]], [[{ reminder_id: 0, domain_id: 1 }]], [[{ reminder_id: 1.5, domain_id: 1 }]], [[{ reminder_id: 1, domain_id: 1 }, { reminder_id: 1, domain_id: 2 }]]])(
    'rejects %j',
    (input) => {
      expect(() => parseApprovedPairs(input)).toThrow();
    },
  );
});

describe('reportLegacyReminders', () => {
  it('maps the report rows (read-only query)', async () => {
    const prisma = {
      $queryRaw: jest.fn(async () => [
        { reminder_id: 1, user_id: 2, title: 'Domain Renewal: a.test', is_completed: 0, name_in_title: 'a.test', matching_domains: BigInt(1), domain_ids: '10', outcome: 'UNIQUE_MATCH' },
        { reminder_id: 3, user_id: 2, title: 'Domain Renewal: s.test', is_completed: 1, name_in_title: 's.test', matching_domains: BigInt(2), domain_ids: '11,12', outcome: 'AMBIGUOUS' },
        { reminder_id: 4, user_id: 2, title: 'Domain Renewal: x', is_completed: 0, name_in_title: 'x', matching_domains: BigInt(0), domain_ids: null, outcome: 'NO_MATCH' },
      ]),
    };
    const rows = await reportLegacyReminders(prisma as any);
    expect(rows[0]).toMatchObject({ reminder_id: 1, matching_domains: 1, domain_ids: [10], is_completed: false, outcome: 'UNIQUE_MATCH' });
    expect(rows[1]).toMatchObject({ domain_ids: [11, 12], is_completed: true, outcome: 'AMBIGUOUS' });
    expect(rows[2]).toMatchObject({ domain_ids: [], outcome: 'NO_MATCH' });
    const sql = (prisma.$queryRaw.mock.calls[0] as any[])[0].sql as string;
    expect(sql).toMatch(/^\s*SELECT/);
    expect(sql).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/i);
  });
});

describe('applyApprovedLinks', () => {
  const linked = (db: any) => db.reminders.filter((r: any) => r.domain_id !== null).map((r: any) => r.id);

  it('dry run by default: validates, counts and rolls back', async () => {
    const { prisma, db } = buildFake();
    const result = await applyApprovedLinks(prisma, [{ reminder_id: 1, domain_id: 10 }, { reminder_id: 2, domain_id: 10 }]);
    expect(result).toEqual({ approved: 2, updated: 2, executed: false });
    expect(linked(db)).toEqual([6]); // unchanged
  });

  it('execute: links exactly the approved, uniquely matching pairs', async () => {
    const { prisma, db } = buildFake();
    const result = await applyApprovedLinks(prisma, [{ reminder_id: 1, domain_id: 10 }, { reminder_id: 2, domain_id: 10 }], { execute: true });
    expect(result).toEqual({ approved: 2, updated: 2, executed: true });
    expect(linked(db)).toEqual([1, 2, 6]);
  });

  it.each([
    [{ reminder_id: 3, domain_id: 11 }, 'matches 2 domains'], // ambiguous at update time
    [{ reminder_id: 4, domain_id: 10 }, 'matches 0 domains'], // asset deleted
    [{ reminder_id: 5, domain_id: 10 }, 'not a "Domain Renewal: <domain>" reminder'],
    [{ reminder_id: 6, domain_id: 10 }, 'already linked'],
    [{ reminder_id: 1, domain_id: 11 }, 'not the approved 11'], // approved the wrong domain
    [{ reminder_id: 99, domain_id: 10 }, 'not found'],
  ])('one bad pair (%j) rolls back the whole batch', async (bad, message) => {
    const { prisma, db } = buildFake();
    const error = await applyApprovedLinks(prisma, [{ reminder_id: 2, domain_id: 10 }, bad], { execute: true }).then(() => null, (e) => e);
    expect(error).toBeInstanceOf(BackfillRejected);
    expect(error.message).toContain(message);
    expect(linked(db)).toEqual([6]);
  });

  it('locks with MariaDB 10.4-compatible syntax (FOR UPDATE / LOCK IN SHARE MODE, never FOR SHARE)', async () => {
    const { prisma } = buildFake();
    const queries: string[] = [];
    const tx = prisma.$transaction;
    prisma.$transaction = jest.fn((fn: any, opts: any) =>
      tx(async (client: any) => {
        const original = client.$queryRaw;
        client.$queryRaw = jest.fn(async (sql: any) => {
          queries.push(sql.sql);
          return original(sql);
        });
        return fn(client);
      }, opts),
    );
    await applyApprovedLinks(prisma, [{ reminder_id: 1, domain_id: 10 }]);
    expect(queries.some((q) => /FROM reminders WHERE id = \? FOR UPDATE$/.test(q))).toBe(true);
    expect(queries.some((q) => /FROM domains WHERE LOWER\(TRIM\(domain_name\)\) = \? LOCK IN SHARE MODE$/.test(q))).toBe(true);
    expect(queries.join('\n')).not.toMatch(/FOR SHARE/);
  });

  it('rolls back when the affected-row count differs from the approved count', async () => {
    const { prisma, db } = buildFake();
    // A concurrent writer links reminder 2 between validation and update: the UPDATE affects 0 rows
    const tx = prisma.$transaction;
    prisma.$transaction = jest.fn((fn: any) =>
      tx(async (client: any) => {
        const original = client.$executeRaw;
        client.$executeRaw = jest.fn(async (sql: any) => (sql.values[1] === 2 ? 0 : original(sql)));
        return fn(client);
      }),
    );
    const error = await applyApprovedLinks(prisma, [{ reminder_id: 1, domain_id: 10 }, { reminder_id: 2, domain_id: 10 }], { execute: true }).then(() => null, (e) => e);
    expect(error).toBeInstanceOf(BackfillRejected);
    expect(error.message).toContain('updated 1 row(s), expected 2');
    expect(linked(db)).toEqual([6]); // reminder 1's update was rolled back too
  });
});
