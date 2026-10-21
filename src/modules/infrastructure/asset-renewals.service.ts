import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/prisma.service';
import { businessToday, parseDateOnly, toDateKey } from '../../core/utils/date-only.util';
import { RenewalPeriod, RenewalPeriodUnit, addRenewalPeriod, parseRenewalPeriod } from './renewal-period.util';

/**
 * Domain and server renewals (POST /infrastructure/{domains|servers}/:id/renew), failed attempts
 * (.../renewal-failed) and the renewal history (.../renewals).
 *
 * A renewal extends the CURRENT expiry date by the renewal period, never the renewal date. It is
 * explicit: completing a reminder alone never renews anything. Duplicate extensions are prevented
 * at three levels:
 *  - the asset row is locked (SELECT ... FOR UPDATE) for the whole transaction, so concurrent
 *    renewals of one asset run one after the other;
 *  - the caller states the expiry it is renewing (expected_expiry_date); once renewed, the
 *    expiry has moved on and a second request with the old date is refused (409);
 *  - unique keys: idempotency_key (a retried request returns the recorded result) and cycle_key
 *    (one renewal per asset and previous expiry date), enforced by the database.
 * The history row, the new expiry date and the linked reminder are written in one transaction.
 */

export type AssetType = 'domain' | 'server';

const ASSETS = {
  domain: { table: 'domains', nameColumn: 'domain_name', label: 'Domain', relation: 'domain_id' },
  server: { table: 'servers', nameColumn: 'name', label: 'Server', relation: 'server_id' },
} as const;

/** Used when neither the request nor the domain has a renewal period. Servers have no default. */
export const DEFAULT_DOMAIN_RENEWAL_PERIOD: RenewalPeriod = { value: 1, unit: 'year' };

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_COST = 99999999.99; // DECIMAL(10, 2)

type LockedAsset = {
  id: number;
  name: string;
  expiry_date: Date | null;
  renewal_period_value: number | null;
  renewal_period_unit: RenewalPeriodUnit | null;
};

const badRequest = (message: string, field?: string) =>
  new BadRequestException(field ? { statusCode: 400, error: 'Bad Request', message, [field]: message } : message);

/** DATE value from a raw query (a Date, or a "YYYY-MM-DD" string depending on the driver). */
const asDate = (value: unknown): Date | null => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  return parseDateOnly(String(value), 'Expiry date') ?? null;
};

const performedBy = (user: any) => ({
  performed_by_id: typeof user?.id === 'number' ? user.id : null,
  performed_by_name: String(user?.name || user?.username || '').slice(0, 150) || null,
});

const cycleKey = (type: AssetType, id: number, previousExpiry: Date) => `${type}:${id}:${toDateKey(previousExpiry)}`;

/**
 * Locks the asset row (SELECT ... FOR UPDATE, held until the transaction ends) and returns its
 * current expiry date, or undefined when the row does not exist. Renewals and manual expiry
 * edits both take this lock, so they run one after the other and each sees the other's result.
 */
export async function lockAssetExpiry(tx: any, type: AssetType, id: number): Promise<Date | null | undefined> {
  const { table } = ASSETS[type];
  const rows: any[] = await tx.$queryRaw(
    Prisma.sql`SELECT id, expiry_date FROM ${Prisma.raw(table)} WHERE id = ${id} FOR UPDATE`,
  );
  return rows[0] ? asDate(rows[0].expiry_date) : undefined;
}

/** 409 for an expiry date that is no longer the one the caller saw (renewed or edited meanwhile). */
export function staleExpiryError(type: AssetType, current: Date | null) {
  const message = `The ${ASSETS[type].label.toLowerCase()}'s expiry date has changed (it may already have been renewed). Reload and try again.`;
  return new ConflictException({ statusCode: 409, error: 'Conflict', message, current_expiry_date: toDateKey(current) });
}

/** 422 body code: the renewal would still leave the asset expired and needs explicit confirmation. */
export const RENEWAL_STILL_EXPIRED = 'RENEWAL_STILL_EXPIRED';

/**
 * History entry for an expiry date changed through the ordinary edit forms (PUT/PATCH), written by
 * InfrastructureService in the same transaction as the update. Unchanged dates write nothing.
 */
export async function recordManualExpiryChange(
  client: any,
  entry: { type: AssetType; id: number; name: string; previous: Date | null; next: Date | null; user: any },
) {
  if (toDateKey(entry.previous) === toDateKey(entry.next)) return null;
  return client.assetRenewal.create({
    data: {
      asset_type: entry.type,
      asset_id: entry.id,
      asset_name: String(entry.name ?? '').slice(0, 255),
      [ASSETS[entry.type].relation]: entry.id,
      event: 'manual_change',
      previous_expiry_date: entry.previous,
      new_expiry_date: entry.next,
      ...performedBy(entry.user),
    },
  });
}

@Injectable()
export class AssetRenewalsService {
  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------
  // Input validation
  // -------------------------------------------------------------
  private parseIdempotencyKey(value: unknown): string {
    const key = typeof value === 'string' ? value.trim() : '';
    if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
      throw badRequest('idempotency_key is required: 8-64 letters, digits, "-" or "_".', 'idempotency_key');
    }
    return key;
  }

  /** Renewal or attempt date: defaults to today (business timezone); never in the future. */
  private parseRenewalDate(value: unknown, today: Date): Date {
    const date = parseDateOnly(value, 'Renewal date') ?? today;
    if (date > today) throw badRequest('Renewal date cannot be in the future.', 'renewal_date');
    return date;
  }

  private parseCost(value: unknown): string | null {
    if (value === undefined || value === null || value === '') return null;
    const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
    if (!/^\d+(\.\d{1,2})?$/.test(text) || Number(text) > MAX_COST) {
      throw badRequest('Cost must be a non-negative amount with at most 2 decimals.', 'cost');
    }
    return text;
  }

  private parseOptionalText(value: unknown, label: string, field: string, max?: number): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') throw badRequest(`${label} must be text.`, field);
    const text = value.trim();
    if (max && text.length > max) throw badRequest(`${label} must be at most ${max} characters.`, field);
    return text || null;
  }

  private parseReminderId(value: unknown): number | null {
    if (value === undefined || value === null || value === '') return null;
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('reminder_id must be a reminder id.', 'reminder_id');
    return id;
  }

  private parseExpectedExpiry(value: unknown, required: boolean): Date | null {
    const date = parseDateOnly(value, 'Expected expiry date');
    if (!date) {
      if (required) throw badRequest('expected_expiry_date (the expiry date being renewed) is required.', 'expected_expiry_date');
      return null;
    }
    return date;
  }

  // -------------------------------------------------------------
  // Locking and shared checks
  // -------------------------------------------------------------
  /** Reads the asset with a row lock held until the transaction ends (null when it does not exist). */
  private async lockAsset(tx: any, type: AssetType, id: number): Promise<LockedAsset | null> {
    const { table, nameColumn } = ASSETS[type];
    const rows: any[] = await tx.$queryRaw(
      Prisma.sql`SELECT id, ${Prisma.raw(nameColumn)} AS name, expiry_date, renewal_period_value, renewal_period_unit FROM ${Prisma.raw(table)} WHERE id = ${id} FOR UPDATE`,
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: Number(row.id),
      name: String(row.name ?? ''),
      expiry_date: asDate(row.expiry_date),
      renewal_period_value: row.renewal_period_value === null || row.renewal_period_value === undefined ? null : Number(row.renewal_period_value),
      renewal_period_unit: row.renewal_period_unit ?? null,
    };
  }

  private notFound(type: AssetType) {
    return new NotFoundException(`${ASSETS[type].label} not found`);
  }

  private staleExpiry(type: AssetType, current: Date | null) {
    return staleExpiryError(type, current);
  }

  /**
   * The reminder a renewal (or failed attempt) refers to must be the caller's own, still open, and
   * linked to this asset (reminders.domain_id / server_id). Nothing is inferred from the title:
   * legacy "Domain Renewal: <name>" reminders take part only once linked by the reviewed backfill
   * (prisma/runbooks/reminder-link-backfill.ts). Anything else is refused (400).
   */
  private async assertRenewalReminder(tx: any, user: any, type: AssetType, asset: LockedAsset, reminderId: number) {
    const reminder = await tx.reminder.findFirst({ where: { id: reminderId, user_id: user?.id } });
    if (!reminder) throw badRequest('Reminder not found.', 'reminder_id');
    if (reminder.is_completed) throw badRequest('This reminder is already completed.', 'reminder_id');
    if (reminder[ASSETS[type].relation] !== asset.id) {
      throw badRequest(`This reminder is not linked to this ${ASSETS[type].label.toLowerCase()}.`, 'reminder_id');
    }
  }

  /** Period of a renewal: the request's, else the asset's default, else 1 year for domains (400 for servers). */
  private resolvePeriod(type: AssetType, asset: LockedAsset, requested: RenewalPeriod | null): RenewalPeriod {
    const stored = parseRenewalPeriod(asset.renewal_period_value, asset.renewal_period_unit) ?? null;
    const period = requested ?? stored ?? (type === 'domain' ? DEFAULT_DOMAIN_RENEWAL_PERIOD : null);
    if (!period) {
      throw badRequest('Renewal period is required: this server has no default renewal period.', 'period_value');
    }
    return period;
  }

  /**
   * 422 when the new expiry date would still be before today and the caller has not confirmed that
   * exact date (confirm_new_expiry_date). Nothing has been written at this point, so the
   * idempotency key stays unused and the same request can be resent with the confirmation.
   */
  private assertConfirmedIfStillExpired(type: AssetType, current: Date, newExpiry: Date, today: Date, confirmed: Date | null) {
    if (newExpiry >= today || toDateKey(confirmed) === toDateKey(newExpiry)) return;
    throw new UnprocessableEntityException({
      statusCode: 422,
      error: 'Unprocessable Entity',
      code: RENEWAL_STILL_EXPIRED,
      message: `After this renewal the ${ASSETS[type].label.toLowerCase()} would still be expired (new expiry ${toDateKey(newExpiry)}, today ${toDateKey(today)}). Confirm this date to renew anyway, or renew for a longer period.`,
      current_expiry_date: toDateKey(current),
      computed_new_expiry_date: toDateKey(newExpiry),
      today: toDateKey(today),
    });
  }

  /** A request whose idempotency key is already recorded: the recorded result, if it is the same request. */
  private replay(existing: any, type: AssetType, id: number, event: 'renewed' | 'failed') {
    if (existing.asset_type !== type || existing.asset_id !== id || existing.event !== event) {
      throw new ConflictException('idempotency_key was already used for a different request.');
    }
    return { renewal: existing, expiry_date: event === 'renewed' ? existing.new_expiry_date : existing.previous_expiry_date, replayed: true };
  }

  /**
   * Runs the transaction; a duplicate idempotency key (a concurrent retry of the same request)
   * returns the recorded result, a duplicate cycle key is "already renewed", and an InnoDB
   * deadlock is retried (as for domain names).
   */
  private async runTransaction(type: AssetType, id: number, key: string, event: 'renewed' | 'failed', work: (tx: any) => Promise<any>) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.prisma.$transaction(work);
      } catch (error: any) {
        if (error?.code === 'P2002') {
          const target = JSON.stringify(error?.meta?.target ?? '');
          if (target.includes('idempotency_key')) {
            const existing = await this.prisma.assetRenewal.findUnique({ where: { idempotency_key: key } });
            if (existing) return this.replay(existing, type, id, event);
          }
          if (target.includes('cycle_key')) {
            throw new ConflictException(`This expiry date of the ${ASSETS[type].label.toLowerCase()} was already renewed.`);
          }
        }
        const deadlock = error?.code === 'P2034' || String(error?.meta?.code) === '1213' || /deadlock/i.test(String(error?.message));
        if (deadlock && attempt < 3) continue;
        throw error;
      }
    }
  }

  // -------------------------------------------------------------
  // POST /:id/renew
  // -------------------------------------------------------------
  async renew(user: any, type: AssetType, id: number, body: any = {}) {
    const today = businessToday();
    const key = this.parseIdempotencyKey(body.idempotency_key);
    const expected = this.parseExpectedExpiry(body.expected_expiry_date, true)!;
    const requestedPeriod = parseRenewalPeriod(body.period_value, body.period_unit) ?? null;
    const renewalDate = this.parseRenewalDate(body.renewal_date, today);
    const cost = this.parseCost(body.cost);
    const paymentReference = this.parseOptionalText(body.payment_reference, 'Payment reference', 'payment_reference', 255);
    const notes = this.parseOptionalText(body.notes, 'Notes', 'notes');
    const reminderId = this.parseReminderId(body.reminder_id);
    const confirmedNewExpiry = parseDateOnly(body.confirm_new_expiry_date, 'Confirmed new expiry date') ?? null;

    // A retry of a completed request: the recorded result, without touching the asset
    const recorded = await this.prisma.assetRenewal.findUnique({ where: { idempotency_key: key } });
    if (recorded) return this.replay(recorded, type, id, 'renewed');

    return this.runTransaction(type, id, key, 'renewed', async (tx) => {
      const asset = await this.lockAsset(tx, type, id);
      if (!asset) throw this.notFound(type);

      // Recorded by a concurrent request that held the lock before this one
      const concurrent = await tx.assetRenewal.findUnique({ where: { idempotency_key: key } });
      if (concurrent) return this.replay(concurrent, type, id, 'renewed');

      const current = asset.expiry_date;
      if (!current) {
        throw badRequest(`This ${ASSETS[type].label.toLowerCase()} has no expiry date. Set the expiry date before renewing.`, 'expected_expiry_date');
      }
      if (toDateKey(current) !== toDateKey(expected)) throw this.staleExpiry(type, current);

      // Computed from the locked, verified current expiry (never from a client-side value)
      const period = this.resolvePeriod(type, asset, requestedPeriod);
      const newExpiry = addRenewalPeriod(current, period);
      this.assertConfirmedIfStillExpired(type, current, newExpiry, today, confirmedNewExpiry);

      if (reminderId) await this.assertRenewalReminder(tx, user, type, asset, reminderId);

      const renewal = await tx.assetRenewal.create({
        data: {
          asset_type: type,
          asset_id: asset.id,
          asset_name: asset.name.slice(0, 255),
          [ASSETS[type].relation]: asset.id,
          event: 'renewed',
          previous_expiry_date: current,
          new_expiry_date: newExpiry,
          renewal_date: renewalDate,
          period_value: period.value,
          period_unit: period.unit,
          cost,
          payment_reference: paymentReference,
          notes,
          reminder_id: reminderId,
          ...performedBy(user),
          idempotency_key: key,
          cycle_key: cycleKey(type, asset.id, current),
        },
      });
      await tx[type].update({ where: { id: asset.id }, data: { expiry_date: newExpiry } });
      if (reminderId) await tx.reminder.update({ where: { id: reminderId }, data: { is_completed: true } });

      return { renewal, expiry_date: newExpiry, replayed: false };
    });
  }

  // -------------------------------------------------------------
  // POST /:id/renewal-failed  (expiry date unchanged)
  // -------------------------------------------------------------
  async recordFailure(user: any, type: AssetType, id: number, body: any = {}) {
    const today = businessToday();
    const key = this.parseIdempotencyKey(body.idempotency_key);
    const reason = this.parseOptionalText(body.failure_reason, 'Failure reason', 'failure_reason', 2000);
    if (!reason) throw badRequest('Failure reason is required.', 'failure_reason');
    const expected = this.parseExpectedExpiry(body.expected_expiry_date, false);
    const period = parseRenewalPeriod(body.period_value, body.period_unit) ?? null;
    const attemptDate = this.parseRenewalDate(body.renewal_date, today);
    const cost = this.parseCost(body.cost);
    const paymentReference = this.parseOptionalText(body.payment_reference, 'Payment reference', 'payment_reference', 255);
    const notes = this.parseOptionalText(body.notes, 'Notes', 'notes');
    const reminderId = this.parseReminderId(body.reminder_id);

    const recorded = await this.prisma.assetRenewal.findUnique({ where: { idempotency_key: key } });
    if (recorded) return this.replay(recorded, type, id, 'failed');

    return this.runTransaction(type, id, key, 'failed', async (tx) => {
      const asset = await this.lockAsset(tx, type, id);
      if (!asset) throw this.notFound(type);
      const concurrent = await tx.assetRenewal.findUnique({ where: { idempotency_key: key } });
      if (concurrent) return this.replay(concurrent, type, id, 'failed');
      if (expected && toDateKey(asset.expiry_date) !== toDateKey(expected)) throw this.staleExpiry(type, asset.expiry_date);
      if (reminderId) await this.assertRenewalReminder(tx, user, type, asset, reminderId);

      // Recorded only: the expiry date and the reminder (left open) are not changed
      const renewal = await tx.assetRenewal.create({
        data: {
          asset_type: type,
          asset_id: asset.id,
          asset_name: asset.name.slice(0, 255),
          [ASSETS[type].relation]: asset.id,
          event: 'failed',
          previous_expiry_date: asset.expiry_date,
          new_expiry_date: null,
          renewal_date: attemptDate,
          period_value: period?.value ?? null,
          period_unit: period?.unit ?? null,
          cost,
          payment_reference: paymentReference,
          notes,
          failure_reason: reason,
          reminder_id: reminderId,
          ...performedBy(user),
          idempotency_key: key,
        },
      });
      return { renewal, expiry_date: asset.expiry_date, replayed: false };
    });
  }

  // -------------------------------------------------------------
  // GET /:id/renewal-preview?period_value=&period_unit=
  // -------------------------------------------------------------
  /**
   * Read-only: what a renewal would do now (no lock, nothing written). The renew request recomputes
   * the same values after locking the asset; send expected_expiry_date = current_expiry_date and,
   * when confirmation_required, confirm_new_expiry_date = computed_new_expiry_date.
   */
  async preview(type: AssetType, id: number, query: any = {}) {
    const today = businessToday();
    const requested = parseRenewalPeriod(query.period_value, query.period_unit) ?? null;
    const row = await (this.prisma as any)[type].findUnique({ where: { id } });
    if (!row) throw this.notFound(type);
    const asset: LockedAsset = {
      id: row.id,
      name: String(row[ASSETS[type].nameColumn] ?? ''),
      expiry_date: asDate(row.expiry_date),
      renewal_period_value: row.renewal_period_value ?? null,
      renewal_period_unit: row.renewal_period_unit ?? null,
    };
    if (!asset.expiry_date) {
      throw badRequest(`This ${ASSETS[type].label.toLowerCase()} has no expiry date. Set the expiry date before renewing.`, 'expected_expiry_date');
    }
    const period = this.resolvePeriod(type, asset, requested);
    const newExpiry = addRenewalPeriod(asset.expiry_date, period);
    const stillExpired = newExpiry < today;
    return {
      asset_type: type,
      asset_id: asset.id,
      asset_name: asset.name,
      current_expiry_date: toDateKey(asset.expiry_date),
      period_value: period.value,
      period_unit: period.unit,
      period_source: requested ? 'request' : asset.renewal_period_value ? 'asset' : 'default',
      computed_new_expiry_date: toDateKey(newExpiry),
      today: toDateKey(today),
      still_expired: stillExpired,
      confirmation_required: stillExpired,
    };
  }

  // -------------------------------------------------------------
  // GET /:id/renewals
  // -------------------------------------------------------------
  /** Newest first. Still available after the asset is deleted (404 only when there is neither). */
  async getHistory(type: AssetType, id: number) {
    const history = await this.prisma.assetRenewal.findMany({
      where: { asset_type: type, asset_id: id },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    });
    if (history.length === 0 && (await (this.prisma as any)[type].count({ where: { id } })) === 0) {
      throw this.notFound(type);
    }
    return history;
  }
}
