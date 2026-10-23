import { BadRequestException } from '@nestjs/common';

/** Domain providers offered by the Add/Edit Domain form; stored as these exact labels. */
export const DOMAIN_PROVIDERS = [
  'GoDaddy',
  'Grehasoft Hostinger 1',
  'Grehasoft Hostinger 2',
  'Grehasoft Cloud',
  'Prasanth',
  'Client',
  'Moved',
] as const;

/**
 * Former labels, accepted as input and saved as the current one (a form loaded before the rename
 * still saves). Stored values are never rewritten: a domain saved with a former label keeps it
 * until it is changed (see parseDomainProvider).
 */
const PROVIDER_ALIASES: Readonly<Record<string, (typeof DOMAIN_PROVIDERS)[number]>> = {
  'grehasoft goddy': 'GoDaddy',
};

/** Domain status (Prisma enum DomainStatus), set by users: never derived from the expiry date. */
export const DOMAIN_STATUSES = ['active', 'expired'] as const;
export type DomainStatusValue = (typeof DOMAIN_STATUSES)[number];

const invalid = (field: 'status' | 'provider', message: string) =>
  new BadRequestException({ statusCode: 400, error: 'Bad Request', message, [field]: message });

/** "active"/"expired" (also "Active"/"Expired"); anything else is a 400. */
export const parseDomainStatus = (value: unknown): DomainStatusValue => {
  const status = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!(DOMAIN_STATUSES as readonly string[]).includes(status)) {
    throw invalid('status', 'Status must be Active or Expired.');
  }
  return status as DomainStatusValue;
};

/**
 * A provider from the request: '' clears it; otherwise one of DOMAIN_PROVIDERS (matched ignoring
 * case, stored as the canonical label). On update, `current` is the stored value: re-sending it
 * unchanged is accepted, so domains saved before the list existed stay editable.
 */
export const parseDomainProvider = (value: unknown, current?: string | null): string => {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw invalid('provider', `Provider must be one of: ${DOMAIN_PROVIDERS.join(', ')}.`);
  const provider = value.trim();
  if (!provider) return '';
  if (current !== undefined && current !== null && provider === current.trim()) return current;
  const match = DOMAIN_PROVIDERS.find((p) => p.toLowerCase() === provider.toLowerCase()) ?? PROVIDER_ALIASES[provider.toLowerCase()];
  if (!match) throw invalid('provider', `Provider must be one of: ${DOMAIN_PROVIDERS.join(', ')}.`);
  return match;
};

/** Domain list ?status= filter: none for ''/'all', otherwise active or expired (400 for anything else). */
export const domainStatusFilter = (value: unknown): DomainStatusValue | undefined => {
  if (value === undefined || value === null || value === '' || value === 'all') return undefined;
  return parseDomainStatus(value);
};
