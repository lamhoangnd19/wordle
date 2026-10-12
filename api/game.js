import { createHash, randomBytes } from 'node:crypto';
import { findPlayer, join, updatePlayer, leaderboard, persistent } from '../server/store.js';
import { publicGame } from '../server/engine.js';
const digest = token => createHash('sha256').update(token).digest('hex');
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    if (!['GET','POST'].includes(req.method)) { res.statusCode = 405; res.setHeader('Allow','GET, POST'); return res.end(JSON.stringify({ error: 'Phương thức không hỗ trợ.' })); }
    const rawToken = (req.headers.cookie || '').match(/(?:^|;\s*)club_session=([a-f0-9]{64})(?:;|$)/)?.[1];
    let player = await findPlayer(rawToken ? digest(rawToken) : null);
    if (req.method === 'POST') {
      if (req.headers.origin && req.headers.origin !== `https://${req.headers.host}` && req.headers.origin !== `http://${req.headers.host}`) throw new Error('Yêu cầu không hợp lệ.');
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
      if (body.action === 'join') {
        if (!player) {
          const name = String(body.name || '').trim().normalize('NFC');
          if (!/^[\p{L}\p{N} _.-]{2,20}$/u.test(name)) throw new Error('Tên gồm 2–20 ký tự: chữ, số, khoảng trắng, dấu _ . hoặc -');
          const token = randomBytes(32).toString('hex');
          player = await join(name, digest(token));
          res.setHeader('Set-Cookie', `club_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${process.env.VERCEL ? '; Secure' : ''}`);
        }
      } else if (['start','guess'].includes(body.action)) {
        if (!player) throw new Error('Hãy tham gia Club trước khi chơi.');
        player = await updatePlayer(player.token, body.action, body);
      } else throw new Error('Thao tác không hợp lệ.');
    }
    const ranks = await leaderboard();
    const profile = player ? { id: player.id, name: player.name, wins: player.wins, played: player.played, streak: player.streak, best: player.best, rank: ranks.find(p=>p.id===player.id)?.rank || null } : null;
    res.end(JSON.stringify({ player: profile, game: publicGame(player?.game), leaderboard: ranks.slice(0,50), storage: persistent ? 'postgres' : 'demo' }));
  } catch(error) {
    const safe = !error.code && !error.message.includes('DATABASE_URL') && !error.message.includes('JSON');
    res.statusCode = safe ? 400 : 503;
    if (!safe) console.error('Wordle API error:', error.code || error.name);
    res.end(JSON.stringify({ error: safe ? error.message : 'Máy chủ chưa sẵn sàng. Kiểm tra kết nối và cấu hình cơ sở dữ liệu.' }));
  }
}
