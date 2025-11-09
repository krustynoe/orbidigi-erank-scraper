// index.js — eRank (members.erank.com) + ZenRows/Etsy
// CommonJS, Node 18 (Render). Usa CSRF meta + XSRF cookie. Cheerio para parsear HTML.

globalThis.File = globalThis.File || class File {}; // undici File polyfill

const express = require('express');
const axios   = require('axios');
const cheerio = require('cheerio');

const app  = express();
const port = process.env.PORT || 3000;

app.use((req, _res, next) => { if (req.url.includes('//')) req.url = req.url.replace(/\/{2,}/g, '/'); next(); });
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/erank/healthz', (_req, res) => res.json({ ok: true })); // alias de cortesía

// ---------- ENV ----------
const ZR   = process.env.ZENROWS_API_KEY || '';
const ER   = (process.env.ERANK_COOKIES || process.env.ERANK_COOKIE || '').trim(); // "a=1; b=2; XSRF-TOKEN=.."
const TREND_URL = (process.env.ERANK_TREND_URL || 'https://members.erank.com/trends').trim();
const UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36';

// ---------- AXIOS + HELPERS ----------
const http = axios.create({ timeout: 120000 });

function cookieHeaders(cookie) {
  const h = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };
  if (cookie) h['Cookie'] = cookie;
  return h;
}
function getCookieValue(line, name) {
  const parts = String(line || '').split(';').map(s => s.trim());
  for (const p of parts) {
    const [k, ...rest] = p.split('=');
    if (k === name) return rest.join('='); // NO decodificar aquí (para reusar tal cual en Cookie)
  }
  return '';
}
function getSetCookieValueRaw(setCookies, name) {
  // Devuelve el valor EXACTO (sin decode) de la cookie en Set-Cookie
  for (const sc of (setCookies || [])) {
    const m = sc.match(new RegExp('^' + name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + '=([^;]+)'));
    if (m) return m[1]; // sin decode
  }
  return '';
}
function decodeIfEncoded(v) {
  try { return decodeURIComponent(v); } catch { return v || ''; }
}
function apiHeaders({ cookie, csrfMeta, xsrfHeader }) {
  return {
    'User-Agent'       : UA,
    'Accept'           : 'application/json, text/plain, */*',
    'X-Requested-With' : 'XMLHttpRequest',
    'Origin'           : 'https://members.erank.com',
    'Referer'          : TREND_URL,
    ...(cookie     ? { 'Cookie'       : cookie }      : {}),
    ...(csrfMeta   ? { 'X-CSRF-TOKEN' : csrfMeta }    : {}),
    ...(xsrfHeader ? { 'X-XSRF-TOKEN' : xsrfHeader }  : {})
  };
}
function looksLikeLoginOr404(html) {
  const s = String(html || '').toLowerCase();
  return s.includes('page you were looking for was not found')
      || s.includes('sign in') || s.includes('login');
}

// ZenRows → HTML (solo sitios públicos, p.ej. Etsy)
async function fetchHtml(url, waitFor = 'body') {
  const params = {
    apikey: ZR,
    url,
    js_render: 'true',
    custom_headers: 'true',
    // premium_proxy: 'true', // activa si lo necesitas
    block_resources: 'image,font',   // OJO: 'image'/'font' (no 'images')
    wait_for: waitFor
  };
  const { data } = await http.get('https://api.zenrows.com/v1/', {
    params, headers: { 'User-Agent': UA }, timeout: 120000
  });
  if (typeof data === 'string') return data;
  if (data?.html) return data.html;
  throw new Error(JSON.stringify(data));
}

// 1) Carga /trends para sacar CSRF meta y XSRF cookie DESDE SET-COOKIE
async function getCsrfPair() {
  const r = await http.get(TREND_URL, { headers: cookieHeaders(ER), timeout: 60000 });
  const html = typeof r.data === 'string' ? r.data : (r.data?.html || '');
  if (!html) throw new Error('No HTML from trends');
  const $ = cheerio.load(html);
  const csrfMeta = $('meta[name="csrf-token"]').attr('content') || '';
  const xsrfRaw  = getSetCookieValueRaw(r.headers['set-cookie'], 'XSRF-TOKEN') || getCookieValue(ER, 'XSRF-TOKEN'); // raw (URL-encoded o no)
  const xsrfForHeader = decodeIfEncoded(xsrfRaw); // header sin %encoding
  if (!csrfMeta) throw new Error('csrf meta not found');
  if (!xsrfRaw)  throw new Error('XSRF-TOKEN cookie missing');
  return { csrfMeta, xsrfRaw, xsrfForHeader };
}

// 2) Llamada a /members.erank.com/api/*
async function erankApiGet(path) {
  const { csrfMeta, xsrfRaw, xsrfForHeader } = await getCsrfPair();

  // Reconstituye Cookie con XSRF-TOKEN EXACTO (sin tocarlo)
  const cookieHasXsrf = /(^|;\s*)XSRF-TOKEN=/.test(ER);
  const cookieLine = cookieHasXsrf ? ER : (ER ? `${ER}; XSRF-TOKEN=${xsrfRaw}` : `XSRF-TOKEN=${xsrfRaw}`);

  const url = `https://members.erank.com/${path}`;
  const { data } = await http.get(url, {
    headers: apiHeaders({ cookie: cookieLine, csrfMeta, xsrfHeader: xsrfForHeader }),
    timeout: 120000
  });
  if (data && data.success === false) throw new Error(JSON.stringify(data));
  return data;
}

// ---------- DEBUG ----------
app.get('/erank/debug', async (req, res) => {
  try {
    const u = String(req.query.url || TREND_URL);
    const r = await http.get(u, { headers: cookieHeaders(ER), timeout: 60000 });
    const html = typeof r.data === 'string' ? r.data : (r.data?.html || '');
    const $ = cheerio.load(html);
    const meta = $('meta[name="csrf-token"]').attr('content') || '';
    const xsrfEnv  = getCookieValue(ER, 'XSRF-TOKEN') || null;
    const xsrfSet  = getSetCookieValueRaw(r.headers['set-cookie'], 'XSRF-TOKEN') || null;
    res.json({
      url: u,
      ok: !!meta && !looksLikeLoginOr404(html),
      csrf_meta_prefix: meta ? (meta.slice(0, 10) + '…') : null,
      xsrf_cookie_from_env: xsrfEnv ? (xsrfEnv.slice(0, 12) + '…') : null,
      xsrf_cookie_from_set_cookie: xsrfSet ? (xsrfSet.slice(0, 12) + '…') : null
    });
  } catch (e) {
    res.status(502).json({ error: e.response?.data || String(e) });
  }
});

/* ------------- ERANK ROUTES -------------- */

// /erank/keywords  -> usa /api/trend-buzz y devuelve {results[]}
app.get('/erank/keywords', async (req, res) => {
  try {
    const q = (req.query.q || '').toString().toLowerCase();
    const data = await erankApiGet('api/trend-buzz');

    const pool = [];
    if (Array.isArray(data)) {
      for (const x of data) {
        const t = (x?.title || x?.name || x?.keyword || '').trim();
        if (t) pool.push(t);
      }
    } else if (data && typeof data === 'object') {
      const buckets = [data.results, data.items, data.keywords, data.trends, data.data];
      for (const arr of buckets) {
        if (Array.isArray(arr)) {
          for (const x of arr) {
            if (typeof x === 'string') pool.push(x.trim());
            else if (x && typeof x === 'object') {
              const t = (x.title || x.name || x.keyword || '').trim();
              if (t) pool.push(t);
            }
          }
        }
      }
    }

    let results = Array.from(new Set(pool)).filter(Boolean);
    if (q) results = results.filter(s => s.includes(q));
    res.json({ source: 'members.erank.com/api/trend-buzz', query: req.query.q || '', count: results.length, results: results.slice(0, 20) });
  } catch (e) {
    console.error('keywords error:', e.response?.status, e.response?.data || e.message || e);
    res.status(403).json({ error: e.response?.data || e.message || 'Unauthorized' });
  }
});

// /erank/research -> {items[]}
app.get('/erank/research', async (req, res) => {
  try {
    const q = (req.query.q || '').toString().toLowerCase();
    const data = await erankApiGet('api/trend-buzz');

    const items = [];
    const push = (title, link) => { title = (title||'').trim(); link=(link||'').trim(); if (title) items.push({ title, link }); };

    if (Array.isArray(data)) {
      for (const x of data) push(x?.title || x?.name || x?.keyword, x?.link || x?.url);
    } else if (data && typeof data === 'object') {
      const buckets = [data.items, data.results, data.trends, data.data];
      for (const arr of (buckets || [])) {
        if (Array.isArray(arr)) {
          for (const x of arr) {
            if (typeof x === 'string') push(x, '');
            else if (x && typeof x === 'object') push(x.title || x.name || x.keyword, x.link || x.url);
          }
        }
      }
    }

    const filtered = q ? items.filter(it => (it.title||'').toLowerCase().includes(q)) : items;
    res.json({ source: 'members.erank.com/api/trend-buzz', query: q, count: filtered.length, items: filtered.slice(0, 20) });
  } catch (e) {
    console.error('research error:', e.response?.status, e.response?.data || e.message || e);
    res.status(403).json({ error: e.response?.data || e.message || 'Unauthorized' });
  }
});

/* ------------- ETSY (público con ZenRows) ------------- */

app.get('/erank/products', async (req, res) => {
  try {
    const q = String(req.query.q || '');
    const html = await fetchHtml(`https://www.etsy.com/search?q=${encodeURIComponent(q)}`, 'body');
    const $ = cheerio.load(html);
    let nodes = $('li[data-search-result]');
    if (!nodes.length) nodes = $('.v2-listing-card');

    const items = [];
    nodes.each((_, el) => {
      const $el = $(el);
      const title = ($el.find('h3, [data-test="listing-card-title"]').first().text() || '').trim();
      const url   = ($el.find('a').attr('href') || '').trim();
      const price = ($el.find('.currency-value, [data-buy-box-listing-price]').first().text() || '').trim();
      const shop  = ($el.find('.v2-listing-card__shop, .text-body-sm').first().text() || '').trim();
      if (title || url) items.push({ title, url, price, shop });
    });

    res.json({ query: q, count: items.length, items: items.slice(0, 20) });
  } catch (e) {
    console.error('products error:', e.response?.data || e.message || e);
    res.status(502).json({ error: e.response?.data || String(e) });
  }
});

app.get('/erank/mylistings', async (req, res) => {
  try {
    const shop = String(req.query.shop || '');
    if (!shop) return res.status(400).json({ error: "Missing 'shop' param" });

    const html = await fetchHtml(`https://www.etsy.com/shop/${encodeURIComponent(shop)}`, '.wt-grid__item-xs-6, .v2-listing-card');
    const $ = cheerio.load(html);
    const items = [];
    $('.wt-grid__item-xs-6, .v2-listing-card').each((_, el) => {
      const $el = $(el);
      const title = ($el.find('h3').first().text() || '').trim();
      const url   = ($el.find('a').attr('href') || '').trim();
      const price = ($el.find('.currency-value').first().text() || '').trim();
      const tags  = ($el.find('[data-buy-box-listing-tags], .tag').text() || '').trim();
      if (title || url) items.push({ title, url, price, tags });
    });
    res.json({ shop, count: items.length, items: items.slice(0, 50) });
  } catch (e) {
    console.error('mylistings error:', e.response?.data || e.message || e);
    res.status(500).json({ error: e.response?.data || String(e) });
  }
});

app.listen(port, '0.0.0.0', () => {
  const routes = [];
  app._router?.stack?.forEach(mw => { if (mw.route) routes.push(Object.keys(mw.route.methods).join(',').toUpperCase() + ' ' + mw.route.path); });
  console.log('ROUTES:', routes);
  console.log('listening on', port);
});
