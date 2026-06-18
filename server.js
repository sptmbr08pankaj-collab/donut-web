/*
 * DigiStay Donut — hosted web app backend (shared-password login).
 *
 * Serves the Donut frontend (public/index.html) and exposes POST /api/mcp,
 * which the frontend's window.cowork shim calls. The gateway emulates the same
 * "MCP tool" calls against the real Zoho Books, HubSpot and Razorpay APIs using
 * ONE shared set of server-side credentials — so the whole team sees the same data.
 *
 * Access: a single shared password (APP_PASSWORD). On login the user also enters
 * their name, used only for "Prepared by" attribution and the POC dashboard.
 *
 * All secrets come from environment variables (see .env.example / README).
 */
"use strict";
const express = require("express");
const session = require("express-session");
const path = require("path");
const crypto = require("crypto");

const {
  PORT = 8080,
  BASE_URL = "http://localhost:8080",
  SESSION_SECRET = crypto.randomBytes(24).toString("hex"),
  APP_PASSWORD, // the single shared team password
  ALLOWED_DOMAIN = "digistay.ai",
  // Zoho
  ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_ORG_ID, ZOHO_DC = "in",
  // HubSpot private-app token
  HUBSPOT_TOKEN,
  // Razorpay
  RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET,
} = process.env;

// Connector "server ids" exactly as hard-coded in the Donut frontend.
const ZOHO_PREFIX = "mcp__902e601b-7e82-446d-8ccc-4b7ce715944b";
const HUBSPOT_PREFIX = "mcp__ebbfa203-0d0b-44fa-aae0-a87358d0fb66";
const RAZORPAY_PREFIX = "mcp__f194d9b7-4a73-4b66-9f3b-87d17c296d4c";

const ZOHO_API = `https://www.zohoapis.${ZOHO_DC}/books/v3`;
const ZOHO_BILLING = `https://www.zohoapis.${ZOHO_DC}/billing/v1`;
const ZOHO_ACCOUNTS = `https://accounts.zoho.${ZOHO_DC}`;

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false }));
app.set("trust proxy", 1);
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: BASE_URL.startsWith("https"), maxAge: 12 * 3600 * 1000 },
}));

/* --------------------------- Shared-password auth --------------------------- */
function passwordOk(input) {
  const a = Buffer.from(String(input || ""));
  const b = Buffer.from(String(APP_PASSWORD || ""));
  if (!APP_PASSWORD || a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch (e) { return false; }
}
function loginPage(err) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Donut — Sign in</title>
<style>body{margin:0;font:15px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f6f7f9;color:#0f172a;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:16px;box-shadow:0 24px 60px rgba(15,23,42,.12);max-width:380px;width:92%;padding:26px}
h1{font-size:20px;margin:0 0 4px}.sub{color:#64748b;font-size:13px;margin-bottom:16px}
label{font-size:12px;color:#64748b;display:block;margin:10px 0 4px}
input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #e2e8f0;border-radius:9px;font:inherit}
button{width:100%;margin-top:16px;padding:11px;border:0;border-radius:9px;background:#0f766e;color:#fff;font-weight:700;font-size:15px;cursor:pointer}
.err{background:#fef2f2;color:#991b1b;border:1px solid #fecaca;border-radius:9px;padding:8px 10px;font-size:13px;margin-bottom:10px}</style></head>
<body><form class="card" method="POST" action="/login">
<h1>🍩 Donut</h1><div class="sub">DigiStay quotation builder &amp; performance dashboard.</div>
${err ? '<div class="err">' + err + "</div>" : ""}
<label>Your name <span style="color:#94a3b8">(for "Prepared by" &amp; reports)</span></label>
<input name="name" placeholder="e.g. Pankaj Chamoli" autocomplete="name">
<label>Team password</label>
<input name="password" type="password" placeholder="Shared team password" autocomplete="current-password" autofocus required>
<button type="submit">Sign in</button>
</form></body></html>`;
}
app.get("/login", (req, res) => res.send(loginPage("")));
app.post("/login", (req, res) => {
  if (!passwordOk(req.body.password)) return res.status(401).send(loginPage("Wrong password. Try again."));
  const name = String(req.body.name || "").trim().slice(0, 80) || "DigiStay Team";
  req.session.user = { name, email: "team@" + ALLOWED_DOMAIN };
  res.redirect("/");
});
app.get("/logout", (req, res) => { req.session.destroy(() => res.redirect("/login")); });
app.get("/api/me", (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: "not signed in" });
  res.json(req.session.user);
});
function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "not signed in" });
  return res.redirect("/login");
}

/* ----------------------------- Zoho Books ----------------------------- */
let _ztok = { token: "", exp: 0 };
async function zohoToken() {
  if (_ztok.token && Date.now() < _ztok.exp - 60000) return _ztok.token;
  const p = new URLSearchParams({ refresh_token: ZOHO_REFRESH_TOKEN || "", client_id: ZOHO_CLIENT_ID || "", client_secret: ZOHO_CLIENT_SECRET || "", grant_type: "refresh_token" });
  const r = await fetch(`${ZOHO_ACCOUNTS}/oauth/v2/token`, { method: "POST", body: p });
  const d = await r.json();
  if (!d.access_token) throw new Error("Zoho token refresh failed: " + JSON.stringify(d));
  _ztok = { token: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000 };
  return _ztok.token;
}
// Zoho Billing (Subscriptions) — plans/add-ons/coupons catalog. Uses the same OAuth
// token (the refresh token must carry the ZohoSubscriptions scope) plus the org header.
async function billing(op, args) {
  const qp = args.query_params || {}, pv = args.path_variables || {};
  let path = "", method = "GET";
  switch (op) {
    case "list_plans": path = "/plans"; break;
    case "list_addons": path = "/addons"; break;
    case "list_coupons": path = "/coupons"; break;
    case "get_plan": path = "/plans/" + pv.plan_code; break;
    default: throw new Error("Unsupported Billing op: " + op);
  }
  const q = new URLSearchParams();
  Object.keys(qp).forEach((k) => { if (qp[k] != null) q.set(k, typeof qp[k] === "object" ? JSON.stringify(qp[k]) : String(qp[k])); });
  const url = ZOHO_BILLING + path + (q.toString() ? "?" + q.toString() : "");
  const headers = {
    Authorization: "Zoho-oauthtoken " + (await zohoToken()),
    "X-com-zoho-subscriptions-organizationid": ZOHO_ORG_ID || "",
  };
  const r = await fetch(url, { method, headers });
  return await r.json();
}

async function zoho(op, args) {
  if (op.startsWith("billing_")) return billing(op.slice("billing_".length), args);
  const qp = args.query_params || {}, body = args.body || {}, pv = args.path_variables || {};
  let path = "", method = "GET";
  switch (op) {
    case "list_items": path = "/items"; break;
    case "list_estimates": path = "/estimates"; break;
    case "get_estimate": path = "/estimates/" + pv.estimate_id; break;
    case "create_estimate": path = "/estimates"; method = "POST"; break;
    case "update_estimate": path = "/estimates/" + pv.estimate_id; method = "PUT"; break;
    case "delete_estimate": path = "/estimates/" + pv.estimate_id; method = "DELETE"; break;
    case "list_invoices": path = "/invoices"; break;
    case "list_contacts": path = "/contacts"; break;
    case "get_contact": path = "/contacts/" + pv.contact_id; break;
    case "create_contact": path = "/contacts"; method = "POST"; break;
    case "get_organization": path = "/organizations/" + (pv.organization_id || qp.organization_id || ZOHO_ORG_ID); break;
    case "list_users": path = "/users"; break;
    default: throw new Error("Unsupported Zoho op: " + op);
  }
  const q = new URLSearchParams();
  Object.keys(qp).forEach((k) => { if (qp[k] != null) q.set(k, typeof qp[k] === "object" ? JSON.stringify(qp[k]) : String(qp[k])); });
  if (!q.get("organization_id") && ZOHO_ORG_ID) q.set("organization_id", ZOHO_ORG_ID);
  const url = ZOHO_API + path + "?" + q.toString();
  const headers = { Authorization: "Zoho-oauthtoken " + (await zohoToken()) };
  let fetchBody;
  if (method === "POST" || method === "PUT") {
    const fd = new URLSearchParams(); fd.set("JSONString", JSON.stringify(body)); fetchBody = fd;
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  const r = await fetch(url, { method, headers, body: fetchBody });
  return await r.json();
}

/* ------------------------------ HubSpot ------------------------------- */
function hsHeaders() { return { Authorization: "Bearer " + (HUBSPOT_TOKEN || ""), "Content-Type": "application/json" }; }
function mapAssoc(objectType, assocs) {
  const typeId = objectType === "notes" ? 202 : 1;
  return (assocs || []).map((a) => ({ to: { id: a.targetObjectId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: typeId }] }));
}
async function hubspot(op, args, sessionUser) {
  if (op === "get_user_details") {
    const parts = String((sessionUser && sessionUser.name) || "DigiStay Team").trim().split(/\s+/);
    return { userInformation: { email: (sessionUser && sessionUser.email) || ("team@" + ALLOWED_DOMAIN), firstName: parts.shift() || "DigiStay", lastName: parts.join(" "), ownerId: "" } };
  }
  if (op === "search_crm_objects") {
    const ot = args.objectType || "contacts";
    const r = await fetch(`https://api.hubapi.com/crm/v3/objects/${ot}/search`, { method: "POST", headers: hsHeaders(), body: JSON.stringify({ query: args.query || "", limit: args.limit || 10, properties: args.properties || [] }) });
    return await r.json();
  }
  if (op === "search_owners") {
    let owners = [], after;
    do {
      const u = new URL("https://api.hubapi.com/crm/v3/owners");
      u.searchParams.set("limit", "100"); if (after) u.searchParams.set("after", after);
      const r = await fetch(u, { headers: hsHeaders() }); const d = await r.json();
      (d.results || []).forEach((o) => owners.push({ ownerId: o.id, name: ((o.firstName || "") + " " + (o.lastName || "")).trim() || o.email || "", email: o.email, isActive: !o.archived }));
      after = d.paging && d.paging.next && d.paging.next.after;
    } while (after);
    if (args.ownerIds && args.ownerIds.length) { const set = new Set(args.ownerIds.map(String)); owners = owners.filter((o) => set.has(String(o.ownerId))); }
    else if (args.searchQuery) { const qq = String(args.searchQuery).toLowerCase(); owners = owners.filter((o) => String(o.name || "").toLowerCase().includes(qq) || String(o.email || "").toLowerCase().includes(qq)); }
    return { owners, hasMore: false, offset: 0 };
  }
  if (op === "manage_crm_objects") {
    const out = { results: [] };
    for (const o of (args.createRequest && args.createRequest.objects) || []) {
      const ot = o.objectType || "contacts"; const bodyObj = { properties: o.properties || {} };
      if (o.associations) bodyObj.associations = mapAssoc(ot, o.associations);
      const r = await fetch(`https://api.hubapi.com/crm/v3/objects/${ot}`, { method: "POST", headers: hsHeaders(), body: JSON.stringify(bodyObj) });
      out.results.push(await r.json());
    }
    for (const o of (args.updateRequest && args.updateRequest.objects) || []) {
      const ot = o.objectType || "contacts";
      const r = await fetch(`https://api.hubapi.com/crm/v3/objects/${ot}/${o.objectId}`, { method: "PATCH", headers: hsHeaders(), body: JSON.stringify({ properties: o.properties || {} }) });
      out.results.push(await r.json());
    }
    return out;
  }
  throw new Error("Unsupported HubSpot op: " + op);
}

/* ------------------------------ Razorpay ------------------------------ */
async function razorpay(op, args) {
  const auth = "Basic " + Buffer.from((RAZORPAY_KEY_ID || "") + ":" + (RAZORPAY_KEY_SECRET || "")).toString("base64");
  if (op === "fetch_all_payments") {
    const u = new URL("https://api.razorpay.com/v1/payments"); const a = args || {};
    ["count", "skip", "from", "to"].forEach((k) => { if (a[k] != null) u.searchParams.set(k, a[k]); });
    const r = await fetch(u, { headers: { Authorization: auth } });
    return await r.json();
  }
  throw new Error("Unsupported Razorpay op: " + op);
}

/* --------------------------- Gateway endpoint -------------------------- */
app.post("/api/mcp", requireAuth, async (req, res) => {
  try {
    const { name, args } = req.body || {};
    if (!name) throw new Error("missing tool name");
    let data;
    if (name.startsWith(ZOHO_PREFIX)) data = await zoho(name.slice(ZOHO_PREFIX.length + 2), args || {});
    else if (name.startsWith(HUBSPOT_PREFIX)) data = await hubspot(name.slice(HUBSPOT_PREFIX.length + 2), args || {}, req.session.user);
    else if (name.startsWith(RAZORPAY_PREFIX)) data = await razorpay(name.slice(RAZORPAY_PREFIX.length + 2), (args && (args.query_params || args)) || {});
    else throw new Error("Unknown tool: " + name);
    res.json(data);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

/* --------------------------- Static frontend --------------------------- */
app.use(requireAuth, express.static(path.join(__dirname, "public")));
app.get("*", requireAuth, (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`Donut web running on ${BASE_URL} (port ${PORT})`));
