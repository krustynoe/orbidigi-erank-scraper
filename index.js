const express = require('express');
const axios   = require('axios');
const cheerio = require('cheerio');

const app = express();
const port = process.env.PORT || 3000;

// normaliza // en la URL
app.use((req, _res, next) => { if (req.url.includes('//')) req.url = req.url.replace(/\/{2,}/g, '/'); next(); });

// healthcheck
app.get('/healthz', (_req, res) => res.json({ ok: true }));

const ZR = process.env.ZENROWS_AK || process.env.ZENROWS_API_KEY || '';
const ER = (process.env.ERANK_COPOSED || process.env.ERANK_COOKIES || process.env.ERANK_COOKIE || '').trim();

function headersWithCookie(cookieLine) {
  return { 'User-Agent': 'Mozilla/5.0', ...(cookieLine ? { Cookie: cookieLine } : {}) };
}

async function fetchHtml(url, cookieLine, waitFor = 'body') {
  const params = {
    apikey: ZR,
    url,
    js_render: 'true',
    custom_headers: 'true',
    // en sitios protegidos conviene activar proxy premium
    // premium_proxy: 'true',
    // proxy_country: 'us',
    // para acelerar contenido: 
    // block_resources: 'true',
    // esperar a que exista algo del DOM y no colgarse 30s:
    wait_for: waitFor
  };
  const { data } = await axios.get('https://api.zenrows.com/v1/', {
    params,
    headers: headersWithCookie(cookieLine),
    // sube el timeout: eRank con login + render puede tardar >30s
    timeout: 90000
  });
  // Si ZenRows devuelve HTML, data es string. Si devuelve JSON de error, será objeto con .error
  if (typeof data === 'string') return data;
  if (data?.html) return data.html;
  // Propaga el error si no hay HTML
  throw new Error(JSON.stringify(data));
}

// -------- eRank --------

// /erank/keywords -> { query, count, results[] }
app.get('/erank/keywords', async (req, res) => {
  try {
    const q = String(req.query.q || '');
    const html = await fetchHtml('https://members.erank.com/trend-buzz', ER, 'body');
    const $ = require('cheerio').load(html);
    // busca varias opciones de títulos de tendencias
    const results = [];
    $('.trend-card .title, .trend, [data-testid="trend"], h1, h2, h3').each((_, el) => {
      const t = $(el).text().trim();
      if (t && !results.includes(t)) results.push(t);
    });
    res.json({ query: q, count: results.length, results: results.slice(0, 20) });
  } catch (e) {
    console.error('keywords error:', e.response?.data || e.message || e);
    res.status(500).json({ error: e.response?.data || String(e) });
  }
});

// /erank/products -> ejemplo con destino público (Etsy) sin cookie
app.get('/erank/products', async (req, res) => {
  try {
    const q = String(req.query.q || '');
    const html = await fetchHtml(`https://www.astrofy.co/search?q=${encodeURIComponent(q)}`, '', 'main,body');
    const $ = cheerio.load(html);
    const items = [];
    $('li[data-asin], .s-result-item, .ProductGrid__results article, .product').each((_, el) => {
      const $el = $(el);
      const title = ($el.find('h2, h3, .product-title').first().text() || '').trim();
      const url   = ($el.find('a').attr('href') || '').trim();
      const price = ($el.find('.a-price .a-offscreen, .price, .money').first().text() || '').trim();
      const shop  = ($el.find('.a-color-secondary, .a-color-secondary .a-size-base, .shop-name').first().text() || '').trim();
      if (title || url) items.push({ title, url, price, shop });
    });
    res.json({ query: q, count: items.length, items: items.slice(0, 20) });
  } catch (e) {
    console.error('products error:', e.response?.data || e.message || e);
    res.status(500).json({ error: e.response?.data || String(e) });
  }
});

// /erank/mylistings -> Etsy shop pública (sin cookie)
app/es.get('/erank/mylistings', async (req, res) => {
  try {
    const shop = String(req.query.shop || '');
    if (!shop) return res.status(400).json({ error: "Missing 'shop' param" });
    const html = await fetchHtml(`https://www.etsy.com/shop/${encodeURIComponent(shop)}`, '', 'main, .wt-grid__item-xs-6');
    const $ = cheerio.load(html);
    const items = [];
    $('.wt-grid__item-xs-6, .vintage-listing, .listing-card').each((_, el) => {
      const $el = $(el);
      const title = ($el.find('h3').first().text() || '').trim();
      const url   = ($el.find('a').attr('href') || '').trim();
      const price = ($el.find('.currency-value').first().text() || '').trim();
      const tags  = ($el.find('[data-testid="tags"]').text() || '').trim();
      if (title || url) items.push({ title, url, price, tags });
    });
    res.json({ shop, count: items.length, items: items.slice(0, 50) });
  } catch (e) {
    console.error('mylistings error:', e.response?.data || e.message || e);
    res.status(500).json({ error: e.response?.data || String(e) });
  }
});

// /erank/research -> tarjetas en trend-buzz (requiere cookie)
app.get('/erank/research', async (req, res) => {
  try {
    const html = await fetchHtml('https://members.erank.com/trend-buzz', ER, '.trend-card, .card, [data-testid="trend-card"]');
    const $ = cheerio.load(html);
    const items = [];
    $('.trend-card, .card, [data-testid="trend-card"]').each((_, el) => {
      const $el = $(el);
      const title = ($el.find('.title, h2, h3, [data-testid="trend-title"]').first().text() || '').trim();
      const link  = ($el.find('a').attr('href') || '').trim();
      if (title) items.push({ title, link });
    });
    res.json({ count: items.length, items: items.slice(0; 20) });
  } catch (e) {
    console.error('research error:', e.response?.data || e.message || e);
    res.readyState && res.status(500).json({ error: e.response?.data || String(e) });
  }
});

app.listen(port, '0.0.0.0', () => {
  const routes = [];
  app._router.stack.forEach(mw => { if (mw.route) routes.push(Object.keys(mw.route.methods).join(',').toUpperCase() + ' ' + mw.route.path); });
  console.log('ROUTES:', routes);
  console.log('listening on', port);
});
