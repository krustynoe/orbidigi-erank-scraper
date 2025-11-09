// index.js (CommonJS) — eRank + ZenRows + Cheerio, con CSRF/XSRF correcto

/* 0) Polyfill antes de cargar axios (evita "File is not defined" de undici/Node18) */
globalThis.File = globalThis.File || class File {};

/* 1) Imports */
const express = require('express');
const axios   = require('axios');
const cheerio = require('cheerio');

/* 2) App */
const app  = express();
const port = process.env.PORT || 3000;

app.use((req, _res, next) => {                 // colapsa // -> /
  if (req.url.includes('//')) req.url = req.url.replace(/\/{2,}/g, '/');
  next();
});
app.get('/healthz', (_req, res) => res.json({ ok: true }));

/* 3) ENV */
const ZR        = process.env.ZENROWS_API_KEY || '';
const ER        = (process.env.ERANK_COOKIES || process.env.ERANK_COOKIE || '').trim(); // UNA línea
const TREND_URL = (process.env.ERANK_TREND_URL || 'https://members.erank.com/trend-buzz').trim();
const UA        = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36';

/* 4) Axios + helpers */
const http = axios.create({ timeout: 120000 });

function cookieHeaders(cookie) {
  const h = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };
  if (cookie) h['Cookie'] = cookie;
  return h;
}
function getCookieValue(line, name) {
  // line: "a=1; XSRF-TOKEN=enc%20val; b=2"
  const parts = String(line || '').split(';').map(s => s.trim());
  for (const p of parts) {
    const [k, ...rest] = p.split('=');
    if (k === name) return decodeURIComponent(rest.join('=') || '');
  }
  return '';
}
function getSetCookieValue(setCookieArr, name) {
  // setCookieArr: array of "XSRF-TOKEN=...; Path=/; ..." strings
  for (const sc of (setCookieArr || [])) {
    const m = sc.match(new RegExp('^' + name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + '=([^;]+)'));
    if (m) return decodeURIComponent(m[1]);
  }
  return '';
}
function apiHeaders({ cookie, csrfMeta, xsrfToken }) {
  return {
    'User-Agent'       : UA,
    'Accept'           : 'application/json, text/plain, */*',
    'X-Requested-With' : 'XMLHttpRequest',
    'Origin'           : 'https://members.erank.com',
    'Referer'          : TREND_URL,
    'Cookie'           : cookie,                 // debe incluir XSRF-TOKEN=...
    'X-CSRF-TOKEN'     : csrfMeta,              // del <meta name="csrf-token">
    'X-XSRF-TOKEN'     : xsrfToken              // valor de cookie XSRF-TOKEN (decodificado)
  };
}
function looksLikeLogin(html) {
  const s = String(html || '').toLowerCase();
  return s.includes('unauthorized') || s.includes('sign in') || s.includes('login required');
}

/* 5) ZenRows → HTML (solo para sitios públicos, p.ej. Etsy) */
async function fetchHtml(url, cookie = '', waitFor = 'body') {
  const params = {
    apikey: ZR,
    url,
    js_render: 'true',
    custom_headers: 'true',
    // premium_proxy: 'true',         // habilita si la web bloquea mucho
    block_resources: 'image,font',   // evita "File is not defined" y acelera render
    wait_for: waitFor
  };
  const { data } = await http.get('https://api.zenrows.com/v1/', {
    params, headers: { 'User-Agent': UA }, timeout: 90000
  });
  if (typeof data === 'string') return data;
  if (data?.html) return data.html;
  throw new Error(JSON.stringify(data));
}

/* 6) eRank /members: obtener CSRF+XSRF y llamar a /api */
async function getCsrfPair() {
  const r = await http.get(TREND_URL, { headers: cookieHeaders(ER), timeout: 60000 });
  const html = typeof r.data === 'string' ? r.data : (r.data?.html || '');
  if (!html) throw new Error('Empty HTML from trends page');

  const $ = cheerio.load(html);
  const csrfMeta = $('meta[name="csrf-token"]').attr('content') || '';
  const xsrfFromSetCookie = getSetCookieValue(r.headers['set-cookie'], 'XSRF-TOKEN');
  const xsrfFromEnv       = getCookieValue(ER, 'XSRF-TOKEN');

  const xsrfToken = xsmm(xsrfFromSetCookie || xsrfFromEnv); // decode handled in helpers

  if (!csrfMeta)  throw new Error('CSRF meta token not found');
  if (!xsrfToken) throw new Error('XSRF-TOKEN cookie missing');
  return { csrfMeta, xsrfToken };

  function xsmm(v){ return (v || '').trim(); }
}
async function erankApiGet(path) {
  const { csrfMeta, xsrfToken } = await getCsrfPair();
  const cookieWithXsrf = ER
    ? `${ER}${ER.endsWith(';') ? '' : '; '}XSRF-TOKEN=${encodeURIComponent(xsrfToken)}`
    : `XSRF-TOKEN=${encodeURIComponent(xsrfToken)}`;

  const url = `https://members.erank.com/${path}`;
  const { data } = await http.get(url, {
    headers: apiHeaders({ cookie: cookieWithXsrf, csrfMeta, xsrfToken }),
    timeout: 90000
  });
  if (data?.success === false) {
    throw new Error(JSON.stringify(data));
  }
  return data;
}

/* 7) Debug para ver si /trends es accesible y si hay csrf meta */
app.get('/erank/debug', async (req, res) => {
  try {
    const u = String(req.query.url || TREND_URL);
    const r = await http.get(u, { headers: cookieHeaders(ER), timeout: 60000 });
    const html = typeof r.data === 'string' ? r.data : (r.data?.html || '');
    const $ = cheerio.load(html);
    const meta = $('meta[name="csrf-token"]').attr('content') || '';
    const xsrfEnv  = getCookieValue(ER, 'XSRF-TOKEN');
    const xsrfSetC = getSetCookieValue(r.headers['set-cookie'], 'XSRF-TOKEN');
    res.json({
      url: u,
      ok: !!meta,
      csrf_meta_prefix: meta ? meta.slice(0, 12) + '…' : null,
      xsrf_cookie_from_env: xsrfEnv ? xsrfEnv.slice(0, 12) + '…' : null,
      xsrf_cookie_from_set_cookie: xsrfSetC ? xsrfSetC.slice(0, 12) + '…' : null
    });
  } catch (e) {
    res.status(502).json({ error: e.response?.data || e.message || String(e) });
  }
});

/* -------- eRANK ROUTES -------- */

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
      const cand = [data.results, data.items, data.keywords, data.trends, data.data];
      for (const arr of cand) {
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
    if (q) results = results.filter(s => s.toLowerCase().includes(q));
    res.json({ source: 'members.erank.com/api/trend-buzz', query: req.query.q || '', count: results.length, results: results.slice(0, 20) });
  } catch (e) {
    console.error('keywords error:', e.response?.status, e.response?.data || e.message || e);
    res.status(403).json({ error: e.response?.data || e.message || 'Unauthorized' });
  }
});

app.get('/erank/research', async (req, res) => {
  try {
    const q = (req.query.q || '').toString().toLowerCase();
    const data = await erankApiGet('api/trend-buzz');

    const out = [];
    const push = (title, link) => { title = (title||'').trim(); link=(link||'').trim(); if (title) out.push({ title, link }); };

    if (Array.isArray(data)) {
      for (const x of data) push(x?.title || x?.name || x?.keyword, x?.link || x?.url);
    } else if (data && typeof data === 'object') {
      const cand = [data.items, data.results, data.trends, data.data];
      for (const arr of (cand || [])) {
        if (Array.isArray(arr)) {
          for (const x of arr) {
            if (typeof x === 'string') push(x, '');
            else if (x && typeof x === 'object') push(x.title || x.name || x.keyword, x.link || x.url);
          }
        }
      }
    }

    const items = q ? out.filter(o => (o.title||'').toLowerCase().includes(q)) : out;
    res.json({ source: 'members.erank.com/api/trend-buzz', query: q, count: items.length, items: items.slice(0, 20) });
  } catch (e) {
    console.error('research error:', e.response?.data || e.message || e);
    res.status(403).json({ error: e.response?.data || e.message || 'Unauthorized' });
  }
});

/* -------- ETSY (público) -------- */

app.get('/erank/products', async (req, res) => {
  try {
    const q = String(req.query.q || '');
    const html = await fetchHtml(`https://www.etsy.com/search?q=${encodeURIComponent(q)}`, '', 'body');
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

    const html = await fetchHtml(`https://www.etsy.com/shop/${encodeURIComponent(shop)}`, '', 'body');
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
  app._router.stack.forEach(mw => { if (mw.route) routes.push(Object.keys(mw.route.methods).join(',').toUpperCase() + ' ' + mw.route.path); });
  console.log('ROUTES:', routes);
  console.log('listening on', port);
});
