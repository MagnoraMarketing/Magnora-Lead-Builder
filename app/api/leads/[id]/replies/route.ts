import { getAuthedContext } from '@/lib/api/auth';
import { RATE_LIMITS, checkRateLimit } from '@/lib/api/rate-limit';
import {
  notFound,
  ok,
  rateLimited,
  serverError,
  unauthorized,
  validationError,
} from '@/lib/api/response';
import { createReplySchema } from '@/lib/validation/schemas';
import type { LeadReply } from '@/types/database';

type Params = { params: Promise<{ id: string }> };

/** GET /api/leads/[id]/replies — what the lead has written back, oldest first. */
export async function GET(_request: Request, { params }: Params) {
  try {
    const auth = await getAuthedContext();
    if (!auth) return unauthorized();
    const { user, supabase } = auth;
    const { id } = await params;

    const { data, error } = await supabase
      .from('lead_replies')
      .select('*')
      .eq('lead_id', id)
      .eq('user_id', user.id)
      .order('received_at', { ascending: true })
      .returns<LeadReply[]>();

    if (error) return serverError('replies:list', error);
    return ok({ replies: data ?? [] });
  } catch (error) {
    return serverError('replies:list', error);
  }
}

/**
 * POST /api/leads/[id]/replies — records the lead's reply, pasted in by the
 * user. The database then cancels the lead's open follow-ups.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const auth = await getAuthedContext();
    if (!auth) return unauthorized();
    const { user, supabase } = auth;
    const { id } = await params;

    if (!(await checkRateLimit(user.id, RATE_LIMITS.mutateMessage))) return rateLimited();

    const parsed = createReplySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return validationError(parsed.error);

    const { data, error } = await supabase
      .from('lead_replies')
      .insert({
        user_id: user.id,
        lead_id: id,
        body: parsed.data.body,
        ...(parsed.data.receivedAt ? { received_at: parsed.data.receivedAt } : {}),
      })
      .select()
      .single<LeadReply>();

    // The composite foreign key rejects a lead the caller does not own.
    if (error?.code === '23503') return notFound('Lead');
    if (error) return serverError('replies:create', error);

    return ok({ reply: data }, 201);
  } catch (error) {
    return serverError('replies:create', error);
  }
}
