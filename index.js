const express = require('express');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

app.get('/', async (req, res) => {
  const token = process.env.ERANK_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'Missing ERANK_TOKEN' });
  }

  try {
    // Call eRank Trend Buzz endpoint (modify URL if you need another route)
    const response = await axios.get('https://members.erank.com/api/trend-buzz', {
      headers: {
        Authorization: 'Bearer ' + token,
      },
    });

    return res.json(response.data);
  } catch (error) {
    console.error('Erank API error:', error);
    res.status(500).json({ error: error.message || 'Error fetching eRank data' });
  }
});

app.listen(port, () => {
  console.log(`Erank API proxy listening on port ${port}`);
});
