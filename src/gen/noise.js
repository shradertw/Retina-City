/* Seeded value noise for the generators (same integer hash as the shaders). */
import { h2, hf } from '../world/hash.js';

/** Smooth value noise in [0, 1] with one lattice cell per unit. @param {number} x @param {number} z @param {number} salt */
export function vnoise(x, z, salt){
  const i = Math.floor(x), j = Math.floor(z);
  let u = x - i, v = z - j; u = u * u * (3 - 2 * u); v = v * v * (3 - 2 * v);
  const a = hf(h2(i, j, salt)), b = hf(h2(i + 1, j, salt)), c = hf(h2(i, j + 1, salt)), d = hf(h2(i + 1, j + 1, salt));
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
/** Several octaves of value noise, in [0, 1]. @param {number} x @param {number} z @param {number} salt @param {number} [octaves] */
export function fbm(x, z, salt, octaves = 5){
  let s = 0, amp = 0.5, f = 1, norm = 0;
  for (let o = 0; o < octaves; o++){ s += amp * vnoise(x * f, z * f, (salt + o * 1013) >>> 0); norm += amp; amp *= 0.5; f *= 2.03; }
  return s / norm;
}
/** A salt for one purpose in one world. @param {number} seed @param {number} k */
export const salt = (seed, k) => (Math.imul(seed >>> 0, 0x2C1B3C6D) ^ Math.imul(k, 0x297A2D39)) >>> 0;
