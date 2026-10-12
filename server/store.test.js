import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreForTime, ROUND_MS } from './store.js';
import { hashPassword, verifyPassword } from './auth.js';

test('score decreases by one point every two minutes',()=>{
  const round={startsAt:1_000_000};
  for(const [minute,points] of [[0,5],[2,4],[4,3],[6,2],[8,1],[10,1]])assert.equal(scoreForTime(round,round.startsAt+minute*60000),points);
  assert.equal(ROUND_MS,600000);
});
test('password hashes use a random salt and verify safely',async()=>{
  const first=await hashPassword('mat khau rat tot'),second=await hashPassword('mat khau rat tot');
  assert.notEqual(first,second);assert.equal(await verifyPassword('mat khau rat tot',first),true);assert.equal(await verifyPassword('sai mat khau',first),false);
});
