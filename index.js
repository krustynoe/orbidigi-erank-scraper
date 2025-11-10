// index.js — eRank scraper sólido: login Sanctum + JSON embebido en HTML (Inertia) + fallback DOM
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

// --- util: normalizar país ---
function normCountry(c) {
  const m = String(c || "").toUpperCase();
  if (m === "USA") return "US";
  return m;
}

// ---------- 1) Login Sanctum (API, sin teclado) ----------
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
      args: ["--no-sandbox","--disable-dev-shm-usage"]
    });
  }
  if (ctx) await ctx.close();
  ctx = await browser.newContext({ userAgent: UA, storageState: state });
  lastLoginAt = Date.now();
  return ctx;
}

// ---------- 2) Extraer JSON embebido desde keyword-tool ----------
async function extractFromKeywordTool(context, { q, country, source }) {
  // abrir la página real (no el endpoint)
  const toolUrl = `https://members.erank.com/keyword-tool?country=${encodeURIComponent(country)}&source=${encodeURIComponent(source)}&keyword=${encodeURIComponent(q)}`;
  const page = await context.newPage();
  await page.goto(toolUrl, { waitUntil: "domcontentloaded", timeout: 180000 });

  // Dentro de la página: intentar varias fuentes de JSON embebido (Inertia / script JSON / window.__*)
  const payload = await page.evaluate(() => {
    const result = { dataPage: null, scripts: [], globals: {} };

    // 1) Inertia: data-page
    const el = document.querySelector("[data-page]");
    if (el) {
      try { result.dataPage = JSON.parse(el.getAttribute("data-page") || "null"); } catch {}
    }

    // 2) <script type="application/json">
    document.querySelectorAll('script[type="application/json"]').forEach(s => {
      try { result.scripts.push(JSON.parse(s.textContent || "null")); } catch {}
    });

    // 3) window.__* variables con JSON
    try {
      for (const k of Object.getOwnPropertyNames(window)) {
        if (k.startsWith("__") || k.startsWith("ERANK") || k.includes("INITIAL")) {
          const v = window[k];
          if (v && (typeof v === "object" || typeof v === "string")) {
            result.globals[k] = v;
          }
        }
      }
    } catch {}

    return result;
  });

  // HTML completo por si hace falta scrapping DOM
  const html = await page.content();
  await page.close();

  return { toolUrl, payload, html };
}

// ---------- 3) Unificar lectura: endpoint JSON directo o extracción desde la página ----------
async function getErankData({ q, country, source }) {
  const context = await ensureContextLogged();
  country = normCountry(country);

  // 3.1 Primero, abrir la página y extraer JSON embebido (más fiable porque tus logs muestran siempre HTML)
  const { toolUrl, payload, html } = await extractFromKeywordTool(context, { q, country, source });

  // Intenta encontrar colecciones en el JSON embebido (Inertia/props/…)
  function fromEmbedded() {
    const buckets = { related: [], near: [], top: [], stats: {} };

    const candidates = [];
    if (payload?.dataPage) candidates.push(payload.dataPage);
    if (Array.isArray(payload?.scripts)) candidates.push(...payload.scripts);
    if (payload?.globals) candidates.push(payload.globals);

    const collectStrings = (arr, into) => {
      for (const s of arr) {
        const t = (s || "").toString().trim();
        if (t) into.add(t);
      }
    };

    const relatedSet = new Set();
    const nearSet = new Set();
    const topArr = [];
    let statsObj = {};

    const visit = (node) => {
      if (!node) return;

      // Heurísticas: busca arrays con keywords, terms, nearMatches, topListings, etc.
      if (Array.isArray(node)) {
        // ¿parecen near/related?
        const maybeStrings = node.filter(v => typeof v === "string" || (typeof v === "object" && (v.keyword || v.term || v.name || v.title)));
        if (maybeStrings.length >= 1) {
          const tmp = [];
          for (const it of maybeStrings) {
            if (typeof it === "string") tmp.push(it);
            else tmp.push(it.keyword || it.term || it.name || it.title);
          }
          collectStrings(tmp, relatedSet); // luego diferenciamos por endpoints
        }
        // ¿parecen top listings?
        const maybeListings = node.filter(v => v && (v.url || v.link) && (v.title || v.name));
        if (maybeListings.length) {
          for (const it of maybeListings) {
            topArr.push({
              title: String(it.title || it.name || "").trim(),
              url: String(it.url || it.link || "").trim(),
              price: it.price || "",
              shop: it.shop || ""
            });
          }
        }
      } else if (typeof node === "object") {
        // Si hay claves muy obvias
        for (const [k, v] of Object.entries(node)) {
          const kk = k.toLowerCase();
          if (kk.includes("related") || kk.includes("suggestion") || kk.includes("keywords")) {
            if (Array.isArray(v)) {
              const tmp = v.map(it => typeof it === "string" ? it : (it?.keyword || it?.term || it?.name || it?.title || ""));
              collectStrings(tmp, relatedSet);
            }
          }
          if (kk.includes("near") || kk.includes("matches")) {
            if (Array.isArray(v)) {
              const tmp = v.map(it => typeof it === "string" ? it : (it?.keyword || it?.term || it?.name || it?.title || ""));
              collectStrings(tmp, nearSet);
            }
          }
          if (kk.includes("top") && kk.includes("listing")) {
            if (Array.isArray(v)) {
              for (const it of v) {
                topArr.push({
                  title: String(it?.title || it?.name || "").trim(),
                  url: String(it?.url || it?.link || "").trim(),
                  price: it?.price || "",
                  shop: it?.shop || ""
                });
              }
            }
          }
          if (kk.includes("stat") || kk.includes("metrics")) {
            if (typeof v === "object") statsObj = { ...statsObj, ...v };
          }
          // Recursivo
          if (v && (typeof v === "object")) visit(v);
        }
      }
    };

    for (const c of candidates) visit(c);

    buckets.related = Array.from(relatedSet).filter(Boolean);
    buckets.near = Array.from(nearSet).filter(Boolean);
    buckets.top = topArr.filter(x => x.url || x.title);
    buckets.stats = statsObj;

    return { toolUrl, ...buckets };
  }

  const embedded = fromEmbedded();

  // Si no hay nada en embebido, intentar scraping DOM básico
  if (!embedded.related.length && !embedded.near.length && !embedded.top.length && !Object.keys(embedded.stats || {}).length) {
    const $ = cheerio.load(html);
    const rel = new Set();
    $("table tbody tr").each((_, tr) => { const t = $(tr).find("td").first().text().trim(); if (t) rel.add(t); });
    $("[class*=chip],[class*=tag],[data-testid*=keyword],a[href*='keyword=']").each((_, el) => { const t = $(el).text().trim(); if (t) rel.add(t); });

    const top = [];
    $("a[href*='etsy.com/listing/']").each((_, a) => {
      const title = $(a).text().trim();
      const url = $(a).attr("href") || "";
      if (url) top.push({ title, url });
    });

    return { toolUrl, related: Array.from(rel), near: [], top, stats: {} };
  }

  return embedded;
}

// ---------- 4) Endpoints ----------
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/erank/healthz", (_req, res) => res.json({ ok: true }));

app.get("/erank/keywords", async (req, res) => {
  try {
    const q = String(req.query.q || "planner");
    const country = normCountry(req.query.country || "US");
    const source = String(req.query.marketplace || "etsy");

    // 1º: intentar endpoint (por si algún día vuelve el JSON)
    const ctx = await ensureContextLogged();
    const headers = {
      "Accept": "application/json, text/plain, */*",
      "X-Requested-With": "XMLHttpRequest",
      "Referer": "https://members.erank.com/keyword-tool",
      "User-Agent": UA
    };
    const urlJson = `https://members.erank.com/related-searches?keyword=${encodeURIComponent(q)}&country=${encodeURIComponent(country)}&source=${encodeURIComponent(source)}`;
    const r = await ctx.request.get(urlJson, { headers });
    const ct = r.headers()["content-type"] || "";
    let results = [];
    if (r.ok() && ct.includes("application/json")) {
      const data = await r.json();
      const arr = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
      results = arr.map(o => (o?.keyword || o?.name || o?.title || o?.term || o?.text || "").toString().trim()).filter(Boolean);
    }

    // 2º: si JSON no vino o vino vacío, usa extracción embebida en la página
    if (!results.length) {
      const emb = await getErankData({ q, country, source });
      results = emb.related || [];
      if (!results.length) results = emb.near || [];
      if (q) results = results.filter(s => s.toLowerCase().includes(q.toLowerCase()));
      return res.json({ source: emb.toolUrl, query: q, count: results.length, results: results.slice(0, 100) });
    }

    res.json({ source: urlJson, query: q, count: results.length, results: results.slice(0, 100) });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

app.get("/erank/near-matches", async (req, res) => {
  try {
    const q = String(req.query.q || "planner");
    const country = normCountry(req.query.country || "US");
    const source = String(req.query.marketplace || "etsy");

    const emb = await getErankData({ q, country, source });
    const results = emb.near || [];
    res.json({ source: emb.toolUrl, query: q, count: results.length, results });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

app.get("/erank/top-listings", async (req, res) => {
  try {
    const q = String(req.query.q || "planner");
    const country = normCountry(req.query.country || "US");
    const source = String(req.query.marketplace || "etsy");

    const emb = await getErankData({ q, country, source });
    const items = emb.top || [];
    res.json({ source: emb.toolUrl, query: q, count: items.length, items });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

app.get("/erank/stats", async (req, res) => {
  try {
    const q = String(req.query.q || "planner");
    const country = normCountry(req.query.country || "US");
    const source = String(req.query.marketplace || "etsy");

    const emb = await getErankData({ q, country, source });
    const stats = emb.stats || {};
    res.json({ source: emb.toolUrl, query: q, stats });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

// Debug: HTML crudo (vista)
app.get("/erank/raw", async (req, res) => {
  try {
    const q = String(req.query.q || "planner");
    const country = normCountry(req.query.country || "US");
    const source = String(req.query.marketplace || "etsy");
    const context = await ensureContextLogged(false);
    const page = await context.newPage();
    const url = `https://members.erank.com/keyword-tool?country=${encodeURIComponent(country)}&source=${encodeURIComponent(source)}&keyword=${encodeURIComponent(q)}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 180000 });
    const html = await page.content();
    await page.close();
    res.json({ url, ok: !!html, length: html ? html.length : 0, preview: (html || "").slice(0, 2000) });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

app.get("/", (_req, res) => res.json({
  ok: true,
  routes: ["/erank/healthz","/erank/keywords","/erank/stats","/erank/top-listings","/erank/near-matches","/erank/raw"]
}));

app.listen(port, "0.0.0.0", () => {
  console.log("✅ Server live on", port);
});
