// index.js — eRank scraper (login Sanctum) con JSON+HTML fallback y parsers robustos
globalThis.File = globalThis.File || class File {};

const express = require("express");
const { chromium, request } = require("playwright");
const cheerio = require("cheerio");

const app = express();
const port = process.env.PORT || 3000;

const EMAIL = (process.env.ERANK_EMAIL || "").trim();
const PASS  = (process.env.ERANK_PASSWORD || "").trim();
const UA    = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";

let browser, ctx;
let lastLoginAt = 0;

/* ============================== 1) LOGIN SANCTUM ============================== */
async function ensureContextLogged(force = false) {
  const fresh = (Date.now() - lastLoginAt) < 20 * 60 * 1000;
  if (!force && fresh && ctx) return ctx;
  if (!EMAIL || !PASS) throw new Error("Faltan ERANK_EMAIL/ERANK_PASSWORD");

  const rq = await request.newContext({ extraHTTPHeaders: { "User-Agent": UA } });
  const csrf = await rq.get("https://members.erank.com/sanctum/csrf-cookie");
  if (!csrf.ok()) throw new Error("CSRF cookie falló");

  const xsrf = (await rq.storageState()).cookies.find(c => c.name === "XSRF-TOKEN")?.value || "";
  const login = await rq.post("https://members.erank.com/login", {
    form: { email: EMAIL, password: PASS },
    headers: {
      "X-Requested-With": "XMLHttpRequest",
      "X-XSRF-TOKEN": decodeURIComponent(xsrf),
      "User-Agent": UA
    }
  });
  if (!login.ok()) throw new Error(`Login falló: ${login.status()}`);

  const state = await rq.storageState();
  await rq.dispose();

  if (!browser)
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox","--disable-dev-shm-usage"] });

  if (ctx) await ctx.close();
  ctx = await browser.newContext({ userAgent: UA, storageState: state });
  lastLoginAt = Date.now();
  return ctx;
}

/* ============================== 2) FETCH ERANK =============================== */
// 1º intentamos JSON con el request del contexto (cookies compartidas)
// 2º si devuelve HTML, cargamos la página real y scrapeamos su HTML
async function callErank(pathname, query = {}) {
  const qs = new URLSearchParams(query || {}).toString();
  const url = `https://members.erank.com/${pathname}${qs ? "?" + qs : ""}`;
  const headers = {
    "Accept": "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    "Referer": "https://members.erank.com/keyword-tool",
    "User-Agent": UA
  };

  const context = await ensureContextLogged();
  const state = await context.storageState();
  const rqc = await request.newContext({ extraHTTPHeaders: headers, storageState: state });

  const r = await rqc.get(url);
  const ct = r.headers()["content-type"] || "";
  const text = await r.text();
  await rqc.dispose();

  if (r.ok() && ct.includes("application/json")) {
    try { return { url, json: JSON.parse(text), html: null }; }
    catch { /* cae al html */ }
  }

  // HTML (Inertia/React) → abrimos la página para obtener DOM completo
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "networkidle", timeout: 180000 });
  const html = await page.content();
  await page.close();
  return { url, json: null, html };
}

/* ============================== 3) PARSERS =================================== */
// ---- JSON seguro (tolera data/props/arreglos)
function pickKeywordsFromJSON(payload) {
  try {
    if (!payload) return [];
    if (Array.isArray(payload)) {
      return payload.map(x => (x?.keyword || x?.name || x?.title || x?.term || x?.text || "").toString().trim())
                    .filter(Boolean);
    }
    if (payload.props) {
      const arr = payload.props.keywords || payload.props.data || payload.props.results || [];
      if (Array.isArray(arr))
        return arr.map(x => (x?.keyword || x?.name || x?.title || x?.term || x?.text || "").toString().trim())
                  .filter(Boolean);
    }
    if (Array.isArray(payload.data)) {
      return payload.data.map(x => (x?.keyword || x?.name || x?.title || x?.term || x?.text || "").toString().trim())
                         .filter(Boolean);
    }
  } catch {}
  return [];
}

function pickTopListingsFromJSON(payload) {
  try {
    const arr = Array.isArray(payload?.data) ? payload.data : (payload?.props?.data || []);
    if (Array.isArray(arr)) {
      return arr.map(o => ({
        title: String(o?.title || o?.name || "").trim(),
        url:   String(o?.url || o?.link  || "").trim(),
        price: o?.price || "",
        shop:  o?.shop  || ""
      })).filter(x => x.title || x.url);
    }
  } catch {}
  return [];
}

// ---- HTML → keywords (tabla + chips + enlaces con ?keyword=)
function extractKeywordsFromHTML(html) {
  const $ = cheerio.load(html || "");
  const out = new Set();
  $("table tbody tr").each((_, tr) => {
    const t = $(tr).find("td").first().text().trim();
    if (t) out.add(t);
  });
  $("[class*=chip],[class*=tag],[data-testid*=keyword],a[href*='keyword=']").each((_, el) => {
    const t = $(el).text().trim();
    if (t) out.add(t);
  });
  return Array.from(out);
}

// ---- HTML → top listings (enlaces a Etsy)
function extractTopListingsFromHTML(html) {
  const $ = cheerio.load(html || "");
  const items = [];
  $("a[href*='etsy.com/listing/']").each((_, a) => {
    const title = $(a).text().trim();
    const url   = $(a).attr("href") || "";
    if (url) items.push({ title, url });
  });
  return items;
}

// ---- HTML → stats (si no hay JSON, devolvemos medidas mínimas)
function extractStatsFromHTML(html) {
  return { htmlLength: (html || "").length };
}

/* ============================== 4) ENDPOINTS ================================= */
app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.get("/erank/keywords", async (req, res) => {
  try {
    const q       = String(req.query.q || "planner");
    const country = String(req.query.country || "USA");
    const source  = String(req.query.marketplace || "etsy");

    const { url, json, html } = await callErank("related-searches", { keyword: q, country, source });

    // 1º JSON (props/data/arrays), 2º HTML (DOM)
    let results = pickKeywordsFromJSON(json);
    if (!results.length && html) results = extractKeywordsFromHTML(html);

    // filtrar por query si procede y limitar
    if (q) results = results.filter(s => s.toLowerCase().includes(q.toLowerCase()));
    res.json({ source: url, query: q, count: results.length, results: results.slice(0, 100) });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.get("/erank/near-matches", async (req, res) => {
  try {
    const q       = String(req.query.q || "planner");
    const country = String(req.query.country || "USA");
    const source  = String(req.query.marketplace || "etsy");

    const { url, json, html } = await callErank("near-matches", { keyword: q, country, source });

    let results = pickKeywordsFromJSON(json);
    if (!results.length && html) results = extractKeywordsFromHTML(html);

    if (q) results = results.filter(s => s.toLowerCase().includes(q.toLowerCase()));
    res.json({ source: url, query: q, count: results.length, results: results.slice(0, 100) });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.get("/erank/top-listings", async (req, res) => {
  try {
    const q       = String(req.query.q || "planner");
    const country = String(req.query.country || "USA");
    const source  = String(req.query.marketplace || "etsy");

    const { url, json, html } = await callErank("top-listings", { keyword: q, country, source });

    let items = pickTopListingsFromJSON(json);
    if (!items.length && html) items = extractTopListingsFromHTML(html);

    res.json({ source: url, query: q, count: items.length, items });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.get("/erank/stats", async (req, res) => {
  try {
    const q       = String(req.query.q || "planner");
    const country = String(req.query.country || "USA");
    const source  = String(req.query.marketplace || "etsy");

    const { url, json, html } = await callErank("stats", { keyword: q, country, source });

    const stats = json && typeof json === "object" && Object.keys(json).length
      ? json
      : extractStatsFromHTML(html);

    res.json({ source: url, query: q, stats });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// Debug: HTML crudo del Keyword Tool
app.get("/erank/raw", async (req, res) => {
  try {
    const q       = String(req.query.q || "planner");
    const country = String(req.query.country || "USA");
    const source  = String(req.query.marketplace || "etsy");
    const context = await ensureContextLogged(false);
    const page = await context.newPage();
    const url = `https://members.erank.com/keyword-tool?country=${encodeURIComponent(country)}&source=${encodeURIComponent(source)}&keyword=${encodeURIComponent(q)}`;
    await page.goto(url, { waitUntil: "networkidle", timeout: 180000 });
    const html = await page.content();
    await page.close();
    res.json({ url, ok: !!html, length: html ? html.length : 0, preview: (html || "").slice(0, 2000) });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.get("/", (_req, res) => res.json({
  ok: true,
  routes: [
    "/erank/healthz",
    "/erank/keywords",
    "/erank/near-matches",
    "/erank/top-listings",
    "/erank/stats",
    "/erank/raw"
  ]
}));

app.listen(port, "0.0.0.0", () => {
  console.log("✅ eRank scraper listo en puerto", port);
});
