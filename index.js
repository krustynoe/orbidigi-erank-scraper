// index.js — eRank PRO scraper FINAL
// Express + Playwright + Cheerio + Stealth + XHR capture + TopN ranking + Debug

// ---------- Imports & App ----------
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const cheerio = require('cheerio');
const { chromium } = require('playwright');

const app = new (require('express'))();
const port = process.env.PORT || 3000;

// ---------- Constants ----------
const BASE = 'https://members.erank.com';
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const STORAGE = path.join(DATA_DIR, 'storageState.json');

const DEFAULT_COUNT   = 30;      // default top-N for keywords
const DEFAULT_TAGS_N  = 15;      // default top-N for tags
const DEFAULT_PROD_N  = 20;      // default top-N for products
const DEFAULT_COUNTRY = (process.env.ERANK_LISTING_COUNTRY || process.env.ERANK_DEFAULT_COUNTRY || 'EU').toUpperCase();
const DEFAULT_MARKET  = (process.env.ERANK_DEFAULT_MARKETPLACE || 'etsy').toLowerCase();

const ERANK_COOKIES   = (process.env.ERANK_COOKIES  || '').trim();
const ERANK_EMAIL     = (process.env.ERANK_EMAIL    || '').trim();
const ERANK_PASSWORD  = (process.env.ERANK_PASSWORD || '').trim();

const STEALTH_ON      = (process.env.STEALTH_ON || '1') !== '0';
const STEALTH_MIN_MS  = parseInt(process.env.STEALTH_MIN_MS || '700', 10);
const STEALTH_MAX_MS  = parseInt(process.env.STEALTH_MAX_MS || '1400', 10);
const MAX_RETRIES     = parseInt(process.env.MAX_RETRIES    || '3', 10);
const RECYCLE_AFTER   = parseInt(process.env.RECYCLE_AFTER  || '6', 10);

const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.6533.99 Safari/537.36'
];
const LANG_POOL = ['en-US,en;q=0.9,es;q=0.8','en-GB,en;q=0.9,es;q=0.7','es-ES,es;q=0.9,en;q=0.8'];

let browser = null, context = null;
let consecutiveErrors = 0;

// ---------- Small utils ----------
const rand  = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pick  = (arr) => arr[Math.floor(Math.random() * arr.length)];
const jitter = async () => { if (STEALTH_ON) await sleep(rand(STEALTH_MIN_MS, STEALTH_MAX_MS)); };
const toInt = (x) => {
  if (x == null) return 0;
  if (typeof x === 'number') return Math.max(0, Math.floor(x));
  if (typeof x === 'string') {
    const s = x.replace(/[^\d]/g, '');
    return s ? parseInt(s, 10) : 0;
  }
  return 0;
};
const parseScore = (volume, competition) => {
  const v = Math.max(0, toInt(volume));
  const c = Math.max(0, toInt(competition));
  return v / (c + 1);
};

// ---------- Browser / Context ----------
async function recycleContext(reason='stale') {
  try { if (context) await context.close().catch(()=>{}); } catch {}
  try { if (browser)  await browser.close().catch(()=>{}); } catch {}
  context = null; browser = null; consecutiveErrors = 0;
  console.warn('[recycle]', reason);
}

async function ensureBrowser() {
  if (browser && context) return;
  browser = await chromium.launch({ headless:true, args:['--no-sandbox','--disable-dev-shm-usage'] });
  const ua   = pick(UA_POOL);
  const lang = pick(LANG_POOL);
  const ctxOpts = {
    baseURL: BASE,
    userAgent: ua,
    locale:   lang.startsWith('es') ? 'es-ES' : 'en-US',
    permissions: [],
    bypassCSP: true,
    extraHTTPHeaders: { 'accept-language': lang, 'upgrade-insecure-requests': '1' }
  };
  if (fs.existsSync(STORAGE)) ctx_opts = { ...ctxOpts, storageState: STORAGE };
  context = await browser.createIncognitoBrowserContext ? await browser.createIncognitoBrowserContext() : await browser.newContext(ctxOpts);

  if (ERANK_COOKIES) {
    const cookies = ERANK_COOKIES.split(';').map(s=>s.trim()).filter(Boolean).map(pair=>{
      const i=pair.indexOf('='); if (i<=0) return null;
      return { name:pair.slice(0,i).trim(), value:pair.slice(i+1).trim(), path:'/', secure:true, httpOnly:false };
    }).filter(Boolean);
    const both=[];
    for (const c of cookies){ both.push({...c,domain:'members.erank.com',sameSite:'None'}); both.push({...c,domain:'.erank.com',sameSite:'None'}); }
    try{ await context.addCookies(both); } catch(e){ console.error('addCookies:', e.message); }
  }
}

async function saveStorage(){ try{ if (context) await context.storageState({ path:STORAGE }); }catch{} }

async function openAndEnsure(page, url, referer){
  if (referer) try{ await page.setDefaultTimeout(30000); await page.setExtraHTTPHeaders({ referer }); }catch{}
  await jitter();
  const resp = await page.goto(url, { waitUntil:'domcontentloaded', timeout:60000 });
  await page.waitForLoadState('networkidle', { timeout:60000 }).catch(()=>{});
  await jitter();
  return resp;
}
async function isLoggedIn(page){
  try { const r=await openAndEnsure(page, `${BASE}/dashboard`, `${BASE}/`); return page.url().includes('/dashboard') && r?.ok(); }
  catch { return false; }
}
async function loginIfNeeded(page){
  if (await isLoggedIn(page)) return true;
  if (ERANK_COOKIES) {
    await page.reload({waitUntil:'domcontentloaded'}).catch(()=>{});
    await jitter();
    if (await isLoggedIn(page)) { await saveStorage(); return true; }
  }
  if (!ERANK_EMAIL || !ERANK_PASSWORD) throw new Error('No valid session and ERANK_EMAIL/ERANK_PASSWORD not configured.');

  await openAndEnsure(page, `${BASE}/login`, `${BASE}/`);
  try {
    await page.evaluate(async (email, pass) => {
      const token = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';
      const headers={ 'Content-Type':'application/json' }; if (token) headers['X-CSRF-TOKEN']=token;
      await fetch('/login', { method:'POST', headers, body: JSON.stringify({email, password:pass}) });
    }, ERANK_EMAIL, ERANK_PASSWORD);
    await page.waitForLoadState('networkidle', {timeout:30000}).catch(()=>{});
  } catch {}
  if (!(await isLoggedIn(page))) {
    try {
      await page.getByLabel(/email/i).fill(ERANK_EMAIL);
      await page.getByLabel(/password/i).fill(ERANK_PASSWORD);
      await Promise.all([
        page.waitForNavigation({ url:/\/dashboard/, timeout:45000 }),
        page.getByRole('button',{name:/log.?in|sign.?in/i}).click()
      ]);
    } catch(e){ console.error('Login UI fallback:', e.message); }
  }
  if (!(await isLoggedIn(page))) throw new Error('Login failed — check credentials/cookies');
  await saveStorage();
  return true;
}
async function withRetries(taskFn, label='task'){
  let lastErr;
  for (let i=1;i<=MAX_RETRIES;i++){
    try{ const out=await taskFn(); consecutiveErrors=0; return out; }
    catch(e){ lastErr=e; consecutiveErrors++; await sleep(rand(700,1500)*i); if (consecutiveErrors>=RECYCLE_AFTER){ await recycleContext(`too many errors (${consecutiveErrors})`); await ensureBrowser(); } }
  }
  throw lastErr;
}

// ---------- XHR capture & normalization ----------
function findArraysDeep(obj, pred, acc=[]){
  if (!obj || typeof obj !== 'object') return acc;
  if (Array.isArray(obj) && obj.some(pred)) acc.push(obj);
  for (const k of Object.keys(obj)) findArraysDeep(obj[k], pred, acc);
  return acc;
}
async function captureJson(page, pred, timeMs=3000){
  const bucket=[];
  const handler = async (r)=>{
    try{
      const ct=(r.headers()['content-type']||'').toLowerCase();
      if (!ct.includes('application/json')) return;
      const body=await r.text();
      const json=JSON.parse(body);
      const arrays= findArraysDeep(json, pred);
      if (arrays.length) bucket.push({ json, arrays });
    }catch{}
  };
  page.on('response', handler);
  await page.waitForTimeout(timeMs);
  page.off('response', handler);
  return bucket;
}
function normalizeValue(v){
  if (v==null) return '';
  if (typeof v==='number') return String(v);
  if (typeof v==='string') return v;
  if (typeof v==='object'){
    const prefer=['avg_sales','sales','views','favorites','fav','avg_searches','searches','volume','value','count','score','total','avg','competition','etsy_competition'];
    for (const k of prefer){ if (v[k]!=null){ const x=v[k]; if (typeof x==='number') return String(x); if (typeof x==='string') return x; } }
    for (const [,x] of Object.entries(v)){ if (typeof x==='number') return String(x); if (typeof x==='string') return x; }
    try{ return JSON.stringify(v); }catch{ return ''; }
  }
  return '';
}
function normalizeKeyword(o){
  const kw=(o?.keyword ?? o?.term ?? o?.query ?? '').toString().trim();
  const volume= normalizeValue(o?.volume ?? o?.searches ?? o?.avg_searches ?? o?.metrics);
  let competition = normalizeValue(o?.competition ?? o?.etsy_competition ?? o?.comp);
  // map non-numeric competition to numeric band for ranking
  const t=(competition||'').toLowerCase();
  if (t && !/\d/.test(t)){
    if (/very\s*high/.test(t))      competition='100000';
    else if (/high/.test(t))        competition='50000';
    else if (/medium/.test(t))      competition='10000';
    else if (/low/.test(t))         competition='1000';
    else                            competition='0';
  }
  if (!kw) return null;
  return { keyword:kw, volume, competition, score: parseScore(volume, competition) };
}
function normalizeListing(o){
  const base=o||{};
  let id    = base.listing_id ?? base.id ?? base?.listing?.id ?? base?.listing?.listing_id ?? '';
  let title = (base.title ?? base.name ?? base?.listing?.title ?? base?.listing?.name ?? '').toString().trim();
  let href  = (base.url ?? base.link ?? base.permalink ?? base?.listing?.url ?? base?.listing?.link ?? '').toString().trim();
  let shop_id   = base.shop_id ?? base?.shop?.id ?? base?.seller_id ?? '';
  let shop_name = (base.shop_name ?? base?.shop?.name ?? base?.seller_name ?? '').toString().trim();
  let sales     = toInt( base.sales ?? base?.shop_sales ?? base?.listing?.sales );
  let views     = toInt( base.views ?? base?.listing_views );
  let favorites = toInt( base.favorites ?? base?.hearts ?? base?.listing_favorites );

  if (!id && href){ const m = href.match(/\/listing\/(\d+)/i); if (m) id = m[1]; }
  if (!href && id) href = `https://www.etsy.com/listing/${id}`;

  // simple product score: combine views & favorites; fallback to 1 if both zero
  const prodScore = (views * 0.6) + (favorites * 1.2) + (sales * 5);

  return (id || href || title) ? { listing_id:id, title, href, shop_id, shop_name, views, favorites, sales, score: prodScore } : null;
}

// ---------- HTML helpers ----------
function htmlStats(html){ return { htmlLength: html?.length||0, totalKeywords:(html?.match(/keyword/gi)||[]).length }; }
function tableByHeaders($, headerMatchers=[]){
  const tables=[];
  $('table').each((_,t)=>{
    const $t=$(t);
    const header=[];
    $t.find('thead th, tr th').each((__,th)=> header.push($(th).text().trim().toLowerCase()));
    if (!header.length) return;
    const ok = headerMatchers.every(rx => header.some(h=> rx.test(h)));
    if (!ok) return;
    const rows=[];
    $t.find('tbody tr, tr').each((i,tr2)=>{
      const tds=$(tr2).find('td'); if(!tds.length) return;
      rows.push( tds.map((__,td)=> $(td).text().trim()).get() );
    });
    if (rows.length) tables.push({ header, rows });
  });
  return tables[0] || null;
}
function parseKeywordsHTML(html){
  const $=cheerio.load(html);
  const tbl = tableByHeaders($, [/^keyword$/, /volume|avg.*search|searches/, /(etsy\s*comp|competition)/i]);
  if (!tbl) return { count:0, results:[], ...htmlStats(html) };
  const k=tbl.header.findIndex(h=>/keyword/.test(h));
  const v=tbl.header.findIndex(h=>/(volume|avg.*search|searches)/i.test(h));
  const c=tbl.header.findIndex(h=>/(etsy\s*comp|competition)/i.test(h));
  let rows = tbl.rows.map(r=>{
    const kw=(r[k]||'').trim(); if(!kw) return null;
    const vol=(r[v]||'').trim();
    const comp=c>=0?(r[c]||'').trim():'';
    return { keyword:kw, volume:vol, competition:comp, score:parseScore(vol, comp) };
  }).filter(Boolean);
  const seen=new Set();
  rows=rows.filter(r=>{const key=r.keyword.toLowerCase(); if(seen.has(key)) return false; seen.add(key); return true;});
  return { count:rows.length, results:rows, ...htmlStats(html) };
}
function parseTopListingsHTML(html){
  const $=cheerio.load(html);
  const items=[];
  $('[data-listing-id]').each((_,el)=>{
    const id=$(el).attr('data-listing-id')||'';
    const a=$(el).find('a[href*="/listing/"]').first();
    const href=a.attr('href')||'';
    const title=a.text().trim() || $(el).text().trim();
    items.push( normalizeListing({ listing_id:id, url:href, title }) );
  });
  return { count: items.length, results: items.filter(Boolean), ...htmlStats(html) };
}

// ---------- UI helpers ----------
async function ensureMarketplaceCountry(page, marketplace, country){
  const mpBtn= page.getByRole('button',{name:/marketplace/i}).or(page.getByRole('combobox').nth(0));
  if (await mpBtn.isVisible().catch(()=>false)){ await mpBtn.click().catch(()=>{}); await page.getByRole('option',{name:new RegExp(`^${marketplace}$`,'i')}).click().catch(()=>{}); }
  const cBtn= page.getByRole('button',{name:/country/i}).or(page.getByRole('combobox').nth(1));
  if (await cBtn.isVisible().catch(()=>false)){ await cBtn.click().catch(()=>{}); await page.getByRole('option',{name:new RegExp(`^${country}$`,'i')}).click().catch(()=>{}); }
}
async function ensurePeriod(page, period){
  if (!period) return;
  const map={ '30d':/last\s*30\s*days/i, 'this_month':/this\s*month/i, 'last_month':/last\s*month/i };
  const rx=map[String(period).toLowerCase?.()||''];
  if (!rx) return;
  const dd = page.locator('button:has-text("Last 30 days"), button:has-text("This month"), button:has-text("Last month"), .ant-select-selector');
  if (await dd.first().isVisible().catch(()=>false)){
    await dd.first().click().catch(()=>{});
    const opt = page.locator('.ant-select-item, [role="option"]').filter({ hasText: rx });
    if (await opt.first().isVisible().catch(()=>false)){
      await opt.first().click().catch(()=>{});
      await page.waitForLoadState('networkidle', {timeout:10000}).catch(()=>{});
    }
  }
}
async function typeAndSearch(page, q){
  try{
    const inputSel='input[placeholder="Enter keywords, separated by comma"]';
    await page.waitForSelector(inputSel,{timeout:20000});
    const input=await page.$(inputSel); if(!input) throw new Error('keyword input not found');
    await input.click({clickCount:3}).catch(()=>{});
    await input.fill('');
    await input.type(String(q), {delay:35});
    await page.evaluate(sel=>{ const el=document.querySelector(sel); if(el){ el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); } }, inputSel);
    await input.press('Enter').catch(()=>{});
    await page.waitForSelector('table tbody tr td, [data-listing-id], [data-keyword], .ant-empty', {timeout:20000}).catch(()=>{});
  }catch(e){ console.error('typeAndSearch:', e.message); }
}
async function autoScroll(page, steps=4){ for(let i=0;i<steps;i++){ await page.evaluate(()=>window.scrollBy(0, window.innerHeight*0.85)); await sleep(250);} }
async function enrichListingsWithShops(page, items){
  const map = await page.evaluate(()=>{
    const out={};
    document.querySelectorAll('[data-listing-id]').forEach(card=>{
      const id = card.getAttribute('data-listing-id') || '';
      const anchor = card.querySelector('a[href*="/listing/"]');
      const href = anchor ? (anchor.getAttribute('href')||'') : '';
      const shopA = card.querySelector('a[href*="/shop/"]');
      const shopHref = shopA ? (shopA.getAttribute('href')||'') : '';
      const shopName = shopA ? (shopA.textContent||'').trim() : '';
      const m = /\/shop\/([^/?#]+)/i.exec(shopHref || '');
      const key = id || href;
      if (key) out[key] = { shop_id: m ? m[1] : '', shop_name: shopName };
    });
    return out;
  });
  for (const r of items) {
    const key = r.listing_id || r.href || '';
    if (key && map[key]) {
      r.shop_id   = r.shop_id   || map[key].shop_id   || '';
      r.shop_name = r.shop_name || map[key].shop_name || '';
    }
  }
  return items;
}

// ---------- Health / Debug ----------
app.get('/healthz', (_req,res)=> res.json({ ok:true, service:'erank-scraper', stealth:STEALTH_ON }));
app.get('/erank/healthz', (_req,res)=> res.json({ ok:true, alias:'erank/healthz', stealth:STEALTH_ON }));
app.get('/debug/cookies', async (_req,res)=>{ try{ await ensureBrowser(); const ck=await context.cookies('https://members.erank.com'); res.json({count:ck.length, cookies: ck.map(c=>({name:c.name, domain:c.domain}))}); }catch(e){ res.status(500).json({error:e.message}); }});
app.get('/erank/raw', async (req,res)=>{ const p=(req.query.path||'/dashboard').toString(); try{ await ensureBrowser(); const page=await context.newPage(); await loginIfNeeded(page); await openAndEnsure(page, `${BASE}${p.startsWith('/')?'':'/'}${p}`, `${BASE}/`); const html=await page.content(); await page.close(); res.set('content-type','text/html; charset=utf-8').send(html);}catch(e){ res.status(500).json({error:e.message}); }});

// ---------- KEYWORDS (Top N) ----------
app.get('/erank/keywords', async (req,res)=>{
  const q=(req.query.q||'').toString().trim();
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit||DEFAULT_COUNT,10)||DEFAULT_COUNT));
  const country=(req.query.country||DEFAULT_COUNT?req.query.country:DEFAULT_COUNTRY).toUpperCase();
  const marketplace=(req.query.marketplace||DEFAULT_MARKET).toLowerCase();
  if(!q) return res.status(400).json({error:'Missing ?q='});
  try{
    const out = await withRetries(async ()=>{
      await ensureBrowser(); const page=await context.newPage(); await loginIfNeeded(page);
      await openAndEnsure(page, `${BASE}/keyword-tool`, `${BASE}/`);
      await ensureMarketplaceCountry(page, marketplace, country);
      await typeAndSearch(page, q);

      // wait for a couple of data responses
      for (let i=0;i<2;i++){ await page.waitForResponse(r=>/keyword|search|inertia/i.test(r.url()) && r.status()===200, {timeout:5000}).catch(()=>{}); }

      const cap = await captureJson(page, x=> x && typeof x==='object' && ('keyword'in x || 'term'in x), 4500);
      await autoScroll(page, 4);

      let results=[];
      for (const hit of cap) for (const arr of hit.arrays) for (const o of arr){ const nk=normalizeKeyword(o); if (nk) results.push(nk); }

      if (!results.length){
        await page.waitForSelector('table tbody tr td, [data-keyword], .ant-empty',{timeout:4000}).catch(()=>{});
        const html = await page.content();
        results = parseKeywordsHTML(html).results;
      }
      await page.close();

      // dedupe + rank
      const seen=new Set();
      results = results.filter(r=>{ const key=(r.keyword||'').toLowerCase(); if(!key||seen.has(key)) return false; seen.add(key); return true; });
      results.forEach(r=> { r.score = parseScore(r.volume, r.competition); });
      results.sort((a,b)=> b.score - a.score || toInt(b.volume)-toInt(a.volume));

      return { query:q, country, marketplace, count:Math.min(results.length, limit), results:results.slice(0,limit) };
    }, 'keywords-top');
    res.json(out);
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ---------- TAGS (Top N) ----------
app.get('/erank/tags', async (req,res)=>{
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit||DEFAULT_TAGS_N,10)||DEFAULT_TAGS_N));
  const country=(req.query.country||DEFAULT_COUNTRY).toUpperCase();
  const marketplace=(req.query.marketplace||DEFAULT_MARKET).toLowerCase();
  const period = (req.query.period||'').toString();
  try{
    await ensureBrowser(); const p=await context.newPage(); await loginIfNeeded(p);
    await openAndEnsure(p, `${BASE}/tags?country=${encodeURIComponent(country)}`, `${BASE}/`);
    await ensurePeriod(p, period);
    await p.waitForTimeout(600);
    await autoScroll(p, 8);

    const cap = await captureJson(p, x=> x && typeof x==='object' && ('tag' in x), 2500);

    let rows=[];
    for(const hit of cap) for(const arr of hit.arrays) for(const o of arr){
      const tag=(o.tag||'').trim(); if(!tag) continue;
      const avg_searches = normalizeValue(o.avg_searches ?? o.searches ?? '');
      const etsy_competition = normalizeValue(o.etsy_competition ?? o.competition ?? '');
      const score = parseScore(avg_searches, etsy_competition);
      rows.push({ tag, avg_searches, etsy_competition, score });
    }

    if (!rows.length){
      // DOM fallback
      rows = await p.evaluate(()=>{
        const out=[]; const t=document.querySelector('table'); if(!t) return out;
        const headers=Array.from(t.querySelectorAll('thead th, tr th')).map(th=>th.textContent.trim().toLowerCase());
        const idx={
          tag:  headers.findIndex(h=>h==='tag'),
          avgS: headers findIndex ? -1 : headers.findIndex(h=>h.includes('search')),
          comp: headers.findIndex(h=>h.includes('competition')||h.includes('etsy'))
        };
        Array.from(t.querySelectorAll('tbody tr, tr')).forEach(tr=>{
          const tds=Array.from(tr.querySelectorAll('td')).map(td=>td.textContent.trim());
          if(!tds.length) return;
          const tag = idx.tag>=0? tds[idx.tag] : '';
          const avgS= idx.avgS>=0? tds[idx.avgS]: '';
          const comp= idx.comp>=0? tds[idx.comp]: '';
          if (tag) out.push({tag, avg_searches:avgS, etsy_competition:comp});
        });
        return out;
      });
      rows = rows.map(r=> ({...r, score: parseScore(r.avg_searches, r.etsy_compartion||r.etsy_competition)}));
      if (!rows.length){
        const html=await p.content();
        const $=cheerio.load(html);
        const tbl=tableByHeaders($, [/^tag$/, /avg.*search|searches/, /competition|etsy/]);
        if (tbl){
          const idx={
            tag:  tbl.header.findIndex(h=>/^tag$/.test(h)),
            avgS: tbl.header.findIndex(h=>/(avg.*search|searches)/.test(h)),
            comp: tbl.header findIndex ? -1 : tbl.header.findIndex(h=>/(competition|etsy)/.test(h))
          };
          rows = tbl rows ? tbl.rows.map(r=>{
            const t=r[idx.tag]||''; if(!t) return null;
            const as= idx.avgS>=0? (r[idx.avgS]||'') : '';
            const cp= idx.comp>=0? (r[idx.comp]||'') : '';
            return { tag:t, avg_searches:as, etsy_competition:cp, score:parseScore(as,cp) };
          }).filter(Boolean) : [];
        }
      }
    }

    await p.close();
    rows.sort((a,b)=> b.score - a.score || toInt(b.avg_searches)-toInt(a.avg_searches));
    res.json({ country, marketplace, count: Math.min(rows.length, limit), results: rows.slice(0,limit) });
  }catch(e){ console.error('tags error:', e); res.status(500).json({error:e.message}); }
});

// ---------- internal: getTopListings (reusable) ----------
async function getTopListings({ q, country, marketplace, limit, period }){
  await ensureBrowser();
  const page = await context.newPage();
  await loginIfNeeded(page);

  await openAndEnsure(page, `${BASE}/keyword-tool`, `${BASE}/`);
  await ensureMarketplaceCountry(page, marketplace, country);
  await ensurePeriod(page, period);
  await typeAndSearch(page, q);

  const tab=page.getByRole('tab',{name:/top listings/i});
  if (await tab.isVisible().catch(()=>false)) {
    await tab.click().catch(()=>{});
    await page.waitForLoadState('networkidle',{timeout:30000}).catch(()=>{});
  } else {
    await page.locator('text=Top Listings').first().click().catch(()=>{});
    await page.waitForLoadState('networkidle',{timeout:30000}).catch(()=>{});
  }

  // try to load more
  const moreBtn = page.locator('button:has-text("Load more"), button:has-text("Show more")').first();
  if (await moreBtn.isVisible().catch(()=>false)){
    await moreBtn.click().catch(()=>{});
    await page.waitForLoadState('networkidle',{timeout:15000}).catch(()=>{});
  }

  const cap = await captureJson(page, x=> x && typeof x==='object' && ('listing_id'in x || 'title'in x || 'url' in x || 'shop' in x), 5000);
  await autoScroll(page, 6);

  let results=[];
  for (const hit of cap) for (const arr of hit.arrays) for (const o of arr){ const n=normalizeListing(o); if (n) results.push(n); }

  if (!results.length){
    const html=await page.content();
    results = parseTopListingsHTML(html).results;
  }

  results = await enrichListingsWithShops(page, results);
  await page.close();

  // dedupe & crop
  const seen=new Set();
  results = results.filter(r=>{
    const key = (r.listing_id||'')+'|'+(r.href||'');
    if (seen.has(key)) return false;
    seen.add(key);
    return (r.listing_id || r.href);
  }).slice(0, limit);

  return results;
}

// ---------- TOP-LISTINGS (public) ----------
app.get('/erank/top-listings', async (req,res)=>{
  const q=(req.query.q||'').toString().trim();
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit||DEFAULT_PROD_N,10)||DEFAULT_PROD_N));
  const country=(req.query.country||DEFAULT_COUNTRY).toUpperCase();
  const marketplace=(req.query.money||req.query.marketplace||DEFAULT_MARKET).toLowerCase();
  const period=(req.query.period||'').toString();
  if(!q) return res.status(400).json({error:'Missing ?q='});
  try{
    const results = await withRetries(()=> getModifiedTopProducts({ q, country, marketplace, limit, period }), 'top-listings');
    res.json({ query:q, country, marketplace, count:results.length, results });
  }catch(e){ res.status(500).json({error:e.message}); }
});

// Wrapper to keep legacy name (top-listings uses getTopListings; top-products uses extended ranking)
async function getModifiedTopProducts(opts){
  const items = await getTopListings(opts);
  // leave in default order (as returned by eRank) for /erank/top-listings
  return items;
}

// ---------- NEW: TOP-PRODUCTS (rankable) ----------
app.get('/erank/top-products', async (req,res)=>{
  const q=(req.query.q||'').toString().trim();
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit||DEFAULT_PROD_N,10)||DEFAULT_PROD_N));
  const country=(req.query.country||DEFAULT_COUNTRY).toUpperCase();
  const marketplace=(req.query.marketplace||DEFAULT_MARKET).toLowerCase();
  const period=(req.query.period||'').toString();
  const sort_by=(req.query.sort_by||'score').toLowerCase(); // score|sales|views|favs
  if(!q) return res.status(400).json({error:'Missing ?q='});
  try{
    const items = await withRetries(()=> getTopListings({ q, country, marketplace, limit: 200, period }), 'top-products');

    // rank
    const ranker = {
      'score':  (a,b)=> (b.score||0) - (a.score||0),
      'sales':  (a,b)=> (b.sales||0) - (a.sales||0),
      'views':  (a,b)=> (b.views||0) - (a.views||0),
      'favs':   (a,b)=> (b.favorites||0) - (a.favorites||0),
    }[sort_by] || ((a,b)=> (b.score||0) - (a.score||0));

    const ranked = items.sort(ranker).slice(0, limit);
    res.json({ query:q, country, marketplace, period, sort_by, count:ranked.length, results:ranked });
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ---------- My Shop / Stats ----------
app.get('/erank/my-shop', async (_req,res)=>{
  try{
    await ensureBrowser(); const page=await context.newPage(); await loginIfNeeded(page);
    await openAndEnsure(page, `${BASE}/dashboard`, `${BASE}/`);
    const html=await page.content();
    const $=cheerio load ? cheerio.load(html) : require('cheerio').load(html);
    const stats={};
    $('[class*="stat"], [class*="metric"]').each((_,el)=>{
      const t=$(el).text().trim().replace(/\s+/g,' ');
      if(!t) return; const p=t.split(':'); if (p.length>=2) stats[p[0].trim()] = p.slice(1).join(':').trim();
    });
    await page.close();
    res.json({ stats, ...({}) });
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/erank/stats', async (_req,res)=>{
  try{ await ensureBrowser(); const page=await context.newPage(); await loginIfNeeded(page);
    await openAndEnsure(page, `${BASE}/dashboard`, `${BASE}/`);
    const html=await page.content(); await page.close();
    res.json({ ok:true, ...{ htmlLength: (html?.length||0), totalKeywords: (html?.match(/keyword/gi)||[]).length } });
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ---------- Debug screenshots ----------
app.get('/debug/keywords-screenshot', async (req,res)=>{
  const q=(req.query.q||'').toString().trim();
  const country=(req.query.country||DEFAULT_COUNTRY).toUpperCase();
  const marketplace=(req.query.marketplace||DEFAULT_MARKET).toLowerCase();
  if(!q) return res.status(400).json({error:'Falta ?q='});
  try{
    await ensureBrowser(); const page=await context.newPage(); await loginIfNeeded(page);
    await openAndEnsure(page, `${BASE}/keyword-tool`, `${BASE}/`);
    await ensureMarketplaceCountry(page, marketplace, country);
    await typeAndSearch(page, q);
    await page.waitForTimeout(1200);
    const img=await page.captureScreenshot?await page.captureScreenshot():await page.screenshot({fullPage:true});
    await page.close();
    res.set('content-type','image/png').send(img);
  }catch(e){ res.status(500).json({error:e.message}); }
});
app.get('/debug/toplist-screenshot', async (req,res)=>{
  const q=(req.html?req.html:q)=>q; // safe
  const query=(req.query.q||'').toString().trim();
  const country=(req.query.country||DEFAULT_COUNTRY).toUpperCase();
  const marketplace=(req.query.marketplace||DEFAULT_MARKET).toLowerCase();
  if(!query) return res.status(400).json({error:'Falta ?q='});
  try{
    await ensureBrowser(); const page=await context.newPage(); await loginIfNeeded(page);
    await openAndEnsure(page, `${BASE}/keyword-tool`, `${BASE}/`);
    await ensureMarketplaceCountry(page, marketplace, country);
    await typeAndSearch(page, query);
    const tab=page.getByRole('exact',{name:/^Top\s+Listings$/i}).or(page.getByRole('tab',{name:/top listings/i}));
    if (await tab.first().isVisible().catch(()=>false)){ await tab.first().click().catch(()=>{}); await page.waitForLoadState('networkidle',{timeout:30000}).catch(()=>{}); }
    await page.waitForTimeout(1200);
    const img=await page.screenshot({fullPage:true});
    await page.close();
    res.set('content-type','image/png').send(img);
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ---------- Start ----------
app.listen(port, ()=> {
  console.log(`[eRank] API listening on :${port} (stealth=${STEALTH_ON}, retries=${MAX_RETRIES})`);
});
