'use client';

import { useEffect, useState } from 'react';
import { Alert, Button, Card, CardBody, CardHeader, Spinner } from '@/components/ui';
import { ApiRequestError, apiFetch } from '@/lib/api/client';
import {
  MESSAGE_CHANNELS,
  MESSAGE_CHANNEL_LABELS,
  type MessageChannel,
} from '@/lib/constants/outreach';
import type { CampaignStep } from '@/types/database';

interface StepDraft {
  delayDays: number;
  topic: string;
  channel: MessageChannel;
}

const toDraft = (s: CampaignStep): StepDraft => ({
  delayDays: s.delay_days,
  topic: s.topic ?? '',
  channel: s.channel,
});

/**
 * The follow-up sequence of a campaign. When a message to one of the
 * campaign's leads is marked sent, the next step is planned for that lead
 * automatically and shows up on Today when due — unless the lead has replied
 * or reached a final status.
 */
export function SequenceEditor({ campaignId }: { campaignId: string }) {
  const [steps, setSteps] = useState<StepDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    apiFetch<{ steps: CampaignStep[] }>(`/api/campaigns/${campaignId}/steps`)
      .then((data) => setSteps(data.steps.map(toDraft)))
      .catch((err) =>
        setError(err instanceof ApiRequestError ? err.message : 'Could not load the sequence.'),
      )
      .finally(() => setLoading(false));
  }, [campaignId]);

  const update = (index: number, patch: Partial<StepDraft>) =>
    setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const data = await apiFetch<{ steps: CampaignStep[] }>(`/api/campaigns/${campaignId}/steps`, {
        method: 'PUT',
        body: JSON.stringify({ steps }),
      });
      setSteps(data.steps.map(toDraft));
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save the sequence.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Follow-up sequence"
        description="Planned automatically after each message you mark as sent. Stops when the lead replies."
      />
      <CardBody className="space-y-3">
        {error && <Alert tone="error">{error}</Alert>}
        {saved && <Alert tone="success">Sequence saved.</Alert>}

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Spinner /> Loading…
          </div>
        ) : (
          <>
            <p className="text-sm text-slate-600">
              <strong>Step 1</strong> is your first message.
              {steps.length === 0 && ' No follow-ups yet.'}
            </p>
            {steps.map((step, index) => (
              <div
                key={index}
                className="grid gap-3 rounded-md border border-slate-200 p-3 sm:grid-cols-[auto_8rem_1fr_12rem_auto] sm:items-end"
              >
                <p className="text-sm font-medium text-slate-900">Follow-up {index + 1}</p>
                <div>
                  <label htmlFor={`delay-${index}`} className="field-label">
                    Days after previous
                  </label>
                  <input
                    id={`delay-${index}`}
                    type="number"
                    min={1}
                    max={90}
                    value={step.delayDays}
                    onChange={(e) => update(index, { delayDays: Number(e.target.value) })}
                    className="field-input"
                  />
                </div>
                <div>
                  <label htmlFor={`topic-${index}`} className="field-label">
                    Topic / angle
                  </label>
                  <input
                    id={`topic-${index}`}
                    value={step.topic}
                    maxLength={500}
                    onChange={(e) => update(index, { topic: e.target.value })}
                    placeholder="e.g. Short reminder, then share a relevant result"
                    className="field-input"
                  />
                </div>
                <div>
                  <label htmlFor={`channel-${index}`} className="field-label">
                    Type
                  </label>
                  <select
                    id={`channel-${index}`}
                    value={step.channel}
                    onChange={(e) => update(index, { channel: e.target.value as MessageChannel })}
                    className="field-input"
                  >
                    {MESSAGE_CHANNELS.map((c) => (
                      <option key={c} value={c}>
                        {MESSAGE_CHANNEL_LABELS[c]}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  onClick={() => setSteps((prev) => prev.filter((_, i) => i !== index))}
                  className="text-xs text-slate-400 hover:text-rose-600"
                >
                  Remove
                </button>
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              {steps.length < 9 && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    setSteps((prev) => [
                      ...prev,
                      { delayDays: prev.length === 0 ? 3 : 7, topic: '', channel: 'direct_message' },
                    ])
                  }
                >
                  Add follow-up
                </Button>
              )}
              <Button size="sm" onClick={() => void save()} loading={saving}>
                Save sequence
              </Button>
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}
