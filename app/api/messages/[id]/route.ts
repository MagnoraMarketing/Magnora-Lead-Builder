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
import { MESSAGE_MAX_LENGTH } from '@/lib/constants/outreach';
import { applyMessageAction, canEditBody } from '@/lib/outreach/lifecycle';
import { updateMessageSchema } from '@/lib/validation/schemas';
import type { OutreachMessage } from '@/types/database';

type Params = { params: Promise<{ id: string }> };

/**
 * PATCH /api/messages/[id] — edit the text, or apply one lifecycle action.
 *
 * Editing an approved message sends it back to draft (the database trigger
 * does this too). "mark_sent" is an explicit user action; nothing in the app
 * calls it as a side effect of copying the text.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const auth = await getAuthedContext();
    if (!auth) return unauthorized();
    const { user, supabase } = auth;
    const { id } = await params;

    if (!(await checkRateLimit(user.id, RATE_LIMITS.mutateMessage))) return rateLimited();

    const parsed = updateMessageSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return validationError(parsed.error);
    const input = parsed.data;

    const { data: current, error: loadError } = await supabase
      .from('outreach_messages')
      .select('*')
      .eq('id', id)
      .eq('user_id', user.id)
      .maybeSingle<OutreachMessage>();

    if (loadError) return serverError('messages:patch:load', loadError);
    if (!current) return notFound('Message');

    let patch: Partial<Pick<OutreachMessage, 'body' | 'status'>>;

    if (input.action === 'edit') {
      if (!canEditBody(current.status)) {
        return fail('message_sent', 'A sent message is kept as a record and cannot be edited.', 409);
      }
      const max = MESSAGE_MAX_LENGTH[current.channel];
      if (input.body.length > max) {
        return fail('validation_error', 'Some fields need attention.', 422, {
          body: [`This message can be at most ${max} characters.`],
        });
      }
      patch = { body: input.body };
      // Approval belongs to the exact words approved.
      if (current.status === 'approved' && input.body !== current.body) patch.status = 'draft';
    } else {
      const transition = applyMessageAction(current.status, input.action);
      if (!transition.ok) return fail('invalid_transition', transition.reason, 409);
      patch = { status: transition.status };
    }

    const { data, error } = await supabase
      .from('outreach_messages')
      .update(patch)
      .eq('id', id)
      .eq('user_id', user.id)
      .select()
      .maybeSingle<OutreachMessage>();

    // The trigger is the backstop for a race with another tab.
    if (error?.code === '23514') return fail('invalid_transition', 'That change is not allowed.', 409);
    if (error) return serverError('messages:patch', error);
    if (!data) return notFound('Message');

    return ok({ message: data });
  } catch (error) {
    return serverError('messages:patch', error);
  }
}

/** DELETE /api/messages/[id] */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const auth = await getAuthedContext();
    if (!auth) return unauthorized();
    const { user, supabase } = auth;
    const { id } = await params;

    if (!(await checkRateLimit(user.id, RATE_LIMITS.mutateMessage))) return rateLimited();

    const { error, count } = await supabase
      .from('outreach_messages')
      .delete({ count: 'exact' })
      .eq('id', id)
      .eq('user_id', user.id);

    if (error) return serverError('messages:delete', error);
    if (!count) return notFound('Message');

    return ok({ deleted: true });
  } catch (error) {
    return serverError('messages:delete', error);
  }
}
