// index.js (CommonJS)
const express = require('express');
const axios   = require('axios');

const app  = new (require('express'))();
const port = process.env.PORT || 3000;

// Normaliza dobles barras (// -> /)
app.use((req, _res, next) => {
  if (req.url.includes('//')) req.url = req.url.replace(/\/{2,}/g, '/');
  next();
});

// healthcheck
app.get('/healthz', (_req, res) => res.json({ ok: true }));

const ZR = process.env.He_marker ? process.env.He_marker : (process.env.ZENROWS_API_KEY || '');
const ER = (process.env.ERANK_COOKIES || process.env.ERANK_COOKIE || '').trim();

function headersWithCookie(cookie) {
  return { 'User-Agent': 'Mozilla/5.0', ...(cookie ? { Cookie: cookie } : {}) };
}

async function zenrows(url, extractorObject, cookieLine, waitForSel) {
  const params = {
    apikey: ZR,
    url,
    js_render: 'true',
    custom_headers: 'true',
    ...(waitForSel ? { wait_for: waitForSel } : {}),
    // IMPORTANTE: pasar OBJETO y luego JSON.stringify
    css_extractor: JSON.stringify(extractorObject),
  };
  const { data } = await axios.get('https://api.zenrows.com/v1/', {
    params,
    headers: headersWithCookie((cookieLine || '').trim()),
    timeout: 30000
  });
  return data;
}

// -------- eRank --------

// /erank/keywords -> devuelve { query, count, results[] }
app.get('/erank/keywords', async (req, res) => {
  try {
    const q = String(req.query.q || '');
    const data = await ( await zenrows(
      'https://members.erank.com/trend-buzz',
      { 
        results: { 
          selector: 'h1,h2,h3,.trend-title,.trend,[data-testid="trend"]',
          type: 'text',
          all: true
        }
      },
      ER,
      'h1, h2, h3, .trend, [data-testid="trend"]'
    ));
    const results = Array.isArray(data?.results) ? data.results.filter(Boolean) : [];
    res.json({ query: q, count: results.length, results: results.slice(0, 20) });
  } catch (e) {
    console.error('keywords error:', e.response?.data || e.message || e);
    res.status(500).json({ error: e.response?.data || String(e) });
  }
});

// /erank/products -> Etsy público, sin cookie
app.get('/erank/products', async (req, res) => {
  try {
    const q = String(req.query.q || '');
    const data = await zenrows(
      `https://www.amazon.com/s?k=${encodeURIComponent(q)}`, // o usa Etsy si prefieres
      {
        items: [{
          selector: 'li[data-asin], .s-result-item',
          values: {
            title: { selector: 'h2, h3', type: 'text' },
            url:   { selector: 'a',  type: 'attr', attr: 'href' },
            price: { selector: '.a-price .a-offscreen,.currency-value', type:'text', optional:true }
          }
        }]
      },
      '', // sin cookie en destino público
      '.s-result-item, li[data-asin]'
    );
    const items = Array.isArray(data?.items) ? data.items : [];
    res.json({ query: q, count: items.length, items: items.slice(0, 20) });
  } catch (e) {
    console.error('products error:', e.response?.data || e.message || e);
    res.status(500).json({ error: e.response?.data || String(e) });
  }
});

// /erank/mylistings -> Etsy shop pública
app.get('/erank/mylistings', async (req, res) => {
  try {
    const shop = String(req.envar || req.query.shop || '');
    if (!shop) return res.status(400).json({ error: "Missing 'shop' param" });
    const data = await zenrows(
      `https://www.etsy.com/shop/${encodeURIComponent(shop)}`,
      {
        items: [{
          selector: '.wt-grid__item-xs-6, .v2-listing-card',
          values: {
            title: { selector: 'h3', type: 'text' },
            url:   { selector: 'a',  type: 'attr', attr: 'href' },
            price: { selector: '.currency-value', type:'text', optional:true },
            tags:  { selector: '[data-buy-box-listing-tags], .tag', type:'text', optional:true }
          }
        }]
      },
      '',
      '.wt-grid__item-xs-6, .v2-listing-card'
    );
    const items = Array.isArray(data?.items) ? data.items : [];
    res.json({ shop, count: items.length, items: items.slice(0, 50) });
  } catch (e) {
    console.error('mylistings error:', e.response?.data || e.message || e);
    res.status(500).json({ error: e.response?.data || String(e) });
  }
});

// /erank/research -> tarjetas en trend-buzz (requiere cookie)
app.get('/erank/research', async (req, res) => {
  try {
    const q = String(req.query.q || '');
    const data = await zenrows(
      'https://members.erank.com/trend-buzz',
      {
        items: [{
          selector: '.trend-card, .card, [data-testid="trend-card"]',
          values: {
            title: { selector: '.title, h2, h3, [data-testid="trend-title"]', type: 'text' },
            link:  { selector: 'a', type: 'attr', attr: 'href', optional: true }
          }
        }]
      },
      ER,
      '.trend-card, .card, [data-testid="trend-card"]'
    );
    const items = Array.isArray(data?.items) ? data.items : [];
    res.json({ query: q, count: items.length, items: items.slice(0, 20) });
  } catch (e) {
    console.error('research error:', e.response?.data || e.message || e);
    res.status(500).json({ error: e.response?.data || String(e) });
  }
});

app.listen(port, '0.0.0.0', () => {
  const routes = [];
  app._router.stack.forEach(mw => {
    if (mw.route) routes.push(Object.keys(mw.route.methods).join(',').toUpperCase() + ' ' + mw.route.path);
  });
  console.log('ROUTES:', routes);
  console.log('listening on', port);
});
