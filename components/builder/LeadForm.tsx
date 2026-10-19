'use client';

import { useState, type FormEvent } from 'react';
import { useCampaigns } from '@/components/campaigns/useCampaigns';
import { Alert, Button, Card, CardBody, CardHeader, cx } from '@/components/ui';
import { ApiRequestError, apiFetch } from '@/lib/api/client';
import {
  MESSAGE_CHANNELS,
  MESSAGE_CHANNEL_LABELS,
  MESSAGE_MAX_LENGTH,
  type MessageChannel,
} from '@/lib/constants/outreach';

interface LeadFields {
  name: string;
  role: string;
  company: string;
  linkedinUrl: string;
}

const EMPTY: LeadFields = { name: '', role: '', company: '', linkedinUrl: '' };

const FIELDS = [
  { key: 'name', label: 'Name', placeholder: 'Mette Sørensen', required: true, type: 'text' },
  { key: 'role', label: 'Role', placeholder: 'CFO', required: true, type: 'text' },
  { key: 'company', label: 'Company', placeholder: 'Nordlys A/S', required: true, type: 'text' },
  {
    key: 'linkedinUrl',
    label: 'LinkedIn URL',
    placeholder: 'https://www.linkedin.com/in/…',
    required: false,
    type: 'url',
  },
] as const;

/**
 * The AI Lead Builder form: enter a lead, generate a message, review and edit
 * it, then save lead and message together as a draft. Nothing is stored until
 * Save is pressed.
 */
export function LeadForm({ onSaved }: { onSaved: (existingLead: boolean) => void }) {
  const campaigns = useCampaigns();
  const [lead, setLead] = useState<LeadFields>(EMPTY);
  const [campaignId, setCampaignId] = useState('');
  const [channel, setChannel] = useState<MessageChannel>('connection_request');
  const [instructions, setInstructions] = useState('');

  const [message, setMessage] = useState<string | null>(null);
  const [source, setSource] = useState<'ai' | 'manual'>('ai');
  const [aiModel, setAiModel] = useState<string | undefined>();

  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const max = MESSAGE_MAX_LENGTH[channel];
  const length = message?.trim().length ?? 0;

  function handleError(err: unknown, fallback: string) {
    if (err instanceof ApiRequestError) {
      setError(err.message);
      if (err.fields) setFieldErrors(err.fields);
    } else {
      setError(fallback);
    }
  }

  async function generate(event?: FormEvent) {
    event?.preventDefault();
    setGenerating(true);
    setError(null);
    setFieldErrors({});
    setNotice(null);
    try {
      const data = await apiFetch<{ message: string; model: string }>('/api/generate-message', {
        method: 'POST',
        body: JSON.stringify({
          ...lead,
          campaignId: campaignId || null,
          channel,
          instructions,
        }),
      });
      setMessage(data.message);
      setSource('ai');
      setAiModel(data.model);
    } catch (err) {
      handleError(err, 'Could not generate a message.');
    } finally {
      setGenerating(false);
    }
  }

  function writeManually() {
    setMessage('');
    setSource('manual');
    setAiModel(undefined);
    setNotice(null);
  }

  async function save() {
    if (message === null) return;
    setSaving(true);
    setError(null);
    setFieldErrors({});
    try {
      const data = await apiFetch<{ existingLead: boolean }>('/api/builder', {
        method: 'POST',
        body: JSON.stringify({
          ...lead,
          campaignId: campaignId || null,
          channel,
          body: message,
          source,
          ...(aiModel ? { aiModel } : {}),
        }),
      });
      setNotice(
        data.existingLead
          ? `${lead.name} was already in your leads, so the draft was added to that lead.`
          : `Saved ${lead.name} with a draft message.`,
      );
      setLead(EMPTY);
      setInstructions('');
      setMessage(null);
      onSaved(data.existingLead);
    } catch (err) {
      handleError(err, 'Could not save the lead.');
    } finally {
      setSaving(false);
    }
  }

  const fieldError = (key: string) =>
    fieldErrors[key] ? <p className="field-error">{fieldErrors[key]?.[0]}</p> : null;

  return (
    <Card>
      <CardHeader
        title="New lead"
        description="Enter the lead, generate a personalised LinkedIn message, review it, then save."
      />
      <CardBody className="space-y-4">
        {error && <Alert tone="error">{error}</Alert>}
        {notice && <Alert tone="success">{notice}</Alert>}

        <form onSubmit={generate} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            {FIELDS.map((field) => (
              <div key={field.key}>
                <label htmlFor={`builder-${field.key}`} className="field-label">
                  {field.label}
                  {!field.required && <span className="font-normal text-slate-400"> (optional)</span>}
                </label>
                <input
                  id={`builder-${field.key}`}
                  type={field.type}
                  required={field.required}
                  value={lead[field.key]}
                  onChange={(e) => setLead({ ...lead, [field.key]: e.target.value })}
                  placeholder={field.placeholder}
                  className="field-input"
                />
                {fieldError(field.key)}
              </div>
            ))}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="builder-campaign" className="field-label">
                Campaign <span className="font-normal text-slate-400">(optional)</span>
              </label>
              <select
                id="builder-campaign"
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
              <p className="mt-1 text-xs text-slate-500">
                A campaign tells the AI who you are and what you offer.
              </p>
            </div>
            <div>
              <label htmlFor="builder-channel" className="field-label">
                Message type
              </label>
              <select
                id="builder-channel"
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

          <div>
            <label htmlFor="builder-instructions" className="field-label">
              Extra guidance <span className="font-normal text-slate-400">(optional)</span>
            </label>
            <input
              id="builder-instructions"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              maxLength={500}
              placeholder="e.g. We met at the Aarhus fintech meetup last week"
              className="field-input"
            />
            <p className="mt-1 text-xs text-slate-500">
              The AI only uses what you enter here. It does not look anything up about the person.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button type="submit" loading={generating}>
              {message !== null && source === 'ai' ? 'Regenerate message' : 'Generate message'}
            </Button>
            {message === null && (
              <Button type="button" variant="secondary" onClick={writeManually}>
                Write it myself
              </Button>
            )}
          </div>
        </form>

        {message !== null && (
          <div className="space-y-2 border-t border-slate-200 pt-4">
            <label htmlFor="builder-message" className="field-label">
              {source === 'ai' ? 'Generated message — review and edit before saving' : 'Your message'}
            </label>
            <textarea
              id="builder-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={channel === 'connection_request' ? 4 : 8}
              className="field-input resize-y"
            />
            <p className={cx('text-xs', length > max ? 'text-rose-600' : 'text-slate-500')}>
              {length} / {max} characters
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => void save()}
                loading={saving}
                disabled={length === 0 || length > max}
              >
                Save lead &amp; message
              </Button>
              <Button variant="ghost" onClick={() => setMessage(null)}>
                Discard
              </Button>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
