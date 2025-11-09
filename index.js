// index.js (CommonJS) — eRank API JSON + Etsy (ZenRows) + Cheerio

// Polyfill para undici en Node 18
globalThis.File = globalThis.File || class File {};

const express = require('express');
const axios   = require('axios');
const cheerio = require('cheerio');

const app  = express();
const port = process.env.PORT || 3000;

app.use((req, _res, next) => {
  if (req.url.includes('//')) req.url = req.url.replace(/\/{2,}/g, '/');
  next();
});

// Health
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// ENV
const ERANK_COOKIES = (process.env.ERANK_COOKIES || process.env.ERANK_COOKIE || '').trim();
const ZR            = process.env.ZENROWS_API_KEY || '';

function cookieHeaders(cookie) {
  return {
    'User-Agent'      : 'Mozilla/5.0',
    'Accept'          : 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Cookie'          : cookie || ''
  };
}

// ------- eRank API JSON (sin ZenRows) -------

// /erank/keywords -> usa API /api/trend-buzz y devuelve títulos/keywords
app.get('/erank/keywords', async (req, res) => {
  try {
    const q = String(req.query.q || '').toLowerCase();
    // Endpoint visto en tu HTML: window.Ziggy.routes.api['trend-buzz']
    const url = 'https://members.erank.com/api/trend-buzz';

    const { data } = await axios.get(url, {
      headers: cookieHeaders(ERANK_COOKIES),
      timeout: 60000
    });

    // Normaliza posibles estructuras (depende de tu plan / respuesta real)
    // Intenta construir una lista de títulos/keywords desde campos típicos
    const pool = [];
    if (Array.isArray(data)) {
      data.forEach(x => {
        const t = (x?.title || x?.name || x?.keyword || '').toString().trim();
        if (t) pool.push(t);
      });
    } else if (data && typeof data === 'object') {
      const guessArrays = [data.results, data.items, data.keywords, data.trends, data.data];
      guessArrays.filter(Array.isArray).forEach(arr => {
        arr.forEach(x => {
          if (typeof x === 'string') pool.push(x.trim());
          else if (x && typeof x === 'object') {
            const t = (x.title || x.name || x.keyword || '').toString().trim();
            if (t) pool.push(t);
          }
        });
      });
    }

    let results = Array.from(new Set(pool)).filter(Boolean);
    if (q) results = results.filter(s => s.toLowerCase().includes(q));
    res.json({ source: url, query: req.query.q || '', count: results.length, results: results.slice(0, 20) });
  } catch (e) {
    console.error('keywords error:', e.response?.status, e.response?.data || e.message || e);
    res.status(502).json({ error: e.response?.data || String(e) });
  }
});

// /erank/research -> igual, pero devuelve objetos {title, link}
app.get('/erank/research', async (req, res) => {
  try {
    const q = String(req.query.q || '').toLowerCase();
    const url = 'https://members.erank.com/api/trend-buzz';

    const { data } = await axios.get(url, {
      headers: cookieHeaders(ERANK_COOKIES),
      timeout: 60000
    });

    const items = [];
    const push = (title, link) => {
      title = (title || '').toString().trim();
      link  = (link  || '').toString().trim();
      if (title) items.push({ title, link });
    };

    if (Array.isArray(data)) {
      data.forEach(x => push(x?.title || x?.name || x?.keyword, x?.link || x?.url));
    } else if (data && typeof data === 'object') {
      const guessArrays = [data.items, data.results, data.trends, data.data];
      guessArrays.filter(Array.isArray).forEach(arr => {
        arr.forEach(x => {
          if (typeof x === 'string') push(x, '');
          else if (x && typeof x === 'object') push(x.title || x.name || x.keyword, x.link || x.url);
        });
      });
    }

    let filtered = items;
    if (q) filtered = items.filter(o => (o.title || '').toLowerCase().includes(q));
    res.json({ source: url, query: req.query.q || '', count: filtered.length, items: filtered.slice(0, 20) });
  } catch (e) {
    console.error('research error:', e.response?.status, e.response?.data || e.message || e);
    res.status(502).json({ error: e.response?.data || String(e) });
  }
});

// ------- Etsy (público) con ZenRows + Cheerio -------

function headersNoCookie() {
  return { 'User-Agent': 'Mozilla/5.0' };
}

// ZenRows -> HTML para páginas públicas
async function fetchHtmlZenRows(url, waitFor = 'body') {
  const params = {
    apikey: ZR,
    url,
    js_render: 'true',
    custom_headers: 'true',
    premium_proxy: 'true',
    // No bloqueamos scripts para que hidrate; sí podemos quitar imágenes
    block_resources: 'image,media,font,stylesheet',
    wait_for: waitFor
  };
  const { data } = await axios.get('https://api.zenrows.com/v1/', {
    params,
    headers: headersNoCookie(),
    timeout: 90000
  });
  if (typeof data === 'string') return data;
  if (data?.html) return data.html;
  throw new Error(JSON.stringify(data));
}

// /erank/products -> Etsy search { query, count, items[] }
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

// /erank/mylistings -> Etsy shop { shop, count, items[] }
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
    res.status(502).json({ error: e.response?.data || String(e) });
  }
});

app.listen(port, '0.0.0.0', () => {
  const routes = [];
  app._router?.stack?.forEach(mw => { if (mw.route) routes.push(Object.keys(mw.route.methods).join(',').toUpperCase() + ' ' + mw.route.path); });
  console.log('ROUTES:', routes);
  console.log('listening on', port);
});
