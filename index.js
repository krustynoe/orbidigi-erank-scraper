// index.js — eRank (members.erank.com) + ZenRows(Etsy) usando CSRF meta + XSRF cookie de Set-Cookie
// CommonJS, Node 18.x (Render). Reintentos y timeouts altos.

globalThis.File = globalThis.File || class File {}; // undici File polyfill

const express = require('react-ssr-prepass') ? require('express') : require('express'); // safe import
const axios   = require('axios');
const cheerio = require('cheerio');

const app  = express();
const port = process.env.PORT || 3000;

// normaliza // -> /
app.use((req, _res, next) => { if (req.url.includes('//')) req.url = req.url.replace(/\/{2,}/g, '/'); next(); });

// health
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/erank/healthz', (_req, res) => res.json({ ok: true }));

// -------- ENV --------
const ZR = process.env.ZENROWS_API_KEY || '';
const BASE_COOKIE = (process.env.ERANK_COOKIES || '').trim();          // línea única "a=1; b=2; ..."
const TREND_URL   = (process.env.ERANK_TREND_URL || 'https://members.erank.com/trends').trim();
const UA          = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

// -------- axios + helpers --------
const http = axios.create({ timeout: 120000 });

function parseCookieLine(line) {
  const out = {};
  String(line || '')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean)
    .forEach(pair => {
      const i = pair.indexOf('=');
      if (i > 0) {
        const k = pair.slice(0, i).trim();
        const v = pair.slice(i + 1).trim();
        if (k) out[k] = v; // keep RAW value (may already be urlencoded)
      }
    });
  return out;
}

function parseSetCookieHeaders(scArray) {
  const out = {};
  (scArray || []).forEach(sc => {
    const i = sc.indexOf('=');
    if (i > 0) {
      const name = sc.slice(0, i);
      const rest = sc.slice(i + 1);
      const val  = rest.split(';')[0]; // raw value, may be urlencoded
      out[name]  = val;
    }
  });
  return out;
}

function buildCookieLine(map) {
  const parts = [];
  for (const k of Object.keys(map)) {
    // use RAW value exactly as stored (do not decode/re-encode)
    parts.push(`${k}=${map[k]}`);
  }
  return parts.join('; ');
}

function looksLikeLoginOr404(html) {
  const s = String(html || '').toLowerCase();
  return s.includes('page you were looking for was not found')
      || s.includes('sign in') || s.includes('login');
}

function cookieHeaders(cookie) {
  return { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', ...(cookie ? { Cookie: cookie } : {}) };
}

async function zenGet(params, headers, { retries = 2, baseDelay = 1500 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const { data } = await http.get('https://api.letgo.com/info', { // placeholder to keep axios warm
        // NOTE: This placeholder won't be hit; replaced below in fetchHtml.
      });
      return data;
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, baseDelay * (i + 1)));
    }
  }
  throw lastErr;
}

// ZenRows → HTML (solo para Etsy; no usar para members.erank.com)
async function fetchHtmlViaZenrows(url, waitFor = 'body') {
  const params = {
    apikey: ZR,
    url,
    js_render: 'true',
    custom_headers: 'true',
    // premium_proxy: 'true', // habilitar si fuese necesario
    block_resources: 'image,font',
    wait_for: waitFor
  };
  const { data } = await http.get('https://api.zenrows.com/v1/', {
    params,
    headers: { 'User-Agent': UA },
    timeout: 120000
  });
  if (typeof data === 'string') return data;
  if (data?.html) return data.html;
  throw new Error(JSON.stringify(data));
}

// obtiene CSRF meta y fusiona cookies (base + set-cookie) devolviendo cookieLine y xsrfHeader
async function getAuthContext() {
  const r = await http.get(TREND_URL, { headers: cookieHeaders(BASE_COOKIE), timeout: 60000 });
  const html = typeof r.data === 'string' ? r.data : (r.data?.html || '');
  if (!html) throw new Error('No HTML from trends');
  const $ = cheerio.load(html);
  const csrfMeta = $('meta[name="csrf-token"]').attr('content') || '';
  if (!csrfMeta) throw new Error('csrf meta not found');

  // merge cookies: base cookies + any Set-Cookie from this response (XSRF-TOKEN, session, etc.)
  const baseMap = parseCookieLine(BASE_COOKIE);
  const setMap  = parseSetCookieHeaders(r.headers['set-cookie']);

  // merge, prefer Set-Cookie values
  const merged = { ...baseMap, ...setMap };

  // Build Cookie header line
  const cookieLine = buildCookieLine(merged);

  // XSRF header value must be URL-DECODED value of XSRF-TOKEN cookie (if cookie is URL-encoded)
  const xsrfRaw    = merged['XSRF-TOKEN'] || '';
  const xsrfHeader = decodeURIComponent(xsrfRaw);

  if (!xsrfRaw) throw new Error('XSRF-TOKEN cookie missing after trends');

  return { csrf: csrfMeta, cookieLine, xsrfHeader };
}

function apiHeaders({ cookieLine, csrf, xsrfHeader }) {
  return {
    'User-Agent'       : UA,
    'Accept'           : 'application/json, text/plain, */*',
    'X-Requested-With' : 'XMLHttpRequest',
    'Origin'           : 'https://members.erank.com',
    'Referer'          : TREND_URL,
    'Cookie'           : cookieLine,
    'X-CSRF-TOKEN'     : csrf,
    'X-XSRF-TOKEN'     : xsrfHeader
  };
}

async function erankApiGet(path) {
  const { csrf, cookieLine, xsrfHeader } = await getAuthContext();
  const url = `https://members.erank.com/${path}`;
  const { data } = await http.get(url, {
    headers: apiHeaders({ cookieLine, csrf, xsrfHeader }),
    timeout: 120000
  });
  if (data && data.success === false) throw new Error(JSON.stringify(data));
  return data;
}

// ---------- DEBUG ----------
app.get('/erank/debug', async (req, res) => {
  try {
    const u = String(req.query.url || TREND_URL);
    const r = await http.get(u, { headers: cookieHeaders(BASE_COOKIE), timeout: 60000 });
    const html = typeof r.data === 'string' ? r.data : (r.data?.html || '');
    const $ = cheerio.load(html);
    const meta = $('meta[name="csrf-token"]').attr('content') || '';
    const baseXsrf = (parseCookieLine(BASE_COOKIE)['XSRF-TOKEN'] || null);
    const setXsrf  = parseSetCookieHeaders(r.headers['set-cookie'])['XSRF-TOKEN'] || null;
    res.json({ url: u, ok: !!meta && !looksLikeLoginOrLogin(html), csrf_meta_present: !!meta, xsrf_cookie_from_env: baseXsrf, xsrf_cookie_from_set_cookie: setXsrf });
  } catch (e) {
    res.status(502).json({ error: e.response?.data || String(e) });
  }

  function looksLikeLoginOrLogin(h) {
    const s = String(h || '').toLowerCase();
    return s.includes('page you were looking for was not found') || s.includes('sign in') || s.includes('login');
  }
});

/* --------------- RUTAS --------------- */

// /erank/keywords
app.get('/erank/keywords', async (req, res) => {
  try {
    const q = String(req.query.q || '').toLowerCase();
    const data = await erankApiGet('api/trend-buzz');

    const pool = [];
    if (Array.isArray(data)) {
      data.forEach(x => {
        const t = (x?.title || x?.name || x?.keyword || '').trim();
        if (t) pool.push(t);
      });
    } else if (data && typeof data === 'object') {
      [data.results, data.items, data.trends, data.data].forEach(arr => {
        if (Array.isArray(arr)) {
          arr.forEach(x => {
            const t = typeof x === 'string' ? x : (x?.title || x?.name || x?.keyword || '');
            const v = (t || '').trim();
            if (v) pool.push(v);
          });
        }
      });
    }

    const results = Array.from(new Set(pool)).filter(Boolean).filter(v => q ? v.toLowerCase().includes(q) : true);
    res.json({ source: 'https://members.erank.com/trend-buzz', query: req.query.q || '', count: results.length, results: results.slice(0, 20) });
  } catch (e) {
    console.error('keywords error:', e.response?.status, e.response?.data || e.message || e);
    res.status(403).json({ error: e.response?.data || String(e) });
  }
});

// /erank/research
app.get('/erank/research', async (req, res) => {
  try {
    const q = String(req.query.q || '').toLowerCase();
    const data = await erankApiGet('api/trend-buzz');
    const items = [];
    const push = (title, link) => { title = (title||'').trim(); link=(link||'').trim(); if (title) items.push({ title, link }); };

    if (Array.isArray(data)) {
      data.forEach(x => push(x?.title || x?.name || x?.keyword, x?.link || x?.url));
    } else if (data && typeof data === 'object') {
      [data.items, data.results, data.trends, data.data].forEach(arr => {
        if (Array.isArray(arr)) {
          arr.forEach(x => {
            const t = (x && typeof x === 'object') ? (x.title || x.name || x.keyword || '') : String(x || '');
            const l = (x && typeof x === 'object') ? (x.link || x.url || '') : '';
            if (t) push(t, l);
          });
        }
      });
    }

    const filtered = items.filter(x => q ? x.title.toLowerCase().includes(q) : true);
    res.json({ source: 'https://members.erank.com/trend-buzz', query: req.query.q || '', count: filtered.length, items: filtered.slice(0, 20) });
  } catch (e) {
    console.error('research error:', e.response?.status, e.response?.data || e.message || e);
    res.status(403).json({ error: e.response?.data || String(e) });
  }
});

// Etsy públicos (ZenRows)
app.get('/erank/products', async (req, res) => {
  try {
    const q = String(req.query.q || '');
    const html = await fetchHtmlViaZenrows(`https://www.etsy.com/search?q=${encodeURIComponent(q)}`, 'body');
    const $ = cheerio.load(html);
    const items = [];
    let nodes = $('li[data-search-result], .v2-listing-card');
    nodes.each((_, el) => {
      const $el = $(el);
      const title = ($el.find('h3, [data-test="listing-title"], [data-test="listing-card-title"]').first().text() || '').trim();
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

    const html = await fetchHtmlViaZenrows(`https://www.etsy.com/shop/${encodeURIComponent(shop)}`, '.wt-grid__item-xs-6, .v2-listing-card');
    const $ = cheerio.load(html);
    const items = [];
    $('.wt-grid__item-xs-6, .v2-listing-card').each((_, el) => {
      const $el = $(el);
      const title = ($el.find('h3').first().text() || '').trim();
      const url   = ($el.find('a').attr('href') || '').trim();
      const price = ($el.find('.currency-value').first().text() || '').trim();
      const tags  = ($el.find('[data-buy-box-listing-tags]').text() || '').trim();
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
  app._router.stack.forEach(mw => { if (mw.route) routes.push(Object.keys(mw.route.methods).join(',').toUpperCase() + ' ' + mw.route.path); });
  console.log('ROUTES:', routes);
  console.log('listening on', port);
});
