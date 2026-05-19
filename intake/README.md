# bridge-intake — Bridget's intake engine

Capability #22 from the BRIDGE canvas. The membrane between every inbound surface
(email, Telegram, WhatsApp, voice memos, photos, calendar, Drive, SharePoint)
and Omar's inner agents (Beatrix, Clem).

Long-running cloud daemon. Surface watchers run in-process. Relay forwards
Telegram + WhatsApp through here over HTTP. Local Mac watchers post voice
memo + photo events. Email + Calendar + Drive run Gmail-OAuth polling
inside the daemon. SharePoint uses Microsoft Graph delta queries.

## Pipeline

```
inbound  →  surface adapter  →  normalized intake item  →  classifier  →  router  →  agent / brain / Omar
                                                              ↓             ↓
                                                          audit log    audit log
```

## Files

```
src/
  daemon.mjs                  entrypoint
  http.mjs                    HTTP server (all endpoints)
  pipeline.mjs                ingest(item) → classify + route
  metrics.mjs                 in-process counters + latency
  log.mjs                     stderr logger
  audit/index.mjs             audit substrate adapter (Agent C interface)
  classifier/
    index.mjs                 combines rules + LLM
    rules.mjs                 fast deterministic patterns
    llm.mjs                   Claude Sonnet 4.5 with structured output
  routing/
    router.mjs                dispatch handle/queue/escalate/archive
    thresholds.mjs            action thresholds per surface × principal
    agents.mjs                OpenClaw → Beatrix/Clem
    brain.mjs                 gbrain HTTP / CLI
    omar.mjs                  Telegram → Omar
  surfaces/
    telegram.mjs              relay forwards via /ingest/telegram
    whatsapp.mjs              relay forwards via /ingest/whatsapp
    email.mjs                 Gmail polling (OAuth + history.list)
    calendar.mjs              Google Calendar (shared OAuth)
    drive.mjs                 Google Drive (shared OAuth)
    sharepoint.mjs            Microsoft Graph delta
    voicememo.mjs             local watcher POSTs to /ingest/voice-memo
    photo.mjs                 local watcher POSTs to /ingest/photo

local-watchers/
  voicememo.mjs               run on Omar's Mac via launchd
  photo.mjs                   run on Omar's Mac via launchd

test/
  fixtures/                   sample inbound from each surface
  run.mjs                     offline unit + adapter tests
  e2e.mjs                     end-to-end against running daemon
```

## Endpoints

| Method | Path                              | Purpose                                       |
|--------|-----------------------------------|-----------------------------------------------|
| GET    | /health                           | Liveness probe                                |
| GET    | /metrics                          | Counters + latency snapshot                   |
| POST   | /ingest/telegram                  | Relay forwards Telegram messages              |
| POST   | /ingest/whatsapp                  | Relay forwards WhatsApp via Twilio            |
| POST   | /ingest/voice-memo                | Local Mac watcher posts voice memo events     |
| POST   | /ingest/photo                     | Local Mac watcher posts photo events          |
| POST   | /ingest/admin-test                | Manually inject an inbound (admin token)      |
| POST   | /push/email                       | Gmail Pub/Sub push handler                    |
| GET    | /admin/oauth/google/start         | Returns Google OAuth URL Omar taps            |
| GET    | /admin/oauth/google/callback      | OAuth redirect target (Google calls)          |
| GET    | /admin/threshold                  | Read action thresholds                        |
| POST   | /admin/threshold                  | Update action thresholds                      |
| POST   | /admin/test                       | Classify + compute routing without acting     |
| GET    | /admin/audit                      | Recent audit events                           |

Admin endpoints require `?token=<ADMIN_TOKEN>` or `Authorization: Bearer <token>`.

## The 60-second OAuth click flow Omar needs to do

Once the service is deployed (URL `https://bridge-intake.onrender.com`):

1. Open `https://bridge-intake.onrender.com/admin/oauth/google/start?token=<ADMIN_TOKEN>`
   in any browser. You'll see a JSON response with an `authUrl`.
2. Tap that URL. Google asks "Bridget wants to read your Gmail / Calendar / Drive."
3. Tap Allow.
4. Google redirects to `/admin/oauth/google/callback?code=…`. Bridget's daemon
   exchanges the code for tokens, persists them, and starts polling your inbox.
5. Done. Email + Calendar + Drive are all live.

After this one click, refresh tokens auto-renew indefinitely.

## Run locally

```bash
cd intake
npm install
STATE_DIR=/tmp/intake PORT=8080 ADMIN_TOKEN=local-token \
  ANTHROPIC_API_KEY=sk-… \
  TELEGRAM_BOT_TOKEN=… TELEGRAM_CHAT_ID=… \
  GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… \
  node src/daemon.mjs
```

## Tests

```bash
# offline (no network, no LLM):
node test/run.mjs

# end-to-end (against running daemon):
INTAKE_URL=http://localhost:8080 INTAKE_ADMIN_TOKEN=local-token \
  node test/e2e.mjs
```

## Audit log

Every classification + routing decision writes a JSONL line to
`$STATE_DIR/intake/audit.jsonl`. The shape matches what Agent C's
trust-and-audit library is expected to expose. When their library publishes,
swap the implementation of `src/audit/index.mjs::record` to call into it
and run a one-time backfill.

## Local Mac watchers

Voice memo and photo watchers run on Omar's Mac because the cloud has no
access to those folders. Install them as launchd plists (template at the
bottom of each watcher file).

Once installed:
- New voice memo → Whisper transcribes → POST to /ingest/voice-memo → intake routes.
- New screenshot or download → vision describes → POST to /ingest/photo → intake routes.
