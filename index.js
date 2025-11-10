// index.js — eRank Trend Buzz via HTML (window.__DATA__) + login auto como respaldo
// Node 18 CJS para Render.

globalThis.File = globalThis.File || class File {};

const express = require('express');
const axios   = require('axios');
const cheerio = require('cheerio');

const app  = express();
const port = process.env.PORT || 3000;

// ===== ENV =====
const ZR    = (process.env.ZENROWS_API_KEY || '').trim();
const EMAIL = (process.env.ERANK_EMAIL || '').trim();
const PASS  = (process.env.ERANK_PASSWORD || '').trim();
const PATH  = (process.env.ERANK_TREND_PATH || 'trend-buzz').trim(); // trend-buzz | trends
const TREND_URL = `https://members.erank.com/${PATH}`;
const UA    = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

const http = axios.create({ timeout: 120000, validateStatus: () => true });

// ===== Cookie jar simple en memoria =====
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

// ===== HTTP helpers =====
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
    original_status: 'true'
  };
  const res = await http.get('https://api.zenrows.com/v1/', {
    params: zrParams,
    headers: { 'User-Agent': UA, ...headers, ...(jar.size?{Cookie:cookieHeader()}:{} ) },
  });
  return res;
}

// ===== Login automático (Sanctum) como respaldo =====
let sessionReadyAt = 0;
async function loginIfNeeded(force=false) {
  const fresh = Date.now() - sessionReadyAt < 20 * 60 * 1000; // 20 min
  if (!force && fresh && (getCookie('laravel_session') || getCookie('sid_er'))) return;
  if (!EMAIL || !PASS) throw new Error('Faltan ERANK_EMAIL/ERANK_PASSWORD en Environment');

  // 1) CSRF cookie
  let r = await directGet('https://members.erank.com/sanctum/csrf-cookie');
  applySetCookies(r);
  if (r.status >= 400) {
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
  if (!getCookie('laravel_session') && !getCookie('sid_er')) throw new Error('Login eRank fallido');
  sessionReadyAt = Date.now();
}

// ===== Utilidades de parsing JSON embebido =====
function balanceJson(s) {
  if (!s) return null;
  s = s.trim();
  const open = s[0] === '{' ? '{' : s[0] === '[' ? '[' : null;
  const close = open === '{' ? '}' : open === '[' ? ']' : null;
  if (!open) return null;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return s.slice(0, i + 1); }
  }
  return null;
}

function extractEmbeddedJson(html) {
  // Busca window.__DATA__ = {...};  o  <script type="application/json" id="__NEXT_DATA__">...</script>
  const candidates = [];

  // 1) window.__DATA__ = {...};
  let m;
  const reWin = /window\.__DATA__\s*=\s*([\s\S]+?);[\r\n]/g;
  while ((m = reWin.exec(html))) {
    const j = balanceJson(m[1]);
    if (j) candidates.push(j);
  }

  // 2) <script type="application/json">...</script>
  const reScript = /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = reScript.exec(html))) {
    const j = balanceJson(m[1]);
    if (j) candidates.push(j);
  }

  // 3) const Ziggy = {...};
  const reZiggy = /const\s+Ziggy\s*=\s*([\s\S]+?);[\r\n]/g;
  while ((m = reZiggy.exec(html))) {
    const j = balanceJson(m[1]);
    if (j) candidates.push(j);
  }

  // Parseo
  const parsed = [];
  for (const raw of candidates) {
    try { parsed.push(JSON.parse(raw)); } catch { /* ignore */ }
  }
  return parsed;
}

function gatherStrings(node, acc) {
  if (!node) return;
  if (typeof node === 'string') { const s = node.trim(); if (s) acc.add(s); return; }
  if (Array.isArray(node)) { node.forEach(n => gatherStrings(n, acc)); return; }
  if (typeof node === 'object') {
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (typeof v === 'string' && /title|name|keyword|term|text/i.test(k)) {
        const s = v.trim(); if (s) acc.add(s);
      } else gatherStrings(v, acc);
    }
  }
}

function extractKnownKeywords(payload) {
  const out = new Set();
  const pick = (o) => {
    if (!o || typeof o !== 'object') return;
    const t = o.title || o.name || o.keyword || o.term || o.text;
    if (typeof t === 'string') { const s = t.trim(); if (s) out.add(s); }
  };
  const roots = [payload?.trends, payload?.buzz, payload?.items, payload?.results, payload?.data?.data, payload?.keywords];
  for (const r of roots) if (Array.isArray(r)) r.forEach(pick);
  return Array.from(out);
}

// ===== Scrape HTML renderizado de Trend Buzz =====
async function fetchTrendBuzzJsonViaHTML() {
  await loginIfNeeded(false);
  // 2-3 intentos con waits crecientes
  const waits = [8000, 12000, 15000];
  for (const w of waits) {
    const zr = await zenrowsGet(TREND_URL, { wait: w, country: 'us' }, { Cookie: cookieHeader() });
    const html = typeof zr.data === 'string' ? zr.data : (zr.data?.html || '');
    if (!html) continue;

    // Extraer bloques JSON candidatos
    const blobs = extractEmbeddedJson(html);
    for (const obj of blobs) {
      // Intenta extraer palabras “conocidas” y si no, barrido genérico
      let results = extractKnownKeywords(obj);
      if (results.length === 0) {
        const acc = new Set(); gatherStrings(obj, acc);
        results = Array.from(acc);
      }
      // Cualquier lista no vacía es válida
      if (results.length > 0) return { results, raw: obj };
    }
  }
  return { results: [], raw: null };
}

// ===== Respaldo por API (se usará solo si HTML no trae datos) =====
async function callApiFallback(q) {
  await loginIfNeeded(true);
  const url = `https://members.erank.com/api/${PATH}${q ? `?q=${encodeURIComponent(q)}` : ''}`;
  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': 'https://members.erank.com',
    'Referer': TREND_URL,
    'User-Agent': UA,
    Cookie: cookieHeader()
  };
  // directo
  let r = await http.get(url, { headers });
  if (r.status === 200 && typeof r.data === 'object' && !('success' in r.data && r.data.success === false)) return r.data;

  // ZenRows
  const zr = await zenrowsGet(url, { wait: 12000, country: 'us' }, headers);
  if (typeof zr.data === 'object' && !('code' in zr.data) && !('html' in zr.data)) return zr.data;
  return null;
}

// ===== Endpoints =====
app.get('/healthz',      (_req, res) => res.json({ ok: true }));
app.get('/erank/healthz',(_req, res) => res.json({ ok: true }));

app.get('/erank/debug', async (_req, res) => {
  try {
    await loginIfNeeded(false);
    const zr = await zenrowsGet(TREND_URL, { wait: 8000 }, { Cookie: cookieHeader() });
    const html = typeof zr.data === 'string' ? zr.data : (zr.data?.html || '');
    res.json({ ok: !!html, snippet: String(html).slice(0, 600) });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

app.get('/erank/inspect', async (_req, res) => {
  try {
    await loginIfNeeded(false);
    const zr = await zenrowsGet(TREND_URL, { wait: 12000 }, { Cookie: cookieHeader() });
    const html = typeof zr.data === 'string' ? zr.data : (zr.data?.html || '');
    const $ = cheerio.load(html || '');
    const scripts = [];
    $('script').each((i, el) => {
      const txt = ($(el).html() || '').trim();
      scripts.push({ i, len: txt.length, head: txt.slice(0, 160) });
    });
    res.json({ source: TREND_URL, scripts: scripts.slice(0, 20) });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

// === Keywords desde HTML (y API como respaldo) ===
app.get('/erank/keywords', async (req, res) => {
  try {
    const q = String(req.query.q || '').toLowerCase();

    // 1) HTML
    const { results: htmlResults } = await fetchTrendBuzzJsonViaHTML();
    let results = htmlResults;

    // 2) Filtra si hay q
    if (q && results.length) results = results.filter(s => s.toLowerCase().includes(q));

    // 3) Si vacío, API fallback
    if (!results.length) {
      const data = await callApiFallback(q);
      if (data) {
        results = extractKnownKeywords(data);
        if (!results.length) {
          const acc = new Set(); gatherStrings(data, acc);
          results = Array.from(acc);
        }
      }
    }

    res.json({ source: TREND_URL, query: q, count: results.length, results: results.slice(0, 100) });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

// === Research: títulos + links desde HTML embebido ===
app.get('/erank/research', async (req, res) => {
  try {
    const q = String(req.query.q || '').toLowerCase();

    const { results: htmlResults, raw } = await fetchTrendBuzzJsonViaHTML();
    const items = [];
    const pushItem = (o) => {
      if (!o || typeof o !== 'object') return;
      const title = (o.title || o.name || o.keyword || o.term || '').toString().trim();
      const link  = (o.url || o.link || '').toString().trim();
      if (title && (!q || title.toLowerCase().includes(q))) items.push({ title, link });
    };

    if (raw) {
      // intentos de rutas comunes
      const sources = [raw?.trends, raw?.buzz, raw?.items, raw?.results, raw?.data?.data];
      for (const arr of sources) if (Array.isArray(arr)) arr.forEach(pushItem);
      if (!items.length && Array.isArray(htmlResults)) htmlResults.forEach(s => { if (typeof s === 'string') items.push({ title: s, link: '' }); });
    }

    if (!items.length) {
      const data = await callApiFallback(q);
      if (data) {
        const sources = [data?.trends, data?.buzz, data?.items, data?.results, data?.data?.data];
        for (const arr of sources) if (Array.isArray(arr)) arr.forEach(pushItem);
      }
    }

    res.json({ source: TREND_URL, query: q, count: items.length, items: items.slice(0, 50) });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

// === Etsy público (ZenRows) ===
app.get('/erank/products', async (req, res) => {
  try {
    const q = String(req.query.q || '');
    const url = `https://www.etsy.com/search?q=${encodeURIComponent(q)}`;
    const zr = await zenrowsGet(url, { wait: 8000 }, {});
    const html = typeof zr.data === 'string' ? zr.data : (zr.data?.html || '');
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
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

// ===== Listen =====
app.listen(port, '0.0.0.0', () => {
  const routes = [];
  app._router?.stack.forEach(mw => { if (mw.route) routes.push(Object.keys(mw.route.methods).join(',').toUpperCase() + ' ' + mw.route.path); });
  console.log('ROUTES:', routes);
  console.log('listening on', port);
});
