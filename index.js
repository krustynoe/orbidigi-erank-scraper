// index.js — eRank: login automático (Sanctum) + API autodetect + fallback ZenRows
// Node 18 CJS para Render. Sin dependencias extra.

globalThis.File = globalThis.File || class File {};

const express = require('express');
const axios   = require('axios');
const cheerio = require('cheerio');

const app  = express();
const port = process.env.PORT || 3000;

// --------- ENV
const ZR   = (process.env.ZENROWS_API_KEY || '').trim();
const EMAIL= (process.env.ERANK_EMAIL || '').trim();
const PASS = (process.env.ERANK_PASSWORD || '').trim();
const PATH = (process.env.ERANK_TREND_PATH || 'trend-buzz').trim(); // 'trend-buzz' | 'trends'
const TREND_URL = `https://members.erank.com/${PATH}`;
const UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

const http = axios.create({ timeout: 120000, validateStatus: () => true });

// --------- Cookie jar simple (memoria)
const jar = new Map(); // name -> value
function applySetCookies(res) {
  const sc = res.headers?.['set-cookie'];
  if (!sc) return;
  for (const raw of sc) {
    const part = String(raw).split(';')[0];
    const eq = part.indexOf('=');
    if (eq > 0) {
      const name = part.slice(0, eq).trim();
      const val  = part.slice(eq + 1).trim();
      if (name) jar.set(name, val);
    }
  }
}
function cookieHeader() {
  return Array.from(jar.entries()).map(([k,v]) => `${k}=${v}`).join('; ');
}
function getCookie(name) { return jar.get(name) || ''; }

// --------- Helpers HTTP
async function directGet(url, headers={}) {
  return http.get(url, { headers: { 'User-Agent': UA, ...headers, ...(jar.size?{Cookie:cookieHeader()}:{} ) } });
}
async function directPost(url, data, headers={}) {
  return http.post(url, data, { headers: { 'User-Agent': UA, ...headers, ...(jar.size?{Cookie:cookieHeader()}:{} ) } });
}
async function zenrowsGet(url, params={}, headers={}) {
  const zrParams = {
    apikey: ZR, url,
    custom_headers: 'true',
    premium_proxy: 'true',
    js_render: 'true',
    wait: String(params.wait || 8000),
    proxy_country: params.country || 'us',
    original_status: 'true',
    allowed_status_codes: '400,401,403,404,422,429'
  };
  const res = await http.get('https://api.zenrows.com/v1/', {
    params: zrParams,
    headers: { 'User-Agent': UA, ...headers, ...(jar.size?{Cookie:cookieHeader()}:{} ) },
  });
  return res;
}

// --------- Login automático (Sanctum)
let sessionReadyAt = 0;
async function loginIfNeeded(force=false) {
  const fresh = Date.now() - sessionReadyAt < 20 * 60 * 1000; // 20 min
  if (!force && fresh && getCookie('laravel_session')) return;

  if (!EMAIL || !PASS) throw new Error('Faltan ERANK_EMAIL/ERANK_PASSWORD en Environment');

  // 1) CSRF cookie
  let r = await directGet('https://members.erank.com/sanctum/csrf-cookie');
  applySetCookies(r);
  if (r.status >= 400) {
    // intenta vía ZenRows si la IP directa está bloqueada
    r = await zenrowsGet('https://members.erank.com/sanctum/csrf-cookie', { wait: 8000 });
    applySetCookies(r);
  }
  const xsrf = decodeURIComponent(getCookie('XSRF-TOKEN') || '');

  // 2) POST /login
  const body = new URLSearchParams({ email: EMAIL, password: PASS }).toString();
  const hdrs = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'X-Requested-With': 'XMLHttpRequest',
    ...(xsrf ? { 'X-XSRF-TOKEN': xsrf } : {})
  };

  let p = await directPost('https://members.erank.com/login', body, hdrs);
  applySetCookies(p);
  if (p.status >= 400 || (!getCookie('laravel_session') && !getCookie('sid_er'))) {
    // fallback por ZenRows si falla directo
    const zr = await http.post('https://api.zenrows.com/v1/', body, {
      params: {
        apikey: ZR,
        url: 'https://members.erank.com/login',
        custom_headers: 'true',
        premium_proxy: 'true',
        js_render: 'true',
        wait: '8000',
        method: 'POST'
      },
      headers: { 'User-Agent': UA, ...hdrs, ...(jar.size?{Cookie:cookieHeader()}:{} ) }
    });
    applySetCookies(zr);
  }

  if (!getCookie('laravel_session') && !getCookie('sid_er')) {
    throw new Error('No se pudo iniciar sesión en eRank');
  }
  sessionReadyAt = Date.now();
}

// --------- Extraer tokens + endpoint desde HTML
function extractAuthFromHtml(html) {
  const $ = cheerio.load(html);
  const csrf = $('meta[name="csrf-token"]').attr('content') || '';
  // JWT
  let dal = '';
  const ctx = html.match(/window\.APP_CONTEXT\s*=\s*(\{[\s\S]*?\});/);
  if (ctx) { try { dal = JSON.parse(ctx[1]).DAL_TOKEN || ''; } catch {} }
  // Ziggy
  let apiPath = '';
  const zig = html.match(/const\s+Ziggy\s*=\s*(\{[\s\S]*?\});/);
  if (zig) {
    try {
      const z = JSON.parse(zig[1]); const routes = z?.routes || {};
      const key = Object.keys(routes).find(k => /^api\./.test(k) && /trend/i.test(k));
      if (key && routes[key]?.uri) apiPath = routes[key].uri;
    } catch {}
  }
  if (!apiPath) apiPath = `api/${PATH}`;
  return { csrf, dal, apiPath };
}

// --------- Llamada API: primero directo con sesión, luego ZenRows con misma sesión
async function callErankApi(apiPath, { q }) {
  await loginIfNeeded(false);

  const base = `https://members.erank.com/${apiPath}`;
  const url  = q ? `${base}?q=${encodeURIComponent(q)}` : base;

  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': 'https://members.erank.com',
    'Referer': TREND_URL,
    'User-Agent': UA,
    Cookie: cookieHeader()
  };

  // 1) Directo con la sesión actual
  let r = await http.get(url, { headers, validateStatus: () => true });
  if (r.status === 401 || r.status === 403) {
    // refresca sesión y reintenta una vez
    await loginIfNeeded(true);
    const headers2 = { ...headers, Cookie: cookieHeader() };
    r = await http.get(url, { headers: headers2, validateStatus: () => true });
  }
  if (r.status === 200 && typeof r.data === 'object') return r.data;

  // 2) Fallback ZenRows usando la MISMA cookie
  const waits = [8000, 12000, 15000];
  for (const w of waits) {
    const zr = await zenrowsGet(url, { wait: w, country: 'us' }, headers);
    const zStatus = zr?.status || zr?.data?.statusCode || zr?.data?.status || 'unknown';
    console.log(`ZenRows API fallback wait=${w} → status=${zStatus}`);
    if (typeof zr.data === 'object' && !('code' in zr.data) && !('html' in zr.data)) {
      return zr.data;
    }
    if (zStatus === 401 || zStatus === 403) { await loginIfNeeded(true); }
  }

  // último recurso: error detallado
  throw new Error(`API no accesible (status=${r?.status}).`);
}

// --------- ZenRows HTML para debug y Etsy
async function fetchRenderedHtml(url, { waitMs = 8000, block = 'image,font,stylesheet' } = {}) {
  const params = {
    apikey: ZR, url,
    js_render: 'true', custom_headers: 'true', premium_proxy: 'true',
    wait: String(waitMs)
  };
  if (block) params.block_resources = block;
  const res = await http.get('https://api.zenrows.com/v1/', {
    params,
    headers: { 'User-Agent': UA, Cookie: cookieHeader() || undefined }
  });
  const html = typeof res.data === 'string' ? res.data : (res.data?.html || '');
  if (!html) throw new Error('HTML vacío del renderer');
  return html;
}

// --------- Parsers
function gatherStrings(node, acc) {
  if (!node) return;
  if (typeof node === 'string') { const s = node.trim(); if (s) acc.add(s); return; }
  if (Array.isArray(node)) { node.forEach(n => gatherStrings(n, acc)); return; }
  if (typeof node === 'object') {
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (typeof v === 'string' && /title|name|keyword|term/i.test(k)) acc.add(v.trim());
      else gatherStrings(v, acc);
    }
  }
}
function extractKnownKeywords(payload) {
  const out = [];
  const pick = (o) => {
    if (!o || typeof o !== 'object') return;
    const t = o.title || o.name || o.keyword || o.term || o.text;
    if (typeof t === 'string') { const s = t.trim(); if (s) out.push(s); }
  };
  const roots = [payload?.trends, payload?.buzz, payload?.items, payload?.results, payload?.data?.data, payload?.keywords];
  for (const r of roots) if (Array.isArray(r)) r.forEach(pick);
  return Array.from(new Set(out));
}

// --------- Endpoints
app.get('/healthz',      (_req, res) => res.json({ ok: true }));
app.get('/erank/healthz',(_req, res) => res.json({ ok: true }));

app.get('/erank/debug', async (_req, res) => {
  try { const html = await fetchRenderedHtml(TREND_URL, { waitMs: 8000 }); res.json({ ok: /<html/i.test(html), snippet: html.slice(0, 600) }); }
  catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

app.get('/erank/inspect', async (_req, res) => {
  try {
    await loginIfNeeded(false);
    const html = await fetchRenderedHtml(TREND_URL, { waitMs: 8000 });
    const $ = cheerio.load(html);
    const scripts = [];
    $('script').each((i, el) => { const txt = ($(el).html() || '').trim(); scripts.push({ i, len: txt.length, head: txt.slice(0, 160) }); });
    res.json({ source: TREND_URL, scripts: scripts.slice(0, 20) });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

app.get('/erank/keywords', async (req, res) => {
  try {
    const q = String(req.query.q || '').toLowerCase();
    await loginIfNeeded(false);
    const page = await directGet(TREND_URL);
    const { csrf, dal, apiPath } = extractAuthFromHtml(page.data || '');
    const data = await callErankApi(apiPath, { q });
    let results = extractKnownKeywords(data);
    if (results.length === 0) { const acc = new Set(); gatherStrings(data, acc); results = Array.from(acc); }
    if (q) results = results.filter(s => s.toLowerCase().includes(q));
    res.json({ source: `https://members.erank.com/${apiPath}`, query: q, count: results.length, results: results.slice(0, 100) });
  } catch (e) { console.error('keywords error:', e.response?.data || e.message || e); res.status(502).json({ error: String(e.message || e) }); }
});

app.get('/erank/research', async (req, res) => {
  try {
    const q = String(req.query.q || '').toLowerCase();
    await loginIfNeeded(false);
    const page = await directGet(TREND_URL);
    const { apiPath } = extractAuthFromHtml(page.data || '');
    const data = await callErankApi(apiPath, { q });

    const items = [];
    const roots = [data?.trends, data?.buzz, data?.items, data?.results, data?.data?.data];
    for (const arr of roots) {
      if (Array.isArray(arr)) {
        arr.forEach(o => {
          if (!o || typeof o !== 'object') return;
          const title = (o.title || o.name || o.keyword || o.term || '').toString().trim();
          const link  = (o.url || o.link || '').toString().trim();
          if (title && (!q || title.toLowerCase().includes(q))) items.push({ title, link });
        });
      }
    }
    if (items.length === 0) {
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
    }
    res.json({ source: `https://members.erank.com/${apiPath}`, query: q, count: items.length, items: items.slice(0, 50) });
  } catch (e) { console.error('research error:', e.response?.data || e.message || e); res.status(502).json({ error: String(e.message || e) }); }
});

app.get('/erank/raw', async (_req, res) => {
  try {
    await loginIfNeeded(false);
    const page = await directGet(TREND_URL);
    const { apiPath } = extractAuthFromHtml(page.data || '');
    const data = await callErankApi(apiPath, {});
    res.json({ apiPath, typeof: typeof data, keys: data && typeof data==='object' ? Object.keys(data).slice(0,20):[], preview: JSON.stringify(data).slice(0,1200) });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

// Etsy público (ZenRows)
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
      const price = ($el.find('.currency-value, [data-buy-box-listing-price]').first().text() || '').trim();
      const shop  = ($el.find('.v2-listing-card__shop, .text-body-secondary, .text-body-small').first().text() || '').trim();
      if (title || link) items.push({ title, url: link, price, shop });
    });
    res.json({ query: q, count: items.length, items: items.slice(0, 20) });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

app.listen(port, '0.0.0.0', () => {
  const routes = [];
  app._router?.stack.forEach(mw => { if (mw.route) routes.push(Object.keys(mw.route.methods).join(',').toUpperCase() + ' ' + mw.route.path); });
  console.log('ROUTES:', routes);
  console.log('listening on', port);
});
