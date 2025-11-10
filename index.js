// index.js — eRank Keyword Tool via Inertia JSON (X-Inertia) + login Sanctum
// Node 18 CJS para Render.

globalThis.File = globalThis.File || class File {};

const express = require('express');
const axios   = require('axios');

const app  = express();
const port = process.env.PORT || 3000;

// ===== ENV =====
const EMAIL = (process.env.ERANK_EMAIL || '').trim();
const PASS  = (process.env.ERANK_PASSWORD || '').trim();
const UA    = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

const http = axios.create({ timeout: 120000, validateStatus: () => true });

// ===== Cookie jar simple =====
const jar = new Map();
function applySetCookies(res){
  const sc = res.headers?.['set-cookie'];
  if (!sc) return;
  for (const raw of sc) {
    const part = String(raw).split(';')[0];
    const eq = part.indexOf('=');
    if (eq>0) { const k = part.slice(0,eq).trim(); const v = part.slice(eq+1).trim(); if (k) jar.set(k,v); }
  }
}
function cookieHeader(){ return Array.from(jar.entries()).map(([k,v])=>`${k}=${v}`).join('; '); }
function getCookie(n){ return jar.get(n)||''; }

// ===== Login Sanctum =====
let sessionReadyAt = 0;
async function loginIfNeeded(force=false){
  const fresh = Date.now() - sessionReadyAt < 20*60*1000;
  if (!force && fresh && (getCookie('laravel_session') || getCookie('sid_er'))) return;
  if (!EMAIL || !PASS) throw new Error('Faltan ERANK_EMAIL/ERANK_PASSWORD');

  // CSRF
  const r = await http.get('https://members.erank.com/sanctum/csrf-cookie',{headers:{'User-Agent':UA}});
  applySetCookies(r);
  const xsrf = decodeURIComponent(getCookie('XSRF-TOKEN')||'');

  // Login
  const body = new URLSearchParams({ email:EMAIL, password:PASS }).toString();
  const hdrs = { 'User-Agent':UA,'Content-Type':'application/x-www-form-urlencoded','X-Requested-With':'XMLHttpRequest', ...(xsrf?{'X-XSRF-TOKEN':xsrf}:{}) , Cookie:cookieHeader()};
  const p = await http.post('https://members.erank.com/login', body, { headers: hdrs });
  applySetCookies(p);

  if (!getCookie('laravel_session') && !getCookie('sid_er')) throw new Error('Login eRank fallido');
  sessionReadyAt = Date.now();
}

// ===== Inertia fetch =====
async function inertiaGet(path, query){
  await loginIfNeeded(false);
  const qs = new URLSearchParams(query||{}).toString();
  const url = `https://members.erank.com/${path}${qs?`?${qs}`:''}`;
  const headers = {
    'User-Agent': UA,
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'X-Inertia': 'true',             // <- clave
    // 'X-Inertia-Version': 'hash',   // opcional
    'Referer': 'https://members.erank.com/keyword-tool',
    Cookie: cookieHeader()
  };

  let r = await http.get(url, { headers });
  if (r.status===401 || r.status===403) { await loginIfNeeded(true); r = await http.get(url, { headers:{...headers, Cookie:cookieHeader()} }); }
  if (r.status!==200) throw new Error(`Inertia ${path} status ${r.status}`);
  if (typeof r.data!=='object' || !r.data.props) throw new Error('Respuesta Inertia sin props');
  return { url, props: r.data.props };
}

// ===== Extractores =====
function gatherStrings(node, acc){
  if (!node) return;
  if (typeof node==='string'){ const s=node.trim(); if (s) acc.add(s); return; }
  if (Array.isArray(node)){ node.forEach(n=>gatherStrings(n,acc)); return; }
  if (typeof node==='object'){
    for (const k of Object.keys(node)){
      const v=node[k];
      if (typeof v==='string' && /keyword|title|name|term|text/i.test(k)) { const s=v.trim(); if (s) acc.add(s); }
      else gatherStrings(v,acc);
    }
  }
}

function extractKeywordsFromProps(props){
  // Intenta campos típicos
  const candidates = [
    props?.relatedSearches, props?.nearMatches, props?.keywords, props?.results, props?.data
  ].filter(Boolean);
  const out = new Set();

  for (const c of candidates){
    if (Array.isArray(c)) {
      c.forEach(o=>{
        if (!o || typeof o!=='object') return;
        const t=o.keyword||o.name||o.title||o.term||o.text;
        if (typeof t==='string'){ const s=t.trim(); if (s) out.add(s); }
      });
    }
  }

  // Si nada, barrido genérico
  if (!out.size){
    const acc=new Set(); gatherStrings(props,acc); acc.forEach(s=>out.add(s));
  }
  return Array.from(out);
}

// ===== Endpoints =====
app.get('/healthz',(_req,res)=>res.json({ok:true}));
app.get('/erank/healthz',(_req,res)=>res.json({ok:true}));

// /erank/keywords -> Inertia JSON de keyword-tool
app.get('/erank/keywords', async (req,res)=>{
  try{
    const q = String(req.query.q||'planner');
    const country = String(req.query.country||'USA');
    const marketplace = String(req.query.marketplace||'etsy'); // eRank usa "source"
    const { url, props } = await inertiaGet('keyword-tool',{ country, source: marketplace, keyword: q });

    let results = extractKeywordsFromProps(props);
    if (q) results = results.filter(s=>s.toLowerCase().includes(q.toLowerCase()));
    // filtra ruidos obvios
    results = results.filter(s => s && s.length<=64 && !/^https?:\/\//i.test(s));

    res.json({ source:url, query:q, count:results.length, results:results.slice(0,100) });
  }catch(e){
    res.status(502).json({ error:String(e.message||e) });
  }
});

// Debug: muestra las primeras claves de props
app.get('/erank/raw', async (req,res)=>{
  try{
    const q = String(req.query.q||'planner');
    const country = String(req.query.country||'USA');
    const marketplace = String(req.query.marketplace||'etsy');
    const { url, props } = await inertiaGet('keyword-tool',{ country, source: marketplace, keyword: q });
    res.json({ source:url, keys:Object.keys(props||{}).slice(0,20), preview: JSON.stringify(props).slice(0,1200) });
  }catch(e){ res.status(502).json({ error:String(e.message||e) }); }
});

app.listen(port,'0.0.0.0',()=>{
  const routes=[]; app._router?.stack.forEach(mw=>{ if(mw.route) routes.push(Object.keys(mw.route.methods).join(',').toUpperCase()+' '+mw.route.path); });
  console.log('ROUTES:',routes); console.log('listening on',port);
});
