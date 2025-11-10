// index.js — eRank JSON+HTML (Inertia-safe) via Playwright (Sanctum login)

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

// ---------- 1) Login Sanctum ----------
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
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });

  if (ctx) await ctx.close();
  ctx = await browser.newContext({ userAgent: UA, storageState: state });
  lastLoginAt = Date.now();
  return ctx;
}

// ---------- 2) Llamadas eRank robustas ----------
async function callErank(pathname, query = {}) {
  const qs = new URLSearchParams(query || {}).toString();
  const url = `https://members.erank.com/${pathname}${qs ? "?" + qs : ""}`;
  const headers = {
    "Accept": "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    "Referer": "https://members.erank.com/keyword-tool",
    "User-Agent": UA
  };

  const context = await ensureContextLogged();
  const state = await context.storageState();
  const rqc = await request.newContext({ extraHTTPHeaders: headers, storageState: state });

  const r = await rqc.get(url);
  const code = r.status();
  const ct = r.headers()["content-type"] || "";
  const text = await r.text();
  await rqc.dispose();

  // Si no es JSON, hacer fallback con navegador
  if (!ct.includes("application/json")) {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 180000 });
    const html = await page.content();
    await page.close();
    return { url, html, json: null };
  }

  try {
    const json = JSON.parse(text);
    return { url, json, html: null };
  } catch {
    return { url, json: null, html: text };
  }
}

// ---------- 3) Parsers seguros ----------
function extractKeywords(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload.map(x => x.keyword || x.name || x.title || "").filter(Boolean);

  if (payload.props) {
    const props = payload.props;
    const data = props.keywords || props.data || props.results || [];
    if (Array.isArray(data))
      return data.map(x => x.keyword || x.name || x.title || "").filter(Boolean);
  }

  if (payload.data && Array.isArray(payload.data))
    return payload.data.map(x => x.keyword || x.name || x.title || "").filter(Boolean);

  return [];
}

function extractFromHTML(html) {
  const $ = cheerio.load(html || "");
  const out = new Set();
  $("table tbody tr").each((_, tr) => {
    const t = $(tr).find("td").first().text().trim();
    if (t) out.add(t);
  });
  $("[class*=chip],[class*=tag],[data-testid*=keyword],a[href*='keyword=']").each((_, el) => {
    const t = $(el).text().trim();
    if (t) out.add(t);
  });
  return Array.from(out);
}

// ---------- 4) Endpoints ----------
app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.get("/erank/keywords", async (req, res) => {
  try {
    const q = String(req.query.q || "planner");
    const country = String(req.query.country || "USA");
    const source = String(req.query.marketplace || "etsy");

    const { url, json, html } = await callErank("related-searches", { keyword: q, country, source });

    let results = extractKeywords(json);
    if (!results.length && html) results = extractFromHTML(html);

    res.json({ source: url, query: q, count: results.length, results });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/erank/stats", async (req, res) => {
  try {
    const q = String(req.query.q || "planner");
    const country = String(req.query.country || "USA");
    const source = String(req.query.marketplace || "etsy");
    const { url, json, html } = await callErank("stats", { keyword: q, country, source });
    res.json({ source: url, query: q, stats: json || { htmlLength: html?.length || 0 } });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get("/erank/top-listings", async (req, res) => {
  try {
    const q = String(req.query.q || "planner");
    const country = String(req.query.country || "USA");
    const source = String(req.query.marketplace || "etsy");
    const { url, json, html } = await callErank("top-listings", { keyword: q, country, source });
    let items = [];
    if (json?.data && Array.isArray(json.data))
      items = json.data.map(x => ({ title: x.title, url: x.url })).filter(x => x.title && x.url);
    if (!items.length && html) {
      const $ = cheerio.load(html);
      $("a[href*='etsy.com/listing/']").each((_, a) => {
        const t = $(a).text().trim(), u = $(a).attr("href");
        if (u) items.push({ title: t, url: u });
      });
    }
    res.json({ source: url, query: q, count: items.length, items });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get("/erank/near-matches", async (req, res) => {
  try {
    const q = String(req.query.q || "planner");
    const country = String(req.query.country || "USA");
    const source = String(req.query.marketplace || "etsy");
    const { url, json, html } = await callErank("near-matches", { keyword: q, country, source });
    let results = extractKeywords(json);
    if (!results.length && html) results = extractFromHTML(html);
    res.json({ source: url, query: q, count: results.length, results });
  } catch (e) { res.status(502).json({ error: e.message }); }
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
    res.json({ url, ok: !!html, length: html.length, preview: html.slice(0, 1000) });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get("/", (_req, res) => res.json({
  ok: true,
  routes: ["/erank/keywords","/erank/stats","/erank/top-listings","/erank/near-matches","/erank/raw"]
}));

app.listen(port, "0.0.0.0", () => console.log("✅ Server online en puerto", port));
