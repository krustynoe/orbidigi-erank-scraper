// index.js — FINAL: login Sanctum + scraping estable de eRank Keyword Tool (Inertia + DOM)

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

// ---------- utils ----------
const normCountry = (c) => {
  const s = String(c || "US").toUpperCase();
  if (s === "USA") return "US";
  return s; // admite US / EU / etc.
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
async function loadKeywordToolHTML(keyword, country, source) {
  const c = normCountry(country);
  const s = normSource(source);
  const url = `https://members.erank.com/keyword-tool?country=${encodeURIComponent(c)}&source=${encodeURIComponent(s)}&keyword=${encodeURIComponent(keyword)}`;

  const context = await ensureContextLogged();
  const page = await context.newPage();

  // primero carga rápida para que Inertia pueble props
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 180000 });

  // Espera escalonada: #app[data-page] (Inertia) o al menos tabla/chips del DOM
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

// ---------- 3) PARSERS ROBUSTOS ----------
function parseInertiaProps(jsonStr) {
  if (!jsonStr) return {};
  try { return JSON.parse(jsonStr) || {}; } catch { return {}; }
}

function pickKeywordsFromProps(propsRoot) {
  const out = [];
  const scan = (obj) => {
    if (!obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      obj.forEach(x => {
        const kw = text(x?.keyword || x?.name || x?.title || x?.term || x?.text);
        const vol = x?.volume ?? x?.search_volume ?? x?.sv ?? null;
        if (kw) out.push({ keyword: kw, volume: vol ?? null });
      });
    } else {
      for (const k of Object.keys(obj)) scan(obj[k]);
    }
  };
  scan(propsRoot);
  // dedup
  const seen = new Set();
  return out.filter(it => {
    const key = it.keyword.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function pickKeywordsFromHTML(html) {
  const $ = cheerio.load(html || "");
  const out = new Map();

  // Tabla
  $("table tbody tr").each((_, tr) => {
    const tds = $(tr).find("td");
    const kw = text($(tds.get(0)).text());
    const vol = text($(tds.get(1)).text());
    if (kw) out.set(kw.toLowerCase(), { keyword: kw, volume: vol || null });
  });

  // Chips/tags
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

// Keywords (combina props y DOM)
app.get("/erank/keywords", async (req, res) => {
  try {
    const q = text(req.query.q || "planner");
    const country = text(req.query.country || "US");
    const source = text(req.query.marketplace || "etsy");

    const { url, html, dataPageJSON } = await loadKeywordToolHTML(q, country, source);
    const inertia = parseInertiaProps(dataPageJSON);
    const propsRoot = inertia?.props || inertia || {};

    let results = pickKeywordsFromProps(propsRoot);
    if (!results.length) results = pickKeywordsFromHTML(html);

    res.json({ source: url, query: q, count: results.length, results });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// Near matches = mismo scraping (props/DOM)
app.get("/erank/near-matches", async (req, res) => {
  try {
    const q = text(req.query.q || "planner");
    const country = text(req.query.country || "US");
    const source = text(req.query.marketplace || "etsy");

    const { url, html, dataPageJSON } = await loadKeywordToolHTML(q, country, source);
    const inertia = parseInertiaProps(dataPageJSON);
    const propsRoot = inertia?.props || inertia || {};

    let results = pickKeywordsFromProps(propsRoot);
    if (!results.length) results = pickKeywordsFromHTML(html);

    res.json({ source: url, query: q, count: results.length, results });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// Top listings
app.get("/erank/top-listings", async (req, res) => {
  try {
    const q = text(req.query.q || "planner");
    const country = text(req.query.country || "US");
    const source = text(req.query.marketplace || "etsy");

    const { url, html, dataPageJSON } = await loadKeywordToolHTML(q, country, source);
    const inertia = parseInertiaProps(dataPageJSON);
    const propsRoot = inertia?.props || inertia || {};

    // intenta props primero
    let items = [];
    const scan = (obj) => {
      if (!obj || typeof obj !== "object") return;
      if (Array.isArray(obj)) {
        obj.forEach(x => {
          const title = text(x?.title || x?.name);
          const link = text(x?.url || x?.link || x?.href);
          if (title || link) items.push({ title, url: link });
        });
      } else {
        for (const k of Object.keys(obj)) scan(obj[k]);
      }
    };
    scan(propsRoot);

    if (!items.length) items = pickListingsFromHTML(html);

    // dedup por url/título
    const seen = new Set();
    items = items.filter(it => {
      const key = (it.url || it.title || "").toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    res.json({ source: url, query: q, count: items.length, items });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// Stats (si no hay props, devuelve tamaño HTML)
app.get("/erank/stats", async (req, res) => {
  try {
    const q = text(req.query.q || "planner");
    const country = text(req.query.country || "US");
    const source = text(req.query.marketplace || "etsy");

    const { url, html, dataPageJSON } = await loadKeywordToolHTML(q, country, source);
    const inertia = parseInertiaProps(dataPageJSON);
    const propsRoot = inertia?.props || inertia || {};

    // Busca un bloque plausible de stats
    let stats = {};
    const scanStats = (obj) => {
      if (!obj || typeof obj !== "object") return;
      if (Array.isArray(obj)) return;
      const keys = Object.keys(obj);
      if (keys.some(k => /volume|search|trend|avg|min|max/i.test(k))) {
        stats = Object.assign(stats, obj);
      }
      for (const k of keys) scanStats(obj[k]);
    };
    scanStats(propsRoot);

    if (!Object.keys(stats).length) stats = { htmlLength: (html || "").length };

    res.json({ source: url, query: q, stats });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// Raw HTML (debug)
app.get("/erank/raw", async (req, res) => {
  try {
    const q = text(req.query.q || "planner");
    const country = text(req.query.country || "US");
    const source = text(req.query.marketplace || "etsy");
    const { url, html, dataPageJSON } = await loadKeywordToolHTML(q, country, source);
    res.json({ url, ok: !!html, length: (html || "").length, hasProps: !!dataPageJSON, preview: (html || "").slice(0, 1200) });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

app.get("/", (_req, res) => res.json({
  ok: true,
  routes: ["/erank/healthz","/erank/keywords","/erank/stats","/erank/top-listings","/erank/near-matches","/erank/raw"]
}));

app.listen(port, "0.0.0.0", () => console.log("✅ eRank scraper estable activo en", port));
