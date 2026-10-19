/**
 * Route tests for campaigns, outreach messages and CSV import.
 *
 * Same approach as api.test.ts: the handlers run for real; Supabase, the rate
 * limiter and the AI call are stubbed. What is checked is what matters for
 * safety — authentication, user scoping, that AI drafts are saved as drafts,
 * that "sent" needs an explicit approved → sent action, and that an
 * unconfigured AI key degrades cleanly.
 */
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let currentUser: { id: string; email: string } | null = null;

interface RecordedQuery {
  table: string;
  operation: string;
  filters: Record<string, unknown>;
  payload?: unknown;
}

const recorded: RecordedQuery[] = [];
let tableRows: Record<string, unknown[]> = {};
let rpcCalls: { fn: string; args: unknown }[] = [];
let rpcResult: unknown = [];

function builder(table: string, operation: string, payload?: unknown) {
  const record: RecordedQuery = { table, operation, filters: {}, payload };
  recorded.push(record);
  const rows = () => tableRows[table] ?? [];
  // Writes echo the payload merged over the first stored row, like `.select()` after a write.
  const result = () =>
    operation === 'insert' || operation === 'update'
      ? { ...(rows()[0] as object), ...(payload as object) }
      : (rows()[0] ?? null);

  const b: Record<string, unknown> = {
    eq(column: string, value: unknown) {
      record.filters[column] = value;
      return b;
    },
    in(column: string, value: unknown) {
      record.filters[column] = value;
      return b;
    },
    order: () => b,
    range: () => b,
    returns: () => b,
    select: () => b,
    single: async () => ({ data: result(), error: null }),
    maybeSingle: async () => ({ data: result(), error: null }),
    then(resolve: (value: unknown) => unknown) {
      return Promise.resolve({ data: rows(), error: null, count: rows().length }).then(resolve);
    },
  };
  return b;
}

const supabaseStub = {
  auth: {
    getUser: async () => ({
      data: { user: currentUser },
      error: currentUser ? null : new Error('no session'),
    }),
  },
  from(table: string) {
    return {
      select: () => builder(table, 'select'),
      insert: (payload: unknown) => builder(table, 'insert', payload),
      update: (payload: unknown) => builder(table, 'update', payload),
      delete: () => builder(table, 'delete'),
    };
  },
  rpc: async (fn: string, args: unknown) => {
    rpcCalls.push({ fn, args });
    return { data: rpcResult, error: null };
  },
};

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => supabaseStub }));

vi.mock('@/lib/api/rate-limit', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/rate-limit')>('@/lib/api/rate-limit');
  return { ...actual, checkRateLimit: async () => true };
});

const generateMock = vi.fn();
vi.mock('@/lib/ai/outreach', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ai/outreach')>('@/lib/ai/outreach');
  return { ...actual, generateOutreachMessage: (...args: unknown[]) => generateMock(...args) };
});

const { GET: listCampaigns, POST: createCampaign } = await import('@/app/api/campaigns/route');
const { PATCH: patchCampaign, DELETE: deleteCampaign } = await import(
  '@/app/api/campaigns/[id]/route'
);
const { GET: listMessages, POST: createMessage } = await import('@/app/api/messages/route');
const { POST: generateMessage } = await import('@/app/api/messages/generate/route');
const { PATCH: patchMessage, DELETE: deleteMessage } = await import('@/app/api/messages/[id]/route');
const { POST: importLeads } = await import('@/app/api/leads/import/route');
const { AiGenerationError } = await import('@/lib/ai/outreach');

const USER_ID = '11111111-1111-1111-1111-111111111111';
const LEAD_ID = '22222222-2222-2222-2222-222222222222';
const CAMPAIGN_ID = '44444444-4444-4444-4444-444444444444';
const MESSAGE_ID = '55555555-5555-5555-5555-555555555555';

const json = (url: string, body: unknown, method = 'POST') =>
  new NextRequest(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as never;

const params = (id: string) => ({ params: Promise.resolve({ id }) });

const signIn = () => {
  currentUser = { id: USER_ID, email: 'user@test.dk' };
};

const lead = (overrides: Record<string, unknown> = {}) => ({
  id: LEAD_ID,
  user_id: USER_ID,
  full_name: 'Mette Sørensen',
  status: 'new',
  campaign_id: null,
  ...overrides,
});

const message = (overrides: Record<string, unknown> = {}) => ({
  id: MESSAGE_ID,
  user_id: USER_ID,
  lead_id: LEAD_ID,
  channel: 'connection_request',
  body: 'Hej Mette',
  status: 'draft',
  ...overrides,
});

beforeEach(() => {
  currentUser = null;
  recorded.length = 0;
  rpcCalls = [];
  rpcResult = [];
  tableRows = { leads: [], campaigns: [], outreach_messages: [] };
  generateMock.mockReset();
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

describe('authentication', () => {
  it('every new endpoint rejects an unauthenticated caller with 401', async () => {
    const responses = await Promise.all([
      listCampaigns(),
      createCampaign(json('http://localhost', { name: 'x' })),
      patchCampaign(json('http://localhost', { name: 'x' }, 'PATCH'), params(CAMPAIGN_ID)),
      deleteCampaign(new Request('http://localhost'), params(CAMPAIGN_ID)),
      listMessages(new NextRequest('http://localhost/api/messages') as never),
      createMessage(json('http://localhost', {})),
      generateMessage(json('http://localhost', {})),
      patchMessage(json('http://localhost', { action: 'approve' }, 'PATCH'), params(MESSAGE_ID)),
      deleteMessage(new Request('http://localhost'), params(MESSAGE_ID)),
      importLeads(json('http://localhost', { csv: 'Name\nJens' })),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(401);
      expect((await response.json()).error.code).toBe('unauthorized');
    }
    expect(recorded).toHaveLength(0);
    expect(generateMock).not.toHaveBeenCalled();
  });
});

describe('campaigns', () => {
  it('creates a campaign owned by the caller, ignoring a supplied user_id', async () => {
    signIn();
    const response = await createCampaign(
      json('http://localhost', { name: '  Q1 CFOs ', offer: '', user_id: 'someone-else' }),
    );
    expect(response.status).toBe(201);
    const insert = recorded.find((q) => q.table === 'campaigns' && q.operation === 'insert');
    expect(insert?.payload).toMatchObject({
      name: 'Q1 CFOs',
      offer: null,
      user_id: USER_ID,
      language: 'da',
    });
  });

  it('scopes updates and deletes to the caller', async () => {
    signIn();
    tableRows.campaigns = [{ id: CAMPAIGN_ID, user_id: USER_ID, name: 'x' }];
    await patchCampaign(json('http://localhost', { status: 'paused' }, 'PATCH'), params(CAMPAIGN_ID));
    await deleteCampaign(new Request('http://localhost'), params(CAMPAIGN_ID));
    const writes = recorded.filter((q) => q.table === 'campaigns');
    expect(writes.map((q) => q.filters)).toEqual([
      { id: CAMPAIGN_ID, user_id: USER_ID },
      { id: CAMPAIGN_ID, user_id: USER_ID },
    ]);
  });
});

describe('AI generation', () => {
  it('answers ai_not_configured without calling the AI when the key is missing', async () => {
    signIn();
    delete process.env.ANTHROPIC_API_KEY;
    const response = await generateMessage(json('http://localhost', { leadId: LEAD_ID }));
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('ai_not_configured');
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('saves the generated text as an AI draft scoped to the caller', async () => {
    signIn();
    tableRows.leads = [lead()];
    generateMock.mockResolvedValue({ body: 'Hej Mette, lad os forbinde.', model: 'claude-test' });

    const response = await generateMessage(
      json('http://localhost', { leadId: LEAD_ID, channel: 'connection_request' }),
    );
    expect(response.status).toBe(201);

    const leadRead = recorded.find((q) => q.table === 'leads');
    expect(leadRead?.filters).toEqual({ id: LEAD_ID, user_id: USER_ID });

    const insert = recorded.find((q) => q.table === 'outreach_messages' && q.operation === 'insert');
    expect(insert?.payload).toMatchObject({
      user_id: USER_ID,
      lead_id: LEAD_ID,
      body: 'Hej Mette, lad os forbinde.',
      source: 'ai',
      ai_model: 'claude-test',
    });
    // Never approved or sent on creation.
    expect(insert?.payload).not.toHaveProperty('status');
  });

  it('refuses to draft for a do-not-contact lead', async () => {
    signIn();
    tableRows.leads = [lead({ status: 'do_not_contact' })];
    const response = await generateMessage(json('http://localhost', { leadId: LEAD_ID }));
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('do_not_contact');
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('maps AI failures to stable codes and saves nothing', async () => {
    signIn();
    tableRows.leads = [lead()];
    generateMock.mockRejectedValue(new AiGenerationError('ai_invalid_output', 'nope'));
    const response = await generateMessage(json('http://localhost', { leadId: LEAD_ID }));
    expect(response.status).toBe(502);
    expect((await response.json()).error.code).toBe('ai_invalid_output');
    expect(recorded.some((q) => q.operation === 'insert')).toBe(false);
  });
});

describe('message lifecycle', () => {
  it('scopes the queue to the caller', async () => {
    signIn();
    await listMessages(new NextRequest('http://localhost/api/messages?status=draft') as never);
    const query = recorded.find((q) => q.table === 'outreach_messages');
    expect(query?.filters).toMatchObject({ user_id: USER_ID, status: 'draft' });
  });

  it('will not mark a draft as sent', async () => {
    signIn();
    tableRows.outreach_messages = [message({ status: 'draft' })];
    const response = await patchMessage(
      json('http://localhost', { action: 'mark_sent' }, 'PATCH'),
      params(MESSAGE_ID),
    );
    expect(response.status).toBe(409);
    expect(recorded.some((q) => q.operation === 'update')).toBe(false);
  });

  it('marks an approved message as sent only on the explicit action', async () => {
    signIn();
    tableRows.outreach_messages = [message({ status: 'approved' })];
    const response = await patchMessage(
      json('http://localhost', { action: 'mark_sent' }, 'PATCH'),
      params(MESSAGE_ID),
    );
    expect(response.status).toBe(200);
    const update = recorded.find((q) => q.operation === 'update');
    expect(update?.payload).toEqual({ status: 'sent' });
    expect(update?.filters).toEqual({ id: MESSAGE_ID, user_id: USER_ID });
  });

  it('moves an approved message back to draft when its text is edited', async () => {
    signIn();
    tableRows.outreach_messages = [message({ status: 'approved' })];
    await patchMessage(
      json('http://localhost', { action: 'edit', body: 'Hej Mette, ny tekst' }, 'PATCH'),
      params(MESSAGE_ID),
    );
    const update = recorded.find((q) => q.operation === 'update');
    expect(update?.payload).toEqual({ body: 'Hej Mette, ny tekst', status: 'draft' });
  });

  it('refuses to edit a sent message or exceed the connection-note limit', async () => {
    signIn();
    tableRows.outreach_messages = [message({ status: 'sent' })];
    const sent = await patchMessage(
      json('http://localhost', { action: 'edit', body: 'x' }, 'PATCH'),
      params(MESSAGE_ID),
    );
    expect(sent.status).toBe(409);

    tableRows.outreach_messages = [message({ status: 'draft' })];
    const tooLong = await patchMessage(
      json('http://localhost', { action: 'edit', body: 'a'.repeat(301) }, 'PATCH'),
      params(MESSAGE_ID),
    );
    expect(tooLong.status).toBe(422);
    expect(recorded.some((q) => q.operation === 'update')).toBe(false);
  });
});

describe('CSV import', () => {
  it('validates on the server and imports only valid rows through import_leads', async () => {
    signIn();
    rpcResult = [{ inserted: 1, skipped: 0 }];
    const response = await importLeads(
      json('http://localhost', { csv: 'Name,Email\nJens Hansen,jens@acme.dk\nBad,not-email\n' }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({ inserted: 1, duplicates: 0 });
    expect(body.data.invalid).toEqual([{ line: 3, messages: ['email: Must be a valid email address'] }]);

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]?.fn).toBe('import_leads');
    const args = rpcCalls[0]?.args as { p_rows: { full_name: string }[]; p_campaign_id: null };
    expect(args.p_rows.map((r) => r.full_name)).toEqual(['Jens Hansen']);
    // The rows carry no user_id: import_leads stamps auth.uid() itself.
    expect(args.p_rows[0]).not.toHaveProperty('user_id');
  });

  it('rejects a file it cannot use without calling the database', async () => {
    signIn();
    const response = await importLeads(json('http://localhost', { csv: 'Company\nAcme\n' }));
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe('invalid_file');
    expect(rpcCalls).toHaveLength(0);
  });
});
