const express = require('express');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

app.get('/', async (req, res) => {
  const query = req.query.q || '';
  const apikey = process.env.ZENROWS_API_KEY;
  const cookieString = process.env.ERANK_COOKIES || process.env.ERANK_COOKIE || '';

  if (!apikey) {
    return res.status(500).json({ error: 'Missing ZENROWS_API_KEY' });
  }

  try {
    // Configure ZenRows parameXYZters with css_extractor to grab h2 and h3 text
    const params = {
      apikey: apikey,
      url: 'https://members.erank.com/trend-buzz',
      js_render: 'true',
      custom_headers: 'true',
      css_extractor: JSON.stringify({ results: 'h2, h3' }),
    };

    // Build Cookie header from Netscape cookie file string
    const headers = {};
    if (cookieString.trim()) {
      try {
        const cookiePairs = [];
        const lines = cookieString.split(/\r?\n/);
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
      headers,
    });

    let results = [];
    if (response.data) {
      if (Array.isArray(response.data.results)) {
        results = response.data.results;
      } else if (typeof response.data.results === 'string') {
        results = [response.data.results];
      }
    }

    // If query parameter provided, filter results by substring (case-insensitive)
    if (query) {
      const qLower = query.toLowerCase();
      results = results.filter((item) => item.toLowerCase().includes(qLower));
    }

    res.json({ results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Scraping error' });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
