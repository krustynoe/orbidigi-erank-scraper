// index.js — FINAL estable: login Sanctum + scraping HTML (Inertia/DOM) + endpoints extra

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
const text = (v) => (v ?? "").toString().trim();
const normCountry = (c) => { const s = String(c || "US").toUpperCase(); return (s === "USA") ? "US" : s; };
const normSource  = (m) => String(m || "etsy").toLowerCase();

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

// ---------- 2) CARGA DE PÁGINAS ----------
async function loadKeywordToolHTML(keyword, country, source, tab = null) {
  const c = normCountry(country);
  const s = normSource(source);
  const url = `https://members.erank.com/keyword-tool?country=${encodeURIComponent(c)}&source=${encodeURIComponent(s)}&keyword=${encodeURIComponent(keyword)}`;

  const context = await ensureContextLogged();
  const page = await context.newPage();

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 180000 });

  // Si piden top-listings, entrar explícitamente a la pestaña
  if (tab === "top-listings") {
    try {
      await page.waitForSelector('a[href*="top-listings"], text=Top Listings', { timeout: 8000 });
      await page.click('a[href*="top-listings"], text=Top Listings');
      // Espera razonable para hidratar DOM
      await page.waitForTimeout(5000);
    } catch (_) {}
  }

  // props inertia o contenido
  try { await page.waitForSelector('#app[data-page], table tbody tr, [class*=chip], [class*=tag], [data-testid*=keyword]', { timeout: 12000 }); } catch (_) {}

  const html = await page.content();
  await page.close();
  return { url, html };
}

async function loadDashboardHTML() {
  // Primero intentamos members.erank.com, si falla probamos erank.com
  const context = await ensureContextLogged();
  const page = await context.newPage();
  let url = "https://members.erank.com/dashboard";
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
  } catch {
    url = "https://erank.com/dashboard";
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
  }
  // Espera a que el dashboard muestre tarjetas
  try { await page.waitForSelector("div,section,article", { timeout: 8000 }); } catch (_) {}
  const html = await page.content();
  await page.close();
  return { url, html };
}

// ---------- 3) PARSERS ----------
function pickKeywordsFromHTML(html) {
  const $ = cheerio.load(html || "");
  const out = new Map();
  // Tabla principal (si existe)
  $("table tbody tr").each((_, tr) => {
    const tds = $(tr).find("td");
    const kw = text($(tds.get(0)).text());
    const vol = text($(tds.get(1)).text());
    if (kw) out.set(kw.toLowerCase(), { keyword: kw, volume: vol || null });
  });
  // Chips/etiquetas
  $("[class*=chip],[class*=tag],[data-testid*=keyword],a[href*='keyword=']").each((_, el) => {
    const kw = text($(el).text());
    if (kw && !out.has(kw.toLowerCase())) out.set(kw.toLowerCase(), { keyword: kw, volume: null });
  });
  return [...out.values()];
}

function pickListingsFromHTML(html) {
  const $ = cheerio.load(html || "");
  const items = [];
  // enlaces a listings
  $("a[href*='etsy.com/listing/']").each((_, a) => {
    const title = text($(a).text());
    const url = $(a).attr("href") || "";
    if (url) items.push({ title, url });
  });
  return items;
}

function extractShopStatsFromDashboard(html) {
  const $ = cheerio.load(html || "");
  const lookup = (label) => {
    // busca una tarjeta que contenga el label y extrae el número cercano
    const node = $(`*:contains("${label}")`).filter((_,el)=>$(el).children().length===0).first();
    if (!node.length) return null;
    // número a derecha o en ancestros cercanos
    const txts = [
      node.parent().text(),
      node.parent().next().text(),
      node.closest("div,section,article").text()
    ].map(text).join(" | ");
    const m = txts.match(/([\d.,]+(?:\s?[KMB])?)/i);
    return m ? m[1] : null;
  };
  return {
    activeListings: lookup("Active Listings"),
    spottedOnEtsy: lookup("Spotted on Etsy"),
    inventoryValue: lookup("Inventory Value"),
    uniqueTagsUsed: lookup("Unique Tags Used")
  };
}

function aggregateCompetitorsFromListings(html) {
  const $ = cheerio.load(html || "");
  const counts = new Map();
  // Heurística: muchos listados incluyen el nombre de la shop cerca del título o como enlace vecino
  $("a[href*='etsy.com/listing/']").each((_, a) => {
    // intenta encontrar texto cercano con 'by <shop>' o enlace a /shop/
    let ctx = $(a).closest("div,li,tr").text();
    let shop = (ctx.match(/\bby\s+([A-Za-z0-9_\- ]{2,60})/i)||[])[1] || "";
    if (!shop) {
      const shopLink = $(a).closest("div,li,tr").find("a[href*='/shop/']").first().text();
      shop = text(shopLink);
    }
    shop = text(shop);
    if (shop) counts.set(shop, (counts.get(shop)||0)+1);
  });
  // output ordenado
  return [...counts.entries()].sort((a,b)=>b[1]-a[1]).map(([shop,hits])=>({shop,hits}));
}

// ---------- 4) ENDPOINTS ----------
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/erank/healthz", (_req, res) => res.json({ ok: true })); // alias solicitado

// Keywords (US/EU/…)
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

// Near matches (mismo parser)
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

// Top listings (click en pestaña antes de scrapear)
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

// Alias products → top-listings
app.get("/erank/products", async (req, res) => {
  req.url = req.url.replace("/erank/products", "/erank/top-listings");
  return app._router.handle(req, res, () => {});
});

// Stats con totalKeywords + htmlLength
app.get("/erank/stats", async (req, res) => {
  try {
    const q = text(req.query.q || "planner");
    const country = text(req.query.country || "US");
    const source = text(req.query.marketplace || "etsy");
    const { url, html } = await loadKeywordToolHTML(q, country, source);
    const $ = cheerio.load(html);
    const totalKeywords = $("table tbody tr").length;
    res.json({ source: url, query: q, stats: { totalKeywords, htmlLength: (html||"").length } });
  } catch (e) { res.status(502).json({ error: String(e.message||e) }); }
});

// Shop dashboard (tu tienda)
app.get("/erank/shop", async (_req, res) => {
  try {
    const { url, html } = await loadDashboardHTML();
    const stats = extractShopStatsFromDashboard(html);
    res.json({ source: url, shop: stats });
  } catch (e) { res.status(502).json({ error: String(e.message||e) }); }
});

// Competitors (a partir de Top Listings)
app.get("/erank/competitors", async (req, res) => {
  try {
    const q = text(req.query.q || "planner");
    const country = text(req.query.country || "US");
    const source = text(req.query.marketplace || "etsy");
    const { url, html } = await loadKeywordToolHTML(q, country, source, "top-listings");
    const leaderboard = aggregateCompetitorsFromListings(html);
    res.json({ source: url, query: q, count: leaderboard.length, competitors: leaderboard });
  } catch (e) { res.status(502).json({ error: String(e.message||e) }); }
});

// Raw HTML (debug)
app.get("/erank/raw", async (req, res) => {
  try {
    const q = text(req.query.q || "planner");
    const country = text(req.query.country || "US");
    const source = text(req.query.marketplace || "etsy");
    const { url, html } = await loadKeywordToolHTML(q, country, source);
    res.json({ url, ok: !!html, length: (html || "").length, preview: (html || "").slice(0, 1200) });
  } catch (e) { res.status(502).json({ error: String(e.message||e) }); }
});

// Índice
app.get("/", (_req, res) => res.json({
  ok: true,
  routes: [
    "/healthz","/erank/healthz",
    "/erank/keywords","/erank/near-matches",
    "/erank/top-listings","/erank/products",
    "/erank/stats","/erank/shop","/erank/competitors",
    "/erank/raw"
  ]
}));

app.listen(port, "0.0.0.0", () => console.log("✅ eRank scraper activo en", port));
