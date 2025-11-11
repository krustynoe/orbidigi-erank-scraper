app.get('/erank/tags', async (req, res) => {
  const country = (req.query.country || DEFAULT_COUNTRY).toUpperCase();
  try {
    await ensureBrowser();
    const page = await context.newPage();
    await loginIfNeeded(page);

    await openAndEnsure(page, `${BASE}/tags?country=${country}`, `${BASE}/dashboard`);

    // 1) DOM vivo
    let rows = await scrapeTagsInPage(page);

    // 2) Fallback Cheerio/JSON si vacío
    if (!rows.length) {
      const html = await page.content();
      const $ = cheerio.load(html);
      const tbl = tableByHeaders($, [/^tag$/, /avg.*search|searches/, /clicks|ctr|click/]);
      if (tbl) {
        const idx = {
          tag:  tbl.header.findIndex(h => /^tag$/.test(h)),
          avgS: tbl.header.findIndex(h => /(avg.*search|searches)/.test(h)),
          avgC: tbl.header.findIndex(h => /(avg.*click|clicks)/.test(h)),
          ctr:  tbl.header.findIndex(h => /ctr/.test(h)),
          comp: tbl.header.findIndex(h => /(competition|etsy)/.test(h)),
          trend:tbl.header.findIndex(h => /(trend)/.test(h)),
        };
        rows = tbl.rows.map(r => ({
          tag: r[idx.tag] || '',
          avg_searches: idx.avgS >= 0 ? (r[idx.avgS] || '') : '',
          avg_clicks:   idx.avgC >= 0 ? (r[idx.avgC] || '') : '',
          avg_ctr:      idx.ctr  >= 0 ? (r[idx.ctr ] || '') : '',
          etsy_competition: idx.comp >= 0 ? (r[idx.comp] || '') : '',
          search_trend: idx.trend>= 0 ? (r[idx.trend] || '') : ''
        })).filter(x => x.tag);
      } else {
        const pageJson = getInertiaPageJSON($);
        if (pageJson) {
          const arrays = deepFindArrays(pageJson, o => o && typeof o === 'object' && ('tag' in o));
          for (const arr of arrays) {
            rows = arr.map(o => ({
              tag: (o.tag || '').toString(),
              avg_searches: (o.avg_searches || o.searches || '').toString(),
              avg_clicks: (o.avg_clicks || '').toString(),
              avg_ctr: (o.avg_ctr || o.ctr || '').toString(),
              etsy_competition: (o.etsy_competition || o.competition || '').toString(),
              search_trend: (o.trend || o.search_trend || '').toString()
            })).filter(x => x.tag);
            if (rows.length) break;
          }
        }
      }
    }

    await page.close();
    return res.json({ country, count: rows.length, results: rows });
  } catch (e) {
    console.error('tags error:', e);
    res.status(500).json({ error: e.message });
  }
});
