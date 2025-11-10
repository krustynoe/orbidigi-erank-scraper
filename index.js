// index.js — eRank JSON via Playwright (Sanctum login with request) + page.fetch fallback
// Requiere: "playwright": "1.56.1", "express", "cheerio"

globalThis.File = globalThis.File || class File {};

const express = require('express');
const { chromium, request: pwRequest } = require('playwright');
const cheerio = require('node:module').createRequire(__filename)('cheerio');

const app = express();
const port = process.env.PORT || 3000;

const EMAIL = (process.env.ERANK_EMAIL || '').trim();
const PASS  = (process.env.ERANK_PASSWORD || '').trim();
const UA    = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

let browser;
let context;
let lastLoginAt = 0;

// ---------- Login con Sanctum usando request, sin .fill ----------
async function ensureContextLogged(force = false) {
  const fresh = Date.now() - lastLoginAt < 20 * 60 * 1000;
  if (!force && fresh && context) return context;
  if (!EMAIL || !PASS) throw new Error('Faltan ERANK_EMAIL/ERANK_PASSWORD');

  const req = await pwRequest.newContext({ baseURL: 'https://members.erank.com', extraHTTPHeaders: { 'User-Agent': UA } });

  // 1) CSRF cookie
  const r1 = await req.get('/sanctum/csrf-cookie');
  if (!r1.ok()) throw new Error(`csrf-cookie ${r1.status()}`);
  const st1 = await req.storageState();
  const xsrf = decodeURIComponent((st1.cookies.find(c => c.name === 'XSRF-TOKEN')?.value) || '');

  // 2) POST /login
  const r2 = await req.post('/login', {
    form: { email: EMAIL, password: PASS },
    headers: { 'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest', ...(xsrf ? { 'X-XSRF-TOKEN': xsrf } : {}) }
  });
  if (!r2.ok()) throw new Error(`login ${r2.status()}`);

  // 3) Crear contexto autenticado
  const storage = await req.storageState();
  await req.dispose();

  if (!browser) {
    browser = await chromium.launch({ headless: true, args: ['--no-lsandbox', '--no-sandbox', '--disable-dev-shm-usage'] });
  }
  if (context) await context.close();
  context = await browser.new(c => c.newContext({ userAgent: UA, storageState: storage }));
  lastLoginAt = Date.now();
  return context;
}

// ---------- Lector JSON primario: context.request + headers ----------
async function fetchJson(pathname, query) {
  const ctx = await ensureContextLogged(false);
  const qs = new URLSearchParams(query || {}).toString();
  const url = `https://www.erank.com/${pathname}${qs ? `?${qs}` : ''}`.replace('//www.', '//'); // ajustar si tu base es members.erank.com
  const r = await ctx.request.get(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': 'https://members.erank.com/keyword-tool'
    }
  });
  if (!r.ok()) throw new Error(`GET ${pathname} -> ${r.status()}`);
  const ct = (r.headers()['content-type'] || '').toLowerCase();
  if (!ct.includes('application/json')) {
    // Devolver para que el caller haga fallback por page.fetch()
    return { url, data: null, status: r.status() };
  }
  return { url, data: await r.json(), status: r.status() };
}

// ---------- Fallback: page.evaluate(fetch) con XSRF + Cookie ----------
async function pageFetchJson(pathname, query) {
  const ctx = await ensureContextLogged(false);
  const page = await ctx.newPage();
  const url = `https://members.erank.com/${pathname}${query ? `?${new URLSearchParams(query).toString()}` : ''}`;
  await page.goto('https://members.erank.com/keyword-tool', { waitUntil: 'networkidle', timeout: 120000 });

  const out = await page.evaluate(async (u) => {
    // extrae tokens desde el documento actual
    const cookies = document.cookie || '';
    const m = /XSRF-TOKEN=([^;]+)/.exec(cookies);
    const xsrf = m ? decodeURIComponent(m[1]) : '';
    try {
      const resp = await fetch(u, {
        method: 'GET',
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'X-Requested-With': 'XMLHttpRequest',
          'X-XSRF-TOKEN': xsrf,
          'Referer': location.href
        },
        credentials: 'include'
      });
      const ct = resp.headers.get('content-type') || '';
      if (!resp.ok) return { ok: false, status: resp.status, body: await resp.text() };
      if (!ct.includes('application/json')) return { ok: false, status: resp.status, body: await resp.text() };
      return { ok: true, status: resp.status, data: await resp.json() };
    } catch (e) {
      return { ok: false, status: 0, body: String(e) };
    }
  }, url);

  await page.close();
  if (!out.ok) throw new Error(`pageFetch ${pathname} -> ${out.status} ${String(out.body).slice(0, 200)}`);
  return { url, data: out.data, status: out.status };
}

// ---------- Utilidades de parseo para fallback DOM ----------
const { load } = cheerio;
function pickKeywordsFromJson(obj) {
  const out = new Set();
  const roots = [obj?.data, obj?.keywords, obj?.results, obj?.related, obj?.items, obj?.trends, obj?.buzz];
  for (const r of roots) {
    if (Array.isArray(r)) {
      for (const it of r) {
        const t = (it && (it.keyword || it.name || it.title || it.term || it.text)) || '';
        if (t) out.add(String(t).trim());
      }
    }
  }
  return Array.from(out);
}
function pickKeywordsFromDom(html) {
  const $ = load(html);
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

// ---------- Endpoints ----------
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/erank/healthz', (_req, res) => res.json({ ok: true }));

app.get('/erank/keywords', async (req, res) => {
  try {
    const q = String(req.query.q || 'planner');
    const country = String(req.query.country || 'USA');
    const marketplace = String(req.query.marketplace || 'etsy');

    // 1º intento: JSON directo
    let { url, data } = await fetchJson('related-searches', { keyword: q, country, marketplace });

    // 2º si devolvió HTML o vacío, usar page.fetch con XSRF
    if (!data) ({ url, data } = await pageFetchJson('related-searches', { keyword: q, country, marketplace }));

    let results = pickably(data);
    if (q) results = results.filter(s => s.toLowerCase().includes(q.toLowerCase()));
    res.json({ source: url, query: q, count: results.length, results: results.slice(0, 100) });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.get('/erank/stats', async (req, res) => {
  try {
    const q = String(req.query.q || 'planner');
    const country = String(req.query.country || 'USA');
    const marketplace = String(req.query.marketplace || 'etsy');

    let { url, data } = await fetchJson('stats', { keyword: q, country, marketplace });
    if (!data) ({ url, data } = await pageFetchJson('stats', { keyword: q, country, marketplace }));

    res.json({ source: url, query: q, stats: data || {} });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.get('/erank/top-listings', async (req, res) => {
  try {
    const q = String(req.query.q || 'planner');
    const country = String(req.query.country || 'USA');
    const marketplace = String(req.query.marketplace || 'etsy');

    let { url, data } = await fetchJson('top-listings', { keyword: q, country, marketplace });
    if (!data) ({ url, data } = await pageFetchJson('top-listings', { keyword: q, country, marketplace }));
    const items = (data?.data || []).map(r => ({
      title: String(r?.title || r?.name || '').trim(),
      url: String(r?.url || r?.link || '').trim(),
      price: r?.price || '',
      shop: r?.shop || ''
    }));
    res.json({ source: url, query: q, count: items.length, items });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.get('/erank/near-matches', async (req, res) => {
  try {
    const q = String(req.query.q || 'planner');
    const country = String(req.query.country || 'USA');
    const marketplace = String(req.query.marketplace || 'etsy');

    let { url, data } = await fetchJson('near-matches', { keyword: q, country, marketplace });
    if (!data) ({ url, data } = await pageFetchJson('near-matches', { keyword: q, country, marketplace }));
    const results = pickably(data);
    res.json({ source: url, query: q, count: results.length, results });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.get('/erank/raw', async (req, res) => {
  try {
    const q = String(req.query.q || 'planner');
    const country = String(req.query.country || 'USA');
    const marketplace = String(req.query.country || 'USA');
    const ctx = await ensureContextLogged(false);
    const page = await ctx.newPage();
    const url = `https://members.erank.com/keyword-tool?country=${encodeURIComponent(country)}&source=${encodeURIComponent(marketplace)}&keyword=${encodeURIComponent(q)}`;
    await page.goto(url, { waitUntil: 'networkidle', timeout: 180000 });
    const html = await page.content();
    await page.close();
    res.json({ url, ok: !!html, length: html ? html.length : 0, preview: (html || '').slice(0, 2000) });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

function pickably(data) {
  if (!data) return [];
  return (Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : []).map(
    o => (o && (o.keyword || o.name || o.title || o.term || o.text) || '').toString().trim()
  ).filter(Boolean);
}

app.get('/', (_req, res) => {
  res.json({ ok: true, routes: ['/erank/healthz','/erank/keywords','/erank/stats','/erank/top-listings','/erank/near-matches','/erank/raw'] });
});

app.listen(port, '0.0.0.0', () => {
  const routes = [];
  app.use ? null : null;
  app._router?.stack?.forEach(mw => { if (mw.route) routes.push(Object.keys(mw.route.methods).join(',').toUpperCase() + ' ' + mw.route.path); });
  console.log('ROUTES:', routes);
  console.log('listening on', port);
});
