/* The world layer, generated once when the player presses Generate: a square of the chosen size centred on
   the start point, with land shaped by noise and ocean all around the edges. A small world comes out as an
   island, a large one as a continent with bays and inland lakes. Heights are kept on a coarse grid
   (32 m cells, or coarser so the grid stays at most 1024 x 1024). */
import { fbm, salt } from './noise.js';

/**
 * @typedef {{ size: number, seed: number, half: number, res: number, cell: number, height: Float32Array,
 *             heightAt: (x: number, z: number) => number, isLand: (x: number, z: number) => boolean, ms: number }} World
 */
/** @param {{ size: number, seed: number }} opts @returns {World} */
export function buildWorld(opts){
  const t0 = performance.now();
  const size = opts.size * 1000, half = size / 2, seed = opts.seed >>> 0;
  const res = Math.max(64, Math.min(1024, Math.round(size / 32))), cell = size / res;
  const height = new Float32Array(res * res);
  const sA = salt(seed, 1), sB = salt(seed, 2);
  const L = Math.max(size / 3, 3000);                       // size of the big land features
  for (let j = 0; j < res; j++) for (let i = 0; i < res; i++){
    const x = -half + (i + 0.5) * cell, z = -half + (j + 0.5) * cell;
    const n = fbm(x / L, z / L, sA, 6) - 0.5 + 0.25 * (fbm(x / (L * 0.25), z / (L * 0.25), sB, 3) - 0.5);
    const edge = Math.max(Math.abs(x), Math.abs(z)) / half;        // 0 at the centre, 1 at the border
    const fall = Math.min(Math.max((edge - 0.55) / 0.4, 0), 1);
    const centre = Math.exp(-Math.pow(Math.hypot(x, z) / (0.12 * size + 600), 2));   // keep the start point on land
    height[j * res + i] = 0.32 + 1.6 * n - 1.3 * fall * fall + 0.35 * centre;
  }
  const heightAt = (x, z) => {
    const fx = (x + half) / cell - 0.5, fz = (z + half) / cell - 0.5;
    if (fx < 0 || fz < 0 || fx > res - 1 || fz > res - 1) return -1;
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
    const i1 = Math.min(i + 1, res - 1), j1 = Math.min(j + 1, res - 1);
    const a = height[j * res + i], b = height[j * res + i1], c = height[j1 * res + i], d = height[j1 * res + i1];
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  return { size, seed, half, res, cell, height, heightAt, isLand: (x, z) => heightAt(x, z) > 0, ms: performance.now() - t0 };
}
