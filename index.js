// --- ZenRows helper for rendered HTML with your cookie
async function fetchRenderedHtml(url, waitForSel = 'body') {
  const params = {
    apikey: ZR,
    url,
    js_render: 'true',
    custom_headers: 'true',
    block_resources: 'image,font',
    wait_for: 'h2',          // más liviano
    render_delay: 3000       // espera 3 s antes de capturar el DOM
  };
  const { data } = await http.get('https://api.zenrows.com/v1/', {
    params,
    headers: { 'User-Agent': UA, ...(ER ? { Cookie: ER } : {}) },
    timeout: 120000
  });
  const html = typeof data === 'string' ? data : (data?.html || '');
  if (!html) throw new Error(`Empty HTML from renderer for ${url}`);
  return html;
}
