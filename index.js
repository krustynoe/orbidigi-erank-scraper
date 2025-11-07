const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const port = process.env.PORT || 3000;

app.get('/', async (req, res) => {
  const keyword = req.query.q || 'digital planner';
  const apiKey = process.env.ZENROWS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Missing ZenRows API key' });
  }

  // build cookie header from ERANK_COOKIES environment variable
  let cookieHeader = '';
  const cookiesString = process.env.ERANK_COOKIES || process.env.ERANK_COOKIE || '';
  if (cookiesString.trim()) {
    const lines = cookiesString.split(/\r?\n/);
    const cookiePairs = [];
    for (const line of lines) {
      if (!line || line.startsWith('#')) continue;
      const parts = line.split('\t');
      if (parts.length >= 7) {
        cookiePairs.push(`${parts[5]}=${parts[6]}`);
      }
    }
    cookieHeader = cookiePairs.join('; ');
  }

  const params = {
    apikey: apiKey,
    url: 'https://erank.com/dashboard',
    js_render: 'true',
    css_extractor: JSON.stringify({ results: 'h3' })
  };
  if (cookieHeader) {
    params.custom_headers = 'true';
  }

  try {
    const response = await axios.get('https://api.zenrows.com/v1/', {
      params,
      headers: cookieHeader ? { Cookie: cookieHeader } : {}
    });

    const data = response.data;

    if (data && data.results) {
      return res.json(data.results);
    }

    // If css_extractor didn't run, fallback to parse HTML
    const $ = cheerio.load(data);
    const results = [];
    $('h3').each((i, elem) => {
      results.push($(elem).text().trim());
    });
    return res.json(results);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message || 'Error fetching data' });
  }
});

app.listen(port, () => {
  console.log(`ERank scraper listening on port ${port}`);
});
