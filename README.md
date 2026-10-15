# Vehicle Portfolios

Digital vehicle packets for car dealerships (similar to iPacket), run as a **multi-dealership platform**.
Each store lives on its own subdomain, such as `nsbchevy.aiautoengine.com`. Each store's sender identity, customers,
message history and messaging costs are kept separate.

**Stack:** Cloudflare Pages (static site + Pages Functions) · Supabase (Postgres + Row Level Security, Auth, Storage) ·
Twilio (texting; one subaccount per dealership) · Resend (email; one verified domain per dealership) ·
Cloudflare Email Routing (inbound email replies).

There is no build step and no runtime npm dependencies.

---

## What's in it

| Area | What it does |
|---|---|
| **Customer portfolio** `/v/<vehicle>` | Phone-first page with photos, specs, highlights, documents, NHTSA recalls, the salesperson card, and a test-drive form with an optional, unchecked SMS consent box. Texted links show a photo and price preview. |
| **Open tracking** | Each customer gets a personal link. When they open it, the salesperson gets a text and an email. Every open is logged. Link-preview robots, refreshes, and staff viewing their own links don't count. |
| **Dealer dashboard** `/admin` | Vehicles (add by listing URL, VIN, HomeNet/vAuto feed, or by hand), photos, documents, QR window cards, sharing, **Inbox**, leads, staff, **Usage**, Settings → **Texting & email**. |
| **Inbox** | Two-way texts and emails with each customer. Shows delivery status (✓ sent, ✓✓ delivered, ⚠ failed), the consent timeline, the assigned salesperson, and a "Do not text" button. |
| **Leads** | Saved to the database and emailed to the store and the salesperson. Sent to **Elead as ADF/XML**. The salesperson also gets a text. |
| **Inventory** | HomeNet/vAuto CSV feed synced hourly, by HTTPS URL, relay upload, or manual upload. |
| **Platform console** `/platform` | For you: every dealership with usage, **provider cost, invoice and margin**; plan and allowance per dealership; **10DLC onboarding runner**; email domains; rate card. |

---

## How dealerships are kept separate

| | Per dealership | How it's enforced |
|---|---|---|
| **Texting identity** | Its own Twilio **subaccount**, Messaging Service, phone number, Secondary Customer Profile, 10DLC brand and campaign | `messaging_profiles`. Sends always use that dealership's subaccount credentials. |
| **Email identity** | Its own verified sending domain (`sales@mail.theirdealership.com`), or `Dealer Name via Vehicle Portfolios <slug@mail.aiautoengine.com>` until verified. Its own reply-to. | `messaging_profiles.email_*`, Resend Domains API |
| **Customers** | One record per dealership (the same person at two stores is two records). Opt-outs are per store. | Postgres RLS on `customers` |
| **Message history** | Every text and email, in or out, including staff alerts and CRM emails | RLS on `messages` |
| **Consent evidence** | Append-only. Nobody can edit or delete it. | `consent_records` has no update/delete policy |
| **Costs** | Each message is tagged with its dealership. Fixed fees go on a per-dealership ledger. | `messages`, `usage_charges` |
| **Credentials** | Subaccount auth tokens, encrypted with AES-GCM | `provider_credentials`. RLS is on with no policies, and table grants are revoked, so only the server can read it. |

Platform operators (rows in `platform_admins`) have support access to every dealership. Dealership admins and salespeople see only their own store.

---

## Texting: compliance built in

- **Consent before the first text.** A customer can be texted from the dealership number only when one of these is true:
  1. They checked the SMS box on a vehicle page. The record stores the exact wording, page URL, IP address and time.
  2. A salesperson confirmed the customer agreed. The record stores the staff member, login and time.
  3. The customer texted the dealership first (replies are allowed for 72 hours).
- **STOP / START / HELP.** Each dealership has its own Messaging Service, so Twilio's opt-out handling is per store.
  - STOP-type keywords (STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE, OPTOUT) record an opt-out and block further sends.
  - After STOP, staff **cannot** opt the customer back in. Only the customer can, by texting START (or ticking the box on a form). The database enforces this.
  - Twilio error 21610 (recipient opted out) is also recorded as an opt-out.
  - HELP replies are sent by the Messaging Service's opt-out settings, so customers don't get two replies.
- **First text includes "Reply STOP to opt out."**
- **Delivery status** arrives through signed Twilio callbacks. Status never goes backwards: a late "sent" can't overwrite "delivered". Error codes are shown in plain English.
- **Incoming replies are routed** to the assigned salesperson. If there isn't one, they go to whoever last sent that customer a portfolio, then whoever handled their lead, then the store's lead inbox. The salesperson gets a text and an email with the reply.
- **Every webhook is signature-checked.** Twilio requests are validated with that dealership's subaccount token. Resend uses Svix signatures. Inbound email uses a shared secret.
- **Public program terms** at `/sms-terms`, with a privacy section at `/sms-terms#privacy`. These are the URLs the 10DLC campaign registration requires.

## Email

- Customer emails come **from the dealership**, using its verified domain once DNS is set up. Until then they come from the platform domain, with the dealership's name.
- **Replies go back to the dealership.** The reply-to is `slug+customer@reply.aiautoengine.com`. The Email Worker logs the reply in that customer's conversation and forwards the original email to the salesperson, or to the store's reply address.
- One-click **unsubscribe** (RFC 8058 header plus footer link) and spam complaints both record an email opt-out.
- Staff notifications, lead emails and the Elead ADF copy are logged and costed too.

## Costs and the $995 subscription

Default rates are Twilio's published US long-code pricing and 10DLC fees, checked in October 2026. You can edit them under **Platform → Rates & plans**.

| Item | Your cost |
|---|---|
| Outbound SMS segment | $0.0083 + carrier fee ≈ $0.0035–$0.005 (avg $0.0045) → **≈ $0.0128** |
| Inbound SMS segment | $0.0083 + carrier fee ≈ $0.003 |
| Phone number | $1.15 / month |
| 10DLC Standard campaign | $10 / month (Low-Volume Mixed: $1.50) |
| Standard brand registration (incl. secondary vetting) | $46 one-time |
| Campaign vetting | $15 one-time |

**Example.** With the default plan of $995/month, 2,500 included text segments and 5,000 emails:
- A dealership that uses its whole allowance costs you about 2,500 × $0.0128 ≈ $32 in texts, plus $11.15 for the number and campaign, plus around $2 in email. That's about **$45 a month, leaving roughly $950 margin**.
- Onboarding costs about $61 one-time ($46 brand + $15 vetting). Consider charging it as a setup fee.

How cost is tracked:
- Each text gets an estimated cost when it's sent.
- The **real Twilio price** replaces the estimate after delivery. A daily reconcile also catches any that were missed.
- Phone number and campaign fees are booked once per month per dealership.

What each side sees:
- **You** see cost, invoice and margin per dealership.
- **Dealers** see their usage against the allowance on `/admin/usage`, but not your costs.

Per-dealership plan options:
- monthly fee
- included segments and emails
- overage rates
- whether to **pause texting at the allowance** or bill overage
- whether to pass phone number and 10DLC fees through to the dealer

---

## Deploy

### 1. Supabase
1. Create a project. In the **SQL Editor**, run these in order:
   - `supabase/migrations/0001_vehicle_portfolios.sql`
   - `supabase/migrations/0002_messaging_platform.sql`
   - `supabase/seed.sql`
2. **Authentication → Providers → Email:** turn off public sign-ups.
3. **URL Configuration:** set Site URL to `https://nsbchevy.aiautoengine.com` and add the redirect URL `https://*.aiautoengine.com/**`.
4. **Authentication → Users → Add user:** add yourself, then run:
   ```sql
   select public.vp_add_platform_admin('jthistle729@gmail.com');
   select public.vp_add_member('nsbchevy', 'jthistle729@gmail.com', 'owner');
   ```

### 2. Cloudflare Pages
1. Connect this repo: **Workers & Pages → Create → Pages**. Build command: *none*. Output directory: `public`.
2. Add the secrets and variables listed in `.dev.vars.example`. Generate `ENCRYPTION_KEY` with `openssl rand -base64 32` and **keep a copy**: losing it means every dealership's Twilio subaccount token has to be re-entered.
3. Add each dealership subdomain as a **custom domain** on the Pages project, starting with `nsbchevy.aiautoengine.com`.
4. Use the **Workers Paid** plan ($5/month). Feed syncs and the 10DLC runner need more than the free plan's 10 ms CPU per request.

### 3. Scheduled jobs
In `supabase/cron.sql`, replace `REPLACE_WITH_CRON_SECRET` with your secret and run it. It sets up:
- the hourly HomeNet/vAuto feed sync
- the daily cost reconcile and 10DLC status refresh

### 4. Twilio, one time for the platform
1. Upgrade your Twilio account (the **parent / ISV account**). Create and get approval for your **Primary Customer Profile** in Trust Hub. Put its `BU…` SID in `TWILIO_PRIMARY_CUSTOMER_PROFILE_SID`.
2. Staff alerts come from the platform, not the dealerships. They need **your own** brand and campaign (use case "Account Notification") on the parent account, plus a number in a Messaging Service. Put that in `TWILIO_PLATFORM_MESSAGING_SERVICE_SID`.

### 5. Email, one time for the platform
1. In Resend, verify `mail.aiautoengine.com` (this becomes `PLATFORM_EMAIL_DOMAIN`). Create an API key.
2. Add a webhook to `https://nsbchevy.aiautoengine.com/api/resend/webhook` for the delivered, bounced, complained and failed events. Put its signing secret in `RESEND_WEBHOOK_SECRET`.
3. For inbound replies:
   - Deploy `workers/email-inbound` (`npx wrangler deploy` in that folder, plus `wrangler secret put INBOUND_EMAIL_SECRET`).
   - In Cloudflare → aiautoengine.com → **Email Routing**, enable the `reply.aiautoengine.com` subdomain.
   - Add a catch-all rule that sends to the Worker.

---

## Onboarding a new dealership (runbook)

| Step | Who | Where | Notes |
|---|---|---|---|
| 1. Create dealership, invite the owner | You | Platform → **New dealership** | Starts on the default plan |
| 2. Add custom domain `slug.aiautoengine.com` | You | Cloudflare Pages | |
| 3. Business details for registration | Dealer admin or you | Settings → Texting & email | Legal name and **EIN must match IRS records**. Authorized rep, address, website. Use **Fill in suggested wording** for the campaign description, message flow, samples, consent and HELP text. |
| 4. Create subaccount + Messaging Service | You | Platform → dealership → **Texting setup** | Webhooks are set up automatically |
| 5. Start registration | You | same page | Runs the Twilio ISV API flow: Secondary Customer Profile → business info → authorized rep → address → link to your Primary profile → evaluate → submit → A2P profile → evaluate → submit → **brand**. If Twilio finds a problem, the runner stops and shows the reason. Fix the details and press **Retry**. |
| 6. Buy a local number | You | same page | Number rental is billed to the dealership's subaccount and booked on its ledger |
| 7. Brand review | TCR | — | Usually 1–3 days. **Check review status**, or let the daily job do it. When approved, the runner registers the **campaign** (use case MIXED, with privacy and terms URLs pointing to `/sms-terms`). |
| 8. Campaign review | Carriers | — | Often 1–3 weeks. When the campaign shows VERIFIED, **texting turns on automatically** for that dealership. |
| 9. Email domain | Dealer admin or you | Settings → Texting & email → **Your sending domain** | Add the DNS records shown, then press **Verify** |
| 10. Staff | Dealer admin | Staff | Mobile numbers and alert preferences. Invite logins. |
| 11. Elead + feed | Dealer admin | Settings → General | Elead ADF address, HomeNet/vAuto feed URL |

Customers can still be sent portfolio links **from the salesperson's own phone** ("Text from my phone") or by email while registration is in review.

If you register a dealership in the Twilio Console instead, paste the SIDs under **Texting setup → Registered in the Twilio Console instead?**. The daily job then tracks approval.

---

## Tests

```bash
bash tests/sql/run.sh                  # 96 checks: RLS isolation between stores, consent rules, credential secrecy, usage/billing math, feed sync
node --test tests/functions/*.test.js  # 48 tests: webhooks + signatures, STOP/START/HELP, routing, send gating, email identity,
                                       #           unsubscribe, Resend events, 10DLC runner, number purchase, reconcile, leads/ADF, feed
node tests/e2e/run.mjs                 # 46 browser checks: portfolio, consent box, terms page, dashboard, inbox, usage, settings, platform console
```

All provider calls in the tests are simulated. **Before the first live dealership**, run one onboarding end to end and watch the registration log. The Twilio ISV API flow follows Twilio's documented steps, but it hasn't been run against a live account yet.

## Security notes

- Provider secrets live only in Cloudflare secrets and in the encrypted `provider_credentials` table. The browser never sees them.
- All public writes (leads, tracking, webhooks) go through server functions using the service key. Clients can't insert messages, consent opt-outs, usage charges or billing changes.
- Dealership admins can edit business details and email settings, but a database trigger stops them from changing provider IDs, registration status or `sms_enabled`.
- If a feed relay token or `INBOUND_EMAIL_SECRET` leaks, rotate it.
