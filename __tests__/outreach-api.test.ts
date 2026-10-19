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
/** Error returned by the next insert into a table, e.g. a unique violation. */
let insertErrors: Record<string, { code: string } | undefined> = {};

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
    filter(column: string, _op: string, value: unknown) {
      record.filters[column] = value;
      return b;
    },
    order: () => b,
    range: () => b,
    limit: () => b,
    or: () => b,
    gt(column: string, value: unknown) {
      record.filters[`${column}>`] = value;
      return b;
    },
    lte(column: string, value: unknown) {
      record.filters[`${column}<=`] = value;
      return b;
    },
    returns: () => b,
    select: () => b,
    single: async () => {
      const error = operation === 'insert' ? insertErrors[table] : undefined;
      if (error) {
        insertErrors[table] = undefined;
        return { data: null, error };
      }
      return { data: result(), error: null };
    },
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
      upsert: (payload: unknown) => builder(table, 'upsert', payload),
      delete: () => builder(table, 'delete'),
    };
  },
  rpc: async (fn: string, args: unknown) => {
    rpcCalls.push({ fn, args });
    return { data: rpcResult, error: null };
  },
};

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => supabaseStub }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => supabaseStub }));

vi.mock('@/lib/api/rate-limit', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/api/rate-limit')>('@/lib/api/rate-limit');
  return { ...actual, checkRateLimit: async () => true };
});

const generateMock = vi.fn();
vi.mock('@/lib/ai/outreach', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ai/outreach')>('@/lib/ai/outreach');
  return { ...actual, generateOutreachMessage: (...args: unknown[]) => generateMock(...args) };
});

const { GET: listCampaigns, POST: createCampaign } = await import('@/app/api/campaigns/route');
const { PATCH: patchCampaign, DELETE: deleteCampaign } =
  await import('@/app/api/campaigns/[id]/route');
const { GET: listMessages, POST: createMessage } = await import('@/app/api/messages/route');
const { POST: generateMessage } = await import('@/app/api/messages/generate/route');
const { PATCH: patchMessage, DELETE: deleteMessage } =
  await import('@/app/api/messages/[id]/route');
const { POST: importLeads } = await import('@/app/api/leads/import/route');
const { POST: builderGenerate } = await import('@/app/api/generate-message/route');
const { POST: builderSave } = await import('@/app/api/builder/route');
const { AiGenerationError } = await import('@/lib/ai/outreach');
const { PUT: putSteps } = await import('@/app/api/campaigns/[id]/steps/route');
const { POST: createFollowUp } = await import('@/app/api/followups/route');
const { PATCH: patchFollowUp } = await import('@/app/api/followups/[id]/route');
const { POST: createReply } = await import('@/app/api/leads/[id]/replies/route');
const { GET: getToday } = await import('@/app/api/today/route');
const { POST: enrichLead } = await import('@/app/api/leads/[id]/enrich/route');
const { POST: apolloWebhook } = await import('@/app/api/webhooks/apollo/[token]/route');

const USER_ID = '11111111-1111-1111-1111-111111111111';
const LEAD_ID = '22222222-2222-2222-2222-222222222222';
const CAMPAIGN_ID = '44444444-4444-4444-4444-444444444444';
const MESSAGE_ID = '55555555-5555-5555-5555-555555555555';
const TASK_ID = '66666666-6666-6666-6666-666666666666';
const TOKEN = 'a'.repeat(64);

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
  insertErrors = {};
  tableRows = {
    leads: [],
    campaigns: [],
    outreach_messages: [],
    follow_up_tasks: [],
    lead_replies: [],
    campaign_steps: [],
    enrichment_requests: [],
  };
  generateMock.mockReset();
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.APOLLO_API_KEY;
  delete process.env.APP_URL;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
      builderGenerate(json('http://localhost', {})),
      builderSave(json('http://localhost', {})),
      putSteps(json('http://localhost', { steps: [] }, 'PUT'), params(CAMPAIGN_ID)),
      createFollowUp(json('http://localhost', {})),
      patchFollowUp(json('http://localhost', { action: 'skip' }, 'PATCH'), params(TASK_ID)),
      createReply(json('http://localhost', { body: 'x' }), params(LEAD_ID)),
      getToday(new NextRequest('http://localhost/api/today') as never),
      enrichLead(new Request('http://localhost', { method: 'POST' }), params(LEAD_ID)),
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
    await patchCampaign(
      json('http://localhost', { status: 'paused' }, 'PATCH'),
      params(CAMPAIGN_ID),
    );
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

    const insert = recorded.find(
      (q) => q.table === 'outreach_messages' && q.operation === 'insert',
    );
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
    expect(body.data.invalid).toEqual([
      { line: 3, messages: ['email: Must be a valid email address'] },
    ]);

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

describe('AI Lead Builder', () => {
  const form = { name: 'Mette Sørensen', role: 'CFO', company: 'Nordlys A/S', linkedinUrl: '' };

  it('generates a message from the form without saving anything', async () => {
    signIn();
    generateMock.mockResolvedValue({ body: 'Hej Mette, lad os forbinde.', model: 'claude-test' });

    const response = await builderGenerate(json('http://localhost', form));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({
      message: 'Hej Mette, lad os forbinde.',
      model: 'claude-test',
    });

    const [input] = generateMock.mock.calls[0] as [{ lead: Record<string, unknown> }];
    expect(input.lead).toMatchObject({
      full_name: 'Mette Sørensen',
      first_name: 'Mette',
      job_title: 'CFO',
      company_name: 'Nordlys A/S',
    });
    expect(recorded.some((q) => q.operation === 'insert')).toBe(false);
  });

  it('requires name, role and company', async () => {
    signIn();
    const response = await builderGenerate(json('http://localhost', { name: 'Mette' }));
    expect(response.status).toBe(422);
    expect(Object.keys((await response.json()).error.fields)).toEqual(
      expect.arrayContaining(['role', 'company']),
    );
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('answers ai_not_configured when the key is missing', async () => {
    signIn();
    delete process.env.ANTHROPIC_API_KEY;
    const response = await builderGenerate(json('http://localhost', form));
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('ai_not_configured');
  });

  it('saves the lead and its message as a draft, owned by the caller', async () => {
    signIn();
    tableRows.leads = [lead()];
    const response = await builderSave(
      json('http://localhost', {
        ...form,
        linkedinUrl: 'https://www.linkedin.com/in/mette',
        body: 'Hej Mette',
        source: 'ai',
        aiModel: 'claude-test',
        user_id: 'someone-else',
      }),
    );
    expect(response.status).toBe(201);
    expect((await response.json()).data.existingLead).toBe(false);

    const leadInsert = recorded.find((q) => q.table === 'leads' && q.operation === 'insert');
    expect(leadInsert?.payload).toMatchObject({
      user_id: USER_ID,
      full_name: 'Mette Sørensen',
      first_name: 'Mette',
      last_name: 'Sørensen',
      job_title: 'CFO',
      company_name: 'Nordlys A/S',
      linkedin_url: 'https://www.linkedin.com/in/mette',
      source: 'builder',
    });
    const messageInsert = recorded.find(
      (q) => q.table === 'outreach_messages' && q.operation === 'insert',
    );
    expect(messageInsert?.payload).toMatchObject({
      user_id: USER_ID,
      lead_id: LEAD_ID,
      body: 'Hej Mette',
      source: 'ai',
      ai_model: 'claude-test',
    });
    expect(messageInsert?.payload).not.toHaveProperty('status');
  });

  it('adds the message to an existing lead instead of duplicating it', async () => {
    signIn();
    tableRows.leads = [lead()];
    insertErrors.leads = { code: '23505' };

    const response = await builderSave(
      json('http://localhost', { ...form, body: 'Hej igen', source: 'manual' }),
    );
    expect(response.status).toBe(201);
    expect((await response.json()).data.existingLead).toBe(true);

    const lookup = recorded.find((q) => q.table === 'leads' && q.operation === 'select');
    expect(lookup?.filters).toMatchObject({
      user_id: USER_ID,
      name_company_key: 'mette sorensen|nordlys as',
    });
    expect(recorded.some((q) => q.table === 'outreach_messages' && q.operation === 'insert')).toBe(
      true,
    );
  });

  it('refuses to add a message to an existing do-not-contact lead', async () => {
    signIn();
    tableRows.leads = [lead({ status: 'do_not_contact' })];
    insertErrors.leads = { code: '23505' };
    const response = await builderSave(
      json('http://localhost', { ...form, body: 'Hej', source: 'manual' }),
    );
    expect(response.status).toBe(409);
    expect(recorded.some((q) => q.table === 'outreach_messages')).toBe(false);
  });

  it('removes the new lead again if its message cannot be saved', async () => {
    signIn();
    tableRows.leads = [lead()];
    insertErrors.outreach_messages = { code: 'XX000' };
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await builderSave(
      json('http://localhost', { ...form, body: 'Hej', source: 'manual' }),
    );
    expect(response.status).toBe(500);
    const cleanup = recorded.find((q) => q.table === 'leads' && q.operation === 'delete');
    expect(cleanup?.filters).toEqual({ id: LEAD_ID, user_id: USER_ID });
  });

  it('enforces the connection-note limit when saving', async () => {
    signIn();
    const response = await builderSave(
      json('http://localhost', {
        ...form,
        channel: 'connection_request',
        body: 'a'.repeat(301),
        source: 'manual',
      }),
    );
    expect(response.status).toBe(422);
    expect(recorded).toHaveLength(0);
  });
});

describe('follow-up sequences and replies', () => {
  it("numbers campaign steps from 2 and checks the campaign is the caller's", async () => {
    signIn();
    tableRows.campaigns = [{ id: CAMPAIGN_ID, user_id: USER_ID }];
    const response = await putSteps(
      json(
        'http://localhost',
        {
          steps: [
            { delayDays: 3, topic: 'Nudge' },
            { delayDays: 7, channel: 'connection_request' },
          ],
        },
        'PUT',
      ),
      params(CAMPAIGN_ID),
    );
    expect(response.status).toBe(200);
    const upsert = recorded.find((q) => q.table === 'campaign_steps' && q.operation === 'upsert');
    expect(upsert?.payload).toEqual([
      expect.objectContaining({
        user_id: USER_ID,
        campaign_id: CAMPAIGN_ID,
        step_number: 2,
        delay_days: 3,
        topic: 'Nudge',
      }),
      expect.objectContaining({
        step_number: 3,
        delay_days: 7,
        channel: 'connection_request',
        topic: null,
      }),
    ]);
    const trim = recorded.find((q) => q.table === 'campaign_steps' && q.operation === 'delete');
    expect(trim?.filters).toMatchObject({
      campaign_id: CAMPAIGN_ID,
      user_id: USER_ID,
      'step_number>': 3,
    });
  });

  it('refuses steps for a campaign the caller does not own', async () => {
    signIn();
    tableRows.campaigns = [];
    const response = await putSteps(
      json('http://localhost', { steps: [] }, 'PUT'),
      params(CAMPAIGN_ID),
    );
    expect(response.status).toBe(404);
    expect(recorded.some((q) => q.operation === 'upsert' || q.operation === 'delete')).toBe(false);
  });

  it("plans a follow-up by hand for the caller's lead", async () => {
    signIn();
    tableRows.leads = [lead()];
    const response = await createFollowUp(
      json('http://localhost', {
        leadId: LEAD_ID,
        dueAt: '2026-10-25T08:00:00.000Z',
        topic: 'Case study',
      }),
    );
    expect(response.status).toBe(201);
    const insert = recorded.find((q) => q.table === 'follow_up_tasks' && q.operation === 'insert');
    expect(insert?.payload).toEqual({
      user_id: USER_ID,
      lead_id: LEAD_ID,
      topic: 'Case study',
      channel: 'direct_message',
      due_at: '2026-10-25T08:00:00.000Z',
    });
  });

  it('skips an open follow-up but not a closed one', async () => {
    signIn();
    tableRows.follow_up_tasks = [{ id: TASK_ID, user_id: USER_ID, status: 'pending' }];
    const ok = await patchFollowUp(
      json('http://localhost', { action: 'skip' }, 'PATCH'),
      params(TASK_ID),
    );
    expect(ok.status).toBe(200);
    expect(recorded.find((q) => q.operation === 'update')?.payload).toEqual({
      status: 'cancelled',
    });

    recorded.length = 0;
    tableRows.follow_up_tasks = [{ id: TASK_ID, user_id: USER_ID, status: 'done' }];
    const closed = await patchFollowUp(
      json('http://localhost', { action: 'skip' }, 'PATCH'),
      params(TASK_ID),
    );
    expect(closed.status).toBe(409);
    expect(recorded.some((q) => q.operation === 'update')).toBe(false);
  });

  it('records a reply owned by the caller', async () => {
    signIn();
    const response = await createReply(
      json('http://localhost', { body: '  Tak, hvad koster det?  ' }),
      params(LEAD_ID),
    );
    expect(response.status).toBe(201);
    expect(recorded.find((q) => q.table === 'lead_replies')?.payload).toEqual({
      user_id: USER_ID,
      lead_id: LEAD_ID,
      body: 'Tak, hvad koster det?',
    });
  });

  it('drafts a planned follow-up with its topic and date, and links the task', async () => {
    signIn();
    tableRows.leads = [lead()];
    tableRows.follow_up_tasks = [
      {
        id: TASK_ID,
        user_id: USER_ID,
        lead_id: LEAD_ID,
        status: 'pending',
        step_number: 2,
        topic: 'Share a case',
        channel: 'direct_message',
        due_at: '2026-10-25T08:00:00.000Z',
        campaign_id: null,
      },
    ];
    generateMock.mockResolvedValue({ body: 'Hej igen Mette', model: 'claude-test' });

    const response = await generateMessage(
      json('http://localhost', { leadId: LEAD_ID, taskId: TASK_ID }),
    );
    expect(response.status).toBe(201);

    const [input] = generateMock.mock.calls[0] as [{ kind: string; topic: string }];
    expect(input).toMatchObject({ kind: 'follow_up', topic: 'Share a case' });

    const insert = recorded.find(
      (q) => q.table === 'outreach_messages' && q.operation === 'insert',
    );
    expect(insert?.payload).toMatchObject({
      kind: 'follow_up',
      sequence_step: 2,
      scheduled_for: '2026-10-25T08:00:00.000Z',
      channel: 'direct_message',
    });
    const link = recorded.find((q) => q.table === 'follow_up_tasks' && q.operation === 'update');
    expect(link?.payload).toMatchObject({ status: 'drafted' });
    expect(link?.filters).toEqual({ id: TASK_ID, user_id: USER_ID });
  });

  it("scopes the Today list to the caller and to the user's day", async () => {
    signIn();
    const until = '2026-10-19T21:59:59.999Z';
    const response = await getToday(
      new NextRequest(`http://localhost/api/today?until=${encodeURIComponent(until)}`) as never,
    );
    expect(response.status).toBe(200);
    const tasks = recorded.find((q) => q.table === 'follow_up_tasks');
    expect(tasks?.filters).toMatchObject({ user_id: USER_ID, 'due_at<=': until });
    expect(
      recorded
        .filter((q) => q.table === 'outreach_messages')
        .every((q) => q.filters.user_id === USER_ID),
    ).toBe(true);
  });
});

describe('contact enrichment', () => {
  const apolloResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('answers enrichment_not_configured without an Apollo key', async () => {
    signIn();
    const response = await enrichLead(
      new Request('http://localhost', { method: 'POST' }),
      params(LEAD_ID),
    );
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('enrichment_not_configured');
  });

  it('fills only empty fields and asks for phones through a tokenised webhook', async () => {
    signIn();
    process.env.APOLLO_API_KEY = 'apollo-key';
    process.env.APP_URL = 'https://app.example';
    tableRows.leads = [
      lead({ email: null, phone: null, mobile_phone: null, industry: 'Typed by user' }),
    ];
    tableRows.enrichment_requests = [{ id: 'req-1' }];
    const fetchMock = vi.fn().mockResolvedValue(
      apolloResponse({
        person: {
          email: 'mette@nordlys.dk',
          email_status: 'verified',
          organization: { industry: 'energy' },
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await enrichLead(
      new Request('http://localhost', { method: 'POST' }),
      params(LEAD_ID),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()).data;
    expect(body).toMatchObject({ found: true, filled: ['email'], phonePending: true });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/^https:\/\/api\.apollo\.io\/api\/v1\/people\/match\?/);
    const query = new URL(url).searchParams;
    expect(query.get('reveal_phone_number')).toBe('true');
    expect(query.get('webhook_url')).toMatch(
      /^https:\/\/app\.example\/api\/webhooks\/apollo\/[0-9a-f]{64}$/,
    );
    expect(new Headers(init.headers).get('X-Api-Key')).toBe('apollo-key');

    const leadUpdate = recorded.find((q) => q.table === 'leads' && q.operation === 'update');
    expect(leadUpdate?.payload).toMatchObject({
      email: 'mette@nordlys.dk',
      enrichment_status: 'found',
    });
    expect(leadUpdate?.payload).not.toHaveProperty('industry');
    expect(leadUpdate?.filters).toEqual({ id: LEAD_ID, user_id: USER_ID });
  });

  it('refuses to look up a do-not-contact lead', async () => {
    signIn();
    process.env.APOLLO_API_KEY = 'apollo-key';
    tableRows.leads = [lead({ status: 'do_not_contact' })];
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = await enrichLead(
      new Request('http://localhost', { method: 'POST' }),
      params(LEAD_ID),
    );
    expect(response.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the webhook rejects a malformed or unknown token', async () => {
    const bad = await apolloWebhook(
      new Request('http://localhost', { method: 'POST', body: '{}' }),
      {
        params: Promise.resolve({ token: 'not-a-token' }),
      },
    );
    expect(bad.status).toBe(404);
    expect(recorded).toHaveLength(0);

    tableRows.enrichment_requests = [];
    const unknown = await apolloWebhook(
      new Request('http://localhost', { method: 'POST', body: '{}' }),
      {
        params: Promise.resolve({ token: TOKEN }),
      },
    );
    expect(unknown.status).toBe(404);
  });

  it("the webhook fills only that lead's empty phone fields", async () => {
    tableRows.enrichment_requests = [
      {
        id: 'req-1',
        user_id: USER_ID,
        lead_id: LEAD_ID,
        phone_requested: true,
        webhook_token: TOKEN,
      },
    ];
    tableRows.leads = [lead({ phone: '+45 11 11 11 11', mobile_phone: null })];
    const payload = {
      people: [
        {
          phone_numbers: [
            { sanitized_number: '+4520304050', type_cd: 'mobile' },
            { sanitized_number: '+4570203040', type_cd: 'work' },
          ],
        },
      ],
    };
    const response = await apolloWebhook(
      new Request('http://localhost', { method: 'POST', body: JSON.stringify(payload) }),
      { params: Promise.resolve({ token: TOKEN }) },
    );
    expect(response.status).toBe(200);

    const lookup = recorded.find(
      (q) => q.table === 'enrichment_requests' && q.operation === 'select',
    );
    expect(lookup?.filters).toEqual({ webhook_token: TOKEN });
    const leadUpdate = recorded.find((q) => q.table === 'leads' && q.operation === 'update');
    expect(leadUpdate?.payload).toMatchObject({ mobile_phone: '+4520304050' });
    expect(leadUpdate?.payload).not.toHaveProperty('phone');
    expect(leadUpdate?.filters).toEqual({ id: LEAD_ID, user_id: USER_ID });
    const done = recorded.find(
      (q) => q.table === 'enrichment_requests' && q.operation === 'update',
    );
    expect(done?.payload).toMatchObject({ status: 'completed', webhook_payload: payload });
  });
});
