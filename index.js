const express2 = require('express');
const puppeteer2 = require('puppeteer');


const app2 = express2();
const port2 = process.env.PORT || 3000;


app2.get('/', async (req, res) => {
const keyword = req.query.q || 'digital planner';


const browser = await puppeteer2.launch({
headless: true,
executablePath: '/usr/bin/google-chrome',
args: ['--no-sandbox', '--disable-setuid-sandbox']
});


const page = await browser.newPage();
await page.goto('https://erank.com/login');


await page.type('#email', process.env.ERANK_EMAIL);
await page.type('#password', process.env.ERANK_PASS);
await page.click('button[type="submit"]');
await page.waitForNavigation();


await page.goto('https://erank.com/dashboard');
await page.waitForTimeout(5000);


const result = await page.evaluate(() => {
return [...document.querySelectorAll('h3')].map(el => el.innerText);
});


await browser.close();
res.json({ keyword, result });
});


app2.listen(port2, () => {
console.log(`ERANK scraper live on port ${port2}`);
});