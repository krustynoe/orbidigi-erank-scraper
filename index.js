// index.js — eRank Keyword Tool via Playwright + CSRF/XSRF aware in-page fetch
// No usa axios ni ZenRows. Requiere: "playwright": "1.56.1"

globalThis.File = globalThis.File || class File {};

const express = require('express');
const { chromium } = require('playwright');
const cheerio = require('cheerio');

const app  = new (require('express'))();
const port = process.env.PORT || 3000;

const EMAIL = (process.env.ERANK_EMAIL || '').trim();
const PASS  = (process.env.ERANK_PASSWORD || '').trim();
const UA    = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

let browser;
let page;
let lastLoginAt = 0;

// ---- login via UI (robusto con Sanctum) ----
async function ensureLoggedIn(force=false){
  const fresh = Date.now()-lastLoginAt < 20*60*1000;
  if(!force && page && fresh) return page;

  if(!browser) {
    browser = await chromium.launch({ headless:true, args:['--no-sandbox','--disable-dev-shm-usage'] });
  }
  if (page) { try { await page.close(); } catch(_){} }
  const ctx = await browser.newContext({ userAgent: UA });
  page = await ctx.newPage();

  await page.goto('https://members.erank.com/login', { waitUntil:'domcontentloaded', timeout:120000 });
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASS);
  const btn = await page.$('button[type="submit"],button:has-text("Sign in"),button:has-text("Login")');
  if (btn) await btn.click(); else await page.keyboard.press('Enter');
  await page.waitForLoadState('networkidle', { timeout:120000 });

  // en algunos tenants aterriza en /; forzamos keyword-tool para tener contexto
  if (!/members\.erank\.com\/(keyword\-tool|dashboard)/.test(page.url())) {
    await page.goto('https://members.erank.com/keyword-tool', { waitUntil:'domcontentloaded', timeout:120000 });
  }
  lastLoginAt = Date.now();
  return page;
}

// ---- in-page JSON fetch con XSRF/CSRF e Inertia ----
async function inPageJson(pathname, query, referer='keyword-tool'){
  const p = await ensureLoggedIn(false);
  if(!p.url().includes('/'+referer)) {
    await p.goto(`https://members.erank.com/${referer}`, { waitUntil:'domcontentloaded', timeout:120000 });
  }
  const qs = new URLSearchParams(query||{}).toString();
  const url = `https://members.erank.com/${pathname}${qs?`?${qs}`:''}`;

  // extrae tokens desde el DOM y usa fetch dentro de la página (mismas cookies)
  const resp = await p.evaluate(async (href) => {
    const xsrf = (document.cookie.split(';').map(s=>s.trim()).find(s=>s.startsWith('XSRF-TOKEN='))||'').split('=')[1]||'';
    const csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
    try{
      const r = await fetch(href, {
        method:'GET',
        headers:{
          'Accept':'application/json',
          'X-Requested-With':'XMLHttpRequest',
          'X-Inertia':'true',
          'X-XSRF-TOKEN': decodeURIComponent(xsense?xsense:xsrf),
          'X-CSRF-TOKEN': csrf
        },
        credentials:'same-origin'
      });
      const ct = r.headers.get('Content-Type')||'';
      const ok = r.ok && ct.includes('application/json');
      const body = ok ? await r.json() : await r.text();
      return { ok, status:r.status, body };
    }catch(e){ return { ok:false, status:0, body:String(e) }; }
  }, url);

  if(!resp.ok){
    throw new Error(`inPageJson ${pathname} -> ${resp.status} ${String(resp.body).slice(0,200)}`);
  }
  return { url, data: resp.body };
}

// ---- DOM fallback si el JSON viene vacío ----
function parseKeywordsFromHtml(html){
  const $ = cheerio.load(html);
  const out = new Set();
  $('table tbody tr').each((_, tr)=> {
    const t = $(tr).find('td').first().text().trim();
    if (t) out.add(t);
  });
  $('[class*=chip],[class*=tag],[data-testid*=keyword]').each((_, el)=>{
    const t = $(el).text().trim(); if (t) out.add(t);
  });
  return Array.from(out);
}

// ---- endpoints ----
app.get('/healthz', (_req,res)=>res.json({ ok:true }));
app.get('/erank/healthz', (_req,res)=>res.json({ ok:true }));

app.get('/erank/keywords', async (req,res)=>{
  try{
    const q = String(req.query.q||'planner');
    const country = String(req.query.country||'USA');
    const marketplace = String(req.query.marketplace||'etsy');
    const { url, data } = await inPageJson('related-searches', { keyword:q, country, marketplace }, 'keyword-tool');
    let arr = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
    let results = arr.map(x => (x && (x.keyword||x.name||x.title||x.term||x.text)||'').toString().trim()).filter(Boolean);
    if(!results.length){
      const p = await ensureLoggedIn(false);
      await p.goto(`https://members.erank.com/keyword-tool?country=${encodeURIComponent(country)}&source=${encodeURIComponent(marketplace)}&keyword=${encodeURIComponent(q)}`, { waitUntil:'networkidle', timeout:240000 });
      const html = await p.content();
      results = parseKeywordsFromHtml(html).filter(s => s.toLowerCase().includes(q.toLowerCase()));
      return res.json({ source:p.url(), query:q, count:results.length, results:results.slice(0,100) });
    }
    const filtered = q ? results.filter(s=>s.toLowerCase().includes(q.toLowerCase())) : results;
    res.json({ source:url, query:q, count:filtered.length, results:filtered.slice(0,100) });
  }catch(e){ res.status(502).json({ error:String(e.message||e) }); }
});

app.get('/erank/stats', async (req,res)=>{
  try{
    const q = String(req.query.q||'planner');
    const country = String(req.query.country||'USA');
    const marketplace = String(req.query.marketplace||'etsy');
    const { url, data } = await inPageJson('stats', { keyword:q, country, marketplace }, 'keyword-tool');
    res.json({ source:url, query:q, stats:data });
  }catch(e){ res.status(502).json({ error:String(e.message||e) }); }
});

app.get('/erank/top-listings', async (req,res)=>{
  try{
    const q = String(req.query.q||'planner');
    const country = String(req.query.country||'USA');
    const marketplace = String(req.query.marketplace||'etsy');
    const { url, data } = await inPageJson('top-listings', { keyword:q, country, marketplace }, 'keyword=planner' );
    const rows = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
    const items = rows.map(r=>({
      title: String(r?.title||r?.name||'').trim(),
      url:   String(r?.url||r?.link||'').trim(),
      price: r?.price||'',
      shop:  r?.shop||''
    })).filter(x=>x.title || x.url);
    res.json({ source:url, query:q, count:items.length, items });
  }catch(e){ res.status(502).json({ error:String(e.message||e) }); }
});

app.get('/erank/near-matches', async (req,res)=>{
  try{
    const q = String(req.query.q||'planner');
    const country = String(req.query.country||'USA');
    const marketplace = String(req.query.marketplace||'etsy');
    const { url, data } = await inPageJson('near-matches', { keyword:q, country, marketplace }, 'keyword-tool');
    const arr = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
    const results = arr.map(o => (o && (o.keyword||o.name||o.title||o.term||o.text)||'').toString().trim()).filter(Boolean);
    res.json({ source:url, query:q, count:results.length, results });
  }catch(e){ res.status(502).json({ error:String(e.message||e) }); }
});

app.get('/erank/raw', async (req,res)=>{
  try{
    const q = String(req.query.q||'planner');
    const country = String(req.query.country||'USA');
    const marketplace = String(req.query.country||'USA');
    const p = await ensureLoggedIn(false);
    await p.goto(`https://members.erank.com/keyword-tool?country=${encodeURIComponent(country)}&source=${encodeURIComponent(marketplace)}&keyword=${encodeURIComponent(q)}`, { waitUntil:'networkidle', timeout:240000 });
    const html = await p.content();
    res.json({ url:p.url(), ok:!!html, length: html? html.length:0, preview: (html||'').slice(0,2000) });
  }catch(e){ res.status(502).json({ error:String(e.message||e) }); }
});

app.get('/', (_req,res)=>res.json({ ok:true, routes:['/erank/healthz','/erank/keywords','/erank/stats','/erank/top-listings','/erank/near-matches','/erank/raw'] }));

app.listen(port,'0.0.0.0', ()=>{
  const routes=[]; app._router?.stack.forEach(mw=>{ if(mw.route) routes.push(Object.keys(mw.route.methods).join(',').toUpperCase()+' '+mw.route.path); });
  console.log('ROUTES:', routes);
  console.log('listening on', port);
});
