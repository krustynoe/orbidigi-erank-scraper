// index.js (CommonJS) — eRank via ZenRows (HTML) + Cheerio

// Polyfill antes de axios (evita "File is not defined" de undici, Node 18)
globalThis.File = globalThis.File || class File {};

const express = require('express');
const axios   = require('axios');
const cheerio = require('cheerio');

const app  = express();
const port = process.env.PORT || 3000;

// Normaliza dobles barras // -> /
app.use((req, _res, next) => {
  if (req.url.includes('//')) req.url = req.url.replace(/\/{2,}/g, '/');
  next();
});

// Healthcheck
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// ---- ENV ----
const ZR = process.env.ZENROWS_API_KEY || '';
const ER = (process.env.ERANK_COOKIES || process.env.ERANK_COOKIE || '').trim();
const TREND_ENV = (process.env.ERANK_TREND_URL || '').trim();

// ---- Helpers ----
function headersWithCookie(cookie) {
  return { 'User-Agent': 'Mozilla/5.0', ...(cookie ? { Cookie: cookie } : {}) };
}

// GET robusto con reintentos/backoff (para “socket hang up”/5xx)
async function zenGet(params, headers, { retries = 2, baseDelay = 1500 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const { data } = await axios.get('https://api.zenrows.com/v1/', {
        params,
        headers,
        timeout: 120000
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

// ZenRows -> HTML (sin css_extractor). Lista válida para block_resources.
async function fetchHtml(url, cookie = '', waitFor = 'body') {
  const params = {
    apikey: ZR,
    url,
    js_render: 'true',
    custom_headers: 'true',
    premium_proxy: 'true',
    block_resources: 'image,media,fonts,tracking',
    wait_for: waitFor
  };
  const data = await zenGet(params, headersWithCookie(cookie));
  if (typeof data === 'string') return data;
  if (data?.html) return data.html;
  throw new Error(JSON.stringify(data));
}

// Detecta 404/login en el HTML de destino
function looksLike404OrLogin(html) {
  const s = String(html || '').toLowerCase();
  return s.includes('page you were looking for was not found')
      || s.includes('sorry, the page you were looking for was not found')
      || s.includes('sign in') || s.includes('login');
}

// Candidatas para Trend Buzz (si definiste ERANK_TREND_URL, va primero)
const TREND_CANDIDATES = (TREND_ENV ? [TREND_ENV] : [
  'https://members.erank.com/trends',
  'https://members.erank.com/trend-buzz',
  'https://members.erank.com/keyword-trends',
  'https://members.erank.com/trendbuzz'
]);

// Resuelve la primera URL que devuelva contenido real
async function resolveTrendUrl(cookie) {
  for (const u of TREND_CANDIDATES) {
    try {
      const html = await fetchHtml(u, cookie, 'body');
      if (html && !looksLike404OrLogin(html)) return { url: u, html };
    } catch (_) {}
  }
  return { url: null, html: null };
}

// Debug: inspecciona una URL concreta
app.get('/erank/debug', async (req, res) => {
  try {
    const u = String(req.query.url || TREND_CANDIDATES[0] || 'https://members.erank.com/trends');
    const html = await fetchHtml(u, ER, 'body');
    res.json({ url: u, ok: !looksLike404OrLogin(html), snippet: String(html || '').slice(0, 500) });
  } catch (e) {
    res.status(500).json({ error: e.response?.data || String(e) });
  }
});

/* ---------------- RUTAS ERANK ---------------- */

// /erank/keywords -> { source, query, count, results[] }
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

// /erank/products -> Etsy público { query, count, items[] }
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

// /erank/mylistings -> Etsy shop { shop, count, items[] }
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

// /erank/research -> tarjetas { source, query, count, items[] }
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
