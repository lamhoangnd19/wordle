import postgres from 'postgres';
import { randomUUID, randomBytes } from 'node:crypto';
import { applyGuess, chooseWord } from './engine.js';

export const ROUND_MS=600000, ONLINE_MS=30000;
const SCORE_WINDOW_MS=ROUND_MS/5, users=new Map(), sessions=new Map(), rooms=new Map();
let sql, memoryQueue=Promise.resolve();
export const persistent=Boolean(process.env.DATABASE_URL);
export function database(){if(!sql)sql=postgres(process.env.DATABASE_URL,{max:3,idle_timeout:20,connect_timeout:10,prepare:false});return sql;}

export async function setup(connectionString=process.env.DATABASE_URL_UNPOOLED||process.env.DATABASE_URL){
  if(!connectionString)throw new Error('Set DATABASE_URL first.');
  const client=postgres(connectionString,{max:1,connect_timeout:10,prepare:false});
  try{await client.begin(async db=>{
    await db`CREATE TABLE IF NOT EXISTS club_schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const done=(await db`SELECT id FROM club_schema_migrations WHERE id='rooms_v1'`)[0];
    if(!done){
      await db`DROP TABLE IF EXISTS club_skip_voters,club_skip_requests,club_game_state,club_rounds,club_players CASCADE`;
    }
    await db`CREATE TABLE IF NOT EXISTS club_users (id uuid PRIMARY KEY, name text NOT NULL, password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`;
    await db`CREATE UNIQUE INDEX IF NOT EXISTS club_user_name ON club_users (lower(name))`;
    await db`CREATE TABLE IF NOT EXISTS club_rooms (id varchar(8) PRIMARY KEY, owner_id uuid NOT NULL REFERENCES club_users(id), created_at timestamptz NOT NULL DEFAULT now())`;
    await db`CREATE TABLE IF NOT EXISTS club_sessions (token text PRIMARY KEY, user_id uuid NOT NULL REFERENCES club_users(id) ON DELETE CASCADE, room_id varchar(8) REFERENCES club_rooms(id) ON DELETE SET NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`;
    await db`CREATE TABLE IF NOT EXISTS club_room_members (room_id varchar(8) NOT NULL REFERENCES club_rooms(id) ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES club_users(id) ON DELETE CASCADE, points integer NOT NULL DEFAULT 0, solved integer NOT NULL DEFAULT 0, played integer NOT NULL DEFAULT 0, streak integer NOT NULL DEFAULT 0, best integer NOT NULL DEFAULT 0, attempts integer NOT NULL DEFAULT 0, game jsonb, last_seen timestamptz, joined_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(room_id,user_id))`;
    await db`CREATE TABLE IF NOT EXISTS club_room_rounds (room_id varchar(8) NOT NULL REFERENCES club_rooms(id) ON DELETE CASCADE, slot bigint NOT NULL, answer char(5) NOT NULL, starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, PRIMARY KEY(room_id,slot))`;
    await db`CREATE TABLE IF NOT EXISTS club_room_state (room_id varchar(8) PRIMARY KEY REFERENCES club_rooms(id) ON DELETE CASCADE, current_slot bigint)`;
    await db`CREATE TABLE IF NOT EXISTS club_room_skip_requests (id uuid PRIMARY KEY, room_id varchar(8) NOT NULL REFERENCES club_rooms(id) ON DELETE CASCADE, round_slot bigint NOT NULL, proposed_by uuid NOT NULL REFERENCES club_users(id), status text NOT NULL DEFAULT 'active' CHECK(status IN('active','passed','rejected')), created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz)`;
    await db`CREATE UNIQUE INDEX IF NOT EXISTS club_room_active_skip ON club_room_skip_requests(room_id,round_slot) WHERE status='active'`;
    await db`CREATE TABLE IF NOT EXISTS club_room_skip_voters (request_id uuid NOT NULL REFERENCES club_room_skip_requests(id) ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES club_users(id), accepted boolean NOT NULL DEFAULT false, PRIMARY KEY(request_id,user_id))`;
    if(!done)await db`INSERT INTO club_schema_migrations(id) VALUES('rooms_v1')`;
  });}finally{await client.end();}
}
function requireStorage(){if(!persistent&&(process.env.VERCEL||process.env.NODE_ENV==='production'))throw new Error('Cần cấu hình DATABASE_URL.');}
async function lock(operation){const previous=memoryQueue;let release;memoryQueue=new Promise(r=>release=r);await previous;try{return await operation();}finally{release();}}
const roomCode=()=>{const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789',bytes=randomBytes(6);return [...bytes].map(b=>alphabet[b%alphabet.length]).join('');};
export const scoreForTime=(round,now=Date.now())=>Math.max(1,5-Math.floor(Math.max(0,Number(now)-round.startsAt)/SCORE_WINDOW_MS));
const normalizeRound=row=>({slot:String(row.slot),answer:row.answer.trim(),startsAt:+new Date(row.starts_at),endsAt:+new Date(row.ends_at)});
function publicUser(user){return user?{id:user.id,name:user.name}:null;}

export async function findUserByName(name){
  requireStorage();
  if(!persistent)return [...users.values()].find(u=>u.name.toLowerCase()===name.toLowerCase())||null;
  return (await database()`SELECT * FROM club_users WHERE lower(name)=lower(${name})`)[0]||null;
}
export async function createAccount(name,passwordHash,token,expiresAt){
  requireStorage();
  if(!persistent)return lock(async()=>{
    if(await findUserByName(name))throw new Error('Tên tài khoản đã được sử dụng.');
    const user={id:randomUUID(),name,password_hash:passwordHash};users.set(user.id,user);sessions.set(token,{token,userId:user.id,roomId:null,expiresAt});return publicUser(user);
  });
  try{return await database().begin(async db=>{
    const user=(await db`INSERT INTO club_users(id,name,password_hash) VALUES(${randomUUID()},${name},${passwordHash}) RETURNING *`)[0];
    await db`INSERT INTO club_sessions(token,user_id,expires_at) VALUES(${token},${user.id},${expiresAt})`;return publicUser(user);
  });}catch(error){if(error.code==='23505')throw new Error('Tên tài khoản đã được sử dụng.');throw error;}
}
export async function createLoginSession(userId,token,expiresAt){
  requireStorage();
  if(!persistent){sessions.set(token,{token,userId,roomId:null,expiresAt});return;}
  await database()`INSERT INTO club_sessions(token,user_id,expires_at) VALUES(${token},${userId},${expiresAt})`;
}
export async function logout(token){
  if(!token)return;
  if(!persistent){sessions.delete(token);return;}
  await database()`DELETE FROM club_sessions WHERE token=${token}`;
}
async function memoryContext(token){
  const session=sessions.get(token);if(!session||+new Date(session.expiresAt)<=Date.now())return null;
  const user=users.get(session.userId),room=session.roomId?rooms.get(session.roomId):null;
  return {session,user,room,member:room?.members.get(user.id)||null};
}
async function dbContext(db,token,forUpdate=false){
  if(!token)return null;
  const lockSql=forUpdate?' FOR UPDATE OF s':'';
  const rows=await db.unsafe(`SELECT s.token,s.room_id,u.id user_id,u.name,u.password_hash,r.owner_id,m.points,m.solved,m.played,m.streak,m.best,m.attempts,m.game,m.last_seen FROM club_sessions s JOIN club_users u ON u.id=s.user_id LEFT JOIN club_rooms r ON r.id=s.room_id LEFT JOIN club_room_members m ON m.room_id=s.room_id AND m.user_id=u.id WHERE s.token=$1 AND s.expires_at>now()${lockSql}`,[token]);
  if(!rows[0])return null;const x=rows[0];
  return {session:{token:x.token,roomId:x.room_id},user:{id:x.user_id,name:x.name,password_hash:x.password_hash},room:x.room_id?{id:x.room_id,ownerId:x.owner_id}:null,member:x.room_id?{roomId:x.room_id,userId:x.user_id,points:x.points,solved:x.solved,played:x.played,streak:x.streak,best:x.best,attempts:x.attempts,game:x.game,lastSeen:x.last_seen}:null};
}
export async function getAccount(token){
  requireStorage();const ctx=persistent?await dbContext(database(),token):await memoryContext(token);return ctx?.user||null;
}
export async function createRoom(token){
  requireStorage();
  const run=async db=>{
    const ctx=persistent?await dbContext(db,token,true):await memoryContext(token);if(!ctx)throw new Error('Hãy đăng nhập trước.');
    let id=roomCode();if(persistent){while((await db`SELECT id FROM club_rooms WHERE id=${id}`)[0])id=roomCode();
      await db`INSERT INTO club_rooms(id,owner_id) VALUES(${id},${ctx.user.id})`;
      await db`INSERT INTO club_room_members(room_id,user_id) VALUES(${id},${ctx.user.id})`;
      await db`INSERT INTO club_room_state(room_id) VALUES(${id})`;
      await db`UPDATE club_sessions SET room_id=${id} WHERE token=${token}`;
    }else{while(rooms.has(id))id=roomCode();rooms.set(id,{id,ownerId:ctx.user.id,members:new Map([[ctx.user.id,{roomId:id,userId:ctx.user.id,points:0,solved:0,played:0,streak:0,best:0,attempts:0,game:null,lastSeen:null}]]),rounds:new Map(),currentSlot:null,votes:new Map()});ctx.session.roomId=id;}
    return id;
  };return persistent?database().begin(run):lock(()=>run(null));
}
export async function joinRoom(token,rawId){
  requireStorage();const id=String(rawId||'').trim().toUpperCase();
  if(!/^[A-Z2-9]{6}$/.test(id))throw new Error('ID phòng gồm 6 ký tự.');
  const run=async db=>{const ctx=persistent?await dbContext(db,token,true):await memoryContext(token);if(!ctx)throw new Error('Hãy đăng nhập trước.');
    if(persistent){if(!(await db`SELECT id FROM club_rooms WHERE id=${id}`)[0])throw new Error('Không tìm thấy phòng.');
      await db`INSERT INTO club_room_members(room_id,user_id) VALUES(${id},${ctx.user.id}) ON CONFLICT DO NOTHING`;await db`UPDATE club_sessions SET room_id=${id} WHERE token=${token}`;
    }else{const room=rooms.get(id);if(!room)throw new Error('Không tìm thấy phòng.');if(!room.members.has(ctx.user.id))room.members.set(ctx.user.id,{roomId:id,userId:ctx.user.id,points:0,solved:0,played:0,streak:0,best:0,attempts:0,game:null,lastSeen:null});ctx.session.roomId=id;}
  };return persistent?database().begin(run):lock(()=>run(null));
}
export async function leaveRoom(token){
  if(!persistent){const ctx=await memoryContext(token);if(ctx)ctx.session.roomId=null;return;}
  await database()`UPDATE club_sessions SET room_id=NULL WHERE token=${token}`;
}
export async function deleteRoom(token){
  requireStorage();
  const run=async db=>{const ctx=persistent?await dbContext(db,token,true):await memoryContext(token);if(!ctx?.room)throw new Error('Bạn chưa vào phòng.');if(ctx.room.ownerId!==ctx.user.id)throw new Error('Chỉ chủ phòng mới có thể xóa phòng.');
    if(persistent)await db`DELETE FROM club_rooms WHERE id=${ctx.room.id}`;else rooms.delete(ctx.room.id);
  };return persistent?database().begin(run):lock(()=>run(null));
}
function newMemoryRound(room,now,previous){let slot=Number(now);while(room.rounds.has(String(slot)))slot++;const round={slot:String(slot),answer:chooseWord(previous?.answer),startsAt:Number(now),endsAt:Number(now)+ROUND_MS};room.rounds.set(round.slot,round);room.currentSlot=round.slot;return round;}
async function currentRound(db,room,now){
  if(!persistent){const current=room.currentSlot?room.rounds.get(room.currentSlot):null;return current?.endsAt>now?current:newMemoryRound(room,now,current);}
  const state=(await db`SELECT current_slot FROM club_room_state WHERE room_id=${room.id} FOR UPDATE`)[0];let row=state?.current_slot?(await db`SELECT slot,answer,starts_at,ends_at FROM club_room_rounds WHERE room_id=${room.id} AND slot=${state.current_slot}`)[0]:null;
  if(row&&+new Date(row.ends_at)>now)return normalizeRound(row);let slot=now,created;
  while(!created){created=(await db`INSERT INTO club_room_rounds(room_id,slot,answer,starts_at,ends_at) VALUES(${room.id},${String(slot)},${chooseWord(row?.answer?.trim())},${new Date(now)},${new Date(now+ROUND_MS)}) ON CONFLICT DO NOTHING RETURNING slot,answer,starts_at,ends_at`)[0];slot++;}
  await db`UPDATE club_room_state SET current_slot=${created.slot} WHERE room_id=${room.id}`;return normalizeRound(created);
}
async function advanceRound(db,room,round,now){
  if(!persistent){round.endsAt=now;return newMemoryRound(room,now,round);}
  await db`UPDATE club_room_rounds SET ends_at=LEAST(ends_at,${new Date(now)}) WHERE room_id=${room.id} AND slot=${round.slot}`;
  let slot=now,row;while(!row){row=(await db`INSERT INTO club_room_rounds(room_id,slot,answer,starts_at,ends_at) VALUES(${room.id},${String(slot)},${chooseWord(round.answer)},${new Date(now)},${new Date(now+ROUND_MS)}) ON CONFLICT DO NOTHING RETURNING slot,answer,starts_at,ends_at`)[0];slot++;}
  await db`UPDATE club_room_state SET current_slot=${row.slot} WHERE room_id=${room.id}`;return normalizeRound(row);
}
function syncGame(member,round){if(member.game?.roundId===round.slot)return;member.game={id:round.slot,roundId:round.slot,answer:round.answer,guesses:[],status:'playing'};}
async function saveMember(db,m,now){await db`UPDATE club_room_members SET points=${m.points},solved=${m.solved},played=${m.played},streak=${m.streak},best=${m.best},attempts=${m.attempts},game=${db.json(m.game)},last_seen=${new Date(now)} WHERE room_id=${m.roomId} AND user_id=${m.userId}`;}
function guess(member,round,body,now){if(body.gameId!==member.game.id)throw new Error('Phiên này đã kết thúc.');const before=member.game.status;applyGuess(member.game,body.guess);if(before==='playing'&&member.game.status!=='playing'){member.played++;if(member.game.status==='won'){const points=scoreForTime(round,now);member.game.points=points;member.points+=points;member.solved++;member.streak++;member.attempts+=member.game.guesses.length;member.best=Math.max(member.best,member.streak);}else member.streak=0;}}
async function leaderboard(db,room){
  const all=persistent?await db`SELECT m.user_id id,u.name,m.points,m.solved,m.played,m.streak,m.attempts FROM club_room_members m JOIN club_users u ON u.id=m.user_id WHERE m.room_id=${room.id} ORDER BY m.points DESC,CASE WHEN m.solved>0 THEN m.attempts::float/m.solved ELSE 999 END,lower(u.name)`:[...room.members.values()].map(m=>({...m,id:m.userId,name:users.get(m.userId).name})).sort((a,b)=>b.points-a.points||(a.solved?a.attempts/a.solved:999)-(b.solved?b.attempts/b.solved:999)||a.name.localeCompare(b.name));
  return all.map((p,i)=>({id:p.id,name:p.name,wins:p.points,solved:p.solved,played:p.played,streak:p.streak,rank:i+1,average:p.solved?+(p.attempts/p.solved).toFixed(1):null}));
}
async function skipVote(db,ctx,round){
  if(!persistent){const req=[...ctx.room.votes.values()].find(v=>v.roundSlot===round.slot&&v.status==='active');if(!req)return null;return{id:req.id,proposedByName:users.get(req.proposedBy).name,accepted:[...req.voters.values()].filter(Boolean).length,total:req.voters.size,hasVoted:req.voters.get(ctx.user.id)===true,isEligible:req.voters.has(ctx.user.id)};}
  const req=(await db`SELECT r.id,u.name FROM club_room_skip_requests r JOIN club_users u ON u.id=r.proposed_by WHERE r.room_id=${ctx.room.id} AND r.round_slot=${round.slot} AND r.status='active' LIMIT 1`)[0];if(!req)return null;
  const c=(await db`SELECT count(*)::integer total,count(*) FILTER(WHERE accepted)::integer accepted,bool_or(user_id=${ctx.user.id}) eligible,bool_or(user_id=${ctx.user.id} AND accepted) voted FROM club_room_skip_voters WHERE request_id=${req.id}`)[0];
  return{id:req.id,proposedByName:req.name,accepted:c.accepted,total:c.total,hasVoted:Boolean(c.voted),isEligible:Boolean(c.eligible)};
}
async function propose(db,ctx,round,now){
  if(!persistent){if([...ctx.room.votes.values()].some(v=>v.roundSlot===round.slot&&v.status==='active'))throw new Error('Đã có đề xuất bỏ qua.');const online=[...ctx.room.members.values()].filter(m=>m.lastSeen&&m.lastSeen>=now-ONLINE_MS),req={id:randomUUID(),roundSlot:round.slot,proposedBy:ctx.user.id,status:'active',voters:new Map(online.map(m=>[m.userId,m.userId===ctx.user.id]))};if(!req.voters.has(ctx.user.id))req.voters.set(ctx.user.id,true);ctx.room.votes.set(req.id,req);if([...req.voters.values()].every(Boolean)){req.status='passed';return advanceRound(null,ctx.room,round,now);}return round;}
  if((await db`SELECT id FROM club_room_skip_requests WHERE room_id=${ctx.room.id} AND round_slot=${round.slot} AND status='active'`)[0])throw new Error('Đã có đề xuất bỏ qua.');
  const id=randomUUID();await db`INSERT INTO club_room_skip_requests(id,room_id,round_slot,proposed_by) VALUES(${id},${ctx.room.id},${round.slot},${ctx.user.id})`;
  await db`INSERT INTO club_room_skip_voters(request_id,user_id,accepted) SELECT ${id},user_id,user_id=${ctx.user.id} FROM club_room_members WHERE room_id=${ctx.room.id} AND (last_seen>=${new Date(now-ONLINE_MS)} OR user_id=${ctx.user.id})`;
  const remaining=(await db`SELECT count(*)::integer n FROM club_room_skip_voters WHERE request_id=${id} AND NOT accepted`)[0].n;if(!remaining){await db`UPDATE club_room_skip_requests SET status='passed',resolved_at=now() WHERE id=${id}`;return advanceRound(db,ctx.room,round,now);}return round;
}
async function vote(db,ctx,round,body,now){
  if(!persistent){const req=ctx.room.votes.get(body.voteId);if(!req||req.status!=='active'||req.roundSlot!==round.slot)throw new Error('Đề xuất đã kết thúc.');if(!req.voters.has(ctx.user.id))throw new Error('Bạn không thuộc biểu quyết này.');if(body.accept!==true){req.status='rejected';return round;}req.voters.set(ctx.user.id,true);if([...req.voters.values()].every(Boolean)){req.status='passed';return advanceRound(null,ctx.room,round,now);}return round;}
  const req=(await db`SELECT id FROM club_room_skip_requests WHERE id=${body.voteId} AND room_id=${ctx.room.id} AND round_slot=${round.slot} AND status='active' FOR UPDATE`)[0];if(!req)throw new Error('Đề xuất đã kết thúc.');
  const voter=(await db`SELECT accepted FROM club_room_skip_voters WHERE request_id=${req.id} AND user_id=${ctx.user.id} FOR UPDATE`)[0];if(!voter)throw new Error('Bạn không thuộc biểu quyết này.');if(body.accept!==true){await db`UPDATE club_room_skip_requests SET status='rejected',resolved_at=now() WHERE id=${req.id}`;return round;}await db`UPDATE club_room_skip_voters SET accepted=true WHERE request_id=${req.id} AND user_id=${ctx.user.id}`;
  const remaining=(await db`SELECT count(*)::integer n FROM club_room_skip_voters WHERE request_id=${req.id} AND NOT accepted`)[0].n;if(!remaining){await db`UPDATE club_room_skip_requests SET status='passed',resolved_at=now() WHERE id=${req.id}`;return advanceRound(db,ctx.room,round,now);}return round;
}
function result(ctx,round,voteData,ranks){const m=ctx.member;return{user:publicUser(ctx.user),room:{id:ctx.room.id,isOwner:ctx.room.ownerId===ctx.user.id},player:{id:ctx.user.id,name:ctx.user.name,wins:m.points,solved:m.solved,played:m.played,streak:m.streak,best:m.best,rank:ranks.find(p=>p.id===ctx.user.id)?.rank||null},member:m,round,skipVote:voteData,leaderboard:ranks};}
export async function loadState(token,now=Date.now()){
  requireStorage();const run=async db=>{const ctx=persistent?await dbContext(db,token,true):await memoryContext(token);if(!ctx)return{user:null,room:null,player:null,member:null,round:null,skipVote:null,leaderboard:[]};if(!ctx.room)return{user:publicUser(ctx.user),room:null,player:null,member:null,round:null,skipVote:null,leaderboard:[]};const round=await currentRound(db,ctx.room,Number(now));syncGame(ctx.member,round);ctx.member.lastSeen=Number(now);if(persistent)await saveMember(db,ctx.member,Number(now));const ranks=await leaderboard(db,ctx.room);return result(ctx,round,await skipVote(db,ctx,round),ranks);};
  return persistent?database().begin(run):lock(()=>run(null));
}
export async function updatePlayer(token,action,body={},now=Date.now()){
  requireStorage();const run=async db=>{const ctx=persistent?await dbContext(db,token,true):await memoryContext(token);if(!ctx?.room||!ctx.member)throw new Error('Hãy vào một phòng trước.');let round=await currentRound(db,ctx.room,Number(now));syncGame(ctx.member,round);ctx.member.lastSeen=Number(now);if(action==='guess')guess(ctx.member,round,body,Number(now));else if(action==='proposeSkip')round=await propose(db,ctx,round,Number(now));else if(action==='voteSkip')round=await vote(db,ctx,round,body,Number(now));else throw new Error('Thao tác không hợp lệ.');syncGame(ctx.member,round);if(persistent)await saveMember(db,ctx.member,Number(now));const ranks=await leaderboard(db,ctx.room);return result(ctx,round,await skipVote(db,ctx,round),ranks);};return persistent?database().begin(run):lock(()=>run(null));
}
