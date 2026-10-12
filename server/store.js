import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { applyGuess, chooseWord } from './engine.js';

export const ROUND_MS = 600000;
export const ONLINE_MS = 30000;
const SCORE_WINDOW_MS = ROUND_MS / 5;
const players = new Map(), rounds = new Map(), skipRequests = new Map();
let currentRoundSlot = null, memoryQueue = Promise.resolve(), sql;

export const persistent = Boolean(process.env.DATABASE_URL);
export function database() {
  if (!sql) sql = postgres(process.env.DATABASE_URL, { max: 3, idle_timeout: 20, connect_timeout: 10, prepare: false });
  return sql;
}
export async function setup(connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('Set DATABASE_URL first.');
  const db = postgres(connectionString, { max: 1, connect_timeout: 10, prepare: false });
  try {
    await db`CREATE TABLE IF NOT EXISTS club_players (id uuid PRIMARY KEY, token text UNIQUE NOT NULL, name text NOT NULL, wins integer NOT NULL DEFAULT 0, played integer NOT NULL DEFAULT 0, streak integer NOT NULL DEFAULT 0, best integer NOT NULL DEFAULT 0, attempts integer NOT NULL DEFAULT 0, game jsonb, created_at timestamptz NOT NULL DEFAULT now())`;
    await db`ALTER TABLE club_players ADD COLUMN IF NOT EXISTS last_seen timestamptz`;
    await db`ALTER TABLE club_players ADD COLUMN IF NOT EXISTS solved integer NOT NULL DEFAULT 0`;
    await db`UPDATE club_players SET solved=wins WHERE solved=0 AND wins>0`;
    await db`CREATE UNIQUE INDEX IF NOT EXISTS club_player_name ON club_players (lower(name))`;
    await db`CREATE TABLE IF NOT EXISTS club_rounds (slot bigint PRIMARY KEY, answer char(5) NOT NULL, starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`;
    await db`CREATE TABLE IF NOT EXISTS club_game_state (id smallint PRIMARY KEY CHECK (id = 1), current_slot bigint REFERENCES club_rounds(slot))`;
    await db`INSERT INTO club_game_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING`;
    await db`CREATE TABLE IF NOT EXISTS club_skip_requests (id uuid PRIMARY KEY, round_slot bigint NOT NULL REFERENCES club_rounds(slot), proposed_by uuid NOT NULL REFERENCES club_players(id), status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','passed','rejected')), created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz)`;
    await db`CREATE UNIQUE INDEX IF NOT EXISTS club_active_skip_request ON club_skip_requests (round_slot) WHERE status = 'active'`;
    await db`CREATE TABLE IF NOT EXISTS club_skip_voters (request_id uuid NOT NULL REFERENCES club_skip_requests(id) ON DELETE CASCADE, player_id uuid NOT NULL REFERENCES club_players(id), accepted boolean NOT NULL DEFAULT false, PRIMARY KEY (request_id, player_id))`;
  } finally { await db.end(); }
}
function requireStorage() {
  if (!persistent && (process.env.VERCEL || process.env.NODE_ENV === 'production')) throw new Error('Cần cấu hình DATABASE_URL để lưu bảng xếp hạng.');
}
export function roundWindow(now = Date.now()) {
  const startsAt = Math.floor(Number(now) / ROUND_MS) * ROUND_MS;
  return { slot: String(startsAt), startsAt, endsAt: startsAt + ROUND_MS };
}
const normalizeRound = row => ({ slot: String(row.slot), answer: row.answer.trim(), startsAt: +new Date(row.starts_at), endsAt: +new Date(row.ends_at) });
function newMemoryRound(now, previous, aligned = false) {
  const window = aligned ? roundWindow(now) : { startsAt: Number(now), endsAt: Number(now) + ROUND_MS };
  let slot = window.startsAt;
  while (rounds.has(String(slot))) slot++;
  const round = { slot: String(slot), ...window, answer: chooseWord(previous?.answer) };
  rounds.set(round.slot, round); currentRoundSlot = round.slot; return round;
}
async function newDatabaseRound(db, now, previous) {
  let slot = Number(now), row;
  while (!row) {
    row = (await db`INSERT INTO club_rounds (slot,answer,starts_at,ends_at) VALUES (${String(slot)},${chooseWord(previous?.answer)},${new Date(Number(now))},${new Date(Number(now)+ROUND_MS)}) ON CONFLICT (slot) DO NOTHING RETURNING slot,answer,starts_at,ends_at`)[0];
    slot++;
  }
  await db`UPDATE club_game_state SET current_slot=${row.slot} WHERE id=1`;
  return normalizeRound(row);
}
export async function getCurrentRound(db = persistent ? database() : null, now = Date.now()) {
  requireStorage(); const timestamp = Number(now);
  if (!persistent) {
    const current = currentRoundSlot ? rounds.get(currentRoundSlot) : null;
    return current?.endsAt > timestamp ? current : newMemoryRound(timestamp, current, !current);
  }
  await db`INSERT INTO club_game_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING`;
  const state = (await db`SELECT current_slot FROM club_game_state WHERE id=1 FOR UPDATE`)[0];
  let row = state?.current_slot ? (await db`SELECT slot,answer,starts_at,ends_at FROM club_rounds WHERE slot=${state.current_slot}`)[0] : null;
  if (!row) {
    row = (await db`SELECT slot,answer,starts_at,ends_at FROM club_rounds WHERE ends_at>${new Date(timestamp)} ORDER BY starts_at DESC LIMIT 1`)[0];
    if (row) await db`UPDATE club_game_state SET current_slot=${row.slot} WHERE id=1`;
  }
  return row && +new Date(row.ends_at) > timestamp ? normalizeRound(row) : newDatabaseRound(db, timestamp, row ? normalizeRound(row) : null);
}
async function advanceRound(db, round, now) {
  if (!persistent) {
    const current = rounds.get(round.slot);
    if (!current || currentRoundSlot !== round.slot) return getCurrentRound(null, now);
    current.endsAt = Math.min(current.endsAt, Number(now));
    return newMemoryRound(now, current);
  }
  await db`UPDATE club_rounds SET ends_at=LEAST(ends_at,${new Date(Number(now))}) WHERE slot=${round.slot}`;
  return newDatabaseRound(db, now, round);
}
function syncPlayerRound(player, round) {
  if (player.game?.roundId === round.slot) return false;
  player.game = { id: round.slot, roundId: round.slot, answer: round.answer, guesses: [], status: 'playing' };
  return true;
}
async function savePlayer(db, player, now) {
  await db`UPDATE club_players SET game=${db.json(player.game)},wins=${player.wins},played=${player.played},streak=${player.streak},best=${player.best},attempts=${player.attempts},solved=${player.solved},last_seen=${new Date(Number(now))} WHERE id=${player.id}`;
}
function memoryVote(request, playerId) {
  if (!request || request.status !== 'active') return null;
  const votes = [...request.voters.entries()];
  return { id: request.id, proposedBy: request.proposedBy, proposedByName: request.proposedByName, accepted: votes.filter(([,v])=>v).length, total: votes.length, hasVoted: request.voters.get(playerId) === true, isEligible: request.voters.has(playerId) };
}
async function getSkipVote(db, player, round) {
  if (!player) return null;
  if (!persistent) return memoryVote([...skipRequests.values()].find(r=>r.roundSlot===round.slot&&r.status==='active'), player.id);
  const request = (await db`SELECT r.id,r.proposed_by,p.name proposed_by_name FROM club_skip_requests r JOIN club_players p ON p.id=r.proposed_by WHERE r.round_slot=${round.slot} AND r.status='active' LIMIT 1`)[0];
  if (!request) return null;
  const c = (await db`SELECT count(*)::integer total,count(*) FILTER (WHERE accepted)::integer accepted,bool_or(player_id=${player.id}) eligible,bool_or(player_id=${player.id} AND accepted) has_voted FROM club_skip_voters WHERE request_id=${request.id}`)[0];
  return { id: request.id, proposedBy: request.proposed_by, proposedByName: request.proposed_by_name, accepted: c.accepted, total: c.total, hasVoted: Boolean(c.has_voted), isEligible: Boolean(c.eligible) };
}
export async function findPlayer(token) {
  requireStorage(); if (!token) return null;
  return persistent ? (await database()`SELECT * FROM club_players WHERE token=${token}`)[0] || null : players.get(token) || null;
}
async function memoryTransaction(operation) {
  const previous = memoryQueue; let release;
  memoryQueue = new Promise(resolve => { release = resolve; }); await previous;
  try { return await operation(); } finally { release(); }
}
export async function loadState(token, now = Date.now()) {
  requireStorage(); const timestamp = Number(now);
  if (!persistent) return memoryTransaction(async()=>{
    const round=await getCurrentRound(null,timestamp), player=token?players.get(token)||null:null;
    if(player){syncPlayerRound(player,round);player.lastSeen=timestamp;}
    return {player,round,skipVote:await getSkipVote(null,player,round)};
  });
  return database().begin(async db=>{
    const round=await getCurrentRound(db,timestamp);
    if(!token)return {player:null,round,skipVote:null};
    const player=(await db`SELECT * FROM club_players WHERE token=${token} FOR UPDATE`)[0]||null;
    if(player){syncPlayerRound(player,round);await savePlayer(db,player,timestamp);}
    return {player,round,skipVote:await getSkipVote(db,player,round)};
  });
}
export async function join(name, token) {
  requireStorage();
  const player={id:randomUUID(),token,name,wins:0,played:0,streak:0,best:0,attempts:0,solved:0,game:null,lastSeen:null};
  if(!persistent){
    if([...players.values()].some(p=>p.name.toLowerCase()===name.toLowerCase()))throw new Error('Tên này đã được sử dụng. Chọn một tên khác nhé!');
    players.set(token,player);return player;
  }
  try{return (await database()`INSERT INTO club_players (id,token,name) VALUES (${player.id},${token},${name}) RETURNING *`)[0];}
  catch(error){if(error.code==='23505')throw new Error('Tên này đã được sử dụng. Chọn một tên khác nhé!');throw error;}
}
export function scoreForTime(round, now = Date.now()) {
  const elapsed = Math.max(0, Number(now) - round.startsAt);
  return Math.max(1, 5 - Math.floor(elapsed / SCORE_WINDOW_MS));
}
function guess(player, body, round, now) {
  if(body.gameId!==player.game.id)throw new Error('Phiên 10 phút này đã kết thúc. Đang tải từ mới…');
  const before=player.game.status;applyGuess(player.game,body.guess);
  if(before==='playing'&&player.game.status!=='playing'){
    player.played++;
    if(player.game.status==='won'){
      const points=scoreForTime(round,now);
      player.game.points=points;player.wins+=points;player.solved++;player.streak++;
      player.attempts+=player.game.guesses.length;player.best=Math.max(player.best,player.streak);
    } else player.streak=0;
  }
}
async function proposeSkip(db, player, round, now) {
  if(!persistent){
    if([...skipRequests.values()].some(r=>r.roundSlot===round.slot&&r.status==='active'))throw new Error('Phiên này đã có một đề xuất bỏ qua.');
    const online=[...players.values()].filter(p=>p.lastSeen!==null&&p.lastSeen>=now-ONLINE_MS);
    if(!online.some(p=>p.id===player.id))online.push(player);
    const request={id:randomUUID(),roundSlot:round.slot,proposedBy:player.id,proposedByName:player.name,status:'active',voters:new Map(online.map(p=>[p.id,p.id===player.id]))};
    skipRequests.set(request.id,request);
    if([...request.voters.values()].every(Boolean)){request.status='passed';return advanceRound(null,round,now);}
    return round;
  }
  if((await db`SELECT id FROM club_skip_requests WHERE round_slot=${round.slot} AND status='active' LIMIT 1`)[0])throw new Error('Phiên này đã có một đề xuất bỏ qua.');
  const id=randomUUID();
  await db`INSERT INTO club_skip_requests (id,round_slot,proposed_by) VALUES (${id},${round.slot},${player.id})`;
  await db`INSERT INTO club_skip_voters (request_id,player_id,accepted) SELECT ${id},id,id=${player.id} FROM club_players WHERE last_seen>=${new Date(now-ONLINE_MS)} OR id=${player.id}`;
  const remaining=(await db`SELECT count(*)::integer count FROM club_skip_voters WHERE request_id=${id} AND NOT accepted`)[0].count;
  if(!remaining){await db`UPDATE club_skip_requests SET status='passed',resolved_at=${new Date(now)} WHERE id=${id}`;return advanceRound(db,round,now);}
  return round;
}
async function castSkipVote(db, player, round, body, now) {
  if(!body.voteId)throw new Error('Đề xuất bỏ qua không hợp lệ.');
  if(!persistent){
    const request=skipRequests.get(body.voteId);
    if(!request||request.roundSlot!==round.slot||request.status!=='active')throw new Error('Đề xuất này đã kết thúc.');
    if(!request.voters.has(player.id))throw new Error('Bạn không nằm trong danh sách biểu quyết của đề xuất này.');
    if(request.voters.get(player.id))throw new Error('Bạn đã đồng ý với đề xuất này.');
    if(body.accept!==true){request.status='rejected';return round;}
    request.voters.set(player.id,true);
    if([...request.voters.values()].every(Boolean)){request.status='passed';return advanceRound(null,round,now);}
    return round;
  }
  const request=(await db`SELECT id FROM club_skip_requests WHERE id=${body.voteId} AND round_slot=${round.slot} AND status='active' FOR UPDATE`)[0];
  if(!request)throw new Error('Đề xuất này đã kết thúc.');
  const voter=(await db`SELECT accepted FROM club_skip_voters WHERE request_id=${request.id} AND player_id=${player.id} FOR UPDATE`)[0];
  if(!voter)throw new Error('Bạn không nằm trong danh sách biểu quyết của đề xuất này.');
  if(voter.accepted)throw new Error('Bạn đã đồng ý với đề xuất này.');
  if(body.accept!==true){await db`UPDATE club_skip_requests SET status='rejected',resolved_at=${new Date(now)} WHERE id=${request.id}`;return round;}
  await db`UPDATE club_skip_voters SET accepted=true WHERE request_id=${request.id} AND player_id=${player.id}`;
  const remaining=(await db`SELECT count(*)::integer count FROM club_skip_voters WHERE request_id=${request.id} AND NOT accepted`)[0].count;
  if(!remaining){await db`UPDATE club_skip_requests SET status='passed',resolved_at=${new Date(now)} WHERE id=${request.id}`;return advanceRound(db,round,now);}
  return round;
}
export async function updatePlayer(token, action, body={}, now=Date.now()) {
  requireStorage();const timestamp=Number(now);
  const run=async db=>{
    let round=await getCurrentRound(db,timestamp);
    const original=persistent?(await db`SELECT * FROM club_players WHERE token=${token} FOR UPDATE`)[0]:players.get(token);
    if(!original)throw new Error('Hãy tham gia Club trước khi chơi.');
    let player=persistent?original:structuredClone(original);
    syncPlayerRound(player,round);player.lastSeen=timestamp;if(!persistent)players.set(token,player);
    if(action==='guess')guess(player,body,round,timestamp);
    else if(action==='proposeSkip')round=await proposeSkip(db,player,round,timestamp);
    else if(action==='voteSkip')round=await castSkipVote(db,player,round,body,timestamp);
    else if(!['sync','start'].includes(action))throw new Error('Thao tác không hợp lệ.');
    syncPlayerRound(player,round);
    if(persistent)await savePlayer(db,player,timestamp);else players.set(token,player);
    return {player,round,skipVote:await getSkipVote(db,player,round)};
  };
  return persistent?database().begin(run):memoryTransaction(()=>run(null));
}
export async function leaderboard() {
  requireStorage();
  const all=persistent?await database()`SELECT id,name,wins,solved,played,streak,best,attempts FROM club_players WHERE played>0 ORDER BY wins DESC,CASE WHEN solved>0 THEN attempts::float/solved ELSE 999 END ASC,lower(name) ASC`:[...players.values()].filter(p=>p.played>0).sort((a,b)=>b.wins-a.wins||(a.solved?a.attempts/a.solved:999)-(b.solved?b.attempts/b.solved:999)||a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return all.map((p,i)=>({id:p.id,name:p.name,wins:p.wins,solved:p.solved,played:p.played,streak:p.streak,rank:i+1,average:p.solved?+(p.attempts/p.solved).toFixed(1):null}));
}
