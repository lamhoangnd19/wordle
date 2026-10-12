import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROUND_MS, join, findPlayer, loadState, updatePlayer, leaderboard, roundWindow } from './store.js';

test('all players share a ten-minute round, score once, and reset together', { skip: Boolean(process.env.DATABASE_URL) }, async () => {
  const now = Math.floor(Date.now() / ROUND_MS) * ROUND_MS + 1000;
  await join('Store Alice', 'store-alice');
  await join('Store Bob', 'store-bob');
  let aliceState = await loadState('store-alice', now);
  let bobState = await loadState('store-bob', now);
  assert.equal(aliceState.round.slot, bobState.round.slot);
  assert.equal(aliceState.player.game.id, bobState.player.game.id);
  assert.equal(aliceState.player.game.answer, bobState.player.game.answer);
  assert.equal(aliceState.round.endsAt - aliceState.round.startsAt, ROUND_MS);

  const answer = aliceState.player.game.answer;
  const requests = await Promise.allSettled([
    updatePlayer('store-alice', 'guess', { gameId: aliceState.player.game.id, guess: answer }, now),
    updatePlayer('store-alice', 'guess', { gameId: aliceState.player.game.id, guess: answer }, now),
  ]);
  assert.equal(requests.filter(result => result.status === 'fulfilled').length, 1);
  const alice = await findPlayer('store-alice');
  assert.equal(alice.wins, 1);
  assert.equal(alice.played, 1);

  const wrong = answer === 'crane' ? 'stone' : 'crane';
  let bobResult = await updatePlayer('store-bob', 'guess', { gameId: bobState.player.game.id, guess: wrong }, now);
  bobResult = await updatePlayer('store-bob', 'guess', { gameId: bobState.player.game.id, guess: answer }, now);
  assert.equal(bobResult.player.wins, 1);

  const nextTime = now + ROUND_MS;
  aliceState = await loadState('store-alice', nextTime);
  bobState = await loadState('store-bob', nextTime);
  assert.notEqual(aliceState.player.game.id, String(roundWindow(now).slot));
  assert.equal(aliceState.player.game.id, bobState.player.game.id);
  assert.equal(aliceState.player.game.answer, bobState.player.game.answer);
  assert.equal(aliceState.player.game.status, 'playing');
  assert.equal(aliceState.player.game.guesses.length, 0);

  const ranks = await leaderboard();
  assert.equal(ranks.find(p => p.name === 'Store Alice').wins, 1);
  assert.equal(ranks.find(p => p.name === 'Store Bob').wins, 1);
});

test('stale round guesses are rejected without changing the new board', { skip: Boolean(process.env.DATABASE_URL) }, async () => {
  const now = Math.floor(Date.now() / ROUND_MS) * ROUND_MS + 2000;
  await join('Store Carol', 'store-carol');
  const state = await loadState('store-carol', now);
  const oldGameId = state.player.game.id;
  await assert.rejects(updatePlayer('store-carol', 'guess', { gameId: oldGameId, guess: 'crane' }, now + ROUND_MS), /Phiên 10 phút/);
  const refreshed = await loadState('store-carol', now + ROUND_MS);
  assert.notEqual(refreshed.player.game.id, oldGameId);
  assert.equal(refreshed.player.game.guesses.length, 0);
});
