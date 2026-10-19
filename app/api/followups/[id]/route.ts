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
import { updateFollowUpSchema } from '@/lib/validation/schemas';
import type { FollowUpTask } from '@/types/database';

type Params = { params: Promise<{ id: string }> };

/** PATCH /api/followups/[id] — skip it, or move it to another time. */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const auth = await getAuthedContext();
    if (!auth) return unauthorized();
    const { user, supabase } = auth;
    const { id } = await params;

    if (!(await checkRateLimit(user.id, RATE_LIMITS.mutateMessage))) return rateLimited();

    const parsed = updateFollowUpSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return validationError(parsed.error);
    const input = parsed.data;

    const { data: current, error: loadError } = await supabase
      .from('follow_up_tasks')
      .select('*')
      .eq('id', id)
      .eq('user_id', user.id)
      .maybeSingle<FollowUpTask>();
    if (loadError) return serverError('followups:patch:load', loadError);
    if (!current) return notFound('Follow-up');
    if (current.status === 'done' || current.status === 'cancelled') {
      return fail('task_closed', 'This follow-up is already closed.', 409);
    }

    const patch =
      input.action === 'skip' ? { status: 'cancelled' as const } : { due_at: input.dueAt };

    const { data, error } = await supabase
      .from('follow_up_tasks')
      .update(patch)
      .eq('id', id)
      .eq('user_id', user.id)
      .select()
      .maybeSingle<FollowUpTask>();
    if (error) return serverError('followups:patch', error);
    if (!data) return notFound('Follow-up');

    return ok({ followUp: data });
  } catch (error) {
    return serverError('followups:patch', error);
  }
}
