import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import handler from '../api/game.js';
import { findPlayer } from './store.js';

test('API gives every player the same timed round and credits wins exactly once', { skip: Boolean(process.env.DATABASE_URL) }, async () => {
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    req.body = raw ? JSON.parse(raw) : undefined;
    await handler(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(body, cookie, origin) {
    const response = await fetch(`${base}/api/game`, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }

  try {
    const guest = await call();
    assert.equal(guest.data.player, null);
    assert.equal(guest.data.game, null);
    assert.ok(guest.data.round.id);
    assert.equal(new Date(guest.data.round.endsAt) - new Date(guest.data.round.startsAt), 10 * 60 * 1000);

    assert.equal((await call({ action: 'join', name: 'A' })).status, 400);
    const alice = await call({ action: 'join', name: 'API Alice' });
    const bob = await call({ action: 'join', name: 'API Bob' });
    assert.ok(alice.cookie);
    assert.notEqual(alice.data.player.id, bob.data.player.id);
    assert.equal(alice.data.round.id, bob.data.round.id);
    assert.equal(alice.data.game.id, bob.data.game.id);
    assert.equal('answer' in alice.data.game, false);
    assert.equal('token' in alice.data.player, false);
    assert.equal((await call({ action: 'join', name: 'api alice' })).status, 400);
    assert.equal((await call({ action: 'guess', gameId: alice.data.game.id, guess: 'crane' }, alice.cookie, 'https://attacker.example')).status, 400);

    const rawToken = alice.cookie.split('=')[1];
    const internal = await findPlayer(createHash('sha256').update(rawToken).digest('hex'));
    const won = await call({ action: 'guess', gameId: alice.data.game.id, guess: internal.game.answer }, alice.cookie);
    assert.equal(won.data.game.status, 'won');
    assert.equal(won.data.player.wins, 1);
    assert.equal(won.data.player.played, 1);

    const duplicate = await call({ action: 'guess', gameId: alice.data.game.id, guess: internal.game.answer }, alice.cookie);
    assert.equal(duplicate.status, 400);
    const after = await call(undefined, alice.cookie);
    assert.equal(after.data.player.wins, 1);
    assert.equal(after.data.round.id, alice.data.round.id);
    assert.equal((await call(undefined, bob.cookie)).data.player.wins, 0);

    const proposed = await call({ action: 'proposeSkip' }, alice.cookie);
    assert.equal(proposed.data.skipVote.accepted, 1);
    assert.equal(proposed.data.skipVote.total, 2);
    const notified = await call(undefined, bob.cookie);
    assert.equal(notified.data.skipVote.proposedByName, 'API Alice');
    const approved = await call({ action: 'voteSkip', voteId: notified.data.skipVote.id, accept: true }, bob.cookie);
    assert.notEqual(approved.data.round.id, alice.data.round.id);
    assert.equal(approved.data.player.wins, 0);
    assert.equal(approved.data.player.played, 0);
    assert.equal((await call(undefined, alice.cookie)).data.player.wins, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
