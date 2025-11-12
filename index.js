// index.js — eRank PRO scraper FINAL (Top N logic + country)
// Express + Playwright + Cheerio + Stealth + XHR capture + Normalizers + Debug

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

// Stealth
const STEALTH_ON     = (process.env.STEALTH_ON || '1') !== '0';
const STEALTH_MIN_MS = parseInt(process.env.STEALTH_MIN_MS || '700', 10);
const STEALTH_MAX_MS = parseInt(process.env.STEALTH_MAX_MS || '1400', 10);
const MAX_RETRIES    = parseInt(process.env.MAX_RETRIES    || '3', 10);
const RECYCLE_AFTER  = parseInt(process.env.RECYCLE_AFTER  || '6', 10);

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
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pick  = (arr) => arr[Math.floor(Math.random() * arr.length)];
const jitter = async () => { if (STEALTH_ON) await sleep(rand(STEALTH_MIN_MS, STEALTH_MAX_MS)); };

function toInt(x) {
  if (x === null || x === undefined) return 0;
  if (typeof x === 'number') return x;
  if (typeof x === 'string') {
    // quita comas, < 20 -> 20 aprox
    const s = x.replace(/[^\d]/g, '');
    return s ? parseInt(s, 10) : 0;
  }
  return 0;
}
function parseScore(volume, competition) {
  const v = Math.max(0, toInt(volume));
  const c = Math.max(0, toInt(competition));
  return v / (c + 1);
}

// ---------- Browser ----------
async function recycleContext(reason = 'stale') {
  try { if (context) await context.close().catch(()=>{}); } catch {}
  try { if (browser)  await browser.close().catch(()=>{}); } catch {}
  browser = null; context = null; consecutiveErrors = 0;
  console.warn('[recycle] due to:', reason);
}

async function ensureBrowser() {
  if (browser && context) return;
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-dev-shm-usage'] });

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

  if (ERANK_COOKIES) {
    const parsed = ERANK_COOKIES.split(';').map(s=>s.trim()).filter(Boolean).map(pair=>{
      const i=pair.indexOf('='); if(i<=0) return null;
      return { name:pair.slice(0,i).trim(), value:pair.slice(i+1).trim(), path:'/', secure:true, httpOnly:false };
    }).filter(Boolean);
    const both = [];
    for (const c of parsed) {
      both.push({ ...c, domain:'members.erank.com', sameSite:'None' });
      both.push({ ...c, domain:'.erank.com',        sameSite:'None' });
    }
    try { await context.addCookies(both); } catch(e){ console.error('addCookies:', e.message); }
  }
}

async function saveStorage() {
  try { if (context) await context.storageState({ path: STORAGE }); } catch {}
}

async function openAndEnsure(page, url, referer) {
  if (referer) try { await page.setExtraHTTPHeaders({ referer }); } catch {}
  await jitter();
  const resp = await page.goto(url, { waitUntil:'domcontentloaded', timeout:60000 });
  await page.waitForLoadState('networkidle', { timeout:60000 }).catch(()=>{});
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
  if (ERANK_COOKIES) { await page.reload({waitUntil:'domcontentloaded'}).catch(()=>{}); await jitter(); if (await isLoggedIn(page)) { await saveStorage(); return true; } }
  if (!ERANK_EMAIL || !ERANK_PASSWORD) throw new Error('No valid session and ERANK_EMAIL/ERANK_PASSWORD not configured.');

  await openAndEnsure(page, `${BASE}/login`, `${BASE}/dashboard`);
  try {
    await page.evaluate(async (email, pass) => {
      const token = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';
      const headers = { 'Content-Type':'application/json' };
      if (token) headers['X-CSRF-TOKEN'] = token;
      await fetch('/login', { method:'POST', headers, body: JSON.stringify({email, password: pass}) });
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
  if (!(await isLoggedIn(page))) throw new Error('Login failed — check credentials/cookies.');
  await saveStorage();
  return true;
}
async function withRetries(taskFn, label='task') {
  let lastErr;
  for (let a=1; a<=MAX_RETRIES; a++) {
    try { const out = await taskFn(); consecutiveErrors=0; return out; }
    catch(e){ lastErr=e; consecutiveErrors++; await sleep(rand(700,2000)*a); if(consecutiveErrors>=RECYCLE_AFTER){ await recycleContext(`too many errors (${consecutiveErrors})`); await ensureBrowser(); } }
  }
  throw lastErr;
}

// ---------- Helpers captura XHR / normalizadores ----------
function findArraysDeep(obj, pred, acc=[]) {
  if (!obj || typeof obj!=='object') return acc;
  if (Array.isArray(obj) && obj.some(pred)) acc.push(obj);
  for (const k of Object.keys(obj)) findArraysDeep(obj[k], pred, acc);
  return acc;
}
async function captureJson(page, pred, timeMs=3000) {
  const bucket=[]; const handler = async (r)=>{
    try{
      const ct=(r.headers()['content-type']||'').toLowerCase();
      if(!ct.includes('application/json')) return;
      const txt=await r.text();
      const json=JSON.parse(txt);
      const arrays=findArraysDeep(json, pred);
      if (arrays.length) bucket.push({ json, arrays });
    }catch{}
  };
  page.on('response', handler);
  await page.waitForTimeout(timeMs);
  page.off('response', handler);
  return bucket;
}
function normalizeValue(v) {
  if (v===null||v===undefined) return '';
  if (typeof v==='number') return String(v);
  if (typeof v==='string') return v;
  if (typeof v==='object') {
    const prefer=['avg_searches','searches','volume','value','count','score','total','avg'];
    for (const k of prefer){ if(v[k]!=null){ const x=v[k]; if(typeof x==='number')return String(x); if(typeof x==='string')return x; } }
    for (const [,x] of Object.entries(v)){ if(typeof x==='number')return String(x); if(typeof x==='string')return x; }
    try{return JSON.stringify(v);}catch{return String(v);}
  }
  return String(v);
}
function normalizeKeyword(o) {
  const kw=(o?.keyword ?? o?.term ?? o?.query ?? '').toString().trim();
  const volume = normalizeValue(o?.volume ?? o?.searches ?? o?.avg_searches ?? o?.metrics);
  const competition = normalizeValue(o?.competition ?? o?.etsy_competition ?? o?.comp ?? '');
  if (!kw) return null;
  const score = parseScore(volume, competition);
  return { keyword: kw, volume, competition, score };
}
function normalizeListing(o) {
  const base=o||{};
  let id    = base.listing_id ?? base.id ?? base?.listing?.id ?? base?.listing?.listing_id ?? '';
  let title = (base.title ?? base.name ?? base?.listing?.title ?? base?.listing?.name ?? '').toString().trim();
  let href  = (base.url ?? base.link ?? base.permalink ?? base?.listing?.url ?? base?.listing?.link ?? '').toString().trim();
  const shop_id   = base.shop_id ?? base?.shop?.id ?? base?.seller_id ?? '';
  const shop_name = (base.shop_name ?? base?.shop?.name ?? base?.seller_name ?? '').toString().trim();
  if (!id && href){ const m=href.match(/\/listing\/(\d+)/i); if(m) id=m[1]; }
  if (!href && id) href=`https://www.etsy.com/listing/${id}`;
  return (id||href||title) ? { listing_id:id, title, href, shop_id, shop_name } : null;
}

// ---------- Parsers HTML fallback ----------
function htmlStats(html){ return { htmlLength: html?.length || 0, totalKeywords: (html?.match(/keyword/gi)||[]).length }; }
function getInertiaPageJSON($){ const node=$('[data-page]').first(); if(!node.length) return null; const raw=node.attr('data-page'); if(!raw) return null; try{return JSON.parse(raw);}catch{return null;} }
function tableByHeaders($, headerMatchers=[]) {
  const tables=[]; $('table').each((_,t)=>{ const $t=$(t); const header=[]; $t.find('thead tr th, tr th').each((__,th)=>header.push($(th).text().trim().toLowerCase())); if(!header.length)return;
    const ok=headerMatchers.every(rx=>header.some(h=>rx.test(h))); if(!ok)return;
    const rows=[]; $t.find('tbody tr, tr').each((i,tr)=>{ const tds=$(tr).find('td'); if(!tds.length)return; rows.push(tds.map((__,td)=>$(td).text().trim()).get());});
    if(rows.length) tables.push({header,rows});
  }); return tables[0]||null;
}
function parseKeywords(html){
  const $=cheerio.load(html);
  const tbl=tableByHeaders($,[/^keyword$/, /volume|avg.*search|searches/]);
  if (tbl){ const k=tbl.header.findIndex(h=>/keyword/.test(h)), v=tbl.header.findIndex(h=>/(volume|avg.*search|searches)/.test(h));
    const results=tbl.rows.map(r=>({keyword:(r[k]||'').trim(), volume:(r[v]||'').trim(), competition:'', score:parseScore(r[v], '')})).filter(x=>x.keyword);
    return {count:results.length, results, ...htmlStats(html)}; }
  const page=getInertiaPageJSON($);
  if (page){ const arrays=findArraysDeep(page,o=>o&&typeof o==='object'&&('keyword'in o||'term'in o));
    for (const arr of arrays){ const results=arr.map(normalizeKeyword).filter(Boolean); if(results.length) return {count:results.length, results, ...htmlStats(html)}; } }
  return {count:0, results:[], ...htmlStats(html)};
}
function parseTopListings(html){
  const $=cheerio.load(html), items=[];
  $('a[href*="/listing/"]').each((_,a)=>{ const href=$(a).attr('href')||''; const title=$(a).attr('title')||$(a).text().trim(); if(href||title) items.push({ listing_id:'', title, href});});
  $('[data-listing-id]').each((_,el)=>{ const id=$(el).attr('data-listing-id'); const title=$(el).text().trim(); if(id||title) items.push({ listing_id:id, title, href:''});});
  return {count:items.length, results:items, ...htmlStats(html)};
}

// ---------- Acciones de UI ----------
async function ensureMarketplaceCountry(page, marketplace, country) {
  const mpBtn = page.getByRole('button',{name:/marketplace/i}).or(page.getByRole('combobox').nth(0));
  if (await mpBtn.isVisible().catch(()=>false)) { await mpBtn.click().catch(()=>{}); await page.getByRole('option',{name:new RegExp(`^${marketplace}$`,'i')}).click().catch(()=>{}); }
  const cBtn = page.getByRole('button',{name:/country/i}).or(page.getByRole('combobox').nth(1));
  if (await cBtn.isVisible().catch(()=>false)) { await cBtn.click().catch(()=>{}); await page.getByRole('option',{name:new RegExp(`^${country}$`,'i')}).click().catch(()=>{}); }
}
async function typeAndSearch(page, q) {
  try{
    const inputSelector='input[placeholder="Enter keywords, separated by comma"]';
    await page.waitForSelector(inputSelector,{timeout:20000});
    const input=await page.$(inputSelector); if(!input) throw new Error('No input');
    await input.click({clickCount:3}).catch(()=>{}); await input.fill(''); await input.type(q,{delay:35});
    await page.evaluate(sel=>{ const el=document.querySelector(sel); if(el){ el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));}}, inputSelector);
    await input.press('Enter').catch(()=>{});
    await page.waitForSelector('table tbody tr td, [data-listing-id], [data-keyword], .ant-empty',{timeout:20000}).catch(()=>{});
  }catch(e){ console.error('typeAndSearch failed:', e.message); }
}
async function autoScroll(page, steps=4){ for(let i=0;i<steps;i++){ await page.evaluate(()=>window.scrollBy(0, window.innerHeight*0.85)); await sleep(250);} }

// ---------- Middlewares ----------
app.use((req, _res, next) => { if (req.url.includes('//')) req.url = req.url.replace(/\/{2,}/g,'/'); next(); });
app.use(async (_req,_res,next)=>{ await jitter(); next(); });

// ---------- Health / Debug ----------
app.get('/healthz', (_req,res)=>res.json({ok:true,service:'erank-scraper',stealth:STEALTH_ON}));
app.get('/erank/healthz', (_req,res)=>res.json({ok:true,alias:'erank/healthz',stealth:STEALTH_ON}));
app.get('/debug/cookies', async (_req,res)=>{ try{ await ensureBrowser(); const ck=await context.cookies('https://members.erank.com'); res.json({count:ck.length, cookies:ck.map(c=>({name:c.name,domain:c.domain}))}); }catch(e){ res.status(500).json({error:e.message}); }});
app.get('/erank/raw', async (req,res)=>{ const p=(req.query.path||'/dashboard').toString(); try{ await ensureBrowser(); const page=await context.newPage(); await loginIfNeeded(page); await openAndEnsure(page, `${BASE}${p.startsWith('/')?'':'/'}${p}`, pick(REFERERS)); const html=await page.content(); await page.close(); res.set('content-type','text/html; charset=utf-8').send(html);}catch(e){ res.status(500).json({error:e.message}); }});

// ---------- KEYWORDS (Top N) ----------
app.get('/erank/keywords', async (req,res)=>{
  const q=(req.query.q||'').toString().trim();
  const limit = parseInt(req.query.limit||'30',10);
  const country=(req.query.country||DEFAULT_COUNTRY).toUpperCase();
  const marketplace=(req.query.marketplace||DEFAULT_MARKET).toLowerCase();
  if(!q) return res.status(400).json({error:'Missing ?q='});
  try{
    const out = await withRetries(async ()=>{
      await ensureBrowser();
      const page=await context.newPage(); await loginIfNeeded(page);
      await openAndEnsure(page, `${BASE}/keyword-tool`, `${BASE}/dashboard`);
      await ensureMarketplaceCountry(page, marketplace, country);
      await typeAndSearch(page, q);

      // espera XHR explícitas
      for (let i=0;i<2;i++) {
        await page.waitForResponse(r => /keyword|search|inertia/i.test(r.url()) && r.status()===200, {timeout:5000}).catch(()=>{});
      }

      const cap=await captureJson(page, x=>x && typeof x==='object' && ('keyword' in x || 'term' in x), 4500);
      await autoScroll(page, 4);

      let results=[];
      for (const hit of cap) for (const arr of hit.arrays) for (const o of arr){
        const norm=normalizeKeyword(o); if(norm) results.push(norm);
      }

      if (!results.length){
        await page.waitForSelector('table tbody tr td, [data-keyword]',{timeout:4000}).catch(()=>{});
        // fallback DOM/HTML
        const domFallback = []; // tratar DOM con cheerio si quieres, usamos parseKeywords:
        const html = await page.content();
        const parsed = parseKeywords(html).results;
        for (const r of parsed) results.push({keyword:r.keyword, volume:r.volume, competition:'', score:parseScore(r.volume,'')});
      }
      await page.close();

      // ranking: volumen alto / competencia baja → score alto
      results.forEach(r=> r.score = parseScore(r.volume, r.competition||''));
      results = results
        .filter(r=>r.keyword)
        .sort((a,b)=> b.score - a.score || toInt(b.volume) - toInt(a.volume))
        .slice(0, Math.max(1, Math.min(200, limit)));

      return { query:q, country, marketplace, count:results.length, results };
    }, 'keywords-top');
    res.json(out);
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ---------- TOP LISTINGS (Top N productos) ----------
app.get('/erank/top-listings', async (req,res)=>{
  const q=(req.query.q||'').toString().trim();
  const limit = parseInt(req.query.limit||'20',10);
  const country=(req.query.country||DEFAULT_COUNTRY).toUpperCase();
  const marketplace=(req.query.marketplace||DEFAULT_MARKET).toLowerCase();
  if(!q) return res.status(400).json({error:'Missing ?q='});
  try{
    const out=await withRetries(async ()=>{
      await ensureBrowser();
      const page=await context.newPage(); await loginIfNeeded(page);
      await openAndEnsure(page, `${BASE}/keyword-tool`, `${BASE}/dashboard`);
      await ensureMarketplaceCountry(page, marketplace, country);
      await typeAndSearch(page, q);

      const tab=page.getByRole('tab',{name:/top listings/i});
      if(await tab.isVisible().catch(()=>false)){ await tab.click().catch(()=>{}); await page.waitForLoadState('networkidle',{timeout:30000}).catch(()=>{}); }
      else { await page.locator('text=Top Listings').first().click().catch(()=>{}); await page.waitForLoadState('networkidle',{timeout:30000}).catch(()=>{}); }

      // opcional: load more
      const moreBtn = page.locator('button:has-text("Load more"), button:has-text("Show more")').first();
      if (await moreBtn.isVisible().catch(()=>false)) { await moreBtn.click().catch(()=>{}); await page.waitForLoadState('networkidle',{timeout:15000}).catch(()=>{}); }

      const cap=await captureJson(page, x=>x && typeof x==='object' && ('listing_id'in x || 'title'in x || 'url' in x), 5000);
      await autoScroll(page, 6);

      let results=[];
      for (const hit of cap) for (const arr of hit.arrays) for (const o of arr){
        const norm=normalizeListing(o); if(norm) results.push(norm);
      }

      if (!results.length){
        const html=await page.content();
        results = parseTopListings(html).results.map(r=>normalizeListing(r)).filter(Boolean);
      }

      results = results
        .filter(r=>r && (r.listing_id || r.href))
        .filter((r,i,a)=> a.findIndex(x=>(x.listing_id||'')===(r.listing_id||'') && (x.href||'')===(r.href||''))===i)
        .slice(0, Math.max(1, Math.min(200, limit)));

      await page.close();
      return { query:q, country, marketplace, count:results.length, results };
    }, 'top-listings');
    res.json(out);
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ---------- TAGS (Top N) ----------
app.get('/erank/tags', async (req,res)=>{
  const country=(req.query.country||DEFAULT_COUNTRY).toUpperCase();
  const marketplace=(req.query.marketplace||DEFAULT_MARKET).toLowerCase();
  const limit = parseInt(req.query.limit||'15',10);
  try{
    await ensureBrowser();
    const page=await context.newPage(); await loginIfNeeded(page);
    await openAndEnsure(page, `${BASE}/tags?country=${country}`, `${BASE}/dashboard`);
    await page.waitForTimeout(600);
    await autoScroll(page, 8);

    const cap=await captureJson(page, x=>x && typeof x==='object' && ('tag' in x), 2500);
    let rows=[];
    for (const hit of cap) for (const arr of hit.arrays) for (const o of arr){
      const tag=(o.tag||'').toString().trim(); if(!tag) continue;
      const avg_searches = normalizeValue(o.avg_searches ?? o.searches ?? '');
      const etsy_competition = normalizeValue(o.etsy_competition ?? o.competition ?? '');
      const score = parseScore(avg_searches, etsy_competition);
      rows.push({ tag, avg_searches, etsy_competition, score });
    }

    if (!rows.length){
      // DOM
      const dom = await page.evaluate(()=>{
        const out=[]; const t=document.querySelector('table'); if(!t) return out;
        const headers=Array.from(t.querySelectorAll('thead th, tr th')).map(th=>th.textContent.trim().toLowerCase());
        const idx = {
          tag:  headers.findIndex(h=>h==='tag'),
          avgS: headers.findIndex(h=>h.includes('search')),
          comp: headers.findIndex(h=>h.includes('competition')||h.includes('etsy'))
        };
        Array.from(t.querySelectorAll('tbody tr, tr')).forEach(tr=>{
          const td=Array.from(tr.querySelectorAll('td')).map(x=>x.textContent.trim());
          if(!td.length) return;
          const tag = idx.tag>=0? td[idx.tag]:''; if(!tag) return;
          const avg_searches = idx.avgS>=0? td[idx.avgS]:'';
          const etsy_competition = idx.comp>=0? td[idx.comp]:'';
          out.push({tag, avg_searches, etsy_competition});
        }); return out;
      });
      rows = dom.map(r=>({...r, score:parseScore(r.avg_searches, r.etsy_competition)}));
      if (!rows.length){
        const html=await page.content();
        const $=cheerio.load(html);
        const tbl=tableByHeaders($,[/^tag$/, /avg.*search|searches/, /competition|etsy/]);
        if (tbl){
          const idx={ tag:tbl.header.findIndex(h=>/^tag$/.test(h)), avgS:tbl.header.findIndex(h=>/(avg.*search|searches)/.test(h)), comp:tbl.header.findIndex(h=>/(competition|etsy)/.test(h)) };
          rows = tbl.rows.map(r=>{
            const tag=r[idx.tag]||'';
            const avg_searches=r[idx.avgS]||'';
            const etsy_competition=r[idx.comp]||'';
            return tag? {tag, avg_searches, etsy_competition, score:parseScore(avg_searches, etsy_competition)} : null;
          }).filter(Boolean);
        }
      }
    }

    await page.close();
    rows = rows
      .sort((a,b)=> b.score - a.score || toInt(b.avg_searches)-toInt(a.avg_searches))
      .slice(0, Math.max(1, Math.min(200, limit)));

    res.json({ country, marketplace, count:rows.length, results:rows });
  }catch(e){ console.error('tags error:', e); res.status(500).json({error:e.message}); }
});

// ---------- My Shop / Stats / Otros ----------
app.get('/erank/stats', async (_req,res)=>{
  try{ await ensureBrowser(); const page=await context.newPage(); await loginIfNeeded(page);
    await openAndEnsure(page, `${BASE}/dashboard`, pick(REFERERS)); const html=await page.content(); await page.close();
    res.json({ ok:true, ...htmlStats(html) });
  }catch(e){ res.status(500).json({error:e.message}); }
});
app.get('/erank/my-shop', async (_req,res)=>{
  try{ await ensureBrowser(); const page=await context.newPage(); await loginIfNeeded(page);
    await openAndEnsure(page, `${BASE}/dashboard`, pick(REFERERS));
    const html=await page.content();
    const $=cheerio.load(html); const stats={};
    $('[class*="stat"], [class*="metric"]').each((_,el)=>{ const t=$(el).text().trim().replace(/\s+/g,' '); if(!t) return; const p=t.split(':'); if(p.length>=2) stats[p[0].trim()]=p.slice(1).join(':').trim();});
    await page.close();
    res.json({ stats, ...htmlStats(html) });
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ---------- Debug screenshots ----------
app.get('/debug/keywords-screenshot', async (req,res)=>{
  const q=(req.query.q||'').toString().trim();
  const country=(req.query.country||DEFAULT_COUNTRY).toUpperCase();
  const marketplace=(req.query.marketplace||DEFAULT_MARKET).toLowerCase();
  if(!q) return res.status(400).json({error:'Falta ?q='});
  try{ await ensureBrowser(); const page=await context.newPage(); await loginIfNeeded(page);
    await openAndEnsure(page, `${BASE}/keyword-tool`, `${BASE}/dashboard`);
    await ensureMarketplaceCountry(page, marketplace, country);
    await typeAndSearch(page, q); await sleep(1000);
    const buf=await page.screenshot({fullPage:true}); await page.close();
    res.set('content-type','image/png').send(buf);
  }catch(e){ res.status(500).json({error:e.message}); }
});
app.get('/debug/toplist-screenshot', async (req,res)=>{
  const q=(req.query.q||'').toString().trim();
  const country=(req.query.country||DEFAULT_COUNTRY).toUpperCase();
  const marketplace=(req.query.marketplace||DEFAULT_MARKET).toLowerCase();
  if(!q) return res.status(400).json({error:'Falta ?q='});
  try{ await ensureBrowser(); const page=await context.newPage(); await loginIfNeeded(page);
    await openAndEnsure(page, `${BASE}/keyword-tool`, `${BASE}/dashboard`);
    await ensureMarketplaceCountry(page, marketplace, country);
    await typeAndSearch(page, q);
    const tab=page.getByRole('tab',{name:/top listings/i});
    if(await tab.isVisible().catch(()=>false)){ await tab.click().catch(()=>{}); await page.waitForLoadState('networkidle',{timeout:30000}).catch(()=>{}); }
    else { await page.locator('text=Top Listings').first().click().catch(()=>{}); await page.waitForLoadState('networkidle',{timeout:30000}).catch(()=>{}); }
    await sleep(1000);
    const buf=await page.screenshot({fullPage:true}); await page.close();
    res.set('content-type','image/png').send(buf);
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ---------- Start ----------
app.listen(port, ()=> console.log(`[eRank] API listening on :${port} (stealth=${STEALTH_ON}, retries=${MAX_RETRIES})`));
