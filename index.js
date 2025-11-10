// index.js — eRank: login Sanctum + JSON si existe + SCRAPING HTML (Opción A) con Cheerio.
// Requiere: express, cheerio, playwright@1.56.1

globalThis.File = globalThis.File || class File {};

const express = require("express");
const { chromium, request } = require("playwright");
const cheerio = require("cheerio");

const app = express();
const port = process.env.PORT || 3000;

const EMAIL = (process.env.ERANK_EMAIL || "").trim();
const PASS  = (process.env.ERANK_PASSWORD || "").trim();
const UA    = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML,like Gecko) Chrome/122 Safari/537.36";

let browser, ctx;
let lastLoginAt = 0;

// ---------- 1) Login Sanctum (sin teclado) ----------
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

  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"]
    });
  }
  if (ctx) await ctx.close();
  ctx = await browser.newContext({ userAgent: UA, storageState: state });
  lastLoginAt = Date.now();
  return ctx;
}

// ---------- 2) Helper: intenta JSON y si no, usa HTML del panel ----------
async function fetchErankJSON(pathname, query = {}) {
  const ctx = await ensureContextLogged();
  const headers = {
    "Accept": "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    "Referer": "https://members.erank.com/keyword-tool",
    "User-Agent": UA
  };
  const qs = new URLSearchParams(query || {}).toString();
  const url = `https://members.erank.com/${pathname}${qs ? "?" + qs : ""}`;

  // 1) Intento con request del contexto (arrastra cookies)
  const r = await ctx.request.get(url, { headers });
  const ct = r.headers()["content-type"] || "";
  if (r.ok() && ct.includes("application/json")) {
    const data = await r.json().catch(() => null);
    return { mode: "json", url, json: data, html: null };
  }

  // 2) Fallback: devuelve HTML del panel real
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 180000 });
  const html = await page.content();
  await page.close();
  return { mode: "html", url, json: null, html };
}

// ---------- 3) Scrapers HTML (Opción A) ----------
function parseKeywordsHTML(html) {
  const $ = cheerio.load(html || "");
  const seen = new Set();
  const details = [];

  // Tabla principal (si existe): keyword en 1ª columna, volumen en 2ª
  $("table tbody tr").each((_, tr) => {
    const tds = $(tr).find("td");
    const kw  = $(tds[0]).text().trim();
    const vol = $(tds[1]).text().trim();
    if (kw) {
      if (!seen.has(kw)) {
        seen.add(kw);
        details.push({ keyword: kw, volume: vol || null });
      }
    }
  });

  // Chips / tags / pills / enlaces con ?keyword=
  $("[class*=chip],[class*=tag],[data-testid*=keyword],a[href*='keyword=']").each((_, el) => {
    let t = $(el).text().trim();
    if (!t) {
      const href = $(el).attr("href") || "";
      const m = href.match(/[?&]keyword=([^&]+)/);
      if (m) t = decodeURIComponent(m[1]);
    }
    if (t && !seen.has(t)) {
      seen.add(t);
      details.push({ keyword: t, volume: null });
    }
  });

  const results = details.map(d => d.keyword);
  return { results, details };
}

function parseTopListingsHTML(html) {
  const $ = cheerio.load(html || "");
  const items = [];
  // Enlaces a Etsy listings
  $("a[href*='etsy.com/listing/']").each((_, a) => {
    const title = $(a).text().trim() || null;
    const url = $(a).attr("href") || null;
    if (url) items.push({ title, url });
  });
  // Alternativa: tarjetitas con data-url o botones
  $("[data-url*='etsy.com/listing/']").each((_, el) => {
    const url = $(el).attr("data-url");
    const title = $(el).text().trim() || null;
    if (url) items.push({ title, url });
  });
  return dedupeBy(items, x => x.url).slice(0, 100);
}

function parseNearMatchesHTML(html) {
  // Reutilizamos el parser de keywords
  const { results } = parseKeywordsHTML(html);
  return results.slice(0, 100);
}

function parseStatsHTML(html) {
  // Parser básico de estadísticas visibles en tarjetas/labels, si existieran
  const $ = cheerio.load(html || "");
  const stats = {};
  // Ejemplo heurístico (ajústalo si ves labels concretos en tu HTML)
  $("[class*=stat],[class*=card],[class*=panel]").each((_, el) => {
    const label = $(el).find("h3, h4, .label, .title").first().text().trim();
    const value = $(el).find(".value, .number, strong, b").first().text().trim();
    if (label && value) stats[label] = value;
  });
  return stats;
}

function dedupeBy(arr, keyFn) {
  const map = new Map();
  for (const it of arr) {
    const k = keyFn(it);
    if (!map.has(k)) map.set(k, it);
  }
  return Array.from(map.values());
}

// ---------- 4) Endpoints ----------
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/erank/healthz", (_req, res) => res.json({ ok: true }));

app.get("/erank/keywords", async (req, res) => {
  try {
    const q = String(req.query.q || "planner");
    const country = String(req.query.country || "USA");
    const source = String(req.query.marketplace || "etsy");

    // 1) Intento JSON
    const r = await fetchErankJSON("related-searches", { keyword: q, country, source });
    let results = [];
    let details = [];

    if (r.json) {
      // datos JSON (Infrecuente a día de hoy, pero soportado)
      const arr = Array.isArray(r.json?.data) ? r.json.data : Array.isArray(r.json) ? r.json : [];
      results = arr.map(o => (o?.keyword || o?.name || o?.title || o?.term || o?.text || "").toString().trim()).filter(Boolean);
      details = results.map(k => ({ keyword: k, volume: null }));
    }

    // 2) Si no hay JSON o viene vacío → SCRAPING HTML del panel
    if (!results.length && r.html) {
      const pageHTML = await getKeywordToolHTML(country, source, q);
      const parsed = parseKeywordsHTML(pageHTML);
      results = parsed.results;
      details = parsed.details;
    }

    // Filtro por consulta (por si el HTML trae más)
    if (q) results = results.filter(s => s.toLowerCase().includes(q.toLowerCase()));

    res.json({ source: r.url, query: q, count: results.length, results, details });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.get("/erank/top-listings", async (req, res) => {
  try {
    const q = String(req.query.q || "planner");
    const country = String(req.query.country || "USA");
    const source = String(req.query.marketplace || "etsy");

    const r = await fetchErankJSON("top-listings", { keyword: q, country, source });

    let items = [];
    if (r.json) {
      const arr = Array.isArray(r.json?.data) ? r.json.data : Array.isArray(r.json) ? r.json : [];
      items = arr.map(o => ({
        title: String(o?.title || o?.name || "").trim(),
        url: String(o?.url || o?.link || "").trim(),
        price: o?.price || "",
        shop: o?.shop || ""
      })).filter(x => x.title || x.url);
    }

    if (!items.length) {
      const pageHTML = await getKeywordToolHTML(country, source, q);
      items = parseTopListingsHTML(pageHTML);
    }

    res.json({ source: r.url, query: q, count: items.length, items: items.slice(0, 100) });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.get("/erank/near-matches", async (req, res) => {
  try {
    const q = String(req.query.q || "planner");
    const country = String(req.query.country || "USA");
    const source = String(req.query.marketplace || "etsy");

    const r = await fetchErankJSON("near-matches", { keyword: q, country, source });

    let results = [];
    if (r.json) {
      const arr = Array.isArray(r.json?.data) ? r.json.data : Array.isArray(r.json) ? r.json : [];
      results = arr.map(o => (o?.keyword || o?.name || o?.title || o?.term || o?.text || "").toString().trim()).filter(Boolean);
    }

    if (!results.length) {
      const pageHTML = await getKeywordToolHTML(country, source, q);
      results = parseNearMatchesHTML(pageHTML);
    }

    res.json({ source: r.url, query: q, count: results.length, results });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.get("/erank/stats", async (req, res) => {
  try {
    const q = String(req.query.q || "planner");
    const country = String(req.query.country || "USA");
    const source = String(req.query.marketplace || "etsy");

    const r = await fetchErankJSON("stats", { keyword: q, country, source });

    let stats = r.json || {};
    if (!Object.keys(stats || {}).length) {
      const pageHTML = await getKeywordToolHTML(country, source, q);
      stats = parseStatsHTML(pageHTML);
    }

    res.json({ source: r.url, query: q, stats });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// Debug: HTML crudo del Keyword Tool
app.get("/erank/raw", async (req, res) => {
  try {
    const q = String(req.query.q || "planner");
    const country = String(req.query.country || "USA");
    const source = String(req.query.marketplace || "etsy");
    const html = await getKeywordToolHTML(country, source, q);
    res.json({ ok: !!html, length: (html || "").length, preview: (html || "").slice(0, 2000) });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.get("/", (_req, res) => res.json({
  ok: true,
  routes: ["/erank/healthz","/erank/keywords","/erank/stats","/erank/top-listings","/erank/near-matches","/erank/raw"]
}));

// ---------- 5) Utilidad: descargar el HTML del keyword tool ----------
async function getKeywordToolHTML(country, source, keyword) {
  const ctx = await ensureContextLogged();
  const page = await ctx.newPage();
  const url = `https://members.erank.com/keyword-tool?country=${encodeURIComponent(country)}&source=${encodeURIComponent(source)}&keyword=${encodeURIComponent(keyword)}`;
  await page.goto(url, { waitUntil: "networkidle", timeout: 180000 });
  const html = await page.content();
  await page.close();
  return html;
}

app.listen(port, "0.0.0.0", () => {
  console.log("✅ Server online en", port);
});
