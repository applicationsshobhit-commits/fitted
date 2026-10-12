// Local static server for the capture prototype. No dependencies.
// Serves the page, the MediaPipe bundle and its WASM from node_modules, and the
// hand model from disk, so capture works offline once installed.
import { createServer } from 'node:http';
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { join, normalize, extname, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.FITTED_PORT || 7780);

const MOUNTS = [
  ['/capture/', join(ROOT, 'capture')],
  ['/vendor/tasks-vision/', join(ROOT, 'node_modules', '@mediapipe', 'tasks-vision')],
  ['/design/', join(ROOT, 'design')],
  ['/vendor/three/', join(ROOT, 'node_modules', 'three')],
];
const RENDER_DIR = join(ROOT, 'design', 'out');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.map': 'application/json',
  '.png': 'image/png',
  '.stl': 'model/stl',
};

async function send(res, file) {
  const info = await stat(file);
  const target = info.isDirectory() ? join(file, 'index.html') : file;
  const body = await readFile(target);
  res.writeHead(200, { 'Content-Type': TYPES[extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(body);
}

async function handle(req, res) {
  let path;
  try { path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400); return res.end('bad path'); }

  // The render page saves its PNGs here. Bare file names only, PNG only.
  if (req.method === 'POST' && path.startsWith('/design/out/')) {
    const name = path.slice('/design/out/'.length);
    if (!/^[\w-]+\.png$/.test(name)) { res.writeHead(400); return res.end('png file name only'); }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const b64 = Buffer.concat(chunks).toString().replace(/^data:image\/png;base64,/, '');
    await mkdir(RENDER_DIR, { recursive: true });
    await writeFile(join(RENDER_DIR, name), Buffer.from(b64, 'base64'));
    res.writeHead(200); return res.end('saved');
  }

  if (path === '/' || path === '/capture') {
    res.writeHead(302, { Location: '/capture/' });
    return res.end();
  }
  for (const [prefix, dir] of MOUNTS) {
    if (!path.startsWith(prefix)) continue;
    const file = normalize(join(dir, path.slice(prefix.length)));
    // Never serve anything outside the mount, whatever the URL says.
    if (file !== dir && !file.startsWith(dir + sep)) { res.writeHead(403); return res.end('forbidden'); }
    try { return await send(res, file); }
    catch { res.writeHead(404); return res.end('not found'); }
  }
  res.writeHead(404); res.end('not found');
}

// Browsers resolve "localhost" to IPv4 or IPv6 depending on the machine, so listen on
// both loopback addresses. Neither is reachable from other computers.
for (const host of ['127.0.0.1', '::1']) {
  createServer(handle).listen(PORT, host).on('error', err => console.warn(`not listening on ${host}: ${err.message}`));
}
console.log(`fitted capture → http://localhost:${PORT}/capture/`);
