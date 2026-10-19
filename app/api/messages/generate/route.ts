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
import { AI_ERROR_STATUS, aiNotConfigured, draftContextFailure } from '@/lib/outreach/api';
import { inferKind, loadDraftContext } from '@/lib/outreach/context';
import type { OutreachKind } from '@/lib/outreach/prompt';
import { generateMessageSchema } from '@/lib/validation/schemas';
import type { FollowUpTask, OutreachMessage } from '@/types/database';

/**
 * POST /api/messages/generate — drafts a LinkedIn message with AI and saves it
 * as a draft: a first message, a follow-up (optionally for a planned
 * follow-up task), or a reply to what the lead wrote. The draft is never
 * approved or sent automatically.
 *
 * Personalisation uses only what is stored: the lead's fields, the campaign's
 * sender context, and the conversation the user has recorded.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthedContext();
    if (!auth) return unauthorized();
    const { user, supabase } = auth;

    // Checked before the rate limiter so an unconfigured deployment does not
    // burn the user's quota on requests that cannot succeed.
    if (!isAiConfigured()) return aiNotConfigured();

    if (!(await checkRateLimit(user.id, RATE_LIMITS.generateMessage))) return rateLimited();

    const parsed = generateMessageSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return validationError(parsed.error);
    const input = parsed.data;

    let task: FollowUpTask | null = null;
    if (input.taskId) {
      const { data, error } = await supabase
        .from('follow_up_tasks')
        .select('*')
        .eq('id', input.taskId)
        .eq('user_id', user.id)
        .eq('lead_id', input.leadId)
        .maybeSingle<FollowUpTask>();
      if (error) return serverError('messages:generate:task', error);
      if (!data) return notFound('Follow-up');
      if (data.status !== 'pending') {
        return fail('task_not_pending', 'This follow-up already has a draft or is closed.', 409);
      }
      task = data;
    }

    const context = await loadDraftContext(
      supabase,
      user.id,
      input.leadId,
      input.campaignId === undefined ? (task?.campaign_id ?? undefined) : input.campaignId,
    );
    if (!context.ok) return draftContextFailure(context, 'messages:generate:context');
    const { lead, campaign, conversation } = context;

    const kind: OutreachKind = task ? 'follow_up' : (input.kind ?? inferKind(conversation));
    const channel = task?.channel ?? input.channel;

    let generated;
    try {
      generated = await generateOutreachMessage({
        lead,
        campaign,
        channel,
        instructions: input.instructions,
        kind,
        topic: task?.topic,
        conversation,
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
        channel,
        body: generated.body,
        source: 'ai',
        ai_model: generated.model,
        kind,
        sequence_step: task?.step_number ?? null,
        scheduled_for: task?.due_at ?? null,
      })
      .select()
      .single<OutreachMessage>();

    if (error || !data) return serverError('messages:generate:save', error);

    if (task) {
      const { error: taskError } = await supabase
        .from('follow_up_tasks')
        .update({ status: 'drafted', message_id: data.id })
        .eq('id', task.id)
        .eq('user_id', user.id);
      if (taskError) return serverError('messages:generate:task-link', taskError);
    }

    return ok({ message: data }, 201);
  } catch (error) {
    return serverError('messages:generate', error);
  }
}
