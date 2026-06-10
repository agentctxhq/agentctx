/**
 * Zero-dependency ULID generation (SPEC §2.1: record IDs are ULIDs,
 * sortable by creation time).
 *
 * Layout: 10 chars Crockford-base32 timestamp (48 bits, ms precision) +
 * 16 chars randomness (80 bits). Monotonic within the same millisecond:
 * the random part is incremented so IDs generated in one process always
 * sort in creation order.
 */
import { randomBytes } from "node:crypto";

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RANDOM_LEN = 16;

let lastTime = -1;
let lastRandom: number[] = [];

export function ulid(now: number = Date.now()): string {
  if (now === lastTime) {
    incrementRandom(lastRandom);
  } else {
    lastTime = now;
    lastRandom = freshRandom();
  }
  let out = encodeTime(now);
  for (const value of lastRandom) {
    out += ENCODING.charAt(value);
  }
  return out;
}

function encodeTime(ms: number): string {
  let out = "";
  let t = ms;
  for (let i = 0; i < TIME_LEN; i++) {
    out = ENCODING.charAt(t % 32) + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function freshRandom(): number[] {
  const bytes = randomBytes(RANDOM_LEN);
  const values: number[] = [];
  for (const byte of bytes) {
    values.push(byte & 31);
  }
  return values;
}

function incrementRandom(values: number[]): void {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = (values[i] ?? 0) + 1;
    if (v <= 31) {
      values[i] = v;
      return;
    }
    values[i] = 0;
  }
}
