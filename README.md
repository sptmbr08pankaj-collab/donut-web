# DigiStay Donut — hosted web app

The full Donut tool (quotation builder + POC performance dashboard) as a normal website your whole team opens in a browser. It talks to **one shared Zoho + HubSpot + Razorpay** account through a small backend, and is protected by a **single shared team password**.

No Claude / Cowork needed to use it. No API keys ever reach the browser.

```
donut-web/
├─ server.js          backend: shared-password login + /api/mcp gateway to Zoho/HubSpot/Razorpay
├─ package.json
├─ .env.example       all the secrets you provide (as host env vars)
└─ public/
   └─ index.html      the Donut app (unchanged) + a small shim pointing it at the backend
```

## How it works
The Donut app makes every data call through one function. On the website a shim sends that to `POST /api/mcp`; the backend signs the request with the shared Zoho/HubSpot/Razorpay credentials and returns the data. The login page asks for the shared password plus the person's **name**, which is used for "Prepared by" and the POC dashboard.

> Note: because everyone shares one password, the tool can't *prove* who's who — it trusts the name each person types. The per-POC dashboard still works as long as people enter their real name. For true per-person identity, switch back to Google sign-in (ask and I'll swap it in).

---

## 1. Get the credentials (one-time)

**Team password** — just pick a strong shared password and set it as `APP_PASSWORD` (below). Share it with the team. **Do not reuse your Google/Zoho admin password.**

**Zoho Books (shared login)** — go to `https://api-console.zoho.in` → *Self Client* → Create.
- Scope: `ZohoBooks.fullaccess.all`, generate a code, then exchange it for a **refresh token** (Zoho's self-client screen shows the curl, or use Postman). Keep `client_id`, `client_secret`, `refresh_token`.
- `ZOHO_ORG_ID` is already `60062278723` (your org). `ZOHO_DC=in`.
- Use a finance/ops Zoho login so estimates send from finance@ as today.

**HubSpot** — Settings → Integrations → **Private Apps** → Create. Scopes: contacts read/write, owners read, notes read/write. Copy the **token**.

**Razorpay** (optional) — Dashboard → Settings → API Keys → **Key ID + Secret**.

---

## 2. Deploy on Render (or Railway)

**Render**
1. Push this `donut-web` folder to a GitHub repo.
2. Render → **New → Web Service** → connect the repo.
3. Runtime **Node**, Build `npm install`, Start `npm start`.
4. Add every variable from `.env.example` under **Environment** (use the real values), including `APP_PASSWORD`. Set `BASE_URL` to the Render URL (e.g. `https://donut-xxxx.onrender.com`).
5. Deploy.
6. (Optional) Add a custom domain `donut.digistay.ai` and update `BASE_URL` to match.

**Railway** is the same idea: New Project → Deploy from repo → add the env vars → it gives you a URL → set `BASE_URL` to it.

---

## 3. Use it
Open the URL → enter your **name** + the **shared team password** → Donut loads. Share the URL **and the password** with the team; everyone reads/writes the same shared Zoho + HubSpot. To change who has access, change `APP_PASSWORD` and redeploy.

---

## Notes & limits
- **Saved quotes** are stored in each person's browser (localStorage), the same as the artifact. Every quote is still pushed to Zoho, which is the shared source of truth. (If you want a shared "my drafts across devices" list, that's a small add — a DB table — ask and I'll wire it.)
- **Sessions** use in-memory storage (fine for a single Render instance). If you scale to multiple instances, swap in a session store (Redis) — noted in `server.js`.
- **Zoho writes** are sent as `JSONString` form params (Zoho Books convention). If your Zoho edition rejects a write, check the Zoho API console scope.
- **Sender email**: estimates still send from whatever From-address your Zoho org default is set to (finance@), exactly as in the artifact.
- Keep all secrets in the host's env vars only — never commit real values.
