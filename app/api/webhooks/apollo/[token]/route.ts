import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { parseApolloPhoneWebhook } from '@/lib/integrations/enrichment/apollo';
import { fillEmptyFields } from '@/lib/integrations/enrichment/apply';
import type { Json } from '@/types/supabase';
import type { EnrichmentRequest, Lead } from '@/types/database';

type Params = { params: Promise<{ token: string }> };

const TOKEN = /^[0-9a-f]{64}$/;

/**
 * POST /api/webhooks/apollo/[token] — Apollo delivers revealed phone numbers.
 *
 * There is no user session here, so the service-role client is used, and the
 * token is the only authority: a 64-hex-character random value issued for one
 * lookup of one lead. It can only ever write that lead's empty phone fields.
 * Repeated deliveries (Apollo retries) are harmless: the raw payload is kept
 * on the request, and fields that are already filled are left alone.
 */
export async function POST(request: Request, { params }: Params) {
  const { token } = await params;
  if (!TOKEN.test(token)) return NextResponse.json({ ok: false }, { status: 404 });

  try {
    const admin = createAdminClient();
    const { data: req, error } = await admin
      .from('enrichment_requests')
      .select('*')
      .eq('webhook_token', token)
      .maybeSingle<EnrichmentRequest>();
    if (error) throw error;
    if (!req || !req.phone_requested) return NextResponse.json({ ok: false }, { status: 404 });

    const payload: unknown = await request.json().catch(() => null);
    const phones = parseApolloPhoneWebhook(payload);

    const { data: lead } = await admin
      .from('leads')
      .select('*')
      .eq('id', req.lead_id)
      .eq('user_id', req.user_id)
      .maybeSingle<Lead>();

    if (lead && lead.status !== 'do_not_contact') {
      const patch = fillEmptyFields(lead, phones);
      if (Object.keys(patch).length > 0) {
        const { error: updateError } = await admin
          .from('leads')
          .update({ ...patch, enrichment_status: 'found', enriched_at: new Date().toISOString() })
          .eq('id', lead.id)
          .eq('user_id', req.user_id);
        if (updateError) throw updateError;
      }
    }

    const { error: doneError } = await admin
      .from('enrichment_requests')
      .update({
        webhook_payload: (payload ?? null) as Json,
        status: 'completed',
        completed_at: new Date().toISOString(),
      })
      .eq('id', req.id);
    if (doneError) throw doneError;

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[webhook:apollo]', error);
    // 500 lets Apollo retry; the handler is idempotent.
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
