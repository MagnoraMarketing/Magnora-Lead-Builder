import type { EnrichableFields } from './index';
import type { Lead } from '@/types/database';

/**
 * Only fills gaps. A value the lead already has — scraped, imported or typed
 * by the user — is never replaced by a provider's answer.
 */
export function fillEmptyFields(
  lead: Pick<Lead, keyof EnrichableFields>,
  found: EnrichableFields,
): EnrichableFields {
  const patch: EnrichableFields = {};
  for (const [key, value] of Object.entries(found) as [keyof EnrichableFields, string | null | undefined][]) {
    if (value && !lead[key]) patch[key] = value;
  }
  return patch;
}
