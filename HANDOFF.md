# DigiStay Donut — Project Hand-off

> Single-file knowledge base for the **Donut** web app: what it is, how it's built, how to run/deploy it, every integration quirk we hit, and what's still pending. If you're picking this up cold, read this top to bottom once.

Last updated: 2026-06-26.

---

## 1. What Donut is

A browser app for the DigiStay sales/ops team with three tools in one page:

1. **🧾 Quote Builder** — build a quotation (plan + add-ons + services), push it to **Zoho Billing** as an estimate (Quote or Subscription Quote), log a note to the customer's **HubSpot** contact, generate a **payment link**, and mark it paid.
2. **📊 Performance** — POC sales dashboard from Zoho data (quoted/accepted/realized/outstanding, leaderboard, by-POC, plans/add-ons, AOV).
3. **📞 HubSpot** — sales-team activity dashboard (leads assigned/contacted, stuck-lead tracker, by-POC, leaderboard, deals).

No API keys ever reach the browser — every data call is proxied through the backend, which signs it with shared server-side credentials.

---

## 2. Architecture

```
Browser (public/index.html, vanilla JS)
   │  window.cowork.callMcpTool(name,args)   ← thin shim, top of index.html
   ▼  POST /api/mcp  {name, args}
server.js  (Express gateway)
   │  routes by connector-id PREFIX in `name`
   ├─ ZOHO_PREFIX     → zoho()      → https://www.zohoapis.in/billing/v1/...
   ├─ HUBSPOT_PREFIX  → hubspot()   → https://api.hubapi.com/crm/v3|v4/...
   └─ RAZORPAY_PREFIX → razorpay()  → Razorpay REST
```

- **Frontend** is one big `public/index.html` — three independent `<script>` IIFEs (Quote Builder, Performance, HubSpot). **Functions are NOT shared across IIFE scopes** — re-declare helpers per scope (this has caused several "X is not defined" bugs).
- **Backend** `server.js` — shared-password login, session, and the `/api/mcp` gateway. It maps the connector "server id" prefix in the tool name to the right API and injects credentials.
- The tool names look like `mcp__<connector-id>__<op>` so the same frontend can run either as a Cowork artifact (real connectors) or on the web (server gateway). On the web, the gateway implements the ops.

### Connector prefixes (in `server.js`)
| Prefix const | Connector id | Service |
|---|---|---|
| `ZOHO_PREFIX` | `mcp__902e601b-7e82-446d-8ccc-4b7ce715944b` | Zoho |
| `HUBSPOT_PREFIX` | `mcp__ebbfa203-0d0b-44fa-aae0-a87358d0fb66` | HubSpot |
| `RAZORPAY_PREFIX` | `mcp__f194d9b7-4a73-4b66-9f3b-87d17c296d4c` | Razorpay |

> There is also a connected **Zoho Billing MCP server** `mcp__11b329f3-fb02-4354-b045-c7833058971b` used for admin cleanup (deletes) — see Gotchas.

---

## 3. Repo layout

```
donut-web/
├─ server.js           backend: login + /api/mcp gateway (zoho/hubspot/razorpay)
├─ package.json        node>=18, deps: express, express-session. start: node server.js
├─ README.md           original setup notes
├─ HANDOFF.md          ← this file
├─ .env                local secrets (git-ignored — NEVER commit)
└─ public/
   └─ index.html       the entire Donut SPA (HTML + CSS + JS, 3 views)
```

---

## 4. Hosting & deployment

- **GitHub:** `git@github.com:sptmbr08pankaj-collab/donut-web.git` (SSH key set up on this Mac, email `sptmbr08.pankaj@gmail.com`). Branch: `main`.
- **Host:** Render (Node web service). Build `npm install`, start `npm start`.
- **Deploy = push to `main`.** Render auto-deploys on push. (For a docs-only change like this file, Render still redeploys but runtime is unchanged.)
- After the **first** deploy, set `BASE_URL` to the Render URL. **Do NOT set `PORT`** — Render provides it.

### Environment variables (set in Render → Environment)
| Var | Notes |
|---|---|
| `APP_PASSWORD` | shared team password. Currently `This1s@Password`. |
| `SESSION_SECRET` | random string. |
| `ALLOWED_DOMAIN` | `digistay.ai`. |
| `BASE_URL` | the Render URL (after first deploy). |
| `ZOHO_CLIENT_ID` / `ZOHO_CLIENT_SECRET` / `ZOHO_REFRESH_TOKEN` | Zoho self-client OAuth. |
| `ZOHO_ORG_ID` | `60062278723` (Openquest Tech Pvt Ltd). |
| `ZOHO_DC` | `in`. |
| `HUBSPOT_TOKEN` | HubSpot Private App token (`pat-na2-…`). |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | optional (payment links can also come from Zoho). |

> The real values live in the local `.env` (git-ignored) and in Render's env. **If you rotate the Zoho refresh token, update it in Render too** or the deployed app gets Zoho `code 57`.

---

## 5. Integrations & credentials

### Zoho — **Billing** (not Books)
- The org uses **Zoho Billing**, not Books. Books is disabled (error 6018). Everything (catalog, customers, estimates, invoices, payments, payment links) goes through **`/billing/v1/...`** with header `X-com-zoho-subscriptions-organizationid: <ORG_ID>` and a JSON body.
- **OAuth scope must be `ZohoSubscriptions.fullaccess.all`** (NOT `ZohoBilling` — that's invalid). Token via `api-console.zoho.in` → Self Client.
- Org `60062278723`, DC `in`, finance@digistay.ai.
- **Estimates = quotes.** Subscription quote = `estimate_type=new_subscription` + `interval_unit`. Payment links via `/billing/v1/paymentlinks`.

### HubSpot — Private App token
- CRM v3 (search/objects/batch) + v4 (associations). Custom props used: `hubspot_owner_assigneddate`, `hs_call_disposition`, `hs_lead_status`, `date_entered_in_*`, `notes_last_contacted`.
- **Missing scope:** `crm.objects.deals.read` is NOT granted on the app token, so `/deals` returns 403. Deals metrics are built but disabled until this scope is added (Settings → Integrations → Private Apps → Scopes).

### Razorpay
- Optional. Payment links can be created via Zoho Billing instead.

---

## 6. Auth model

- **Hosted gate:** `server.js` `/login` requires the shared `APP_PASSWORD` + the person's **name** (used for "Prepared by" / POC attribution). Session cookie. All routes behind `requireAuth`.
- Because everyone shares one password, the tool trusts the name typed. The HubSpot dashboard additionally restricts itself to the **Sales team** names (see §10).
- The frontend also contains a HubSpot/Zoho identity-check path (used when run as a Cowork artifact). In the hosted version the shared password is the real gate.

---

## 7. Quote Builder — business rules (the important ones)

All in the first `<script>` IIFE in `index.html`. Key function: **`pushToZoho(q, markSent)`**.

- **Mandatory before save/send (`quoteReady()`):** a **customer must be selected** (name) AND **at least one** plan/add-on/service line. Email & phone are **NOT** required (we removed that). Nothing is saved (not even a draft) or sent to Zoho until both are met.
- **Quote vs Subscription Quote:**
  - **Any plan in the cart → Subscription Quote** (`estimate_type=new_subscription`), with or without add-ons/services.
  - **Add-ons / services only (no plan) → regular Quote.**
  - On a draft whose type flips between saves, the estimate is **recreated** (Zoho can't flip `estimate_type` on update).
- **Discounts:**
  - **Regular Quote:** custom % discount (entity-level) — the typed-% bar. % must match an approved Zoho coupon's percentage (1–30%, exact, no rounding).
  - **Subscription Quote:** Zoho rejects custom discounts — discount is applied as the **coupon** picked in the coupon dropdown (`coupon_code`). The typed-% bar does NOT push to subscriptions. If the coupon isn't tied to the plan, the quote still saves (without the coupon) and the POC is warned.
- **Reference#:** the Donut quote number is **NOT** sent to Zoho's Reference# field (sent blank).
- **Payment mode:** every estimate is created with `auto_collect:false` ("collect payment offline" ticked).
- **Place of supply:** synced to the Zoho customer on save/send (from quote state → PIN/City/GSTIN-derived).
- **Sync targets:** Save → Zoho draft (+ optional HubSpot note). Send via Zoho → emails the estimate; if Zoho can't email (no email), it copies a shareable estimate link.

### Catalog (plans / add-ons / coupons)
- Built **live from Zoho Billing** (`fetchBillingCatalog` → `buildCatalog`/`refreshCatalogLive`). Auto-refreshes on load and every 5 min. Cache key: **`digistay_catalog_v12_billing`** (bump the version to force-drop stale caches).
- **Blocklist (`BLOCKED_CATALOG`)** — permanently hidden plans/add-ons/services, hyphen/space-insensitive, applied on every refresh: *Pro quarterly, Core Quarter, Quarterly Plan, Connect Quarter, Connect Half Yearly, Connect Yearly, Half-Yearly Plan, Annual Plan, Core Half Yearly, Core Yearly, Custom Website.* (Similarly-named `DigiStay Connect*` plans are NOT affected — exact name match.)
- **Add-on ↔ plan association:** add-ons in Zoho are plan-scoped (`applicable_to_all_plans` + `plans[]`). The catalog stores `allPlans` + `planCodes`; once a plan is in the cart, the Add-ons list shows **only add-ons associated with that plan** (helpers `planCodeOf` / `addonForPlan` / `catAddonOf`). This prevents the "selected addon is not associated with the plan" error.
- **Room-license add-ons** are tier+term specific (`ROOM_ADDON_ID`), auto-added based on room count vs plan's included rooms.

---

## 8. Performance Dashboard (📊)

Second `<script>` IIFE; left **collapsible sidebar** layout (Summary / Leaderboard / By POC / Outstanding / Plans / Add-ons / Avg order value).
- ₹ everywhere. POCs split into **Active** vs **Ex-employees**; "Ajitesh Kashyap" duplicates merged; "Shreya Jindal" (not "Shreya Gupta").
- **AOV** = total quoted ÷ distinct customers.
- **Accepted/invoiced value** bucketed by **acceptance date** (`accepted_date`), not quote date.
- **Realized revenue** from Zoho payments, attributed to the POC via invoice salesperson → customer+amount → customer's latest accepted quote.
- **Outstanding** = accepted invoiced − realized (Zoho invoice `balance`; invoices have `invoice_date`, not `date`).
- Clickable KPIs / leaderboard / By-POC drill-downs. **Manual outstanding adjustments are local only (localStorage) and must NEVER sync to Zoho** (explicit user constraint).
- Notification bell lists payments received (link or manual).

---

## 9. (reserved)

---

## 10. HubSpot Dashboard (📞)

Third `<script>` IIFE; same left-sidebar layout. **Restricted to the Sales team** (data + access): **Abhinav Gupta, Ajitesh Kashyap, Shreya Jindal, Pankaj Chamoli.** Routes through the server gateway using the **app `HUBSPOT_TOKEN`**.

- **Contacts:** leads assigned (by `hubspot_owner_assigneddate`, not create date), contacted (≥1 outbound call via call→contact assoc), attempts, dispositions, lead-status, by-agent, day/month trend. Granularity drives period options (Day→today/yesterday/this/last week; Month→month ranges).
- **🚨 Stuck leads:** open leads idle ≥3 days (`STUCK_DAYS`) in Unassigned / New / Demo Pending / Demo Conducted. Red count badge on the sidebar item; per-status cards + table; each row/card links to the HubSpot record. Snapshot (ignores period). Idle = days since last activity (`notes_last_contacted`/`notes_last_updated`, fallback `createdate`).
- **By POC** + **Leaderboard:** leads assigned/touched, demos conducted, converted, deals created (shared `pocAgg()`). Demos = `date_entered_in_demo_done`, conversions = `date_entered_in_converted`, within the selected period.
- **Deals:** disabled until the `crm.objects.deals.read` scope is added — then the "deals created" column/card light up automatically.

### HubSpot data facts
- `hs_lead_status` values: NEW, Prospected, Demo Pending, Demo Rejected, Demo No-Show, Demo Conducted, Not Prospect, Cold, Nurture, CONVERTED.
- **"Unassigned" is not a status** — it means no `hubspot_owner_id`. Genuine unassigned open leads = no owner + `lifecyclestage='lead'` + status `NOT_IN` the dead/converted set.
- Stage-entry date props: `date_entered_in_new`, `date_entered_in_demo_pending`, **`date_entered_in_demo_done`** (= Demo Conducted; note `_demo_done`, not `_demo_conducted`), `date_entered_in_converted`.
- HubSpot `NOT_IN` filter **includes** records that have no value for the property (confirmed).

---

## 11. Gotchas & learnings (read before changing Zoho behavior)

1. **Books is dead — use Billing.** `/billing/v1/...`, scope `ZohoSubscriptions.fullaccess.all`, org header required.
2. **The API token user CANNOT delete estimates/customers** (error 104003). For cleanup use the connected **Zoho Billing MCP** `mcp__11b329f3-…` → `Delete_a_Quote` / `Delete_a_Customer`.
3. **Subscription estimates reject custom discounts** — only coupons. Editing a Donut sub-quote that had a custom discount throws "cannot apply a coupon and custom discount to a subscription." → we apply discounts on subscriptions as `coupon_code`.
4. **Coupons are POC-specific + plan-scoped.** The coupon LIST has no plan-association field (needs per-coupon calls). Many coupons share a %. Auto-mapping a typed % to the right coupon is unreliable → discounts on subscriptions come from the coupon dropdown, not the % bar. Create API accepts `coupon_code`; error `113022` if the coupon isn't tied to the plan/add-on.
5. **Add-ons are plan-scoped** (`applicable_to_all_plans` + `plans[]`). Mismatched add-on+plan → "selected addon is not associated with the plan." → catalog filters add-ons by the in-cart plan.
6. **`estimate_type` can't be flipped on update** — recreate the draft when the Quote/Subscription type changes.
7. **`pushToZoho` retry ladder (`writeEstimate`):** coupon-not-associated → drop coupon & save; line not a valid subscription item / 8009 / addon-not-associated → fall back to a regular Quote. So saves never hard-fail.
8. **Subscription line items** need the Billing plan/addon `item_id`; ad-hoc/custom lines can't live in a subscription estimate (8009 "standalone vs subscription items").
9. **Invoice date field is `invoice_date`, not `date`** (which is null) — used for Outstanding.
10. **HubSpot deals 403** — app token lacks `crm.objects.deals.read`.
11. **Manual outstanding adjustments stay local** — never push to Zoho.
12. **Catalog cache key** — bump `CAT_KEY` (`digistay_catalog_v##_billing`) whenever the catalog shape or blocklist changes, so old caches are dropped.

---

## 12. Local development & testing

- No system Node / Homebrew on this Mac. Use the standalone build at `/tmp/node-v20.18.1-darwin-x64/bin` (re-download if `/tmp` was cleaned:
  `curl -sL https://nodejs.org/dist/v20.18.1/node-v20.18.1-darwin-x64.tar.gz | tar xz -C /tmp`).
- Load env for API tests: `set -a; . ./.env; set +a`.
- **Syntax-check the inline JS** (the file is one big HTML) before committing:
  ```bash
  /tmp/node-v20.18.1-darwin-x64/bin/node -e '
  const fs=require("fs"),vm=require("vm");const h=fs.readFileSync("public/index.html","utf8");
  const re=/<script\b[^>]*>([\s\S]*?)<\/script>/g;let m,i=0,ok=true;
  while((m=re.exec(h))){i++;const c=m[1];if(!c.trim())continue;try{new vm.Script(c,{filename:"s#"+i});}catch(e){ok=false;console.log("ERR s#"+i,e.message);}}
  console.log(ok?"All "+i+" OK":"FAILED");'
  ```
- Get a Zoho access token for API probing:
  ```bash
  curl -s -X POST "https://accounts.zoho.in/oauth/v2/token" \
    -d "refresh_token=$ZOHO_REFRESH_TOKEN&client_id=$ZOHO_CLIENT_ID&client_secret=$ZOHO_CLIENT_SECRET&grant_type=refresh_token"
  ```
  then call `https://www.zohoapis.in/billing/v1/{plans,addons,coupons,estimates}` with `Authorization: Zoho-oauthtoken <t>` and the org header.

---

## 13. Deploy checklist

1. Make the change in `public/index.html` or `server.js`.
2. Syntax-check inline JS (above).
3. `git add … && git commit && git push origin main`.
4. Render auto-deploys. Confirm env vars are present (esp. a current `ZOHO_REFRESH_TOKEN`).
5. In the app: hard-refresh; if catalog looks stale, the `CAT_KEY` bump or a manual "Rebuild catalog" forces a fresh pull.

---

## 14. Pending / backlog

- **HubSpot Deals** — add `crm.objects.deals.read` scope to the Private App → deals-created metrics + Sales→AM movement + lead→deal TAT light up.
- **GST registered-name autofill** from GSTIN — needs an external GST API key.
- (Nice-to-have) Per-person identity instead of shared password (Google SSO) for true POC attribution.

---

## 15. Key files & symbols quick-map

| Need to change… | Look at |
|---|---|
| How estimates are created/updated, Quote vs Subscription, discounts, coupons | `pushToZoho` / `writeEstimate` / `makeBody` in `index.html` |
| Save/send validation | `quoteReady`, `saveQuote`, `emailQuote`, `syncExternal` |
| Catalog source / blocklist / associations | `fetchBillingCatalog`, `BLOCKED_CATALOG`, `catBlocked`, `addonForPlan`, `CAT_KEY` |
| Add-on/plan/service UI | `renderWizard`, `renderCatBlocks`, `addPlan`, `addAddon`, `addService` |
| Performance dashboard | second IIFE (`#view-dashboard`) |
| HubSpot dashboard | third IIFE (`#view-hubspot`): `load`, `render`, `loadStuck`, `pocAgg`, `renderLeaderboard` |
| Backend gateway / new ops / credentials | `server.js` (`zoho`, `hubspot`, `razorpay`, `/api/mcp`) |
