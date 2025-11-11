// index.js — eRank PRO scraper FINAL + STEALTH
// Playwright 1.56.1, Express, Cheerio. Pensado para Render (Docker).
// Modo sigiloso: delays aleatorios, UA/locale rotativos, backoff/retry, referers, reciclado de contexto.

const fs = require('fs');
const path = require('path');
const express = require('express');
const cheerio = require('cheerio');
const { chromium } = require('playwright');

const app = express();
const port = process.env.PORT || 3000;

// ---------- Constantes ----------
const BASE = 'https://members.erank.com';
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const STORAGE = path.join(DATA_DIR, 'storageState.json');

const DEFAULT_COUNTRY = (process.env.ERANK_DEFAULT_COUNTRY || 'EU').toUpperCase();
const DEFAULT_MARKET  = (process.env.ERANK_DEFAULT_MARKETPLACE || 'etsy').toLowerCase();

const ERANK_COOKIES = (process.env.ERANK_COOKIES || '').trim();
const ERANK_EMAIL   = (process.env.ERANK_EMAIL   || '').trim();
const ERANK_PASSWORD= (process.env.ERANK_PASSWORD|| '').trim();

// Stealth settings (configurables por ENV)
const STEALTH_ON     = (process.env.STEALTH_ON || '1') !== '0';
const STEALTH_MIN_MS = parseInt(process.env.STEALTH_MIN_MS || '700', 10);  // delay mínimo entre pasos
const STEALTH_MAX_MS = parseInt(process.env.STEALTH_MAX_MS || '1600', 10); // delay máximo entre pasos
const MAX_RETRIES    = parseInt(process.env.MAX_RETRIES    || '3', 10);    // reintentos por endpoint
const RECYCLE_AFTER  = parseInt(process.env.RECYCLE_AFTER  || '6', 10);    // recicla contexto tras N fallos

// UAs y locales rotativos (para mitigar fingerprints)
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.6533.99 Safari/537.36'
];
const ACCEPT_LANGS = [
  'en-US,en;q=0.9,es;q=0.8',
  'en-GB,en;q=0.9,es;q=0.7',
  'es-ES,es;q=0.9,en;q=0.8'
];
const REFERERS = [
  `${BASE}/dashboard`,
  `${BASE}/keyword-tool`,
  `${BASE}/competitor-research`,
  `${BASE}/listings/active`,
  `${BASE}/trend-buzz`
];

let browser = null;
let context = null;
let consecutiveErrors = 0;

// ---------- Utilidades ----------
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = async () => { if (!STEALTH_ON) return; await sleep(rand(STEALTH_MIN_MS, STEALTH_MAX_MS)); };

function pick(arr) { return arr[rand(0, arr.length - 1)]; }

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

async function recycleContext(reason = 'stale') {
  try { if (context) await context.close().catch(()=>{}); } catch {}
  try { if (browser) await browser.close().catch(()=>{}); } catch {}
  browser = null;
  context = null;
  consecutiveErrors = 0;
  console.warn('[recycle] Recycling browser/context due to:', reason);
}

async function ensureBrowser() {
  if (browser && context) return;

  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });

  const ua      = pick(USER_AGENTS);
  const lang    = pick(ACCEPT_LANGS);

  const contextOptions = {
    baseURL: BASE,
    userAgent: ua,
    locale: lang.startsWith('es') ? 'es-ES' : 'en-US',
    extraHTTPHeaders: {
      'accept-language': lang,
      'upgrade-insecure-requests': '1'
    }
  };

  if (fs.existsSync(STORAGE)) contextOptions.storageState = STORAGE;

  context = await browser.newContext(contextOptions);

  // Aplica cookies a ambos dominios
  if (ERANK_COOKIES) {
    const parsed = cookiesFromString(ERANK_COOKIES);
    const both = [];
    for (const c of parsed) {
      both.push({ ...c, domain: 'members.erank.com', sameSite: 'None' });
      both.push({ ...c, domain: '.erank.com',        sameSite: 'None' });
    }
    try { await context.addCookies(both); } catch (e) { console.error('addCookies:', e.message); }
  }
}

async function saveStorage() {
  try { if (context) await context.storageState({ path: STORAGE }); } catch (e) {
    console.warn('storageState save failed:', e.message);
  }
}

async function openAndEnsure(page, url, referer) {
  if (referer) {
    try { await page.setExtraHTTPHeaders({ referer }); } catch {}
  }
  await jitter();
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(()=>{});
  await jitter();
  return resp;
}

async function isLoggedIn(page) {
  try {
    const r = await openAndEnsure(page, `${BASE}/dashboard`, pick(REFERERS));
    const u = page.url();
    return u.includes('/dashboard') && r?.ok();
  } catch { return false; }
}

async function loginIfNeeded(page) {
  if (await isLoggedIn(page)) return true;

  if (ERANK_COOKIES) { // primer empujón por si el panel necesita un “hit” autenticado
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{});
    await jitter();
    if (await isLoggedIn(page)) { await saveStorage(); return true; }
  }

  if (!ERANK_EMAIL || !ERANK_PASSWORD) {
    throw new Error('No valid session and ERANK_EMAIL/ERANK_PASSWORD not configured.');
  }

  await openAndEnsure(page, `${BASE}/login`, `${BASE}/dashboard`);

  // 1) Intento API (respeta CSRF si existe)
  try {
    await page.evaluate(async (email, pass) => {
      const token = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';
      const hdrs = { 'Content-Type': 'application/json' };
      if (token) hdrs['X-CSRF-TOKEN'] = token;
      await fetch('/login', { method: 'POST', headers: hdrs, body: JSON.stringify({ email, password: pass }) });
    }, ERANK_EMAIL, ERANK_PASSWORD);
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(()=>{});
    await jitter();
  } catch {}

  // 2) Fallback UI
  if (!(await isLoggedIn(page))) {
    try {
      await page.getByLabel(/email/i).fill(ERANK_EMAIL);
      await jitter();
      await page.getByLabel(/password/i).fill(ERANK_PASSWORD);
      await jitter();
      await Promise.all([
        page.waitForNavigation({ url: /\/dashboard/, timeout: 45000 }),
        page.getByRole('button', { name: /log.?in|sign.?in/i }).click()
      ]);
    } catch (e) {
      console.error('Login UI fallback:', e.message);
    }
  }

  if (!(await isLoggedIn(page))) {
    throw new Error('Login failed — check ERANK_EMAIL/ERANK_PASSWORD or ERANK_COOKIES.');
  }

  await saveStorage();
  return true;
}

async function withRetries(taskFn, label = 'task') {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const out = await taskFn();
      consecutiveErrors = 0;
      return out;
    } catch (e) {
      lastErr = e;
      consecutiveErrors++;
      const delay = rand(700, 2000) * attempt; // backoff suave
      console.warn(`[retry] ${label} attempt ${attempt}/${MAX_RETRIES} failed: ${e.message}. Waiting ${delay}ms`);
      await sleep(delay);
      if (consecutiveErrors >= RECYCLE_AFTER) {
        await recycleContext(`too many errors (${consecutiveErrors})`);
        await ensureBrowser();
      }
    }
  }
  throw lastErr;
}

// ---------- Parsers ----------
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
      const volume  = row[1] || '';
      if (keyword) results.push({ keyword, volume });
    }
  } else {
    $('*[data-keyword]').each((_, el) => results.push({ keyword: $(el).text().trim() }));
  }
  return { count: results.length, results, chips, ...htmlStats(html) };
}
function parseTopListings(html) {
  const $ = cheerio.load(html);
  const cards = [];
  $('[class*="listing"], [data-listing-id], a[href*="/listing/"]').each((_, el) => {
    const title = $(el).text().trim().replace(/\s+/g, ' ');
    const href  = $(el).attr('href') || '';
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
    $('[class*="card"], [class*="result"]').each((_, el) => {
      items.push({ text: cheerio.load(el).text().trim().replace(/\s+/g, ' ') });
    });
  }
  return { count: items.length, results: items, ...htmlStats(html) };
}

// ---------- Middleware global: normaliza // y añade pequeño delay entre requests ----------
app.use(async (req, _res, next) => {
  if (req.url.includes('//')) req.url = req.url.replace(/\/{2,}/g, '/');
  await jitter();
  next();
});

// ---------- Health ----------
app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'erank-scraper', stealth: STEALTH_ON }));
app.get('/erank/healthz', (_req, res) => res.json({ ok: true, alias: 'erank/healthz', stealth: STEALTH_ON }));

// Debug cookies
app.get('/debug/cookies', async (_req, res) => {
  try {
    await ensureBrowser();
    const ck = await context.cookies('https://members.erank.com');
    res.json({ count: ck.length, cookies: ck.map(c => ({ name: c.name, domain: c.domain })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Endpoints principales (con reintentos) ----------
app.get('/erank/keywords', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const country = (req.query.country || DEFAULT_COUNTRY).toUpperCase();
  const marketplace = (req.query.marketplace || DEFAULT_MARKET).toLowerCase();
  if (!q) return res.status(400).json({ error: 'Missing ?q=' });
  try {
    const out = await withRetries(async () => {
      await ensureBrowser();
      const page = await context.newPage();
      await loginIfNeeded(page);
      const url = `${BASE}/keyword-tool?q=${encodeURIComponent(q)}&country=${country}&marketplace=${marketplace}`;
      await openAndEnsure(page, url, pick(REFERERS));
      const html = await page.content();
      await page.close();
      return { query: q, country, marketplace, ...parseKeywords(html) };
    }, 'keywords');
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/erank/near-matches', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const country = (req.query.country || DEFAULT_COUNTRY).toUpperCase();
  const marketplace = (req.query.marketplace || DEFAULT_MARKET).toLowerCase();
  if (!q) return res.status(400).json({ error: 'Missing ?q=' });
  try {
    const out = await withRetries(async () => {
      await ensureBrowser();
      const page = await context.newPage();
      await loginIfNeeded(page);
      const url = `${BASE}/keyword-tool?q=${encodeURIComponent(q)}&tab=near-matches&country=${country}&marketplace=${marketplace}`;
      await openAndEnsure(page, url, `${BASE}/keyword-tool`);
      const html = await page.content();
      await page.close();
      return { query: q, country, marketplace, ...parseGenericList(html) };
    }, 'near-matches');
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/erank/top-listings', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const country = (req.query.country || DEFAULT_COUNTRY).toUpperCase();
  const marketplace = (req.query.marketplace || DEFAULT_MARKET).toLowerCase();
  if (!q) return res.status(400).json({ error: 'Missing ?q=' });
  try {
    const out = await withRetries(async () => {
      await ensureBrowser();
      const page = await context.newPage();
      await loginIfNeeded(page);
      const url = `${BASE}/keyword-tool?q=${encodeURIComponent(q)}&country=${country}&marketplace=${marketplace}`;
      await openAndEnsure(page, url, `${BASE}/dashboard`);
      // Clic robusto pestaña
      const tab = page.getByRole('tab', { name: /top listings/i });
      if (await tab.isVisible().catch(()=>false)) {
        await tab.click().catch(()=>{});
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(()=>{});
        await jitter();
      } else {
        await page.locator('text=Top Listings').first().click().catch(()=>{});
        await jitter();
      }
      const html = await page.content();
      await page.close();
      return { query: q, country, marketplace, ...parseTopListings(html) };
    }, 'top-listings');
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/erank/stats', async (_req, res) => {
  try {
    const out = await withRetries(async () => {
      await ensureBrowser();
      const page = await context.newPage();
      await loginIfNeeded(page);
      await openAndEnsure(page, `${BASE}/dashboard`, pick(REFERERS));
      const html = await page.content();
      await page.close();
      return { ok: true, ...htmlStats(html) };
    }, 'stats');
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/erank/my-shop', async (_req, res) => {
  try {
    const out = await withRetries(async () => {
      await ensureBrowser();
      const page = await context.newPage();
      await loginIfNeeded(page);
      await openAndEnsure(page, `${BASE}/dashboard`, pick(REFERERS));
      const html = await page.content();
      await page.close();
      return parseMyShop(html);
    }, 'my-shop');
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/erank/products', async (_req, res) => {
  try {
    const out = await withRetries(async () => {
      await ensureBrowser();
      const page = await context.newPage();
      await loginIfNeeded(page);
      await openAndEnsure(page, `${BASE}/listings/active`, `${BASE}/dashboard`);
      const html = await page.content();
      await page.close();
      return parseGenericList(html);
    }, 'products');
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/erank/competitors', async (_req, res) => {
  try {
    const out = await withRetries(async () => {
      await ensureBrowser();
      const page = await context.newPage();
      await loginIfNeeded(page);
      await openAndEnsure(page, `${BASE}/competitor-research`, `${BASE}/dashboard`);
      const html = await page.content();
      await page.close();
      return parseGenericList(html);
    }, 'competitors');
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/erank/raw', async (req, res) => {
  const p = (req.query.path || '/dashboard').toString();
  try {
    const html = await withRetries(async () => {
      await ensureBrowser();
      const page = await context.newPage();
      await loginIfNeeded(page);
      await openAndEnsure(page, `${BASE}${p.startsWith('/') ? '' : '/'}${p}`, pick(REFERERS));
      const html = await page.content();
      await page.close();
      return html;
    }, 'raw');
    res.set('content-type', 'text/html; charset=utf-8').send(html);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Extras que pediste (tienda/estado/tags/trends) ---
app.get('/erank/shop-info', async (req, res) => {
  const shop = (req.query.shop || '').toString().trim();
  const country = (req.query.country || DEFAULT_COUNTRY).toUpperCase();
  const marketplace = (req.query.marketplace || DEFAULT_MARKET).toLowerCase();
  if (!shop) return res.status(400).json({ error: 'Falta ?shop=' });
  try {
    const out = await withRetries(async () => {
      await ensureBrowser();
      const page = await context.newPage();
      await loginIfNeeded(page);
      await openAndEnsure(page, `${BASE}/shop-info?country=${country}&marketplace=${marketplace}`, `${BASE}/dashboard`);
      await page.getByPlaceholder(/enter shop name/i).fill(shop).catch(()=>{});
      await jitter();
      const btn = page.getByRole('button', { name: /^find$/i });
      if (await btn.isVisible().catch(()=>false)) {
        await Promise.all([
          page.waitForLoadState('networkidle', { timeout: 45000 }),
          btn.click()
        ]);
        await jitter();
      }
      const html = await page.content();
      await page.close();
      return { shop, country, marketplace, ...parseGenericList(html) };
    }, 'shop-info');
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/erank/listings', async (req, res) => {
  const status = (req.query.status || 'active').toString().toLowerCase();
  const seg = { active: 'active', draft: 'draft', expired: 'expired' }[status] || 'active';
  try {
    const out = await withRetries(async () => {
      await ensureBrowser();
      const page = await context.newPage();
      await loginIfNeeded(page);
      await openAndEnsure(page, `${BASE}/listings/${seg}`, `${BASE}/dashboard`);
      const html = await page.content();
      await page.close();
      return { status: seg, ...parseGenericList(html) };
    }, 'listings');
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/erank/tags', async (req, res) => {
  const country = (req.query.country || DEFAULT_COUNTRY).toUpperCase();
  try {
    const out = await withRetries(async () => {
      await ensureBrowser();
      const page = await context.newPage();
      await loginIfNeeded(page);
      await openAndEnsure(page, `${BASE}/tags?country=${country}`, `${BASE}/dashboard`);
      const html = await page.content();
      const $ = cheerio.load(html);
      const rows = [];
      $('table tr').each((i, tr) => {
        if (i === 0) return;
        const td = $(tr).find('td');
        if (!td.length) return;
        rows.push({
          tag: $(td[0]).text().trim(),
          avg_searches:     $(td[2])?.text()?.trim() || '',
          avg_clicks:       $(td[3])?.text()?.trim() || '',
          avg_ctr:          $(td[4])?.text()?.trim() || '',
          etsy_competition: $(td[5])?.text()?.trim() || '',
          search_trend:     $(td[6])?.text()?.trim() || ''
        });
      });
      await page.close();
      return { country, count: rows.length, results: rows, ...htmlStats(html) };
    }, 'tags');
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/erank/trend-buzz', async (req, res) => {
  const country = (req.query.country || 'USA').toUpperCase();
  const marketplace = (req.query.marketplace || 'Etsy');
  const tab = (req.query.tab || 'keywords').toLowerCase(); // keywords|products|colors|recipients|styles|materials
  try {
    const out = await withRetries(async () => {
      await ensureBrowser();
      const page = await context.newPage();
      await loginIfNeeded(page);
      await openAndEnsure(page, `${BASE}/trend-buzz`, `${BASE}/dashboard`);
      await page.getByRole('button', { name: /marketplace/i }).click().catch(()=>{});
      await page.getByRole('option', { name: new RegExp(`^${marketplace}$`, 'i') }).click().catch(()=>{});
      await jitter();
      await page.getByRole('button', { name: /country/i }).click().catch(()=>{});
      await page.getByRole('option', { name: new RegExp(`^${country}$`, 'i') }).click().catch(()=>{});
      await jitter();
      const tabBtn = page.getByRole('tab', { name: new RegExp(`^${tab}$`, 'i') });
      if (await tabBtn.isVisible().catch(()=>false)) {
        await tabBtn.click().catch(()=>{});
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(()=>{});
        await jitter();
      }
      const html = await page.content();
      await page.close();
      return { marketplace, country, tab, ...parseGenericList(html) };
    }, 'trend-buzz');
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Start ----------
app.listen(port, () => {
  console.log(`[eRank] API listening on :${port} (stealth=${STEALTH_ON}, retries=${MAX_RETRIES})`);
});
