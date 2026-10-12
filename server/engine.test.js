import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreGuess, applyGuess, chooseWord, publicGame } from './engine.js';
import { words } from './words.js';
test('green letters consume duplicates before yellow letters', () => {
  assert.deepEqual(scoreGuess('apple', 'allee'), ['correct','present','absent','absent','correct']);
  assert.deepEqual(scoreGuess('abbey', 'bobby'), ['present','absent','correct','absent','correct']);
  assert.deepEqual(scoreGuess('eerie', 'eagle'), ['correct','absent','absent','absent','correct']);
});
test('winning returns the answer only after completion', () => {
  const game = {id:'test',answer:'apple',guesses:[],status:'playing'};
  assert.equal('answer' in publicGame(game), false);
  applyGuess(game,'apple');
  assert.equal(game.status,'won');
  assert.equal(publicGame(game).answer,'apple');
  assert.throws(()=>applyGuess(game,'apple'));
  assert.equal(game.guesses.length,1);
});
test('six valid guesses end the game and reject a seventh', () => {
  const game = {id:'test',answer:'apple',guesses:[],status:'playing'};
  ['crane','stone','bread','flame','cloud','grape'].forEach(word=>applyGuess(game,word));
  assert.equal(game.status,'lost');
  assert.throws(()=>applyGuess(game,'apple'));
  assert.equal(game.guesses.length,6);
});
test('invalid and duplicate words do not consume a turn', () => {
  const game = {answer:'apple',guesses:[],status:'playing'};
  ['abc','abcde','12345','aaaaa',null].forEach(word=>assert.throws(()=>applyGuess(game,word)));
  assert.equal(game.guesses.length,0);
  applyGuess(game,'CRANE');
  assert.throws(()=>applyGuess(game,'crane'));
  assert.equal(game.guesses.length,1);
});
test('dictionary has unique five-letter words and random choice avoids last answer',()=>{
  assert.ok(words.length>800);
  assert.equal(words.length,new Set(words).size);
  words.forEach(word=>assert.match(word,/^[a-z]{5}$/));
  for(let i=0;i<100;i++) {const choice=chooseWord('apple');assert.notEqual(choice,'apple');assert.ok(words.includes(choice));}
});
