// index.js — eRank scraper con login Sanctum + JSON + fallback HTML + logs de depuración

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

// ---------- 1) Login Sanctum estable + logs ----------
async function ensureContextLogged(force = false) {
  const fresh = (Date.now() - lastLoginAt) < 20 * 60 * 1000;
  if (!force && fresh && ctx) return ctx;
  if (!EMAIL || !PASS) throw new Error("Faltan ERANK_EMAIL/ERANK_PASSWORD");

  console.log("🔐 Login: creando request context para CSRF…");
  const rq = await request.newContext({ extraHTTPHeaders: { "User-Agent": UA } });

  const csrf = await rq.get("https://members.erank.com/sanctum/csrf-cookie");
  console.log("🔐 CSRF status:", csrf.status());
  if (!csrf.ok()) throw new Error("CSRF cookie falló");

  const xsrf = (await rq.storageState()).cookies.find(c => c.name === "XSRF-TOKEN")?.value || "";
  console.log("🔐 XSRF:", xsrf ? "(obtenido)" : "(vacío)");

  const login = await rq.post("https://members.erank.com/login", {
    form: { email: EMAIL, password: PASS },
    headers: {
      "X-Requested-With": "XMLHttpRequest",
      "X-XSRF-TOKEN": decodeURIComponent(xsrf || ""),
      "User-Agent": UA
    }
  });
  console.log("🔐 Login status:", login.status());
  if (!login.ok()) throw new Error(`Login falló: ${login.status()}`);

  const state = await rq.storageState();
  await rq.dispose();

  if (!browser) {
    console.log("🧭 Lanzando Chromium…");
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"]
    });
  }
  if (ctx) await ctx.close();
  ctx = await browser.newContext({ userAgent: UA, storageState: state });

  const cookies = (await ctx.cookies()).map(c => c.name);
  console.log("🍪 Cookies en contexto:", cookies);

  lastLoginAt = Date.now();
  return ctx;
}

// ---------- 2) Petición JSON con fallback a navegador + logs ----------
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

  // 2.1 Intento directo con cookies (request.newContext + storageState)
  const state = await (await ensureContextLogged()).storageState();
  const rqc = await request.newContext({ storageState: state, extraHTTPHeaders: headers });

  console.log("📤 [REQ] URL:", url);
  console.log("📩 [REQ] Headers:", headers);

  const resp = await rqc.get(url);
  const code = resp.status();
  const ct   = resp.headers()["content-type"] || "";
  const text = await resp.text();
  await rqc.dispose();

  console.log(`📥 [RESP] status: ${code} | content-type: ${ct} | length: ${text ? text.length : 0}`);

  if (resp.ok() && ct.includes("application/json")) {
    try { return { url, json: JSON.parse(text), html: null, mode: "request-json" }; }
    catch { /* si falla JSON.parse pasamos a fallback */ }
  }

  // 2.2 Fallback: fetch desde el navegador con XSRF y sesión viva
  console.log("↪️ [FALLBACK] Entrando en fetch desde navegador con XSRF…");
  const context = await ensureContextLogged();
  const page = await context.newPage();
  page.on("console", (m) => {
    const s = m.text?.() || m.message || "";
    if (s) console.log("🧩 [PAGE] debug", s.slice(0, 200));
  });

  await page.goto("https://members.erank.com/keyword-tool", {
    waitUntil: "domcontentloaded",
    timeout: 120000
  });

  const out = await page.evaluate(async ({ u }) => {
    const xsrf = (document.cookie.split(";")
      .map(s => s.trim())
      .find(s => s.startsWith("XSRF-TOKEN=")) || "").split("=")[1] || "";
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
      return { ok: resp.ok, type, text, xsrf: !!xsrf };
    } catch (e) {
      return { ok: false, type: "", text: String(e), xsrf: !!xsrf };
    }
  }, { u: url });

  await page.close();

  console.log(`📥 [FALLBACK RESP] ok: ${out.ok} | type: ${out.type} | xsrf: ${out.xsrf} | length: ${out.text ? out.text.length : 0}`);

  if (out.ok && String(out.type).includes("application/json")) {
    try { return { url, json: JSON.parse(out.text), html: null, mode: "browser-json" }; }
    catch { /* caemos a html */ }
  }

  console.log("⚠️ [FALLBACK] Respuesta NO JSON → devolviendo HTML/text para scraping");
  return { url, json: null, html: out.text || text || "", mode: "browser-text" };
}

// ---------- 3) Parsers (JSON + HTML) ----------
function pickKeywordsFromJSON(payload) {
  const arr = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  return arr
    .map(o => (o?.keyword || o?.name || o?.title || o?.term || o?.text || "").toString().trim())
    .filter(Boolean);
}

function pickKeywordsFromHTML(html) {
  const $ = cheerio.load(html);
  const out = new Set();

  // Tabla principal del keyword tool
  $("table tbody tr").each((_, tr) => {
    const t = $(tr).find("td").first().text().trim();
    if (t) out.add(t);
  });

  // Chips/tags/links ligados a keywords
  $("[class*=chip],[class*=tag],[data-testid*=keyword],a[href*='keyword=']").each((_, el) => {
    const t = $(el).text().trim();
    if (t) out.add(t);
  });

  // Backups en headings
  $("h1,h2,h3,h4").each((_, el) => {
    const t = $(el).text().trim();
    if (t && /\bkeyword\b/i.test(t)) out.add(t);
  });

  return Array.from(out).filter(Boolean);
}

function pickTopListingsFromJSON(payload) {
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

function pickTopListingsFromHTML(html) {
  const $ = cheerio.load(html);
  const items = [];
  $("a[href*='etsy.com/listing/']").each((_, a) => {
    const title = $(a).text().trim();
    const href  = $(a).attr("href") || "";
    if (href) items.push({ title, url: href });
  });
  return items;
}

// ---------- 4) Endpoints ----------
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/erank/healthz", (_req, res) => res.json({ ok: true }));

app.get("/erank/keywords", async (req, res) => {
  try {
    const q       = String(req.query.q || "planner");
    const country = String(req.query.country || "USA");
    const source  = String(req.query.marketplace || "etsy");

    const { url, json, html, mode } = await callErank("related-searches", { keyword: q, country, source });
    let results = [];

    if (json) results = pickKeywordsFromJSON(json);
    if (!results.length && html) results = pickKeywordsFromHTML(html);
    if (q) results = results.filter(s => s.toLowerCase().includes(q.toLowerCase()));

    console.log(`🧪 [/keywords] mode: ${mode} | json? ${!!json} | html? ${!!html}`);
    console.log("🧪 [/keywords] resultados:", results.length);

    res.json({ source: url, query: q, count: results.length, results });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.get("/erank/stats", async (req, res) => {
  try {
    const q       = String(req.query.q || "planner");
    const country = String(req.query.country || "USA");
    const source  = String(req.query.marketplace || "etsy");

    const { url, json, html, mode } = await callErank("stats", { keyword: q, country, source });
    const stats = json || {};
    console.log(`🧪 [/stats] mode: ${mode} | keys: ${Object.keys(stats||{}).length}`);
    res.json({ source: url, query: q, stats });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.get("/erank/top-listings", async (req, res) => {
  try {
    const q       = String(req.query.q || "planner");
    const country = String(req.query.country || "USA");
    const source  = String(req.query.marketplace || "etsy");

    const { url, json, html, mode } = await callErank("top-listings", { keyword: q, country, source });
    let items = [];

    if (json) items = pickTopListingsFromJSON(json);
    if (!items.length && html) items = pickTopListingsFromHTML(html);

    console.log(`🧪 [/top-listings] items: ${items.length} | mode: ${mode}`);
    res.json({ source: url, query: q, count: items.length, items });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.get("/erank/near-matches", async (req, res) => {
  try {
    const q       = String(req.query.q || "planner");
    const country = String(req.query.country || "USA");
    const source  = String(req.query.marketplace || "etsy");

    const { url, json, html, mode } = await callErank("near-matches", { keyword: q, country, source });
    let results = [];

    if (json) results = pickKeywordsFromJSON(json);
    if (!results.length && html) results = pickKeywordsFromHTML(html);

    console.log(`🧪 [/near-matches] count: ${results.length} | mode: ${mode}`);
    res.json({ source: url, query: q, count: results.length, results });
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
    await page.goto(url, { waitUntil: "networkidle", timeout: 120000 });
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
  console.log("✅ Server live on", port);
});
