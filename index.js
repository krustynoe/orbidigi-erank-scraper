// index.js — eRank Keyword Tool con Playwright (Chromium real, headless) + login Sanctum
// Node 18 CJS para Render.

globalThis.File = globalThis.File || class File {};

const express = require('express');
const { chromium, request: pwRequest } = require('playwright');
const cheerio = require('cheerio');

const app = express();
const port = process.env.PORT || 3000;

// ===== ENV =====
const EMAIL = (process.env.ERANK_EMAIL || '').trim();
const PASS  = (process.env.ERANK_PASSWORD || '').trim();
const UA    = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

// ===== Estado global =====
let browser;
let context;
let lastLoginTs = 0;

// ===== Helpers =====
function getCookieValue(storageState, name) {
  const c = storageState?.cookies?.find(k => k.name === name);
  return c ? c.value : '';
}

// ===== Login Sanctum =====
async function ensureLoggedContext(force=false) {
  const fresh = Date.now() - lastLoginTs < 20 * 60 * 1000;
  if (!force && fresh && context) return context;

  if (!EMAIL || !PASS) throw new Error('Faltan ERANK_EMAIL/ERANK_PASSWORD');

  const req = await pwRequest.newContext({
    baseURL: 'https://members.erank.com',
    extraHTTPHeaders: { 'User-Agent': UA }
  });

  let r = await req.get('/sanctum/csrf-cookie');
  if (!r.ok()) throw new Error('CSRF-cookie falló');
  let state = await req.storageState();
  const xsrf = decodeURIComponent(getCookieValue(state, 'XSRF-TOKEN') || '');

  const res = await req.post('/login', {
    form: { email: EMAIL, password: PASS },
    headers: {
      'User-Agent': UA,
      'X-Requested-With': 'XMLHttpRequest',
      ...(xsrf ? { 'X-XSRF-TOKEN': xsrf } : {})
    }
  });
  if (!res.ok()) throw new Error(`Login eRank fallido: ${res.status()}`);
  state = await req.storageState();

  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    });
  }
  if (context) await context.close();
  context = await browser.newContext({
    userAgent: UA,
    storageState: state,
    viewport: { width: 1366, height: 900 },
    deviceScaleFactor: 1
  });
  lastLoginTs = Date.now();
  return context;
}

// ===== Scraper Keyword Tool =====
async function scrapeKeywordTool({ q, country, marketplace }) {
  const ctx = await ensureLoggedContext(false);
  const page = await ctx.newPage();

  const url = `https://members.erank.com/keyword-tool?country=${encodeURIComponent(country)}&source=${encodeURIComponent(marketplace)}&keyword=${encodeURIComponent(q)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 240000 });

  const selectors = [
    'table tbody tr',
    '[role="table"] [role="row"]',
    '.keywords table tbody tr'
  ];

  let found = false;
  for (const sel of selectors) {
    try {
      await page.waitForSelector(sel, { timeout: 45000 });
      found = true;
      break;
    } catch {}
  }

  const html = await page.content();
  const $ = cheerio.load(html);
  const out = new Set();

  $('table tbody tr').each((_, tr) => {
    const t = $(tr).find('td').first().text().trim();
    if (t) out.add(t);
  });

  $('[role="table"] [role="row"]').each((_, row) => {
    const t = $(row).find('[role="cell"]').first().text().trim();
    if (t) out.add(t);
  });

  $('[class*=chip],[class*=tag],[data-testid*=keyword]').each((_, el) => {
    const t = $(el).text().trim();
    if (t) out.add(t);
  });

  await page.close();
  return { source: url, results: Array.from(out).filter(s => s && s.length <= 64 && !/^https?:\/\//i.test(s)) };
}

// ===== Endpoints =====
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/erank/healthz', (_req, res) => res.json({ ok: true }));

app.get('/erank/keywords', async (req, res) => {
  try {
    const q           = String(req.query.q || 'planner');
    const country     = String(req.query.country || 'USA');
    const marketplace = String(req.query.marketplace || 'etsy');
    const { source, results } = await scrapeKeywordTool({ q, country, marketplace });
    const filtered = q ? results.filter(s => s.toLowerCase().includes(q.toLowerCase())) : results;
    res.json({ source, query: q, count: filtered.length, results: filtered.slice(0, 100) });
  } catch (e) {
    try {
      await ensureLoggedContext(true);
      const q           = String(req.query.q || 'planner');
      const country     = String(req.query.country || 'USA');
      const marketplace = String(req.query.marketplace || 'etsy');
      const { source, results } = await scrapeKeywordTool({ q, country, marketplace });
      const filtered = q ? results.filter(s => s.toLowerCase().includes(q.toLowerCase())) : results;
      return res.json({ source, query: q, count: filtered.length, results: filtered.slice(0, 100) });
    } catch (err) {
      return res.status(502).json({ error: String(err.message || err) });
    }
  }
});

app.get('/erank/raw', async (req, res) => {
  try {
    const q           = String(req.query.q || 'planner');
    const country     = String(req.query.country || 'USA');
    const marketplace = String(req.query.marketplace || 'etsy');
    const ctx = await ensureLoggedContext(false);
    const page = await ctx.newPage();
    const url = `https://members.erank.com/keyword-tool?country=${encodeURIComponent(country)}&source=${encodeURIComponent(marketplace)}&keyword=${encodeURIComponent(q)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 240000 });
    const html = await page.content();
    await page.close();
    res.json({ url, ok: !!html, preview: String(html).slice(0, 1800) });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.listen(port, '0.0.0.0', () => {
  const routes = [];
  app._router?.stack.forEach(mw => {
    if (mw.route) routes.push(Object.keys(mw.route.methods).join(',').toUpperCase() + ' ' + mw.route.path);
  });
  console.log('ROUTES:', routes);
  console.log('listening on', port);
});
