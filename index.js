// index.js (CommonJS) — eRank con Cheerio sobre HTML de ZenRows

// 1) Polyfill antes de axios (evita "File is not defined" de undici)
globalThis.File = globalThis.File || class File {};

const express = require('express');
const axios   = require('axios');
const cheerio = require('cheerio');

const app  = express();
const port = process.env.PORT || 3000;

// Normaliza dobles barras (// -> /)
app.use((req, _res, next) => {
  if (req.url.includes('//')) req.url = req.url.replace(/\/{2,}/g, '/');
  next();
});

// Healthcheck
app.get('/healthz', (_req, res) => res.json({ ok: true }));

const ZR = process.env.ZENROWS_API_KEY || '';
const ER = (process.env.ERANK_COOKIES || process.env.ERANK_COOKIE || '').trim();

function headersWithCookie(cookie) {
  return { 'User-Agent': 'Mozilla/5.0', ...(cookie ? { Cookie: cookie } : {}) };
}

// Trae HTML renderizado con ZenRows; sin css_extractor para evitar REQS004
async function fetchHtml(url, cookie = '', waitFor = 'body') {
  const params = {
    apikey: ZR,
    url,
    js_render: 'true',
    custom_headers: 'true',
    wait_for: waitFor,
    // premium_proxy: 'true',  // descomenta si el sitio protege fuerte
    // block_resources: 'true'
  };
  const { data } = await axios.get('https://api.zenrows.com/v1/', {
    params,
    headers: headersWithCookie(cookie),
    timeout: 90000
  });
  if (typeof data === 'string') return data;
  if (data?.html) return data.html;
  throw new Error(JSON.stringify(data));
}

/* ---------------- RUTAS ERANK ---------------- */

// /erank/keywords -> { query, count, results[] }
app.get('/erank/keywords', async (req, res) => {
  try {
    const q = String(req.query.q || '');
    const html = await fetchHtml('https://members.erank.com/trend-buzz', ER, 'body');
    const $ = cheerio.load(html);
    const set = new Set();
    $('.trend-card .title, .trend, [data-testid="trend"], h1, h2, h3').each((_, el) => {
      const t = $(el).text().trim();
      if (t) set.add(t);
    });
    const results = Array.from(set);
    res.json({ query: q, count: results.length, results: results.slice(0, 20) });
  } catch (e) {
    console.error('keywords error:', e.response?.data || e.message || e);
    res.status(500).json({ error: e.response?.data || String(e) });
  }
});

// /erank/products -> ejemplo público (Etsy) { query, count, items[] }
app.get('/erank/products', async (req, res) => {
  try {
    const q = String(req.query.q || '');
    const html = await fetchHtml(
      `https://www.etsy.com/search?q=${encodeURIComponent(q)}`,
      '',
      'li[data-search-result]'
    );
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

// /erank/mylistings -> Etsy shop pública { shop, count, items[] }
app.get('/erank/mylistings', async (req, res) => {
  try {
    const shop = String(req.query.shop || '');
    if (!shop) return res.status(400).json({ error: "Missing 'shop' param" });

    const html = await fetchHtml(
      `https://www.etsy.com/shop/${encodeURIComponent(shop)}`,
      '',
      '.wt-grid__item-xs-6, .v2-listing-card'
    );
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

// /erank/research -> tarjetas en trend-buzz { query, count, items[] }
app.get('/erank/research', async (req, res) => {
  try {
    const q = String(req.query.q || '');
    const html = await fetchHtml(
      'https://members.erank.com/trend-buzz',
      ER,
      '.trend-card, .card, [data-testid="trend-card"]'
    );
    const $ = cheerio.load(html);
    const items = [];
    $('.trend-card, .card, [data-testid="trend-card"]').each((_, el) => {
      const $el = $(el);
      const title = ($el.find('.title, h2, h3, [data-testid="trend-title"]').first().text() || '').trim();
      const link  = ($el.find('a').attr('href') || '').trim();
      if (title) items.push({ title, link });
    });
    res.json({ query: q, count: items.length, items: items.slice(0, 20) });
  } catch (e) {
    console.error('research error:', e.response?.data || e.message || e);
    res.status(500).json({ error: e.response?.data || String(e) });
  }
});

app.listen(port, '0.0.0.0', () => {
  const routes = [];
  app._router.stack.forEach(mw => { if (mw.route) routes.push(Object.keys(mw.route.methods).join(',').toUpperCase() + ' ' + mw.route.path); });
  console.log('ROUTES:', routes);
  console.log('listening on', port);
});
