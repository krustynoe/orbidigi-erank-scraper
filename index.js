// index.js — eRank Keyword Tool via ZenRows (rendered DOM) + login Sanctum
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
const PATH  = (process.env.ERANK_TREND_PATH || 'trend-buzz').trim(); // 'trend-buzz' o 'trends'
const UA    = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

const http = axios.create({ timeout: 120000, validateStatus: () => true });

// ===== Cookie jar simple =====
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
function getCookie(n) { return jar.get(n) || ''; }

// ===== HTTP helpers =====
async function directGet(url, headers={}) {
  return http.get(url, { headers: { 'User-Agent': UA, ...headers, ...(jar.size?{Cookie:cookieHeader()}:{} ) } });
}
async function directPost(url, data, headers={}) {
  return http.post(url, data, { headers: { 'User-Agent': UA, ...headers, ...(jar.size?{Cookie:cookieHeader()}:{} ) } });
}
async function zenrowsGet(url, params={}, headers={}) {
  const zrParams = {
    apikey: ZR,
    url,
    custom_headers: 'true',
    premium_proxy: 'true',
    js_render: 'true',
    wait: String(params.wait || 20000),                     // esperar más para hidratar
    wait_for: params.wait_for || 'table,tbody tr,div[role="table"]',
    proxy_country: params.country || 'us',
    original_status: 'true'
  };
  const res = await http.get('https://api.zenrows.com/v1/', {
    params: zrParams,
    headers: { 'User-Agent': UA, ...headers, ...(jar.size?{Cookie:cookieHeader()}:{} ) }
  });
  return res;
}

// ===== Login automático (Sanctum) =====
let sessionReadyAt = 0;
async function loginIfNeeded(force=false) {
  const fresh = Date.now() - sessionReadyAt < 20 * 60 * 1000;
  if (!force && fresh && (getCookie('laravel_session') || getCookie('sid_er'))) return;
  if (!EMAIL || !PASS) throw new Error('Faltan ERANK_EMAIL/ERANK_PASSWORD');

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

// ===== Utilidades de parsing JSON embebido y DOM =====
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
  const blobs = [];
  let m;

  // window.__DATA__ = {...};
  const reWin = /window\.__DATA__\s*=\s*([\s\S]+?);[\r\n]/g;
  while ((m = reWin.exec(html))) { const j = balanceJson(m[1]); if (j) blobs.push(j); }

  // <script type="application/json">...</script>
  const reScript = /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = reScript.exec(html))) { const j = balanceJson(m[1]); if (j) blobs.push(j); }

  // const Ziggy = {...};
  const reZiggy = /const\s+Ziggy\s*=\s*([\s\S]+?);[\r\n]/g;
  while ((m = reZiggy.exec(html))) { const j = balanceJson(m[1]); if (j) blobs.push(j); }

  const parsed = [];
  for (const raw of blobs) { try { parsed.push(JSON.parse(raw)); } catch {} }
  return parsed;
}

function gatherStrings(node, acc) {
  if (!node) return;
  if (typeof node === 'string') { const s = node.trim(); if (s) acc.add(s); return; }
  if (Array.isArray(node)) { node.forEach(n => gatherStrings(n, acc)); return; }
  if (typeof node === 'object') {
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (typeof v === 'string' && /keyword|title|name|term|text/i.test(k)) {
        const s = v.trim(); if (s) acc.add(s);
      } else gatherStrings(v, acc);
    }
  }
}

function pickKeywordsFromJson(obj) {
  const out = new Set();
  const roots = [obj?.keywords, obj?.related, obj?.results, obj?.data, obj?.buzz, obj?.trends, obj?.items];
  for (const r of roots) {
    if (Array.isArray(r)) {
      r.forEach(o => {
        if (!o || typeof o !== 'object') return;
        const t = o.keyword || o.name || o.title || o.term || o.text;
        if (typeof t === 'string') out.add(t.trim());
      });
    }
  }
  if (!out.size) { const acc = new Set(); gatherStrings(obj, acc); acc.forEach(s => out.add(s)); }
  return Array.from(out);
}

function pickKeywordsFromDom(html) {
  const $ = cheerio.load(html);
  const out = new Set();

  // tablas con cabecera "Keywords"
  $('table').each((_, tbl) => {
    const th0 = cheerio.load($.html(tbl))('th').first().text().toLowerCase();
    if (th0.includes('keyword') || th0.includes('keywords')) {
      cheerio.load($.html(tbl))('tbody tr').each((__, tr) => {
        const first = cheerio.load($.html(tr))('td').first().text().trim();
        if (first) out.add(first);
      });
    }
  });

  // chips/badges
  $('[class*=chip],[class*=tag],[data-testid*=keyword]').each((_, el) => {
    const t = $(el).text().trim(); if (t) out.add(t);
  });

  return Array.from(out);
}

// ===== Keyword Tool por HTML renderizado =====
async function fetchKeywordToolKeywords({ q, country, marketplace }) {
  await loginIfNeeded(false);

  const url = `https://members.erank.com/keyword-tool?country=${encodeURIComponent(country)}&source=${encodeURIComponent(marketplace)}&keyword=${encodeURIComponent(q)}`;

  // 2 intentos con waits crecientes y wait_for a la tabla
  const waits = [20000, 25000];
  for (const w of waits) {
    const zr = await zenrowsGet(url, { wait: w, wait_for: 'table,tbody tr,div[role="table"]', country: 'us' }, { Cookie: cookieHeader() });
    const html = typeof zr.data === 'string' ? zr.data : (zr.data?.html || '');
    if (!html) continue;

    // a) JSON embebido
    const blobs = extractEmbeddedJson(html);
    for (const obj of blobs) {
      const kw = pickKeywordsFromJson(obj).filter(s => s && s.length <= 64);
      if (kw.length) return { source: url, results: kw };
    }

    // b) DOM visible
    const domKw = pickKeywordsFromDom(html).filter(s => s && s.length <= 64);
    if (domKw.length) return { source: url, results: domKw };
  }
  return { source: url, results: [] };
}

// ===== Endpoints =====
app.get('/healthz',      (_req, res) => res.json({ ok: true }));
app.get('/erank/healthz',(_req, res) => res.json({ ok: true }));

app.get('/erank/keywords', async (req, res) => {
  try {
    const q           = String(req.query.q || 'planner');
    const country     = String(req.query.country || 'USA');
    const marketplace = String(req.query.marketplace || 'etsy');
    const { source, results } = await fetchKeywordToolKeywords({ q, country, marketplace });
    const filtered = q ? results.filter(s => s.toLowerCase().includes(q.toLowerCase())) : results;
    res.json({ source, query: q, count: filtered.length, results: filtered.slice(0, 100) });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.get('/erank/inspect', async (req, res) => {
  try {
    const q           = String(req.query.q || 'planner');
    const country     = String(req.query.country || 'USA');
    const marketplace = String(req.query.marketplace || 'etsy');
    await loginIfNeeded(false);
    const url = `https://members.erank.com/keyword-tool?country=${encodeURIComponent(country)}&source=${encodeURIComponent(marketplace)}&keyword=${encodeURIComponent(q)}`;
    const zr  = await zenrowsGet(url, { wait: 25000, wait_for: 'table,tbody tr,div[role="table"]' }, { Cookie: cookieHeader() });
    const html = typeof zr.data === 'string' ? zr.data : (zr.data?.html || '');
    const $ = cheerio.load(html || '');
    const scripts = [];
    $('script').each((i, el) => {
      const txt = ($(el).html() || '').trim();
      scripts.push({ i, len: txt.length, head: txt.slice(0, 160) });
    });
    res.json({ url, scripts: scripts.slice(0, 20) });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

app.get('/erank/debug', async (_req, res) => {
  try {
    await loginIfNeeded(false);
    const url = `https://members.erank.com/${PATH}`;
    const zr  = await zenrowsGet(url, { wait: 10000 }, { Cookie: cookieHeader() });
    const html = typeof zr.data === 'string' ? zr.data : (zr.data?.html || '');
    res.json({ ok: !!html, snippet: String(html).slice(0, 600) });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

app.listen(port, '0.0.0.0', () => {
  const routes = [];
  app._router?.stack.forEach(mw => { if (mw.route) routes.push(Object.keys(mw.route.methods).join(',').toUpperCase() + ' ' + mw.route.path); });
  console.log('ROUTES:', routes);
  console.log('listening on', port);
});
