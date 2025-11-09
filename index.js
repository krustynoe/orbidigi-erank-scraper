// index.js — eRank + ZenRows. CommonJS / Node 18 for Render

// ---- Fix undici File on Node 18 so axios doesn't crash ----
globalThis.File = globalThis.File || class File {};

const express = require('express');
const axios   = require('axios');
const cheerio = require('cheerio');

const app  = express();
const port = process.env.PORT || 3000;

// normaliza // -> /
app.use((req, _res, next) => { if (req.url.includes('//')) req.url = req.url.replace(/\/{2,}/g, '/'); next(); });
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/erank/healthz', (_req, res) => res.json({ ok: true }));

// ---- ENV
const ZR     = (process.env.ZENROWS_API_KEY || '').trim();
const BASE   = (process.env.ERANK_COOKIES || process.env.ERANK_COOKIES_RAW || '').trim(); // "a=1; b=2; ..."
const TREND_NAME = (process.env.ERANK_TREND_NAME || 'trends').trim(); // 'trends' o 'trend-buzz'
const TREND_URL  = `https://members.erank.com/${TREND_NAME}`;
const UA     = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

const http = axios.create({ timeout: 90000 });

// ---- Cookie helpers
function parseCookieLine(line) {
  const out = {};
  String(line || '')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean)
    .forEach(pair => {
      const i = pair.indexOf('=');
      if (i > 0) {
        const k = pair.slice(0, i).trim();
        const v = pair.slice(i + 1).trim();
        if (k) out[k] = v; // RAW value
      }
    });
  return out;
}

function parseSetCookie(arr) {
  const out = {};
  (arr || []).forEach(sc => {
    const i = sc.indexOf('=');
    if (i > 0) {
      const name = sc.slice(0, i);
      const val  = sc.slice(i + 1).split(';')[0]; // RAW value (may be urlencoded)
      out[name]  = val;
    }
  });
  return out; // <- FALTABA
}

function buildCookie(map) {
  return Object.entries(map).map(([k, v]) => `${k}=${v}`).join('; ');
}

const hdrForPage = (cookie) => ({
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  ...(cookie ? { Cookie: cookie } : {})
});

// ---- ZenRows helper (para Etsy público)
async function fetchHtmlViaZenrows(url, waitFor = 'body') {
  const params = {
    apikey: ZR,
    url,
    js_render: 'true',
    custom_headers: 'true',
    // premium_proxy: 'true',
    block_resources: 'image,font',
    wait_for: waitFor
  };
  const { data } = await http.get('https://api.zenrows.com/v1/', {
    params,
    headers: { 'User-Agent': UA },
    timeout: 120000
  });
  if (typeof data === 'string') return data;
  if (data?.html) return data.html;
  throw new Error(JSON.stringify(data));
}

// ---- Auth & CSRF bootstrap (correcto): /sanctum/csrf-cookie -> merge cookies -> /trends -> headers
async function getAuthContext() {
  const baseHeaders = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Origin': 'https://members.erank.com',
    'Referer': TREND_URL,
    ...(BASE ? { Cookie: BASE } : {})
  };

  // 1) Obtener XSRF-TOKEN y sesión desde Sanctum
  const r1 = await http.get('https://members.erank.com/sanctum/csrf-cookie', {
    headers: baseHeaders,
    maxRedirects: 0,
    validateStatus: () => true,
    timeout: 45000
  });

  if (r1.status === 302 && /\/login/i.test(r1.headers.location || '')) {
    throw new Error('Login requerido o cookie expirada (302 en /sanctum/csrf-cookie)');
  }
  if (![200, 204].includes(r1.status)) {
    throw new Error(`CSRF cookie endpoint devolvió ${r1.status}`);
  }

  const setMap = parseSetCookie(r1.headers['set-cookie'] || []);
  if (!setMap['XSRF-TOKEN']) {
    throw new Error('XSRF-TOKEN not present after /sanctum/csrf-cookie');
  }

  // 2) Combinar con cookies base
  const baseMap = parseCookieLine(BASE);
  const merged  = { ...baseMap, ...setMap }; // prioriza Set-Cookie reciente

  // 3) Opcional: leer meta CSRF desde /trends
  const r2 = await http.get(TREND_URL, {
    headers: { ...baseHeaders, Cookie: buildCookie(merged) },
    validateStatus: () => true,
    timeout: 45000
  });
  const html = String(r2.data || '');
  const $ = cheerio.load(html);
  const csrfMeta = $('meta[name="csrf-token"]').attr('content') || '';

  const cookieLine = buildCookie(merged);          // incluye XSRF-TOKEN=<raw>
  const xsrfRaw    = merged['XSRF-TOKEN'];         // podría venir URL-encoded
  const xsrfHeader = decodeURIComponent(xsrfRaw);  // header va DE-encodificado

  return { cookieLine, csrf: csrfMeta, xsrfHeader };
}

function apiHeaders(cookieLine, csrf, xsrfHeader) {
  return {
    'User-Agent'
