// index.js — eRank PRO scraper FINAL (Playwright v1.56.1 + Cheerio + Express)
// Reemplaza archivo actual por este y reinicia el servicio en Render.

const fs = require('fs');
const path = require('path');
const express = require('express');
const cheerio = require('cheerio');
const { chromium } = require('playwright');

const app = express();
const port = process.env.PORT || 3000;

const BASE = 'https://members.erank.com';
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const STORAGE = path.join(DATA_DIR, 'storageState.json');

const DEFAULT_COUNTRY = (process.env.ERANK_DEFAULT_COUNTRY || 'EU').toUpperCase();
const DEFAULT_MARKET = (process.env.ERANK_DEFAULT_MARKETPLACE || 'etsy').toLowerCase();

const ERANK_COOKIES = (process.env.ERANK_COOKIES || '').trim();
const ERANK_EMAIL = (process.env.ERANK_EMAIL || '').trim();
const ERANK_PASSWORD = (process.env.ERANK_PASSWORD || '').trim();

let browser = null;
let context = null;

// ----------------- Utils -----------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function cookiesFromString(cookieStr) {
  return cookieStr.split(';')
    .map(s => s.trim())
    .filter(Boolean)
    .map(pair => {
      const i = pair.indexOf('=');
      if (i <= 0) return null;
      return {
        name:  pair.slice(0, i).trim(),
        value: pair.slice(i + 1).trim(),
        path: '/',
        secure: true,
        httpOnly: false
      };
    })
    .filter(Boolean);
}

async function ensureBrowser() {
  if (browser && context) return;
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  const contextOptions = {
    baseURL: BASE,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    locale: 'en-US',
    extraHTTPHeaders: {
      'accept-language': 'en-US,en;q=0.9,es;q=0.8',
      'upgrade-insecure-requests': '1'
    }
  };

  if (fs.existsSync(STORAGE)) contextOptions.storageState = STORAGE;

  context = await browser.newContext(contextOptions);

  // Apply ERANK_COOKIES to both members.erank.com and .erank.com (many cookies are set to parent domain)
  if (ERANK_COOKIES) {
    const parsed = cookiesFromString(ERANK_COOKIES);
    const both = [];
    for (const c of parsed) {
      both.push({ ...c, domain: 'members.erank.com', sameSite: 'None' });
      both.push({ ...c, domain: '.erank.com',          sameSite: 'None' });
    }
    try {
      await context.addCookies(both);
    } catch (e) {
      console.error('Error context.addCookies:', e.message);
    }
  }
}

async function saveStorage() {
  try {
    if (context) await context.storageState({ path: STORAGE });
  } catch (e) {
    console.warn('No se pudo guardar storageState:', e.message);
  }
}

async function isLoggedIn(page) {
  try {
    const r = await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const u = page.url();
    return u.includes('/dashboard') && r?.ok();
  } catch (e) {
    return false;
  }
}

async function loginIfNeeded(page) {
  if (await isLoggedIn(page)) return true;

  // If cookies provided in ENV, retry after a quick reload
  if (ERANK_COOKIES) {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{});
    if (await isLoggedIn(page)) {
      await saveStorage();
      return true;
    }
  }

  // Fallback to credential login (if provided)
  if (!ERANK_EMAIL || !ERANK_PASSWORD) {
    throw new Error('No valid session and ERANK_EMAIL/ERANK_PASSWORD not configured.');
  }

  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 45000 });

  // Try API login first (preferred), fallback to UI fill if necessary
  try {
    // Some setups accept direct POST; we attempt fetch in page context to respect CSRF tokens
    await page.evaluate(async (email, pass) => {
      const tokenMeta = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';
      const headers = { 'Content-Type': 'application/json' };
      if (tokenMeta) headers['X-CSRF-TOKEN'] = tokenMeta;
      await fetch('/login', {
        method: 'POST',
        headers,
        body: JSON.stringify({ email, password: pass })
      });
    }, ERANK_EMAIL, ERANK_PASSWORD);
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(()=>{});
  } catch (e) {
    // fallback UI fill
    try {
      await page.getByLabel(/email/i).fill(ERANK_EMAIL);
      await page.getByLabel(/password/i).fill(ERANK_PASSWORD);
      await Promise.all([
        page.waitForNavigation({ url: /\/dashboard/, timeout: 45000 }),
        page.getByRole('button', { name: /log.?in|sign.?in/i }).click()
      ]);
    } catch (err) {
      console.error('Login fallback error:', err.message);
    }
  }

  if (!(await isLoggedIn(page))) {
    throw new Error('Login failed — check ERANK_EMAIL/ERANK_PASSWORD or ERANK_COOKIES.');
  }

  await saveStorage();
  return true;
}

async function openAndEnsure(page, url, referer) {
  if (referer) await page.setExtraHTTPHeaders({ referer }).catch(()=>{});
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(()=>{});
  await sleep(800);
  return resp;
}

// ----------------- Parsers -----------------
function htmlStats(html) {
  return {
    htmlLength: html?.length || 0,
    totalKeywords: (html?.match(/keyword/gi) || []).length
  };
}

function extractSimpleTable($) {
  const rows = [];
  $('table tr').each((_, tr) => {
    const cells = [];
    $(tr).find('th,td').each((__, td) => {
      cells.push($(td).text().trim().replace(/\s+/g, ' '));
    });
    if (cells.length) rows.push(cells);
  });
  return rows;
}

function extractChips($) {
  return $('[class*="chip"], [class*="tag"], .badge, .label')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter(Boolean);
}

function parseKeywords(html) {
  const $ = cheerio.load(html);
  const table = extractSimpleTable($);
  const chips = extractChips($);
  const results = [];
  if (table.length > 1) {
    const body = table[0].length > 1 ? table.slice(1) : table;
    for (const row of body) {
      const keyword = row[0] || '';
      const volume = row[1] || '';
      if (keyword) results.push({ keyword, volume });
    }
  } else {
    // fallback: search for keyword lists in DOM
    $('*[data-keyword]').each((_, el) => {
      results.push({ keyword: $(el).text().trim() });
    });
  }
  return { count: results.length, results, chips, ...htmlStats(html) };
}

function parseTopListings(html) {
  const $ = cheerio.load(html);
  const cards = [];
  $('[class*="listing"], [data-listing-id], a[href*="/listing/"]').each((_, el) => {
    const title = $(el).text().trim().replace(/\s+/g, ' ');
    const href = $(el).attr('href') || '';
    if (title || href) cards.push({ title, href });
  });
  return { count: cards.length, results: cards, ...htmlStats(html) };
}

function parseMyShop(html) {
  const $ = cheerio.load(html);
  const stats = {};
  $('[class*="stat"], [class*="metric"]').each((_, el) => {
    const t = $(el).text().trim().replace(/\s+/g, ' ');
    if (t) {
      const parts = t.split(':');
      if (parts.length >= 2) stats[parts[0].trim()] = parts.slice(1).join(':').trim();
    }
  });
  return { stats, ...htmlStats(html) };
}

function parseGenericList(html) {
  const $ = cheerio.load(html);
  const items = [];
  $('table tr').each((i, tr) => {
    if (i === 0) return;
    const tds = $(tr).find('td');
    if (tds.length) {
      const obj = {};
      tds.each((idx, td) => { obj[`col${idx+1}`] = $(td).text().trim().replace(/\s+/g, ' '); });
      items.push(obj);
    }
  });
  if (!items.length) {
    // fallback: search for card-list items
    $('[class*="card"], [class*="result"]').each((_, el) => {
      items.push({ text: cheerio.load(el).text().trim().replace(/\s+/g, ' ') });
    });
  }
  return { count: items.length, results: items, ...htmlStats(html) };
}

// ----------------- Middlewares & routes -----------------
app.use((req, _res, next) => {
  if (req.url.includes('//')) req.url = req.url.replace(/\/{2,}/g, '/');
  next();
});

app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'erank-scraper' }));
app.get('/erank/healthz', (_req, res) => res.json({ ok: true, alias: 'erank/healthz' }));

// Debug route: show cookies loaded into context
app.get('/debug/cookies', async (_req, res) => {
  try {
    await ensureBrowser();
    const ck = await context.cookies('https://members.erank.com');
    res.json({ count: ck.length, cookies: ck.map(c => ({ name: c.name, domain: c.domain })) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Keywords
app.get('/erank/keywords', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const country = (req.query.country || DEFAULT_COUNTRY).toUpperCase();
  const marketplace = (req.query.marketplace || DEFAULT_MARK).toLowerCase();
  if (!q) return res.status(400).json({ error: 'Missing ?q= query param' });
  try {
    await ensureBrowser();
    const page = await context.newPage();
    await loginIfNeeded(page);
    const url = `${BASE}/keyword-tool?q=${encodeURIComponent(q)}&country=${country}&marketplace=${marketplace}`;
    await openAndEnsure(page, url);
    const html = await page.content();
    const out = parseKeywords(html);
    res.json({ query: q, country, marketplace, ...out });
    await page.close();
  } catch (e) {
    console.error('keywords error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Near matches
app.get('/erank/near-matches', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const country = (req.query.country || DEFAULT_COUNTRY).toUpperCase();
  const marketplace = (req.query.marketplace || DEFAULT_MARK).toLowerCase();
  if (!q) return res.status(400).json({ error: 'Missing ?q= query param' });
  try {
    await ensureBrowser();
    const page = await context.newPage();
    await loginIfNeeded(page);
    const url = `${BASE}/keyword-tool?q=${encodeURIComponent(q)}&tab=near-matches&country=${country}&marketplace=${marketplace}`;
    await openAndEnsure(page, url);
    const html = await page.content();
    const out = parseGenericList(html);
    res.json({ query: q, country, marketplace, ...out });
    await page.close();
  } catch (e) {
    console.error('near-matches error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Top listings
app.get('/erank/top-listings', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const country = (req.query.country || DEFAULT_COUNTRY).toUpperCase();
  const marketplace = (req.query.marketplace || DEFAULT_MARK).toLowerCase();
  if (!q) return res.status(400).json({ error: 'Missing ?q= query param' });
  try {
    await ensureBrowser();
    const page = await context.newPage();
    await loginIfNeeded(page);
    const url = `${BASE}/keyword-tool?q=${encodeURIComponent(q)}&country=${country}&marketplace=${marketplace}`;
    await openAndEnsure(page, url);
    // Try to click Top Listings tab robustly
    const tab = page.getByRole('tab', { name: /top listings/i });
    if (await tab.isVisible().catch(()=>false)) {
      await tab.click().catch(()=>{});
      await page.waitForLoadState('networkidle').catch(()=>{});
      await sleep(800);
    } else {
      await page.locator('text=Top Listings').first().click().catch(()=>{});
      await sleep(800);
    }
    const html = await page.content();
    const out = parseTopListings(html);
    res.json({ query: q, country, marketplace, ...out });
    await page.close();
  } catch (e) {
    console.error('top-listings error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Stats
app.get('/erank/stats', async (_req, res) => {
  try {
    await ensureBrowser();
    const page = await context.newPage();
    await loginIfNeeded(page);
    await openAndEnsure(page, `${BASE}/dashboard`);
    const html = await page.content();
    res.json({ ok: true, ...htmlStats(html) });
    await page.close();
  } catch (e) {
    console.error('stats error:', e);
    res.status(500).json({ error: e.message });
  }
});

// My shop (dashboard)
app.get('/erank/my-shop', async (_req, res) => {
  try {
    await ensureBrowser();
    const page = await context.newPage();
    await loginIfNeeded(page);
    await openAndEnsure(page, `${BASE}/dashboard`);
    const html = await page.content();
    const out = parseMyShop(html);
    res.json(out);
    await page.close();
  } catch (e) {
    console.error('my-shop error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Products (listings active)
app.get('/erank/products', async (_req, res) => {
  try {
    await ensureBrowser();
    const page = await context.newPage();
    await loginIfNeeded(page);
    await openAndEnsure(page, `${BASE}/listings/active`);
    const html = await page.content();
    const out = parseGenericList(html);
    res.json(out);
    await page.close();
  } catch (e) {
    console.error('products error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Competitors
app.get('/erank/competitors', async (_req, res) => {
  try {
    await ensureBrowser();
    const page = await context.newPage();
    await loginIfNeeded(page);
    await openAndEnsure(page, `${BASE}/competitor-research`);
    const html = await page.content();
    const out = parseGenericList(html);
    res.json(out);
    await page.close();
  } catch (e) {
    console.error('competitors error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Raw debug HTML
app.get('/erank/raw', async (req, res) => {
  const p = (req.query.path || '/dashboard').toString();
  try {
    await ensureBrowser();
    const page = await context.newPage();
    await loginIfNeeded(page);
    await openAndEnsure(page, `${BASE}${p.startsWith('/') ? '' : '/'}${p}`);
    const html = await page.content();
    res.set('content-type', 'text/html; charset=utf-8').send(html);
    await page.close();
  } catch (e) {
    console.error('raw error:', e);
    res.status(500).json({ error: e.message });
  }
});

// --- Additional endpoints requested --- //

// Shop Info (search shop metrics)
app.get('/erank/shop-info', async (req, res) => {
  const shop = (req.query.shop || '').toString().trim();
  const country = (req.query.country || DEFAULT_COUNTRY).toUpperCase();
  const marketplace = (req.query.marketplace || DEFAULT_MARK).toLowerCase();
  if (!shop) return res.status(400).json({ error: 'Falta ?shop=' });

  try {
    await ensureBrowser();
    const page = await context.newPage();
    await loginIfNeeded(page);

    await openAndEnsure(page, `${BASE}/shop-info?country=${country}&marketplace=${marketplace}`);
    await page.getByPlaceholder(/enter shop name/i).fill(shop).catch(()=>{});
    const btn = page.getByRole('button', { name: /^find$/i });
    if (await btn.isVisible().catch(()=>false)) {
      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: 45000 }),
        btn.click()
      ]);
      await sleep(600);
    }

    const html = await page.content();
    const out = parseGenericList(html);
    res.json({ shop, country, marketplace, ...out });
    await page.close();
  } catch (e) {
    console.error('shop-info error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Listings (active/draft/expired)
app.get('/erank/listings', async (req, res) => {
  const status = (req.query.status || 'active').toString().toLowerCase();
  const seg = { active: 'active', draft: 'draft', expired: 'expired' }[status] || 'active';
  try {
    await ensureBrowser();
    const page = await context.newPage();
    await loginIfNeeded(page);
    await openAndEnsure(page, `${BASE}/listings/${seg}`);
    const html = await page.content();
    const out = parseGenericList(html);
    res.json({ status: seg, ...out });
    await page.close();
  } catch (e) {
    console.error('listings error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Tag report
app.get('/erank/tags', async (req, res) => {
  const country = (req.query.country || DEFAULT_COUNTRY).toUpperCase();
  try {
    await ensureBrowser();
    const page = await context.newPage();
    await loginIfNeeded(page);
    await openAndEnsure(page, `${BASE}/tags?country=${country}`);
    const html = await page.content();
    const $ = cheerio.load(html);
    const rows = [];
    $('table tr').each((i, tr) => {
      if (i === 0) return;
      const td = $(tr).find('td');
      if (!td.length) return;
      rows.push({
        tag: $(td[0]).text().trim(),
        avg_searches: $(td[2])?.text()?.trim() || '',
        avg_clicks: $(td[3])?.text()?.trim() || '',
        avg_ctr: $(td[4])?.text()?.trim() || '',
        etsy_competition: $(td[5])?.text()?.trim() || '',
        search_trend: $(td[6])?.text()?.trim() || ''
      });
    });
    res.json({ country, count: rows.length, results: rows, ...htmlStats(html) });
    await page.close();
  } catch (e) {
    console.error('tags error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Trend Buzz
app.get('/erank/trend-buzz', async (req, res) => {
  const country = (req.query.country || 'USA').toUpperCase();
  const marketplace = (req.query.marketplace || 'Etsy');
  const tab = (req.query.tab || 'keywords').toLowerCase();

  try {
    await ensureBrowser();
    const page = await context.newPage();
    await loginIfNeeded(page);
    await openAndEnsure(page, `${BASE}/trend-buzz`);
    await page.getByRole('button', { name: /marketplace/i }).click().catch(()=>{});
    await page.getByRole('option', { name: new RegExp(`^${marketplace}$`, 'i') }).click().catch(()=>{});
    await page.getByRole('button', { name: /country/i }).click().catch(()=>{});
    await page.getByRole('option', { name: new RegExp(`^${country}$`, 'i') }).click().catch(()=>{});
    const tabBtn = page.getByRole('tab', { name: new RegExp(`^${tab}$`, 'i') });
    if (await tabBtn.isVisible().catch(()=>false)) {
      await tabBtn.click().catch(()=>{});
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(()=>{});
    }
    const html = await page.content();
    const out = parseGenericList(html);
    res.json({ marketplace, country, tab, ...out });
    await page.close();
  } catch (e) {
    console.error('trend-buzz error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ----------------- Start server -----------------
app.listen(port, () => {
  console.log(`[eRank] API listening on :${port}`);
});
