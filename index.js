// index.js — eRank via ZenRows (rendered DOM) + Cheerio. CommonJS for Node 18 on Render.

// 0) Fix undici File on Node 18 so axios doesn’t throw “File is not defined”
globalThis.File = globalThis.File || class File {};

const express = require('express');
const axios   = require('axios');
const cheerio = require('cheerio');

const app  = express();
const port = process.env.PORT || 3000;

// Normalize accidental double slashes in path
app.use((req, _res, next) => { 
  if (req.url.includes('//')) req.url = req.url.replace(/\/{2,}/g, '/'); 
  next(); 
});

// Health endpoints
app.get('/healthz',      (_req, res) => res.json({ ok: true }));
app.get('/erank/healthz',(_req, res) => res.json({ ok: true }));

// --- ENV
const ZR    = (process.env.ZENROWS_API_KEY || '').trim();
const ER    = (process.env.ERANK_COOKIES   || '').trim(); // "name=value; name2=value2; ..."
const PATH  = (process.env.ERANK_TREND_PATH || 'trends').trim(); // 'trends' or 'trend-buzz'
const TREND_URL = `https://members.erank.com/${PATH}`;
const UA    = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

const http = axios.create({ timeout: 120000 });

// --- ZenRows helper for rendered HTML with your cookie
async function fetchRenderedHtml(url) {
  const params = {
    apikey: ZR,
    url,
    js_render: 'true',
    custom_headers: 'true',
    premium_proxy: 'true',
    block_resources: 'image,font,stylesheet',
    wait: '5000'
  };

  const { data } = await http.get('https://api.zenrows.com/v1/', {
    params,
    headers: { 'User-Agent': UA, ...(ER ? { Cookie: ER } : {}) },
    timeout: 120000
  });

  const html = typeof data === 'string' ? data : (data?.html || '');
  if (!html) throw new Error(`Empty HTML from renderer for ${url}`);
  return html;
}

// --- Debug endpoint
app.get('/erank/debug', async (req, res) => {
  try {
    const target = String(req.query.url || TREND_URL);
    const html = await fetchRenderedHtml(target);
    const ok = /trend|keyword|h2|h3/i.test(html);
    res.json({ url: target, ok, snippet: html.slice(0, 600) });
  } catch (e) {
    res.status(502).json({ error: e.response?.data || String(e) });
  }
});

// --- /erank/keywords
app.get('/erank/keywords', async (req, res) => {
  try {
    const q = String(req.query.q || '').toLowerCase();
    const html = await fetchRenderedHtml(TREND_URL);
    const $ = cheerio.load(html);
    const words = new Set();

    $('.trend-card .title, [data-testid="trend-title"], .trend-title, h2, h3').each((_, el) => {
      const t = $(el).text().trim();
      if (t) words.add(t);
    });

    $('[class*="keyword"], [class*="tag"], [data-testid="keyword"]').each((_, el) => {
      const t = $(el).text().trim();
      if (t) words.add(t);
    });

    let results = Array.from(words);
    if (q) results = results.filter(s => s.toLowerCase().includes(q));

    res.json({ source: TREND_URL, query: q, count: results.length, results: results.slice(0, 20) });
  } catch (e) {
    console.error('keywords scrape error:', e.response?.data || e.message || e);
    res.status(502).json({ error: e.response?.data || String(e) });
  }
});

// --- /erank/research
app.get('/erank/research', async (req, res) => {
  try {
    const q = String(req.query.q || '').toLowerCase();
    const html = await fetchRenderedHtml(TREND_URL);
    const $ = cheerio.load(html);
    const items = [];
    $('.trend-card, [data-testid="trend-card"]').each((_, el) => {
      const $el = $(el);
      const title = ($el.find('.title, [data-testid="trend-title"], h2, h3').first().text() || '').trim();
      const link  = ($el.find('a').attr('href') || '').trim();
      if (title) {
        if (!q || title.toLowerCase().includes(q)) {
          items.push({ title, link });
        }
      }
    });
    res.json({ source: TREND_URL, query: q, count: items.length, items: items.slice(0, 20) });
  } catch (e) {
    console.error('research scrape error:', e.response?.data || e.message || e);
    res.status(502).json({ error: e.response?.data || String(e) });
  }
});

// --- /erank/products (Etsy público)
app.get('/erank/products', async (req, res) => {
  try {
    const q = String(req.query.q || '');
    const url = `https://www.etsy.com/search?q=${encodeURIComponent(q)}`;
    const html = await fetchRenderedHtml(url);
    const $ = cheerio.load(html);
    const items = [];
    $('li[data-search-result], .v2-listing-card').each((_, el) => {
      const $el = $(el);
      const title = ($el.find('h3, [data-test="listing-title"], [data-test="listing-card-title"]').first().text() || '').trim();
      const link  = ($el.find('a').attr('href') || '').trim();
      const price = ($el.find('.currency-value, [data-buy-box-listing-price"]').first().text() || '').trim();
      const shop  = ($el.find('.v2-listing-card__shop, .text-body-secondary, .text-body-small').first().text() || '').trim();
      if (title || link) items.push({ title, url: link, price, shop });
    });
    res.json({ query: q, count: items.length, items: items.slice(0, 20) });
  } catch (e) {
    console.error('products error:', e.response?.data || e.message || e);
    res.status(502).json({ error: e.response?.data || String(e) });
  }
});

// --- /erank/mylistings (Etsy shop público)
app.get('/erank/mylistings', async (req, res) => {
  try {
    const shop = String(req.query.shop || '');
    if (!shop) return res.status(400).json({ error: "Missing 'shop' param" });
    const url = `https://www.etsy.com/shop/${encodeURIComponent(shop)}`;
    const html = await fetchRenderedHtml(url);
    const $ = cheerio.load(html);
    const items = [];
    $('.wt-grid__item-xs-6, .v2-listing-card').each((_, el) => {
      const $el = $(el);
      const title = ($el.find('h3').first().text() || '').trim();
      const link  = ($el.find('a').attr('href') || '').trim();
      const price = ($el.find('.currency-value').first().text() || '').trim();
      const tags  = ($el.find('[data-buy-box-listing-tags], .tag').text() || '').trim();
      if (title || link) items.push({ title, url: link, price, tags });
    });
    res.json({ shop, count: items.length, items: items.slice(0, 50) });
  } catch (e) {
    console.error('mylistings error:', e.response?.data || e.message || e);
    res.status(500).json({ error: e.response?.data || String(e) });
  }
});

app.listen(port, '0.0.0.0', () => {
  const routes = [];
  app._router?.stack.forEach(mw => { 
    if (mw.route) routes.push(Object.keys(mw.route.methods).join(',').toUpperCase() + ' ' + mw.route.path); 
  });
  console.log('ROUTES:', routes);
  console.log('Your service is live on port', port);
});
