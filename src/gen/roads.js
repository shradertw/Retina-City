/* Roads, generated in 512 m chunks. Placeholder layout for checkpoint 1a: a grid every 88 m, bent by a
   smooth noise field so streets curve; every 4th line is a wider main road that is always kept; about 18%
   of the other segments are dropped to make bigger blocks; roads stay on land.
   A road segment runs between two grid points and is stored as a polyline (7 points) with a width. Each
   segment belongs to the chunk holding its first grid point, so every chunk is built from the seed and
   its own position only: the same in any order. (Later layers replace this layout with district rules.) */
import { h2, hf } from '../world/hash.js';
import { vnoise, salt } from './noise.js';

export const ROAD_CHUNK = 512, GRID = 88, SAMPLES = 6;
export const SIDEWALK = 3;                                   // sidewalk width beyond each road edge (m)

/** @typedef {{ id: number, i: number, j: number, dir: number, pts: Float32Array, w: number, major: boolean }} Road */

/** @param {import('./world.js').World} world */
export function makeRoads(world){
  const seed = world.seed, sKeep = salt(seed, 11), sX = salt(seed, 12), sZ = salt(seed, 13), sId = salt(seed, 14);
  const WA = 34, WS = 640;                                   // bend: up to 34 m, over ~640 m
  /** the bent position of the unbent grid point (qx, qz) @returns {[number, number]} */
  const bend = (qx, qz) => [qx + WA * (2 * vnoise(qx / WS, qz / WS, sX) - 1), qz + WA * (2 * vnoise(qx / WS, qz / WS, sZ) - 1)];
  const major = (line) => ((line % 4) + 4) % 4 === 0;
  const cache = new Map();
  /** roads whose first grid point lies in chunk (cx, cz) @returns {Road[]} */
  function chunk(cx, cz){
    const key = cx + ',' + cz;
    let c = cache.get(key);
    if (c) return c;
    c = [];
    const i0 = Math.ceil(cx * ROAD_CHUNK / GRID), i1 = Math.ceil((cx + 1) * ROAD_CHUNK / GRID);
    const j0 = Math.ceil(cz * ROAD_CHUNK / GRID), j1 = Math.ceil((cz + 1) * ROAD_CHUNK / GRID);
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) for (let dir = 0; dir < 2; dir++){
      const isMajor = major(dir === 0 ? j : i);
      if (!isMajor && hf(h2(i * 2 + dir, j, sKeep)) > 0.82) continue;
      const pts = new Float32Array((SAMPLES + 1) * 2);
      let onLand = true;
      for (let k = 0; k <= SAMPLES; k++){
        const t = k / SAMPLES;
        const [x, z] = bend((i + (dir === 0 ? t : 0)) * GRID, (j + (dir === 1 ? t : 0)) * GRID);
        if (!world.isLand(x, z)){ onLand = false; break; }
        pts[2 * k] = x; pts[2 * k + 1] = z;
      }
      if (!onLand) continue;
      c.push({ id: h2(i * 2 + dir, j, sId), i, j, dir, pts, w: isMajor ? 14 : 9, major: isMajor });
    }
    cache.set(key, c);
    if (cache.size > 4096) cache.delete(cache.keys().next().value);
    return c;
  }
  /** A lookup grid (32 m cells) of the roads from chunk (cx, cz) and its neighbours, each listed in every cell
   *  its centre line comes within reach of (its half width + sidewalk + 4 m). near(x, z) gives the roads that
   *  can matter at a point, instead of checking every road nearby. */
  const indexes = new Map(), IC = 32;
  function index(cx, cz){
    const key = cx + ',' + cz;
    let ix = indexes.get(key);
    if (ix) return ix;
    const cells = new Map();
    for (const e of around(cx, cz, 1)){
      const pad = e.w / 2 + SIDEWALK + 4, p = e.pts;
      let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9;
      for (let k = 0; k <= SAMPLES; k++){ x0 = Math.min(x0, p[2 * k]); x1 = Math.max(x1, p[2 * k]); z0 = Math.min(z0, p[2 * k + 1]); z1 = Math.max(z1, p[2 * k + 1]); }
      for (let gz = Math.floor((z0 - pad) / IC); gz <= Math.floor((z1 + pad) / IC); gz++)
        for (let gx = Math.floor((x0 - pad) / IC); gx <= Math.floor((x1 + pad) / IC); gx++){
          const cx2 = (gx + 0.5) * IC, cz2 = (gz + 0.5) * IC;
          if (distToRoad(e, cx2, cz2) > pad + IC * 0.71) continue;   // the cell's centre is too far for any point in it
          const k = gx + ',' + gz; let l = cells.get(k); if (!l){ l = []; cells.set(k, l); } l.push(e);
        }
    }
    const EMPTY = [];
    ix = { near: (x, z) => cells.get(Math.floor(x / IC) + ',' + Math.floor(z / IC)) || EMPTY };
    indexes.set(key, ix);
    if (indexes.size > 512) indexes.delete(indexes.keys().next().value);
    return ix;
  }
  /** roads from chunk (cx, cz) and its neighbours within r chunks @returns {Road[]} */
  function around(cx, cz, r = 1){
    const out = [];
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) for (const e of chunk(cx + dx, cz + dz)) out.push(e);
    return out;
  }
  return { chunk, around, index, bend, cached: (cx, cz) => cache.has(cx + ',' + cz) };
}

/** distance from (x, z) to a road's centre line @param {Road} e @param {number} x @param {number} z */
export function distToRoad(e, x, z){
  const p = e.pts; let best = 1e9;
  for (let k = 0; k < SAMPLES; k++){
    const ax = p[2 * k], az = p[2 * k + 1], bx = p[2 * k + 2] - ax, bz = p[2 * k + 3] - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * bx + (z - az) * bz) / (bx * bx + bz * bz || 1)));
    best = Math.min(best, Math.hypot(x - ax - bx * t, z - az - bz * t));
  }
  return best;
}
