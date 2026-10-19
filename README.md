# Magnora Lead Builder

A B2B lead-generation and LinkedIn outreach app for the Danish market. Search
LinkedIn for decision makers — CEO, CFO, Founder, Direktør, Ejer, Partner and so
on — or import them from CSV, collect them as deduplicated leads, group them
into campaigns, and draft personalised LinkedIn messages with AI that you edit,
approve and track through to sent.

Built on [MagnoraMarketing/linkedin-scraper-best](https://github.com/MagnoraMarketing/linkedin-scraper-best)
(the LinkedIn Lead Finder). Its scraper worker, schema migrations 0001–0004 and
app are carried over as they were; campaigns, AI outreach and CSV import are
added on top, extending the existing lead pages and routes rather than
replacing them.


---

## Contents

1. [Architecture](#1-architecture)
2. [Requirements](#2-requirements)
3. [Environment variables](#3-environment-variables)
4. [Supabase setup](#4-supabase-setup)
5. [Database migrations](#5-database-migrations)
6. [Local development](#6-local-development)
7. [Running the scraper worker](#7-running-the-scraper-worker)
8. [Deploying to Vercel](#8-deploying-to-vercel)
9. [Deploying the worker](#9-deploying-the-worker)
10. [Security](#10-security)
11. [Testing](#11-testing)
12. [Adding countries and cities](#12-adding-countries-and-cities)
13. [Connecting a dialer](#13-connecting-a-dialer)
13a. [Campaigns and AI outreach](#13a-campaigns-and-ai-outreach)
13b. [Importing leads from CSV](#13b-importing-leads-from-csv)
14. [Enrichment](#14-enrichment)
15. [Troubleshooting](#15-troubleshooting)
16. [Legal and ethical use](#16-legal-and-ethical-use)

---

## 1. Architecture

```
Browser
   │
   ▼
Vercel — Next.js UI + API routes          (auth checked, Zod validated, rate limited)
   │            │
   │            └──► Anthropic API          (message drafts; server-side key only)
   │
   │  INSERT scraping_jobs (status = queued)
   ▼
Supabase PostgreSQL                        (job queue + data + RLS)
   ▲                                        │
   │  upsert_lead / job_heartbeat           │  claim_next_job()  FOR UPDATE SKIP LOCKED
   │                                        ▼
Scraper worker — Docker container          (Python 3.11 + Playwright + Chromium)
   │
   ▼
LinkedIn
```

The frontend contains **no scraping logic at all**. The only contract between
the web app and the worker is a row in `scraping_jobs`, so the worker can be
moved to any host without touching the app.

### Why the scraper is not a Vercel Function

This was checked against Vercel's current limits before the architecture was
chosen. Three independent blockers, any one of which is fatal:

| Constraint | Reality | Effect |
|---|---|---|
| **Duration** | 300 s default on all plans; 800 s GA with Fluid compute on Pro/Enterprise; 1800 s in beta | A conservative 100-lead run takes 20–50 minutes at 8–18 s per profile. 500 leads takes hours. Even the beta ceiling is far too low. |
| **Bundle size** | Python functions inherit a 250 MB unzipped limit | Chromium alone is ~170 MB, plus system libraries (`libnss3`, `libatk`, `libgbm`, …) that are not in the runtime image. Playwright cannot download a browser to the read-only filesystem either. |
| **Statelessness** | Functions cannot hold a browser between invocations | There is no way to resume a half-finished scrape. |

Chopping the job into 300-second slices, or reaching for `@sparticuz/chromium`,
would be exactly the kind of fragile workaround worth avoiding. A long-lived
container is the correct shape for this workload. Everything else — the UI, the
API, auth — is an excellent fit for Vercel and lives there.

### Repository layout

```
app/                     Next.js App Router (pages + API routes)
components/              UI components, grouped by feature
lib/                     Supabase clients, validation, dedupe, CSV, integrations
lib/ai/                  Server-only AI message generation (Anthropic SDK)
lib/outreach/            Prompt building, output checks, message lifecycle rules
types/                   Database schema types and API response types
middleware.ts            Route protection
worker/                  Python scraper worker (Docker)
supabase/migrations/     SQL migrations, applied in numeric order
supabase/tests/          SQL test suite for the schema
scripts/test-db.sh       Runs the migrations + SQL tests on a throwaway Postgres
__tests__/               Vitest suites
```

---

## 2. Requirements

| | Version | Needed for |
|---|---|---|
| Node.js | 20+ | The web app |
| Python | 3.11+ | The worker (only if running it outside Docker) |
| Docker | any recent | The recommended way to run the worker |
| PostgreSQL client | 14+ | Optional — only to run `scripts/test-db.sh` |
| A Supabase project | free tier is fine | Database + auth |
| A LinkedIn account | — | The scraper signs in with it. Use a dedicated account, not your main one. |

---

## 3. Environment variables

Copy `.env.example` and fill it in. The web app reads `.env.local`; the worker
reads `worker/.env`.

### Web app (set these on Vercel)

| Variable | Required | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | yes | `https://<ref>.supabase.co`. Safe in the browser. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | yes | The `sb_publishable_…` key. Safe in the browser — RLS is what protects the data. The legacy name `NEXT_PUBLIC_SUPABASE_ANON_KEY` (anon JWT) is still accepted. |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | The `sb_secret_…` secret key (or legacy `service_role` key). **Bypasses RLS.** Server-side only. Never add a `NEXT_PUBLIC_` prefix. |
| `ANTHROPIC_API_KEY` | no | Enables "Draft with AI". Server-side only. Without it the app runs and messages can be written by hand; the generate endpoint answers `ai_not_configured`. |
| `OUTREACH_AI_MODEL` | no | Model for drafts. Defaults to `claude-opus-5-5`. |

The web app does **not** get `LINKEDIN_EMAIL` or `LINKEDIN_PASSWORD`. It has no
use for them, so it is never given them.

### Worker (set these on the worker host only)

| Variable | Default | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | — | Same project URL as above. |
| `SUPABASE_SERVICE_ROLE_KEY` | — | The worker writes on behalf of every user, so it needs this. |
| `LINKEDIN_EMAIL` | — | The scraper account. |
| `LINKEDIN_PASSWORD` | — | Read only by the worker process. |
| `SCRAPER_MAX_CONCURRENCY` | `1` | Profiles fetched at once. Values above 3 are refused. |
| `SCRAPER_DELAY_MS` | `8000` | Base delay between profile loads; randomised up to 2.25×. |
| `SCRAPER_TIMEOUT_MS` | `30000` | Per-navigation timeout. |
| `SCRAPER_MAX_RETRIES` | `3` | Retries per failed profile before it is skipped. |
| `SCRAPER_MAX_SEARCH_PAGES` | `10` | Search result pages loaded per job. |
| `SCRAPER_BREAK_EVERY_N_REQUESTS` | `15` | Pause after this many page loads. |
| `SCRAPER_POLL_INTERVAL_SECONDS` | `10` | Sleep between polls when the queue is empty. |
| `SCRAPER_HEADLESS` | `true` | Set `false` only to debug locally. |
| `SCRAPER_SESSION_DIR` | `.session` | Where the LinkedIn session is cached. Mount a volume here. |
| `SCRAPER_WORKER_ID` | `worker-1` | Identifies this instance in job claims and logs. |

The defaults are deliberately slow. Raising them raises the chance of tripping
LinkedIn's own protections, which this worker treats as a hard stop.

---

## 4. Supabase setup

1. Create a project at [supabase.com](https://supabase.com).
2. **Project Settings → Data API** — copy the Project URL.
3. **Project Settings → API Keys** — copy the `anon` key and the `service_role`
   key.
4. **Authentication → Providers** — make sure Email is enabled.
5. For a private tool, turn off public sign-ups once your account exists:
   **Authentication → Sign In / Providers → Allow new users to sign up**.

---

## 5. Database migrations

**Preferred for a new project:** the Supabase CLI, which records each migration
so later ones apply cleanly:

```bash
supabase login
supabase link --project-ref <your-ref>
supabase db push
```

Or run the six files in `supabase/migrations/` **in numeric order** in the
Supabase SQL editor (Database → SQL Editor → New query, paste, Run):

| File | Creates |
|---|---|
| `0001_init.sql` | Enums, the duplicate-detection key functions, `user_settings`, `scraping_jobs`, `leads`, `job_logs`, all indexes, and RLS policies on every table |
| `0002_user_bootstrap.sql` | A trigger that gives each new user a settings row |
| `0003_job_queue.sql` | `claim_next_job`, `job_heartbeat`, `finish_job`, `upsert_lead` |
| `0004_stats_and_rate_limit.sql` | `dashboard_stats`, the API rate-limit table and function |
| `0005_campaigns_and_outreach.sql` | `campaigns`, `outreach_messages`, `leads.campaign_id`, the message-lifecycle trigger, `outreach_stats`, `campaign_summaries`, `import_leads` |
| `0006_followups_replies_enrichment.sql` | `campaign_steps`, `follow_up_tasks`, `lead_replies`, `enrichment_requests`, planned send times, and the triggers that plan the next follow-up and stop a sequence on a reply |

`0005` is purely additive — no table, column or row is dropped or rewritten —
so it is safe on a database that already holds leads. It needs PostgreSQL 15+
(Supabase runs 17).

Or paste them all at once. `scripts/build-setup-sql.sh` concatenates them into
a single `supabase-setup.sql` you can run in one go:

```bash
./scripts/build-setup-sql.sh
```

That file is generated rather than committed, so it cannot drift from the
migrations it is built from. Run it once — it is not idempotent, and a second
run will error on the `CREATE TYPE` and `CREATE TABLE` statements.

The CLI route is the better one if you expect to change the schema later — the
SQL editor applies statements without tracking what has already run.

`supabase/config.toml` is what makes both this and the Supabase GitHub
integration work; the integration's checks are skipped when it is missing.

### If you pasted the SQL and the GitHub integration now fails

Pasting into the SQL editor creates the objects but records nothing in
`supabase_migrations.schema_migrations` — that bookkeeping belongs to
`supabase db push`. The Supabase GitHub integration therefore believes the
database is empty, tries `0001_init.sql` on the next push to `main`, and fails:

```
ERROR: type "job_status" already exists (SQLSTATE 42710)
```

It fails that way on every push until the ledger is corrected. Paste
`supabase/repair-migration-ledger.sql` into the SQL editor once. It records
0001–0004 as applied and changes nothing in the `public` schema, so the
integration skips those four files and applies only migrations added later
(here, `0005`). It does not list `0005`; if you pasted that too, add `('0005')`
to its insert before running it.

Check the tables really are there before running it — the file explains why and
gives the query.

### Verifying the schema locally

`scripts/test-db.sh` applies every migration to a throwaway PostgreSQL instance
and runs the SQL test suite — duplicate detection, the job queue, and RLS:

```bash
./scripts/test-db.sh
```

It needs a local PostgreSQL 14+ with `postgresql-contrib` (for `unaccent`).
Nothing touches your Supabase project.

---

## 6. Local development

### On Windows, by double-click

Double-click `start-app.bat` in the repository root. It checks for Node 20+,
installs the packages, writes a `.env.local` template for you to fill in on the
first run, starts the dev server and opens the browser.

The app is a web app either way — it runs a server on your machine and you view
it in a browser at <http://localhost:3000>. There is no desktop executable. It
reads the same Supabase project as the Vercel deployment, so accounts, leads
and jobs are identical in both.

### Any platform

```bash
git clone https://github.com/MagnoraMarketing/Magnora-Lead-Builder.git
cd Magnora-Lead-Builder

npm install
cp .env.example .env.local     # fill in the three Supabase values (+ ANTHROPIC_API_KEY for AI)
npm run dev
```

Open <http://localhost:3000>. You will be redirected to `/login`; create an
account with the sign-up link, then you land on `/search`.

If the Supabase variables are missing, every route redirects to `/setup`, which
tells you exactly what is missing rather than throwing.

Useful scripts:

```bash
npm run dev         # dev server
npm run build       # production build
npm run lint        # ESLint, zero warnings allowed
npm run typecheck   # tsc --noEmit
npm run test        # Vitest
npm run format      # Prettier
```

---

## 7. Running the scraper worker

### On Windows, without Docker (simplest)

Double-click `worker/start-worker.bat`.

It creates a virtual environment in `worker/.venv`, installs the dependencies
and Chromium, and starts the worker. On the first run it writes a `worker/.env`
template and opens it in Notepad — fill in the four values, save, and run the
file again.

Leave the window open while a search runs; closing it stops the worker. An
unfinished job returns to the queue once its heartbeat goes stale and is picked
up on the next start, so nothing is lost.

This needs **Python 3.10–3.13** on PATH. Not 3.14: the pinned
`pydantic-core` and `greenlet` publish wheels up to cp313 only, so pip falls
back to compiling them and fails on a missing Rust toolchain and MSVC linker.
The script asks the Windows launcher for 3.13, 3.12, 3.11 and 3.10 by name,
in that order, before falling back to the default. That matters because `py -3`
returns the *newest* installed Python: on a machine carrying both 3.14 and 3.12
it hands back 3.14, so simply installing a supported version would not be
enough. It also rebuilds `worker/.venv` when the environment was created by an
interpreter outside the range.

No cloud host is needed at all: the only contract between the web app and the
worker is a row in `scraping_jobs`, so the worker only needs outbound internet
access.

### With Docker (recommended)

```bash
cd worker
cp ../.env.example .env        # fill in Supabase + LinkedIn values
docker compose up --build
```

### Without Docker

Python 3.10–3.13; see the note above about 3.14.

```bash
cd worker
python -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -r requirements.txt
playwright install --with-deps chromium

export $(grep -v '^#' .env | xargs)  # or set the variables however you prefer
python -m linkedin_lead_worker.main
```

The worker polls for queued jobs, claims one at a time, and logs one JSON
object per line to stdout.

### First run

On its first run the worker signs in with `LINKEDIN_EMAIL` / `LINKEDIN_PASSWORD`
and caches the session in `SCRAPER_SESSION_DIR`. Later runs reuse it, which is
both faster and much less likely to trigger a verification challenge — which is
why that directory should be a mounted volume in production.

If LinkedIn asks for 2FA or a security checkpoint, the worker **stops and
reports it**. It does not attempt to solve, bypass or wait out the challenge.
Sign in to the account in a normal browser, complete the challenge, then restart
the worker.

---

## 8. Deploying to Vercel

1. Push this repository to GitHub.
2. In Vercel: **Add New → Project**, import the repository. The framework is
   detected automatically; leave the root directory as the repository root
   (`.vercelignore` keeps `worker/` out of the build).
3. **Settings → Environment Variables** — add all three Supabase variables for
   Production, Preview and Development, and `ANTHROPIC_API_KEY` if you want AI
   drafting.
4. Deploy.

`vercel.json` caps the API functions at 30 seconds, which is generous: the
slowest of them only writes a queue row.

Do **not** set `LINKEDIN_EMAIL` or `LINKEDIN_PASSWORD` on Vercel. Nothing there
reads them.

---

## 9. Deploying the worker

**This deployment runs the worker on a Windows PC — see §7.** That is the
chosen setup, not a fallback. The only contract between the web app and the
worker is a row in `scraping_jobs`, so the worker needs outbound internet
access and nothing more; nothing has to reach it from outside, and it costs
nothing to run. See `CLAUDE.md` for why.

The rest of this section covers container hosts, kept as worked examples in
case the worker ever has to run unattended. **`render.yaml` and `fly.toml` are
not in use here.** A host that runs long-lived containers is required; the
`Dockerfile` is portable.

### Render (blueprint included — not used here)

`render.yaml` at the repository root describes the whole service, so there is
nothing to configure by hand:

1. Render dashboard → **New** → **Blueprint** → pick this repository.
2. Render reads `render.yaml` and prompts for the four secrets it marks
   `sync: false`: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
   `LINKEDIN_EMAIL`, `LINKEDIN_PASSWORD`. The first two are the same values the
   Vercel project uses; the LinkedIn pair belongs only here.
3. **Apply**. The first build takes a few minutes — the Playwright base image
   carries Chromium.

Two things about the blueprint are deliberate:

- **`plan: standard`, not `starter`.** Chromium does not fit in the 512 MB
  starter plan; it is killed mid-scrape by the OOM reaper. Standard is the
  smallest plan above the 1 GB the `fly.toml` equivalent asks for. Background
  workers have no free tier on Render.
- **A 1 GB disk mounted at `/data`.** This persists the LinkedIn session across
  restarts. Without it every restart signs in again, which is what provokes
  LinkedIn's verification challenges.

Confirm it is alive in **Logs**: `Worker starting`, then a `claim_next_job` poll
every 10 seconds. A run started from `/search` in the web app should move from
`queued` to `running` within one poll.

### Fly.io

```bash
cd worker
fly launch --no-deploy --copy-config
fly volumes create worker_session --size 1
fly secrets set \
  NEXT_PUBLIC_SUPABASE_URL="https://<ref>.supabase.co" \
  SUPABASE_SERVICE_ROLE_KEY="..." \
  LINKEDIN_EMAIL="..." \
  LINKEDIN_PASSWORD="..."
fly deploy
```

### Not Vercel

`worker/vercel.json` sets `ignoreCommand` to `exit 0`, so any Vercel project
pointed at this directory cancels its build instead of failing it. Vercel flags
this repository as a monorepo and offers to add a project per subdirectory, and
`worker/` looks like a standalone app to that heuristic — but it cannot build
there for the reasons in §1, so every such project fails on every commit until
it is deleted. The guard makes that harmless rather than noisy.

The web app's own deployment is unaffected: `.vercelignore` excludes `/worker/`
from it, so this file never reaches that build.

### Anything else

Railway, a VPS with `docker compose`, or your own Kubernetes — the image is
standard. Two requirements:

- **A persistent volume at `SCRAPER_SESSION_DIR`.** Without it every restart
  forces a fresh LinkedIn sign-in. Volumes are mounted root-owned on every host
  worth naming, so the image starts as root, chowns the directory to `pwuser`
  and drops privileges before the scrape begins — see `worker/entrypoint.sh`.
- **Do not scale to zero.** A worker killed mid-job leaves it running until the
  heartbeat goes stale (5 minutes), after which it is re-claimed. That is safe,
  but it wastes time.

Running two workers is supported — `claim_next_job` uses `FOR UPDATE SKIP
LOCKED`, so they never collide — but each one signs in as the same LinkedIn
account, which increases rate-limit pressure. One worker is the sensible
default.

---

## 10. Security

**Credentials.** LinkedIn credentials live only in the worker's environment.
They are never stored in the database, sent to the browser, returned by an API,
or written to a log. There is deliberately no UI field for them. The worker's
logger passes every record through a redaction filter, so a secret that ends up
in a message or an exception string is replaced before any handler sees it.

**Service role key.** `lib/supabase/admin.ts` imports `server-only`, which makes
importing it from a Client Component a build error. The key therefore cannot
reach the browser bundle.

**Row Level Security.** Enabled on every table, deny by default, with policies
comparing `auth.uid()` to `user_id`. This is verified by
`supabase/tests/schema_test.sql`, which checks that a user sees only their own
rows, that cross-user updates and deletes affect zero rows, that a cross-user
insert is rejected, that the `anon` role cannot read `leads` at all, and that
the worker's RPCs are not callable from a browser session.

**Defence in depth.** Every API route independently authenticates the caller
with `getUser()` (which validates the JWT with Supabase, unlike `getSession()`)
and filters every query on `user_id`. RLS is the backstop, not the only line.

**Input validation.** Every request body and query string is parsed with Zod
before it reaches the database. Search terms are stripped of PostgREST's `or`
separators so a filter cannot be rewritten from a search box.

**Rate limiting.** Enforced in PostgreSQL, because Vercel functions are
stateless and an in-process counter would reset on every cold start. Search
creation is limited to 10 per hour per user.

**AI key.** `ANTHROPIC_API_KEY` is read only by `lib/ai/outreach.ts`, which
imports `server-only`; the browser calls `/api/messages/generate` and never
sees the key or talks to Anthropic. Generation is rate limited to 60 per hour
per user.

**Ownership of related rows.** `outreach_messages` and `leads.campaign_id`
reference `(id, user_id)` composite keys, so a message can never point at
another user's lead and a lead can never join another user's campaign — even
through the service role, which bypasses RLS.

**Error messages.** Users get a stable code and a readable message. Database
errors, connection strings and constraint names go to the server log only.

**CSV injection.** Exported fields starting with `=`, `+`, `-` or `@` are
prefixed with an apostrophe, so a scraped value cannot execute as a formula
when the file is opened in Excel.

---

## 11. Testing

```bash
npm run test              # Vitest: dedupe, CSV, validation, API auth/authz, outreach, import
./scripts/test-db.sh      # SQL: schema, duplicate detection, job queue, RLS, outreach
cd worker && pytest       # Python: parsing, config, redaction, geo, job runner
```

What is covered:

| Area | Where |
|---|---|
| Duplicate detection, all three keys | `__tests__/dedupe.test.ts`, `supabase/tests/schema_test.sql` |
| Lead validation | `__tests__/validation.test.ts` |
| Job creation, limits, concurrency | `__tests__/api.test.ts` |
| Authentication on every endpoint | `__tests__/api.test.ts` |
| Authorization / user scoping | `__tests__/api.test.ts`, `supabase/tests/schema_test.sql` |
| CSV export, including injection | `__tests__/csv.test.ts` |
| Scraper HTML parsing | `worker/tests/test_parsing.py` |
| Job queue and restart safety | `supabase/tests/schema_test.sql`, `worker/tests/test_runner.py` |
| Secret redaction in logs | `worker/tests/test_config_and_logging.py` |
| AI prompt rules and draft checks | `__tests__/outreach-prompt.test.ts` |
| AI request shape, retries, refusals, errors (SDK with stubbed fetch) | `__tests__/ai-outreach.test.ts` |
| Campaign, message and import routes: auth, scoping, lifecycle | `__tests__/outreach-api.test.ts` |
| CSV import parsing and round trip with the export | `__tests__/csv-import.test.ts` |
| Message lifecycle trigger, composite-key ownership, import dedupe, RLS | `supabase/tests/outreach_test.sql` |

The TypeScript and SQL duplicate-detection rules are implemented separately and
tested against the same cases, so a drift between them fails a test rather than
silently creating duplicates.

---

## 12. Adding countries and cities

LinkedIn filters people search on numeric location ids (`geoUrn`). Only ids
verified against a real LinkedIn URL are configured. Denmark is
`104514075`; a few others are present but disabled.

**The Danish city ids are not verified and are set to `null` on purpose.** A
wrong id would silently search the wrong place, which is worse than not
filtering server-side. For a city without an id the worker still narrows to the
country and then matches the location text on each profile.

To add a verified id:

1. Run the search on LinkedIn with the location filter applied.
2. Read it out of the address bar: `...&geoUrn=%5B"104514075"%5D` → `104514075`.
3. Add it in **both** places:
   - `lib/constants/search.ts` — for the dropdown (set `enabled: true` for a country)
   - `worker/linkedin_lead_worker/geo.py` — for the scraper

For a new city, add the location text variants to `CITY_TEXT_MATCHES` too, so
the text fallback works before an id is found (for example Copenhagen matches
`copenhagen`, `københavn`, `kobenhavn` and `kbh`).

---

## 13. Connecting a dialer

> **Not in use in this deployment.** Leads leave the system as CSV. This
> section describes how a dialer *could* be wired up; it is not outstanding
> work. See `CLAUDE.md`.

`POST /api/leads/export-to-dialer` is implemented and authenticated, but no
dialer ships with the app — inventing an API for a system that already exists
would only produce code to throw away. Until one is connected the endpoint
returns `501 dialer_not_configured` rather than pretending to succeed.

To connect yours, implement `DialerProvider` (`lib/integrations/dialer/types.ts`):

```ts
import { setDialerProvider, leadToDialerContact } from '@/lib/integrations/dialer';

class MyDialerProvider implements DialerProvider {
  readonly id = 'my-dialer';
  readonly name = 'My Dialer';

  isConfigured() {
    return Boolean(process.env.MY_DIALER_API_KEY);
  }

  async exportLeads(leads) {
    const contacts = leads.map(leadToDialerContact);
    // ...push to your system, then report per-lead outcomes
    return { provider: this.id, exported: contacts.length, failed: 0, results: [] };
  }
}

setDialerProvider(new MyDialerProvider());
```

Nothing else changes.

---

## 13a. Campaigns and AI outreach

### The AI Lead Builder page (`/builder`)

The page you land on after signing in, and the quickest way through the whole
flow:

1. **Lead form** — name, role and company (required), LinkedIn URL (optional),
   plus an optional campaign, message type and one line of extra guidance.
2. **Generate message** — `POST /api/generate-message` drafts the text with
   Claude on the server and returns it. Nothing is saved yet.
3. **Review and edit** the text, or choose "Write it myself".
4. **Save lead & message** — `POST /api/builder` stores both in Supabase; the
   message starts as a **Draft**. If the lead already exists (same LinkedIn URL,
   or same name at the same company), the draft is added to that lead.
5. **Table below** — newest first, with the status (**Draft → Approved →
   Sent**), a button for the next step, and an expandable preview where the
   text can be edited, copied or archived.

The longer routes below — campaigns, the per-lead outreach panel and the
`/messages` queue — use the same messages and the same rules.

**Campaigns** (`/campaigns`) group leads and hold the context the AI writes
from: your name and company, what you offer, the next step you want, tone
(professional, friendly, direct) and language (Danish or English). Assign leads
from the lead page, in bulk from `/leads`, or on CSV import.

**Drafting** happens on a lead's page. "Draft with AI" sends the lead's stored
fields and the campaign context to the Anthropic API from the server and saves
the result as a **draft**. "Write by hand" does the same without AI. Two types:
a connection-request note (LinkedIn's hard limit is 300 characters, enforced in
the database) and a direct message.

What the generator is and is not allowed to do:

- It sees only what is stored — the lead's role, company, location, industry,
  size and your own notes, plus the campaign. It has no tools and no web
  access; nothing is looked up about the person or the company.
- It is told not to imply research (read your post, saw your news), shared
  connections or history, and not to invent numbers, customers or claims.
- Every draft is checked before it is saved: length, no placeholders such as
  `[Name]`, and no links except ones you put in the campaign. A failing draft
  is retried once with the problems listed, then refused.
- A refusal or provider error saves nothing and says so.

**Review and tracking** happens on `/messages` (and on each lead):

| Status | Meaning |
|---|---|
| Draft | Editable. New drafts always start here. |
| Approved | You approved this exact text. Editing it sends it back to Draft. |
| Sent | You clicked **Mark as sent** after sending it on LinkedIn. Locked as a record. |
| Archived | Parked. Can be restored to Draft. |

**Copy text** only copies to the clipboard — it never changes a message. Only
the explicit **Mark as sent** button does, and only from Approved. Marking a
message sent moves a lead at New or Qualified to Contacted; later statuses are
left alone. These rules live in a database trigger
(`outreach_messages_guard`), so they hold for every client, not just the UI.

No message is ever sent to LinkedIn by the app.

Leads marked **Do not contact** cannot have messages drafted.

## 13b. Importing leads from CSV

`/leads` → **Import CSV**. The file needs a header row and a **Name** column
(or First name + Last name). Recognised columns, in English or Danish:
Title/Stilling, Company/Virksomhed, Company website, LinkedIn URL, Email,
Phone, Mobile, Location/By, Country/Land, Industry/Branche, Company size,
Status and Notes. The app's own CSV export imports as-is. Comma or semicolon
delimited (Danish Excel), UTF-8, up to 1,000 rows and 2 MB.

The file is parsed and every row validated on the server. Rows with errors are
reported by line number and skipped. Valid rows go through `import_leads()`,
which runs as you (RLS applies) and lets the same three duplicate-detection
indexes skip leads you already have — an import never overwrites a lead.

## 13c. Follow-ups, replies and Today

Outreach is **semi-automatic**: the app plans and drafts, you send.

- **Campaign sequence** (`/campaigns/[id]` → Follow-up sequence): e.g.
  "3 days later: short reminder", "7 days later: share a result". Step 1 is
  the first message.
- When you **mark a message as sent**, the next step is planned for that lead
  automatically (`follow_up_tasks`), due N days after the send.
- **Today** (`/today`) lists follow-ups due today (draft each with AI, write
  it yourself, or skip), replies waiting for an answer, and approved messages
  planned for today.
- On a lead, **paste their reply** into the Conversation panel. That stops the
  lead's planned follow-ups, and "Draft with AI" then writes a *reply* using the
  whole conversation. A final lead status (interested, meeting, not
  interested, invalid, do not contact) stops the sequence too.
- **Plan follow-up** on a lead sets one by hand, at any time and topic.
- Any draft can be given a **planned send time**.

Nothing is sent to LinkedIn by the app, and the inbox is not read — both
would break LinkedIn's terms and risk the account.

## 14. Enrichment

**Apollo.io**, optional: set `APOLLO_API_KEY` on Vercel. "Find email & phone"
on a lead calls People Enrichment with the name, company, website domain and
LinkedIn URL.

- A **verified** email and company details are applied immediately. Apollo's
  "guessed" emails and locked placeholders are never stored.
- **Phone numbers** arrive minutes later at `/api/webhooks/apollo/<token>`
  (Apollo requires a webhook for phones). The token is random per lookup and
  can only fill that lead's empty phone fields. Vercel Authentication blocks
  Apollo unless **Protection Bypass for Automation** is enabled (the app adds
  the bypass secret to the webhook URL automatically) or a custom domain is
  used.
- Only empty fields are filled; nothing you typed is overwritten. Each lookup
  is logged in `enrichment_requests`, including the raw webhook payload.

Leads are personal data: you need a lawful basis (GDPR) for enriching them,
and Danish law (markedsføringsloven §10) restricts unsolicited email marketing.

`email`, `phone` and `mobile_phone` are `null` unless LinkedIn actually
published them. **The scraper never invents contact data** — it does not build
an address from a name and a domain, and it does not generate phone numbers. A
phone number is read only from an explicit `tel:` link, and email addresses are
filtered against a list of asset and vendor domains that produce email-shaped
false positives.

Apollo (above) is how those gaps are filled. Another vendor can be added by
implementing `EnrichmentProvider` (`lib/integrations/enrichment/index.ts`).

---

## 15. Troubleshooting

**Every page redirects to `/setup`.** The Supabase environment variables are
missing. Add them and redeploy.

**A job sits at "Queued" forever.** No worker is running, or it cannot reach
Supabase. Check the worker logs. Verify `NEXT_PUBLIC_SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` are set on the worker, and that the migrations —
especially `0003_job_queue.sql`, which creates `claim_next_job` — have been run.

**"LinkedIn requires a verification step."** LinkedIn served a 2FA prompt,
security checkpoint or CAPTCHA. This is not worked around by design. Sign in to
the scraper account in a normal browser, complete the challenge, delete the
cached session directory, and restart the worker.

**"LinkedIn rejected the scraper account's credentials."** Check
`LINKEDIN_EMAIL` and `LINKEDIN_PASSWORD` on the worker. The worker does not
retry past a rejection — repeated attempts are what get an account locked.

**"LinkedIn served a sign-in wall."** The cached session expired. Delete the
session directory and restart; the worker will sign in fresh.

**A search finds fewer leads than requested.** Expected. LinkedIn's keyword
search is fuzzy, so results are filtered a second time on job title and
location, and anything already in your database is skipped as a duplicate. The
job log on `/jobs/[id]` shows exactly what happened.

**Jobs are slow.** By design — see the delay settings. 100 leads takes roughly
20–50 minutes. Lowering `SCRAPER_DELAY_MS` is not recommended.

**"You already have a search in progress."** One search runs at a time. Cancel
it on `/search` or wait for it to finish.

**"AI drafting is not set up on this deployment."** `ANTHROPIC_API_KEY` is not
set on the server. Add it on Vercel and redeploy. `/setup` shows whether it is
set.

**"The AI could not produce a draft that passed the checks."** Two attempts in a
row broke a rule (usually length for a connection note). Try again, switch to a
direct message, or write it by hand.

**Duplicates appear in the database.** They should not — three unique indexes
prevent it. Check that `0001_init.sql` applied cleanly, in particular the
`unaccent` extension and the `lead_*_key` functions.

**`unaccent` errors when applying migrations.** Enable the extension:
`create extension if not exists unaccent;`. On a self-hosted Postgres install
`postgresql-contrib` first.

---

## 16. Legal and ethical use

The upstream project this is derived from states it is for educational purposes
and not for commercial use, and LinkedIn's
[User Agreement](https://www.linkedin.com/legal/user-agreement) prohibits
scraping. Using this tool commercially is your decision and your risk. Consider
your GDPR obligations too: leads are personal data, and you need a lawful basis
for processing them, plus a way to honour deletion requests. The `do_not_contact`
status and the delete action exist for that.

What this application deliberately does **not** do, and will not be extended to
do:

- Solve, bypass or wait out CAPTCHAs, 2FA or security checkpoints
- Spoof browser fingerprints or use stealth automation-hiding scripts
- Rotate proxies or user agents to evade rate limits
- Exceed LinkedIn's rate limits through aggressive parallelism

When LinkedIn refuses a request or asks for human verification, the job stops
and tells you why. The conservative defaults are the point, not an obstacle.

---

## License

MIT — see [LICENSE](LICENSE).
