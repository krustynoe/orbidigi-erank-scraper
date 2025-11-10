// index.js — eRank Keyword Tool via Playwright (headless Chromium) + Laravel Sanctum/XSRF
// No usa ZenRows ni axios contra /near-matches|related-searches: las hace el propio navegador con headers (X-Inertia, CSRF).

globalThis.File = globalThis.File || class File {};

const express = require('express');
const axios   = require('axios'); // solo para health/debug si lo necesitas
const { chromium } = require('playwright');
const cheerio = require('cheerio');

const app  = express();
const port = process.env.PORT || 3000;

// ==== ENV ====
const EMAIL = (process.env.ERANK_EMAIL || '').trim();
const PASS  = (process.env.ERANK_PASSWORD || '').trim();
const UA    = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

// ==== Playwright session ====
let browser;
let context;            // page context with cookies
let lastLoginAt = 0;

async function ensureLoggedIn(force = false) {
  const fresh = Date.now() - lastLoginAt < 20 * 60 * 1000; // 20 min
  if (!force && fresh && context) return context;
  if (!EMAIL || !PASS) throw new Error('Faltan ERANK_EMAIL/ERANK_PASSWORD');

  // (Re)create browser
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  }
  if (context) await context.close();

  // Create a clean context and do full login using the UI (more robust with Sanctum)
  context = await browser.newPage({ userAgent: UA });

  // 1) Load login form to get fresh CSRF cookie
  await context.goto('https://members.erank.com/login', { waitUntil: 'domcontentloaded', timeout: 120000 });

  // 2) Fill and submit
  await context.fill('input[name="email"]', EMAIL);
  await context.fill('input[name="password"]', PASS);
  // prefer click on visible submit button, if form has it; fallback to pressing Enter
  const hasButton = await context.$('button[type="submit"],button:has-text("Sign in"),button:has-text("Login")');
  if (hasButton) {
    await hasButton.click();
  } else {
    await context.keyboard.press('Enter');
  }

  // 3) Wait for navigation to dashboard/keyword-tool
  await context.waitForLoadState('networkidle', { timeout: 120000 });
  const url = context.url();
  if (!/members\.erank\.com\/(dashboard|keyword\-tool|trends|trend\-buzz)/.test(url)) {
    // Some tenants redirect to / keyword-tool directly; try navigating explicitly
    await context.goto('https://members.erank.com/keyword-tool', { waitUntil: 'domcontentloaded', timeout: 120000 });
  }

  lastLoginAt = Date.now();
  return context;
}

// Utility: robust In-Page fetch for JSON endpoints that otherwise return Inertia HTML
async function pageFetchJson(pathname, query, refererPath = 'keyword-tool') {
  const ctx = await ensureLoggedIn(false);
  const page = ctx; // using single Page we created above

  // Ensure we are on same-origin page (so fetch carries cookies)
  if (!page.url().includes('members.erank.com')) {
    await page.goto(`https://members.erank.com/${refererPath}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  }

  // resolve XSRF + CSRF tokens from DOM
  const xsrf = await page.evaluate(() => {
    const c = document.cookie.split(';').map(s => s.trim()).find(s => s.startsWith('XSRF-TOKEN='));
    return c ? decodeURIComponent(c.split('=')[1]) : '';
  });
  const csrf = await page.evaluate(() => document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '');

  const qs = new URLSearchParams(query || {}).toString();
  const url = `https://members.erank.com/${pathname}${qs ? `?${qs}` : ''}`;

  const out = await page.evaluate(
    async ({ href, xsrfToken, csrfToken }) => {
      try {
        const r = await fetch(href, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            'X-Inertia': 'true',
            'X-XSRF-TOKEN': xsrfToken || '',
            'X-CSRF-TOKEN': csrfToken || ''
          },
          credentials: 'same-origin'
        });
        const ct = r.headers.get('content-type') || '';
        if (!r.ok) {
          return { ok: false, status: r.status, body: await r.text() };
        }
        if (!ct.includes('application/json')) {
          return { ok: false, status: r.status, body: await r.text() };
        }
        const data = await r.json();
        return { ok: true, status: r.status, data };
      } catch (e) {
        return { ok: false, status: 0, body: String(e) };
      }
    },
    { href: url, xsrfToken: xsrf, csrfToken: csrf }
  );

  if (!out.ok) {
    throw new Error(`pageFetchJson ${pathname} -> ${out.status} ${String(out.body).slice(0, 200)}`);
  }
  return { url, data: out.data };
}

// Fallback: parse keywords from the rendered table if needed
function extractKeywordsFromHtml(html) {
  const $ = cheerio.load(html);
  const out = new Set();
  $('table tbody tr').each((_, tr) => {
    const t = $(tr).find('td').first().text().trim();
    if (t) out.add(t);
  });
  $('[class*=chip],[class*=tag],[data-testid*=keyword]').each((_, el) => {
    const t = $(el).text().trim();
    if (t) out.add(t);
  });
  return Array.from(out);
}

// ========= Endpoints ==========

app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/erank/healthz', (_req, res) => res.json({ ok: true }));

// Keyword suggestions (uses page-level fetch with X-Inertia + CSRF)
app.get('/erank/keywords', async (req, res) => {
  const q           = String(req.query.q || 'planner');
  const country     = String(req.query.country || 'USA');
  const marketplace = String(req.query.marketplace || 'etsy');
  try {
    // First try JSON endpoint via in-page fetch with proper headers
    const rel = await pageFetchJson('related-searches', { keyword: q, country, marketplace }, 'keyword-tool');
    const arr = Array.isArray(rel.data?.data) ? rel.data.data : Array.isArray(rel.data) ? rel.data : [];
    let results = arr
      .map((r) => (r && (r.keyword || r.name || r.title || r.term || r.text)) || '')
      .map(String)
      .map(s => s.trim())
      .filter(Boolean);

    // fallback: render the page and scrape visible table if API returns empty
    if (results.length === 0) {
      const ctx = await ensureLoggedIn(false);
      await ctx.goto(`https://members.erank.com/keyword-tool?country=${encodeURIComponent(country)}&source=${encodeURIComponent(marketplace)}&keyword=${encodeURIComponent(q)}`, { waitUntil: 'networkidle', timeout: 240000 });
      const html = await ctx.content();
      const dom = extractKeywordsFromHtml(html);
      results = dom.filter(s => s.toLowerCase().includes(q.toLowerCase()));
      res.json({ source: `https://members.erank.com/keyword-tool?country=${encodeURIComponent(country)}&source=${encodeURIComponent(marketplace)}&keyword=${encodeURIComponent(q)}`, query: q, count: results.length, results: results.slice(0, 100) });
      return;
    }

    // filter by q if provided
    const filtered = q ? results.filter(s => s.toLowerCase().includes(q.toLowerCase())) : results;
    res.json({ source: rel.url, query: q, count: filtered.length, results: filtered.slice(0, 100) });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.get('/erank/stats', async (req, res) => {
  const q           = String(req.query.q || 'planner');
  const country     = String(req.query.country || 'USA');
  const marketplace = String(req.query.country || 'USA');
  try {
    const data = await pageFetchJson('stats', { keyword: q, country, marketplace }, 'keyword-tool');
    res.json({ source: data.url, query: q, stats: data.data });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.get('/erank/top-listings', async (req, res) => {
  const q           = String(req.query.q || 'planner');
  const country     = String(req.query.country || 'USA');
  const marketplace = String(req.query.marketplace || 'etsy');
  try {
    const data = await pageFetchJson('top-listings', { keyword: q, country, marketplace }, 'keyword-tool');
    const rows = Array.isArray(data.data) ? data.data : (Array.isArray(data.data?.data) ? data.data.data : []);
    const items = rows.map(r => ({
      title: String(r?.title || '').trim(),
      url:   String(r?.url   || r?.link || '').trim(),
      price: r?.price || '',
      shop:  r?.shop  || ''
    })).filter(x => x.title || x.url);
    res.json({ source: data.url, query: q, count: items.length, items });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.get('/erank/near-matches', async (req, res) => {
  const q           = String(req.query.q || 'planner');
  const country     = String(req.query.country || 'USA');
  const marketplace = String(req.query.marketplace || 'etsy');
  try {
    const data = await pageFetchJson('near-matches', { keyword: q, country, marketplace }, 'keyword-tool');
    const arr = Array.isArray(data.data?.data) ? data.data.data : Array.isArray(data.data) ? data.data : [];
    const results = arr.map(o => (o && (o.keyword || o.name || o.title || o.term || o.text) || '').toString().trim()).filter(Boolean);
    res.json({ source: data.url, query: q, count: results.length, results });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// For debugging: fetch and return first part of rendered HTML
app.get('/erank/raw', async (req, res) => {
  const q           = String(req.query.q || 'planner');
  const country     = String(req.query.country || 'USA');
  const marketplace = String(req.query.country || 'USA');
  try {
    const ctx = await ensureLoggedIn(false);
    await ctx.goto(`https://members.erank.com/keyword-tool?country=${encodeURIComponent(country)}&source=${encodeURIComponent(marketplace)}&keyword=${encodeURIComponent(q)}`, { waitUntil: 'networkidle', timeout: 240000 });
    const html = await ctx.content();
    res.json({ url: ctx.url(), ok: !!html, length: html ? html.length : 0, preview: (html || '').slice(0, 2000) });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// raíz de prueba
app.get('/', (_req, res) => {
  res.json({
    ok: true,
    routes: ['/erank/healthz','/erank/keywords','/erank/stats','/erank/top-listings','/erank/near-matches','/erank/raw']
  });
});

app.listen(port, '0.0.0.0', () => {
  const routes = [];
  app._router?.stack.forEach(mw => { if (mw.route) routes.push(Object.keys(mw.route.methods).join(',').toUpperCase() + ' ' + mw.route.path); });
  console.log('ROUTES:', routes);
  console.log('listening on', port);
});
