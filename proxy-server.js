'use strict';

const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3001;

// In-memory cache: adid -> { buffer, cachedAt }
// Keeps only the 2 most recent ADIDs
const cache = {};
const MAX_CACHED_MONTHS = 2;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function fetchBinary(url, baseUrl) {
  return new Promise((resolve, reject) => {
    const resolved = new URL(url, baseUrl || url).href;
    const parsed = new URL(resolved);
    const opts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    };
    https.get(opts, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchBinary(res.headers.location, resolved));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buffer: Buffer.concat(chunks) }));
    }).on('error', reject).setTimeout(30000, function() { this.destroy(new Error('timeout')); });
  });
}

function send(res, status, contentType, body) {
  const buf = typeof body === 'string' ? Buffer.from(body) : body;
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': buf.length,
    'Access-Control-Allow-Origin': '*'
  });
  res.end(buf);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET' });
    return res.end();
  }

  if (url.pathname === '/api/plymouth-pdf') {
    const adid = parseInt(url.searchParams.get('adid') || '552');
    if (isNaN(adid) || adid < 1) return send(res, 400, 'application/json', JSON.stringify({ error: 'Invalid adid' }));

    if (cache[adid]) {
      log(`Serving adid=${adid} from cache (${cache[adid].buffer.length} bytes)`);
      return send(res, 200, 'application/pdf', cache[adid].buffer);
    }

    const pdfUrl = `https://www.plymouth-ma.gov/Archive.aspx?ADID=${adid}`;
    log(`Fetching ${pdfUrl}`);
    try {
      const { status, buffer } = await fetchBinary(pdfUrl);
      if (status !== 200) return send(res, 502, 'application/json', JSON.stringify({ error: `Plymouth MA returned HTTP ${status}` }));

      cache[adid] = { buffer, cachedAt: Date.now() };
      log(`Cached adid=${adid} (${buffer.length} bytes)`);

      // Evict oldest entries beyond the 2-month limit
      const keys = Object.keys(cache).map(Number).sort((a, b) => b - a);
      for (const old of keys.slice(MAX_CACHED_MONTHS)) {
        log(`Evicting adid=${old} from cache`);
        delete cache[old];
      }

      send(res, 200, 'application/pdf', buffer);
    } catch (e) {
      log(`Error: ${e.message}`);
      send(res, 502, 'application/json', JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/duxbury-pdf') {
    const month = (url.searchParams.get('month') || '').toLowerCase().replace(/[^a-z]/g, '');
    const year = parseInt(url.searchParams.get('year') || '2026');
    if (!month || isNaN(year)) return send(res, 400, 'application/json', JSON.stringify({ error: 'Requires month and year params' }));

    // Duxbury uses inconsistent naming — try two common patterns
    const patterns = [
      `https://www.town.duxbury.ma.us/sites/g/files/vyhlif10506/f/uploads/${month}_${year}_bldg_permit_report.pdf`,
      `https://www.town.duxbury.ma.us/municipal-services/files/${month}-${year}-building-permit-listing-report`,
    ];

    let fetched = null;
    for (const pdfUrl of patterns) {
      log(`Trying Duxbury URL: ${pdfUrl}`);
      try {
        const { status, buffer } = await fetchBinary(pdfUrl);
        if (status === 200 && buffer.length > 1000) { fetched = { pdfUrl, buffer }; break; }
      } catch (e) { log(`Failed: ${e.message}`); }
    }

    if (!fetched) return send(res, 502, 'application/json', JSON.stringify({ error: 'Could not fetch Duxbury PDF — URL pattern may have changed' }));
    log(`Returning Duxbury PDF (${fetched.buffer.length} bytes) from ${fetched.pdfUrl}`);
    send(res, 200, 'application/pdf', fetched.buffer);
    return;
  }

  if (url.pathname === '/api/cohasset-pdf') {
    const adid = parseInt(url.searchParams.get('adid') || '447');
    if (isNaN(adid) || adid < 1) return send(res, 400, 'application/json', JSON.stringify({ error: 'Invalid adid' }));
    if (cache[`cohasset-${adid}`]) {
      log(`Serving Cohasset adid=${adid} from cache`);
      return send(res, 200, 'application/pdf', cache[`cohasset-${adid}`].buffer);
    }
    const pdfUrl = `https://www.cohassetma.gov/Archive.aspx?ADID=${adid}`;
    log(`Fetching Cohasset PDF: ${pdfUrl}`);
    try {
      const { status, buffer } = await fetchBinary(pdfUrl);
      if (status !== 200) return send(res, 502, 'application/json', JSON.stringify({ error: `Cohasset returned HTTP ${status}` }));
      cache[`cohasset-${adid}`] = { buffer, cachedAt: Date.now() };
      // Evict oldest beyond 2 cohasset entries
      const keys = Object.keys(cache).filter(k => k.startsWith('cohasset-')).sort();
      for (const old of keys.slice(0, -2)) { delete cache[old]; }
      log(`Cached Cohasset adid=${adid} (${buffer.length} bytes)`);
      send(res, 200, 'application/pdf', buffer);
    } catch (e) {
      log(`Error: ${e.message}`);
      send(res, 502, 'application/json', JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/hingham-pdf') {
    const pdfUrl = 'https://www.hingham-ma.gov/DocumentCenter/View/1833/Building-Permits-Recently-Issued---Updated-PDF';
    if (cache['hingham']) {
      log(`Serving Hingham PDF from cache (${cache['hingham'].buffer.length} bytes)`);
      return send(res, 200, 'application/pdf', cache['hingham'].buffer);
    }
    log(`Fetching Hingham PDF`);
    try {
      const { status, buffer } = await fetchBinary(pdfUrl);
      if (status !== 200) return send(res, 502, 'application/json', JSON.stringify({ error: `Hingham returned HTTP ${status}` }));
      cache['hingham'] = { buffer, cachedAt: Date.now() };
      log(`Cached Hingham PDF (${buffer.length} bytes)`);
      send(res, 200, 'application/pdf', buffer);
    } catch (e) {
      log(`Error: ${e.message}`);
      send(res, 502, 'application/json', JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/') {
    return send(res, 200, 'application/json', JSON.stringify({ endpoints: ['GET /api/plymouth-pdf?adid=552', 'GET /api/duxbury-pdf?month=april&year=2026', 'GET /api/hingham-pdf'] }));
  }

  send(res, 404, 'application/json', JSON.stringify({ error: 'Not found' }));
});

process.on('SIGINT', () => { log('Shutting down'); server.close(); process.exit(0); });
process.on('SIGTERM', () => { log('Shutting down'); server.close(); process.exit(0); });

server.listen(PORT, () => log(`Proxy server listening on port ${PORT}`));
