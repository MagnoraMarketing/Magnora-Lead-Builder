'use client';

import { useState, type FormEvent } from 'react';
import { Alert, Button } from '@/components/ui';
import { ApiRequestError, apiFetch } from '@/lib/api/client';
import {
  CAMPAIGN_LANGUAGES,
  CAMPAIGN_LANGUAGE_LABELS,
  CAMPAIGN_STATUSES,
  CAMPAIGN_STATUS_LABELS,
  CAMPAIGN_TONES,
  CAMPAIGN_TONE_LABELS,
} from '@/lib/constants/outreach';
import type { Campaign } from '@/types/database';

type FormState = {
  name: string;
  description: string;
  sender_name: string;
  sender_company: string;
  offer: string;
  call_to_action: string;
  tone: Campaign['tone'];
  language: Campaign['language'];
  status: Campaign['status'];
};

function toForm(campaign?: Campaign): FormState {
  return {
    name: campaign?.name ?? '',
    description: campaign?.description ?? '',
    sender_name: campaign?.sender_name ?? '',
    sender_company: campaign?.sender_company ?? '',
    offer: campaign?.offer ?? '',
    call_to_action: campaign?.call_to_action ?? '',
    tone: campaign?.tone ?? 'professional',
    language: campaign?.language ?? 'da',
    status: campaign?.status ?? 'active',
  };
}

const TEXT_FIELDS = [
  { key: 'sender_name', label: 'Your name', hint: 'Used to sign direct messages.', max: 120 },
  { key: 'sender_company', label: 'Your company', hint: undefined, max: 200 },
] as const;

/**
 * Create or edit a campaign. The sender fields and the offer are the only
 * facts the AI may state about the sender, so the hints say so.
 */
export function CampaignForm({
  campaign,
  onSaved,
  onCancel,
}: {
  campaign?: Campaign;
  onSaved: (campaign: Campaign) => void;
  onCancel?: () => void;
}) {
  const [form, setForm] = useState<FormState>(() => toForm(campaign));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setFieldErrors({});
    try {
      const data = await apiFetch<{ campaign: Campaign }>(
        campaign ? `/api/campaigns/${campaign.id}` : '/api/campaigns',
        { method: campaign ? 'PATCH' : 'POST', body: JSON.stringify(form) },
      );
      onSaved(data.campaign);
      if (!campaign) setForm(toForm());
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setError(err.message);
        if (err.fields) setFieldErrors(err.fields);
      } else {
        setError('Could not save the campaign.');
      }
    } finally {
      setSaving(false);
    }
  }

  const fieldError = (key: string) =>
    fieldErrors[key] ? <p className="field-error">{fieldErrors[key]?.[0]}</p> : null;

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && <Alert tone="error">{error}</Alert>}

      <div>
        <label htmlFor="campaign-name" className="field-label">
          Name
        </label>
        <input
          id="campaign-name"
          value={form.name}
          onChange={(e) => set('name', e.target.value)}
          maxLength={120}
          required
          className="field-input"
          placeholder="e.g. CFOs in Copenhagen — Q1"
        />
        {fieldError('name')}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {TEXT_FIELDS.map((field) => (
          <div key={field.key}>
            <label htmlFor={`campaign-${field.key}`} className="field-label">
              {field.label}
            </label>
            <input
              id={`campaign-${field.key}`}
              value={form[field.key]}
              onChange={(e) => set(field.key, e.target.value)}
              maxLength={field.max}
              className="field-input"
            />
            {field.hint && <p className="mt-1 text-xs text-slate-500">{field.hint}</p>}
            {fieldError(field.key)}
          </div>
        ))}
      </div>

      <div>
        <label htmlFor="campaign-offer" className="field-label">
          What you offer
        </label>
        <textarea
          id="campaign-offer"
          value={form.offer}
          onChange={(e) => set('offer', e.target.value)}
          maxLength={2000}
          rows={4}
          className="field-input resize-y"
          placeholder="One or two sentences on what you do and for whom. Only write claims you can stand behind — the AI repeats what is here and invents nothing else."
        />
        {fieldError('offer')}
      </div>

      <div>
        <label htmlFor="campaign-cta" className="field-label">
          Next step you want
        </label>
        <input
          id="campaign-cta"
          value={form.call_to_action}
          onChange={(e) => set('call_to_action', e.target.value)}
          maxLength={300}
          className="field-input"
          placeholder="e.g. A 15-minute call next week"
        />
        {fieldError('call_to_action')}
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label htmlFor="campaign-tone" className="field-label">
            Tone
          </label>
          <select
            id="campaign-tone"
            value={form.tone}
            onChange={(e) => set('tone', e.target.value as FormState['tone'])}
            className="field-input"
          >
            {CAMPAIGN_TONES.map((t) => (
              <option key={t} value={t}>
                {CAMPAIGN_TONE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="campaign-language" className="field-label">
            Language
          </label>
          <select
            id="campaign-language"
            value={form.language}
            onChange={(e) => set('language', e.target.value as FormState['language'])}
            className="field-input"
          >
            {CAMPAIGN_LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {CAMPAIGN_LANGUAGE_LABELS[l]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="campaign-status" className="field-label">
            Status
          </label>
          <select
            id="campaign-status"
            value={form.status}
            onChange={(e) => set('status', e.target.value as FormState['status'])}
            className="field-input"
          >
            {CAMPAIGN_STATUSES.map((s) => (
              <option key={s} value={s}>
                {CAMPAIGN_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label htmlFor="campaign-description" className="field-label">
          Internal notes (not shown to the AI)
        </label>
        <textarea
          id="campaign-description"
          value={form.description}
          onChange={(e) => set('description', e.target.value)}
          maxLength={2000}
          rows={2}
          className="field-input resize-y"
        />
      </div>

      <div className="flex gap-2">
        <Button type="submit" loading={saving}>
          {campaign ? 'Save changes' : 'Create campaign'}
        </Button>
        {onCancel && (
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
