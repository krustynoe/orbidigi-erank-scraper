// index.js — eRank API (CSRF + Cookie) y Etsy (ZenRows+Cheerio)
// CommonJS, Node 18 en Render

globalThis.File = globalThis.File || class File {}; // undici workaround

const express = require('express');
const axios   = require('axios');
const cheerio = require('cheerio');

const app  = express();
const port = process.env.PORT || 3000;

app.use((req, _res, next) => { if (req.url.includes('//')) req.url = req.url.replace(/\/{2,}/g, '/'); next(); });
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// ---- ENV ----
const ZR  = process.env.ZENROWS_API_KEY || '';
const ER  = (process.env.ERANK_COOKIES || process.env.ERANK_COOKIE || '').trim();
const TREND_ENV = (process.env.ERANK_TREND_URL || '').trim();

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36';

// ---- HTTP helpers ----
const http = axios.create({ timeout: 120000 });

function cookieHeaders(cookie) {
  const h = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
  };
  if (cookie) h['Cookie'] = cookie;
  return h;
}
function apiHeaders(cookie, csrf) {
  const h = {
    'User-Agent': UA,
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': 'https://members.erank.com/trends'
  };
  if (cookie) h['Cookie'] = cookie;
  if (csrf)   h['X-CSRF-TOKEN'] = csrf;
  return h;
}
function looksLikeLoginOr404(html) {
  const s = String(html || '').toLowerCase();
  return s.includes('page you were looking for was not found')
      || s.includes('sign in') || s.includes('signin') || s.includes('login');
}

// GET HTML via ZenRows (solo para sitios públicos como Etsy)
async function fetchHtmlZenRows(url, waitFor = 'body') {
  const params = {
    apikey: ZR,
    url,
    js_render: 'true',
    custom_headers: 'true',
    premium_proxy: 'true',
    block_resources: 'image,media,fonts,tracking',
    wait_for: waitFor
  };
  const { data } = await http.get('https://api.zenrows.com/v1/', { params, headers: { 'User-Agent': UA } });
  if (typeof data === 'string') return data;
  if (data?.html) return data.html;
  throw new Error(JSON.stringify(data));
}

// ---- eRank API (CSRF + Cookie) ----
async function getCsrfToken() {
  const landing = TREND_ENV || 'https://members.erank.com/trends';
  const r = await http.get(landing, { headers: cookieHeaders(ER), timeout: 60000 });
  const html = typeof r.data === 'string' ? r.data : (r.data?.html || '');
  if (!html) throw new Error('No HTML from trends');
  const $ = cheerio.load(html);
  const token = $('meta[name="csrf-token"]').attr('content') || '';
  if (!token) throw new Error('CSRF token not found');
  return token;
}
async function erankApiGet(path) {
  const csrf = await getCsrfToken();
  const url  = `https://members.erank.com/${path}`;
  const { data } = await http.get(url, { headers: apiHeaders(ER, csrf), timeout: 60000 });
  return data;
}

// ---- DEBUG ----
app.get('/erank/debug', async (req, res) => {
  try {
    const u = String(req.query.url || TREND_ENV || 'https://members.erank.com/trends');
    const r = await http.get(u, { headers: cookieHeaders(ER), timeout: 60000 });
    const html = typeof r.data === 'string' ? r.data : (r.data?.html || '');
    res.json({ url: u, ok: !!html && !looksLikeLoginOr404(html), snippet: String(html || '').slice(0, 400) });
  } catch (e) {
    res.status(502).json({ error: e.response?.data || e.message || String(e) });
  }
});

/* ---------------- ERANK ROUTES ---------------- */

// /erank/keywords -> usa /api/trend-buzz y agrupa títulos/keywords
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
      const candidates = [data.results, data.items, data.keywords, data.trends, data.data];
      for (const arr of candidates) {
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

// /erank/research -> mismos datos pero como objetos {title,link}
app.get('/erank/research', async (req, res) => {
  try {
    const q = (req.query.q || '').toString().toLowerCase();
    const data = await erankApiGet('api/trend-buzz');

    const items = [];
    const push = (title, link) => { title = (title||'').trim(); link=(link||'').trim(); if (title) items.push({ title, link }); };

    if (Array.isArray(data)) {
      for (const x of data) push(x?.title || x?.name || x?.keyword, x?.link || x?.url);
    } else if (data && typeof data === 'object') {
      const candidates = [data.items, data.results, data.trends, data.data];
      for (const arr of candidates) {
        if (Array.isArray(arr)) {
          for (const x of arr) {
            if (typeof x === 'string') push(x, '');
            else if (x && typeof x === 'object') push(x.title || x.name || x.keyword, x.link || x.url);
          }
        }
      }
    }

    let filtered = items;
    if (q) filtered = items.filter(o => (o.title||'').toLowerCase().includes(q));
    res.json({ source: 'members.erank.com/api/trend-buzz', query: req.query.q || '', count: filtered.length, items: filtered.slice(0, 20) });
  } catch (e) {
    console.error('research error:', e.response?.status, e.response?.data || e.message || e);
    res.status(502).json({ error: e.response?.data || e.message || e.toString() });
  }
});

/* ------------- ETSY (público) ------------- */

// /erank/products -> Etsy search
app.get('/erank/products', async (req, res) => {
  try {
    const q = String(req.query.q || '');
    const html = await fetchHtmlZenRows(`https://www.etsy.com/search?q=${encodeURIComponent(q)}`, 'li[data-search-result]');
    const $ = cheerio.load(html);
    const items = [];
    $('li[data-search-result]').each((_, el) => {
      const $el = $(el);
      const title = ($el.find('h3').first().text() || '').trim();
      const url   = ($el.find('a').attr('href') || '').trim();
      const price = ($el.find('.currency-value').first().text() || '').trim();
      const shop  = ($el.find('.v2-listing-card__shop').first().text() || '').trim();
      if (title || url) items.push({ title, url, price, shop });
    });
    res.json({ query: q, count: items.length, items: items.slice(0, 20) });
  } catch (e) {
    console.error('products error:', e.response?.data || e.message || e);
    res.status(502).json({ error: e.response?.data || String(e) });
  }
});

// /erank/mylistings -> Etsy shop
app.get('/erank/mylistings', async (req, res) => {
  try {
    const shop = String(req.query.shop || '');
    if (!shop) return res.status(400).json({ error: "Missing 'shop' param" });

    const html = await fetchHtmlZenRows(`https://www.etsy.com/shop/${encodeURIComponent(shop)}`, '.wt-grid__item-xs-6, .v2-listing-card');
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
  app._router?.stack?.forEach(mw => { if (mw.route) routes.push(Object.keys(mw.route.methods).join(',').toUpperCase() + ' ' + mw.route.path); });
  console.log('ROUTES:', routes);
  console.log('listening on', port);
});
