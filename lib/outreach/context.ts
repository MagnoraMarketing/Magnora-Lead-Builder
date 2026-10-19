import type { getAuthedContext } from '@/lib/api/auth';
import type { ConversationEntry, OutreachKind } from '@/lib/outreach/prompt';
import type { Campaign, Lead, LeadReply, OutreachMessage } from '@/types/database';

type AuthedSupabase = NonNullable<Awaited<ReturnType<typeof getAuthedContext>>>['supabase'];

export type DraftContext =
  | { ok: true; lead: Lead; campaign: Campaign | null; conversation: ConversationEntry[] }
  | { ok: false; reason: 'lead_not_found' | 'campaign_not_found' | 'do_not_contact' | 'db_error'; error?: unknown };

/**
 * Everything the generator may use for one lead: the lead itself, its
 * campaign (an explicit choice wins, including an explicit `null`), and the
 * conversation so far — messages actually marked sent, and the lead's
 * replies — oldest first. Drafts that were never sent are not included.
 */
export async function loadDraftContext(
  supabase: AuthedSupabase,
  userId: string,
  leadId: string,
  campaignId?: string | null,
): Promise<DraftContext> {
  const { data: lead, error: leadError } = await supabase
    .from('leads')
    .select('*')
    .eq('id', leadId)
    .eq('user_id', userId)
    .maybeSingle<Lead>();
  if (leadError) return { ok: false, reason: 'db_error', error: leadError };
  if (!lead) return { ok: false, reason: 'lead_not_found' };
  if (lead.status === 'do_not_contact') return { ok: false, reason: 'do_not_contact' };

  const effectiveCampaignId = campaignId === undefined ? lead.campaign_id : campaignId;
  let campaign: Campaign | null = null;
  if (effectiveCampaignId) {
    const { data, error } = await supabase
      .from('campaigns')
      .select('*')
      .eq('id', effectiveCampaignId)
      .eq('user_id', userId)
      .maybeSingle<Campaign>();
    if (error) return { ok: false, reason: 'db_error', error };
    if (!data) return { ok: false, reason: 'campaign_not_found' };
    campaign = data;
  }

  const [sent, replies] = await Promise.all([
    supabase
      .from('outreach_messages')
      .select('*')
      .eq('user_id', userId)
      .eq('lead_id', leadId)
      .eq('status', 'sent')
      .order('sent_at', { ascending: true })
      .returns<OutreachMessage[]>(),
    supabase
      .from('lead_replies')
      .select('*')
      .eq('user_id', userId)
      .eq('lead_id', leadId)
      .order('received_at', { ascending: true })
      .returns<LeadReply[]>(),
  ]);
  if (sent.error) return { ok: false, reason: 'db_error', error: sent.error };
  if (replies.error) return { ok: false, reason: 'db_error', error: replies.error };

  return { ok: true, lead, campaign, conversation: buildConversation(sent.data ?? [], replies.data ?? []) };
}

/** Merges sent messages and replies into one timeline, oldest first. */
export function buildConversation(
  sent: readonly Pick<OutreachMessage, 'body' | 'sent_at' | 'created_at'>[],
  replies: readonly Pick<LeadReply, 'body' | 'received_at'>[],
): ConversationEntry[] {
  const entries: ConversationEntry[] = [
    ...sent.map((m) => ({ from: 'sender' as const, body: m.body, at: m.sent_at ?? m.created_at })),
    ...replies.map((r) => ({ from: 'lead' as const, body: r.body, at: r.received_at })),
  ];
  return entries.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * What to write when the caller did not say: a reply if the lead spoke last,
 * a follow-up if something was already sent, otherwise a first message.
 */
export function inferKind(conversation: readonly ConversationEntry[]): OutreachKind {
  const last = conversation.at(-1);
  if (!last) return 'initial';
  return last.from === 'lead' ? 'reply' : 'follow_up';
}
