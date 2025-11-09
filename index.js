// index.js (CommonJS) — eRank via ZenRows(HTML)+Cheerio, con CSRF/XSRF para /members API

/* ---- polyfills / setup ---- */
globalThis.File = globalThis.File || class File {}; // evita "File is not defined" con undici/Node18

const express = require('express');
const axios   = require('axios');
const cheerio = require('cheerio');

const app  = new (require('express'))();
const port = process.env.PORT || 3000;

app.use((req, _res, next) => {               // normaliza doble slash // -> /
  if (req.url.includes('//')) req.url = req.url.replace(/\/{2,}/g, '/');
  next();
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

/* ---- ENV ---- */
const ZR         = process.env.ZENROWS_API_KEY || '';
const ER         = (process.env.ERANK_COOKIES || process.env.ERANK_COOKIE || '').trim(); // una línea: name=val; name2=val2; …
const TREND_ENV  = (process.env.ERANK_TREND_URL || '').trim(); // p.ej. https://members.erank.com/trends
const UA         = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36';

/* ---- axios + helpers ---- */
const http = axios.create({ timeout: 120000 });

function cookieHeaders(cookieLine) {
  const h = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };
  if (cookieLine) h['Cookie'] = cookieLine;
  return h;
}
function getCookieValue(cookieLine, name) {
  const parts = String(cookieLine || '').split(';').map(s => s.trim());
  for (const p of parts) {
    const [k, ...rest] = p.split('=');
    if (k === name) return decodeURIComponent(rest.join('=') || '');
  }
  return '';
}
function apiHeaders({ cookie, csrfMeta, xsrfCookie }) {
  return {
    'User-Agent'       : UA,
    'Accept'           : 'application/json, text/plain, */*',
    'X-Requested-With' : 'XMLHttpRequest',
    'Origin'           : 'https://members.erank.com',
    'Referer'          : TREND_ENV || 'https://members.erank.com/trends',
    ...(cookie    ? { 'Cookie'        : cookie }     : {}),
    ...(csrfMeta  ? { 'X-CSRF-TOKEN'  : csrfMeta }   : {}),
    ...(xsrfCookie? { 'X-XSRF-TOKEN'  : xsrfCookie } : {})
  };
}
function looksLikeLoginOr404(html) {
  const s = String(html || '').toLowerCase();
  return s.includes('page you were looking for was not found')
      || s.includes('sorry, the page you were looking for was not found')
      || s.includes('sign in') || s.includes('signin') || s.includes('login');
}
async function zenGet(params, headers, { retries = 2, baseDelay = 1500 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const { data } = await http.get('https://api.zenrows.com/v1/', {
        params, headers, timeout: 120000
      });
      return data;
    } catch (e) {
      lastErr = e;
      const msg = String(e?.code || e?.message || '');
      const status = e?.response?.status || 0;
      if (i < retries && (/ECONNRESET|socket hang up|ETIMEDOUT/i.test(msg) || status >= 500)) {
        await new Promise(r => setTimeout(r, baseDelay * (i + 1)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/* ---- ZenRows HTML (solo para sitios públicos: Etsy) ---- */
async function fetchHtml(url, cookie = '', waitFor = 'body') {
  const params = {
    apikey: ZR,
    url,
    js_render: 'true',
    custom_headers: 'true',
    premium_proxy: 'true',
    // usa valores válidos (no "images"/"fonts")
    block_resources: 'image,media,font',
    wait_for: waitFor
  };
  const data = await zenGet(params, { 'User-Agent': UA });
  if (typeof data === 'string') return data;
  if (data?.html) return data.html;
  throw new Error(JSON.stringify(data));
}

/* ---- eRank members.erank.com necesita CSRF + XSRF ---- */
async function getCsrfPair() {
  const landing = TREND_ENV || 'https://members.erank.com/trends';
  const r = await http.get(landing, { headers: cookieHeaders(ER), timeout: 60000 });
  const html = typeof r.data === 'string' ? r.data : (r.data?.html || '');
  if (!html) throw new Error('No HTML from trends');
  const $ = cheerio.load(html);
  const csrfMeta   = $('meta[name="csrf-token"]').attr('content') || '';
  const xsrfCookie = getCookieValue(ER, 'XSRF-TOKEN'); // de la cookie
  if (!csrfMeta)   throw new Error('CSRF meta not found');
  if (!xsrfCookie) throw new Error('XSRF-TOKEN cookie missing');
  return { csrfMeta, xsrfCookie };
}
async function erankApiGet(path) {
  const { csrfMeta, xsrfCookie } = await getCsrfPair();
  const url = `https://members.erank.com/${path}`;
  const { data } = await http.get(url, {
    headers: apiHeaders({ cookie: ER, csrfMeta, xsrfCookie }),
    timeout: 120000
  });
  return data;
}

/* ---- Debug ---- */
app.get('/erank/debug', async (req, res) => {
  try {
    const u = String(req.query.url || TREND_ENV || 'https://members.erank.com/trends');
    const r = await http.get(u, { headers: cookieHeaders(ER), timeout: 60000 });
    const html = typeof r.data === 'string' ? r.data : (r.data?.html || '');
    res.json({ url: u, ok: !!html && !looksLikeLoginOr404(html), snippet: String(html || '').slice(0, 500) });
  } catch (e) {
    res.status(502).json({ error: e.response?.data || e.message || String(e) });
  }
});

/* -------- eRANK ROUTES -------- */

// /erank/keywords  -> usa /api/trend-buzz y devuelve {results[]}
app.get('/erank/keywords', async (req, res) => {
  try {
    const q = (req.query.q || '').toString().toLowerCase();
    const data = await erankApiGet('api/trend-buzz');

    const pool = [];
    if (Array.isArray(data)) {
      for (const x of data) {
        const t = (x?.title || x?.name || x?.keyword || '').toString().trim();
        if (t) pool.push(t);
      }
    } else if (data && typeof data === 'object') {
      const cand = [data.results, data.items, data.keywords, data.trends, data.data];
      for (const arr of cand) {
        if (Array.isArray(arr)) {
          for (const x of arr) {
            if (typeof x === 'string') pool.push(x.trim());
            else if (x && typeof x === 'object') {
              const t = (x.title || x.name || x.keyword || '').toString().trim();
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
    res.status(502).json({ error: e.response?.data || e.message || String(e) });
  }
});

// /erank/research -> objetos {title,link} desde /api/trend-buzz
app.get('/erank/research', async (req, res) => {
  try {
    const q = (req.query.q || '').toString().toLowerCase();
    const data = await erankApiGet('api/trend-buzz');

    const items = [];
    const push = (title, link) => { title = (title||'').trim(); link=(link||'').trim(); if (title) items.push({ title, link }); };

    if (Array.isArray(data)) {
      for (const x of data) push(x?.title || x?.name || x?.keyword, x?.link || x?.url);
    } else if (data && typeof data === 'object') {
      const cand = [data.items, data.results, data.trends, data.data];
      for (const arr of cand) {
        if (Array.isArray(arr)) {
          for (const x of arr) {
            if (typeof x === 'string') push(x, '');
            else if (x && typeof x === 'object') push(x.title || x.name || x.keyword, x.link || x.url);
          }
        }
      }
    }

    let filtered = items;
    if (q) filtered = items.filter(x => (x.title||'').toLowerCase().includes(q));
    res.json({ source: 'members.erank.com/api/trend-buzz', query: req.query.q || '', count: filtered.length, items: filtered.slice(0, 20) });
  } catch (e) {
    console.error('research error:', e.response?.status || '', e.response?.data || e.message || e);
    res.status(502).json({ error: e.response?.data || e.message || String(e) });
  }
});

/* -------- ETSY (público) -------- */

// /erank/products -> { query, count, items[] }
app.get('/erank/products', async (req, res) => {
  try {
    const q = String(req.query.q || '');
    const html = await fetchHtml(`https://www.etsy.com/search?q=${encodeURIComponent(q)}`, '', 'body');
    const $ = cheerio.load(html);
    let nodes = $('li[data-search-result]');
    if (!nodes.length) nodes = $('.v2-listing-card'); // fallback

    const items = [];
    nodes.each((_, el) => {
      const $el = $(el);
      const title = ($el.find('h3, [data-test="listing-card-title"]').first().text() || '').trim();
      const url   = ($el.find('a').attr('href') || '').trim();
      const price = ($el.find('.currency-value, [data-buy-box-region="price"]').first().text() || '').trim();
      const shop  = ($el.find('.v2-listing-card__shop, .text-body-sm').first().text() || '').trim();
      if (title || url) items.push({ title, url, price, shop });
    });

    res.json({ query: q, count: items.length, items: items.slice(0, 20) });
  } catch (e) {
    console.error('products error:', e.response?.data || e.message || e);
    res.status(502).json({ error: e.response?.data || String(e) });
  }
});

// /erank/mylistings -> { shop, count, items[] }
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
  app._router?.stack?.forEach(mw => { if (mw.route) routes.push(Object.keys(mw.route.methods).join(',').toUpperCase() + ' ' + mw.route.path); });
  console.log('ROUTES:', routes);
  console.log('listening on', port);
});
