// ===== index.js (CommonJS) — orden correcto =====

// Polyfill antes de axios (undici en Node 18)
globalThis.File = globalThis.File || class File {};

// Bootstrap de diagnóstico (no usa 'app')
process.on('uncaughtException', e => { console.error('uncaughtException:', e); process.exit(1); });
process.on('unhandledRejection', e => { console.error('unhandledRejection:', e); process.exit(1); });
console.log('Booting eRank scraper...');
console.log('Node version:', process.version);
console.log('PORT=', process.env.PORT);
console.log('ZENROWS_API_KEY set =', !!process.env.ZENROWS_API_KEY);
console.log('ERANK_COOKIES set =', !!(process.env.ERANK_COOKIES || process.env.ERANK_COOKIE));

const express = require('express');
const axios   = require('axios');
const cheerio = require('cheerio');

const app  = express();                               // <-- define 'app' AQUÍ
const port = process.env.PORT || 3000;

// Normaliza // -> /
app.use((req, _res, next) => {
  if (req.url.includes('//')) req.url = req.url.replace(/\/{2,}/g, '/');
  next();
});

// Healthcheck
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// ---- Config ----
const ZR = process.env.ZENROWS_API_KEY || '';
const ER = (process.env.ERANK_COOKIES || process.env.ERANK_COOKIE || '').trim();

function headersWithCookie(cookie) {
  return { 'User-Agent': 'Mozilla/5.0', ...(cookie ? { Cookie: cookie } : {}) };
}

// ZenRows -> HTML (sin css_extractor)
async function zenGet(params, headers, timeout = 120000) {
  const { data } = await axios.get('https://api.zenrows.com/v1/', { params, headers, timeout });
  return data;
}
async function fetchHtml(url, cookie = '', waitFor = 'body') {
  const params = {
    apikey: ZR,
    url,
    js_render: 'true',
    custom_headers: 'true',
    premium_proxy: 'true',
    block_resources: 'true',
    wait_for: waitFor
  };
  const data = await zenGet(params, headersWithCookie(cookie));
  if (typeof data === 'string') return data;
  if (data?.html) return data.html;
  throw new Error(JSON.stringify(data));
}

function looksLike404OrLogin(html) {
  const s = String(html || '').toLowerCase();
  return s.includes('page you were looking for was not found')
      || s.includes('sign in') || s.includes('login');
}

const TREND_CANDIDATES = [
  process.env.ERANK_TREND_URL || '',                 // si la defines en Render, se intentará primero
  'https://members.erank.com/trends',
  'https://members.erank.com/trend-buzz',
  'https://members.erank.com/keyword-trends',
  'https://members.erank.com/trendbuzz'
].filter(Boolean);

async function resolveTrendUrl(cookie) {
  for (const u of TREND_CANDIDATES) {
    try {
      const html = await fetchHtml(u, cookie, 'body');
      if (html && !looksLike404OrLogin(html)) return { url: u, html };
    } catch (_) {}
  }
  return { url: null, html: null };
}

// ---- Debug ----
app.get('/erank/debug', async (req, res) => {
  try {
    const u = String(req.query.url || TREND_CANDIDATES[0] || 'https://members.erank.com/trends');
    const html = await fetchHtml(u, ER, 'body');
    res.json({ url: u, ok: !looksLike404OrLogin(html), snippet: String(html || '').slice(0, 500) });
  } catch (e) {
    res.status(500).json({ error: e.response?.data || String(e) });
  }
});

// ---- Rutas ----
app.get('/erank/keywords', async (req, res) => {
  try {
    const q = String(req.query.q || '');
    const { url, html } = await resolveTrendUrl(ER);
    if (!url) return res.status(502).json({ error: 'No trend page found (login/404)' });
    const $ = cheerio.load(html);
    const set = new Set();
    $('.trend-card .title, .trend, [data-testid="trend"], h1, h2, h3').each((_, el) => {
      const t = $(el).text().trim();
      if (t) set.add(t);
    });
    const results = Array.from(set);
    res.json({ source: url, query: q, count: results.length, results: results.slice(0, 20) });
  } catch (e) {
    console.error('keywords error:', e.response?.data || e.message || e);
    res.status(500).json({ error: e.response?.data || String(e) });
  }
});

app.get('/erank/products', async (req, res) => {
  try {
    const q = String(req.query.q || '');
    const html = await fetchHtml(`https://www.etsy.com/search?q=${encodeURIComponent(q)}`, '', 'li[data-search-result]');
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
    res.status(500).json({ error: e.response?.data || String(e) });
  }
});

app.get('/erank/mylistings', async (req, res) => {
  try {
    const shop = String(req.query.shop || '');
    if (!shop) return res.status(400).json({ error: "Missing 'shop' param" });
    const html = await fetchHtml(`https://www.etsy.com/shop/${encodeURIComponent(shop)}`, '', '.wt-grid__item-xs-6, .v2-listing-card');
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

app.get('/erank/research', async (req, res) => {
  try {
    const q = String(req.query.q || '');
    const { url, html } = await resolveTrendUrl(ER);
    if (!url) return res.status(502).json({ error: 'No trend page found (login/404)' });
    const $ = cheerio.load(html);
    const items = [];
    $('.trend-card, .card, [data-testid="trend-card"]').each((_, el) => {
      const $el = $(el);
      const title = ($el.find('.title, h2, h3, [data-testid="trend-title"]').first().text() || '').trim();
      const link  = ($el.find('a').attr('href') || '').trim();
      if (title) items.push({ title, link });
    });
    res.json({ source: url, query: q, count: items.length, items: items.slice(0, 20) });
  } catch (e) {
    console.error('research error:', e.response?.data || e.message || e);
    res.status(500).json({ error: e.response?.data || String(e) });
  }
});

app.listen(port, '0.0.0.0', () => {
  const routes = [];
  app._router?.stack?.forEach(mw => { if (mw.route) routes.push(Object.keys(mw.route.methods).join(',').toUpperCase() + ' ' + mw.route.path); });
  console.log('ROUTES:', routes);
  console.log('listening on', port);
});
