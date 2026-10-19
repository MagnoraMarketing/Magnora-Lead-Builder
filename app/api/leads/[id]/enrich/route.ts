import { randomBytes } from 'node:crypto';
import { getAuthedContext } from '@/lib/api/auth';
import { RATE_LIMITS, checkRateLimit } from '@/lib/api/rate-limit';
import {
  fail,
  notFound,
  ok,
  rateLimited,
  serverError,
  unauthorized,
} from '@/lib/api/response';
import { enrichmentEnv } from '@/lib/env';
import { ApolloEnrichmentProvider, ApolloRequestError, APOLLO_PROVIDER_ID } from '@/lib/integrations/enrichment/apollo';
import { fillEmptyFields } from '@/lib/integrations/enrichment/apply';
import { doNotContact } from '@/lib/outreach/api';
import type { Json } from '@/types/supabase';
import type { Lead } from '@/types/database';

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/leads/[id]/enrich — looks the lead up with Apollo.io.
 *
 * A verified email and company details are applied straight away, filling
 * only empty fields. Phone numbers are requested too when the app has a public
 * URL for Apollo's webhook; they arrive minutes later and land through
 * /api/webhooks/apollo/[token], again only into empty fields.
 */
export async function POST(_request: Request, { params }: Params) {
  try {
    const auth = await getAuthedContext();
    if (!auth) return unauthorized();
    const { user, supabase } = auth;
    const { id } = await params;

    const env = enrichmentEnv();
    if (!env.apolloApiKey) {
      return fail(
        'enrichment_not_configured',
        'Contact lookup is not set up on this deployment. Add APOLLO_API_KEY to the server environment.',
        503,
      );
    }

    if (!(await checkRateLimit(user.id, RATE_LIMITS.enrichLead))) return rateLimited();

    const { data: lead, error: leadError } = await supabase
      .from('leads')
      .select('*')
      .eq('id', id)
      .eq('user_id', user.id)
      .maybeSingle<Lead>();
    if (leadError) return serverError('enrich:lead', leadError);
    if (!lead) return notFound('Lead');
    if (lead.status === 'do_not_contact') return doNotContact();

    const token = randomBytes(32).toString('hex');
    const webhookUrl = env.publicUrl
      ? `${env.publicUrl}/api/webhooks/apollo/${token}` +
        (env.bypassSecret ? `?x-vercel-protection-bypass=${encodeURIComponent(env.bypassSecret)}` : '')
      : null;

    const { data: requestRow, error: requestError } = await supabase
      .from('enrichment_requests')
      .insert({
        user_id: user.id,
        lead_id: lead.id,
        provider: APOLLO_PROVIDER_ID,
        webhook_token: webhookUrl ? token : null,
        phone_requested: Boolean(webhookUrl),
      })
      .select('id')
      .single<{ id: string }>();
    if (requestError || !requestRow) return serverError('enrich:request', requestError);

    const provider = new ApolloEnrichmentProvider(env.apolloApiKey);
    let result;
    try {
      result = await provider.enrichLead(lead, { webhookUrl });
    } catch (error) {
      const message = error instanceof ApolloRequestError ? error.message : 'Apollo could not be reached.';
      console.error('[enrich] apollo failed', error);
      await supabase
        .from('enrichment_requests')
        .update({ status: 'failed', error_message: message, completed_at: new Date().toISOString() })
        .eq('id', requestRow.id)
        .eq('user_id', user.id);
      await supabase
        .from('leads')
        .update({ enrichment_status: 'failed', enriched_at: new Date().toISOString() })
        .eq('id', lead.id)
        .eq('user_id', user.id);
      return fail('enrichment_failed', `The contact lookup failed: ${message}`, 502);
    }

    const patch = fillEmptyFields(lead, result.fields);
    const { data: updated, error: updateError } = await supabase
      .from('leads')
      .update({
        ...patch,
        enrichment_status: result.found ? 'found' : 'not_found',
        enriched_at: new Date().toISOString(),
      })
      .eq('id', lead.id)
      .eq('user_id', user.id)
      .select()
      .maybeSingle<Lead>();
    if (updateError) return serverError('enrich:apply', updateError);

    const phonePending = Boolean(webhookUrl) && result.found;
    await supabase
      .from('enrichment_requests')
      .update({
        response: result.raw as Json,
        status: phonePending ? 'pending' : 'completed',
        completed_at: phonePending ? null : new Date().toISOString(),
      })
      .eq('id', requestRow.id)
      .eq('user_id', user.id);

    return ok({
      lead: updated ?? lead,
      found: result.found,
      filled: Object.keys(patch),
      phonePending,
    });
  } catch (error) {
    return serverError('enrich', error);
  }
}
