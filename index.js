const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const port = process.env.PORT || 3000;

app.get('/', async (req, res) => {
  const query = req.query.q || '';
  const apiKey = process.env.ZENROWS_API_KEY;
  const cookiesString = process.env.ERANK_COOKIES || process.env.ERANK_COOKIE || '';

  if (!apiKey) {
    return res.status(500).json({ error: 'Missing ZENROWS_API_KEY' });
  }

  try {
    // Build ZenRows parameters
    const params = {
      apikey: apiKey,
      url: 'https://members.erank.com/trend-buzz',
      js_render: 'true',
      custom_headers: 'true'
    };

    // Build Cookie header from Netscape cookie file string
    const headers = {};
    if (cookiesString.trim()) {
      try {
        const cookiePairs = [];
        const lines = cookiesString.split(/\r?\n/);
        for (const line of lines) {
          if (!line || line.startsWith('#')) continue;
          const parts = line.split('\t');
          if (parts.length >= 7) {
            const name = parts[5];
            const value = parts[6];
            cookiePairs.push(`${name}=${value}`);
          }
        }
        if (cookiePairs.length > 0) {
          headers.Cookie = cookiePairs.join('; ');
        }
      } catch (err) {
        console.error('Failed to parse ERANK_COOKIES:', err);
      }
    }

    const response = await axios.get('https://api.zenrows.com/v1/', {
      params,
      headers
    });

    // Parse HTML to extract text from <h2> and <h3> tags
    const html = response.data.html || '';
    const $ = cheerio.load(html);
    const results = [];
    $('h2, h3').each((i, elem) => {
      results.push($(elem).text().trim());
    });

    return res.json({ query, results });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'Error fetching data' });
  }
});

app.listen(port, () => {
  console.log(`Erank scraper live on port ${port}`);
});
