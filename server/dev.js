import http from 'node:http';
import { createServer } from 'vite';
import handler from '../api/game.js';
const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
http.createServer(async (req, res) => {
  if (req.url.split('?')[0] !== '/api/game') return vite.middlewares(req, res);
  if (req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 4096) { res.writeHead(413); return res.end(); } }
    try { req.body = JSON.parse(raw); } catch { res.writeHead(400); return res.end(JSON.stringify({error:'Yêu cầu không hợp lệ.'})); }
  }
  await handler(req, res);
}).listen(5173, '127.0.0.1', () => console.log('Wordle Club: http://localhost:5173'));
