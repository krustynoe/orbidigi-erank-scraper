// index.js — eRank scraper estable (login Sanctum + JSON + fallback HTML)
globalThis.File = globalThis.File || class File {};

const express = require("express");
const { chromium, request } = require("playwright");
const cheerio = require("cheerio");

const app = express();
const port = process.env.PORT || 3000;

const EMAIL = (process.env.ERANK_EMAIL || "").trim();
const PASS  = (process.env.ERANK_PASSWORD || "").trim();

// UA + idioma coherentes con eRank
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";
const ACCEPT_LANG = "en-US,en;q=0.9";

// === Normalizador de país → ISO-2 ===
const COUNTRY_MAP = {
  US: "US", USA: "US", "UNITED STATES": "US", "UNITED-STATES": "US",
  UK: "UK", GB: "UK", "UNITED KINGDOM": "UK", "UNITED-KINGDOM": "UK",
  ES: "ES", SPAIN: "ES",
  DE: "DE", GERMANY: "DE",
  FR: "FR", FRANCE: "FR",
  IT: "IT", ITALY: "IT",
  CA: "CA", CANADA: "CA",
  AU: "AU", AUSTRALIA: "AU"
};
const toISO2 = (s) => {
  if (!s) return "US";
  const k = String(s).trim().toUpperCase();
  return COUNTRY_MAP[k] || (k.length === 2 ? k : "US");
};

let browser, ctx;
let lastLoginAt = 0;

// ---------- 1) Login Sanctum ----------
async function ensureContextLogged(force = false) {
  const fresh = (Date.now() - lastLoginAt) < 20 * 60 * 1000;
  if (!force && fresh && ctx) return ctx;
  if (!EMAIL || !PASS) throw new Error("Faltan ERANK_EMAIL/ERANK_PASSWORD");

  const rq = await request.newContext({
    extraHTTPHeaders: { "User-Agent": UA, "Accept-Language": ACCEPT_LANG }
  });
  const csrf = await rq.get("https://members.erank.com/sanctum/csrf-cookie");
  if (!csrf.ok()) throw new Error("CSRF cookie falló");

  const xsrf = (await rq.storageState()).cookies.find(c => c.name === "XSRF-TOKEN")?.value || "";
  const login = await rq.post("https://members.erank.com/login", {
    form: { email: EMAIL, password: PASS },
    headers: {
      "X-Requested-With": "XMLHttpRequest",
      "X-XSRF-TOKEN": decodeURIComponent(xsrf),
      "User-Agent": UA,
      "Accept-Language": ACCEPT_LANG
    }
  });
  if (!login.ok()) throw new Error(`Login falló: ${login.status()}`);

  const state = await rq.storageState();
  await rq.dispose();

  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"]
    });
  }
  if (ctx) await ctx.close();
  ctx = await browser.newContext({
    userAgent: UA,
    locale: "en-US",
    extraHTTPHeaders: { "Accept-Language": ACCEPT_LANG },
    storageState: state
  });
  lastLoginAt = Date.now();
  return ctx;
}

// ---------- 2) Petición JSON + fallback HTML ----------
async function callErank(pathname, query = {}) {
  // fuerza ISO-2 y normaliza source
  const country = toISO2(query.country);
  const source  = (query.source || query.marketplace || "etsy").toString().toLowerCase();
  const keyword = (query.keyword || query.q || "").toString();

  const qs = new URLSearchParams({ keyword, country, source }).toString();
  const url = `https://members.erank.com/${pathname}?${qs}`;

  const headers = {
    "Accept": "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    "Referer": `https://members.erank.com/keyword-tool?country=${country}&source=${source}&keyword=${encodeURIComponent(keyword)}`,
    "User-Agent": UA,
    "Accept-Language": ACCEPT_LANG,
    "Cache-Control": "no-cache"
  };

  const state = await (await ensureContextLogged()).storageState();

  // Intento directo con cookies activas
  const rqc = await request.newContext({ storageState: state, extraHTTPHeaders: headers });
  const resp = await rqc.get(url);
  const ct   = resp.headers()["content-type"] || "";
  const t    = await resp.text();
  await rqc.dispose();

  if (resp.ok() && ct.includes("application/json")) {
    try { return { url, json: JSON.parse(t), html: null }; } catch { /* cae a fallback */ }
  }

  // Fallback dentro del navegador, con XSRF del DOM
  const context = await ensureContextLogged();
  const page = await context.newPage();
  await page.goto(`https://members.erank.com/keyword-tool?country=${country}&source=${source}&keyword=${encodeURIComponent(keyword)}`, {
    waitUntil: "domcontentloaded",
    timeout: 120000
  });

  const out = await page.evaluate(async (u) => {
    const xsrf = (document.cookie.split(";").map(s => s.trim()).find(s => s.startsWith("XSRF-TOKEN=")) || "").split("=")[1] || "";
    try {
      const r = await fetch(u, {
        method: "GET",
        headers: {
          "Accept": "application/json, text/plain, */*",
          "X-Requested-With": "XMLHttpRequest",
          "X-XSRF-TOKEN": decodeURIComponent(xsrf),
          "Referer": location.href,
          "Cache-Control": "no-cache"
        },
        credentials: "include"
      });
      const type = r.headers.get("content-type") || "";
      const txt  = await r.text();
      return { ok: r.ok, type, txt };
    } catch (e) {
      return { ok: false, type: "", txt: String(e) };
    }
  }, url);
  await page.close();

  if (out.ok && out.type.includes("application/json")) {
    try { return { url, json: JSON.parse(out.txt), html: null }; } catch { /* sigue */ }
  }
  return { url, json: null, html: out.txt || t };
}

// ---------- 3) Parsers ----------
function pickKeywordsFromJSON(payload) {
  const arr = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  return arr.map(o => (o?.keyword || o?.name || o?.title || o?.term || o?.text || "").toString().trim()).filter(Boolean);
}
function pickKeywordsFromHTML(html) {
  const $ = cheerio.load(html);
  const out = new Set();
  $("table tbody tr").each((_, tr) => {
    const t = $(tr).find("td").first().text().trim();
    if (t) out.add(t);
  });
  $("[class*=chip],[class*=tag],[data-testid*=keyword],a[href*='keyword=']").each((_, el) => {
    const t = $(el).text().trim();
    if (t) out.add(t);
  });
  return Array.from(out).filter(Boolean);
}
function pickTopListingsFromJSON(payload) {
  const arr = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  return arr.map(o => ({
    title: String(o?.title || o?.name || "").trim(),
    url:   String(o?.url || o?.link || "").trim(),
    price: o?.price || "",
    shop:  o?.shop || ""
  })).filter(x => x.title || x.url);
}

// ---------- 4) Endpoints ----------
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/erank/healthz", (_req, res) => res.json({ ok: true }));

app.get("/erank/keywords", async (req, res) => {
  try {
    const q = String(req.query.q || "planner");
    const country = toISO2(req.query.country || "US");
    const source  = String(req.query.marketplace || "etsy").toLowerCase();
    const { url, json, html } = await callErank("related-searches", { keyword: q, country, source });
    let results = [];
    if (json) results = pickKeywordsFromJSON(json);
    if (!results.length && html) results = pickKeywordsFromHTML(html);
    res.json({ source: url, query: q, count: results.length, results });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

app.get("/erank/stats", async (req, res) => {
  try {
    const q = String(req.query.q || "planner");
    const country = toISO2(req.query.country || "US");
    const source  = String(req.query.marketplace || "etsy").toLowerCase();
    const { url, json } = await callErank("stats", { keyword: q, country, source });
    res.json({ source: url, query: q, stats: json || {} });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

app.get("/erank/top-listings", async (req, res) => {
  try {
    const q = String(req.query.q || "planner");
    const country = toISO2(req.query.country || "US");
    const source  = String(req.query.marketplace || "etsy").toLowerCase();
    const { url, json, html } = await callErank("top-listings", { keyword: q, country, source });
    let items = [];
    if (json) items = pickTopListingsFromJSON(json);
    if (!items.length && html) {
      const $ = cheerio.load(html);
      $("a[href*='etsy.com/listing/']").each((_, a) => {
        const title = $(a).text().trim();
        const href = $(a).attr("href");
        if (href) items.push({ title, url: href });
      });
    }
    res.json({ source: url, query: q, count: items.length, items });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

app.get("/erank/near-matches", async (req, res) => {
  try {
    const q = String(req.query.q || "planner");
    const country = toISO2(req.query.country || "US");
    const source  = String(req.query.marketplace || "etsy").toLowerCase();
    const { url, json } = await callErank("near-matches", { keyword: q, country, source });
    const results = json ? pickKeywordsFromJSON(json) : [];
    res.json({ source: url, query: q, count: results.length, results });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

app.get("/erank/raw", async (req, res) => {
  try {
    const q = String(req.query.q || "planner");
    const country = toISO2(req.query.country || "US");
    const source  = String(req.query.marketplace || "etsy").toLowerCase();
    const context = await ensureContextLogged(false);
    const page = await context.newPage();
    const url = `https://members.erank.com/keyword-tool?country=${country}&source=${source}&keyword=${encodeURIComponent(q)}`;
    await page.goto(url, { waitUntil: "networkidle", timeout: 120000 });
    const html = await page.content();
    await page.close();
    res.json({ url, ok: !!html, length: html ? html.length : 0, preview: (html || "").slice(0, 2000) });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

app.get("/", (_req, res) => res.json({
  ok: true,
  routes: ["/erank/healthz","/erank/keywords","/erank/stats","/erank/top-listings","/erank/near-matches","/erank/raw"]
}));

app.listen(port, "0.0.0.0", () => console.log("✅ Server live on", port));
