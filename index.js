// index.js — eRank scraper estable: login Sanctum + scraping DOM renderizado con Playwright
// - Prioriza scraping directo del DOM tras render (esperando selectores).
// - Si el endpoint JSON devuelve HTML, hace fallback a fetch dentro del navegador.
// - Normaliza el país (usa códigos de 2 letras cuando detecta USA/Uk/etc).

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

/* ----------------------------- utils ----------------------------- */

function normalizeCountry(c) {
  if (!c) return "US";
  const s = String(c).trim().toUpperCase();
  // mapas comunes
  const map = {
    USA: "US",
    UNITEDSTATES: "US",
    UNITED_STATES: "US",
    UNITED STATES: "US",
    UK: "UK",
    UNITEDKINGDOM: "UK",
    UNITED_KINGDOM: "UK",
    UNITED KINGDOM: "UK",
    ENGLAND: "UK",
    GB: "UK",
    GREATBRITAIN: "UK",
    GREAT_BRITAIN: "UK",
    GREAT BRITAIN: "UK",
    ESP: "ES",
    SPAIN: "ES"
  };
  if (map[s]) return map[s];
  // si ya es código de 2 letras, úsalo
  if (/^[A-Z]{2}$/.test(s)) return s;
  return s; // deja tal cual si no reconoce
}

/* ---------------------------- login ------------------------------ */

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

/* ---------------------- scraping de la página --------------------- */

async function openKeywordToolPage(q, country, source) {
  const context = await ensureContextLogged(false);
  const page = await context.newPage();
  const url = `https://members.erank.com/keyword-tool?country=${encodeURIComponent(country)}&source=${encodeURIComponent(source)}&keyword=${encodeURIComponent(q)}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 180000 });

  // espera a que el front pinte algo útil. probamos varios selectores habituales
  const selectors = [
    "table tbody tr td:first-child",
    "[class*=chip]", "[class*=tag]",
    "[data-testid*=keyword]",
    "a[href*='keyword=']"
  ];
  let found = false;
  for (const sel of selectors) {
    try {
      await page.waitForSelector(sel, { timeout: 12000 });
      found = true; break;
    } catch (_) {}
  }
  return { page, url, ready: found };
}

async function scrapeKeywordsFromPage(page) {
  // Ejecuta en el DOM y extrae textos útiles
  const data = await page.evaluate(() => {
    const out = new Set();

    const pickText = (el) => (el?.textContent || "").trim();

    // celdas principales
    document.querySelectorAll("table tbody tr").forEach(tr => {
      const td = tr.querySelector("td");
      const t = pickText(td);
      if (t) out.add(t);
    });

    // chips/tags/badges
    document.querySelectorAll("[class*=chip],[class*=tag],[data-testid*=keyword]").forEach(el => {
      const t = pickText(el);
      if (t) out.add(t);
    });

    // anchors con ?keyword=
    document.querySelectorAll("a[href*='keyword=']").forEach(a => {
      const t = pickText(a);
      // si no hay texto, intenta parsear el query param
      const href = a.getAttribute("href") || "";
      const u = new URL(href, location.href);
      const k = u.searchParams.get("keyword") || "";
      if (t) out.add(t);
      if (k) out.add(k);
    });

    return Array.from(out);
  });
  return data.filter(Boolean);
}

async function scrapeTopListingsFromPage(page) {
  const items = await page.evaluate(() => {
    const list = [];
    document.querySelectorAll("a[href*='etsy.com/listing/']").forEach(a => {
      const title = (a.textContent || "").trim();
      const url = a.getAttribute("href") || "";
      if (url) list.push({ title, url });
    });
    // dedupe por url
    const seen = new Set();
    return list.filter(x => {
      if (seen.has(x.url)) return false;
      seen.add(x.url); return true;
    });
  });
  return items;
}

/* ----------------- intento JSON (fallback opcional) --------------- */

async function tryErankJson(pathname, query = {}) {
  const full = (u, q) => {
    const qs = new URLSearchParams(q || {}).toString();
    return `https://members.erank.com/${u}${qs ? "?" + qs : ""}`;
  };
  const url = full(pathname, query);
  const headers = {
    "Accept": "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    "Referer": "https://members.erank.com/keyword-tool",
    "User-Agent": UA
  };
  const state = await (await ensureContextLogged()).storageState();

  // 1) request.newContext con storageState
  const rqc = await request.newContext({ storageState: state, extraHTTPHeaders: headers });
  const r = await rqc.get(url);
  const ct = r.headers()["content-type"] || "";
  const text = await r.text();
  await rqc.dispose();

  if (r.ok() && ct.includes("application/json")) {
    try { return { url, json: JSON.parse(text) }; } catch {}
  }

  // 2) fetch dentro del navegador con XSRF
  const context = await ensureContextLogged(false);
  const page = await context.newPage();
  await page.goto("https://members.erank.com/keyword-tool", { waitUntil: "domcontentloaded", timeout: 120000 });
  const out = await page.evaluate(async ({ u }) => {
    const xsrf = (document.cookie.split(";").map(s => s.trim()).find(s => s.startsWith("XSRF-TOKEN=")) || "").split("=")[1] || "";
    try {
      const resp = await fetch(u, {
        method: "GET",
        headers: {
          "Accept": "application/json, text/plain, */*",
          "X-Requested-With": "XMLHttpRequest",
          "X-XSRF-TOKEN": decodeURIComponent(xsrf),
          "Referer": location.href
        },
        credentials: "include"
      });
      const type = resp.headers.get("content-type") || "";
      const text = await resp.text();
      return { ok: resp.ok, type, text };
    } catch (e) {
      return { ok: false, type: "", text: String(e) };
    }
  }, { u: url });
  await page.close();

  if (out.ok && String(out.type).includes("application/json")) {
    try { return { url, json: JSON.parse(out.text) }; } catch {}
  }
  return { url, json: null };
}

/* ----------------------------- routes ----------------------------- */

app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/erank/healthz", (_req, res) => res.json({ ok: true }));

// Palabras clave
app.get("/erank/keywords", async (req, res) => {
  try {
    const qRaw = String(req.query.q || "planner");
    const country = normalizeCountry(req.query.country || "US");
    const source  = String(req.query.marketplace || "etsy");

    // 1) Scraping directo del DOM renderizado (primario)
    const { page, url } = await openKeywordToolPage(qRaw, country, source);
    let keywords = await scrapeKeywordsFromPage(page);

    // 2) Si no trae nada, intenta JSON oficial como fallback
    if (!keywords.length) {
      const { json } = await tryErankJson("related-searches", { keyword: qRaw, country, source });
      if (json) {
        const arr = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
        keywords = arr.map(o => (o?.keyword || o?.name || o?.title || o?.term || o?.text || "").toString().trim()).filter(Boolean);
      }
    }

    await page.close();

    // filtro por query
    if (qRaw) keywords = keywords.filter(s => s.toLowerCase().includes(qRaw.toLowerCase()));

    res.json({ source: url, query: qRaw, count: keywords.length, results: keywords.slice(0, 100) });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// Listados top
app.get("/erank/top-listings", async (req, res) => {
  try {
    const qRaw = String(req.query.q || "planner");
    const country = normalizeCountry(req.query.country || "US");
    const source  = String(req.query.marketplace || "etsy");

    const { page, url } = await openKeywordToolPage(qRaw, country, source);
    let items = await scrapeTopListingsFromPage(page);

    // fallback JSON (por si existe endpoint estructurado)
    if (!items.length) {
      const { json } = await tryErankJson("top-listings", { keyword: qRaw, country, source });
      if (json) {
        const arr = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
        items = arr.map(o => ({
          title: String(o?.title || o?.name || "").trim(),
          url:   String(o?.url || o?.link || "").trim(),
          price: o?.price || "",
          shop:  o?.shop || ""
        })).filter(x => x.title || x.url);
      }
    }

    await page.close();
    res.json({ source: url, query: qRaw, count: items.length, items });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// Near matches (si no hay API, reutilizamos scraping de keywords)
app.get("/erank/near-matches", async (req, res) => {
  try {
    const qRaw = String(req.query.q || "planner");
    const country = normalizeCountry(req.query.country || "US");
    const source  = String(req.query.marketplace || "etsy");

    const { page, url } = await openKeywordToolPage(qRaw, country, source);
    let results = await scrapeKeywordsFromPage(page);

    // fallback JSON
    if (!results.length) {
      const { json } = await tryErankJson("near-matches", { keyword: qRaw, country, source });
      if (json) {
        const arr = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
        results = arr.map(o => (o?.keyword || o?.name || o?.title || o?.term || o?.text || "").toString().trim()).filter(Boolean);
      }
    }

    await page.close();
    res.json({ source: url, query: qRaw, count: results.length, results });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// Stats: intenta API; si no, responde con nota (podemos ampliar a scraping específico si te interesa)
app.get("/erank/stats", async (req, res) => {
  try {
    const qRaw = String(req.query.q || "planner");
    const country = normalizeCountry(req.query.country || "US");
    const source  = String(req.query.marketplace || "etsy");

    const { url, json } = await tryErankJson("stats", { keyword: qRaw, country, source });
    if (json) {
      return res.json({ source: url, query: qRaw, stats: json });
    }
    // fallback mínimo: abre la página para asegurar sesión y devolver aviso
    const { page } = await openKeywordToolPage(qRaw, country, source);
    await page.close();
    res.json({ source: url, query: qRaw, stats: null, note: "No JSON disponible; scraping de stats no implementado" });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// HTML crudo (debug)
app.get("/erank/raw", async (req, res) => {
  try {
    const qRaw = String(req.query.q || "planner");
    const country = normalizeCountry(req.query.country || "US");
    const source  = String(req.query.marketplace || "etsy");
    const { page, url } = await openKeywordToolPage(qRaw, country, source);
    // Espera un poco extra para que SPA pinte
    await page.waitForTimeout(2000);
    const html = await page.content();
    await page.close();
    res.json({ url, ok: !!html, length: html ? html.length : 0, preview: (html || "").slice(0, 2000) });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.get("/", (_req, res) => res.json({
  ok: true,
  routes: ["/erank/healthz","/erank/keywords","/erank/stats","/erank/top-listings","/erank/near-matches","/erank/raw"]
}));

app.listen(port, "0.0.0.0", () => {
  const routes = [];
  app._router.stack.forEach(mw => { if (mw.route) routes.push(Object.keys(mw.route.methods).join(",").toUpperCase()+" "+mw.route.path); });
  console.log("ROUTES:", routes);
  console.log("listening on", port);
});
