import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import handler from '../api/game.js';
import { loadState } from './store.js';

test('accounts create and join an isolated room whose owner can delete all room state',{skip:Boolean(process.env.DATABASE_URL)},async()=>{
  const server=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;req.body=raw?JSON.parse(raw):undefined;await handler(req,res);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  async function call(body,cookie){const response=await fetch(`${base}/api/game`,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(cookie?{cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});return{status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]||cookie};}
  try{
    assert.equal((await call({action:'register',name:'A',password:'12345678'})).status,400);
    const alice=await call({action:'register',name:'Room Alice',password:'strong-pass-1'}),bob=await call({action:'register',name:'Room Bob',password:'strong-pass-2'});
    assert.ok(alice.cookie&&bob.cookie);assert.equal(alice.data.room,null);
    assert.equal((await call({action:'login',name:'Room Alice',password:'wrong-pass'})).status,400);
    const created=await call({action:'createRoom'},alice.cookie);assert.match(created.data.room.id,/^[A-Z2-9]{6}$/);assert.equal(created.data.room.isOwner,true);
    const joined=await call({action:'joinRoom',roomId:created.data.room.id.toLowerCase()},bob.cookie);assert.equal(joined.data.room.id,created.data.room.id);assert.equal(joined.data.game.id,created.data.game.id);
    const rawToken=alice.cookie.split('=')[1],internal=await loadState(createHash('sha256').update(rawToken).digest('hex'));
    const won=await call({action:'guess',gameId:created.data.game.id,guess:internal.member.game.answer},alice.cookie);assert.equal(won.data.player.solved,1);assert.equal(won.data.player.wins,won.data.game.points);
    const bobView=await call(undefined,bob.cookie);assert.equal(bobView.data.leaderboard.find(x=>x.name==='Room Alice').wins,won.data.game.points);
    const forbidden=await call({action:'deleteRoom'},bob.cookie);assert.equal(forbidden.status,400);
    const deleted=await call({action:'deleteRoom'},alice.cookie);assert.equal(deleted.data.room,null);
    const bobAfter=await call(undefined,bob.cookie);assert.equal(bobAfter.data.room,null);assert.equal(bobAfter.data.leaderboard.length,0);
    const login=await call({action:'login',name:'Room Alice',password:'strong-pass-1'});assert.equal(login.data.user.name,'Room Alice');
  }finally{await new Promise(resolve=>server.close(resolve));}
});
