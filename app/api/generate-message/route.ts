import type { NextRequest } from 'next/server';
import { AiGenerationError, generateOutreachMessage } from '@/lib/ai/outreach';
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
import { AI_ERROR_STATUS, aiNotConfigured } from '@/lib/outreach/api';
import { builderLeadToFacts } from '@/lib/outreach/builder';
import { builderGenerateSchema } from '@/lib/validation/schemas';
import type { Campaign } from '@/types/database';

/**
 * POST /api/generate-message — the AI Lead Builder's generate step.
 *
 * Drafts a LinkedIn message for a lead typed into the form and returns it for
 * review. Nothing is saved: the user edits the text and saves lead and message
 * together through POST /api/builder.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthedContext();
    if (!auth) return unauthorized();
    const { user, supabase } = auth;

    if (!isAiConfigured()) return aiNotConfigured();
    if (!(await checkRateLimit(user.id, RATE_LIMITS.generateMessage))) return rateLimited();

    const parsed = builderGenerateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return validationError(parsed.error);
    const input = parsed.data;

    let campaign: Campaign | null = null;
    if (input.campaignId) {
      const { data, error } = await supabase
        .from('campaigns')
        .select('*')
        .eq('id', input.campaignId)
        .eq('user_id', user.id)
        .maybeSingle<Campaign>();
      if (error) return serverError('generate-message:campaign', error);
      if (!data) return notFound('Campaign');
      campaign = data;
    }

    try {
      const generated = await generateOutreachMessage({
        lead: builderLeadToFacts(input),
        campaign,
        channel: input.channel,
        instructions: input.instructions,
      });
      return ok({ message: generated.body, model: generated.model });
    } catch (error) {
      if (error instanceof AiGenerationError) {
        return fail(error.code, error.message, AI_ERROR_STATUS[error.code]);
      }
      throw error;
    }
  } catch (error) {
    return serverError('generate-message', error);
  }
}
