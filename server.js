// Slither Arena server: multi-room, shared food, 20Hz state broadcast
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 3000, R = 2000, MAXP = 20, TICK = 50;
const HTML = path.join(__dirname, 'slither-arena.html');

const STATIC = { '/manifest.json': 'application/manifest+json', '/sw.js': 'text/javascript', '/icon-192.png': 'image/png', '/icon-512.png': 'image/png' };
const srv = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }
  const u = req.url.split('?')[0];
  if (STATIC[u]) return fs.readFile(path.join(__dirname, u.slice(1)), (e, d) => {
    if (e) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': STATIC[u], 'Cache-Control': 'no-cache' }); res.end(d);
  });
  fs.readFile(HTML, (e, d) => {
    if (e) { res.writeHead(500); return res.end('slither-arena.html must be next to server.js'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(d);
  });
});
const wss = new WebSocketServer({ server: srv, maxPayload: 8192, perMessageDeflate: false });

const rooms = new Map();
let fid = 1, pid = 1;
const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
const bc = (r, o, except) => { const s = JSON.stringify(o); for (const p of r.players.values()) if (p.ws !== except && p.ws.readyState === 1) p.ws.send(s); };
const num = (v, lo, hi, d = 0) => { v = +v; return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d; };
const hex = s => /^#[0-9a-fA-F]{6}$/.test(s) ? s : '#00e5ff';
const cleanSk = k => ({ a: hex(k && k.a), b: hex(k && k.b), p: ['dash', 'stripe', 'dot', 'rainbow'].includes(k && k.p) ? k.p : 'dash' });
const setInfo = (p, m) => { p.n = String(m.n || 'Player').slice(0, 18); p.sk = cleanSk(m.sk); };

// food = [id, x, y, hue, value, isGem]
function addFoodAt(r, x, y, v, h, gem) {
  const f = [fid++, x | 0, y | 0, h == null ? (Math.random() * 360) | 0 : h, v, gem ? 1 : 0];
  r.food.set(f[0], f); r.fa.push(f);
}
function addFood(r, n) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * 6.283, d = Math.sqrt(Math.random()) * (R - 50), gem = Math.random() < .015;
    addFoodAt(r, Math.cos(a) * d, Math.sin(a) * d, gem ? 3 : Math.random() < .12 ? 2 : 1, null, gem);
  }
}
function mkRoom(id, name, perm) {
  const r = { id, name, perm, players: new Map(), food: new Map(), fa: [], fr: [] };
  rooms.set(id, r); addFood(r, 260); r.fa = []; return r;
}
['Server 1', 'Server 2', 'Server 3'].forEach((n, i) => mkRoom('d' + (i + 1), n, true));

function leave(ws) {
  const r = ws.room, p = ws.p;
  if (!r) return;
  r.players.delete(p.id);
  bc(r, { t: 'pl', id: p.id });
  if (!r.perm && r.players.size === 0) rooms.delete(r.id);
  ws.room = null; ws.p = null;
}
function join(ws, id, m) {
  leave(ws);
  const r = rooms.get(id);
  if (!r) return send(ws, { t: 'err', m: 'Server not found' });
  if (r.players.size >= MAXP) return send(ws, { t: 'err', m: 'Server full' });
  const p = { id: pid++, ws, alive: true, x: 0, y: 0, a: 0, l: 14, b: 0, seen: 0 };
  setInfo(p, m); ws.p = p; ws.room = r; r.players.set(p.id, p);
  send(ws, {
    t: 'joined', id: p.id, name: r.name, R,
    players: [...r.players.values()].filter(q => q !== p).map(q => ({ id: q.id, n: q.n, sk: q.sk })),
    food: [...r.food.values()]
  });
  bc(r, { t: 'pj', id: p.id, n: p.n, sk: p.sk }, ws);
}

wss.on('connection', ws => {
  ws.isAlive = true; ws.room = null; ws.p = null;
  ws.on('pong', () => ws.isAlive = true);
  ws.on('error', () => {});
  ws.on('close', () => leave(ws));
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    switch (m.t) {
      case 'get_rooms':
        send(ws, { t: 'room_list', rooms: [...rooms.values()].map(r => ({ id: r.id, name: r.name, players: r.players.size, max: MAXP })) });
        break;
      case 'create_room': {
        if (rooms.size >= 30) return send(ws, { t: 'err', m: 'Too many servers' });
        const id = 'c' + Math.random().toString(36).slice(2, 7);
        mkRoom(id, String(m.name || 'Custom Server').slice(0, 16), false);
        join(ws, id, m); break;
      }
      case 'join_room': join(ws, m.roomId, m); break;
      case 'leave': leave(ws); break;
      case 'spawn': {
        const p = ws.p; if (!p) break;
        setInfo(p, m); p.alive = true; p.l = 14; p.seen = 0;
        bc(ws.room, { t: 'pj', id: p.id, n: p.n, sk: p.sk }, ws); break;
      }
      case 'u': {
        const p = ws.p, r = ws.room; if (!p || !p.alive) break;
        p.x = num(m.x, -R, R); p.y = num(m.y, -R, R); p.a = num(m.a, -7, 7);
        p.l = num(m.l, 5, 3000, 14); p.b = m.b ? 1 : 0; p.seen = Date.now();
        if (Array.isArray(m.e)) for (const i of m.e.slice(0, 40)) {
          const f = r.food.get(i);
          if (f && Math.hypot(f[1] - p.x, f[2] - p.y) < 140) { r.food.delete(i); r.fr.push(i); }
        }
        break;
      }
      case 'd': {
        const p = ws.p, r = ws.room; if (!p || !p.alive) break;
        p.alive = false;
        if (Array.isArray(m.d)) for (const q of m.d.slice(0, 60))
          if (Array.isArray(q) && r.food.size < 900) addFoodAt(r, num(q[0], -R, R), num(q[1], -R, R), 1.5);
        bc(r, { t: 'pd', id: p.id }); break;
      }
    }
  });
});

setInterval(() => {
  const now = Date.now();
  for (const r of rooms.values()) {
    if (!r.players.size) continue;
    if (r.food.size < 260) addFood(r, Math.min(10, 260 - r.food.size));
    const st = [];
    for (const p of r.players.values()) {
      if (!p.alive || !p.seen) continue;
      if (now - p.seen > 5000) { p.alive = false; bc(r, { t: 'pd', id: p.id }); continue; }
      st.push([p.id, p.x | 0, p.y | 0, +p.a.toFixed(2), p.l | 0, p.b]);
    }
    const out = { t: 'st', p: st };
    if (r.fa.length) { out.fa = r.fa; r.fa = []; }
    if (r.fr.length) { out.fr = r.fr; r.fr = []; }
    bc(r, out);
  }
}, TICK);

// keep connections alive behind proxies / drop dead sockets
setInterval(() => wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); }), 30000);

srv.listen(PORT, () => console.log('Slither Arena running on http://localhost:' + PORT));
