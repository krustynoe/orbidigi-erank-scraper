// index.js — eRank via ZenRows (rendered DOM) + Cheerio. CommonJS for Node 18 on Render.

globalThis.File = globalThis.File || class File {};

const express = require('express');
const axios   = require('axios');
const cheerio = require('cheerio');

const app  = express();
const port = process.env.PORT || 3000;

// Normaliza // en paths
app.use((req, _res, next) => {
  if (req.url.includes('//')) req.url = req.url.replace(/\/{2,}/g, '/');
  next();
});

// Health
app.get('/healthz',       (_req, res) => res.json({ ok: true }));
app.get('/erank/healthz', (_req, res) => res.json({ ok: true }));

// ENV
const ZR   = (process.env.ZENROWS_API_KEY || '').trim();
const ER   = (process.env.ERANK_COOKIES    || '').trim(); // "name=val; name2=val2"
const PATH = (process.env.ERANK_TREND_PATH || 'trends').trim(); // 'trends' | 'trend-buzz'
const TREND_URL = `https://members.erank.com/${PATH}`;
const UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

const http = axios.create({ timeout: 120000 });

// ZenRows helper
async function fetchRenderedHtml(url, { waitMs = 8000, block = 'image,font,stylesheet' } = {}) {
  const params = {
    apikey: ZR,
    url,
    js_render: 'true',
    custom_headers: 'true',
    premium_proxy: 'true',
    block_resources: block,
    wait: String(waitMs)
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

// --- Helpers extracción
function collectFromDom($) {
  const out = new Set();
  $('.trend-card .title, [data-testid="trend-title"], .trend-title, h2, h3').each((_, el) => {
    const t = $(el).text().trim();
    if (t) out.add(t);
  });
  $('[class*="keyword"], [class*="tag"], [data-testid="keyword"]').each((_, el) => {
    const t = $(el).text().trim();
    if (t) out.add(t);
  });
  return Array.from(out);
}

function jsonBlocksFromScripts($) {
  const out = [];

  // 1) <script type="application/json">...</script>
  $('script[type="application/json"]').each((_, el) => {
    const txt = ($(el).html() || '').trim();
    if (txt) out.push(txt);
  });

  // 2) window.__X = {...}; y arrays
  $('script').each((_, el) => {
    const txt = ($(el).html() || '').trim();
    if (!txt) return;

    const patterns = [
      /__NEXT_DATA__\s*=\s*({[\s\S]*?});/g,
      /__NUXT__\s*=\s*({[\s\S]*?});/g,
      /__INITIAL_STATE__\s*=\s*({[\s\S]*?});/g,
      /window\.[A-Za-z0-9_$.-]+\s*=\s*({[\s\S]*?});/g,
      /window\.[A-Za-z0-9_$.-]+\s*=\s*(\[[\s\S]*?\]);/g
    ];

    for (const re of patterns) {
      let m;
      while ((m = re.exec(txt))) {
        const balanced = balanceJson(m[1]);
        if (balanced) out.push(balanced);
      }
    }
  });

  return out;
}

function balanceJson(raw) {
  const s = (raw || '').trim();
  const first = s[0];
  const open = first === '{' ? '{' : first === '[' ? '[' : null;
  const close = open === '{' ? '}' : open === '[' ? ']' : null;
  if (!open) return null;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return s.slice(0, i + 1);
    }
  }
  return null;
}

function walkStrings(node, acc) {
  if (typeof node === 'string') {
    const v = node.trim();
    if (v && v.length <= 100) acc.add(v);
    return;
  }
  if (Array.isArray(node)) { node.forEach(n => walkStrings(n, acc)); return; }
  if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (typeof v === 'string' && /title|name|keyword|term/i.test(k)) {
        const s = v.trim(); if (s) acc.add(s);
      } else {
        walkStrings(v, acc);
      }
    }
  }
}

// Debug
app.get('/erank/debug', async (req, res) => {
  try {
    const target = String(req.query.url || TREND_URL);
    const html = await fetchRenderedHtml(target, { waitMs: 8000 });
    const ok = /trend|keyword|h2|h3/i.test(html);
    res.json({ url: target, ok, snippet: html.slice(0, 600) });
  } catch (e) {
    res.status(502).json({ error: e.response?.data || String(e) });
  }
});

// /erank/keywords con retries + JSON fallback
app.get('/erank/keywords', async (req, res) => {
  try {
    const q = String(req.query.q || '').toLowerCase();

    // 1) 8 s con stylesheet bloqueado
    let html = await fetchRenderedHtml(TREND_URL, { waitMs: 8000, block: 'image,font,stylesheet' });
    let $ = cheerio.load(html);
    let results = collectFromDom($);

    // 2) 12 s con stylesheet bloqueado
    if (results.length === 0) {
      html = await fetchRenderedHtml(TREND_URL, { waitMs: 12000, block: 'image,font,stylesheet' });
      $ = cheerio.load(html);
      results = collectFromDom($);
    }

    // 3) 15 s permitiendo stylesheet (sin bloqueos)
    if (results.length === 0) {
      html = await fetchRenderedHtml(TREND_URL, { waitMs: 15000, block: '' });
      $ = cheerio.load(html);
      results = collectFromDom($);
    }

    // 4) Fallback: JSON embebido
    if (results.length === 0) {
      const acc = new Set();
      for (const raw of jsonBlocksFromScripts($)) {
        try { walkStrings(JSON.parse(raw), acc); } catch (_) {}
      }
      results = Array.from(acc);
    }

    if (q) results = results.filter(s => s.toLowerCase().includes(q));
    results = Array.from(new Set(results.map(s => s.trim()))).filter(Boolean);

    res.json({ source: TREND_URL, query: q, count: results.length, results: results.slice(0, 100) });
  } catch (e) {
    console.error('keywords scrape error:', e.response?.data || e.message || e);
    res.status(502).json({ error: e.response?.data || String(e) });
  }
});

// /erank/inspect: introspección de scripts y títulos
app.get('/erank/inspect', async (_req, res) => {
  try {
    const html = await fetchRenderedHtml(TREND_URL, { waitMs: 15000, block: '' });
    const $ = cheerio.load(html);
    const scripts = [];
    $('script').each((i, el) => {
      const txt = ($(el).html() || '').trim();
      scripts.push({ i, len: txt.length, head: txt.slice(0, 120) });
    });
    const titles = collectFromDom($);
    res.json({ source: TREND_URL, scripts: scripts.slice(0, 20), titles: titles.slice(0, 20) });
  } catch (e) {
    res.status(502).json({ error: e.response?.data || String(e) });
  }
});

// /erank/research
app.get('/erank/research', async (req, res) => {
  try {
    const q = String(req.query.q || '').toLowerCase();
    const html = await fetchRenderedHtml(TREND_URL, { waitMs: 8000, block: 'image,font,stylesheet' });
    const $ = cheerio.load(html);
    const items = [];
    $('.trend-card, [data-testid="trend-card"]').each((_, el) => {
      const $el = $(el);
      const title = ($el.find('.title, [data-testid="trend-title"], h2, h3').first().text() || '').trim();
      const link  = ($el.find('a').attr('href') || '').trim();
      if (title && (!q || title.toLowerCase().includes(q))) items.push({ title, link });
    });
    res.json({ source: TREND_URL, query: q, count: items.length, items: items.slice(0, 50) });
  } catch (e) {
    console.error('research scrape error:', e.response?.data || e.message || e);
    res.status(502).json({ error: e.response?.data || String(e) });
  }
});

// Etsy público
app.get('/erank/products', async (req, res) => {
  try {
    const q = String(req.query.q || '');
    const url = `https://www.etsy.com/search?q=${encodeURIComponent(q)}`;
    const html = await fetchRenderedHtml(url, { waitMs: 8000, block: 'image,font,stylesheet' });
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

// Etsy shop público
app.get('/erank/mylistings', async (req, res) => {
  try {
    const shop = String(req.query.shop || '');
    if (!shop) return res.status(400).json({ error: "Missing 'shop' param" });
    const url = `https://www.etsy.com/shop/${encodeURIComponent(shop)}`;
    const html = await fetchRenderedHtml(url, { waitMs: 8000, block: 'image,font,stylesheet' });
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
  console.log('listening on', port);
});
