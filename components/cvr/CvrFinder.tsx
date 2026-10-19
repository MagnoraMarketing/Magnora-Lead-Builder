'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useCampaigns } from '@/components/campaigns/useCampaigns';
import { Alert, Badge, Button, Card, CardBody, CardHeader, EmptyState, cx } from '@/components/ui';
import { ApiRequestError, apiFetch } from '@/lib/api/client';
import { EMPLOYEE_BUCKETS, KOMMUNER, VIRKSOMHEDSFORMER } from '@/lib/integrations/cvr/codes';
import type { CvrCompany } from '@/lib/integrations/cvr/parse';

type FoundCompany = CvrCompany & { existingLeads: number };

interface SearchResult {
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  skipped: number;
  companies: FoundCompany[];
}

interface ImportResult {
  inserted: number;
  duplicates: number;
  withoutDirector: string[];
  unavailable: string[];
}

const toggle = <T,>(list: T[], value: T) =>
  list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

const numberOrNull = (value: string) => (value.trim() === '' ? null : Number(value));

/**
 * Finds active Danish companies in CVR by branche, place, size, company form
 * and age, and turns their directors into leads. Reklamebeskyttede companies
 * never appear: the server excludes them.
 */
export function CvrFinder() {
  const campaigns = useCampaigns();

  const [branche, setBranche] = useState('');
  const [kommuneInput, setKommuneInput] = useState('');
  const [kommuner, setKommuner] = useState<number[]>([]);
  const [postnumre, setPostnumre] = useState('');
  const [employees, setEmployees] = useState<string[]>([]);
  const [forms, setForms] = useState<number[]>([]);
  const [minAge, setMinAge] = useState('');
  const [maxAge, setMaxAge] = useState('');

  const [result, setResult] = useState<SearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [campaignId, setCampaignId] = useState('');
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<ImportResult | null>(null);

  function addKommune() {
    const match = KOMMUNER.find((k) => k.name.toLowerCase() === kommuneInput.trim().toLowerCase());
    if (match && !kommuner.includes(match.code)) setKommuner([...kommuner, match.code]);
    setKommuneInput('');
  }

  async function search(page: number) {
    setSearching(true);
    setError(null);
    setImported(null);
    try {
      const data = await apiFetch<SearchResult>('/api/cvr/search', {
        method: 'POST',
        body: JSON.stringify({
          branche,
          kommunekoder: kommuner,
          postnumre,
          employeeIntervals: employees,
          formkoder: forms,
          minAgeYears: numberOrNull(minAge),
          maxAgeYears: numberOrNull(maxAge),
          page,
        }),
      });
      setResult(data);
      setSelected(new Set());
      setNotConfigured(false);
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'cvr_not_configured') {
        setNotConfigured(true);
      } else {
        const fieldMessage = err instanceof ApiRequestError && err.fields
          ? Object.values(err.fields).flat()[0]
          : null;
        setError(
          err instanceof ApiRequestError
            ? [err.message, fieldMessage].filter(Boolean).join(' ')
            : 'The search failed.',
        );
      }
    } finally {
      setSearching(false);
    }
  }

  async function importSelected() {
    setImporting(true);
    setError(null);
    try {
      const data = await apiFetch<ImportResult>('/api/cvr/import', {
        method: 'POST',
        body: JSON.stringify({ cvrNumbers: [...selected], campaignId: campaignId || null }),
      });
      setImported(data);
      setResult((prev) =>
        prev && {
          ...prev,
          companies: prev.companies.map((c) =>
            selected.has(c.cvrNumber) ? { ...c, existingLeads: Math.max(c.existingLeads, c.directors.length) } : c,
          ),
        },
      );
      setSelected(new Set());
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'The import failed.');
    } finally {
      setImporting(false);
    }
  }

  const selectable = result?.companies.filter((c) => c.directors.length > 0) ?? [];
  const allSelected = selectable.length > 0 && selectable.every((c) => selected.has(c.cvrNumber));
  const directorsSelected =
    result?.companies.filter((c) => selected.has(c.cvrNumber)).reduce((n, c) => n + c.directors.length, 0) ?? 0;

  return (
    <div className="space-y-5">
      {notConfigured && (
        <Alert tone="warning" title="CVR access is not set up yet">
          Access to the register is free but personal. Request system-to-system access from
          Erhvervsstyrelsen (cvrselvbetjening@erst.dk), then add <code>CVR_USERNAME</code> and{' '}
          <code>CVR_PASSWORD</code> to the server environment and redeploy.
        </Alert>
      )}
      {error && <Alert tone="error">{error}</Alert>}

      <Card>
        <CardHeader
          title="Criteria"
          description="Only active companies are searched. Reklamebeskyttede companies are always left out."
        />
        <CardBody className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="cvr-branche" className="field-label">
                Branche (DB07 codes)
              </label>
              <input
                id="cvr-branche"
                value={branche}
                onChange={(e) => setBranche(e.target.value)}
                placeholder="e.g. 62, 702200"
                className="field-input"
              />
              <p className="mt-1 text-xs text-slate-500">
                A short code covers everything under it: 62 is all of IT consultancy and software.
              </p>
            </div>
            <div>
              <label htmlFor="cvr-postnumre" className="field-label">
                Postal codes
              </label>
              <input
                id="cvr-postnumre"
                value={postnumre}
                onChange={(e) => setPostnumre(e.target.value)}
                placeholder="e.g. 8000, 2000-2999"
                className="field-input"
              />
            </div>
          </div>

          <div>
            <label htmlFor="cvr-kommune" className="field-label">
              Municipalities
            </label>
            <div className="flex gap-2">
              <input
                id="cvr-kommune"
                list="cvr-kommuner"
                value={kommuneInput}
                onChange={(e) => setKommuneInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addKommune();
                  }
                }}
                placeholder="Type a municipality"
                className="field-input"
              />
              <datalist id="cvr-kommuner">
                {KOMMUNER.map((k) => (
                  <option key={k.code} value={k.name} />
                ))}
              </datalist>
              <Button variant="secondary" onClick={addKommune} type="button">
                Add
              </Button>
            </div>
            {kommuner.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {kommuner.map((code) => (
                  <button
                    key={code}
                    type="button"
                    onClick={() => setKommuner(kommuner.filter((c) => c !== code))}
                    className="rounded-full bg-brand-50 px-2.5 py-1 text-xs text-brand-700 hover:bg-brand-100"
                  >
                    {KOMMUNER.find((k) => k.code === code)?.name} ×
                  </button>
                ))}
              </div>
            )}
            <p className="mt-1 text-xs text-slate-500">
              Municipalities and postal codes add up: a company in either is included.
            </p>
          </div>

          <fieldset>
            <legend className="field-label">Employees</legend>
            <div className="flex flex-wrap gap-2">
              {EMPLOYEE_BUCKETS.map((b) => (
                <label
                  key={b.code}
                  className={cx(
                    'cursor-pointer rounded-md px-2.5 py-1.5 text-xs ring-1 ring-inset',
                    employees.includes(b.code)
                      ? 'bg-brand-50 text-brand-700 ring-brand-300'
                      : 'text-slate-600 ring-slate-300',
                  )}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={employees.includes(b.code)}
                    onChange={() => setEmployees(toggle(employees, b.code))}
                  />
                  {b.label}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <fieldset>
              <legend className="field-label">Company form</legend>
              <div className="flex flex-wrap gap-2">
                {VIRKSOMHEDSFORMER.map((f) => (
                  <label
                    key={f.code}
                    className={cx(
                      'cursor-pointer rounded-md px-2.5 py-1.5 text-xs ring-1 ring-inset',
                      forms.includes(f.code)
                        ? 'bg-brand-50 text-brand-700 ring-brand-300'
                        : 'text-slate-600 ring-slate-300',
                    )}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={forms.includes(f.code)}
                      onChange={() => setForms(toggle(forms, f.code))}
                    />
                    {f.label}
                  </label>
                ))}
              </div>
            </fieldset>
            <div>
              <span className="field-label">Company age (years)</span>
              <div className="flex items-center gap-2">
                <input
                  aria-label="Minimum age in years"
                  type="number"
                  min={0}
                  max={200}
                  value={minAge}
                  onChange={(e) => setMinAge(e.target.value)}
                  placeholder="from"
                  className="field-input w-24"
                />
                <span className="text-slate-400">–</span>
                <input
                  aria-label="Maximum age in years"
                  type="number"
                  min={0}
                  max={200}
                  value={maxAge}
                  onChange={(e) => setMaxAge(e.target.value)}
                  placeholder="to"
                  className="field-input w-24"
                />
              </div>
            </div>
          </div>

          <Button onClick={() => void search(0)} loading={searching}>
            Search CVR
          </Button>
        </CardBody>
      </Card>

      {result && (
        <Card>
          <CardHeader
            title={`${result.total.toLocaleString('da-DK')} companies`}
            description={
              `Page ${result.page + 1}. Each current director becomes a lead with the company's CVR details.` +
              (result.skipped > 0 ? ` ${result.skipped} inactive or protected on this page were left out.` : '')
            }
          />
          {result.companies.length === 0 ? (
            <EmptyState title="No companies on this page" description="Try wider criteria." />
          ) : (
            <CardBody className="space-y-4">
              {imported && (
                <Alert tone="success" title={`${imported.inserted} leads added`}>
                  {imported.duplicates > 0 && <p>{imported.duplicates} were already in your leads and were skipped.</p>}
                  {imported.withoutDirector.length > 0 && (
                    <p>No current director registered: {imported.withoutDirector.join(', ')}.</p>
                  )}
                  {imported.unavailable.length > 0 && (
                    <p>
                      No longer available (ended or reklamebeskyttet): {imported.unavailable.join(', ')}.
                    </p>
                  )}
                  <p>
                    <Link href="/leads" className="font-medium underline">
                      Go to leads
                    </Link>
                  </p>
                </Alert>
              )}

              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <label htmlFor="cvr-campaign" className="field-label">
                    Campaign
                  </label>
                  <select
                    id="cvr-campaign"
                    value={campaignId}
                    onChange={(e) => setCampaignId(e.target.value)}
                    className="field-input w-auto"
                  >
                    <option value="">No campaign</option>
                    {campaigns.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <Button
                  onClick={() => void importSelected()}
                  loading={importing}
                  disabled={selected.size === 0}
                >
                  Add {directorsSelected} director{directorsSelected === 1 ? '' : 's'} as leads
                </Button>
              </div>

              <div className="overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead className="border-b border-slate-200 text-xs uppercase text-slate-500">
                    <tr>
                      <th className="py-2 pr-3">
                        <input
                          type="checkbox"
                          aria-label="Select all on this page"
                          checked={allSelected}
                          onChange={() =>
                            setSelected(allSelected ? new Set() : new Set(selectable.map((c) => c.cvrNumber)))
                          }
                        />
                      </th>
                      <th className="py-2 pr-3">Company</th>
                      <th className="py-2 pr-3">Place</th>
                      <th className="py-2 pr-3">Branche</th>
                      <th className="py-2 pr-3">Employees</th>
                      <th className="py-2 pr-3">Directors</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {result.companies.map((c) => (
                      <tr key={c.cvrNumber} className="align-top">
                        <td className="py-2 pr-3">
                          <input
                            type="checkbox"
                            aria-label={`Select ${c.name}`}
                            disabled={c.directors.length === 0}
                            checked={selected.has(c.cvrNumber)}
                            onChange={() =>
                              setSelected((prev) => {
                                const next = new Set(prev);
                                if (next.has(c.cvrNumber)) next.delete(c.cvrNumber);
                                else next.add(c.cvrNumber);
                                return next;
                              })
                            }
                          />
                        </td>
                        <td className="py-2 pr-3">
                          <a
                            href={`https://datacvr.virk.dk/enhed/virksomhed/${c.cvrNumber}`}
                            target="_blank"
                            rel="noreferrer"
                            className="font-medium text-brand-700 hover:underline"
                          >
                            {c.name}
                          </a>
                          <p className="text-xs text-slate-500">
                            CVR {c.cvrNumber}
                            {c.form ? ` · ${c.form}` : ''}
                            {c.founded ? ` · founded ${c.founded.slice(0, 4)}` : ''}
                          </p>
                          {c.existingLeads > 0 && <Badge className="mt-1">Already in leads</Badge>}
                        </td>
                        <td className="py-2 pr-3 text-slate-600">
                          {[c.postnummer, c.city].filter(Boolean).join(' ') || '—'}
                        </td>
                        <td className="py-2 pr-3 text-slate-600">{c.branchetekst ?? '—'}</td>
                        <td className="py-2 pr-3 text-slate-600">{c.employees ?? '—'}</td>
                        <td className="py-2 pr-3 text-slate-700">
                          {c.directors.length === 0 ? (
                            <span className="text-slate-400">None registered</span>
                          ) : (
                            c.directors.map((d) => (
                              <p key={d.personId}>
                                {d.name} <span className="text-xs text-slate-500">{d.title}</span>
                              </p>
                            ))
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardBody>
          )}
          <div className="flex justify-between border-t border-slate-200 px-5 py-3">
            <Button
              variant="secondary"
              size="sm"
              disabled={result.page === 0 || searching}
              onClick={() => void search(result.page - 1)}
            >
              Previous
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={!result.hasMore || searching}
              onClick={() => void search(result.page + 1)}
            >
              Next
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
