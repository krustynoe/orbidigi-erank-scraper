// index.js (CommonJS)
const express = require('express');
const axios   = require('axios');

const app  = express();                 // <-- crea app ANTES de usar app.use
const port = process.env.PORT || 3000;

// ↓ Normaliza dobles barras en la URL: //erank -> /erank
app.use((req, _res, next) => {
  if (req.url.includes('//')) req.url = req.url.replace(/\/{2,}/g, '/');
  next();
});

// opcional: healthcheck + listado de rutas
app.get('/healthz', (_req, res) => res.json({ ok: true }));

const ZR = process.env.ZENROWS_API_KEY || '';
const ER = (process.env.ERANK_COOKIES || process.env.ERANK_COOKIE || '').trim();

function headersWithCookie(cookie) {
  return { 'User-Agent': 'Mozilla/5.0', ...(cookie ? { Cookie: cookie } : {}) };
}
async function zenrows(url, extractor, cookie) {
  const params = {
    apikey: ZR,
    url,
    js_render: 'true',
    custom_headers: 'true',
    // intenta esperar a que cargue algo del DOM dinámico
    wait_for: 'h1, h2, h3, .trend-card, .title',
    css_extractor: JSON.stringify(extractor), // OBJETO -> JSON.stringify obligatoriamente
  };
  const { data } = await axios.get('https://api.zenrows.com/v1/', {
    params, headers: headersWithCookie(ER)
  });
  return data;
}

// eRank routes
app.get('/erank/keywords', async (req, res) => {
  try {
    const q = String(req.query.q || '');
    const data = await zenrows(
      'https://members.erank.com/trend-buzz',
      { results: { selector: 'h1,h2,h3,.trend-title,[data-testid="trend"]', type: 'text', all: true } },
      ER
    );
    const results = Array.isArray(data?.[ 'results' ]) ? data.results.filter(Boolean) : [];
    res.json({ query: q, count: results.length, results: results.slice(0, 20) });
  } catch (e) {
    console.error(e?.response?.data || e);
    res.status(500).json({ error: e?.response?.data || String(e) });
  }
});

app.get('/erank/products', async (req, res) => {
  try {
    const q = String(req.query.q || '');
    const data = await zenrows(
      `https://www.etsy.com/search?q=${encodeURIComponent(q)}`,
      {
        items: [{
          selector: 'li[data-search-result]',
          values: {
            title: { selector: 'h3', type: 'text' },
            url:   { selector: 'a',  type: 'attr', attr: 'href' },
            price: { selector: '.currency-value', type: 'text', optional: true },
            shop:  { selector: '.v2-listing-card__shop', type: 'text', optional: true }
          }
        }]
      },
      '' // Etsy no necesita cookie
    );
    const items = Array.isArray(data?.items) ? data.items : [];
    res.json({ query: q, count: items.length, items: items.slice(0, 20) });
  } catch (e) {
    console.error(e?.response?.data || e);
    res.status(500).json({ error: e?.response?.data || String(e) });
  }
});

app.get('/erank/mylistings', async (req, res) => {
  try {
    const shop = String(req.query.shop || '');
    if (!shop) return res.status(400).json({ error: "Missing 'shop' param" });
    const data = await zenrows(
      `https://www.etsy.com/shop/${encodeURIComponent(shop)}`,
      {
        items: [{
          selector: '.wt-grid__item-xs-6',
          values: {
            title: { selector: 'h3', type: 'text' },
            url:   { selector: 'a',  type: 'attr', attr: 'href' },
            price: { selector: '.currency-value', type: 'text', optional: true },
            tags:  { selector: '[data-buy-box-listing-tags]', type: 'text', optional: true }
          }
        }]
      },
      ''
    );
    const items = Array.isArray(data?.items) ? data.items : [];
    res.json({ shop, count: items.length, items: items.slice(0, 50) });
  } catch (e) {
    console.error(e?.response?.data || e);
    res.status(500).json({ error: e?.response?.data || String(e) });
  }
});

app.get('/erank/research', async (req, res) => {
  try {
    const q = String(req.query.q || '');
    const data = await zenrows(
      'https://members.erank.com/trend-buzz',
      { items: [{ selector: '.trend-card,.card,[data-testid="trend-card"]', 
                  values: { title: { selector: '.title,h2,h3,[data-testid="trend-title"]', type: 'text' },
                            link:  { selector: 'a', type: 'attr', attr: 'href', optional: true } } }] },
      ER
    );
    const items = Array.isArray(data?.items) ? data.items : [];
    res.json({ query: q, count: items.length, items: items.slice(0, 20) });
  } catch (e) {
    console.error(e?.response?.data || e);
    res.status(500).json({ error: e?.response?.data || String(e) });
  }
});

app.listen(port, '0.0.0.0', () => {
  // imprime rutas cargadas para verificar
  const routes = [];
  app._router.stack.forEach(mw => {
    if (mw.route) routes.push(Object.keys(mw.route.methods).join(',').toUpperCase() + ' ' + mw.route.path);
  });
  console.log('ROUTES:', routes);
  console.log('listening on', port);
});
