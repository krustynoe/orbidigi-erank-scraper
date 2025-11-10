// index.js — eRank via Playwright (Sanctum login) + API calls from same session,
// with DOM fallback. Docker image: mcr.microsoft.com/playwright:v1.48.2-jammy

globalThis.File = globalThis.File || class File {};

const express = require('express');
const { chromium, request: pwRequest } = require('playwright');
const cheerio = require('cheerio');

const app  = express();
const port = process.env.PORT || 10000;

const EMAIL = (process.env.ERANK_EMAIL || '').trim();
const PASS  = (process.env.ERANK_PASSWORD || '').trim();
const UA    = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

let browser;
let context;
let lastLoginTs = 0;

// ---- utils ----
function cookieFromState(state) {
  return (state.cookies || []).map(c => `${c.name}=${c.value}`).join('; ');
}
function needRefresh() {
  return !context || (Date.now() - lastLoginTs) > 20 * 60_000;
}

// ---- login + context ----
async function ensureLoggedContext(force = false) {
  if (!EMAIL || !PASS) throw new Error('Faltan ERANK_EMAIL/ERANK_PASSWORD');
  if (!force && !needRefresh()) return context;

  const req = await pwRequest.newContext({
    baseURL: 'https://members.erank.com',
    extraHTTPHeaders: { 'User-Agent': UA }
  });

  // CSRF cookie
  let r = await req.get('/sanctum/csrf-cookie');
  if (!r.ok()) throw new Error('No se pudo obtener CSRF cookie');
  let state = await req.storageState();
  const xsrf = decodeURIComponent((state.cookies.find(c => c.name === 'XSRF-TOKEN') || {}).value || '');

  // POST /login
  const res = await req.post('/login', {
    form: { email: EMAIL, password: PASS },
    headers: {
      'User-Agent': UA,
      'X-Requested-With': 'XMLHttpRequest',
      ...(xsrf ? { 'X-XSRF-TOKEN': xsrf } : {})
    }
  });
  if (!res.ok()) throw new Error(`Login eRank fallido: ${res.status()}`);
  state = await req.storageState();

  if (!browser) {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-dev-shm-usage'] });
  }
  if (context) await context.close();
  context = await browser.newContext({
    userAgent: UA,
    storageState: state,
    viewport: { width: 1366, height: 900 }
  });
  lastLoginTs = Date.now();
  return context;
}

// ---- API helpers (same session, same cookies) ----
async function apiGet(pathname, query) {
  const ctx = await ensureLoggedContext(false);
  const qs = new URLSearchParams(query || {}).toString();
  const url = `https://members.erank.com/${pathname}${qs ? `?${qs}` : ''}`;

  const res = await ctx.request.get(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': 'https://members.erank.com/keyword-tool'
    }
  });

  if (res.status() === 401 || res.status() === 403) {
    // refresh session once
    await ensureLoggedContext(true);
    return apiGet(pathname, query);
  }
  if (!res.ok()) throw new Error(`API ${pathname} status ${res.status()}`);

  const ct = (res.headers()['content-type'] || '').toLowerCase();
  if (ct.includes('application/json')) {
    return { url, data: await res.json() };
  } else {
    // not JSON, maybe HTML fallback -> treat as failure for this path
    return { url, data: null };
  }
}

// ---- DOM fallback (only if API returned null) ----
async function scrapeKeywordToolDOM(q, country, marketplace) {
  const ctx = await ensureLoggedContext(false);
  const page = await ctx.newPage();
  const url = `https://members.erank.com/keyword-tool?country=${encodeURIComponent(country)}&source=${encodeURIComponent(marketplace)}&keyword=${encodeURIComponent(q)}`;

  await page.goto(url, { waitUntil: 'networkidle', timeout: 240000 });
  try { await page.waitForSelector('table, [role="table"]', { timeout: 25000 }); } catch {}
  await page.waitForTimeout(1500);

  const html = await page.content();
  await page.close();

  const $ = cheerio.load(html);
  const out = new Set();
  $('table tbody tr').each((_, tr) => {
    const t = $(tr).find('td').first().text().trim();
    if (t) out.add(t);
  });
  $('[role="table"] [role="row"]').each((_, row) => {
    const t = $(row).find('[role="cell"]').first().text().trim();
    if (t) out.add(t);
  });
  $('[class*=chip],[class*=tag],[data-testid*=keyword]').each((_, el) => {
    const t = $(el).text().trim(); if (t) out.add(t);
  });

  return { url, results: Array.from(out) };
}

// ---- normalizadores ----
const pickKeywords = (payload) => {
  const arr = payload?.data || payload || [];
  return Array.isArray(arr) ? arr.map(o => o?.keyword || o?.name || String(o)).filter(Boolean) : [];
};
const pickTopListings = (payload) => {
  const arr = payload?.data || payload || [];
  return Array.isArray(arr) ? arr.map(o => ({
    title: (o?.title||'').toString().trim(),
    url:   (o?.url||o?.link||'').toString().trim(),
    price: o?.price ?? '',
    shop:  o?.shop  ?? ''
  })).filter(x => x.title || x.url) : [];
};

// ---- endpoints ----
app.get('/healthz', (_req,res)=>res.json({ok:true}));
app.get('/erank/healthz', (_req,res)=>res.json({ok:true}));

// keywords -> /related-searches + DOM fallback
app.get('/erank/keywords', async (req,res)=>{
  try{
    const q = String(req.query.q||'planner');
    const country = String(req.query.country||'USA');
    const marketplace = String(req.query.marketplace||'etsy');

    // 1) API first
    const { url, data } = await apiGet('related-searches', { keyword:q, marketplace, country });
    let results = data ? pickKeywords(data) : [];

    // 2) fallback DOM if empty
    if (!results.length) {
      const { results: domRes } = await scrapeKeywordToolDOM(q, country, marketplace);
      results = domRes;
    }
    if (q) results = results.filter(s => s.toLowerCase().includes(q.toLowerCase()));
    res.json({ source: url, query: q, count: results.length, results: results.slice(0,100) });
  }catch(e){ res.status(502).json({ error: String(e.message||e) }); }
});

// stats -> /stats
app.get('/erank/stats', async (req,res)=>{
  try{
    const q = String(req.query.q||'planner');
    const country = String(req.query.country||'USA');
    const marketplace = String(req.query.marketplace||'etsy');
    const { url, data } = await apiGet('stats', { keyword:q, marketplace, country });
    res.json({ source:url, query:q, stats: data||{} });
  }catch(e){ res.status(502).json({ error: String(e.message||e) }); }
});

// top-listings -> /top-listings
app.get('/erank/top-listings', async (req,res)=>{
  try{
    const q = String(req.query.q||'planner');
    const country = String(req.query.country||'USA');
    const marketplace = String(req.query.marketplace||'etsy');
    const { url, data } = await apiGet('top-listings', { keyword:q, marketplace, country });
    const items = pickTopListings(data);
    res.json({ source:url, query:q, count: items.length, items });
  }catch(e){ res.status(502).json({ error: String(e.message||e) }); }
});

// near-matches -> /near-matches
app.get('/erank/near-matches', async (req,res)=>{
  try{
    const q = String(req.query.q||'planner');
    const country = String(req.query.country||'USA');
    const marketplace = String(req.query.marketplace||'etsy');
    const { url, data } = await apiGet('near-matches', { keyword:q, marketplace, country });
    const results = pickKeywords(data);
    res.json({ source:url, query:q, count: results.length, results });
  }catch(e){ res.status(502).json({ error: String(e.message||e) }); }
});

// raw (abre UI solo para depurar)
app.get('/erank/raw', async (req,res)=>{
  try{
    const q = String(req.query.q||'planner');
    const country = String(req.query.country||'USA');
    const marketplace = String(req.query.marketplace||'etsy');
    const ctx = await ensureLoggedContext(false);
    const page = await ctx.newPage();
    const url = `https://members.erank.com/keyword-tool?country=${encodeURIComponent(country)}&source=${encodeURIComponent(marketplace)}&keyword=${encodeURIComponent(q)}`;
    await page.goto(url, { waitUntil:'networkidle', timeout:240000 });
    await page.waitForTimeout(1500);
    const html = await page.content();
    await page.close();
    res.json({ url, ok: !!html && html.length>0, length: html.length||0, preview: (html||'').slice(0,2000) });
  }catch(e){ res.status(502).json({ error: String(e.message||e) }); }
});

app.listen(port, '0.0.0.0', ()=>{
  const routes=[]; app._router?.stack.forEach(mw=>{ if(mw.route) routes.push(Object.keys(mw.route.methods).join(',').toUpperCase()+' '+mw.route.path); });
  console.log('ROUTES:',routes); console.log('listening on',port);
});
