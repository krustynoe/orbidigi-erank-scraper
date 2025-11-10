// index.js — eRank via Playwright (Chromium) + Sanctum login + API (page-fetch) + DOM fallback
// Alinear con:   Dockerfile: FROM mcr.microsoft.com/playwright:v1.56.1-jammy
//                package.json: "playwright": "1.56.1", "engines": { "node": ">=18" }

globalThis.File = globalThis.File || class File {};

const express = require('express');
const { chromium, request: pwRequest } = require('playwright');
const cheerio = require('cheerio');

const app = express();
const port = process.env.PORT || 10000;

// --- ENV ---
const EMAIL = (process.env.ERANK_EMAIL || '').trim();
const PASS  = (process.env.ERANK_PASSWORD || '').trim();
const UA    = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

// --- Playwright session state ---
let browser;          // singleton
let context;          // logged-in context
let lastLoginTs = 0;  // ms epoch

// --- helpers ---
function getCookieValue(state, name) {
  const c = (state?.cookies || []).find(k => k.name === name);
  return c ? c.value : '';
}

async function ensureLoggedContext(force = false) {
  const fresh = Date.now() - lastLoginTs < 20 * 60 * 1000;
  if (!force && fresh && context) return context;
  if (!EMAIL || !PASS) throw new Error('Faltan ERANK_EMAIL/ERANK_PASSWORD');

  // 1) Login con cliente HTTP de Playwright (maneja cookies/CSRF)
  const req = await pwRequest.newContext({
    baseURL: 'https://members.erank.com',
    extraHTTPHeaders: { 'User-Agent': UA }
  });

  const r = await req.get('/sanctum/csrf-cookie');
  if (!r.ok()) throw new Error(`CSRF cookie ${r.status()}`);
  const xsrf = decodeURIComponent(getCookieValue(await req.storageState(), 'XSRF-TOKEN') || '');

  const res = await req.post('/login', {
    form: { email: EMAIL, password: PASS },
    headers: {
      'User-Agent': UA,
      'X-Requested-With': 'XMLHttpRequest',
      ...(xsrf ? { 'X-XSRF-TOKEN': xsrf } : {})
    }
  });
  if (!res.ok()) throw new Error(`Login eRank fallido ${res.status()}`);

  const storageState = await req.storageState();

  // 2) Navegador/Contexto con la sesión
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-bundle-adjust', '--no-sandbox', '--disable-dev-shm-usage']
    });
  }
  if (context) await context.close();

  context = await browser.new_context?.( { storageState, userAgent: UA, viewport: { width: 1366, height: 900 } } )
         || await browser.newContext({ storageState, userAgent: UA, viewport: { width: 1366, height: 900 } });

  // Validación rápida de sesión
  const p = await context.newPage();
  await p.goto('https://members.erank.com/dashboard', { waitUntil: 'networkidle', timeout: 180000 }).catch(() => {});
  const url = p.url();
  await p.close();
  if (/\/login/i.test(url)) {
    // Forzar re-login si redirige a login
    await req.dispose();
    return ensureLoggedContext(true);
  }

  await req.dispose();
  lastLoginTs = Date.now();
  return context;
}

// --- API helpers (server-side) ---
async function fetchJson(pathname, query) {
  const ctx = await ensureLoggedContext(false);
  const qs = new URLSearchParams(query || {}).toString();
  const url = `https://members.erank.com/${pathname}${qs ? `?${qs}` : ''}`;
  const headers = {
    'User-Agent': UA,
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': 'https://members.erank.com',
    'Referer': 'https://members.erank.com/keyword-tool'
  };

  let res = await ctx.request.get(url, { headers });
  if (res.status() === 401 || res.status() === 403) {
    await ensureLoggedContext(true);
    res = await ctx.request.get(url, { headers });
  }
  if (res.status() !== 200) {
    throw new Error(`GET ${pathname} -> ${res.status()}`);
  }
  const ct = (res.headers()['content-type'] || '').toLowerCase();
  if (!ct.includes('json')) {
    const text = await res.text();
    throw new Error(`Non-JSON from ${pathname} (${res.status()} ${ct || 'no-ct'}) ${text.slice(0, 200)}`);
  }
  return { url, data: await res.json() };
}

// --- API helpers (page.evaluate(fetch) dentro del navegador autenticado) ---
async function pageFetchJson(pathname, query) {
  const ctx = await ensureLoggedContext(false);
  const page = await ctx.newPage();
  const qs = new URLSearchParams(query || {}).toString();
  const url = `https://members.erank.com/${pathname}${qs ? `?${qs}` : ''}`;

  // montar contexto SPA (para que Inertia/headers/CSRF estén listos)
  await page.goto('https://members.erank.com/keyword-tool', { waitUntil: 'networkidle', timeout: 180000 });
  await page.waitForTimeout(1000);

  const out = await page.evaluate(async (u) => {
    try {
      const r = await fetch(u, {
        method: 'GET',
        headers: { 'Accept': 'application/json, text/plain, */*', 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'include'
      });
      const ct = r.headers.get('content-type') || '';
      if (!r.ok) return { ok: false, status: r.status, body: await r.text() };
      if (!ct.includes('application/json')) return { ok: false, status: r.status, body: await r.text() };
      const data = await r.json();
      return { ok: true, status: r.status, data };
    } catch (e) {
      return { ok: false, status: 0, body: String(e) };
    }
  }, url);

  await page.close();
  if (!out.ok) throw new Error(`pageFetchJson ${pathname} -> ${out.status} ${String(out.body).slice(0, 200)}`);
  return { url, data: out.data };
}

// --- Render real y scrape DOM (fallback) ---
function extractKeywordsFromHTML(html) {
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
    const t = $(el).text().trim(); if (t) out.add(t);
  });
  return Array.from(out).filter(s => s && s.length <= 64 && !/^https?:\/\//i.test(s));
}

async function renderKeywordTool(q, country, marketplace) {
  const ctx = await ensureLoggedContext(false);
  const page = await ctx.newPage();
  const url = `https://members.erank.com/keyword-tool?country=${encodeURIComponent(country)}&source=${encodeURIComponent(marketplace)}&keyword=${encodeURIComponent(q)}`;
  await page.goto(url, { waitUntil: 'networkidle', timeout: 240000 });
  await page.waitForTimeout(1500);
  try { await page.waitForSelector('table tbody tr, [role="table"] [role="row"]', { timeout: 25000 }); } catch {}
  const html = await page.content();
  await page.close();
  return { url, html };
}

// --- Normalizadores ---
function pickKeywords(payload) {
  const arr = payload?.data || payload || [];
  if (!Array.isArray(arr)) return [];
  return arr
    .map(o => (o && (o.keyword || o.name || o.title || o.term || o.text) || '').toString().trim())
    .filter(Boolean);
}
function pickTopListings(payload) {
  const arr = payload?.data || payload || [];
  if (!Array.isArray(arr)) return [];
  return arr.map(o => ({
    title: String(o?.title || o?.name || '').trim(),
    url:   String(o?.url || o?.link || '').trim(),
    price: o?.price ?? '',
    shop:  o?.shop ?? ''
  })).filter(x => x.title || x.url);
}

// --- Routes ---
app.get('/healthz',     (_req,res)=>res.json({ok:true}));
app.get('/erank/healthz',(_req,res)=>res.json({ok:true}));

app.get('/erank/keywords', async (req,res)=>{
  const q = String(req.query.q || 'planner');
  const country = String(req.query.country || 'USA');
  const marketplace = String(req.query.marketplace || 'etsy');
  try {
    let url, data, results = [];

    // 1) Intento con request server-side
    try {
      ({ url, data } = await fetchJson('related-searches', { keyword:q, country, marketplace }));
      results = pickKeywords(data);
    } catch (e1) {
      // Si vino HTML o bloqueo, hacemos fetch en la página autenticada
      ({ url, data } = await pageFetchJson('related-searches', { keyword:q, country, marketplace }));
      results = pickKeywords(data);
    }

    // 2) Fallback DOM si vacía
    if (!results.length) {
      const r = await renderKeywordTool(q, country, marketplace);
      results = extractKeywordsFromHTML(r.html);
      url = r.url;
    }

    if (q) results = results.filter(s => s.toLowerCase().includes(q.toLowerCase()));
    res.json({ source: url, query: q, count: results.length, results: results.slice(0, 100) });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.get('/erank/stats', async (req,res)=>{
  const q = String(req.query.q || 'planner');
  const country = String(req.query.country || 'USA');
  const marketplace = String(req.query.marketplace || 'etsy');
  try {
    let url, data;
    try {
      ({ url, data } = await fetchJson('stats', { keyword:q, country, marketplace }));
    } catch (e1) {
      ({ url, data } = await pageFetchJson('stats', { keyword:q, country, marketplace }));
    }
    res.json({ source: url, query: q, stats: data });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.get('/erank/top-listings', async (req,res)=>{
  const q = String(req.query.q || 'planner');
  const country = String(req.query.country || 'USA');
  const marketplace = String(req.query.marketplace || 'etsy');
  try {
    let url, data;
    try {
      ({ url, data } = await fetchJson('top-listings', { keyword:q, country, marketplace }));
    } catch (e1) {
      ({ url, data } = await pageFetchJson('top-listings', { keyword:q, country, marketplace }));
    }
    const items = pickTopListings(data);
    res.json({ source: url, query: q, count: items.length, items });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.get('/erank/near-matches', async (req,res)=>{
  const q = String(req.query.q || 'planner');
  const country = String(req.query.country || 'USA');
  const marketplace = String(req.query.marketplace || 'etsy');
  try {
    let url, data;
    try {
      ({ url, data } = await fetchJson('near-matches', { keyword:q, country, marketplace }));
    } catch (e1) {
      ({ url, data } = await pageFetchJson('near-matches', { keyword:q, country, marketplace }));
    }
    const results = pickKeywords(data);
    res.json({ source: url, query: q, count: results.length, results });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.get('/erank/raw', async (req,res)=>{
  const q = String(req.query.q || 'planner');
  const country = String(req.query.country || 'USA');
  const marketplace = String(req.query.marketplace || 'etsy');
  try {
    const { url, html } = await renderKeywordTool(q, country, marketplace);
    res.json({ url, ok: !!html, length: html ? html.length : 0, preview: (html || '').slice(0, 2000) });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// raíz opcional
app.get('/', (_req,res)=>res.json({
  ok:true,
  routes:[
    '/erank/healthz','/erank/keywords','/erank/stats','/erank/top-listings','/erank/near-matches','/erank/raw'
  ]
}));

app.listen(port,'0.0.0.0',()=>{
  const routes=[];
  app._router?.stack.forEach(mw=>{ if (mw.route) routes.push(Object.keys(mw.route.methods).join(',').toUpperCase()+' '+mw.route.path);});
  console.log('ROUTES:', routes);
  console.log('listening on', port);
});
