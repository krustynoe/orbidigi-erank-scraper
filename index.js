// index.js — eRank + ZenRows. CommonJS / Node 18 for Render

// ---- Fix undici File on Node 18 so axios doesn't crash ----
global.ThisIsToForceTop = true;
globalThis.File = globalThis.File || class File {};

const express = require('express');
const axios   = require('axios');
const cheerio = require('cheerio');

const app  = express();
const port = process.env.PORT || 3000;

app.use((req, _res, next) => { if (req.url.includes('//')) req.url = req.url.replace(/\/{2,}/g, '/'); next(); });
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/erank/healthz', (_req, res) => res.json({ ok: true }));

// ---- ENV
const ZR     = (process.env.ZENROWS_API_KEY || '').trim();
const BASE   = (process.env.ERANK_COOKIES || process.env.ERANK_COOKIES_RAW || '').trim(); // "a=1; b=2; ..."
const TREND_NAME = (process.env.ERANK_TREND_NAME || 'trends').trim(); // 'trends' or 'trend-buzz'
const TREND_URL  = `https://members.erank.com/${TREND_NAME}`;
const UA     = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

const http = axios.create({ timeout: 90000 });

// ---- Cookie helpers
function parseCookieLine(line) {
  const out = {};
  String(line || '')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean)
    .forEach(pair => {
      const i = pair.indexOf('=');
      if (i > 0) {
        const k = pair.slice(0, i).trim();
        const v = pair.slice(i + 1).trim();
        if (k) out[k] = v;
      }
    });
  return out;
}
function parseSetCookie(arr) {
  const out = {};
  (arr || []).forEach(sc => {
    const i = sc.indexOf('=');
    if (i > 0) {
      const name = sc.slice(0, i);
      const val  = sc.slice(i + 1).split(';')[0]; // RAW value (may be urlencoded)
      out[name]  = val;
    }
  });
}
function buildCookie(map) {
  return Object.entries(map).map(([k, v]) => `${k}=${v}`).join('; ');
}
const hdrForPage = (cookie) => ({ 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', ...(cookie ? { Cookie: cookie } : {}) });

// ---- Auth & CSRF bootstrap: GET /trends, merge cookies, extract CSRF meta + XSRF cookie
async function getAuthContext() {
  const r = await http.get(TREND_URL, { headers: hdrForPage(BASE), validateStatus: () => true });
  if (r.status >= 400) throw new Error(`GET ${TREND_URL} -> ${r.status}`);

  const html = typeof r.data === 'string' ? r.data : (r.data?.html || '');
  const $ = cheerio.load(html);
  const csrf = $('meta[name="csrf-token"]').attr('content') || '';
  if (!csrf) throw new Error('csrf-token meta not found');

  const baseMap = parseCookieLine(BASE);
  const setMap  = parseSetCookie(r.headers['set-cookie']);
  const merged  = { ...baseMap, ...setMap };     // include XSRF-TOKEN, sid_er, etc.
  const cookieLine = buildCookie(merged);

  const xsrfRaw    = merged['XSRF-TOKEN'] || '';
  const xsrfHeader = xsrfRaw ? decodeURIComponent(xsrfRaw) : '';
  if (!xsrfRaw) throw new Error('XSRF-TOKEN not present after /trends');

  return { cookieLine, csrf, xsrfHeader };
}

function apiHeaders(cookieLine, csrf, xsrfHeader) {
  return {
    'User-Agent'       : UA,
    'Accept'           : 'application/json, text/plain, */*',
    'Content-Type'     : 'application/json',
    'X-Requested-With' : 'XMLHttpRequest',
    'Origin'           : 'https://members.erank.com',
    'Referer'          : TREND_URL,
    'Cookie'           : cookieLine,     // must include XSRF-TOKEN=<raw>
    'X-CSRF-TOKEN'     : csrf,           // meta value
    'X-XSRF-TOKEN'     : xsrfHeader      // decodeURIComponent(XSRF-TOKEN)
  };
}

// ---- eRank API call with retry & endpoint fallbacks
async function callTrendingAPI(q) {
  const { cookieLine, csrf, xsrfHeader } = await getAuthContext();

  // Try official endpoints in order (based on your Network tab)
  const candidates = [
    `https://members.erank.com/api/trending-report?query=${encodeURIComponent(q)}`,
    `https://members.erank.com/api/trend-buzz?query=${encodeURIComponent(q)}`
  ];

  for (const url of candidates) {
    const { status, data } = await http.get(url, {
      headers: apiHeaders(cookieLine, csrf, xsrfHeader),
      validateStatus: () => true
    });

    if (status >= 200 && status < 300) {
      return data; // success
    }
    if (status === 403) {
      // if 403, try the next endpoint; if all fail with 403, bubble up
      if (url === candidates[candidates.length - 1]) {
        throw new Error(`403 from ${url} — check plan/permissions or cookie`);
      }
      continue;
    }
    // For other statuses, bail out
    throw new Error(`${status} from ${url}: ${JSON.stringify(data)}`);
  }

  throw new Error('No trending endpoint returned 2xx');
}

/* ----------------- ROUTES ----------------- */

// Debug endpoint (what you pasted)
app.get('/erank/debug', async (req, res) => {
  try {
    const r = await axios.get(TREND_URL, { headers: hdrForPage(BASE), validateStatus: () => true });
    const html = typeof r.data === 'string' ? r.data : (r.data?.html || '');
    const $ = cheerio.load(html);
    const csrf = $('meta[name="csrf-token"]').attr('content') || null;
    const baseXsrf = (parseCookieLine(BASE)['XSRF-TOKEN'] || null);
    const setMap   = parseSetCookie(r.headers['set-cookie'] || []);
    const setXsrf  = (setMap['XSRF-TOKEN'] || null);
    res.json({ url: TREND_URL, ok: !!csrf && !/login|sign in|page not found/i.test(html), csrf_meta_prefix: csrf ? (csrf.slice(0,12)+'…') : null, xsrf_cookie_from_env: baseXsrf, xsrf_cookie_from_set_cookie: setXsrf });
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message || String(e) });
  }
});

// /erank/keywords — flatten into {results:[]}
app.get('/erank/keywords', async (req, res) => {
  try {
    const q = String(req.query.q || '');
    const data = await callTrendingAPI(q);

    // Normalize possible shapes
    const buckets = [data?.results, data?.items, data?.trends, data?.data];
    const acc = [];
    for (const arr of buckets) {
      if (Array.isArray(arr)) {
        for (const x of arr) {
          const t = typeof x === 'string' ? x : (x?.title || x?.name || x?.keyword || '');
          if (t) acc.push(String(t).trim());
        }
      }
    }
    const unique = Array.from(new Set(acc)).filter(Boolean).filter(s => q ? s.toLowerCase().includes(q.toLowerCase()) : true);
    return res.json({ source: 'members.erank.com', query: q, count: unique.length, results: unique.slice(0, 20) });
  } catch (e) {
    console.error('keywords error:', e.message);
    return res.status(403).json({ error: { success:false, message:'Unauthorized access', code:403 } });
  }
});

// /erank/research — map to {items:[{title,link}]}
app.get('/erank/research', async (req, res) => {
  try {
    const q = String(req.query.q || '');
    const data = await callTrendingAPI(q);

    const titles = Array.isArray(data?.titles) ? data.titles : [];
    const links  = Array.isArray(data?.links)  ? data.links  : [];
    const max    = Math.max(titles.length, links.length);
    const items  = Array.from({ length: max }).map((_, i) => ({
      title: (titles[i] || '').trim(),
      link:  (links[i]  || '').trim()
    })).filter(x => x.title);

    const filtered = items.filter(x => q ? x.title.toLowerCase().includes(q.toLowerCase()) : true);
    return res.json({ source: 'members.erank.com', query: q, count: filtered.length, items: filtered.slice(0, 20) });
  } catch (e) {
    console.error('research error:', e.message);
    return res.status(403).json({ error: { success:false, message:'Unauthorized access', code:403 } });
  }
});

// Etsy: /erank/products — public, no auth
app.get('/erank/products', async (req, res) => {
  try {
    const q = String(req.query.q || '');
    const html = await fetchHtmlViaZenrows(`https://www.etsy.com/search?q=${encodeURIComponent(q)}`, 'li[data-search-result], .v2-listing-card');
    const $ = cheerio.load(html);
    const items = [];
    $('li[data-search-result], .v2-listing-card').each((_, el) => {
      const $el = $(el);
      const title = ($el.find('h3, [data-test="listing-title"], [data-test="listing-card-title"]').first().text() || '').trim();
      const url   = ($el.find('a').attr('href') || '').trim();
      const price = ($el.find('.currency-value, [data-buy-box-listing-price]').first().text() || '').trim();
      const shop  = ($el.find('.v2-listing-card__shop, .text-body-secondary').first().text() || '').trim();
      if (title || url) items.push({ title, url, price, shop });
    });
    res.json({ query: q, count: items.length, items: items.slice(0, 20) });
  } catch (e) {
    console.error('products error:', e.message);
    res.status(502).json({ error: e.response?.data || e.message || String(e) });
  }
});

// Etsy: /erank/mylistings — public shop page
app.get('/erank/mylistings', async (req, res) => {
  try {
    const shop = String(req.query.shop || '');
    if (!shop) return res.status(400).json({ error: "Missing 'shop' param" });

    const html = await fetchHtmlViaZenrows(`https://www.etsy.com/shop/${encodeURIComponent(shop)}`, '.wt-grid__item-xs-6, .v2-listing-card');
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
    console.error('mylistings error:', e.message);
    res.status(500).json({ error: e.response?.data || e.message || String(e) });
  }
});

app.listen(port, '0.0.0.0', () => {
  const routes = [];
  app._router.stack.forEach(mw => { if (mw.route) routes.push(Object.keys(mw.route.methods).join(',').toUpperCase() + ' ' + mw.route.path); });
  console.log('ROUTES:', routes);
  console.log('listening on', port);
});
