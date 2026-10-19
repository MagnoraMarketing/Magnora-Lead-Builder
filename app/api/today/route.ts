import type { NextRequest } from 'next/server';
import { getAuthedContext } from '@/lib/api/auth';
import { ok, serverError, unauthorized, validationError } from '@/lib/api/response';
import { MESSAGE_LEAD_SELECT } from '@/lib/outreach/api';
import { FOLLOW_UP_LEAD_SELECT, defaultUntil } from '@/lib/outreach/followups';
import { todayQuerySchema } from '@/lib/validation/schemas';
import type {
  FollowUpTaskWithLead,
  LeadReplyWithLead,
  OutreachMessage,
  OutreachMessageWithLead,
  TodayOverview,
} from '@/types/database';

/**
 * GET /api/today?until= — the semi-automatic outreach worklist:
 *
 *   followUps      planned follow-ups due by `until`, with any draft written
 *   readyToSend    approved messages with no planned time, or planned by `until`
 *   awaitingAnswer the lead's latest reply is newer than anything sent to them
 *
 * `until` is the end of the user's local day, sent by the browser, so "today"
 * means the user's today rather than the server's.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthedContext();
    if (!auth) return unauthorized();
    const { user, supabase } = auth;

    const parsed = todayQuerySchema.safeParse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );
    if (!parsed.success) return validationError(parsed.error);
    // Normalised to UTC "Z" form: it is interpolated into a PostgREST filter,
    // where a "+01:00" offset would be read as a space.
    const until = new Date(parsed.data.until ?? defaultUntil()).toISOString();

    const [tasks, approved, replies] = await Promise.all([
      supabase
        .from('follow_up_tasks')
        .select(FOLLOW_UP_LEAD_SELECT)
        .eq('user_id', user.id)
        .in('status', ['pending', 'drafted'])
        .lte('due_at', until)
        .order('due_at', { ascending: true })
        .limit(200)
        .returns<FollowUpTaskWithLead[]>(),
      supabase
        .from('outreach_messages')
        .select(MESSAGE_LEAD_SELECT)
        .eq('user_id', user.id)
        .eq('status', 'approved')
        .or(`scheduled_for.is.null,scheduled_for.lte.${until}`)
        .order('scheduled_for', { ascending: true, nullsFirst: false })
        .limit(200)
        .returns<OutreachMessageWithLead[]>(),
      supabase
        .from('lead_replies')
        .select('*, lead:leads(id, full_name, job_title, company_name, linkedin_url, status)')
        .eq('user_id', user.id)
        .order('received_at', { ascending: false })
        .limit(200)
        .returns<LeadReplyWithLead[]>(),
    ]);
    if (tasks.error) return serverError('today:tasks', tasks.error);
    if (approved.error) return serverError('today:approved', approved.error);
    if (replies.error) return serverError('today:replies', replies.error);

    // Drafts written for the due follow-ups.
    const messageIds = (tasks.data ?? []).map((t) => t.message_id).filter((id): id is string => !!id);
    const drafts = new Map<string, OutreachMessage>();
    if (messageIds.length > 0) {
      const { data, error } = await supabase
        .from('outreach_messages')
        .select('*')
        .eq('user_id', user.id)
        .in('id', messageIds)
        .returns<OutreachMessage[]>();
      if (error) return serverError('today:drafts', error);
      for (const m of data ?? []) drafts.set(m.id, m);
    }

    // Latest reply per lead, kept only when nothing was sent after it.
    const latestReply = new Map<string, LeadReplyWithLead>();
    for (const r of replies.data ?? []) {
      if (!latestReply.has(r.lead_id)) latestReply.set(r.lead_id, r);
    }
    const awaitingAnswer: LeadReplyWithLead[] = [];
    if (latestReply.size > 0) {
      const { data, error } = await supabase
        .from('outreach_messages')
        .select('lead_id, sent_at')
        .eq('user_id', user.id)
        .eq('status', 'sent')
        .in('lead_id', [...latestReply.keys()])
        .returns<Pick<OutreachMessage, 'lead_id' | 'sent_at'>[]>();
      if (error) return serverError('today:sent', error);
      const lastSent = new Map<string, string>();
      for (const m of data ?? []) {
        if (m.sent_at && (lastSent.get(m.lead_id) ?? '') < m.sent_at) lastSent.set(m.lead_id, m.sent_at);
      }
      for (const [leadId, reply] of latestReply) {
        if ((lastSent.get(leadId) ?? '') < reply.received_at) awaitingAnswer.push(reply);
      }
    }

    const overview: TodayOverview = {
      followUps: (tasks.data ?? []).map((t) => ({
        ...t,
        message: t.message_id ? (drafts.get(t.message_id) ?? null) : null,
      })),
      readyToSend: approved.data ?? [],
      awaitingAnswer,
    };
    return ok(overview);
  } catch (error) {
    return serverError('today', error);
  }
}
