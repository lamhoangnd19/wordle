import { randomInt } from 'node:crypto';
import { words, dictionary } from './words.js';
export function scoreGuess(answer, guess) {
  const result = Array(5).fill('absent');
  const remaining = {};
  for (let i = 0; i < 5; i++) {
    if (answer[i] === guess[i]) result[i] = 'correct';
    else remaining[answer[i]] = (remaining[answer[i]] || 0) + 1;
  }
  for (let i = 0; i < 5; i++) {
    if (result[i] !== 'correct' && remaining[guess[i]] > 0) {
      result[i] = 'present'; remaining[guess[i]]--;
    }
  }
  return result;
}
export function chooseWord(previous) {
  const choices = words.filter(word => word !== previous);
  return choices[randomInt(choices.length)];
}
export function applyGuess(game, raw) {
  if (game.status !== 'playing') throw new Error('Ván này đã kết thúc. Hãy chơi từ mới.');
  const guess = String(raw || '').toLowerCase();
  if (!/^[a-z]{5}$/.test(guess)) throw new Error('Hãy nhập đủ 5 chữ cái.');
  if (!dictionary.has(guess)) throw new Error('Từ chưa có trong từ điển của Club. Thử một từ khác nhé!');
  if (game.guesses.some(row => row.word === guess)) throw new Error('Bạn đã thử từ này rồi.');
  game.guesses.push({ word: guess, colors: scoreGuess(game.answer, guess) });
  if (guess === game.answer) game.status = 'won';
  else if (game.guesses.length === 6) game.status = 'lost';
  return game;
}
export function publicGame(game) {
  if (!game) return null;
  return { id: game.id, guesses: game.guesses, status: game.status, ...(game.status !== 'playing' ? { answer: game.answer } : {}) };
}
