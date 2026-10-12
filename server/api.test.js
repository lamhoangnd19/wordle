import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import handler from '../api/game.js';
import { findPlayer } from './store.js';

test('API isolates sessions, hides answers, resumes games and credits wins exactly once', {skip:Boolean(process.env.DATABASE_URL)}, async () => {
  const server = http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    req.body=raw?JSON.parse(raw):undefined;await handler(req,res);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  async function call(body,cookie,origin) {
    const response=await fetch(`${base}/api/game`,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(cookie?{cookie}:{}),...(origin?{origin}:{})},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  try {
    const guest=await call();assert.equal(guest.data.player,null);
    assert.equal((await call({action:'start'})).status,400);
    assert.equal((await call({action:'join',name:'A'})).status,400);
    const a=await call({action:'join',name:'Alice'});
    const b=await call({action:'join',name:'Bob'});
    assert.ok(a.cookie);assert.notEqual(a.data.player.id,b.data.player.id);
    assert.equal((await call({action:'join',name:'alice'})).status,400);
    assert.equal((await call({action:'start'},a.cookie,'https://attacker.example')).status,400);
    const started=await call({action:'start'},a.cookie);
    const bStarted=await call({action:'start'},b.cookie);
    assert.notEqual(started.data.game.id,bStarted.data.game.id);
    assert.equal('answer' in started.data.game,false);
    assert.equal('token' in started.data.player,false);
    const resumed=await call({action:'start'},a.cookie);assert.equal(resumed.data.game.id,started.data.game.id);
    const raw=a.cookie.split('=')[1];
    const internal=await findPlayer(createHash('sha256').update(raw).digest('hex'));
    const won=await call({action:'guess',gameId:started.data.game.id,guess:internal.game.answer},a.cookie);
    assert.equal(won.data.game.status,'won');assert.equal(won.data.player.wins,1);assert.equal(won.data.player.played,1);
    const duplicate=await call({action:'guess',gameId:started.data.game.id,guess:internal.game.answer},a.cookie);assert.equal(duplicate.status,400);
    const after=await call(undefined,a.cookie);assert.equal(after.data.player.wins,1);assert.equal(after.data.player.rank,1);
    assert.equal((await call(undefined,b.cookie)).data.player.wins,0);
    const next=await call({action:'start'},a.cookie);assert.notEqual(next.data.game.id,started.data.game.id);
    assert.equal((await call({action:'guess',gameId:started.data.game.id,guess:'crane'},a.cookie)).status,400);
    assert.equal(next.data.game.guesses.length,0);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
