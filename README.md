# Dakghar: email sending SaaS (Phase 1)

Multi-tenant bulk email platform with subscription plans, built around one goal: **land in the inbox, not in spam.**

## What costs money (and what does not)

| Part | Cost |
|---|---|
| This app, Postgres, Redis, dashboard, journeys, MCP server, writing help, public API | **Free.** No paid API is used anywhere |
| Hosting | Your own PC, or any server you already have |
| Email sending | Needs an SMTP relay. **Brevo's free plan gives 300 emails a day with no credit card** (about 9,000 a month). Set `SMTP_URL` to it, see `.env.example` |
| A domain for your From address | Small yearly fee. Unavoidable: without your own domain you cannot set SPF/DKIM and mail lands in spam |
| Payments | Razorpay has no monthly fee but takes a cut of each payment. To avoid it entirely, take UPI/bank payments yourself and move people between plans with `POST /admin/tenants/:id/plan` |
| Using Claude through the MCP server | The server is free; the AI client you connect (for example your own Claude account) has its own usage terms |

Free-tier limits change, so check the provider's page before you rely on them. Honest limits of a free setup: **(1)** bounce and complaint reports only reach the app if you add the webhook. SES and **Brevo are both supported** (`/webhooks/ses`, `/webhooks/brevo?token=...`, see Go live). Another relay's reports are not wired in, so keep lists clean and volumes small there. The Brevo handler follows Brevo's published payload format and is tested against it, but has not been run against a live Brevo account. **(2)** Selling email sending to *other* people (this is a SaaS) usually breaks free relays' terms and always has a per-email cost somewhere. Price your plans above that cost.

## Run it

**With Docker (easiest)**
```bash
cp .env.example .env
docker compose up --build
```
App: http://localhost:3000 · Test inbox (Mailpit catches every email): http://localhost:8025

**Without Docker** (needs Node 22, Postgres 15+, Redis)
```bash
npm install
export DATABASE_URL=postgres://user:pass@localhost:5432/hiringarrow REDIS_URL=redis://localhost:6379
export AUTO_APPROVE=true MAIL_DRIVER=log      # 'log' sends nothing, just records it
npm run migrate
npm start            # terminal 1: API + dashboard
npm run worker       # terminal 2: sends the emails
npm run smoke        # optional: 97 end-to-end API checks (journeys, API, MCP, AI via scripts/mock-ai.mjs, smart send time)
npm run test:failover   # optional: provider failover
node scripts/mock-ai.mjs & npm run test:llm   # optional: the connect-your-own-model path
npm i -D jsdom && npm run smoke:ui   # optional: 52 dashboard checks (see header of scripts/ui-smoke.mjs)
```

## What is built

| Area | Details |
|---|---|
| Accounts | Signup/login (bcrypt + JWT), tenant isolation, new tenants start in **review** with a 200/day cap until you approve them |
| Contacts | CSV import with syntax, disposable and role-address checks, optional MX check, dedupe, consent proof log, hosted signup page with **double opt-in** |
| **Visual builder** | Drag-and-drop email designer (heading, text, image, button, 2 columns, divider, spacer, custom HTML), 3 starter templates, undo/redo, email-safe table HTML that stacks on phones, desktop/phone preview, raw HTML tab |
| Campaigns | `{{first_name \| fallback}}` personalisation, live subject-line coach and inbox preview, **A/B subject test**, **scheduled send**, test send, pause/resume, duplicate, autosave |
| **Segments** | Send to a list plus conditions (engaged in N days, inactive, tag, email domain, custom field, opened / clicked / ignored an earlier campaign) with a live "N people will receive this" count |
| **Reports** | Per-campaign ribbon, hourly chart, per-version A/B results, top links, per-mailbox-provider opens and bounces; 14-day overview chart; onboarding checklist |
| **Journeys** | Automatic multi-step emails. Triggers: subscribes, joins a list, gets a tag, clicks a link, or your site sends an event. Steps: email (visual builder), wait, "only continue if opened/clicked/has tag", add/remove tag. Per-step live counts. Each person enters once; unsubscribed people leave automatically. Turn-on runs the same spam checks as a campaign |
| **Smart send time** | Per-person delivery at the hour they usually open (needs 3 real opens; machine opens ignored) |
| **Public API** | Hashed API keys (read-only or read-write), `POST /v1/contacts` (consent source mandatory), `POST /v1/events`, `GET /v1/contacts/:email`, rate-limited |
| **MCP server** | `POST /mcp` (Streamable HTTP). 14 tools so Claude can check sender health, preview audiences, draft campaigns, check, schedule and, only with `confirm=true` and a read-write key, send |
| **Writing help** | Free and built in, no API, works offline. Subject ideas (spam-checked), a draft email from your own notes, plain-words audience filters ("vip customers active this month"). Optional: point `AI_BASE_URL` at a local model such as Ollama for richer writing, also free |
| **Failover** | `SMTP_URL_FALLBACK`: if the main provider is down or throttling, mail goes through the second one; a dead primary is skipped for 60 s |
| UX | Review-and-send dialog (audience, spam score, issues), command palette (Ctrl/Cmd+K), dark mode, Ctrl+S |
| **Preflight** | Blocks sending on: missing postal address, URL shorteners, image-only mail, fake `Re:`, free-mail From address, spam score 7+, unverified domain |
| Sending | Redis/BullMQ queue, rate limit, retries with backoff, idempotent (nobody gets an email twice), engaged contacts go first |
| Deliverability | `List-Unsubscribe` + one-click POST headers, plain-text part, SPF/DKIM/DMARC checker, per-domain warm-up caps, daily and monthly quotas |
| Safety | Auto-pause when complaints pass 0.1% or bounces pass 5% (fed by SES or Brevo webhooks), suppression list enforced at import, send and signup |
| Tracking | Open pixel, signed click links (no open redirect), unsubscribe page, SES bounce/complaint webhooks |
| Billing | Free/Starter/Growth/Pro plans, quota enforcement, Razorpay subscriptions + signed webhook |
| Admin | `GET /admin/tenants`, `POST /admin/tenants/:id/approve`, `POST /admin/tenants/:id/suspend` with header `x-admin-key` |

## Go live checklist

1. Set the production env vars in `.env.example`. The app refuses to start in production with the default secrets.
2. **Amazon SES** (Mumbai `ap-south-1`): verify your domain with Easy DKIM, request production access, create SMTP credentials, put them in `SMTP_URL`.
3. **Bounces and complaints**: in SES create a configuration set with an SNS topic for Bounce, Complaint, Delivery. Subscribe `https://YOUR_HOST/webhooks/ses` (it confirms itself). Without this, bad addresses are never removed and your reputation will fall.
3b. **Brevo instead of SES** (free): set `SMTP_URL` to Brevo's relay, set `BREVO_WEBHOOK_SECRET`, and in Brevo add a transactional webhook to `https://YOUR_HOST/webhooks/brevo?token=THE_SECRET` with delivered, soft bounce, hard bounce, invalid email, blocked, spam and unsubscribed ticked. Each email carries an `X-Mailin-custom` header that Brevo sends back, which is how events are matched to messages.
4. **DNS** for your sending subdomain: SPF, the 3 DKIM CNAMEs, DMARC `p=none` first. Check them in the Domains page.
5. **Razorpay**: create 3 monthly plans, paste their ids into `plans.razorpay_plan_id`, add the webhook `https://YOUR_HOST/webhooks/razorpay` for the `subscription.*` events.
6. Put it behind HTTPS (Caddy/Nginx/Cloudflare). `BASE_URL` must be the https address because tracking and unsubscribe links use it.
7. Approve new tenants manually: `curl -X POST -H "x-admin-key: $ADMIN_KEY" -H "content-type: application/json" -d '{"daily_send_cap":2000}' https://YOUR_HOST/admin/tenants/<id>/approve`
8. Warm up: start with small, engaged lists. Caps ramp 50, 100, 250, 500, 1000... per day after a domain is verified.

## Not built yet (next phases)

Outgoing webhooks, automatic A/B winner rollout, image upload/hosting, team roles and 2FA, Shopify/WooCommerce connectors, SMS/WhatsApp, inbox-placement seed testing, Google Postmaster integration, ClickHouse for events at scale, AI copy/agent, MCP server, multi-ESP failover.

## Good to know

- **Journeys**: editing steps of a journey while people are inside shifts their position, so editing is blocked until you pause it. Each person enters a journey only once.
- **Smart send time** keeps messages queued for up to 24 h. Pausing and resuming a campaign sends the held messages immediately.
- **MCP / AI safety**: the agent works through the same API as the dashboard, so quotas, preflight, suppression and plan limits all still apply. Use a read-only key to let an agent look without being able to change anything.
- **Failover** mail from the second provider is not matched by the SES bounce webhook. Give that provider its own webhook if you rely on it for volume.

## Layout

```
src/server.js     express app, security headers      src/worker.js   queue consumer + circuit breaker
src/api.js        authenticated REST API            src/public.js   tracking, unsubscribe, signup pages
src/webhooks.js   SES + Razorpay                    src/admin.js    operator endpoints
src/automations.js journeys API                     src/v1.js       public API (keys)
src/mcp.js        MCP server                        src/ai.js       AI help
src/lib/          preflight, render, validate, limits, tokens, mailer, segment, audience, campaign-send
public/editor.js  visual email builder
db/schema.sql     Postgres schema                   public/         dashboard (no build step)
```
