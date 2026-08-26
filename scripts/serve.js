#!/usr/bin/env node
// Zero-dependency static server for local development.
// ES modules can't be loaded from file://, so use this instead of double-clicking
// index.html:  npm start   ->  http://localhost:4173
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { readEnv } from './env.mjs';

const ROOT = resolve(process.argv[3] || '.');
const PORT = Number(process.env.PORT || process.argv[2] || 4173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');

    // config.js is generated from .env so the API key never lives in the repo.
    if (url.pathname === '/config.js') {
      const env = await readEnv();
      const config = { geminiApiKey: env.GEMINI_API_KEY || '', geminiModel: env.GEMINI_MODEL || '' };
      res.writeHead(200, { 'Content-Type': TYPES['.js'], 'Cache-Control': 'no-store' });
      res.end(`window.__RECEIPT_OCR_CONFIG__ = ${JSON.stringify(config)};\n`);
      return;
    }

    let filePath = join(ROOT, normalize(decodeURIComponent(url.pathname)));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const info = await stat(filePath).catch(() => null);
    if (info?.isDirectory()) filePath = join(filePath, 'index.html');
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}).listen(PORT, () => {
  console.log(`Split the Bill running at http://localhost:${PORT}`);
});
