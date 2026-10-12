import { createHash, randomBytes } from 'node:crypto';
import { createAccount, createLoginSession, createRoom, joinRoom, leaveRoom, deleteRoom, findUserByName, loadState, logout, updatePlayer, persistent } from '../server/store.js';
import { hashPassword, verifyPassword } from '../server/auth.js';
import { publicGame } from '../server/engine.js';

const digest=value=>createHash('sha256').update(value).digest('hex');
const SESSION_MS=30*24*60*60*1000;
const cookie=value=>`club_session=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${value?2592000:0}${process.env.VERCEL?'; Secure':''}`;
const publicRound=round=>round?{id:round.slot,startsAt:new Date(round.startsAt).toISOString(),endsAt:new Date(round.endsAt).toISOString()}:null;
function credentials(body){
  const name=String(body.name||'').trim().normalize('NFC'),password=String(body.password||'');
  if(!/^[\p{L}\p{N} _.-]{2,20}$/u.test(name))throw new Error('Tên gồm 2–20 ký tự: chữ, số, khoảng trắng, dấu _ . hoặc -');
  if(password.length<8||password.length>128)throw new Error('Mật khẩu cần từ 8 đến 128 ký tự.');
  return{name,password};
}
export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json; charset=utf-8');
  try{
    if(!['GET','POST'].includes(req.method)){res.statusCode=405;res.setHeader('Allow','GET, POST');return res.end(JSON.stringify({error:'Phương thức không hỗ trợ.'}));}
    const raw=(req.headers.cookie||'').match(/(?:^|;\s*)club_session=([a-f0-9]{64})(?:;|$)/)?.[1];
    let token=raw?digest(raw):null,state=await loadState(token);
    if(req.method==='POST'){
      if(req.headers.origin&&req.headers.origin!==`https://${req.headers.host}`&&req.headers.origin!==`http://${req.headers.host}`)throw new Error('Yêu cầu không hợp lệ.');
      const body=typeof req.body==='string'?JSON.parse(req.body):req.body||{};
      if(body.action==='register'){
        if(state.user)throw new Error('Bạn đã đăng nhập.');
        const {name,password}=credentials(body),rawToken=randomBytes(32).toString('hex');token=digest(rawToken);
        await createAccount(name,await hashPassword(password),token,new Date(Date.now()+SESSION_MS));res.setHeader('Set-Cookie',cookie(rawToken));state=await loadState(token);
      }else if(body.action==='login'){
        if(state.user)throw new Error('Bạn đã đăng nhập.');
        const {name,password}=credentials(body),user=await findUserByName(name);
        if(!user||!await verifyPassword(password,user.password_hash))throw new Error('Tên tài khoản hoặc mật khẩu không đúng.');
        const rawToken=randomBytes(32).toString('hex');token=digest(rawToken);await createLoginSession(user.id,token,new Date(Date.now()+SESSION_MS));res.setHeader('Set-Cookie',cookie(rawToken));state=await loadState(token);
      }else if(body.action==='logout'){
        await logout(token);res.setHeader('Set-Cookie',cookie(''));state=await loadState(null);
      }else{
        if(!state.user)throw new Error('Hãy đăng nhập trước.');
        if(body.action==='createRoom')await createRoom(token);
        else if(body.action==='joinRoom')await joinRoom(token,body.roomId);
        else if(body.action==='leaveRoom')await leaveRoom(token);
        else if(body.action==='deleteRoom')await deleteRoom(token);
        else if(['guess','proposeSkip','voteSkip'].includes(body.action))state=await updatePlayer(token,body.action,body);
        else throw new Error('Thao tác không hợp lệ.');
        if(!['guess','proposeSkip','voteSkip'].includes(body.action))state=await loadState(token);
      }
    }
    res.end(JSON.stringify({user:state.user,room:state.room,player:state.player,game:publicGame(state.member?.game),round:publicRound(state.round),serverTime:new Date().toISOString(),skipVote:state.skipVote,leaderboard:state.leaderboard||[],storage:persistent?'postgres':'demo'}));
  }catch(error){
    const safe=!error.code&&!error.message.includes('DATABASE_URL')&&!error.message.includes('JSON');
    res.statusCode=safe?400:503;if(!safe)console.error('Wordle API error:',error.code||error.name);
    res.end(JSON.stringify({error:safe?error.message:'Máy chủ chưa sẵn sàng. Kiểm tra kết nối cơ sở dữ liệu.'}));
  }
}
