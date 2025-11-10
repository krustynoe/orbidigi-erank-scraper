// index.js — eRank keyword endpoints (related-searches, stats, top-listings, near-matches)
// Node 18 CJS para Render. Login automático con Sanctum.

globalThis.File = globalThis.File || class File {};

const express = require('express');
const axios   = require('axios');

const app  = express();
const port = process.env.PORT || 3000;

// ===== ENV =====
const ZR   = (process.env.ZENROWS_API_KEY || '').trim(); // opcional en este flujo
const EMAIL= (process.env.ERANK_EMAIL || '').trim();
const PASS = (process.env.ERANK_PASSWORD || '').trim();
const UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

const http = axios.create({ timeout: 120000, validateStatus: () => true });

// ===== Cookie jar simple =====
const jar = new Map();
function applySetCookies(res){
  const sc = res.headers?.['set-cookie'];
  if(!sc) return;
  for(const raw of sc){
    const part = String(raw).split(';')[0];
    const eq = part.indexOf('=');
    if(eq>0){ const k=part.slice(0,eq).trim(),v=part.slice(eq+1).trim(); if(k) jar.set(k,v); }
  }
}
function cookieHeader(){ return Array.from(jar.entries()).map(([k,v])=>`${k}=${v}`).join('; '); }
function getCookie(n){ return jar.get(n)||''; }

// ===== Login automático (Sanctum) =====
let sessionReadyAt=0;
async function loginIfNeeded(force=false){
  const fresh = Date.now()-sessionReadyAt < 20*60*1000;
  if(!force && fresh && (getCookie('laravel_session')||getCookie('sid_er'))) return;
  if(!EMAIL||!PASS) throw new Error('Faltan ERANK_EMAIL/ERANK_PASSWORD');

  // 1) CSRF cookie
  let r = await http.get('https://members.erank.com/sanctum/csrf-cookie',{headers:{'User-Agent':UA}});
  applySetCookies(r);
  const xsrf = decodeURIComponent(getCookie('XSRF-TOKEN')||'');

  // 2) POST /login
  const body = new URLSearchParams({email:EMAIL,password:PASS}).toString();
  const hdrs={'Content-Type':'application/x-www-form-urlencoded','X-Requested-With':'XMLHttpRequest',...(xsrf?{'X-XSRF-TOKEN':xsrf}:{})};
  const p = await http.post('https://members.erank.com/login', body, { headers:{...hdrs,'User-Agent':UA,Cookie:cookieHeader()} });
  applySetCookies(p);

  if(!getCookie('laravel_session') && !getCookie('sid_er')) throw new Error('Login eRank fallido');
  sessionReadyAt = Date.now();
}

// ===== Utilidades =====
function buildUrl(base, query){
  const qs = new URLSearchParams(query || {}).toString();
  return qs ? `${base}?${qs}` : base;
}

async function fetchErankJson(pathname, query){
  await loginIfNeeded(false);
  const url = buildUrl(`https://members.erank.com/${pathname}`, query);
  const headers = {
    'User-Agent': UA,
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': 'https://members.erank.com',
    'Referer': 'https://members.erank.com/keyword-tool',
    Cookie: cookieHeader()
  };

  let r = await http.get(url,{ headers });
  // si la sesión caducó, reintenta una vez
  if(r.status===401 || r.status===403){
    await loginIfNeeded(true);
    r = await http.get(url,{ headers:{...headers, Cookie:cookieHeader()} });
  }
  if(r.status!==200) throw new Error(`eRank ${pathname} status ${r.status}`);
  return { url, data: r.data };
}

// ===== Normalizadores de respuesta =====
function pickKeywords(payload){
  // /related-searches suele devolver { data: [ { keyword: "...", ... }, ... ] }
  const arr = payload?.data || payload || [];
  return Array.isArray(arr) ? arr.map(o=>o.keyword || o.name || String(o)).filter(Boolean) : [];
}

function pickTopListings(payload){
  // estructura típica: { data: [ { title, url, price, shop, ... }, ... ] }
  const arr = payload?.data || payload || [];
  if(!Array.isArray(arr)) return [];
  return arr.map(o=>({
    title: String(o.title||'').trim(),
    url:   String(o.url||o.link||'').trim(),
    price: o.price ?? '',
    shop:  o.shop  ?? ''
  })).filter(x=>x.title || x.url);
}

function pickNearMatches(payload){
  const arr = payload?.data || payload || [];
  if(!Array.isArray(arr)) return [];
  return arr.map(o=> String(o.keyword||o.name||'').trim()).filter(Boolean);
}

function pickStats(payload){
  // stats?keyword=... → estructura con métricas; devolvemos tal cual
  return payload;
}

// ===== Endpoints =====
app.get('/healthz',(_req,res)=>res.json({ok:true}));
app.get('/erank/healthz',(_req,res)=>res.json({ok:true}));

// related-searches
app.get('/erank/keywords', async (req,res)=>{
  try{
    const q = String(req.query.q||'planner');
    const country = String(req.query.country||'USA');
    const marketplace = String(req.query.marketplace||'etsy');
    const { url, data } = await fetchErankJson('related-searches',{ keyword:q, marketplace, country });
    const results = pickKeywords(data);
    res.json({ source:url, query:q, count:results.length, results });
  }catch(e){ res.status(502).json({ error:String(e.message||e) }); }
});

// stats
app.get('/erank/stats', async (req,res)=>{
  try{
    const q = String(req.query.q||'planner');
    const country = String(req.query.country||'USA');
    const marketplace = String(req.query.marketplace||'etsy');
    const { url, data } = await fetchErankJson('stats',{ keyword:q, country, marketplace });
    res.json({ source:url, query:q, stats: pickStats(data) });
  }catch(e){ res.status(502).json({ error:String(e.message||e) }); }
});

// top-listings
app.get('/erank/top-listings', async (req,res)=>{
  try{
    const q = String(req.query.q||'planner');
    const country = String(req.query.country||'USA');
    const marketplace = String(req.query.marketplace||'etsy');
    const { url, data } = await fetchErankJson('top-listings',{ keyword:q, country, marketplace });
    const items = pickTopListings(data);
    res.json({ source:url, query:q, count:items.length, items });
  }catch(e){ res.status(502).json({ error:String(e.message||e) }); }
});

// near-matches
app.get('/erank/near-matches', async (req,res)=>{
  try{
    const q = String(req.query.q||'planner');
    const country = String(req.query.country||'USA');
    const marketplace = String(req.query.marketplace||'etsy');
    const { url, data } = await fetchErankJson('near-matches',{ keyword:q, country, marketplace });
    const results = pickNearMatches(data);
    res.json({ source:url, query:q, count:results.length, results });
  }catch(e){ res.status(502).json({ error:String(e.message||e) }); }
});

app.listen(port,'0.0.0.0',()=>{
  const routes=[];
  app._router?.stack.forEach(mw=>{ if(mw.route) routes.push(Object.keys(mw.route.methods).join(',').toUpperCase()+' '+mw.route.path); });
  console.log('ROUTES:',routes);
  console.log('listening on',port);
});
