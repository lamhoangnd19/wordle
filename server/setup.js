import { database, setup } from './store.js';
if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL first.');
await setup();
await database().end();
console.log('Wordle Club database is ready.');
