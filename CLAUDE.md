# Project decisions

Operational decisions for this deployment. They were settled in conversation
and kept being re-derived wrongly from the README, which cost real time — so
they live here, in the repository, where they survive.

Read this before recommending a host, an integration, or a Supabase project.

---

## Supabase project

**`pnvofygshswcmgqmgvbw`** — a new account and project created for this
repository (Magnora Lead Builder).

- Project URL: `https://pnvofygshswcmgqmgvbw.supabase.co`
- It issues the new key types: `sb_publishable_…` (browser, in
  `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`) and `sb_secret_…` (server, in
  `SUPABASE_SERVICE_ROLE_KEY`).

- `mjncziwoqpqhljcoevoe` is the project of the source repository
  (`linkedin-scraper-best`), not this one.
- The Supabase MCP connector in Claude sessions has pointed at
  `jrnivwqlvmoniwarpjlr`, an unrelated AI-booking project with its own `leads`
  table. Never apply these migrations there.

**Schema status:** nothing applied yet. On the new project run all five files in
`supabase/migrations/` from scratch, preferably with `supabase db push`, so the
ledger is recorded and `repair-migration-ledger.sql` is never needed.

---

## AI outreach

Drafts are generated server-side with the Anthropic SDK (`lib/ai/outreach.ts`),
key in `ANTHROPIC_API_KEY` on Vercel only. The generator sees only stored lead
fields and campaign text — no tools, no web access — and must not imply
research it has not done. Drafts are saved as `draft`; only the explicit
"Mark as sent" action, from `approved`, sets `sent`. Copying text never
changes a message. These rules are enforced by the `outreach_messages_guard`
trigger, not just the UI.

## The worker runs on a Windows PC

**Not Render. Not Fly.io. Not Docker. Not Vercel.**

`worker/start-worker.bat`, double-clicked, is the deployment. This is a
deliberate choice, not a fallback:

- The only contract between the web app and the worker is a row in
  `scraping_jobs`, so the worker needs outbound internet access and nothing
  more. Nothing has to reach it from outside.
- It costs nothing. Render has no free tier for background workers, and
  Chromium needs the paid `standard` plan to avoid the OOM reaper.
- The session cache in `worker/.session` persists on local disk with no volume
  to configure, and a LinkedIn verification challenge can be solved by hand by
  setting `SCRAPER_HEADLESS=false` for one run — awkward on a remote host.

`render.yaml` and `fly.toml` remain in the repository as worked examples for a
future unattended deployment. **They are not in use.** Do not propose Render.

**Python 3.10–3.13 only.** Not 3.14: the pinned `pydantic-core` and `greenlet`
ship wheels through cp313 only.

---

## Not in scope

- **No dialer.** `lib/integrations/dialer/` stays the `NotConfiguredDialerProvider`
  stub. CSV export is how leads leave the system. Do not list "connect a
  dialer" as outstanding work.
- **No enrichment.** `lib/integrations/enrichment/` stays the noop provider.

Both are deliberate stubs that report honestly rather than pretending to
succeed. README §13 and §14 describe how they *could* be wired up; nobody is
asking for it.

---

## Where configuration lives

Two places, and only two:

| Where | What |
|---|---|
| Vercel → project `magnoraleadbuilder` → Environment Variables | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY` (optional: `OUTREACH_AI_MODEL`) |
| `worker/.env` on the operator's PC | `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `LINKEDIN_EMAIL`, `LINKEDIN_PASSWORD` |

LinkedIn credentials never go on Vercel — nothing there reads them. The
Anthropic key never goes on the worker — nothing there reads it.

`NEXT_PUBLIC_*` values are inlined into the browser bundle **at build time**, so
changing them in Vercel requires a redeploy. Editing the variable alone leaves
the running app on the old value, which looks exactly like the edit not working.

### The stray Vercel `worker` project

Vercel treats this repository as a monorepo and auto-creates a project rooted
at `worker/`. It cannot build — that directory is Python and Chromium — so
`worker/vercel.json` sets `ignoreCommand` to `exit 0` to keep it from failing
every commit. **Delete such a project; never put credentials in it.** It has
reappeared after deletion before.

---

## Verifying a change

```bash
npm run lint && npm run typecheck && npx vitest run   # 136 tests
./scripts/test-db.sh                                  # SQL suites (needs local Postgres 15+)
cd worker && python -m pytest -q                      # 57 tests
```

CI runs both on every push.
