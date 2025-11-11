// index.js — FINAL estable: login Sanctum + scraping HTML + props + correcciones healthz / stats / top-listings

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

// ---------- utils ----------
const normCountry = (c) => {
  const s = String(c || "US").toUpperCase();
  if (s === "USA") return "US";
  return s;
};
const normSource = (m) => String(m || "etsy").toLowerCase();
const text = (v) => (v ?? "").toString().trim();
const safeArray = (v) => Array.isArray(v) ? v : [];

// ---------- 1) LOGIN SANCTUM ----------
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

// ---------- 2) CARGA DE KEYWORD TOOL (espera props/DOM) ----------
async function loadKeywordToolHTML(keyword, country, source, tab = null) {
  const c = normCountry(country);
  const s = normSource(source);
  const url = `https://members.erank.com/keyword-tool?country=${encodeURIComponent(c)}&source=${encodeURIComponent(s)}&keyword=${encodeURIComponent(keyword)}`;

  const context = await ensureContextLogged();
  const page = await context.newPage();

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 180000 });

  // Si piden tab="top-listings", hace click en esa pestaña
  if (tab === "top-listings") {
    try {
      await page.waitForSelector('a[href*="top-listings"], text=Top Listings', { timeout: 8000 });
      await page.click('a[href*="top-listings"], text=Top Listings');
      await page.waitForTimeout(5000);
    } catch (_) {}
  }

  // props inertia
  let dataPageJSON = null;
  try {
    await page.waitForSelector('#app[data-page]', { timeout: 8000 });
    dataPageJSON = await page.evaluate(() => {
      const el = document.querySelector('#app[data-page]');
      return el?.getAttribute('data-page') || null;
    });
  } catch (_) {}

  if (!dataPageJSON) {
    try {
      await page.waitForSelector('table tbody tr, [class*=chip], [class*=tag], [data-testid*=keyword]', { timeout: 12000 });
    } catch (_) {}
  }

  const html = await page.content();
  await page.close();
  return { url, html, dataPageJSON };
}

// ---------- 3) PARSERS ----------
function parseInertiaProps(jsonStr) {
  if (!jsonStr) return {};
  try { return JSON.parse(jsonStr) || {}; } catch { return {}; }
}

function pickKeywordsFromHTML(html) {
  const $ = cheerio.load(html || "");
  const out = new Map();
  $("table tbody tr").each((_, tr) => {
    const tds = $(tr).find("td");
    const kw = text($(tds.get(0)).text());
    const vol = text($(tds.get(1)).text());
    if (kw) out.set(kw.toLowerCase(), { keyword: kw, volume: vol || null });
  });
  $("[class*=chip],[class*=tag],[data-testid*=keyword],a[href*='keyword=']").each((_, el) => {
    const kw = text($(el).text());
    if (kw && !out.has(kw.toLowerCase())) out.set(kw.toLowerCase(), { keyword: kw, volume: null });
  });
  return [...out.values()];
}

function pickListingsFromHTML(html) {
  const $ = cheerio.load(html || "");
  const items = [];
  $("a[href*='etsy.com/listing/']").each((_, a) => {
    const title = text($(a).text());
    const url = $(a).attr("href") || "";
    if (url) items.push({ title, url });
  });
  return items;
}

// ---------- 4) ENDPOINTS ----------
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/erank/healthz", (_req, res) => res.json({ ok: true }));

// Keywords
app.get("/erank/keywords", async (req, res) => {
  try {
    const q = text(req.query.q || "planner");
    const country = text(req.query.country || "US");
    const source = text(req.query.marketplace || "etsy");
    const { url, html } = await loadKeywordToolHTML(q, country, source);
    const results = pickKeywordsFromHTML(html);
    res.json({ source: url, query: q, count: results.length, results });
  } catch (e) { res.status(502).json({ error: String(e.message||e) }); }
});

// Near matches
app.get("/erank/near-matches", async (req, res) => {
  try {
    const q = text(req.query.q || "planner");
    const country = text(req.query.country || "US");
    const source = text(req.query.marketplace || "etsy");
    const { url, html } = await loadKeywordToolHTML(q, country, source);
    const results = pickKeywordsFromHTML(html);
    res.json({ source: url, query: q, count: results.length, results });
  } catch (e) { res.status(502).json({ error: String(e.message||e) }); }
});

// Top listings (ahora hace click en la pestaña antes de scrapeo)
app.get("/erank/top-listings", async (req, res) => {
  try {
    const q = text(req.query.q || "planner");
    const country = text(req.query.country || "US");
    const source = text(req.query.marketplace || "etsy");
    const { url, html } = await loadKeywordToolHTML(q, country, source, "top-listings");
    const items = pickListingsFromHTML(html);
    res.json({ source: url, query: q, count: items.length, items });
  } catch (e) { res.status(502).json({ error: String(e.message||e) }); }
});

// Stats
app.get("/erank/stats", async (req, res) => {
  try {
    const q = text(req.query.q || "planner");
    const country = text(req.query.country || "US");
    const source = text(req.query.marketplace || "etsy");
    const { url, html } = await loadKeywordToolHTML(q, country, source);
    const $ = cheerio.load(html);
    const totalKeywords = $("table tbody tr").length;
    res.json({ source: url, query: q, stats: { totalKeywords, htmlLength: html.length } });
  } catch (e) { res.status(502).json({ error: String(e.message||e) }); }
});

// Raw HTML
app.get("/erank/raw", async (req, res) => {
  try {
    const q = text(req.query.q || "planner");
    const country = text(req.query.country || "US");
    const source = text(req.query.marketplace || "etsy");
    const { url, html } = await loadKeywordToolHTML(q, country, source);
    res.json({ url, ok: !!html, length: (html || "").length, preview: (html || "").slice(0, 1200) });
  } catch (e) { res.status(502).json({ error: String(e.message||e) }); }
});

app.get("/", (_req, res) => res.json({
  ok: true,
  routes: ["/healthz","/erank/healthz","/erank/keywords","/erank/stats","/erank/top-listings","/erank/near-matches","/erank/raw"]
}));

app.listen(port, "0.0.0.0", () => console.log("✅ eRank scraper activo en puerto", port));
