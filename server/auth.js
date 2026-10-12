import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt=promisify(scryptCallback);
export async function hashPassword(password){
  const salt=randomBytes(16).toString('hex');
  const derived=await scrypt(password,salt,64);
  return `scrypt$${salt}$${Buffer.from(derived).toString('hex')}`;
}
export async function verifyPassword(password,stored){
  const [method,salt,hex]=String(stored||'').split('$');
  if(method!=='scrypt'||!salt||!hex)return false;
  const expected=Buffer.from(hex,'hex'),actual=Buffer.from(await scrypt(password,salt,expected.length));
  return expected.length===actual.length&&timingSafeEqual(expected,actual);
}
