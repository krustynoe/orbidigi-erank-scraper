// index.js — eRank Keyword Tool con Playwright (Chromium) + login Sanctum
// Esperas robustas: networkidle, scroll y validación de sesión.

globalThis.File = globalThis.File || class File {};

const express = require('express');
const { chromium, request: pwRequest } = require('playwright');
const cheerio = require('cheerio');

const app = express();
const port = process.env.PORT || 3000;

const EMAIL = (process.env.ERANK_EMAIL || '').trim();
const PASS  = (process.env.ERANK_PASSWORD || '').trim();
const UA    = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

let browser;
let context;
let lastLoginTs = 0;

function getCookieValue(storageState, name) {
  const c = storageState?.cookies?.find(k => k.name === name);
  return c ? c.value : '';
}

async function ensureLoggedContext(force=false) {
  const fresh = Date.now() - lastLoginTs < 20 * 60 * 1000;
  if (!force && fresh && context) return context;
  if (!EMAIL || !PASS) throw new Error('Faltan ERANK_EMAIL/ERANK_PASSWORD');

  // 1) Login HTTP (Sanctum)
  const req = await pwRequest.newContext({
    baseURL: 'https://members.erank.com',
    extraHTTPHeaders: { 'User-Agent': UA }
  });
  let r = await req.get('/sanctum/csrf-cookie');
  if (!r.ok()) throw new Error('CSRF-cookie falló');
  let state = await req.storageState();
  const xsrf = decodeURIComponent(getCookieValue(state, 'XSRF-TOKEN') || '');
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

  // 2) Lanzar Chromium y crear context con cookies válidas
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    });
  }
  if (context) await context.close();
  context = await browser.newContext({
    userAgent: UA,
    storageState: state,
    viewport: { width: 1366, height: 900 },
    deviceScaleFactor: 1
  });

  // 3) Validar sesión cargando una página interna
  const p = await context.newPage();
  await p.goto('https://members.erank.com/dashboard', { waitUntil: 'networkidle', timeout: 240000 });
  // si redirige al login, fuerza relogin
  const urlNow = p.url();
  if (/login/i.test(urlNow)) {
    await p.close();
    return ensureLoggedContext(true);
  }
  await p.close();

  lastLoginTs = Date.now();
  return context;
}

// util para extraer primera columna y chips
function extractKeywordsFromHTML(html) {
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
  return Array.from(out).filter(s => s && s.length <= 64 && !/^https?:\/\//i.test(s));
}

async function gotoAndHydrate(page, url) {
  // Carga inicial y espera a que la SPA termine llamadas
  await page.goto(url, { waitUntil: 'networkidle', timeout: 240000 });
  // Algunas vistas requieren una microinactividad extra
  await page.waitForTimeout(1500);
  // Intento 1: tabla clásica
  try { await page.waitForSelector('table tbody tr', { timeout: 20000 }); return; } catch {}
  // Intento 2: grids ARIA
  try { await page.waitForSelector('[role="table"] [role="row"]', { timeout: 20000 }); return; } catch {}
  // Intento 3: pequeño scroll para disparar observers
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1500);
  // Último intento con selector genérico
  try { await page.waitForSelector('table, [role="table"]', { timeout: 15000 }); } catch {}
}

async function scrapeKeywordTool({ q, country, marketplace }) {
  const ctx = await ensureLoggedContext(false);
  const page = await ctx.newPage();

  const url = `https://members.erank.com/keyword-tool?country=${encodeURIComponent(country)}&source=${encodeURIComponent(marketplace)}&keyword=${encodeURIComponent(q)}`;
  await gotoAndHydrate(page, url);

  const html = await page.content();
  const kws = extractKeywordsFromHTML(html);
  await page.close();
  return { source: url, results: kws };
}

// ===== Endpoints =====
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/erank/healthz', (_req, res) => res.json({ ok: true }));

app.get('/erank/keywords', async (req, res) => {
  try {
    const q           = String(req.query.q || 'planner');
    const country     = String(req.query.country || 'USA');
    const marketplace = String(req.query.marketplace || 'etsy');
    let { source, results } = await scrapeKeywordTool({ q, country, marketplace });
    if (q) results = results.filter(s => s.toLowerCase().includes(q.toLowerCase()));
    res.json({ source, query: q, count: results.length, results: results.slice(0, 100) });
  } catch (e) {
    try {
      await ensureLoggedContext(true);
      const q           = String(req.query.q || 'planner');
      const country     = String(req.query.country || 'USA');
      const marketplace = String(req.query.marketplace || 'etsy');
      let { source, results } = await scrapeKeywordTool({ q, country, marketplace });
      if (q) results = results.filter(s => s.toLowerCase().includes(q.toLowerCase()));
      return res.json({ source, query: q, count: results.length, results: results.slice(0, 100) });
    } catch (err) {
      return res.status(502).json({ error: String(err.message || err) });
    }
  }
});

// Diagnóstico: devuelve longitud del HTML y primer tramo
app.get('/erank/raw', async (req, res) => {
  try {
    const q           = String(req.query.q || 'planner');
    const country     = String(req.query.country || 'USA');
    const marketplace = String(req.query.marketplace || 'etsy');
    const ctx = await ensureLoggedContext(false);
    const page = await ctx.newPage();
    const url = `https://members.erank.com/keyword-tool?country=${encodeURIComponent(country)}&source=${encodeURIComponent(marketplace)}&keyword=${encodeURIComponent(q)}`;
    await gotoAndHydrate(page, url);
    const html = await page.content();
    await page.close();
    res.json({ url, ok: !!html, length: html.length, preview: String(html).slice(0, 2000) });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.listen(port, '0.0.0.0', () => {
  const routes = [];
  app._router?.stack.forEach(mw => { if (mw.route) routes.push(Object.keys(mw.route.methods).join(',').toUpperCase() + ' ' + mw.route.path); });
  console.log('ROUTES:', routes);
  console.log('listening on', port);
});
