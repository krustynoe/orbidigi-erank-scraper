// --- bootstrap de diagnóstico ---
process.on('uncaughtException', e => { console.error('uncaughtException:', e); process.exit(1); });
process.on('unhandledRejection', e => { console.error('unhandledRejection:', e); process.exit(1); });

console.log('Booting eRank scraper...');
console.log('Node version:', process.version);
console.log('PORT=', process.env.PORT);
console.log('ZENROWS_API_KEY set =', !!process.env.ZENROWS_API_KEY);
console.log('ERANK_COOKIES set =', !!(process.env.ERANK_COOKIES || process.env.ERANK_COOKIE));
// --- fin bootstrap ---
// ---------- CONFIG ----------
const ZR = process.env.ZENROWS_API_KEY || '';
const ER = (process.env.ERANK_COOKIES || '').trim();
const TREND_ENV = (process.env.ERANK_TREND_URL || '').trim();
const TREND_CANDIDATES = TREND_ENV
  ? [TREND_ENV]
  : [
      'https://members.erank.com/trends',
      'https://members.erank.com/trend-buzz',
      'https://members.erank.com/keyword-trends',
      'https://members.erank.com/trendbuzz'
    ];

// ---------- HTTP ROBUSTO ----------
async function zenGet(params, headers, { retries = 3, baseDelay = 1500 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const { data } = await axios.get('https://api.zenrows.com/v1/', {
        params,
        headers,
        timeout: 120000
      });
      return data;
    } catch (e) {
      lastErr = e;
      // si es corte de socket o 5xx, reintenta con backoff
      const msg = String(e?.code || e?.message || '');
      const status = e?.response?.status || 0;
      if (i < retries && (/ECONNRESET|socket hang up|ETIMEDOUT/i.test(msg) || status >= 500)) {
        await new Promise(r => setTimeout(r, baseDelay * (i + 1)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

function headersWithCookie(cookie) {
  return { 'User-Agent': 'Mozilla/5.0', ...(cookie ? { Cookie: cookie } : {}) };
}

async function fetchHtml(url, cookie = '', waitFor = 'body') {
  const params = {
    apikey: ZR,
    url,
    js_render: 'true',
    custom_headers: 'true',
    premium_proxy: 'true',
    block_resources: 'true',
    wait_for: waitFor
  };
  const data = await zenGet(params, headersWithCookie(cookie));
  if (typeof data === 'string') return data;
  if (data?.html) return data.html;
  throw new Error(JSON.stringify(data));
}

function looksLike404OrLogin(html) {
  const s = String(html || '').toLowerCase();
  return s.includes('page you were looking for was not found')
      || s.includes('sign in') || s.includes('login');
}

async function resolveTrendUrl(cookie) {
  for (const u of TREND_CANDIDATES) {
    try {
      const html = await fetchHtml(u, cookie, 'body');
      if (html && !looksLike404OrLogin(html)) return { url: u, html };
    } catch (_) {}
  }
  return { url: null, html: null };
}
app.listen(process.env.PORT || 3000, '0.0.0.0', () => {
  const routes = [];
  app._router?.stack?.forEach(mw => { if (mw.route) routes.push(Object.keys(mw.route.methods).join(',').toUpperCase() + ' ' + mw.route.path); });
  console.log('ROUTES:', routes);
  console.log('listening on', process.env.PORT || 3000);
});
