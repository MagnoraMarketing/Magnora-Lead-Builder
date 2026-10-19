'use client';

import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Alert, Button } from '@/components/ui';
import { ApiRequestError, apiFetch } from '@/lib/api/client';
import type { Campaign } from '@/types/database';

interface ImportResult {
  inserted: number;
  duplicates: number;
  invalid: { line: number; messages: string[] }[];
  ignoredHeaders: string[];
}

/** Largest file the browser will send; the server enforces its own limit too. */
const MAX_FILE_BYTES = 2_000_000;

export function ImportLeadsModal({
  open,
  onClose,
  onImported,
  campaigns,
}: {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
  campaigns: Campaign[];
}) {
  const [file, setFile] = useState<File | null>(null);
  const [campaignId, setCampaignId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  function close() {
    setFile(null);
    setResult(null);
    setError(null);
    onClose();
  }

  async function submit() {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setError('The file is larger than 2 MB. Split it into smaller files.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const csv = await file.text();
      const data = await apiFetch<ImportResult>('/api/leads/import', {
        method: 'POST',
        body: JSON.stringify({ csv, campaignId: campaignId || null }),
      });
      setResult(data);
      if (data.inserted > 0) onImported();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'The import failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="Import leads from CSV"
      footer={
        result ? (
          <Button onClick={close}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button onClick={() => void submit()} loading={busy} disabled={!file}>
              Import
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-3">
          <Alert tone={result.inserted > 0 ? 'success' : 'info'}>
            {result.inserted} imported · {result.duplicates} already in your leads (skipped)
            {result.invalid.length > 0 && ` · ${result.invalid.length} rows with errors`}
          </Alert>
          {result.ignoredHeaders.length > 0 && (
            <p className="text-xs text-slate-500">
              Columns not recognised and ignored: {result.ignoredHeaders.join(', ')}
            </p>
          )}
          {result.invalid.length > 0 && (
            <ul className="max-h-48 space-y-1 overflow-y-auto text-xs text-rose-700">
              {result.invalid.slice(0, 100).map((row) => (
                <li key={row.line}>
                  Line {row.line}: {row.messages.join('; ')}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {error && <Alert tone="error">{error}</Alert>}
          <p>
            Needs a header row with a <strong>Name</strong> column (or First name and Last name).
            Title, Company, LinkedIn URL, Email, Phone, Location, Industry, Status and Notes are
            picked up when present — the app&apos;s own export works as-is. Up to 1,000 rows.
            Leads that already exist are skipped, not overwritten.
          </p>
          <div>
            <label htmlFor="import-file" className="field-label">
              CSV file
            </label>
            <input
              id="import-file"
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium"
            />
          </div>
          <div>
            <label htmlFor="import-campaign" className="field-label">
              Add to campaign (optional)
            </label>
            <select
              id="import-campaign"
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
          </div>
        </div>
      )}
    </Modal>
  );
}
