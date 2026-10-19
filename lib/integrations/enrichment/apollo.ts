import 'server-only';

import type { EnrichableFields, EnrichmentProvider, EnrichmentResult } from './index';
import type { Lead } from '@/types/database';

/**
 * Apollo.io People Enrichment — POST https://api.apollo.io/api/v1/people/match
 *
 * Email comes back in the response. Phone numbers are delivered later to a
 * webhook (Apollo requires `webhook_url` with `reveal_phone_number`), see
 * app/api/webhooks/apollo/[token]/route.ts.
 *
 * Only verified emails are kept. Apollo also returns "guessed" addresses built
 * from name-and-domain patterns, and placeholder addresses for data that was
 * not unlocked; storing either would be inventing contact data, which this
 * app does not do.
 */
const ENDPOINT = 'https://api.apollo.io/api/v1/people/match';

export const APOLLO_PROVIDER_ID = 'apollo';

export class ApolloRequestError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApolloRequestError';
  }
}

export interface ApolloMatchOptions {
  /** When given, Apollo is asked to reveal phone numbers and deliver them here. */
  webhookUrl?: string | null;
}

/** Hostname of a website URL, for Apollo's `domain` matching hint. */
function domainOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** Query parameters for one lead. Only fields the lead actually has are sent. */
export function buildApolloParams(lead: Lead, options: ApolloMatchOptions = {}): URLSearchParams {
  const params = new URLSearchParams();
  const set = (key: string, value: string | null | undefined) => {
    if (value && value.trim()) params.set(key, value.trim());
  };
  set('first_name', lead.first_name);
  set('last_name', lead.last_name);
  if (!lead.first_name && !lead.last_name) set('name', lead.full_name);
  set('organization_name', lead.company_name);
  set('domain', domainOf(lead.company_website));
  set('linkedin_url', lead.linkedin_url);
  params.set('reveal_personal_emails', 'false');
  if (options.webhookUrl) {
    params.set('reveal_phone_number', 'true');
    params.set('webhook_url', options.webhookUrl);
  }
  return params;
}

type Json = Record<string, unknown>;
const asObject = (v: unknown): Json | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
const asString = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;

const PLACEHOLDER_EMAIL = /^email_not_unlocked@|@domain\.com$/i;

export interface ApolloMatchResult {
  found: boolean;
  personId: string | null;
  emailStatus: string | null;
  fields: EnrichableFields;
}

/** Reads the synchronous response. Unknown or missing fields are simply absent. */
export function parseApolloMatch(body: unknown): ApolloMatchResult {
  const person = asObject(asObject(body)?.person);
  if (!person) return { found: false, personId: null, emailStatus: null, fields: {} };

  const fields: EnrichableFields = {};
  const emailStatus = asString(person.email_status);
  const email = asString(person.email);
  if (email && emailStatus === 'verified' && !PLACEHOLDER_EMAIL.test(email)) {
    fields.email = email.toLowerCase();
  }

  const org = asObject(person.organization);
  const website = asString(org?.website_url);
  if (website) fields.company_website = website;
  const industry = asString(org?.industry);
  if (industry) fields.industry = industry;
  const employees = org?.estimated_num_employees;
  if (typeof employees === 'number' && employees > 0) fields.company_size = String(employees);

  return { found: true, personId: asString(person.id), emailStatus, fields };
}

/**
 * Pulls phone numbers out of a phone-reveal webhook payload.
 *
 * The exact payload shape could not be confirmed against Apollo's reference
 * when this was written, so this reads defensively: any `phone_numbers` array
 * anywhere in the payload, each entry's `sanitized_number`, `raw_number` or
 * `number`, and its `type_cd` / `type` to tell mobile from other numbers. The
 * raw payload is always stored on the enrichment request for checking.
 */
export function parseApolloPhoneWebhook(body: unknown): Pick<EnrichableFields, 'phone' | 'mobile_phone'> {
  const numbers: { number: string; mobile: boolean }[] = [];

  const visit = (node: unknown, depth: number) => {
    if (depth > 6 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((child) => visit(child, depth + 1));
      return;
    }
    const obj = node as Json;
    if (Array.isArray(obj.phone_numbers)) {
      for (const entry of obj.phone_numbers) {
        const e = asObject(entry);
        const number = asString(e?.sanitized_number) ?? asString(e?.raw_number) ?? asString(e?.number);
        if (!number || !/\d{6,}/.test(number.replace(/\D/g, ''))) continue;
        const type = (asString(e?.type_cd) ?? asString(e?.type) ?? '').toLowerCase();
        numbers.push({ number, mobile: type.includes('mobile') });
      }
    }
    Object.values(obj).forEach((child) => visit(child, depth + 1));
  };
  visit(body, 0);

  const mobile = numbers.find((n) => n.mobile)?.number;
  const other = numbers.find((n) => !n.mobile)?.number;
  return {
    ...(mobile ? { mobile_phone: mobile } : {}),
    ...(other ? { phone: other } : {}),
  };
}

export class ApolloEnrichmentProvider implements EnrichmentProvider {
  readonly id = APOLLO_PROVIDER_ID;
  readonly name = 'Apollo.io';

  constructor(private readonly apiKey: string | null) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async enrichLead(lead: Lead, options: ApolloMatchOptions = {}): Promise<EnrichmentResult & { raw: unknown }> {
    if (!this.apiKey) throw new ApolloRequestError(0, 'Apollo is not configured.');

    const response = await fetch(`${ENDPOINT}?${buildApolloParams(lead, options).toString()}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'X-Api-Key': this.apiKey,
      },
      body: '{}',
      signal: AbortSignal.timeout(20_000),
    });

    const raw: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        asString(asObject(raw)?.error) ?? asString(asObject(raw)?.message) ?? `HTTP ${response.status}`;
      throw new ApolloRequestError(response.status, message);
    }

    const parsed = parseApolloMatch(raw);
    return { provider: this.id, found: parsed.found, fields: parsed.fields, raw };
  }
}
