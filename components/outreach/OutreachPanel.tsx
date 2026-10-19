'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useCampaigns } from '@/components/campaigns/useCampaigns';
import { MessageCard } from '@/components/outreach/MessageCard';
import { Alert, Button, Card, CardBody, CardHeader, Spinner } from '@/components/ui';
import { ApiRequestError, apiFetch } from '@/lib/api/client';
import {
  MESSAGE_CHANNELS,
  MESSAGE_CHANNEL_LABELS,
  MESSAGE_MAX_LENGTH,
  type MessageChannel,
} from '@/lib/constants/outreach';
import type { Paginated } from '@/types/api';
import type { Lead, OutreachMessage } from '@/types/database';

/**
 * Drafting and history for one lead's LinkedIn outreach.
 *
 * AI drafts use only the lead's stored fields and the selected campaign's
 * sender details. Every draft is saved as a draft for the user to edit and
 * approve; nothing is sent from here.
 */
export function OutreachPanel({ lead, onSent }: { lead: Lead; onSent?: () => void }) {
  const campaigns = useCampaigns();
  const [messages, setMessages] = useState<OutreachMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [campaignId, setCampaignId] = useState<string>(lead.campaign_id ?? '');
  const [channel, setChannel] = useState<MessageChannel>('connection_request');
  const [instructions, setInstructions] = useState('');
  const [generating, setGenerating] = useState(false);

  const [manual, setManual] = useState(false);
  const [manualBody, setManualBody] = useState('');
  const [savingManual, setSavingManual] = useState(false);

  const blocked = lead.status === 'do_not_contact';

  // Follow the lead's campaign when it is reassigned on this page.
  useEffect(() => {
    setCampaignId(lead.campaign_id ?? '');
  }, [lead.campaign_id]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<Paginated<OutreachMessage>>(
        `/api/messages?leadId=${lead.id}&pageSize=100`,
      );
      setMessages(data.items);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load messages.');
    } finally {
      setLoading(false);
    }
  }, [lead.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function generate() {
    setGenerating(true);
    setError(null);
    try {
      const data = await apiFetch<{ message: OutreachMessage }>('/api/messages/generate', {
        method: 'POST',
        body: JSON.stringify({
          leadId: lead.id,
          campaignId: campaignId || null,
          channel,
          ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
        }),
      });
      setMessages((prev) => [data.message, ...prev]);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not draft a message.');
    } finally {
      setGenerating(false);
    }
  }

  async function saveManual() {
    setSavingManual(true);
    setError(null);
    try {
      const data = await apiFetch<{ message: OutreachMessage }>('/api/messages', {
        method: 'POST',
        body: JSON.stringify({
          leadId: lead.id,
          campaignId: campaignId || null,
          channel,
          body: manualBody,
        }),
      });
      setMessages((prev) => [data.message, ...prev]);
      setManualBody('');
      setManual(false);
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? (err.fields?.body?.[0] ?? err.message)
          : 'Could not save the message.',
      );
    } finally {
      setSavingManual(false);
    }
  }

  const replace = (updated: OutreachMessage) => {
    setMessages((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
    // Marking sent can move the lead to Contacted on the server.
    if (updated.status === 'sent') onSent?.();
  };
  const drop = (id: string) => setMessages((prev) => prev.filter((m) => m.id !== id));

  return (
    <Card>
      <CardHeader
        title="LinkedIn outreach"
        description="Drafts are saved here for you to edit and approve. Nothing is sent automatically."
      />
      <CardBody className="space-y-4">
        {blocked && (
          <Alert tone="warning">
            This lead is marked Do not contact, so no messages can be drafted.
          </Alert>
        )}
        {error && <Alert tone="error">{error}</Alert>}

        {!blocked && (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="outreach-campaign" className="field-label">
                  Campaign
                </label>
                <select
                  id="outreach-campaign"
                  value={campaignId}
                  onChange={(e) => setCampaignId(e.target.value)}
                  className="field-input"
                >
                  <option value="">No campaign</option>
                  {campaigns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                {!campaignId && (
                  <p className="mt-1 text-xs text-slate-500">
                    Without a campaign the AI knows nothing about you or your offer.{' '}
                    <Link href="/campaigns" className="text-brand-700 hover:underline">
                      Set one up
                    </Link>
                  </p>
                )}
              </div>
              <div>
                <label htmlFor="outreach-channel" className="field-label">
                  Type
                </label>
                <select
                  id="outreach-channel"
                  value={channel}
                  onChange={(e) => setChannel(e.target.value as MessageChannel)}
                  className="field-input"
                >
                  {MESSAGE_CHANNELS.map((c) => (
                    <option key={c} value={c}>
                      {MESSAGE_CHANNEL_LABELS[c]} (max {MESSAGE_MAX_LENGTH[c]} chars)
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {manual ? (
              <div>
                <label htmlFor="manual-body" className="field-label">
                  Your message
                </label>
                <textarea
                  id="manual-body"
                  value={manualBody}
                  onChange={(e) => setManualBody(e.target.value)}
                  rows={channel === 'connection_request' ? 4 : 8}
                  className="field-input resize-y"
                />
                <p className="mt-1 text-xs text-slate-500">
                  {manualBody.trim().length} / {MESSAGE_MAX_LENGTH[channel]} characters
                </p>
                <div className="mt-2 flex gap-2">
                  <Button
                    size="sm"
                    onClick={() => void saveManual()}
                    loading={savingManual}
                    disabled={
                      !manualBody.trim() || manualBody.trim().length > MESSAGE_MAX_LENGTH[channel]
                    }
                  >
                    Save draft
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setManual(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <div>
                  <label htmlFor="outreach-instructions" className="field-label">
                    Extra guidance (optional)
                  </label>
                  <input
                    id="outreach-instructions"
                    value={instructions}
                    onChange={(e) => setInstructions(e.target.value)}
                    maxLength={500}
                    placeholder="e.g. We met at the Aarhus fintech meetup last week"
                    className="field-input"
                  />
                  <p className="mt-1 text-xs text-slate-500">
                    The AI only knows what is stored on this lead and campaign, plus anything you
                    write here. It does not look anything up.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => void generate()} loading={generating}>
                    Draft with AI
                  </Button>
                  <Button variant="secondary" onClick={() => setManual(true)}>
                    Write by hand
                  </Button>
                </div>
              </>
            )}
          </div>
        )}

        <div className="space-y-3 border-t border-slate-200 pt-4">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <Spinner /> Loading messages…
            </div>
          ) : messages.length === 0 ? (
            <p className="text-sm text-slate-500">No messages for this lead yet.</p>
          ) : (
            messages.map((m) => (
              <MessageCard key={m.id} message={m} onChange={replace} onDelete={drop} />
            ))
          )}
        </div>
      </CardBody>
    </Card>
  );
}
