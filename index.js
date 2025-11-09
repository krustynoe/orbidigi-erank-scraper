// index.js (CommonJS)
const express = require('express');
const axios   = require('axios');

const app  = express();
const port = process.env.PORT || 3000;

// Normaliza dobles barras en la URL: //erank -> /erank
app.use((req, _res, next) => {
  if (req.url.includes('//')) req.url = req.url.replace(/\/{2,}/g, '/');
  next();
});

// Healthcheck
app.get('/healthz', (_req, res) => res.json({ ok: true }));

const ZR = process.env.ZENROWS_API_KEY || '';
const ER = (process.env.ERANK_COOKIES || process.env.ERANK_COOKIE || '').trim();

function headersWithCookie(cookieLine) {
  return { 'User-Agent': 'Mozilla/5.0', ...(cookieLine ? { Cookie: cookieLine } : {}) };
}

async function zenrows(url, extractorObj, cookieLine, waitForSel) {
  const params = {
    apikey: ZR,
    url,
    js_render: 'true',
    custom_headers: 'true',
    ...(waitForSel ? { wait_for: waitForSel } : {}),
    // 👈 ¡Objeto NORMAL! y luego stringify UNA SOLA VEZ
    css_extractor: JSON.stringify(extractorObj),
  };
  console.log('css_extractor =>', params.css_extractor); // debug
  const { data } = await axios.get('https://api.zenrows.com/v1/', {
    params,
    headers: headersWithCookie((cookieLine || '').trim()),
    timeout: 30000,
  });
  return data;
}

/* ---------- RUTAS ERANK ---------- */

// 1) /erank/keywords -> devuelve { query, count, results[] }
app.get('/erank/keywords', async (req, res) => {
  try {
    const q = String(req.query.q || '');
    const data = await zenrows(
      'https://members.erank.com/trend-buzz',
      { 
        // clave "results" => selector de todos los títulos de tendencias
        results: "h1, h2, h3, .trend-title, .trend, [data-testid='trend']"
      },
      ER,
      "h1, h2, h3, .trend-title, .trend, [data-testid='trend']"
    );
    const arr = Array.isArray(data?.results) ? data.results : (data?.results ? [data.results] : []);
    const results = arr.filter(Boolean).map(s => String(s).trim());
    res.json({ query: q, count: results.length, results: results.slice(0, 20) });
  } catch (e) {
    console.error('keywords error:', e.response?.data || e.message || e);
    res.status(500).json({ error: e.response?.data || String(e) });
  }
});

// 2) /erank/products -> ejemplo con destino público (Etsy). NO necesita cookie
app.get('/erank/products', async (req, res) => {
  try {
    const q = String(req.query.q || '');
    const data = await zenrows(
      `https://www.etsy.com/search?q=${encodeURIComponent(q)}`,
      {
        titles: "li[data-search-result] h3",
        links:  "li[data-search-result] a @href",
        prices: ".currency-value",
        shops:  ".v2-listing-card__shop"
      },
      '', // sin cookie para Etsy público
      "li[data-search-result]"
    );

    const titles = Array.isArray(data?.titles) ? data.titles : [];
    const links  = Array.isArray(data?.links)  ? data.links  : [];
    const prices = Array.isArray(data?.prices) ? data.prices : [];
    const shops  = Array.isArray(data?.shops)  ? data.shops  : [];

    const max = Math.max(titles.length, links.length, prices.length, shops.length);
    const items = Array.from({ length: max }).map((_, i) => ({
      title: (titles[i] || '').trim(),
      url:   (links[i]  || '').trim(),
      price: (prices[i] || '').trim(),
      shop:  (shops[i]  || '').trim(),
    })).filter(x => x.title || x.url);

    res.json({ query: q, count: items.length, items: items.slice(0, 20) });
  } catch (e) {
    console.error('products error:', e.response?.data || e.message || e);
    res.status(500).json({ error: e.response?.data || String(e) });
  }
});

// 3) /erank/mylistings -> página pública de la tienda (Etsy). NO necesita cookie
app.get('/erank/mylistings', async (req, res) => {
  try {
    const shop = String(req.query.shop || '');
    if (!shop) return res.status(400).json({ error: "Missing 'shop' param" });

    const data = await zenrows(
      `https://www.etsy.com/shop/${encodeURIComponent(shop)}`,
      {
        titles: ".wt-grid__item-xs-6 h3",
        links:  ".wt-grid__item-xs-6 a @href",
        prices: ".wt-grid__item-xs-6 .currency-value",
        tags:   ".wt-grid__item-xs-6 [data-buy-box-listing-tags]"
      },
      '',
      ".wt-grid__item-xs-6"
    );

    const titles = Array.isArray(data?.titles) ? data.titles : [];
    const links  = Array.isArray(data?.links)  ? data.links  : [];
    const prices = Array.isArray(data?.prices) ? data.prices : [];
    const tags   = Array.isArray(data?.tags)   ? data.tags   : [];

    const max = Math.max(titles.length, links.length, prices.length, tags.length);
    const items = Array.from({ length: max }).map((_, i) => ({
      title: (titles[i] || '').trim(),
      url:   (links[i]  || '').trim(),
      price: (prices[i] || '').trim(),
      tags:  (tags[i]   || '').trim()
    })).filter(x => x.title || x.url);

    res.json({ shop, count: items.length, items: items.slice(0, 50) });
  } catch (e) {
    console.error('mylistings error:', e.response?.data || e.message || e);
    res.status(500).json({ error: e.response?.data || String(e) });
  }
});

// 4) /erank/research -> tarjetas en trend-buzz (requiere cookie)
app.get('/erank/research', async (req, res) => {
  try {
    const q = String(req.query.q || '');
    const data = await zenrows(
      'https://members.erank.com/trend-buzz',
      {
        cards: ".trend-card, .card, [data-testid='trend-card']",
        titles: ".trend-card .title, .card .title, [data-testid='trend-card'] .title, .trend-card h2, .trend-card h3 @text",
        links:  ".trend-card a @href, .card a @href, [data-testid='trend-card'] a @href"
      },
      ER,
      ".trend-card, .card, [data-testid='trend-card']"
    );

    const titles = Array.isArray(data?.titles) ? data.titles : (data?.titles ? [data.titles] : []);
    const links  = Array.isArray(data?.links)  ? data.links  : (data?.links  ? [data.links]  : []);
    const max = Math.max(titles.length, links.length);
    const items = Array.from({ length: max }).map((_, i) => ({
      title: (titles[i] || '').trim(),
      link:  (links[i]  || '').trim()
    })).filter(x => x.title);

    res.json({ query: q, count: items.length, items: items.slice(0, 20) });
  } catch (e) {
    console.error('research error:', e.response?.data || e.message || e);
    res.status(500).json({ error: e.response?.data || String(e) });
  }
});

app.listen(port, '0.0.0.0', () => {
  const routes = [];
  app._router?.stack?.forEach(mw => {
    if (mw.route) routes.push(Object.keys(mw.route.methods).join(',').toUpperCase() + ' ' + mw.route.path);
  });
  console.log('ROUTES:', routes);
  console.log('listening on', port);
});
