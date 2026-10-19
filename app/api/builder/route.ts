import type { NextRequest } from 'next/server';
import { getAuthedContext } from '@/lib/api/auth';
import { RATE_LIMITS, checkRateLimit } from '@/lib/api/rate-limit';
import {
  fail,
  ok,
  rateLimited,
  serverError,
  unauthorized,
  validationError,
} from '@/lib/api/response';
import { normalizeLinkedInUrl, normalizeNameCompany, splitName } from '@/lib/leads/dedupe';
import { doNotContact } from '@/lib/outreach/api';
import { builderSaveSchema } from '@/lib/validation/schemas';
import type { Lead, OutreachMessage } from '@/types/database';

type AuthedSupabase = NonNullable<Awaited<ReturnType<typeof getAuthedContext>>>['supabase'];

/**
 * Finds the caller's lead that a new one collided with, using the same keys
 * as the unique indexes, in the same priority order (LinkedIn URL first).
 */
async function findExistingLead(
  supabase: AuthedSupabase,
  userId: string,
  input: { name: string; company: string; linkedinUrl?: string },
): Promise<Lead | null> {
  const candidates: [string, string | null][] = [
    ['linkedin_url_key', normalizeLinkedInUrl(input.linkedinUrl)],
    ['name_company_key', normalizeNameCompany(input.name, input.company)],
  ];
  for (const [column, key] of candidates) {
    if (!key) continue;
    const { data } = await supabase
      .from('leads')
      .select('*')
      .eq('user_id', userId)
      .filter(column, 'eq', key)
      .maybeSingle<Lead>();
    if (data) return data;
  }
  return null;
}

/**
 * POST /api/builder — the AI Lead Builder's save step.
 *
 * Saves the lead and its reviewed message together. The message always starts
 * as a draft (the database enforces it). If the lead already exists — same
 * LinkedIn URL, or same name at the same company — the message is added to
 * that lead instead of creating a duplicate.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthedContext();
    if (!auth) return unauthorized();
    const { user, supabase } = auth;

    if (!(await checkRateLimit(user.id, RATE_LIMITS.mutateMessage))) return rateLimited();

    const parsed = builderSaveSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return validationError(parsed.error);
    const input = parsed.data;

    const { firstName, lastName } = splitName(input.name);
    const created = await supabase
      .from('leads')
      .insert({
        user_id: user.id,
        full_name: input.name,
        first_name: firstName,
        last_name: lastName,
        job_title: input.role,
        company_name: input.company,
        linkedin_url: input.linkedinUrl ?? null,
        campaign_id: input.campaignId ?? null,
        source: 'builder',
      })
      .select()
      .single<Lead>();

    let lead: Lead;
    let existingLead = false;

    if (created.error?.code === '23503') {
      return fail('invalid_campaign', 'That campaign does not exist.', 422);
    } else if (created.error?.code === '23505') {
      const existing = await findExistingLead(supabase, user.id, input);
      if (!existing) return serverError('builder:find-existing', created.error);
      if (existing.status === 'do_not_contact') return doNotContact();
      lead = existing;
      existingLead = true;
    } else if (created.error || !created.data) {
      return serverError('builder:lead', created.error);
    } else {
      lead = created.data;
    }

    const { data: message, error } = await supabase
      .from('outreach_messages')
      .insert({
        user_id: user.id,
        lead_id: lead.id,
        campaign_id: input.campaignId ?? lead.campaign_id,
        channel: input.channel,
        body: input.body,
        source: input.source,
        ai_model: input.source === 'ai' ? (input.aiModel ?? null) : null,
      })
      .select()
      .single<OutreachMessage>();

    if (error || !message) {
      // Do not leave a lead behind that the user never saw a message for.
      if (!existingLead) {
        await supabase.from('leads').delete().eq('id', lead.id).eq('user_id', user.id);
      }
      if (error?.code === '23503') {
        return fail('invalid_campaign', 'That campaign does not exist.', 422);
      }
      return serverError('builder:message', error);
    }

    return ok({ lead, message, existingLead }, 201);
  } catch (error) {
    return serverError('builder', error);
  }
}
