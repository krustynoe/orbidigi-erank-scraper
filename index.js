// index.js — eRank API autodetect + CSRF/XSRF + ZenRows fallback
// Node 18 CJS para Render.

globalThis.File = globalThis.File || class File {};

const express = require('express');
const axios   = require('axios');
const cheerio = require('cheerio');

const app  = express();
const port = process.env.PORT || 3000;

// Normaliza // en paths
app.use((req, _res, next) => {
  if (req.url.includes('//')) req.url = req.url.replace(/\/{2,}/g, '/');
  next();
});

// Health
app.get('/healthz',       (_req, res) => res.json({ ok: true }));
app.get('/erank/healthz', (_req, res) => res.json({ ok: true }));

// ENV
const ZR   = (process.env.ZENROWS_API_KEY || '').trim();
const ER   = (process.env.ERANK_COOKIES    || '').trim(); // cookies en una sola línea
const PATH = (process.env.ERANK_TREND_PATH || 'trends').trim(); // fallback
const TREND_URL = `https://members.erank.com/${PATH}`;
const UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

const http = axios.create({ timeout: 120000 });

/* -------------------- Utilidades -------------------- */
function getCookie(name) {
  const m = (ER || '').match(new RegExp(`${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : '';
}

/* -------------------- HTML directo (sin render) -------------------- */
async function fetchErankPage() {
  const { data: html } = await http.get(TREND_URL, {
    headers: { 'User-Agent': UA, ...(ER ? { Cookie: ER } : {}) }
  });
  if (typeof html !== 'string') throw new Error('No HTML');
  return html;
}

function extractAuthFromHtml(html) {
  const $ = cheerio.load(html);

  const csrf = $('meta[name="csrf-token"]').attr('content') || '';
  const xsrf = getCookie('XSRF-TOKEN') || getCookie('xsrf-token') || '';

  // JWT en APP_CONTEXT
  let dal = '';
  const ctx = html.match(/window\.APP_CONTEXT\s*=\s*(\{[\s\S]*?\});/);
  if (ctx) { try { dal = JSON.parse(ctx[1]).DAL_TOKEN || ''; } catch {} }

  // Detectar ruta API desde Ziggy
  let apiPath = '';
  const zig = html.match(/const\s+Ziggy\s*=\s*(\{[\s\S]*?\});/);
  if (zig) {
    try {
      const z = JSON.parse(zig[1]);
      const routes = z?.routes || {};
      const key = Object.keys(routes).find(k => /^api\./.test(k) && /trend/i.test(k));
      if (key && routes[key]?.uri) apiPath = routes[key].uri; // p.ej. "api/trend-buzz"
    } catch {}
  }
  if (!apiPath) apiPath = `api/${PATH}`;

  return { csrf, xsrf, dal, apiPath };
}

async function callErankApi(apiPath, { q }) {
  const url = `https://members.erank.com/${apiPath}`;
  const params = q ? { q } : undefined;

  const { data } = await http.get(url, {
    params,
    headers: {
      'User-Agent': UA,
      ...(ER ? { Cookie: ER } : {}),
      'Accept': 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      ...(this?.csrf ? { 'X-CSRF-TOKEN': this.csrf } : {}),
      ...(this?.xsrf ? { 'X-XSRF-TOKEN': this.xsrf } : {}),
      ...(this?.dal  ? { 'Authorization': `Bearer ${this.dal}` } : {}),
      'Origin': 'https://members.erank.com',
      'Referer': TREND_URL,
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty'
    }
  });

  return data;
}

/* -------------------- ZenRows (debug/fallback) -------------------- */
async function fetchRenderedHtml(url, { waitMs = 8000, block = 'image,font,stylesheet' } = {}) {
  const params = {
    apikey: ZR,
    url,
    js_render: 'true',
    custom_headers: 'true',
    premium_proxy: 'true',
    wait: String(waitMs)
  };
  if (block) params.block_resources = block;

  const { data } = await http.get('https://api.zenrows.com/v1/', {
    params,
    headers: { 'User-Agent': UA, ...(ER ? { Cookie: ER } : {}) },
    timeout: 120000
  });
  const html = typeof data === 'string' ? data : (data?.html || '');
  if (!html) throw new Error(`Empty HTML from renderer for ${url}`);
  return html;
}

/* -------------------- Parse general -------------------- */
function gatherStrings(node, acc) {
  if (!node) return;
  if (typeof node === 'string') { const s = node.trim(); if (s) acc.add(s); return; }
  if (Array.isArray(node)) { node.forEach(n => gatherStrings(n, acc)); return; }
  if (typeof node === 'object') {
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (typeof v === 'string' && /title|name|keyword|term/i.test(k)) {
        const s = v.trim(); if (s) acc.add(s);
      } else { gatherStrings(v, acc); }
    }
  }
}

/* -------------------- Endpoints -------------------- */
app.get('/erank/debug', async (_req, res) => {
  try {
    const html = await fetchRenderedHtml(TREND_URL, { waitMs: 8000 });
    res.json({ ok: /<html/i.test(html), snippet: html.slice(0, 600) });
  } catch (e) {
    res.status(502).json({ error: e.response?.data || String(e) });
  }
});

app.get('/erank/inspect', async (_req, res) => {
  try {
    const html = await fetchRenderedHtml(TREND_URL, { waitMs: 8000 });
    const $ = cheerio.load(html);
    const scripts = [];
    $('script').each((i, el) => {
      const txt = ($(el).html() || '').trim();
      scripts.push({ i, len: txt.length, head: txt.slice(0, 160) });
    });
    res.json({ source: TREND_URL, scripts: scripts.slice(0, 20) });
  } catch (e) {
    res.status(502).json({ error: e.response?.data || String(e) });
  }
});

// Keywords vía API
app.get('/erank/keywords', async (req, res) => {
  try {
    const q = String(req.query.q || '').toLowerCase();

    const html = await fetchErankPage();
    const { csrf, xsrf, dal, apiPath } = extractAuthFromHtml(html);
    const api = callErankApi.bind({ csrf, xsrf, dal });

    const data = await api(apiPath, { q });

    const acc = new Set();
    gatherStrings(data, acc);
    let results = Array.from(acc);
    if (q) results = results.filter(s => s.toLowerCase().includes(q));

    res.json({ source: `https://members.erank.com/${apiPath}`, query: q, count: results.length, results: results.slice(0, 100) });
  } catch (e) {
    console.error('keywords error:', e.response?.data || e.message || e);
    res.status(502).json({ error: e.response?.data || String(e) });
  }
});

// Research vía API
app.get('/erank/research', async (req, res) => {
  try {
    const q = String(req.query.q || '').toLowerCase();

    const html = await fetchErankPage();
    const { csrf, xsrf, dal, apiPath } = extractAuthFromHtml(html);
    const api = callErankApi.bind({ csrf, xsrf, dal });

    const data = await api(apiPath, { q });

    const items = [];
    const walk = (node) => {
      if (!node) return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (typeof node === 'object') {
        const title = (node.title || node.name || node.keyword || '').toString().trim();
        const link  = (node.url || node.link || '').toString().trim();
        if (title && (!q || title.toLowerCase().includes(q))) items.push({ title, link });
        for (const k of Object.keys(node)) walk(node[k]);
      }
    };
    walk(data);

    res.json({ source: `https://members.erank.com/${apiPath}`, query: q, count: items.length, items: items.slice(0, 50) });
  } catch (e) {
    console.error('research error:', e.response?.data || e.message || e);
    res.status(502).json({ error: e.response?.data || String(e) });
  }
});

/* -------------------- Etsy público (ZenRows) -------------------- */
app.get('/erank/products', async (req, res) => {
  try {
    const q = String(req.query.q || '');
    const url = `https://www.etsy.com/search?q=${encodeURIComponent(q)}`;
    const html = await fetchRenderedHtml(url, { waitMs: 8000, block: 'image,font,stylesheet' });
    const $ = cheerio.load(html);
    const items = [];
    $('li[data-search-result], .v2-listing-card').each((_, el) => {
      const $el = $(el);
      const title = ($el.find('h3, [data-test="listing-title"], [data-test="listing-card-title"]').first().text() || '').trim();
      const link  = ($el.find('a').attr('href') || '').trim();
      const price = ($el.find('.currency-value, [data-buy-box-listing-price"]').first().text() || '').trim();
      const shop  = ($el.find('.v2-listing-card__shop, .text-body-secondary, .text-body-small').first().text() || '').trim();
      if (title || link) items.push({ title, url: link, price, shop });
    });
    res.json({ query: q, count: items.length, items: items.slice(0, 20) });
  } catch (e) {
    console.error('products error:', e.response?.data || e.message || e);
    res.status(502).json({ error: e.response?.data || String(e) });
  }
});

/* -------------------- Listen -------------------- */
app.listen(port, '0.0.0.0', () => {
  const routes = [];
  app._router?.stack.forEach(mw => { if (mw.route) routes.push(Object.keys(mw.route.methods).join(',').toUpperCase() + ' ' + mw.route.path); });
  console.log('ROUTES:', routes);
  console.log('listening on', port);
});
