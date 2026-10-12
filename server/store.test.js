import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROUND_MS, join, findPlayer, loadState, updatePlayer, leaderboard } from './store.js';

test('all players share a ten-minute round, score once, and reset together', { skip: Boolean(process.env.DATABASE_URL) }, async () => {
  const now = Date.now();
  await join('Store Alice', 'store-alice');
  await join('Store Bob', 'store-bob');
  let aliceState = await loadState('store-alice', now);
  let bobState = await loadState('store-bob', now);
  assert.equal(aliceState.round.slot, bobState.round.slot);
  assert.equal(aliceState.player.game.answer, bobState.player.game.answer);
  assert.equal(aliceState.round.endsAt - aliceState.round.startsAt, ROUND_MS);

  const answer = aliceState.player.game.answer;
  const requests = await Promise.allSettled([
    updatePlayer('store-alice', 'guess', { gameId: aliceState.player.game.id, guess: answer }, now),
    updatePlayer('store-alice', 'guess', { gameId: aliceState.player.game.id, guess: answer }, now),
  ]);
  assert.equal(requests.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await findPlayer('store-alice')).wins, 1);

  const wrong = answer === 'crane' ? 'stone' : 'crane';
  await updatePlayer('store-bob', 'guess', { gameId: bobState.player.game.id, guess: wrong }, now);
  await updatePlayer('store-bob', 'guess', { gameId: bobState.player.game.id, guess: answer }, now);

  const nextTime = aliceState.round.endsAt + 1;
  aliceState = await loadState('store-alice', nextTime);
  bobState = await loadState('store-bob', nextTime);
  assert.equal(aliceState.player.game.id, bobState.player.game.id);
  assert.equal(aliceState.player.game.status, 'playing');
  assert.equal(aliceState.player.game.guesses.length, 0);
  const ranks = await leaderboard();
  assert.equal(ranks.find(p => p.name === 'Store Alice').wins, 1);
  assert.equal(ranks.find(p => p.name === 'Store Bob').wins, 1);
});

test('stale round guesses are rejected without changing the new board', { skip: Boolean(process.env.DATABASE_URL) }, async () => {
  await join('Store Carol', 'store-carol');
  const state = await loadState('store-carol', Date.now());
  const oldGameId = state.player.game.id;
  const nextTime = state.round.endsAt + 1;
  await assert.rejects(updatePlayer('store-carol', 'guess', { gameId: oldGameId, guess: 'crane' }, nextTime), /Phiên 10 phút/);
  const refreshed = await loadState('store-carol', nextTime);
  assert.notEqual(refreshed.player.game.id, oldGameId);
  assert.equal(refreshed.player.game.guesses.length, 0);
});

test('all online players must approve a skip and unfinished players receive no point', { skip: Boolean(process.env.DATABASE_URL) }, async () => {
  const now = Date.now() + ROUND_MS * 3;
  await join('Store Dave', 'store-dave');
  await join('Store Eve', 'store-eve');
  const dave = await loadState('store-dave', now);
  const eve = await loadState('store-eve', now);
  const oldRound = dave.round.slot;

  await updatePlayer('store-dave', 'guess', { gameId: oldRound, guess: dave.player.game.answer }, now + 1);
  const proposed = await updatePlayer('store-dave', 'proposeSkip', {}, now + 2);
  assert.equal(proposed.round.slot, oldRound);
  assert.equal(proposed.skipVote.accepted, 1);
  assert.equal(proposed.skipVote.total, 2);

  const notification = await loadState('store-eve', now + 3);
  assert.equal(notification.skipVote.proposedByName, 'Store Dave');
  assert.equal(notification.skipVote.hasVoted, false);
  const approved = await updatePlayer('store-eve', 'voteSkip', { voteId: notification.skipVote.id, accept: true }, now + 4);
  assert.notEqual(approved.round.slot, oldRound);
  assert.equal(approved.skipVote, null);

  const daveAfter = await loadState('store-dave', now + 5);
  const eveAfter = await loadState('store-eve', now + 5);
  assert.equal(daveAfter.player.wins, 1);
  assert.equal(daveAfter.player.played, 1);
  assert.equal(eveAfter.player.wins, 0);
  assert.equal(eveAfter.player.played, 0);
  assert.equal(eveAfter.player.game.id, daveAfter.player.game.id);
});
