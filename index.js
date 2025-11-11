// index.js — eRank PRO scraper FINAL
// Express + Playwright + Cheerio + Stealth + DOM UI Actions + Inertia/Tabla fallback

// ---------- Núcleo ----------
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

const ERANK_COOKIES  = (process.env.ERANK_COOKIES  || '').trim();
const ERANK_EMAIL    = (process.env.ERANK_EMAIL    || '').trim();
const ERANK_PASSWORD = (process.env.ERANK_PASSWORD || '').trim();

// Stealth (ajustable por ENV)
const STEALTH_ON     = (process.env.STEALTH_ON || '1') !== '0';
const STEALTH_MIN_MS = parseInt(process.env.STEALTH_MIN_MS || '700', 10);
const STEALTH_MAX_MS = parseInt(process.env.STEALTH_MAX_MS || '1600', 10);
const MAX_RETRIES    = parseInt(process.env.MAX_RETRIES    || '3', 10);
const RECYCLE_AFTER  = parseInt(process.env.RECYCLE_AFTER  || '6', 10);

// Rotación ligera para fingerprint
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

// ---------- Utils ----------
const rand   = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const sleep  = (ms) => new Promise(r => setTimeout(r, ms));
const pick   = (arr) => arr[rand(0, arr.length - 1)];
const jitter = async () => { if (STEALTH_ON) await sleep(rand(STEALTH_MIN_MS, STEALTH_MAX_MS)); };

function cookiesFromString(cookieStr) {
  return cookieStr.split(';')
    .map(s => s.trim())
    .filter(Boolean)
    .map(pair => {
      const i = pair.indexOf('=');
      if (i <= 0) return null;
      return { name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim(), path: '/', secure: true, httpOnly: false };
    })
    .filter(Boolean);
}

async function recycleContext(reason = 'stale') {
  try { if (context) await context.close().catch(()=>{}); } catch {}
  try { if (browser)  await browser.close().catch(()=>{}); } catch {}
  browser = null; context = null; consecutiveErrors = 0;
  console.warn('[recycle] Recycling browser/context due to:', reason);
}

async function ensureBrowser() {
  if (browser && context) return;

  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });

  const ua   = pick(USER_AGENTS);
  const lang = pick(ACCEPT_LANGS);

  const contextOptions = {
    baseURL: BASE,
    userAgent: ua,
    locale: lang.startsWith('es') ? 'es-ES' : 'en-US',
    extraHTTPHeaders: { 'accept-language': lang, 'upgrade-insecure-requests': '1' }
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
  try { if (context) await context.storageState({ path: STORAGE }); }
  catch (e) { console.warn('storageState save failed:', e.message); }
}

async function openAndEnsure(page, url, referer) {
  if (referer) try { await page.setExtraHTTPHeaders({ referer }); } catch {}
  await jitter();
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(()=>{});
  await jitter();
  return resp;
}

async function isLoggedIn(page) {
  try {
    const r = await openAndEnsure(page, `${BASE}/dashboard`, pick(REFERERS));
    return page.url().includes('/dashboard') && r?.ok();
  } catch { return false; }
}

async function loginIfNeeded(page) {
  if (await isLoggedIn(page)) return true;

  if (ERANK_COOKIES) { // primer empujón
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{});
    await jitter();
    if (await isLoggedIn(page)) { await saveStorage(); return true; }
  }

  if (!ERANK_EMAIL || !ERANK_PASSWORD) {
    throw new Error('No valid session and ERANK_EMAIL/ERANK_PASSWORD not configured.');
  }

  await openAndEnsure(page, `${BASE}/login`, `${BASE}/dashboard`);

  // 1) Intento API (con CSRF si hay)
  try {
    await page.evaluate(async (email, pass) => {
      const token = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';
      const hdrs  = { 'Content-Type': 'application/json' };
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
      lastErr = e; consecutiveErrors++;
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

// ---------- Parsers helpers ----------
function htmlStats(html){ return { htmlLength: html?.length || 0, totalKeywords: (html?.match(/keyword/gi) || []).length }; }
function extractSimpleTable($){
  const rows=[]; $('table tr').each((_,tr)=>{ const cells=[]; $(tr).find('th,td').each((__,td)=>cells.push($(td).text().trim().replace(/\s+/g,' '))); if(cells.length) rows.push(cells);}); return rows;
}
function extractChips($){ return $('[class*="chip"], [class*="tag"], .badge, .label').map((_,el)=>$(el).text().trim()).get().filter(Boolean); }
function getInertiaPageJSON($){ const node=$('[data-page]').first(); if(!node.length) return null; const raw=node.attr('data-page'); if(!raw) return null; try{ return JSON.parse(raw);}catch{return null;} }
function deepFindArrays(obj,predicate,acc=[]){ if(!obj||typeof obj!=='object') return acc; if(Array.isArray(obj)&&obj.some(predicate)) acc.push(obj); for(const k of Object.keys(obj)) deepFindArrays(obj[k],predicate,acc); return acc; }
function tableByHeaders($, headerMatchers = []) {
  const tables=[];
  $('table').each((_,t)=>{ const $t=$(t); const header=[]; $t.find('thead tr th, tr th').each((__,th)=>header.push($(th).text().trim().replace(/\s+/g,' ').toLowerCase())); if(!header.length) return;
    const ok = headerMatchers.every(rx => header.some(h => rx.test(h))); if(!ok) return;
    const rows=[]; $t.find('tbody tr, tr').each((i,tr)=>{ const tds=$(tr).find('td'); if(!tds.length) return; rows.push(tds.map((__,td)=>$(td).text().trim().replace(/\s+/g,' ')).get()); });
    if(rows.length) tables.push({header,rows});
  });
  return tables[0] || null;
}

// ---------- Parsers (Cheerio fallback) ----------
function parseKeywords(html){
  const $=cheerio.load(html);
  const tbl=tableByHeaders($,[/^keyword$/, /volume|avg.*search|searches/]);
  if(tbl){
    const kIdx=tbl.header.findIndex(h=>/keyword/.test(h));
    const vIdx=tbl.header.findIndex(h=>/(volume|avg.*search|searches)/.test(h));
    const results=tbl.rows.map(r=>({keyword:(r[kIdx]||'').trim(), volume:(r[vIdx]||'').trim()})).filter(x=>x.keyword);
    return {count:results.length, results, chips:extractChips($), ...htmlStats(html)};
  }
  const page=getInertiaPageJSON($);
  if(page){
    const arrays=deepFindArrays(page,o=>o&&typeof o==='object'&&('keyword'in o||'term'in o));
    for(const arr of arrays){
      const results=arr.map(o=>({keyword:(o.keyword||o.term||'').toString(), volume:(o.volume||o.searches||o.avg_searches||'').toString()})).filter(x=>x.keyword);
      if(results.length) return {count:results.length, results, chips:extractChips($), ...htmlStats(html)};
    }
  }
  const results=[]; $('[data-keyword], .keyword, a[href*="/keyword/"]').each((_,el)=>{const kw=$(el).text().trim(); if(kw) results.push({keyword:kw});});
  return {count:results.length, results, chips:extractChips($), ...htmlStats(html)};
}
function parseTopListings(html){
  const $=cheerio.load(html); const items=[];
  $('a[href*="/listing/"]').each((_,a)=>{ const href=$(a).attr('href')||''; const title=$(a).attr('title')||$(a).text().trim().replace(/\s+/g,' '); if(href||title) items.push({title,href}); });
  $('[data-listing-id]').each((_,el)=>{ const id=$(el).attr('data-listing-id'); const title=$(el).text().trim().replace(/\s+/g,' '); if(id||title) items.push({listing_id:id, title}); });
  if(items.length) return {count:items.length, results:items, ...htmlStats(html)};
  const page=getInertiaPageJSON($);
  if(page){
    const arrays=deepFindArrays(page,o=>o&&typeof o==='object'&&('listing_id'in o||'title'in o));
    for(const arr of arrays){
      const results=arr.map(o=>({listing_id:o.listing_id, title:(o.title||o.name||'').toString(), href:o.url||''})).filter(x=>x.title||x.href||x.listing_id);
      if(results.length) return {count:results.length, results, ...htmlStats(html)};
    }
  }
  return {count:0, results:[], ...htmlStats(html)};
}
function parseMyShop(html){
  const $=cheerio.load(html); const stats={};
  $('[class*="stat"], [class*="metric"]').each((_,el)=>{ const t=$(el).text().trim().replace(/\s+/g,' '); if(t){ const parts=t.split(':'); if(parts.length>=2) stats[parts[0].trim()]=parts.slice(1).join(':').trim(); }});
  return {stats, ...htmlStats(html)};
}
function parseGenericList(html){
  const $=cheerio.load(html); const items=[];
  $('table').each((_,t)=>{ $(t).find('tr').each((i,tr)=>{ if(i===0&&$(tr).find('th').length) return; const tds=$(tr).find('td'); if(!tds.length) return;
    const obj={}; tds.each((idx,td)=>{ obj[`col${idx+1}`]=$(td).text().trim().replace(/\s+/g,' '); });
    if(Object.values(obj).some(v=>v)) items.push(obj);
  });});
  if(!items.length){ $('[class*="card"], [class*="result"]').each((_,el)=>{ const text=cheerio.load(el).text().trim().replace(/\s+/g,' '); if(text) items.push({text}); }); }
  return {count:items.length, results:items, ...htmlStats(html)};
}

// ---------- Scraping/acciones en DOM ----------
async function scrapeKeywordsInPage(page){
  return await page.evaluate(()=>{
    const out=[];
    const tables=[...document.querySelectorAll('table')];
    for(const t of tables){
      const headers=[...t.querySelectorAll('thead th, tr th')].map(th=>th.textContent.trim().toLowerCase());
      if(!headers.length || !headers.some(h=>h.includes('keyword'))) continue;
      const kIdx=headers.findIndex(h=>h.includes('keyword'));
      const vIdx=headers.findIndex(h=>h.includes('search')||h.includes('volume'));
      const rows=[...t.querySelectorAll('tbody tr, tr')];
      for(const r of rows){
        const cells=[...r.querySelectorAll('td')].map(td=>td.textContent.trim());
        if(!cells.length) continue;
        const kw=cells[kIdx]||''; const vol=vIdx>=0?(cells[vIdx]||''):'';
        if(kw) out.push({keyword:kw, volume:vol});
      }
    }
    if(!out.length){
      document.querySelectorAll('[data-keyword], .keyword, a[href*="/keyword/"]').forEach(el=>{
        const kw=el.textContent.trim(); if(kw) out.push({keyword:kw});
      });
    }
    return out;
  });
}
async function scrapeTopListingsInPage(page){
  return await page.evaluate(()=>{
    const items=[];
    document.querySelectorAll('a[href*="/listing/"]').forEach(a=>{
      const href=a.getAttribute('href')||'';
      const title=a.getAttribute('title')||a.textContent.trim();
      if(href||title) items.push({title, href});
    });
    document.querySelectorAll('[data-listing-id]').forEach(el=>{
      const id=el.getAttribute('data-listing-id');
      const title=el.textContent.trim();
      if(id||title) items.push({listing_id:id, title});
    });
    return items;
  });
}
async function scrapeTagsInPage(page){
  return await page.evaluate(()=>{
    const tables=[...document.querySelectorAll('table')];
    for(const t of tables){
      const headers=[...t.querySelectorAll('thead th, tr th')].map(th=>th.textContent.trim().toLowerCase());
      if(!headers.length) continue;
      const hasTag=headers.some(h=>h==='tag');
      const hasSearch=headers.some(h=>h.includes('search'));
      if(!hasTag||!hasSearch) continue;
      const idx={
        tag: headers.findIndex(h=>h==='tag'),
        avgS:headers.findIndex(h=>h.includes('search')),
        avgC:headers.findIndex(h=>h.includes('click')),
        ctr: headers.findIndex(h=>h.includes('ctr')),
        comp:headers.findIndex(h=>h.includes('competition')||h.includes('etsy')),
        trend:headers.findIndex(h=>h.includes('trend'))
      };
      const rows=[];
      [...t.querySelectorAll('tbody tr, tr')].forEach(tr=>{
        const tds=[...tr.querySelectorAll('td')].map(td=>td.textContent.trim());
        if(!tds.length) return;
        const row={
          tag: tds[idx.tag]||'',
          avg_searches: idx.avgS>=0?(tds[idx.avgS]||''):'',
          avg_clicks:   idx.avgC>=0?(tds[idx.avgC]||''):'',
          avg_ctr:      idx.ctr >=0?(tds[idx.ctr ]||''):'',
          etsy_competition: idx.comp>=0?(tds[idx.comp]||''):'',
          search_trend: idx.trend>=0?(tds[idx.trend]||''):''
        };
        if(row.tag) rows.push(row);
      });
      if(rows.length) return rows;
    }
    return [];
  });
}

// ---------- Acciones de UI ----------
async function ensureMarketplaceCountry(page, marketplace, country) {
  const mpBtn = page.getByRole('button', { name: /marketplace/i })
                    .or(page.getByRole('combobox').nth(0));
  if (await mpBtn.isVisible().catch(() => false)) {
    await mpBtn.click().catch(()=>{});
    await page.getByRole('option', { name: new RegExp(`^${marketplace}$`, 'i') })
              .click().catch(()=>{});
  }
  const cBtn = page.getByRole('button', { name: /country/i })
                   .or(page.getByRole('combobox').nth(1));
  if (await cBtn.isVisible().catch(() => false)) {
    await cBtn.click().catch(()=>{});
    await page.getByRole('option', { name: new RegExp(`^${country}$`, 'i') })
              .click().catch(()=>{});
  }
}

// ⭐ NUEVA: dispara la búsqueda real en eRank (React input + lupa)
async function typeAndSearch(page, q) {
  try {
    const inputSelector = 'input.react-autosuggest__input, .react-autosuggest__container input, input[type="text"]';
    await page.waitForSelector(inputSelector, { timeout: 15000 });
    const input = await page.$(inputSelector);

    // limpiar y escribir
    await input.click({ clickCount: 3 });
    await input.press('Backspace');
    await input.type(q, { delay: 40 });

    // eventos para frameworks reactivos
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, inputSelector);

    // intentar click en la lupa
    const searchBtnSelector = 'button svg[data-icon="search"], button svg.svg-inline--fa';
    const icon = await page.$(searchBtnSelector);
    if (icon) {
      const buttonParent = await icon.evaluateHandle(el => el.closest('button'));
      await buttonParent.click();
    } else {
      // fallback Enter
      await input.press('Enter');
    }

    // esperar cualquier señal de resultados
    await page.waitForSelector('table tbody tr td, [data-listing-id], [data-keyword]', { timeout: 20000 }).catch(()=>{});
  } catch (e) {
    console.error('typeAndSearch failed:', e.message);
  }
}

async function autoScroll(page, steps = 6) {
  for (let i = 0; i < steps; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await new Promise(r => setTimeout(r, 500));
  }
}

// ---------- Middlewares ----------
app.use((req, _res, next) => { if (req.url.includes('//')) req.url = req.url.replace(/\/{2,}/g, '/'); next(); });
app.use(async (_req, _res, next) => { await jitter(); next(); });

// ---------- Health / Debug ----------
app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'erank-scraper', stealth: STEALTH_ON }));
app.get('/erank/healthz', (_req, res) => res.json({ ok: true, alias: 'erank/healthz', stealth: STEALTH_ON }));
app.get('/debug/cookies', async (_req, res) => {
  try { await ensureBrowser(); const ck = await context.cookies('https://members.erank.com');
    res.json({ count: ck.length, cookies: ck.map(c => ({ name: c.name, domain: c.domain })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/erank/raw', async (req, res) => {
  const p = (req.query.path || '/dashboard').toString();
  try {
    await ensureBrowser();
    const page = await context.newPage();
    await loginIfNeeded(page);
    await openAndEnsure(page, `${BASE}${p.startsWith('/') ? '' : '/'}${p}`, pick(REFERERS));
    const html = await page.content();
    await page.close();
    res.set('content-type', 'text/html; charset=utf-8').send(html);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Endpoints ----------
app.get('/erank/keywords', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const country = (req.query.country || DEFAULT_COUNTRY).toUpperCase();
  const marketplace = (req.query.marketplace || DEFAULT_MARKET).toLowerCase();
  if (!q) return res.status(400).json({ error: 'Missing ?q=' });

  try {
    const out = await withRetries(async () => {
      await ensureBrowser(); const page = await context.newPage(); await loginIfNeeded(page);
      await openAndEnsure(page, `${BASE}/keyword-tool`, `${BASE}/dashboard`);
      await ensureMarketplaceCountry(page, marketplace, country);
      await typeAndSearch(page, q);
      // DOM vivo primero
      let results = await scrapeKeywordsInPage(page);
      if (!results.length) { const html = await page.content(); results = parseKeywords(html).results; }
      await page.close();
      return { query: q, country, marketplace, count: results.length, results };
    }, 'keywords-ui');
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/erank/near-matches', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const country = (req.query.country || DEFAULT_COUNTRY).toUpperCase();
  const marketplace = (req.query.marketplace || DEFAULT_MARKET).toLowerCase();
  if (!q) return res.status(400).json({ error: 'Missing ?q=' });

  try {
    const out = await withRetries(async () => {
      await ensureBrowser(); const page = await context.newPage(); await loginIfNeeded(page);
      const url = `${BASE}/keyword-tool?q=${encodeURIComponent(q)}&tab=near-matches&country=${country}&marketplace=${marketplace}`;
      await openAndEnsure(page, url, `${BASE}/keyword-tool`);
      const html = await page.content(); await page.close();
      return { query: q, country, marketplace, ...parseGenericList(html) };
    }, 'near-matches');
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/erank/top-listings', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const country = (req.query.country || DEFAULT_COUNTRY).toUpperCase();
  const marketplace = (req.query.marketplace || DEFAULT_MARKET).toLowerCase();
  if (!q) return res.status(400).json({ error: 'Missing ?q=' });

  try {
    const out = await withRetries(async () => {
      await ensureBrowser(); const page = await context.newPage(); await loginIfNeeded(page);
      await openAndEnsure(page, `${BASE}/keyword-tool`, `${BASE}/dashboard`);
      await ensureMarketplaceCountry(page, marketplace, country);
      await typeAndSearch(page, q);

      const tab = page.getByRole('tab', { name: /top listings/i });
      if (await tab.isVisible().catch(()=>false)) {
        await tab.click().catch(()=>{}); await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(()=>{});
      } else {
        await page.locator('text=Top Listings').first().click().catch(()=>{});
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(()=>{});
      }

      let results = await scrapeTopListingsInPage(page);
      if (!results.length) { const html = await page.content(); results = parseTopListings(html).results; }

      await page.close();
      return { query: q, country, marketplace, count: results.length, results };
    }, 'top-listings-ui');
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/erank/stats', async (_req, res) => {
  try {
    const out = await withRetries(async () => {
      await ensureBrowser(); const page = await context.newPage(); await loginIfNeeded(page);
      await openAndEnsure(page, `${BASE}/dashboard`, pick(REFERERS));
      const html = await page.content(); await page.close();
      return { ok: true, ...htmlStats(html) };
    }, 'stats');
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/erank/my-shop', async (_req, res) => {
  try {
    const out = await withRetries(async () => {
      await ensureBrowser(); const page = await context.newPage(); await loginIfNeeded(page);
      await openAndEnsure(page, `${BASE}/dashboard`, pick(REFERERS));
      const html = await page.content(); await page.close();
      return parseMyShop(html);
    }, 'my-shop');
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/erank/products', async (_req, res) => {
  try {
    const out = await withRetries(async () => {
      await ensureBrowser(); const page = await context.newPage(); await loginIfNeeded(page);
      await openAndEnsure(page, `${BASE}/listings/active`, `${BASE}/dashboard`);
      const html = await page.content(); await page.close();
      return parseGenericList(html);
    }, 'products');
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/erank/competitors', async (_req, res) => {
  try {
    const out = await withRetries(async () => {
      await ensureBrowser(); const page = await context.newPage(); await loginIfNeeded(page);
      await openAndEnsure(page, `${BASE}/competitor-research`, `${BASE}/dashboard`);
      const html = await page.content(); await page.close();
      return parseGenericList(html);
    }, 'competitors');
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Tags con acciones de UI (scroll) + fallback
app.get('/erank/tags', async (req, res) => {
  const country = (req.query.country || DEFAULT_COUNTRY).toUpperCase();
  try {
    await ensureBrowser(); const page = await context.newPage(); await loginIfNeeded(page);
    await openAndEnsure(page, `${BASE}/tags?country=${country}`, `${BASE}/dashboard`);

    await autoScroll(page, 8); // fuerza hidratación

    let rows = await scrapeTagsInPage(page);
    if (!rows.length) {
      const html = await page.content();
      const $ = cheerio.load(html);
      const tbl = tableByHeaders($, [/^tag$/, /avg.*search|searches/, /clicks|ctr|click/]);
      if (tbl) {
        const idx = {
          tag:  tbl.header.findIndex(h => /^tag$/.test(h)),
          avgS: tbl.header.findIndex(h => /(avg.*search|searches)/.test(h)),
          avgC: tbl.header.findIndex(h => /(avg.*click|clicks)/.test(h)),
          ctr:  tbl.header.findIndex(h => /ctr/.test(h)),
          comp: tbl.header.findIndex(h => /(competition|etsy)/.test(h)),
          trend:tbl.header.findIndex(h => /(trend)/.test(h)),
        };
        rows = tbl.rows.map(r => ({
          tag: r[idx.tag] || '',
          avg_searches:     idx.avgS>=0 ? (r[idx.avgS] || '') : '',
          avg_clicks:       idx.avgC>=0 ? (r[idx.avgC] || '') : '',
          avg_ctr:          idx.ctr >=0 ? (r[idx.ctr ] || '') : '',
          etsy_competition: idx.comp>=0 ? (r[idx.comp] || '') : '',
          search_trend:     idx.trend>= 0? (r[idx.trend]|| '') : ''
        })).filter(x => x.tag);
      }
    }

    await page.close();
    res.json({ country, count: rows.length, results: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/erank/trend-buzz', async (req, res) => {
  const country = (req.query.country || 'USA').toUpperCase();
  const marketplace = (req.query.marketplace || 'Etsy');
  const tab = (req.query.tab || 'keywords').toLowerCase(); // keywords|products|colors|recipients|styles|materials
  try {
    const out = await withRetries(async () => {
      await ensureBrowser(); const page = await context.newPage(); await loginIfNeeded(page);
      await openAndEnsure(page, `${BASE}/trend-buzz`, `${BASE}/dashboard`);
      await page.getByRole('button', { name: /marketplace/i }).click().catch(()=>{});
      await page.getByRole('option', { name: new RegExp(`^${marketplace}$`, 'i') }).click().catch(()=>{});
      await jitter();
      await page.getByRole('button', { name: /country/i }).click().catch(()=>{});
      await page.getByRole('option', { name: new RegExp(`^${country}$`, 'i') }).click().catch(()=>{});
      await jitter();
      const tabBtn = page.getByRole('tab', { name: new RegExp(`^${tab}$`, 'i') });
      if (await tabBtn.isVisible().catch(()=>false)) {
        await tabBtn.click().catch(()=>{}); await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(()=>{}); await jitter();
      }
      const html = await page.content(); await page.close();
      return { marketplace, country, tab, ...parseGenericList(html) };
    }, 'trend-buzz');
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Extras
app.get('/erank/shop-info', async (req, res) => {
  const shop = (req.query.shop || '').toString().trim();
  const country = (req.query.country || DEFAULT_COUNTRY).toUpperCase();
  const marketplace = (req.query.marketplace || DEFAULT_MARKET).toLowerCase();
  if (!shop) return res.status(400).json({ error: 'Falta ?shop=' });

  try {
    const out = await withRetries(async () => {
      await ensureBrowser(); const page = await context.newPage(); await loginIfNeeded(page);
      await openAndEnsure(page, `${BASE}/shop-info?country=${country}&marketplace=${marketplace}`, `${BASE}/dashboard`);
      await page.getByPlaceholder(/enter shop name/i).fill(shop).catch(()=>{}); await jitter();
      const btn = page.getByRole('button', { name: /^find$/i });
      if (await btn.isVisible().catch(()=>false)) {
        await Promise.all([ page.waitForLoadState('networkidle', { timeout: 45000 }), btn.click() ]); await jitter();
      }
      const html = await page.content(); await page.close();
      return { shop, country, marketplace, ...parseGenericList(html) };
    }, 'shop-info');
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/erank/listings', async (req, res) => {
  const status = (req.query.status || 'active').toString().toLowerCase();
  const seg = { active: 'active', draft: 'draft', expired: 'expired' }[status] || 'active';
  try {
    const out = await withRetries(async () => {
      await ensureBrowser(); const page = await context.newPage(); await loginIfNeeded(page);
      await openAndEnsure(page, `${BASE}/listings/${seg}`, `${BASE}/dashboard`);
      const html = await page.content(); await page.close();
      return { status: seg, ...parseGenericList(html) };
    }, 'listings');
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Start ----------
app.listen(port, () => {
  console.log(`[eRank] API listening on :${port} (stealth=${STEALTH_ON}, retries=${MAX_RETRIES})`);
});
