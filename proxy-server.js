'use strict';

const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3001;

// In-memory cache: adid -> { buffer, cachedAt }
const cache = {};
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

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

    const cached = cache[adid];
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      log(`Serving adid=${adid} from cache (${cached.buffer.length} bytes)`);
      return send(res, 200, 'application/pdf', cached.buffer);
    }

    const pdfUrl = `https://www.plymouth-ma.gov/Archive.aspx?ADID=${adid}`;
    log(`Fetching ${pdfUrl}`);
    try {
      const { status, buffer } = await fetchBinary(pdfUrl);
      if (status !== 200) return send(res, 502, 'application/json', JSON.stringify({ error: `Plymouth MA returned HTTP ${status}` }));
      cache[adid] = { buffer, cachedAt: Date.now() };
      log(`Cached adid=${adid} (${buffer.length} bytes)`);
      send(res, 200, 'application/pdf', buffer);
    } catch (e) {
      log(`Error: ${e.message}`);
      send(res, 502, 'application/json', JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/') {
    return send(res, 200, 'application/json', JSON.stringify({ endpoints: ['GET /api/plymouth-pdf?adid=552'] }));
  }

  send(res, 404, 'application/json', JSON.stringify({ error: 'Not found' }));
});

process.on('SIGINT', () => { log('Shutting down'); server.close(); process.exit(0); });
process.on('SIGTERM', () => { log('Shutting down'); server.close(); process.exit(0); });

server.listen(PORT, () => log(`Proxy server listening on port ${PORT}`));
