// index.js — eRank JSON via Playwright (Sanctum login) + fallback fetch; sin page.fill

globalThis.File = globalThis.File || class File {};

const express = require("express");
const { chromium, request } = require("playwright");
const cheerio = require("cheerio");

const app = express();
const port = process.env.PORT || 3000;

const EMAIL = (process.env.ERANK_EMAIL || "").trim();
const PASS  = (process.env.ERANK_PASSWORD || "").trim();
const UA    = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML,like Gecko) Chrome/122 Safari/537.36";

let browser, ctx;          // Browser / BrowserContext
let lastLoginAt = 0;

// ---- 1) Login a Sanctum por API, no por teclado ----
async function ensureContextLogged(force = false) {
  const fresh = (Date.now() - lastLoginAt) < 20 * 60 * 1000;
  if (!force && fresh && ctx) return ctx;
  if (!EMAIL || !PASS) throw new Error("Faltan ERANK_EMAIL/ERANK_PASSWORD");

  // CSRF + login usando Playwright.request
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

// ---- 2) Lector JSON por la misma sesión (primero request, luego fallback por page.evaluate(fetch)) ----
async function callErankJson(pathname, query = {}) {
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

  // 2.1 Intento directo con Playwright.request + cookies de la sesión
  const rqc = await request.newContext({ extraHTTPHeaders: headers });
  const state = await (await ensureContextLogged()).storageState();
  await rqc.addCookies(state.cookies.map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path })));

  let r = await rqc.get(url);
  const code = r.status();
  const ct = r.headers()["content-type"] || "";
  if (r.ok() && ct.includes("application/json")) {
    const data = await r.json();
    await rqc.dispose();
    return { url, data };
  }
  await rqc.dispose();

  // 2.2 Fallback: dentro del navegador con fetch + XSRF
  const page = await (await ensureContextLogged()).newPage();
  await page.goto("https://members.erank.com/keyword-tool", { waitUntil: "domcontentloaded", timeout: 120000 });
  const out = await page.evaluate(async ({ u }) => {
    const getCookie = (name) =>
      document.cookie.split(";").map(s => s.trim()).find(s => s.startsWith(name + "="))?.split("=")[1] || "";
    const xsrf = getCookie("XSRF-TOKEN");
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
      const body = type.includes("application/json") ? await resp.json() : await resp.text();
      return { ok: resp.ok && type.includes("application/json"), code: resp.status, body };
    } catch (e) {
      return { ok: false, code: 0, body: String(e) };
    }
  }, { u: url });
  await page.close();

  if (!out.ok) throw new Error(`JSON ${pathname} ${code} → ${String(out.body).slice(0, 180)}`);
  return { url, data: out.body };
}

// ---- 3) Auxiliares de parsing ----
function pickKeywords(payload) {
  const arr = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  return arr
    .map(o => (o?.keyword || o?.name || o?.title || o?.term || o?.text || "").toString().trim())
    .filter(Boolean);
}
function pickTopListings(payload) {
  const arr = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  return arr
    .map(o => ({
      title: String(o?.title || o?.name || "").trim(),
      url:   String(o?.url || o?.link || "").trim(),
      price: o?.price || "",
      shop:  o?.shop || ""
    }))
    .filter(x => x.title || x.url);
}

// ---- 4) Endpoints ----
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/erank/healthz", (_req, res) => res.json({ ok: true }));

app.get("/erank/keywords", async (req, res) => {
  try {
    const q = String(req.query.q || "planner");
    const country = String(req.query.country || "USA");
    const marketplace = String(req.query.marketplace || "etsy");
    const { url, data } = await callErankJson("related-searches", { keyword: q, country, marketplace });
    let results = pickKeywords(data);

    if (!results.length) {
      // Fallback a scraping si el backend devuelve HTML vacío
      const context = await ensureContextLogged(false);
      const page = await context.newPage();
      const urlPage = `https://members.erank.com/keyword-tool?country=${encodeURIComponent(country)}&source=${encodeURIComponent(marketplace)}&keyword=${encodeURIComponent(q)}`;
      await page.goto(urlPage, { waitUntil: "networkidle", timeout: 180000 });
      const html = await page.content();
      await page.close();
      const $ = cheerio.load(html);
      const out = new Set();
      $("table tbody tr").each((_, tr) => {
        const t = $(tr).find("td").first().text().trim();
        if (t) out.add(t);
      });
      $("[class*=chip],[class*=tag],[data-testid*=keyword]").each((_, el) => {
        const t = $(el).text().trim();
        if (t) out.add(t);
      });
      results = Array.from(out).filter(Boolean);
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
    const { url, data } = await callErankJson("stats", { keyword: q, country, marketplace });
    res.json({ source: url, query: q, stats: data });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.get("/erank/top-listings", async (req, res) => {
  try {
    const q = String(req.query.q || "planner");
    const country = String(req.query.country || "USA");
    const marketplace = String(req.query.marketplace || "etsy");
    const { url, data } = await callErankJson("top-listings", { keyword: q, country, marketplace });
    const items = pickTopListings(data);
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
    const { url, data } = await callErankJson("near-matches", { keyword: q, country, marketplace });
    const results = pickKeywords(data);
    res.json({ source: url, query: q, count: results.length, results });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.get("/erank/raw", async (req, res) => {
  try {
    const q = String(req.query.q || "planner");
    const country = String(req.query.country || "USA");
    const marketplace = String(req.query.marketplace || "etsy");
    const context = await ensureContextLogged(false);
    const page = await context.newPage();
    const url = `https://members.erank.com/keyword-tool?country=${encodeURIComponent(country)}&source=${encodeURIComponent(marketplace)}&keyword=${encodeURIComponent(q)}`;
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
  routes: ["/erank/healthz", "/erank/keywords", "/erank/stats", "/erank/top-listings", "/erank/near-matches", "/erank/raw"]
}));

app.listen(port, "0.0.0.0", () => {
  const routes = [];
  app._router.stack.forEach(mw => {
    if (mw.route) routes.push(Object.keys(mw.route.methods).join(",").toUpperCase() + " " + mw.route.path);
  });
  console.log("ROUTES:", routes);
  console.log("listening on", port);
});
