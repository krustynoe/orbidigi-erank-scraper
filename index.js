// index.js — eRank PRO scraper FINAL (TopN + scoring + debug) — clean & robust (CJS)

const fs = require('node:fs');
const path = require('path');
const express = require('express');
const cheerio = require('cheerio');
const { chromium } = require('playwright');

const app = express();
const port = process.env.PORT || 3000;

/* ===========================
   CONFIG & CONSTANTS
=========================== */
const BASE            = 'https://members.erank.com';
const DATA_DIR        = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const STORAGE         = path.join(DATA_DIR, 'storageState.json');

const DEFAULT_KW_N    = 30;
const DEFAULT_TAG_N   = 15;
const DEFAULT_PROD_N  = 20;

const DEFAULT_COUNTRY = (process.env.ERANK_DEFAULT_COUNTRY || 'EU').toUpperCase();
const DEFAULT_MARKET  = (process.env.ERANK_DEFAULT_MARKETPLACE || 'etsy').toLowerCase();

const ERANK_COOKIES   = (process.env.ERANK_COOKIES  || '').trim();
const ERANK_EMAIL     = (process.env.ERANK_EMAIL    || '').trim();
const ERANK_PASSWORD  = (process.env.ERANK_PASSWORD || '').trim();

const STEALTH_ON      = (process.env.STEALTH_ON || '1') !== '0';
const JITTER_MIN      = parseInt(process.env.STEALTH_MIN_MS || '350', 10);
const JITTER_MAX      = parseInt(process.env.STEALTH_MAX_MS || '900', 10);
const MAX_RETRIES     = parseInt(process.env.MAX_RETRIES    || '3', 10);
const RECYCLE_AFTER   = parseInt(process.env.RECYCLE_AFTER  || '6', 10);

const UA_POOL   = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.6533.99 Safari/537.36'
];
const LANG_POOL = ['en-US,en;q=0.9,es;q=0.8','en-GB,en;q=0.9,es;q=0.7','es-ES,es;q=0.9,en;q=0.8'];

let browser = null, context = null;
let consecutiveErrors = 0;

/* ===========================
   UTILS
=========================== */
const rand   = (a,b)=>Math.floor(Math.random()*(b-a+1))+a;
const sleep  = ms=>new Promise(r=>setTimeout(r,ms));
const pick   = arr=>arr[Math.floor(Math.random()*arr.length)];
const jitter = ()=> STEALTH_ON ? sleep(rand(JITTER_MIN,JITTER_MAX)) : Promise.resolve();

const toInt = v => {
  if (v == null) return 0;
  if (typeof v === 'number') return Math.max(0, Math.floor(v));
  if (typeof v === 'string') {
    const s = v.replace(/[^\d]/g,'');
    return s ? parseInt(s,10) : 0;
  }
  return 0;
};
const score = (volume, comp)=> {
  const v = toInt(volume);
  const c = toInt(comp);
  return v / (c + 1);
};

/* ===========================
   BROWSER / LOGIN
=========================== */
async function recycleContext(reason='recycle'){
  try{ if (context) await context.close(); }catch{}
  try{ if (browser) await browser.close(); }catch{}
  browser=null; context=null; consecutiveErrors=0;
  console.warn('[recycle]', reason);
}
async function ensureBrowser(){
  if (browser && context) return;
  browser = await chromium.launch({ headless:true, args:['--no-sandbox','--disable-dev-shm-usage'] });

  const ua   = pick(UA_POOL);
  const lang = pick(LANG_POOL);

  const ctxOpts = {
    baseURL: BASE,
    userAgent: ua,
    locale: lang.startsWith('es')?'es-ES':'en-US',
    extraHTTPHeaders: { 'accept-language': lang, 'upgrade-insecure-requests':'1' }
  };
  if (fs.existsSync(STORAGE)) ctxOpts.storageState = STORAGE;
  context = await browser.newContext(ctxOpts);

  if (ERANK_COOKIES){
    const cookies = ERANK_COOKIES.split(';').map(s=>s.trim()).filter(Boolean).map(pair=>{
      const i=pair.indexOf('='); if (i<=0) return null;
      return { name:pair.slice(0,i).trim(), value:pair.slice(i+1).trim(), path:'/', secure:true, httpOnly:false };
    }).filter(Boolean);
    const both=[];
    for (const c of cookies){
      both.push({ ...c, domain:'members.erank.com', sameSite:'None' });
      both.push({ ...c, domain:'.erank.com',        sameSite:'None' });
    }
    try{ await context.addCookies(both); }catch(e){ console.error('addCookies:', e.message); }
  }
}
async function saveState(){ try{ if (context) await context.storageState({path:STORAGE}); }catch{} }

async function openAndWait(page, url, referer){
  if (referer) await page.setExtraHTTPHeaders({ referer });
  await jitter();
  const resp = await page.goto(url, { waitUntil:'domcontentloaded', timeout:60000 });
  await page.waitForLoadState('networkidle', { timeout:60000 }).catch(()=>{});
  await jitter();
  return resp;
}
async function isLoggedIn(page){
  try{ const r=await openAndWait(page, `${BASE}/dashboard`, `${BASE}/`); return r && r.ok(); }catch{ return false; }
}
async function loginIfNeeded(page){
  if (await isLoggedIn(page)) return true;
  if (ERANK_COOKIES){
    await page.reload({waitUntil:'domcontentloaded'}).catch(()=>{});
    await jitter();
    if (await isLoggedIn(page)){ await saveState(); return true; }
  }
  if (!ERANK_EMAIL || !ERANK_PASSWORD) throw new Error('No valid session; set ERANK_EMAIL/ERANK_PASSWORD or ERANK_COOKIES');

  await openAndWait(page, `${BASE}/login`, `${BASE}/`);
  try{
    await page.evaluate(async (email,pass)=>{
      const tok = document.querySelector('meta[name="csrf-token"]')?.content || '';
      const h={ 'Content-Type':'application/json' }; if (tok) h['X-CSRF-TOKEN']=tok;
      await fetch('/login', { method:'POST', headers:h, body:JSON.stringify({email, password:pass}) });
    }, ERANK_EMAIL, ERANK_PASSWORD);
    await page.waitForLoadState('networkidle', {timeout:30000}).catch(()=>{});
  }catch{}
  if (!(await isLoggedIn(page))){
    try{
      await page.getByLabel(/email/i).fill(ERANK_EMAIL);
      await page.getByLabel(/password/i).fill(ERANK_PASSWORD);
      await Promise.all([
        page.waitForNavigation({ url:/\/dashboard/, timeout:45000 }),
        page.getByRole('button',{name:/log.?in|sign.?in/i}).click()
      ]);
    }catch(e){ console.error('login fallback:', e.message); }
  }
  if (!(await isLoggedIn(page))) throw new Error('Login failed');
  await saveState();
  return true;
}

async function withRetries(fn, label='task'){
  let last;
  for (let i=1;i<=MAX_RETRIES;i++){
    try { const r=await fn(); consecutiveErrors=0; return r; }
    catch(e){ last=e; console.warn(`[${label}] retry ${i}/${MAX_RETRIES}`, e.message||e); await sleep(rand(700,1500)*i); if (++consecutiveErrors>=RECYCLE_AFTER){ await recycleContext(label); await ensureBrowser(); } }
  }
  throw last;
}

/* ===== callErankJson (por si en el futuro usamos otros /api/...) ===== */
async function callErankJson(apiPath) {
  await ensureBrowser();
  const page = await context.newPage();
  await loginIfNeeded(page);

  try {
    const url = apiPath.startsWith('http')
      ? apiPath
      : `${BASE}${apiPath.startsWith('/') ? apiPath : '/' + apiPath}`;

    const resp = await page.request.get(url, { timeout: 60000 });
    const status = resp.status();
    const text = await resp.text();

    if (status < 200 || status >= 300) {
      throw new Error(`eRank API ${url} -> HTTP ${status} ${text.slice(0, 200)}`);
    }

    try { return JSON.parse(text); }
    catch { return { _raw: text }; }
  } finally {
    try { await page.close(); } catch {}
  }
}

/* ===========================
   XHR CAPTURE & NORMALIZERS
=========================== */
function findArraysDeep(obj, pred, acc=[]){
  if (!obj || typeof obj!=='object') return acc;
  if (Array.isArray(obj) && obj.some(pred)) acc.push(obj);
  for (const k of Object.keys(obj)) findArraysDeep(obj[k], pred, acc);
  return acc;
}
async function captureJson(page, pred, ms=3000){
  const bag=[];
  const h = async (r)=>{
    try{
      const ct=(r.headers()['content-type']||'').toLowerCase();
      if (!ct.includes('application/json')) return;
      const t=await r.text(); const j=JSON.parse(t);
      const arrs = findArraysDeep(j, pred);
      if (arrs.length) bag.push({json:j, arrays:arrs});
    }catch{}
  };
  page.on('response',h);
  await page.waitForTimeout(ms);
  page.off('response',h);
  return bag;
}
function normVal(v){
  if (v==null) return '';
  if (typeof v==='number') return String(v);
  if (typeof v==='string') return v;
  if (typeof v==='object'){
    const keys=['avg_searches','searches','volume','value','count','score','total','avg','competition','etsy_competition','views','favorites','sales'];
    for (const k of keys){ if (v[k]!=null){ const x=v[k]; if (typeof x==='number') return String(x); if (typeof x==='string') return x; } }
    return '';
  }
}
function compToInt(c){
  const t=(c||'').toLowerCase();
  if (!t || /\d/.test(t)) return toInt(c);
  if (/very\s*high/.test(t)) return 100000;
  if (/high/.test(t))       return 50000;
  if (/medium/.test(t))     return 10000;
  if (/low/.test(t))        return 1000;
  return 0;
}
function normalizeKeyword(o){
  const kw=(o?.keyword ?? o?.term ?? o?.query ?? '').toString().trim();
  if (!kw) return null;
  const volume = normVal(o?.volume ?? o?.searches ?? o?.avg_searches ?? o?.metrics);
  let comp     = normVal(o?.competition ?? o?.etsy_competition ?? o?.comp ?? '');
  const cNum   = compToInt(comp);
  return { keyword:kw, volume, competition: comp || (cNum?String(cNum):''), score: score(volume, cNum) };
}
function normalizeListing(o){
  const b=o||{};
  let id    = b.listing_id ?? b.id ?? b?.listing?.id ?? b?.listing?.listing_id ?? '';
  let href  = (b.url ?? b.link ?? b.permalink ?? b?.listing?.url ?? b?.listing?.link ?? '').toString().trim();
  let title = (b.title ?? b.name ?? b?.listing?.title ?? b?.listing?.name ?? '').toString().trim();
  if (!id && href){ const m=href.match(/\/listing\/(\d+)/i); if (m) id=m[1]; }
  if (!href && id) href = `https://www.etsy.com/listing/${id}`;
  const views = toInt(b.views ?? b?.listing_views);
  const favs  = toInt(b.favorites ?? b?.hearts ?? b?.listing_favorites);
  const sales = toInt(b.sales ?? b?.shop_sales ?? b?.listing?.sales);
  const shop_id   = (b.shop_id ?? b?.shop?.id ?? b?.seller_id ?? '').toString();
  const shop_name = (b.shop_name ?? b?.shop?.name ?? b?.seller_name ?? '').toString().trim();
  const prodScore = (views*0.6)+(favs*1.2)+(sales*5);
  return (id||href||title) ? { listing_id:id, title, href, shop_id, shop_name, views, favorites:favs, sales, score:prodScore } : null;
}

/* ===========================
   HTML FALLBACK PARSERS
=========================== */
function tableByHeaders($, patterns){
  const tables=[];
  $('table').each((_,t)=>{
    const $t=$(t), hdr=[];
    $t.find('thead th, tr th').each((__,th)=> hdr.push($(th).text().trim().toLowerCase()));
    if (!hdr.length) return;
    if (!patterns.every(rx=> hdr.some(h=>rx.test(h)))) return;
    const rows=[]; 
    $t.find('tbody tr').each((__,tr)=>{
      const tds=$(tr).find('td'); 
      if(!tds.length) return; 
      rows.push(tds.map((__,td)=>$(td).text().trim()).get());
    });
    if (rows.length) tables.push({header:hdr, rows});
  });
  return tables[0]||null;
}

function parseKeywordsHTML(html){
  const $=cheerio.load(html);
  const tbl = tableByHeaders($, [/^keyword$/, /volume|avg.*search|searches/, /(etsy\s*comp|competition)/i]);
  if (!tbl) return {count:0, results:[], htmlLength:(html?.length||0), totalKeywords:(html?.match(/keyword/gi)||[]).length};
  const k = tbl.header.findIndex(h=>/keyword/.test(h));
  const v = tbl.header.findIndex(h=>/(volume|avg.*search|searches)/i.test(h));
  const c = tbl.header.findIndex(h=>/(etsy\s*comp|competition)/i.test(h));
  let rows = tbl.rows.map(r=>{
    const kw=(r[k]||'').trim(); if(!kw) return null;
    const vol=(r[v]||'').trim();
    const cp = c>=0 ? (r[c]||'').trim() : '';
    return { keyword:kw, volume:vol, competition:cp, score:score(vol, compToInt(cp)) };
  }).filter(Boolean);
  const seen=new Set();
  rows = rows.filter(x=>{ const key=x.keyword.toLowerCase(); if(seen.has(key)) return false; seen.add(key); return true;});
  return {count:rows.length, results:rows, htmlLength:(html?.length||0), totalKeywords:(html?.match(/keyword/gi)||[]).length};
}

function parseTopListingsHTML(html){
  const $=cheerio.load(html);
  const items=[];
  $('[data-listing-id]').each((_,el)=>{
    const id=$(el).attr('data-listing-id') || $(el).attr('data-value') || '';
    const a=$(el).find('a[href*="/listing/"]').first();
    const href=a.attr('href')||'';
    const title=(a.text()||'').trim() || $(el).text().trim();
    items.push( normalizeListing({listing_id:id, url:href, title}) );
  });
  return {count:items.length, results:items.filter(Boolean), htmlLength:(html?.length||0)};
}

/* ===== Trend Buzz HTML parser (robusto) ===== */
function parseTrendBuzzHTML(html) {
  const $ = cheerio.load(html);

  let tbl = tableByHeaders($, [
    /(keyword|color|product|recipient|style|material)/i,
    /search\s*trend|trend|volume|search/i
  ]);

  if (!tbl) {
    $('table').each((_, t) => {
      const $t = $(t);
      const hdr = [];
      $t.find('thead th, tr th').each((__, th) =>
        hdr.push($(th).text().trim().toLowerCase())
      );
      if (hdr.length >= 2 && !tbl) {
        const rows = [];
        $t.find('tbody tr').each((__, tr) => {
          const tds = $(tr).find('td');
          if (!tds.length) return;
          rows.push(
            tds
              .map((__, td) => $(td).text().trim())
              .get()
          );
        });
        if (rows.length) {
          tbl = { header: hdr, rows };
        }
      }
    });
  }

  if (!tbl) {
    return { count: 0, results: [], header: [], htmlLength: (html?.length || 0) };
  }

  const h = tbl.header;

  let iTerm = 0;
  let iTrend = h.length > 1 ? 1 : 0;

  const idxTerm = h.findIndex(x =>
    /(keyword|color|product|recipient|style|material)/i.test(x)
  );
  if (idxTerm >= 0) iTerm = idxTerm;

  const idxTrend = h.findIndex(x =>
    /search\s*trend|trend|volume|search/i.test(x)
  );
  if (idxTrend >= 0) iTrend = idxTrend;

  const results = tbl.rows
    .map(row => {
      const term = (row[iTerm] || '').trim();
      const trend = (row[iTrend] || '').trim();
      if (!term) return null;
      return { term, searchTrend: trend || '' };
    })
    .filter(Boolean);

  return { count: results.length, results, header: h };
}

/* ===== Trend Buzz JSON parser (via XHR /api/trend-buzz) ===== */
function parseTrendBuzzJSON(json, tabName) {
  if (!json || typeof json !== 'object') {
    return { count: 0, results: [] };
  }

  const arrays = findArraysDeep(
    json,
    x =>
      x &&
      typeof x === 'object' &&
      (
        'term' in x ||
        'keyword' in x ||
        'name' in x ||
        'color' in x ||
        'product' in x ||
        'recipient' in x ||
        'style' in x ||
        'material' in x
      )
  );

  const rows = [];
  for (const arr of arrays) {
    for (const o of arr) {
      if (!o || typeof o !== 'object') continue;

      const term =
        (o.term ||
         o.keyword ||
         o.name ||
         o.color ||
         o.product ||
         o.recipient ||
         o.style ||
         o.material ||
         '').toString().trim();

      if (!term) continue;

      const searchTrend = (
        o.search_trend ||
        o.trend ||
        o.score ||
        o.value ||
        o.change ||
        o.rank ||
        ''
      ).toString();

      rows.push({ term, searchTrend, _tab: tabName });
    }
  }

  const seen = new Set();
  const results = rows.filter(r => {
    const k = (r.term || '').toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return { count: results.length, results };
}

/* ===== Monthly trending-report JSON parser (via XHR) ===== */
function parseTrendingReportJSON(json) {
  if (!json || typeof json !== 'object') {
    return { count: 0, results: [] };
  }
  const arrays = findArraysDeep(json, x =>
    x && typeof x === 'object' &&
    ('term' in x || 'keyword' in x || 'search_term' in x)
  );
  const rows = [];
  for (const arr of arrays) {
    for (const o of arr) {
      if (!o || typeof o !== 'object') continue;
      const term =
        (o.term ||
         o.keyword ||
         o.search_term ||
         o.searchTerm ||
         '').toString().trim();
      if (!term) continue;

      const thisMonth = normVal(
        o.this_month ||
        o.thisMonth ||
        o.current_month ||
        o.current ||
        ''
      );
      const lastMonth = normVal(
        o.last_month ||
        o.lastMonth ||
        o.previous_month ||
        o.previous ||
        ''
      );
      const change = normVal(
        o.change ||
        o.diff ||
        o.change_percent ||
        o.delta ||
        ''
      );
      const searches = normVal(
        o.searches ||
        o.volume ||
        o.avg_searches ||
        o.total_searches ||
        ''
      );

      rows.push({ term, thisMonth, lastMonth, change, searches });
    }
  }

  const seen = new Set();
  const results = rows.filter(r => {
    const k = (r.term || '').toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { count: results.length, results };
}

/* ===== Monthly trending-report HTML parser ===== */
function parseTrendingReportHTML(html){
  const $ = cheerio.load(html);
  const tbl = tableByHeaders($, [
    /(keyword|search\s*term|product|recipient|style|material)/i,
    /(searches|volume|this\s*month|last\s*month)/i
  ]);
  if (!tbl) {
    return { count: 0, results: [], header: [], htmlLength: (html?.length || 0) };
  }
  const h = tbl.header;

  const iTerm  = h.findIndex(x => /(keyword|search\s*term|product|recipient|style|material)/i.test(x));
  const iThis  = h.findIndex(x => /(this\s*month|current)/i.test(x));
  const iLast  = h.findIndex(x => /(last\s*month|previous)/i.test(x));
  const iChange= h.findIndex(x => /change|difference/i.test(x));
  const iVol   = h.findIndex(x => /searches|volume/i.test(x));

  const results = tbl.rows
    .map(row => {
      const term      = (row[iTerm]   || '').trim();
      const thisMonth = iThis   >= 0 ? (row[iThis]   || '').trim() : '';
      const lastMonth = iLast   >= 0 ? (row[iLast]   || '').trim() : '';
      const change    = iChange >= 0 ? (row[iChange] || '').trim() : '';
      const searches  = iVol    >= 0 ? (row[iVol]    || '').trim() : '';
      if (!term) return null;
      return { term, thisMonth, lastMonth, change, searches };
    })
    .filter(Boolean);

  return { count: results.length, results, header: h };
}

/* ===== Thunderbit-style row builder para Monthly ===== */
function buildThunderStyleRow(row, opts = {}) {
  const country = (opts.country || DEFAULT_COUNTRY || 'USA').toUpperCase();

  const term       = (row.term || row.keyword || '').toString().trim();
  const thisMonthN = toInt(row.thisMonth || row.searches || 0);
  const lastMonthN = toInt(row.lastMonth || 0);

  const delta      = thisMonthN - lastMonthN;
  const deltaPct   = lastMonthN > 0 ? (delta / lastMonthN) : null;

  let changeIndicator = '-';
  if (delta > 0) changeIndicator = '↑';
  else if (delta < 0) changeIndicator = '↓';

  const keywordUrl =
    `${BASE}/keyword-tool?country=${encodeURIComponent(country)}` +
    `&keyword=${encodeURIComponent(term)}&source=etsy`;

  return {
    keyword: term,
    keyword_url: keywordUrl,
    this_month: thisMonthN,
    last_month: lastMonthN,
    change_abs: delta,
    change_pct: deltaPct,
    change_indicator: changeIndicator,
    searches: thisMonthN,
    raw_change: row.change || '',
    avg_searches: row.avg_searches || '',
    competition: row.competition || '',
    avg_ctr: row.avg_ctr || '',
    searchers_by_country: country
  };
}

/* ===========================
   UI HELPERS
=========================== */
async function ensureMarketplaceCountry(page, market, country){
  const mpBtn = page.getByRole('button',{name:/marketplace/i}).or(page.getByRole('combobox').nth(0));
  if (await mpBtn.isVisible().catch(()=>false)){ 
    await mpBtn.click().catch(()=>{}); 
    await page.getByRole('option',{name:new RegExp(`^${market}$`,'i')}).click().catch(()=>{}); 
  }
  const cBtn  = page.getByRole('button',{name:/country/i}).or(page.getByRole('combobox').nth(1));
  if (await cBtn.isVisible().catch(()=>false)){ 
    await cBtn.click().catch(()=>{}); 
    await page.getByRole('option',{name:new RegExp(`^${country}$`,'i')}).click().catch(()=>{}); 
  }
}

async function ensurePeriod(page, period){
  if (!period) return;
  const map={
    '30d':/last\s*30\s*days/i,
    'this_month':/this\s*month/i,
    'last_month':/last\s*month/i
  };
  const rx = map[String(period).toLowerCase()] || null;
  if (!rx) return;

  const dd = page.locator('button:has-text("Last 30 days"), button:has-text("This month"), button:has-text("Last month"), .ant-select-selector');
  if (await dd.first().isVisible().catch(()=>false)){
    await dd.first().click().catch(()=>{});
    const opt = page.locator('.ant-select-item,[role="option"]').filter({ hasText: rx });
    if (await opt.first().isVisible().catch(()=>false)){
      await opt.first().click().catch(()=>{}); 
      await page.waitForLoadState('networkidle',{timeout:10000}).catch(()=>{});
    }
  }
}

async function typeAndSearch(page, q){
  try{
    const sel='input[placeholder="Enter keywords, separated by comma"]';
    await page.waitForSelector(sel,{timeout:20000});
    const input=await page.$(sel); 
    if(!input) throw new Error('keyword input not found');

    await input.click({clickCount:3}).catch(()=>{}); 
    await input.fill(''); 
    await input.type(String(q),{delay:35});

    await page.evaluate(s=>{
      const el=document.querySelector(s); 
      if(el){ 
        el.dispatchEvent(new Event('input',{bubbles:true})); 
        el.dispatchEvent(new Event('change',{bubbles:true})); 
      }
    }, sel);
    await input.press('Enter').catch(()=>{});

    await page.waitForSelector('table tbody tr td, [data-listing-id], .ant-empty',{timeout:20000}).catch(()=>{});
  }catch(e){ console.error('typeAndSearch:', e.message); }
}

async function openTab(page, name){
  const rx = new RegExp(`^${name.replace(/\s+/g,'\\s+')}$`, 'i');
  const tab = page.getByRole('tab', { name: rx });
  if (await tab.isVisible().catch(()=>false)){
    await tab.click().catch(()=>{}); 
    await page.waitForLoadState('networkidle',{timeout:20000}).catch(()=>{});
    return true;
  }
  const loc = page.locator('text=' + name).first();
  if (await loc.isVisible().catch(()=>false)){
    await loc.click().catch(()=>{}); 
    await page.waitForLoadState('networkidle',{timeout:20000}).catch(()=>{});
    return true;
  }
  return false;
}

async function autoScroll(page, steps=4){ 
  for(let i=0;i<steps;i++){ 
    await page.evaluate(()=>window.scrollBy(0, window.innerHeight*0.85)); 
    await sleep(250); 
  } 
}

async function enrichShops(page, items){
  const map = await page.evaluate(()=>{
    const out={};
    document.querySelectorAll('[data-listing-id]').forEach(card=>{
      const id   = card.getAttribute('data-listing-id') || card.getAttribute('data-value') || '';
      const a    = card.querySelector('a[href*="/listing/"]');
      const href = a ? (a.getAttribute('href')||'') : '';
      const shopA= card.querySelector('a[href*="/shop/"]');
      const shopHref = shopA ? (shopA.getAttribute('href')||'') : '';
      const shopName = shopA ? (shopName = shopA.textContent||'').trim() : '';
      const m = /\/shop\/([^/?#]+)/i.exec(shopHref||'');
      const key = id || href;
      if (key) out[key] = { shop_id: m ? m[1] : '', shop_name: shopName };
    });
    return out;
  });

  for (const it of items){
    const k = it.listing_id || it.href || '';
    if (k && map[k]){
      it.shop_id   = it.shop_id   || map[k].shop_id   || '';
      it.shop_name = it.shop_name || map[k].shop_name || '';
    }
  }
  return items;
}

/* ===========================
   MIDDLEWARES & HEALTH
=========================== */
app.use((req,_res,next)=>{ 
  if (req.url.includes('//')) req.url=req.url.replace(/\/{2,}/g,'/'); 
  next(); 
});
app.use(async (_req,_res,next)=>{ 
  await jitter(); 
  next(); 
});

app.get('/healthz',      (_q,r)=>r.json({ok:true,service:'erank-scraper',stealth:STEALTH_ON}));
app.get('/erank/healthz',(_q,r)=>r.json({ok:true,alias:'erank/healthz',stealth:STEALTH_ON}));

app.get('/debug/cookies', async (_q,r)=>{
  try{ 
    await ensureBrowser(); 
    const ck=await context.cookies('https://members.erank.com'); 
    r.json({count:ck.length, cookies:ck.map(c=>({name:c.name,domain:c.domain}))}); 
  }catch(e){ 
    r.status(500).json({error:e.message}); 
  }
});

app.get('/erank/raw', async (req,res)=>{
  const p=(req.query.path||'/dashboard').toString();
  try{
    await ensureBrowser(); 
    const pg=await context.newPage(); 
    await loginIfNeeded(pg); 
    await openAndWait(pg, `${BASE}${p.startsWith('/')?'':'/'}${p}`, `${BASE}/`);
    const html=await pg.content(); 
    await pg.close(); 
    res.set('content-type','text/html; charset=utf-8').send(html);
  }catch(e){
    res.status(500).json({error:e.message});
  }
});

/* ===========================
   KEYWORDS (TOP N)
=========================== */
async function readStatsPanel(page){
  try{
    return await page.evaluate(()=>{
      const getNum = (s) => (s||'').replace(/,/g,'').match(/[\d.]+/)?.[0] || '';
      let avg='', comp='';
      document.querySelectorAll('*').forEach(n=>{
        const t=(n.textContent||'').toLowerCase();
        if (t.includes('avg') && t.includes('search')) avg = getNum(n.textContent);
        if (t.includes('competition')) comp = n.textContent.trim();
      });
      return { avgSearches:avg, competition:comp };
    });
  }catch{ return { avgSearches:'', competition:'' }; }
}

app.get('/erank/keywords', async (req,res)=>{
  const q=(req.query.q||'').toString().trim();
  const limit=Math.max(1,Math.min(200, parseInt(req.query.limit||DEFAULT_KW_N,10)));
  const country=(req.query.country||DEFAULT_COUNTRY).toUpperCase();
  const market =(req.query.marketplace||DEFAULT_MARKET).toLowerCase();
  if(!q) return res.status(400).json({error:'Missing ?q='});
  try{
    const out = await withRetries(async ()=>{
      await ensureBrowser(); const pg=await context.newPage(); await loginIfNeeded(pg);
      await openAndWait(pg, `${ BASE }/keyword-tool`, `${BASE}/`);
      await ensureMarketplaceCountry(pg, market, country);
      await typeAndSearch(pg, q);

      await openTab(pg, 'Keyword Ideas');
      for(let i=0;i<2;i++){
        await pg.waitForResponse(
          r => /keyword|search|inertia|ideas/i.test(r.url()) && r.status()===200,
          {timeout:6000}
        ).catch(()=>{});
      }
      let cap = await captureJson(pg, x=>x && typeof x==='object' && ('keyword' in x || 'term' in x), 7000);
      await autoScroll(pg, 6);

      let items=[];
      for(const h of cap)
        for(const arr of h.arrays)
          for(const o of arr){
            const nk=normalizeKeyword(o);
            if(nk) items.push(nk);
          }

      if (!items.length){
        const s = await readStatsPanel(pg);
        if (s.avgSearches){
          items.push({
            keyword:q,
            volume:s.avgSearches,
            competition:s.competition,
            score: score(s.avgSearches, compToInt(s.competition))
          });
        }
      }

      if (items.length < limit){
        await openTab(pg, 'Near Matches');
        await pg.waitForResponse(
          r=>/near|match|keyword|inertia/i.test(r.url()) && r.status()===200,
          {timeout:5000}
        ).catch(()=>{});
        cap = await captureJson(pg, x=>x && typeof x==='object' && ('keyword'in x || 'term' in x), 6000);
        await autoScroll(pg, 4);
        for(const h of cap)
          for(const arr of h.arrays)
            for(const o of arr){
              const nk=normalizeKeyword(o);
              if(nk) items.push(nk);
            }
      }

      if (!items.length){
        await pg.waitForSelector('table tbody tr td, [data-keyword], .ant-empty',{timeout:5000}).catch(()=>{});
        const html=await pg.content();
        items = parseKeywordsHTML(html).results;
      }

      await pg.close();

      const seen=new Set();
      items = items.filter(x=>{
        const k=(x.keyword||'').toLowerCase();
        if(!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      });

      items.forEach(x=> x.score=score(x.volume, compToInt(x.competition)));
      items.sort((a,b)=> b.score - a.score || toInt(b.volume)-toInt(a.volume));

      if (!items.length){
        return {
          query:q, country, marketplace:market,
          count:0, results:[],
          reason:'no-xhr-or-empty-dom'
        };
      }
      return {
        query:q,
        country,
        marketplace:market,
        count:Math.min(items.length,limit),
        results:items.slice(0,limit)
      };
    }, 'keywords');

    res.json(out);
  }catch(e){
    res.status(500).json({error:e.message});
  }
});


/* ===========================
   TAGS (TOP N)
=========================== */
app.get('/erank/tags', async (req,res)=>{
  const limit  = Math.max(1,Math.min(200, parseInt(req.query.limit||DEFAULT_TAG_N,10)));
  const country=(req.query.country||DEFAULT_COUNTRY).toUpperCase();
  const market =(req.query.marketplace||DEFAULT_MARKET).toLowerCase();
  const period =(req.query.period||'').toString();
  try{
    await ensureBrowser();
    const pg=await context.newPage();
    await loginIfNeeded(pg);

    await openAndWait(pg, `${BASE}/tags?country=${encodeURIComponent(country)}`, `${BASE}/`);
    await ensurePeriod(pg, period);
    await pg.waitForTimeout(600);
    await autoScroll(pg,6);

    const cap = await captureJson(pg, x=>x && typeof x==='object' && ('tag' in x), 2500);

    let rows=[];
    for(const h of cap)
      for(const arr of h.arrays)
        for(const o of arr){
          const tag=(o.tag||'').toString().trim();
          if(!tag) continue;
          const a = normVal(o.avg_searches ?? o.searches ?? '');
          const c = normVal(o.etsy_competition ?? o.competition ?? '');
          rows.push({ tag, avg_searches:a, etsy_competition:c, score:score(a,c) });
        }

    if (!rows.length){
      rows = await pg.evaluate(()=>{
        const out=[]; 
        const t=document.querySelector('table'); 
        if(!t) return out;

        const hdr = Array.from(t.querySelectorAll('thead th, tr th'))
          .map(th=>th.textContent.trim().toLowerCase());

        const iTag  = hdr.findIndex(h=>h==='tag');
        const iSrch = hdr.findIndex(h=>/avg.*search|searches/.test(h));
        const iComp = hdr.findIndex(h=>/competition|etsy/.test(h));

        t.querySelectorAll('tbody tr').forEach(tr=>{
          const td=Array.from(tr.children).map(x=>x.textContent.trim());
          const tag = iTag>=0? td[iTag] : '';
          const a   = iSrch>=0? td[iSrch]: '';
          const c   = iComp>=0? td[iComp]: '';
          if (tag) out.push({tag, avg_searches:a, etsy_competition:c});
        });
        return out;
      });

      rows = rows.map(r=> ({...r, score:score(r.avg_searches, r.etsy_competition)}));

      if(!rows.length){
        const html=await pg.content();
        const $=cheerio.load(html);
        const tbl=tableByHeaders($, [/^tag$/, /avg.*search|searches/, /competition|etsy/]);
        if (tbl){
          const iTag = tbl.header.findIndex(h=>h==='tag');
          const iSrch= tbl.header.findIndex(h=>/avg.*search|searches/.test(h));
          const iComp= tbl.header.findIndex(h=>/competition|etsy/.test(h));

          rows = tbl.rows.map(r=>{
            const t=(r[iTag]||'').trim(); 
            if(!t) return null;
            const a=(iSrch>=0? r[iSrch]: '').trim();
            const c=(iComp>=0? r[iComp]: '').trim();
            return { tag:t, avg_searches:a, etsy_competition:c, score:score(a,c) };
          }).filter(Boolean);
        }
      }
    }

    await pg.close();

    rows.sort((a,b)=> b.score - a.score || toInt(b.avg_searches)-toInt(a.avg_searches));

    res.json({
      country,
      marketplace:market,
      count:Math.min(rows.length,limit),
      results:rows.slice(0,limit)
    });

  }catch(e){
    console.error('tags error:', e);
    res.status(500).json({error:e.message});
  }
});


/* ===========================
   TOP LISTINGS
=========================== */
async function getTopListings({ q, country, market, limit, period }){
  await ensureBrowser();
  const pg=await context.newPage();
  await loginIfNeeded(pg);

  await openAndWait(pg, `${BASE}/keyword-tool`, `${BASE}/`);
  await ensureMarketplaceCountry(pg, market, country);
  await ensurePeriod(pg, period);
  await typeAndSearch(pg, q);

  await openTab(pg, 'Top Listings');

  for (let i=0;i<3;i++){
    const more = pg.locator('button:has-text("Load more"), button:has-text("Show more")').first();
    if (await more.isVisible().catch(()=>false)){
      await more.click().catch(()=>{});
      await pg.waitForLoadState('networkidle',{timeout:15000}).catch(()=>{});
    }
    await autoScroll(pg,6);
  }

  const cap = await captureJson(
    pg,
    x => x && typeof x==='object' &&
    ('listing_id'in x || 'title'in x || 'url'in x || 'shop' in x),
    8000
  );

  let items=[];
  for(const h of cap)
    for(const arr of h.arrays)
      for(const o of arr){
        const n=normalizeListing(o);
        if(n) items.push(n);
      }

  if (!items.length){
    const html=await pg.content();
    items = parseTopListingsHTML(html).results;
  }

  items = await enrichShops(pg, items);
  await pg.close();

  const seen=new Set();
  items = items.filter(r=>{
    const k=(r.listing_id||'')+'|'+(r.href||'');
    if(!r.listing_id && !r.href) return false;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return items.slice(0, limit);
}

app.get('/erank/top-listings', async (req,res)=>{
  const q=(req.query.q||'').toString().trim();
  if(!q) return res.status(400).json({error:'Missing ?q='});

  const limit   = Math.max(1,Math.min(200, parseInt(req.query.limit||DEFAULT_PROD_N,10)));
  const country = (req.query.country||DEFAULT_COUNTRY).toUpperCase();
  const market  = (req.query.marketplace||DEFAULT_MARKET).toLowerCase();
  const period  = (req.query.period||'').toString();

  try{
    const results = await withRetries(
      ()=> getTopListings({ q, country, market, limit, period }),
      'top-listings'
    );
    res.json({ query:q, country, marketplace:market, count:results.length, results });
  }catch(e){
    res.status(500).json({error:e.message});
  }
});


/* ===========================
   TOP PRODUCTS (sorters)
=========================== */
app.get('/erank/top-products', async (req,res)=>{
  const q=(req.query.q||'').toString().trim();
  if(!q) return res.status(400).json({error:'Missing ?q='});

  const limit   = Math.max(1,Math.min(200, parseInt(req.query.limit||DEFAULT_PROD_N,10)));
  const country = (req.query.country||DEFAULT_COUNTRY).toUpperCase();
  const market  = (req.query.marketplace||DEFAULT_MARKET).toLowerCase();
  const period  = (req.query.period||'').toString();
  const sortBy  = (req.query.sort_by||'score').toLowerCase();

  try{
    const items = await withRetries(
      ()=> getTopListings({ q, country, market, limit:200, period }),
      'top-products'
    );

    const filtered = items.filter(x =>
      (x.listing_id || x.href) &&
      (x.score>0 || x.sales>0 || x.views>0 || x.favorites>0)
    );
    const arr = filtered.length ? filtered : items;

    const rankers = {
      score:(a,b)=>(b.score||0)-(a.score||0),
      sales:(a,b)=>(b.sales||0)-(a.sales||0),
      views:(a,b)=>(b.views||0)-(a.views||0),
      favs :(a,b)=>(b.favorites||0)-(a.favorites||0),
    };

    const sorter = rankers[sortBy] || rankers.score;
    const results = arr.sort(sorter).slice(0,limit);

    res.json({
      query:q,
      country,
      marketplace:market,
      period,
      sort_by:sortBy,
      count:results.length,
      results
    });

  }catch(e){
    res.status(500).json({error:e.message});
  }
});


/* ===========================
   TREND BUZZ (JSON + HTML fallback)
=========================== */
app.get('/erank/trend-buzz', async (req, res) => {
  const marketplace = (req.query.marketplace || DEFAULT_MARKET).toLowerCase();
  const country     = (req.query.country || 'USA').toUpperCase();
  const period      = (req.query.period || 'thirty').toString();
  const categoryRaw = (req.query.category || 'Keyword').toString();

  const cat = categoryRaw.toLowerCase();
  const tabNameMap = {
    keyword:   'Keywords',
    keywords:  'Keywords',
    color:     'Colors',
    colors:    'Colors',
    product:   'Products',
    products:  'Products',
    recipient: 'Recipients',
    recipients:'Recipients',
    style:     'Styles',
    styles:    'Styles',
    material:  'Materials',
    materials: 'Materials'
  };
  const tabName = tabNameMap[cat] || 'Keywords';

  try {
    await ensureBrowser();
    const page = await context.newPage();
    await loginIfNeeded(page);

    await openAndWait(page, `${BASE}/trend-buzz`, `${BASE}/dashboard`);

    try {
      const periodMap = {
        thirty: /past\s*30\s*days/i,
        seven: /past\s*7\s*days/i,
        yesterday: /yesterday/i
      };
      const rx = periodMap[period.toLowerCase()];
      if (rx) {
        const btn = page.getByRole('button', { name: rx });
        if (await btn.first().isVisible().catch(() => false)) {
          await btn.first().click().catch(() => {});
          await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        }
      }
    } catch (e) {
      console.warn('trend-buzz period switch failed:', e.message || e);
    }

    let clicked = false;
    try {
      const tab = page.getByRole('tab', { name: new RegExp(`^${tabName}$`, 'i') });
      if (await tab.first().isVisible().catch(() => false)) {
        await tab.first().click().catch(() => {});
        clicked = true;
        await page.waitForTimeout(1500);
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      }
    } catch (e) {
      console.warn('trend-buzz tab click via role failed:', e.message || e);
    }

    if (!clicked) {
      const loc = page.locator(`text=${tabName}`);
      if (await loc.first().isVisible().catch(() => false)) {
        await loc.first().click().catch(() => {});
        await page.waitForTimeout(1500);
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      } else {
        console.warn('trend-buzz: no se encontró tab para', tabName);
      }
    }

    // Esperar a que haya filas reales en la tabla
    await page.waitForSelector('table tbody tr td', { timeout: 15000 }).catch(() => {});
    await autoScroll(page, 4);

    // 1) Intentar capturar JSON de /api/trend-buzz
    const cap = await captureJson(
      page,
      x =>
        x &&
        typeof x === 'object' &&
        (
          'term' in x ||
          'keyword' in x ||
          'name' in x ||
          'color' in x ||
          'product' in x ||
          'recipient' in x ||
          'style' in x ||
          'material' in x
        ),
      5000
    );

    let parsed = { count: 0, results: [] };

    if (cap.length) {
      parsed = parseTrendBuzzJSON(cap[0].json, tabName);
    }

    // 2) Fallback: si no hay JSON usable, parsear HTML
    if (!parsed || !parsed.results || !parsed.results.length) {
      const html = await page.content();
      parsed = parseTrendBuzzHTML(html);
    }

    await page.close();

    res.json({
      marketplace,
      country,
      period,
      category: tabName,
      count: parsed.count,
      results: parsed.results
    });

  } catch (e) {
    console.error('trend-buzz error:', e);
    res.status(500).json({ error: e.message || String(e) });
  }
});


/* ===========================
   MONTHLY TRENDS
   (captura XHR /api/trending-report desde la UI + fallback HTML)
=========================== */
app.get('/erank/monthly-trends', async (req, res) => {
  const marketplace = (req.query.marketplace || DEFAULT_MARKET).toLowerCase();
  const period      = (req.query.period || 'monthly').toString();
  const category    = (req.query.category || 'all').toString();
  const date        = (req.query.date || '').toString();      // YYYYMM
  const limitRaw    = parseInt(req.query.limit || '100', 10);
  const limit       = Math.max(1, Math.min(500, limitRaw || 100));

  if (!date) {
    return res.status(400).json({ error: 'Missing ?date=YYYYMM' });
  }

  try {
    await ensureBrowser();
    const page = await context.newPage();
    await loginIfNeeded(page);

    const uiUrl = new URL(`${BASE}/trending-report`);
    uiUrl.searchParams.set('category', category);
    uiUrl.searchParams.set('date', date);
    uiUrl.searchParams.set('limit', String(limit));
    uiUrl.searchParams.set('marketplace', marketplace);
    uiUrl.searchParams.set('period', period);

    await openAndWait(page, uiUrl.toString(), `${BASE}/dashboard`);
    await autoScroll(page, 3);

    const cap = await captureJson(
      page,
      x => x && typeof x === 'object' &&
           ('term' in x || 'keyword' in x || 'search_term' in x),
      5000
    );

    let parsed = { count: 0, results: [] };

    if (cap.length) {
      parsed = parseTrendingReportJSON(cap[0].json);
    }

    if (!parsed || !parsed.results || !parsed.results.length) {
      const html = await page.content();
      parsed = parseTrendingReportHTML(html);
    }

    await page.close();

    let results = parsed.results || [];
    if (results.length > limit) {
      results = results.slice(0, limit);
    }

    // Transformar resultados al formato tipo Thunderbit
    const thunderRows = results.map(r =>
      buildThunderStyleRow(r, { country: DEFAULT_COUNTRY })
    );

    res.json({
      marketplace,
      period,
      category,
      date,
      limit,
      count: thunderRows.length,
      results: thunderRows
    });

  } catch (e) {
    console.error('monthly-trends error:', e);
    res.status(500).json({ error: e.message || String(e) });
  }
});


/* ===========================
   MY SHOP (FULL)
=========================== */
app.get('/erank/my-shop', async (_req, res) => {
  try {
    const out = await withRetries(async () => {
      await ensureBrowser();
      const page = await context.newPage();
      await loginIfNeeded(page);

      const dedupeSimple = (arr) => {
        const s = new Set();
        return arr.filter(x => {
          const raw =
            typeof x === 'string'
              ? x
              : (x && (x.title || x.tag || '')) || '';
          const key = raw.toString().trim().toLowerCase();
          if (!key || s.has(key)) return false;
          s.add(key);
          return true;
        });
      };

      const extractSectionItems = ($, heading, { linkSelector, textSelector, max = 20 } = {}) => {
        const normalizedHeading = heading.toLowerCase();

        const headingNode = $('*')
          .filter((_, el) => ($(el).text() || '').trim().toLowerCase().startsWith(normalizedHeading))
          .first();
        if (!headingNode.length) return [];

        let container = headingNode.closest('section');
        if (!container.length) container = headingNode.parent();

        const items = [];

        if (linkSelector) {
          container.find(linkSelector).each((_, el) => {
            const t = ($(el).text() || '').trim();
            const href = $(el).attr('href') || '';
            if (t && !t.toLowerCase().startsWith(normalizedHeading)) {
              items.push({ title: t, href });
            }
          });
        } else if (textSelector) {
          container.find(textSelector).each((_, el) => {
            const t = ($(el).text() || '').trim();
            if (t && !t.toLowerCase().startsWith(normalizedHeading)) {
              items.push(t);
            }
          });
        }

        if (!items.length) return [];
        if (typeof items[0] === 'string') {
          return dedupeSimple(items).slice(0, max);
        }
        const seen = new Set();
        const out = [];
        for (const it of items) {
          const title = (it.title || '').toString();
          const href  = (it.href  || '').toString();
          const k = (title + '|' + href).trim();
          if (!k || seen.has(k)) continue;
          seen.add(k);
          out.push({ title, href });
          if (out.length >= max) break;
        }
        return out;
      };

      const getDashboard = async () => {
        await openAndWait(page, `${BASE}/dashboard`, `${BASE}/`);

        const html = await page.content();
        const $ = cheerio.load(html);

        const bodyText = $('body').text().replace(/\s+/g, ' ');

        const kpis = {};
        const getNumberAfter = (label) => {
          const re = new RegExp(label + '\\s*:?\\s*(\\d[\\d,]*)', 'i');
          const m = bodyText.match(re);
          return m ? m[1] : '';
        };

        kpis.sales          = getNumberAfter('Sales');
        kpis.activeListings = getNumberAfter('Active Listings');
        kpis.spottedOnEtsy  = getNumberAfter('Spotted on Etsy');

        const mRankES = bodyText.match(/Sales Rank\s*[A-Z]{2}\s*(\d[\d,]*)/i);
        kpis.salesRankES = mRankES ? mRankES[1] : '';

        const mGlobal = bodyText.match(/(\d[\d,]*)\s*globally/i);
        kpis.globalRank = mGlobal ? mGlobal[1] : '';

        const recentListings = extractSectionItems($, 'Recent Listings', {
          linkSelector: 'a[href*="/listing/"]',
          max: 20
        });

        return { kpis, recentListings };
      };

      const getTagsReport = async () => {
        const country = DEFAULT_COUNTRY;
        await openAndWait(page, `${BASE}/tags?country=${encodeURIComponent(country)}`, `${BASE}/dashboard`);
        await page.waitForTimeout(600);
        await autoScroll(page, 4);

        const cap = await captureJson(
          page,
          x => x && typeof x === 'object' && ('tag' in x),
          2500
        );

        let tags = [];
        for (const h of cap) {
          for (const arr of h.arrays) {
            for (const o of arr) {
              const tag = (o.tag || '').toString().trim();
              if (!tag) continue;
              const avgSearches = normVal(o.avg_searches ?? o.searches ?? '');
              const avgClicks   = normVal(o.avg_clicks ?? o.clicks ?? '');
              const avgCTR      = normVal(o.avg_ctr ?? o.ctr ?? '');
              const etsyComp    = normVal(o.etsy_competition ?? o.competition ?? '');
              const trend       = (o.search_trend || o.trend || '').toString();
              const gSearch     = normVal(o.google_searches ?? '');

              tags.push({
                tag,
                avgSearches,
                avgClicks,
                avgCTR,
                etsyCompetition: etsyComp,
                googleSearches: gSearch,
                searchTrend: trend
              });
            }
          }
        }

        const $html = cheerio.load(await page.content());

        if (!tags.length) {
          const tbl = tableByHeaders($html, [/^tag$/, /avg.*search|searches/, /competition|etsy/]);
          if (tbl) {
            const iTag  = tbl.header.findIndex(h => h === 'tag');
            const iSrch = tbl.header.findIndex(h => /avg.*search|searches/.test(h));
            const iComp = tbl.header.findIndex(h => /competition|etsy/.test(h));
            tags = tbl.rows.map(r => {
              const t = (r[iTag] || '').trim();
              if (!t) return null;
              const a = (iSrch >= 0 ? r[iSrch] : '').trim();
              const c = (iComp >= 0 ? r[iComp] : '').trim();
              return {
                tag: t,
                avgSearches: a,
                avgClicks: '',
                avgCTR: '',
                etsyCompetition: c,
                googleSearches: '',
                searchTrend: ''
              };
            }).filter(Boolean);
          }
        }

        tags = dedupeSimple(tags);
        const topTags  = tags.slice(0, 20).map(t => t.tag);
        const tagReport = tags;

        return { topTags, tagReport };
      };

      const getTrafficStats = async () => {
        await openAndWait(page, `${BASE}/traffic-stats/etsy`, `${BASE}/dashboard`);
        await page.waitForTimeout(800);
        await autoScroll(page, 4);

        const html = await page.content();
        const $ = cheerio.load(html);

        const tbl = tableByHeaders($, [
          /keyword.*listing/i,
          /visits/i
        ]);

        const rows = [];
        if (tbl) {
          const h = tbl.header;
          const iKW  = h.findIndex(x => /keyword.*listing/i.test(x));
          const iVis = h.findIndex(x => /visit/i.test(x));
          const iPos = h.findIndex(x => /position/i.test(x));
          const iSrc = h.findIndex(x => /traffic.*source|source/i.test(x));

          for (const r of tbl.rows) {
            const keywordOrListing = (iKW >= 0 ? r[iKW] : '').toString().trim();
            if (!keywordOrListing) continue;
            const visits   = (iVis >= 0 ? r[iVis] : '').toString().trim();
            const position = (iPos >= 0 ? r[iPos] : '').toString().trim();
            const source   = (iSrc >= 0 ? r[iSrc] : '').toString().trim();

            rows.push({
              keywordOrListing,
              visits,
              position,
              source
            });
          }
        }

        return {
          rows,
          topSources: [],
          topKeywords: [],
          topDevices: [],
          topCities: [],
          topCountries: []
        };
      };

      const getSpotted = async () => {
        await openAndWait(page, `${BASE}/spotted-on-etsy`, `${BASE}/dashboard`);
        await page.waitForTimeout(800);
        await autoScroll(page, 2);

        const html = await page.content();
        const $ = cheerio.load(html);

        const tbl = tableByHeaders($, [
          /shop.*listing/i,
          /search\s*term/i,
          /position/i
        ]);
        if (!tbl) return [];

        const h = tbl.header;
        const iShop = h.findIndex(x => /shop.*listing/i.test(x));
        const iTerm = h.findIndex(x => /search\s*term/i.test(x));
        const iPage = h.findIndex(x => /page/i.test(x));
        const iPos  = h.findIndex(x => /position/i.test(x));
        const iRank = h.findIndex(x => /rank/i.test(x));
        const iTs   = h.findIndex(x => /timestamp|date/i.test(x));
        const iBy   = h.findIndex(x => /spotted.*by|by/i.test(x));

        const out = [];
        for (const r of tbl.rows) {
          const shopListing = (iShop >= 0 ? r[iShop] : '').toString().trim();
          if (!shopListing) continue;
          const searchTerm  = (iTerm >= 0 ? r[iTerm] : '').toString().trim();
          const pageTxt     = (iPage >= 0 ? r[iPage] : '').toString().trim();
          const position    = (iPos  >= 0 ? r[iPos]  : '').toString().trim();
          const rank        = (iRank >= 0 ? r[iRank] : '').toString().trim();
          const timestamp   = (iTs   >= 0 ? r[iTs]   : '').toString().trim();
          const spottedBy   = (iBy   >= 0 ? r[iBy]   : '').toString().trim();

          out.push({
            listingId: '',
            title: shopListing,
            searchTerm,
            page: pageTxt,
            position,
            number: rank,
            timestamp,
            spottedBy
          });
        }

        return out;
      };

      const getSpellCheck = async () => {
        await openAndWait(page, `${BASE}/spell-checker`, `${BASE}/dashboard`);
        await page.waitForTimeout(800);

        const html = await page.content();
        const $ = cheerio.load(html);

        const tbl = tableByHeaders($, [/tag/i, /suggest/i, /listing/i]);
        if (!tbl) return [];

        const iWrong = tbl.header.findIndex(h => /tag|keyword/i.test(h));
        const iSugg  = tbl.header.findIndex(h => /suggest/i.test(h));
        const iList  = tbl.header.findIndex(h => /listing/i.test(h));

        const issues = tbl.rows.map(r => {
          const wrong      = iWrong >= 0 ? (r[iWrong] || '').toString().trim() : '';
          const suggsText  = iSugg  >= 0 ? (r[iSugg]  || '').toString().trim() : '';
          const listingsText = iList >= 0 ? (r[iList] || '').toString().trim() : '';

          const suggestions = suggsText
            ? suggsText.split(/[,;]/).map(s => s.trim()).filter(Boolean)
            : [];

          const listings = listingsText
            ? listingsText.split(/[,;]/).map(s => {
                const clean = s.toString().trim();
                return {
                  listingId: '',
                  title: clean
                };
              }).filter(Boolean)
            : [];

          return {
            wrongTag: wrong,
            suggestions,
            listings
          };
        });

        return issues;
      };

      const { kpis, recentListings } = await getDashboard();
      const { topTags, tagReport }   = await getTagsReport();
      const trafficStats             = await getTrafficStats();
      const spottedOnEtsy            = await getSpotted();
      const spellingIssues           = await getSpellCheck();

      const products                 = spottedOnEtsy;

      await page.close();

      return {
        kpis,
        topTags,
        trafficStats,
        spottedOnEtsy,
        recentListings,
        spellingIssues,
        products,
        tagReport
      };
    }, 'my-shop-full');

    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});


/* ===========================
   DEBUG screenshots
=========================== */
app.get('/debug/keywords-screenshot', async (req,res)=>{
  const q=(req.query.q||'').toString().trim();
  const country=(req.query.country||DEFAULT_COUNTRY).toUpperCase();
  const market =(req.query.marketplace||DEFAULT_MARKET).toLowerCase();
  if(!q) return res.status(400).send('Falta ?q=');
  try{
    await ensureBrowser();
    const pg=await context.newPage();
    await loginIfNeeded(pg);
    await openAndWait(pg, `${BASE}/keyword-tool`, `${BASE}/`);
    await ensureMarketplaceCountry(pg, market, country);
    await typeAndSearch(pg, q);
    await openTab(pg, 'Keyword Ideas');
    await pg.waitForTimeout(1200);
    const buf=await pg.screenshot({ fullPage:true });
    await pg.close();
    res.set('content-type','image/png').send(buf);
  }catch(e){
    res.status(500).send(e.message);
  }
});

app.get('/debug/toplist-screenshot', async (req,res)=>{
  const q=(req.query.q||'').toString().trim();
  const country=(req.query.country||DEFAULT_COUNTRY).toUpperCase();
  const market =(req.query.marketplace||DEFAULT_MARKET).toLowerCase();
  if(!q) return res.status(400).send('Falta ?q=');
  try{
    await ensureBrowser();
    const pg=await context.newPage();
    await loginIfNeeded(pg);
    await openAndWait(pg, `${BASE}/keyword-tool`, `${BASE}/`);
    await ensureMarketplaceCountry(pg, market, country);
    await typeAndSearch(pg, q);
    await openTab(pg, 'Top Listings');
    await pg.waitForTimeout(1200);
    const buf=await pg.screenshot({fullPage:true});
    await pg.close();
    res.set('content-type','image/png').send(buf);
  }catch(e){
    res.status(500).send(e.message);
  }
});


/* ===========================
   START
=========================== */
app.listen(port, ()=> 
  console.log(`[eRank] API listening on :${port} (stealth=${STEALTH_ON}, retries=${MAX_RETRIES})`)
);

