import type { NextRequest } from 'next/server';
import { AiGenerationError, generateOutreachMessage, type AiErrorCode } from '@/lib/ai/outreach';
import { getAuthedContext } from '@/lib/api/auth';
import { RATE_LIMITS, checkRateLimit } from '@/lib/api/rate-limit';
import {
  fail,
  notFound,
  ok,
  rateLimited,
  serverError,
  unauthorized,
  validationError,
} from '@/lib/api/response';
import { isAiConfigured } from '@/lib/env';
import { doNotContact } from '@/lib/outreach/api';
import { generateMessageSchema } from '@/lib/validation/schemas';
import type { Campaign, Lead, OutreachMessage } from '@/types/database';

const AI_ERROR_STATUS: Record<AiErrorCode, number> = {
  ai_not_configured: 503,
  ai_auth_failed: 502,
  ai_rate_limited: 503,
  ai_unavailable: 502,
  ai_refused: 422,
  ai_invalid_output: 502,
};

/**
 * POST /api/messages/generate — drafts a LinkedIn message with AI and saves it
 * as a draft. The draft is never approved or sent automatically.
 *
 * Personalisation uses only what is stored: the lead's fields and the
 * campaign's sender context. Nothing is looked up elsewhere.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthedContext();
    if (!auth) return unauthorized();
    const { user, supabase } = auth;

    // Checked before the rate limiter so an unconfigured deployment does not
    // burn the user's quota on requests that cannot succeed.
    if (!isAiConfigured()) {
      return fail(
        'ai_not_configured',
        'AI drafting is not set up on this deployment. Add ANTHROPIC_API_KEY to the server environment.',
        503,
      );
    }

    if (!(await checkRateLimit(user.id, RATE_LIMITS.generateMessage))) return rateLimited();

    const parsed = generateMessageSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return validationError(parsed.error);
    const input = parsed.data;

    const { data: lead, error: leadError } = await supabase
      .from('leads')
      .select('*')
      .eq('id', input.leadId)
      .eq('user_id', user.id)
      .maybeSingle<Lead>();

    if (leadError) return serverError('messages:generate:lead', leadError);
    if (!lead) return notFound('Lead');
    if (lead.status === 'do_not_contact') return doNotContact();

    // An explicit choice wins, including an explicit "no campaign" (null).
    const campaignId = input.campaignId === undefined ? lead.campaign_id : input.campaignId;
    let campaign: Campaign | null = null;
    if (campaignId) {
      const { data, error } = await supabase
        .from('campaigns')
        .select('*')
        .eq('id', campaignId)
        .eq('user_id', user.id)
        .maybeSingle<Campaign>();
      if (error) return serverError('messages:generate:campaign', error);
      if (!data) return notFound('Campaign');
      campaign = data;
    }

    let generated;
    try {
      generated = await generateOutreachMessage({
        lead,
        campaign,
        channel: input.channel,
        instructions: input.instructions,
      });
    } catch (error) {
      if (error instanceof AiGenerationError) {
        return fail(error.code, error.message, AI_ERROR_STATUS[error.code]);
      }
      throw error;
    }

    const { data, error } = await supabase
      .from('outreach_messages')
      .insert({
        user_id: user.id,
        lead_id: lead.id,
        campaign_id: campaign?.id ?? null,
        channel: input.channel,
        body: generated.body,
        source: 'ai',
        ai_model: generated.model,
      })
      .select()
      .single<OutreachMessage>();

    if (error) return serverError('messages:generate:save', error);

    return ok({ message: data }, 201);
  } catch (error) {
    return serverError('messages:generate', error);
  }
}
