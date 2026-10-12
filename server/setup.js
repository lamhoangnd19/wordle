import { setup } from './store.js';

if (!process.env.DATABASE_URL && !process.env.DATABASE_URL_UNPOOLED) throw new Error('Set DATABASE_URL first.');

try {
  await setup(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL);
} catch (error) {
  const canFallback = process.env.DATABASE_URL && process.env.DATABASE_URL_UNPOOLED && error.code === 'CONNECT_TIMEOUT';
  if (!canFallback) throw error;
  console.warn('Direct Neon connection timed out; retrying migration through the pooled connection.');
  await setup(process.env.DATABASE_URL);
}
console.log('Wordle Club database is ready.');
