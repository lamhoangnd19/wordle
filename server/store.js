import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { applyGuess, chooseWord } from './engine.js';

const players = new Map();
let sql;
export const persistent = Boolean(process.env.DATABASE_URL);
export function database() {
  if (!sql) sql = postgres(process.env.DATABASE_URL, { max: 3, idle_timeout: 20, connect_timeout: 10, prepare: false });
  return sql;
}
export async function setup() {
  const db = database();
  await db`CREATE TABLE IF NOT EXISTS club_players (id uuid PRIMARY KEY, token text UNIQUE NOT NULL, name text NOT NULL, wins integer NOT NULL DEFAULT 0, played integer NOT NULL DEFAULT 0, streak integer NOT NULL DEFAULT 0, best integer NOT NULL DEFAULT 0, attempts integer NOT NULL DEFAULT 0, game jsonb, created_at timestamptz NOT NULL DEFAULT now())`;
  await db`CREATE UNIQUE INDEX IF NOT EXISTS club_player_name ON club_players (lower(name))`;
}
function requireStorage() {
  if (!persistent && (process.env.VERCEL || process.env.NODE_ENV === 'production')) throw new Error('Cần cấu hình DATABASE_URL để lưu bảng xếp hạng.');
}
export async function findPlayer(token) {
  requireStorage();
  if (!token) return null;
  if (!persistent) return players.get(token) || null;
  return (await database()`SELECT * FROM club_players WHERE token = ${token}`)[0] || null;
}
export async function join(name, token) {
  requireStorage();
  const player = { id: randomUUID(), token, name, wins: 0, played: 0, streak: 0, best: 0, attempts: 0, game: null };
  if (!persistent) {
    if ([...players.values()].some(p => p.name.toLowerCase() === name.toLowerCase())) throw new Error('Tên này đã được sử dụng. Chọn một tên khác nhé!');
    players.set(token, player); return player;
  }
  try { return (await database()`INSERT INTO club_players (id, token, name) VALUES (${player.id}, ${token}, ${name}) RETURNING *`)[0]; }
  catch (error) { if (error.code === '23505') throw new Error('Tên này đã được sử dụng. Chọn một tên khác nhé!'); throw error; }
}
function mutate(player, action, body) {
  if (action === 'start') {
    if (player.game?.status === 'playing') return player;
    player.game = { id: randomUUID(), answer: chooseWord(player.game?.answer), guesses: [], status: 'playing' };
  } else {
    if (!player.game || body.gameId !== player.game.id) throw new Error('Ván chơi đã thay đổi. Tải lại trang để tiếp tục.');
    applyGuess(player.game, body.guess);
    if (player.game.status !== 'playing') {
      player.played++;
      if (player.game.status === 'won') {
        player.wins++; player.streak++; player.attempts += player.game.guesses.length;
        player.best = Math.max(player.best, player.streak);
      } else player.streak = 0;
    }
  }
  return player;
}
export async function updatePlayer(token, action, body) {
  requireStorage();
  if (!persistent) {
    const player = players.get(token);
    if (!player) throw new Error('Hãy tham gia Club trước khi chơi.');
    // Work on a copy, so rejected guesses cannot change stored state.
    const updated = mutate(structuredClone(player), action, body);
    players.set(token, updated); return updated;
  }
  return database().begin(async tx => {
    const player = (await tx`SELECT * FROM club_players WHERE token = ${token} FOR UPDATE`)[0];
    if (!player) throw new Error('Hãy tham gia Club trước khi chơi.');
    mutate(player, action, body);
    await tx`UPDATE club_players SET game = ${tx.json(player.game)}, wins = ${player.wins}, played = ${player.played}, streak = ${player.streak}, best = ${player.best}, attempts = ${player.attempts} WHERE id = ${player.id}`;
    return player;
  });
}
export async function leaderboard() {
  requireStorage();
  const all = persistent ? await database()`SELECT id, name, wins, played, streak, best, attempts FROM club_players WHERE played > 0 ORDER BY wins DESC, CASE WHEN wins > 0 THEN attempts::float / wins ELSE 999 END ASC, lower(name) ASC` : [...players.values()].filter(p => p.played > 0).sort((a,b) => b.wins-a.wins || (a.wins ? a.attempts/a.wins : 999)-(b.wins ? b.attempts/b.wins : 999) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return all.map((p, index) => ({ id: p.id, name: p.name, wins: p.wins, played: p.played, streak: p.streak, rank: index + 1, average: p.wins ? +(p.attempts/p.wins).toFixed(1) : null }));
}
