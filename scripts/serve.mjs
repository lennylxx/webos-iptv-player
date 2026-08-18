import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { join, extname } from 'path';
import { LEGACY_HEADER, readLegacyAsset } from './chromium-53-simulation.mjs';

const PORT = 3000;
const DIR = 'dist';

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.xml': 'application/xml',
};

createServer(async (req, res) => {
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  const file = join(DIR, pathname === '/' ? '/index.html' : pathname);
  try {
    const ext = extname(file);
    // The `chromium-53-simulation` Playwright project asks for the webOS 4
    // engine via this header; a plain preview never sends it.
    const legacy = req.headers[LEGACY_HEADER] === '1';
    const data = legacy ? await readLegacyAsset(file, pathname) : await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      Vary: LEGACY_HEADER,
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}).listen(PORT, () => {
  console.log(`Preview: http://localhost:${PORT}`);
});
