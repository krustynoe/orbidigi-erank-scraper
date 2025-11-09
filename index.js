const express = require('express');
const axios = require('axios');
const app = express();
const port = process.env.PORT || 3000;

const ZR = process.env.ZENROWS_API_KEY || '';
const ER = (process.env.ERANK_COOKIES || process.env.ERANK_COOKIE || '').trim();

function headersWithCookie(cookie) {
  return cookie ? { Cookie: cookie, 'User-Agent': 'Mozilla/5.0' } : { 'User-Agent': 'Mozilla/5.0' };
}

async function zenrows(url, extractor, cookie) {
  const params = {
    apikey: ZR,
    url,
    js_render: 'true',
    custom_headers: 'true',
    css_extractor: JSON.stringify(extractor),
  };
  const { data } = await axios.get('https://api.zenrows.com/v1/', { params, headers: headersWithCookie(cookie) });
  return data;
}

app.get('/erank/keywords', async (req, res) => {
  try {
    const q = req.query.q || '';
    const data = await zenrows(
      `https://members.erank.com/trend-buzz`,
      { results: { selector: 'h1,h2,h3,.trend-title', type: 'text', all: true } },
      ER
    );
    const results = Array.isArray(data.results) ? data.results.filter(Boolean) : [];
    res.json({ query: q, count: results.length, results: results.slice(0, 20) });
  } catch (e) { res.status(500).json({ error: e.response?.data || String(e) }); }
});

app.get('/erank/products', async (req, res) => {
  try {
    const q = req.query.q || '';
    const data = await zenrows(
      `https://www.etsy.com/search?q=${encodeURIComponent(q)}`,
      {
        items: [{
          selector: 'li[data-search-result]',
          values: {
            title: { selector: 'h3', type: 'text' },
            url:   { selector: 'a',  type: 'attr', attr: 'href' },
            price: { selector: '.currency-value', type: 'text', optional: true },
            shop:  { selector: '.v2-listing-card__shop', type: 'text', optional: true }
          }
        }]
      },
      ''
    );
    const items = Array.isArray(data.items) ? data.items : [];
    res.json({ query: q, count: items.length, items: items.slice(0, 20) });
  } catch (e) { res.status(500).json({ error: e.response?.data || String(e) }); }
});

app.get('/erank/mylistings', async (req, res) => {
  try {
    const shop = String(req.query.shop || '');
    if (!shop) return res.status(400).json({ error: "Missing 'shop' param" });
    const data = await zenrows(
      `https://www.etsy.com/shop/${encodeURIComponent(shop)}`,
      {
        items: [{
          selector: '.wt-grid__item-xs-6',
          values: {
            title: { selector: 'h3', type: 'text' },
            url:   { selector: 'a',  type: 'attr', attr: 'href' },
            price: { selector: '.currency-value', type: 'text', optional: true },
            tags:  { selector: '[data-buy-box-listing-tags]', type: 'text', optional: true }
          }
        }]
      },
      ''
    );
    const items = Array.isArray(data.items) ? data.items : [];
    res.json({ shop, count: items.length, items: items.slice(0, 50) });
  } catch (e) { res.status(500).json({ error: e.response?.data || String(e) }); }
});

app.get('/erank/research', async (req, res) => {
  try {
    const q = req.query.q || '';
    const data = await zenrows(
      `https://members.erank.com/trend-buzz`, // o la URL interna que necesites
      { items: [{ selector: '.trend-card', values: { title:{selector:'.title',type:'text'} } }] },
      ER
    );
    const items = Array.isArray(data.items) ? data.items : [];
    res.json({ query: q, count: items.length, items: items.slice(0, 20) });
  } catch (e) { res.status(500).json({ error: e.response?.data || String(e) }); }
});

app.listen(port, () => console.log('eRank scraper listening on', port));
