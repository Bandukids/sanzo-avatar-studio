import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { videoConfiguration, VideoSession } from './lib/video-session.mjs';
import { redact } from './lib/secrets.mjs';
import { CHARACTERS } from './public/service-config.js';

const root = path.dirname(fileURLToPath(import.meta.url)), publicRoot = path.join(root, 'public');
const port = Number(process.env.PORT) || 3088, token = randomBytes(24).toString('hex');
const sockets = new WebSocketServer({ noServer: true, maxPayload: 64000 });
function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
function localOrigin(req) { return [`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host) && (!req.headers.origin || [`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(req.headers.origin)); }
export const server = http.createServer(async (req, res) => {
  if (!localOrigin(req)) return json(res, 403, { error: '此原型只接受本机页面请求。' });
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  try {
    if (url.pathname === '/api/status' && req.method === 'GET') {
      return json(res, 200, { ...videoConfiguration(), csrf: token, prototype: true, version: '0.9' });
    }
    if (url.pathname === '/api/plan' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' }); return res.end(await readFile(path.join(root, 'docs', '实时语音方案.md'))); }
    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: '未找到接口。' });
    if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: '方法不支持。' });
    if (['/index.html', '/speech.html', '/roleplay-review.html'].includes(url.pathname)) { res.writeHead(302, { Location: '/' }); return res.end(); }
    const requested = decodeURIComponent(url.pathname);
    const avatarRoute = /^\/avatar\/([^/]+)\/?$/.exec(requested);
    if (avatarRoute && !Object.hasOwn(CHARACTERS, avatarRoute[1])) {
      res.writeHead(302, { Location: '/' });
      return res.end();
    }
    const relative = requested === '/' ? '/gallery.html' : avatarRoute ? '/live.html' : requested;
    const filename = path.resolve(publicRoot, '.' + relative);
    if (!filename.startsWith(publicRoot + path.sep)) return json(res, 403, { error: '路径不可访问。' });
    const info = await stat(filename); if (!info.isFile()) throw new Error('未找到文件。');
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.png': 'image/png', '.wav': 'audio/wav' };
    res.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': 'no-cache' }); res.end(req.method === 'HEAD' ? undefined : await readFile(filename));
  } catch (error) { if (!res.headersSent) json(res, error.code === 'ENOENT' ? 404 : 400, { error: redact(error.message) }); else res.end(); }
});
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (!localOrigin(req) || url.searchParams.get('token') !== token || url.pathname !== '/api/live' || sockets.clients.size >= 1) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
  sockets.handleUpgrade(req, socket, head, ws => {
    const live = new VideoSession(ws); let initialized = false;
    const timer = setTimeout(() => { live.close(); ws.close(1000, 'session-limit'); }, 20 * 60 * 1000);
    ws.on('close', () => { clearTimeout(timer); live.close(); }); ws.on('error', () => live.close());
    ws.on('message', async (data, binary) => {
      try {
        if (binary) { if (initialized) live.audio(data); return; }
        const message = JSON.parse(data.toString());
        if (message.type === 'start' && !initialized) { initialized = true; await live.start(message); }
        else if (message.type === 'stop') { live.close(); ws.close(); }
        else if (initialized && message.type === 'interrupt') live.interrupt();
        else if (initialized && message.type === 'rtc_joined') live.join();
        else if (initialized && message.type === 'mute') live.setMuted(Boolean(message.muted));
        else if (initialized && message.type === 'text') await live.respond(message.text);
      } catch (error) { live.fail(error); }
    });
  });
});
server.listen(port, '127.0.0.1', () => console.log(`Avatar Live ready: http://127.0.0.1:${port}`));
function shutdown() { for (const ws of sockets.clients) ws.close(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
