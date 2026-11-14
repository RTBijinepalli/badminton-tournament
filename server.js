#!/usr/bin/env node
// Wi-Fi server for the tournament app: serves the page to phones on the same
// network and keeps one shared copy of each tournament on this computer.
// No dependencies, just Node 18+.
//
//   node server.js                                   start on port 8080
//   ADMIN_PIN=1234 SUPER_ADMIN_PIN=5678 node server.js  set your own PINs
//   PORT=3000 node server.js                         pick another port
//
// Admin PINs are checked here, not in the page. Saves without a correct PIN
// are refused; anyone on the network can still view.
//
// Tournaments are saved as JSON files in ./data (one per ?t= tournament id).

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT) || 8080;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const MAX_BODY = 5 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PINS = { super_admin: process.env.SUPER_ADMIN_PIN || '2809', admin: process.env.ADMIN_PIN || '2025' };
const DEFAULT_PINS = !process.env.ADMIN_PIN || !process.env.SUPER_ADMIN_PIN;

// After 20 wrong PINs in 10 minutes, PIN checks pause for everyone.
let pinFailures = [];
function roleForPin(pin) {
  const now = Date.now();
  pinFailures = pinFailures.filter(t => now - t < 10 * 60 * 1000);
  if (pinFailures.length >= 20) return { locked: true };
  const role = pin && pin === PINS.super_admin ? 'super_admin' : pin && pin === PINS.admin ? 'admin' : null;
  if (!role) pinFailures.push(now);
  return { role };
}

// Only these files are served, so ./data and .git stay private.
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/tournament-v2.html': ['tournament-v2.html', 'text/html; charset=utf-8'],
  '/tournament.html': ['tournament.html', 'text/html; charset=utf-8'],
  '/sample-import.json': ['sample-import.json', 'application/json'],
  '/sample-roster.xlsx': ['sample-roster.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
};

// ── Storage ──────────────────────────────────────────────────────
const tournaments = new Map(); // id -> { state, version } (null = known missing)
const listeners = new Map();   // id -> Set of SSE responses

function fileFor(id) { return path.join(DATA_DIR, id + '.json'); }

function load(id) {
  if (tournaments.has(id)) return tournaments.get(id);
  let t = null;
  try { t = JSON.parse(fs.readFileSync(fileFor(id), 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`Could not read ${fileFor(id)}:`, e.message);
  }
  tournaments.set(id, t);
  return t;
}

function save(id, t) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = fileFor(id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(t));
  fs.renameSync(tmp, fileFor(id)); // atomic: a crash never leaves half a file
  tournaments.set(id, t);
}

function broadcast(id, t) {
  const subs = listeners.get(id);
  if (!subs) return;
  const msg = `data: ${JSON.stringify(t)}\n\n`;
  for (const res of subs) res.write(msg);
}

// ── HTTP helpers ─────────────────────────────────────────────────
function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('bad json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function lanUrls() {
  const urls = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) urls.push(`http://${a.address}:${PORT}`);
    }
  }
  return urls;
}

// ── Routes ───────────────────────────────────────────────────────
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method === 'GET' && STATIC[p]) {
    const [file, type] = STATIC[p];
    return fs.readFile(path.join(ROOT, file), (err, buf) =>
      err ? send(res, 404, 'Not found', 'text/plain') : send(res, 200, buf, type));
  }

  if (req.method === 'GET' && p === '/api/health') {
    return send(res, 200, { app: 'badminton-tournament', lanUrls: lanUrls() });
  }

  if (req.method === 'POST' && p === '/api/check-pin') {
    const body = await readJson(req);
    const r = roleForPin(body && String(body.pin || ''));
    return r.locked ? send(res, 429, { error: 'too many wrong PINs' }) : send(res, 200, { role: r.role });
  }

  const m = p.match(/^\/api\/tournaments\/([^/]+)(\/events)?$/);
  if (!m) return send(res, 404, { error: 'not found' });
  const id = decodeURIComponent(m[1]);
  if (!ID_RE.test(id)) return send(res, 400, { error: 'bad tournament id' });

  // Live updates (Server-Sent Events). Sends the current copy first.
  if (m[2]) {
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    const t = load(id);
    if (t) res.write(`data: ${JSON.stringify(t)}\n\n`);
    if (!listeners.has(id)) listeners.set(id, new Set());
    listeners.get(id).add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); listeners.get(id).delete(res); });
    return;
  }

  if (req.method === 'GET') {
    const t = load(id);
    return t ? send(res, 200, t) : send(res, 404, { error: 'no such tournament' });
  }

  if (req.method === 'POST' || req.method === 'PUT') {
    const r = roleForPin(req.headers['x-admin-pin']);
    if (r.locked) return send(res, 429, { error: 'too many wrong PINs' });
    if (!r.role) return send(res, 401, { error: 'admin PIN required' });
  }

  if (req.method === 'POST') { // create
    const body = await readJson(req);
    if (!body || typeof body.state !== 'object') return send(res, 400, { error: 'state required' });
    if (load(id)) return send(res, 409, { error: 'already exists' });
    const t = { state: body.state, version: 1 };
    save(id, t);
    broadcast(id, t);
    return send(res, 201, { version: 1 });
  }

  if (req.method === 'PUT') { // update, only if the client saw the latest version
    const body = await readJson(req);
    if (!body || typeof body.state !== 'object' || !Number.isInteger(body.version)) {
      return send(res, 400, { error: 'state and version required' });
    }
    const cur = load(id);
    if (!cur) return send(res, 404, { error: 'no such tournament' });
    if (body.version !== cur.version) return send(res, 409, { version: cur.version });
    const t = { state: body.state, version: cur.version + 1 };
    save(id, t);
    broadcast(id, t);
    return send(res, 200, { version: t.version });
  }

  send(res, 405, { error: 'method not allowed' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(e => {
    if (!res.headersSent) send(res, e.status || 500, { error: e.message });
    if (!e.status) console.error(e);
  });
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop the other server, or run: PORT=8081 node server.js`);
  } else {
    console.error(e);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log('\nBadminton Tournament server is running.\n');
  console.log(`  On this computer:  http://localhost:${PORT}`);
  const urls = lanUrls();
  if (urls.length) {
    console.log('  On phones (same Wi-Fi):');
    urls.forEach(u => console.log('    ' + u));
  } else {
    console.log('  No Wi-Fi address found. Is this computer connected to a network?');
  }
  console.log(`\nTournaments are saved in ${DATA_DIR}`);
  if (DEFAULT_PINS) console.log('Using the default admin PINs. Set your own with ADMIN_PIN=.... SUPER_ADMIN_PIN=.... node server.js');
  console.log('Press Ctrl+C to stop.\n');
});
