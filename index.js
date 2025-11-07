const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
const port = process.env.PORT || 3000;

app.get('/', async (req, res) => {
  const keyword = req.query.q || 'digital planner';
  let browser;

  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true
    });

    const page = await browser.newPage();
    // Navigate to login page and wait for the email field
    await page.goto('https://erank.com/login', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#email', { timeout: 15000 });

    await page.type('#email', process.env.ERANK_EMAIL || '');
    await page.type('#password', process.env.ERANK_PASSWORD || '');

    await page.click("button[type='submit']");

    // Wait for navigation after login
    await page.waitForNavigation({ timeout: 30000 });

    // Go to dashboard or search page
    await page.goto('https://erank.com/dashboard', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);

    const result = await page.evaluate(() => {
      return [...document.querySelectorAll('h3')].map(el => el.innerText);
    });

    res.json({ keyword, result });
  } catch (error) {
    console.error('ERank scraper error:', error);
    res.status(500).json({ error: error.message || error.toString() });
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (err) {
        console.error('Error closing browser:', err);
      }
    }
  }
});

app.listen(port, () => {
  console.log('ERANK scraper live on port ' + port);
});
