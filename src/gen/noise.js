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
/** The same as fbm(), much faster when sampled many times over a known area (x, z in [lo, hi]): each octave's
 *  lattice values are worked out once into a table instead of hashed at every sample. Identical results.
 *  @param {number} salt @param {number} octaves @param {number} lo @param {number} hi */
export function fbmTable(salt, octaves, lo, hi){
  const oct = [];
  let f = 1, norm = 0, amp = 0.5;
  for (let o = 0; o < octaves; o++){
    const s = (salt + o * 1013) >>> 0, i0 = Math.floor(lo * f) - 1, n = Math.floor(hi * f) + 2 - i0 + 1;
    const tab = new Float32Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) tab[j * n + i] = hf(h2(i0 + i, i0 + j, s));
    oct.push({ f, i0, n, tab, amp }); norm += amp; amp *= 0.5; f *= 2.03;
  }
  return (x, z) => {
    let sum = 0;
    for (const { f, i0, n, tab, amp } of oct){
      const X = x * f, Z = z * f, i = Math.floor(X), j = Math.floor(Z);
      let u = X - i, v = Z - j; u = u * u * (3 - 2 * u); v = v * v * (3 - 2 * v);
      const k = (j - i0) * n + (i - i0), a = tab[k], b = tab[k + 1], c = tab[k + n], d = tab[k + n + 1];
      sum += amp * (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v);
    }
    return sum / norm;
  };
}
