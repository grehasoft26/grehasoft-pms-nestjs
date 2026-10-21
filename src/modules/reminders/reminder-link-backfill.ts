import { Prisma } from '@prisma/client';

/**
 * Linking legacy renewal reminders to their domain (reminders.domain_id).
 *
 * The old system created reminders titled "Domain Renewal: <domain name>" and stored no link.
 * Linking happens in two separate, explicit steps (prisma/runbooks/reminder-link-backfill.ts):
 *  1. report  - read-only: classifies every unlinked legacy reminder;
 *  2. apply   - links ONLY the reminder/domain pairs a reviewer approved from that report, after
 *               re-validating each pair inside one transaction; any problem, or an affected-row
 *               count different from the number of approved pairs, rolls everything back.
 * Servers never had such reminders, so nothing is linked to servers.
 */

export const LEGACY_DOMAIN_RENEWAL_PREFIX = 'Domain Renewal: ';

export type LegacyReminderOutcome = 'UNIQUE_MATCH' | 'AMBIGUOUS' | 'NO_MATCH' | 'NO_NAME';

export type LegacyReminderRow = {
  reminder_id: number;
  user_id: number;
  title: string;
  is_completed: boolean;
  name_in_title: string;
  matching_domains: number;
  domain_ids: number[];
  outcome: LegacyReminderOutcome;
};

/**
 * Read-only classification of unlinked legacy reminders. The prefix must match exactly (case
 * included, as the application always wrote it); the name is compared ignoring case and
 * surrounding spaces, the same rule as domain-name uniqueness. Same SQL as
 * prisma/runbooks/legacy-reminder-report.sql.
 */
export const LEGACY_REMINDER_REPORT_SQL = Prisma.sql`
  SELECT r.id AS reminder_id, r.user_id, r.title, r.is_completed,
         TRIM(SUBSTRING(r.title, 17)) AS name_in_title,
         COUNT(d.id) AS matching_domains,
         GROUP_CONCAT(d.id ORDER BY d.id) AS domain_ids,
         CASE WHEN TRIM(SUBSTRING(r.title, 17)) = '' THEN 'NO_NAME'
              WHEN COUNT(d.id) = 0 THEN 'NO_MATCH'
              WHEN COUNT(d.id) = 1 THEN 'UNIQUE_MATCH'
              ELSE 'AMBIGUOUS' END AS outcome
    FROM reminders r
    LEFT JOIN domains d
      ON LOWER(TRIM(d.domain_name)) = LOWER(TRIM(SUBSTRING(r.title, 17)))
     AND TRIM(SUBSTRING(r.title, 17)) <> ''
   WHERE LEFT(r.title, 16) = BINARY 'Domain Renewal: '
     AND r.domain_id IS NULL AND r.server_id IS NULL
   GROUP BY r.id, r.user_id, r.title, r.is_completed
   ORDER BY outcome, r.id`;

export async function reportLegacyReminders(prisma: { $queryRaw: (sql: Prisma.Sql) => Promise<any[]> }): Promise<LegacyReminderRow[]> {
  const rows = await prisma.$queryRaw(LEGACY_REMINDER_REPORT_SQL);
  return rows.map((r) => ({
    reminder_id: Number(r.reminder_id),
    user_id: Number(r.user_id),
    title: String(r.title),
    is_completed: Boolean(Number(r.is_completed)),
    name_in_title: String(r.name_in_title ?? ''),
    matching_domains: Number(r.matching_domains),
    domain_ids: r.domain_ids ? String(r.domain_ids).split(',').map(Number) : [],
    outcome: r.outcome as LegacyReminderOutcome,
  }));
}

export type ApprovedPair = { reminder_id: number; domain_id: number };

/** Validates the reviewer's approved list: [{ reminder_id, domain_id }], positive ids, no repeats. */
export function parseApprovedPairs(input: unknown): ApprovedPair[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error('Approved pairs must be a non-empty JSON array.');
  const seen = new Set<number>();
  return input.map((p: any, i) => {
    const reminderId = Number(p?.reminder_id);
    const domainId = Number(p?.domain_id);
    if (!Number.isInteger(reminderId) || reminderId <= 0 || !Number.isInteger(domainId) || domainId <= 0) {
      throw new Error(`Approved pair #${i + 1} must have positive integer reminder_id and domain_id.`);
    }
    if (seen.has(reminderId)) throw new Error(`Reminder ${reminderId} is listed more than once.`);
    seen.add(reminderId);
    return { reminder_id: reminderId, domain_id: domainId };
  });
}

export class BackfillRejected extends Error {
  constructor(public readonly problems: string[]) {
    super(`Backfill rolled back: ${problems.length} problem(s)\n - ${problems.join('\n - ')}`);
  }
}

class DryRunRollback extends Error {}

export type BackfillResult = { approved: number; updated: number; executed: boolean };

/**
 * Links exactly the approved pairs, in one transaction. Each pair is re-validated at update time
 * (the reminder row is locked): it must still be an unlinked "Domain Renewal: <name>" reminder whose
 * name matches exactly one domain, and that domain must be the approved one. Any problem, or an
 * affected-row total different from the number of pairs, rolls back every update. With
 * execute = false (the default) the updates are made and then rolled back: a dry run reporting
 * what would change.
 */
export async function applyApprovedLinks(prisma: any, pairs: ApprovedPair[], opts: { execute?: boolean } = {}): Promise<BackfillResult> {
  const execute = opts.execute === true;
  let updated = 0;
  try {
    await prisma.$transaction(async (tx: any) => {
      const problems: string[] = [];
      for (const pair of pairs) {
        const [reminder] = await tx.$queryRaw(
          Prisma.sql`SELECT id, title, domain_id, server_id FROM reminders WHERE id = ${pair.reminder_id} FOR UPDATE`,
        );
        if (!reminder) {
          problems.push(`reminder ${pair.reminder_id}: not found`);
          continue;
        }
        if (reminder.domain_id !== null || reminder.server_id !== null) {
          problems.push(`reminder ${pair.reminder_id}: already linked`);
          continue;
        }
        const title = String(reminder.title ?? '');
        const name = title.startsWith(LEGACY_DOMAIN_RENEWAL_PREFIX) ? title.slice(LEGACY_DOMAIN_RENEWAL_PREFIX.length).trim().toLowerCase() : '';
        if (!name) {
          problems.push(`reminder ${pair.reminder_id}: not a "${LEGACY_DOMAIN_RENEWAL_PREFIX}<domain>" reminder`);
          continue;
        }
        // Shared lock on the matching domains until commit. LOCK IN SHARE MODE, not FOR SHARE:
        // the target is MariaDB 10.4, which rejects FOR SHARE (MySQL 8 accepts both).
        const matches: any[] = await tx.$queryRaw(
          Prisma.sql`SELECT id FROM domains WHERE LOWER(TRIM(domain_name)) = ${name} LOCK IN SHARE MODE`,
        );
        const ids = matches.map((m) => Number(m.id));
        if (ids.length !== 1) {
          problems.push(`reminder ${pair.reminder_id}: "${name}" matches ${ids.length} domains (${ids.join(', ') || 'none'})`);
        } else if (ids[0] !== pair.domain_id) {
          problems.push(`reminder ${pair.reminder_id}: matches domain ${ids[0]}, not the approved ${pair.domain_id}`);
        }
      }
      if (problems.length) throw new BackfillRejected(problems);

      for (const pair of pairs) {
        updated += Number(
          await tx.$executeRaw(
            Prisma.sql`UPDATE reminders SET domain_id = ${pair.domain_id} WHERE id = ${pair.reminder_id} AND domain_id IS NULL AND server_id IS NULL`,
          ),
        );
      }
      if (updated !== pairs.length) {
        throw new BackfillRejected([`updated ${updated} row(s), expected ${pairs.length}`]);
      }
      if (!execute) throw new DryRunRollback();
    }, { timeout: 120000, maxWait: 10000 }); // Prisma's 5 s default is too short for long lists
  } catch (error) {
    if (error instanceof DryRunRollback) return { approved: pairs.length, updated, executed: false };
    throw error;
  }
  return { approved: pairs.length, updated, executed: true };
}
