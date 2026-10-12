import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { applyGuess, chooseWord } from './engine.js';

export const ROUND_MS = 10 * 60 * 1000;
const players = new Map();
const rounds = new Map();
const memoryLocks = new Map();
let sql;

export const persistent = Boolean(process.env.DATABASE_URL);

export function database() {
  if (!sql) sql = postgres(process.env.DATABASE_URL, { max: 3, idle_timeout: 20, connect_timeout: 10, prepare: false });
  return sql;
}

export async function setup(connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('Set DATABASE_URL first.');
  const migration = postgres(connectionString, { max: 1, connect_timeout: 10, prepare: false });
  try {
    await migration`CREATE TABLE IF NOT EXISTS club_players (id uuid PRIMARY KEY, token text UNIQUE NOT NULL, name text NOT NULL, wins integer NOT NULL DEFAULT 0, played integer NOT NULL DEFAULT 0, streak integer NOT NULL DEFAULT 0, best integer NOT NULL DEFAULT 0, attempts integer NOT NULL DEFAULT 0, game jsonb, created_at timestamptz NOT NULL DEFAULT now())`;
    await migration`CREATE UNIQUE INDEX IF NOT EXISTS club_player_name ON club_players (lower(name))`;
    await migration`CREATE TABLE IF NOT EXISTS club_rounds (slot bigint PRIMARY KEY, answer char(5) NOT NULL, starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`;
  } finally {
    await migration.end();
  }
}

function requireStorage() {
  if (!persistent && (process.env.VERCEL || process.env.NODE_ENV === 'production')) throw new Error('Cần cấu hình DATABASE_URL để lưu bảng xếp hạng.');
}

export function roundWindow(now = Date.now()) {
  const timestamp = Number(now);
  const startsAt = Math.floor(timestamp / ROUND_MS) * ROUND_MS;
  return { slot: String(startsAt), startsAt, endsAt: startsAt + ROUND_MS };
}

function normalizeRound(row) {
  return {
    slot: String(row.slot),
    answer: row.answer.trim(),
    startsAt: new Date(row.starts_at).getTime(),
    endsAt: new Date(row.ends_at).getTime(),
  };
}

export async function getCurrentRound(query = persistent ? database() : null, now = Date.now()) {
  requireStorage();
  const window = roundWindow(now);
  if (!persistent) {
    if (!rounds.has(window.slot)) {
      const previous = [...rounds.values()].sort((a, b) => b.startsAt - a.startsAt)[0];
      rounds.set(window.slot, { ...window, answer: chooseWord(previous?.answer) });
    }
    return rounds.get(window.slot);
  }

  let row = (await query`SELECT slot, answer, starts_at, ends_at FROM club_rounds WHERE slot = ${window.slot}`)[0];
  if (!row) {
    const previous = (await query`SELECT answer FROM club_rounds WHERE slot < ${window.slot} ORDER BY slot DESC LIMIT 1`)[0];
    const answer = chooseWord(previous?.answer?.trim());
    row = (await query`
      INSERT INTO club_rounds (slot, answer, starts_at, ends_at)
      VALUES (${window.slot}, ${answer}, ${new Date(window.startsAt)}, ${new Date(window.endsAt)})
      ON CONFLICT (slot) DO NOTHING
      RETURNING slot, answer, starts_at, ends_at
    `)[0];
    if (!row) row = (await query`SELECT slot, answer, starts_at, ends_at FROM club_rounds WHERE slot = ${window.slot}`)[0];
  }
  return normalizeRound(row);
}

function syncPlayerRound(player, round) {
  if (player.game?.roundId !== round.slot) {
    player.game = { id: round.slot, roundId: round.slot, answer: round.answer, guesses: [], status: 'playing' };
    return true;
  }
  return false;
}

async function savePlayer(query, player) {
  await query`UPDATE club_players SET game = ${query.json(player.game)}, wins = ${player.wins}, played = ${player.played}, streak = ${player.streak}, best = ${player.best}, attempts = ${player.attempts} WHERE id = ${player.id}`;
}

export async function findPlayer(token) {
  requireStorage();
  if (!token) return null;
  if (!persistent) return players.get(token) || null;
  return (await database()`SELECT * FROM club_players WHERE token = ${token}`)[0] || null;
}

export async function loadState(token, now = Date.now()) {
  requireStorage();
  if (!persistent) {
    const round = await getCurrentRound(null, now);
    const player = token ? players.get(token) || null : null;
    if (player) syncPlayerRound(player, round);
    return { player, round };
  }

  const db = database();
  const round = await getCurrentRound(db, now);
  if (!token) return { player: null, round };
  return db.begin(async tx => {
    const player = (await tx`SELECT * FROM club_players WHERE token = ${token} FOR UPDATE`)[0] || null;
    if (player && syncPlayerRound(player, round)) await savePlayer(tx, player);
    return { player, round };
  });
}

export async function join(name, token) {
  requireStorage();
  const player = { id: randomUUID(), token, name, wins: 0, played: 0, streak: 0, best: 0, attempts: 0, game: null };
  if (!persistent) {
    if ([...players.values()].some(p => p.name.toLowerCase() === name.toLowerCase())) throw new Error('Tên này đã được sử dụng. Chọn một tên khác nhé!');
    players.set(token, player);
    return player;
  }
  try {
    return (await database()`INSERT INTO club_players (id, token, name) VALUES (${player.id}, ${token}, ${name}) RETURNING *`)[0];
  } catch (error) {
    if (error.code === '23505') throw new Error('Tên này đã được sử dụng. Chọn một tên khác nhé!');
    throw error;
  }
}

function applyPlayerAction(player, round, action, body) {
  syncPlayerRound(player, round);
  if (action === 'sync' || action === 'start') return player;
  if (action !== 'guess') throw new Error('Thao tác không hợp lệ.');
  if (body.gameId !== player.game.id) throw new Error('Phiên 10 phút này đã kết thúc. Đang tải từ mới…');

  const previousStatus = player.game.status;
  applyGuess(player.game, body.guess);
  if (previousStatus === 'playing' && player.game.status !== 'playing') {
    player.played++;
    if (player.game.status === 'won') {
      player.wins++;
      player.streak++;
      player.attempts += player.game.guesses.length;
      player.best = Math.max(player.best, player.streak);
    } else {
      player.streak = 0;
    }
  }
  return player;
}

async function withMemoryLock(token, operation) {
  const previous = memoryLocks.get(token) || Promise.resolve();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  memoryLocks.set(token, previous.then(() => gate));
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

export async function updatePlayer(token, action, body = {}, now = Date.now()) {
  requireStorage();
  if (!persistent) {
    return withMemoryLock(token, async () => {
      const original = players.get(token);
      if (!original) throw new Error('Hãy tham gia Club trước khi chơi.');
      const round = await getCurrentRound(null, now);
      const player = applyPlayerAction(structuredClone(original), round, action, body);
      players.set(token, player);
      return { player, round };
    });
  }

  return database().begin(async tx => {
    const round = await getCurrentRound(tx, now);
    const player = (await tx`SELECT * FROM club_players WHERE token = ${token} FOR UPDATE`)[0];
    if (!player) throw new Error('Hãy tham gia Club trước khi chơi.');
    applyPlayerAction(player, round, action, body);
    await savePlayer(tx, player);
    return { player, round };
  });
}

export async function leaderboard() {
  requireStorage();
  const all = persistent
    ? await database()`SELECT id, name, wins, played, streak, best, attempts FROM club_players WHERE played > 0 ORDER BY wins DESC, CASE WHEN wins > 0 THEN attempts::float / wins ELSE 999 END ASC, lower(name) ASC`
    : [...players.values()].filter(p => p.played > 0).sort((a,b) => b.wins-a.wins || (a.wins ? a.attempts/a.wins : 999)-(b.wins ? b.attempts/b.wins : 999) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

  return all.map((p, index) => ({
    id: p.id,
    name: p.name,
    wins: p.wins,
    played: p.played,
    streak: p.streak,
    rank: index + 1,
    average: p.wins ? +(p.attempts / p.wins).toFixed(1) : null,
  }));
}
