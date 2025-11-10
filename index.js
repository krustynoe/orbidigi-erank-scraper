// index.js — eRank scraper con login Sanctum + JSON + fallback HTML + DEBUG
globalThis.File = globalThis.File || class File {};

const express = require("express");
const { chromium, request } = require("playwright");
const cheerio = require("cheerio");

const app = express();
const port = process.env.PORT || 3000;

const EMAIL = (process.env.ERANK_EMAIL || "").trim();
const PASS  = (process.env.ERANK_PASSWORD || "").trim();
const UA    = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";
const DEBUG = String(process.env.DEBUG || "0") === "1";

let browser, ctx;
let lastLoginAt = 0;

function dbg(...args) { if (DEBUG) console.log(...args); }

// ---------- 1) Login Sanctum estable ----------
async function ensureContextLogged(force = false) {
  const fresh = (Date.now() - lastLoginAt) < 20 * 60 * 1000;
  if (!force && fresh && ctx) return ctx;
  if (!EMAIL || !PASS) throw new Error("Faltan ERANK_EMAIL/ERANK_PASSWORD");

  dbg("🔐 Login: creando request context para CSRF…");
  const rq = await request.newContext({ extraHTTPHeaders: { "User-Agent": UA } });
  const csrf = await rq.get("https://members.erank.com/sanctum/csrf-cookie");
  dbg("🔐 CSRF status:", csrf.status());
  if (!csrf.ok()) throw new Error("CSRF cookie falló");

  const xsrf = (await rq.storageState()).cookies.find(c => c.name === "XSRF-TOKEN")?.value || "";
  dbg("🔐 XSRF:", xsrf ? "(obtenido)" : "(vacío)");

  const login = await rq.post("https://members.erank.com/login", {
    form: { email: EMAIL, password: PASS },
    headers: {
      "X-Requested-With": "XMLHttpRequest",
      "X-XSRF-TOKEN": decodeURIComponent(xsrf),
      "User-Agent": UA
    }
  });
  dbg("🔐 Login status:", login.status());
  if (!login.ok()) throw new Error(`Login falló: ${login.status()}`);

  const state = await rq.storageState();
  await rq.dispose();

  if (!browser) {
    dbg("🧭 Lanzando Chromium…");
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"]
    });
  }
  if (ctx) await ctx.close();
  ctx = await browser.newContext({ userAgent: UA, storageState: state });
  lastLoginAt = Date.now();

  if (DEBUG) {
    const cookies = (await ctx.storageState()).cookies || [];
    dbg("🍪 Cookies en contexto:", cookies.map(c => c.name));
  }

  return ctx;
}

// ---------- 2) Petición JSON o fallback HTML ----------
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

  dbg("📤 [REQ] URL:", url);
  dbg("📩 [REQ] Headers:", headers);

  const state = await (await ensureContextLogged()).storageState();

  // Intento directo con cookies
  const rqc = await request.newContext({ storageState: state, extraHTTPHeaders: headers });
  let resp = await rqc.get(url);
  const code = resp.status();
  const ct = resp.headers()["content-type"] || "";
  const text = await resp.text();
  await rqc.dispose();

  dbg("📥 [RESP] status:", code, "| content-type:", ct, "| length:", text?.length || 0);

  if (resp.ok() && ct.includes("application/json")) {
    dbg("✅ [RESP] JSON directo OK");
    try {
      return { url, json: JSON.parse(text), html: null, mode: "direct-json" };
    } catch (e) {
      dbg("⚠️ [RESP] JSON parse falló:", e?.message || e);
    }
  }

  // Fallback dentro del navegador (XSRF + sesión viva)
  dbg("↪️ [FALLBACK] Entrando en fetch desde navegador con XSRF…");
  const context = await ensureContextLogged();
  const page = await context.newPage();

  // Escucha consola del navegador (útil si algo rompe dentro de page.evaluate)
  if (DEBUG) {
    page.on("console", msg => console.log("🧩 [PAGE]", msg.type(), msg.text()));
  }

  await page.goto("https://members.erank.com/keyword-tool", { waitUntil: "domcontentloaded", timeout: 120000 });
  const out = await page.evaluate(async ({ u }) => {
    const cookie = document.cookie || "";
    const xsrf = (cookie.split(";").map(s => s.trim()).find(s => s.startsWith("XSRF-TOKEN=")) || "").split("=")[1] || "";
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
      return { ok: resp.ok, type, text, xsrf_present: Boolean(xsrf) };
    } catch (e) {
      return { ok: false, type: "", text: String(e), xsrf_present: Boolean(xsrf) };
    }
  }, { u: url });
  await page.close();

  dbg("📥 [FALLBACK RESP] ok:", out.ok, "| type:", out.type, "| xsrf:", out.xsrf_present, "| length:", out.text?.length || 0);

  if (out.ok && out.type.includes("application/json")) {
    dbg("✅ [FALLBACK] JSON desde navegador OK");
    try {
      return { url, json: JSON.parse(out.text), html: null, mode: "browser-json" };
    } catch (e) {
      dbg("⚠️ [FALLBACK] parse falló:", e?.message || e);
      return { url, json: null, html: out.text, mode: "browser-text" };
    }
  }

  dbg("⚠️ [FALLBACK] Respuesta NO JSON → devolviendo HTML/text para scraping");
  return { url, json: null, html: out.text || text, mode: "browser-text" };
}

// ---------- 3) Parsers ----------
function pickKeywordsFromJSON(payload) {
  const arr = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  return arr.map(o => (o?.keyword || o?.name || o?.title || o?.term || o?.text || "").toString().trim()).filter(Boolean);
}
function pickKeywordsFromHTML(html) {
  const $ = cheerio.load(html);
  const out = new Set();
  // tabla
  $("table tbody tr").each((_, tr) => {
    const t = $(tr).find("td").first().text().trim();
    if (t) out.add(t);
  });
  // chips/tags y anchors con keyword=
  $("[class*=chip],[class*=tag],[data-testid*=keyword],a[href*='keyword=']").each((_, el) => {
    const t = $(el).text().trim();
    if (t) out.add(t);
  });
  const list = Array.from(out).filter(Boolean);
  return list;
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

// ---------- 4) Endpoints ----------
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/erank/healthz", (_req, res) => res.json({ ok: true, debug: DEBUG }));

app.get("/erank/keywords", async (req, res) => {
  try {
    const q = String(req.query.q || "planner");
    const country = String(req.query.country || "USA");
    const source = String(req.query.marketplace || "etsy");

    const { url, json, html, mode } = await callErank("related-searches", { keyword: q, country, source });
    dbg("🧪 [/keywords] mode:", mode, "| json?", Boolean(json), "| html?", Boolean(html));

    let results = [];
    if (json) results = pickKeywordsFromJSON(json);
    if (!results.length && html) results = pickKeywordsFromHTML(html);

    // filtro suave por q
    if (q) results = results.filter(s => s.toLowerCase().includes(q.toLowerCase()));

    dbg("🧪 [/keywords] resultados:", results.length);
    res.json({ source: url, query: q, count: results.length, results, mode, hadJSON: Boolean(json) });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

app.get("/erank/stats", async (req, res) => {
  try {
    const q = String(req.query.q || "planner");
    const country = String(req.query.country || "USA");
    const source = String(req.query.marketplace || "etsy");
    const { url, json, mode } = await callErank("stats", { keyword: q, country, source });
    dbg("🧪 [/stats] mode:", mode, "| keys:", json ? Object.keys(json).length : 0);
    res.json({ source: url, query: q, stats: json || {}, mode, hadJSON: Boolean(json) });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

app.get("/erank/top-listings", async (req, res) => {
  try {
    const q = String(req.query.q || "planner");
    const country = String(req.query.country || "USA");
    const source = String(req.query.marketplace || "etsy");
    const { url, json, html, mode } = await callErank("top-listings", { keyword: q, country, source });

    let items = [];
    if (json) items = pickTopListingsFromJSON(json);
    if (!items.length && html) {
      const $ = cheerio.load(html);
      $("a[href*='etsy.com/listing/']").each((_, a) => {
        const title = $(a).text().trim();
        const href = $(a).attr("href") || "";
        if (href) items.push({ title, url: href });
      });
    }
    dbg("🧪 [/top-listings] items:", items.length, "| mode:", mode);
    res.json({ source: url, query: q, count: items.length, items, mode, hadJSON: Boolean(json) });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

app.get("/erank/near-matches", async (req, res) => {
  try {
    const q = String(req.query.q || "planner");
    const country = String(req.query.country || "USA");
    const source = String(req.query.marketplace || "etsy");
    const { url, json, mode } = await callErank("near-matches", { keyword: q, country, source });
    const results = json ? pickKeywordsFromJSON(json) : [];
    dbg("🧪 [/near-matches] count:", results.length, "| mode:", mode);
    res.json({ source: url, query: q, count: results.length, results, mode, hadJSON: Boolean(json) });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

app.get("/erank/raw", async (req, res) => {
  try {
    const q = String(req.query.q || "planner");
    const country = String(req.query.country || "USA");
    const source = String(req.query.marketplace || "etsy");
    const context = await ensureContextLogged(false);
    const page = await context.newPage();
    const url = `https://members.erank.com/keyword-tool?country=${encodeURIComponent(country)}&source=${encodeURIComponent(source)}&keyword=${encodeURIComponent(q)}`;
    await page.goto(url, { waitUntil: "networkidle", timeout: 120000 });
    const html = await page.content();
    await page.close();
    res.json({ url, ok: !!html, length: html ? html.length : 0, preview: (html || "").slice(0, 2000) });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

app.get("/", (_req, res) =>
  res.json({
    ok: true,
    routes: ["/erank/healthz","/erank/keywords","/erank/stats","/erank/top-listings","/erank/near-matches","/erank/raw"],
    debug: DEBUG
  })
);

app.listen(port, "0.0.0.0", () => {
  console.log("✅ Server live on", port, "| DEBUG:", DEBUG);
});
