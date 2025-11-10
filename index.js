// index.js — eRank JSON via Playwright (login Sanctum) + fallback fetch; sin page.fill

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
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox","--disable-dev-shm-usage"] });
  }
  if (ctx) await ctx.close();
  ctx = await browser.newContext({ userAgent: UA, storageState: state });
  lastLoginAt = Date.now();
  return ctx;
}

// ---------- 2) Llamadas eRank: intenta JSON; si no, fetch del navegador; si aun así es HTML, lo devuelve ----------
async function callErank(pathname, query = {}) {
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

  // Intento 1: request.newContext con storageState
  const rqc = await request.newContext({ storageState: state, extraHTTPHeaders: headers });
  let r, code, ct, bodyText;
  try {
    r = await rqc.get(url);
    code = r.status();
    ct = r.headers()["content-type"] || "";
    bodyText = await r.text();
  } finally {
    await rqc.dispose();
  }
  if (r.ok() && ct.includes("application/json")) {
    return { url, json: JSON.parse(bodyText), html: null };
  }

  // Intento 2 (fallback): fetch desde dentro del navegador con XSRF
  const page = await (await ensureContextLogged()).newPage();
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
      return { ok: resp.ok, code: resp.status, type, text };
    } catch (e) {
      return { ok: false, code: 0, type: "", text: String(e) };
    }
  }, { u: url });
  await page.close();

  if (out.ok && String(out.type).includes("application/json")) {
    try { return { url, json: JSON.parse(out.text), html: null }; }
    catch { /* cae abajo y se devuelve como html */ }
  }

  // Si llegamos aquí, eRank respondió HTML: devolvemos el HTML para que la ruta pueda scrapear
  return { url, json: null, html: out.text || bodyText || "" };
}

// ---------- 3) Helpers de parsing ----------
function pickKeywordsFromJSON(payload) {
  const arr = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  return arr.map(o => (o?.keyword || o?.name || o?.title || o?.term || o?.text || "").toString().trim()).filter(Boolean);
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
function pickKeywordsFromHTML(html) {
  const $ = cheerio.load(html);
  const out = new Set();
  $("table tbody tr").each((_, tr) => { const t = $(tr).find("td").first().text().trim(); if (t) out.add(t); });
  $("[class*=chip],[class*=tag],[data-testid*=keyword],a[href*='keyword=']").each((_, el) => {
    const t = $(el).text().trim(); if (t) out.add(t);
  });
  return Array.from(out).filter(Boolean);
}

// ---------- 4) Endpoints ----------
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/erank/healthz", (_req, res) => res.json({ ok: true }));

app.get("/erank/keywords", async (req, res) => {
  try {
    const q = String(req.query.q || "planner");
    const country = String(req.query.country || "USA");
    const marketplace = String(req.query.marketplace || "etsy");

    const { url, json, html } = await callErank("related-searches", { keyword: q, country, marketplace });

    let results = [];
    if (json) {
      results = pickKeywordsFromJSON(json);
    }
    if (!results.length && html) {
      results = pickKeywordsFromHTML(html);
    }
    if (q) results = results.filter(s => s.toLowerCase().includes(q.toLowerCase()));

    res.json({ source: url, query: q, count: results.length, results: results.slice(0, 100) });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.get("/erank/stats", async (req, res) => {
  try {
    const q = String(req.query.q || "planner");
    const country = String(req.query.country || "USA");
    const marketplace = String(req.query.marketplace || "etsy");

    const { url, json } = await callErank("stats", { keyword: q, country, marketplace });
    if (!json) throw new Error("Stats no devolvió JSON");
    res.json({ source: url, query: q, stats: json });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.get("/erank/top-listings", async (req, res) => {
  try {
    const q = String(req.query.q || "planner");
    const country = String(req.query.country || "USA");
    const marketplace = String(req.query.marketplace || "etsy");

    const { url, json, html } = await callErank("top-listings", { keyword: q, country, marketplace });

    let items = [];
    if (json) {
      items = pickTopListingsFromJSON(json);
    }
    if (!items.length && html) {
      // Fallback muy básico desde HTML (si cambian el layout, seguirá vacío)
      const $ = cheerio.load(html);
      items = [];
      $("a[href*='etsy.com/listing/']").each((_, a) => {
        const title = $(a).text().trim();
        const url = $(a).attr("href") || "";
        if (url) items.push({ title, url });
      });
    }

    res.json({ source: url, query: q, count: items.length, items });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.get("/erank/near-matches", async (req, res) => {
  try {
    const q = String(req.query.q || "planner");
    const country = String(req.query.country || "USA");
    const marketplace = String(req.query.marketplace || "etsy");

    const { url, json } = await callErank("near-matches", { keyword: q, country, marketplace });
    const results = json ? pickKeywordsFromJSON(json) : [];
    res.json({ source: url, query: q, count: results.length, results });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// Debug: HTML crudo del Keyword Tool
app.get("/erank/raw", async (req, res) => {
  try {
    const q = String(req.query.q || "planner");
    const country = String(req.query.country || "USA");
    const marketplace = String(req.query.marketplace || "etsy");
    const context = await ensureContextLogged(false);
    const page = await context.newPage();
    const url = `https://members.erank.com/keyword-tool?country=${encodeURIComponent(country)}&source=${encodeURIComponent(marketplace)}&keyword=${encodeURIComponent(q)}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
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
