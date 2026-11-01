/* Roads, in 512 m chunks, from two sources:
   - the world history's roads (src/gen/history.js): farm tracks, roads and main roads across the country, cut
     into pieces of 6 segments (24 m each) that belong to the chunk of their first point;
   - inside towns only, a placeholder street grid: every 88 m, bent by a smooth noise field so streets curve;
     every 4th line is a wider main street that is always kept; about 18% of the others are dropped to make
     bigger blocks (district street patterns replace this in step 4e).
   Every road is a polyline of 7 points with a width. Town roads (the grid, and history roads inside a town)
   have curbs, sidewalks, buildings and street lights; country roads lie level with the fields.
   Each chunk is built from the seed, the history and its own position only: the same in any order. */
import { h2, hf } from '../world/hash.js';
import { vnoise, salt } from './noise.js';

export const ROAD_CHUNK = 512, GRID = 88, SAMPLES = 6;
/** a number key for a pair of integers (faster than text keys like "3,-2") */
export const key2 = (x, z) => (x + 524288) * 1048576 + (z + 524288);
export const SIDEWALK = 3;                                   // sidewalk width beyond each road edge (m)

/** @typedef {{ id: number, pts: Float32Array, w: number, major: boolean, type: number, town: boolean }} Road
 *  type: 0 street, 1 main street or main road, 2 farm track, 3 road */
// widths (m) of the history's road classes: farm track, road, main road
const CLASS_W = [4, 7, 10], CLASS_TYPE = [2, 3, 1];

/** The history's roads and towns, as the road generator needs them (plain data, so it can go to a worker).
 *  @param {any} history */
export function roadNetwork(history){
  const towns = [];
  if (history) for (const s of history.settlements){
    if (!s.alive) continue;
    const r = Math.sqrt(s.pop / (3000 * Math.PI)) * 1000;
    if (r < 60) continue;                                   // hamlets: no street grid
    towns.push([s.x * 1000, s.z * 1000, r * 1.25 + 60, s.pop]);
  }
  return { towns, paths: history ? history.roads.map((r) => ({ pts: r.pts, cls: r.cls })) : [] };
}

/** @param {import('./world.js').World} world @param {{ towns: number[][], paths: { pts: Float32Array, cls: number }[] }} [net] */
export function makeRoads(world, net = { towns: [], paths: [] }){
  const seed = world.seed, sKeep = salt(seed, 11), sX = salt(seed, 12), sZ = salt(seed, 13), sId = salt(seed, 14);
  const WA = 34, WS = 640;                                   // bend: up to 34 m, over ~640 m
  /** the bent position of the unbent grid point (qx, qz) @returns {[number, number]} */
  const bend = (qx, qz) => [qx + WA * (2 * vnoise(qx / WS, qz / WS, sX) - 1), qz + WA * (2 * vnoise(qx / WS, qz / WS, sZ) - 1)];
  const major = (line) => ((line % 4) + 4) % 4 === 0;
  const cache = new Map();
  // towns in 1 km buckets, for "is this point in a town?"
  const tb = new Map();
  for (const t of net.towns){
    const n = Math.ceil(t[2] / 1000);
    for (let b = -n; b <= n; b++) for (let a = -n; a <= n; a++){
      const k = key2(Math.floor(t[0] / 1000) + a, Math.floor(t[1] / 1000) + b); let l = tb.get(k); if (!l){ l = []; tb.set(k, l); } l.push(t);
    }
  }
  const inTown = (x, z) => (tb.get(key2(Math.floor(x / 1000), Math.floor(z / 1000))) || []).some((t) => Math.hypot(x - t[0], z - t[1]) < t[2]);
  /** the town at (x, z) ([x, z, radius, people]), or null */
  const townAt = (x, z) => (tb.get(key2(Math.floor(x / 1000), Math.floor(z / 1000))) || []).find((t) => Math.hypot(x - t[0], z - t[1]) < t[2]) || null;
  // the history's roads, resampled every 24 m and cut into pieces of 6 segments, by chunk of their first point
  const pieces = new Map(), sP = salt(seed, 15), STEP = 24;
  net.paths.forEach((path, pi) => {
    const P = path.pts, n = P.length / 2;
    if (n < 2) return;
    const out = [P[0], P[1]];
    let carry = 0;
    for (let k = 0; k + 1 < n; k++){
      const ax = P[2 * k], az = P[2 * k + 1], bx = P[2 * k + 2], bz = P[2 * k + 3], L = Math.hypot(bx - ax, bz - az);
      let t = STEP - carry;
      while (t <= L){ out.push(ax + (bx - ax) * t / L, az + (bz - az) * t / L); t += STEP; }
      carry = L - (t - STEP);
    }
    if (carry > 1){ out.push(P[2 * n - 2], P[2 * n - 1]); }
    const m = out.length / 2;
    for (let s0 = 0, run = 0; s0 + 1 < m; s0 += SAMPLES, run++){
      const pts = new Float32Array((SAMPLES + 1) * 2);
      for (let q = 0; q <= SAMPLES; q++){ const idx = Math.min(s0 + q, m - 1); pts[2 * q] = out[2 * idx]; pts[2 * q + 1] = out[2 * idx + 1]; }
      const cls = path.cls, mid = SAMPLES;                   // centre point of the piece
      const town = inTown(pts[mid], pts[mid + 1]);
      const e = { id: h2(pi, run, sP), pts, w: CLASS_W[cls], major: cls === 2, type: CLASS_TYPE[cls], town };
      const k = key2(Math.floor(pts[0] / ROAD_CHUNK), Math.floor(pts[1] / ROAD_CHUNK));
      let l = pieces.get(k); if (!l){ l = []; pieces.set(k, l); } l.push(e);
    }
  });
  /** roads whose first grid point lies in chunk (cx, cz) @returns {Road[]} */
  function chunk(cx, cz){
    const key = key2(cx, cz);
    let c = cache.get(key);
    if (c) return c;
    c = [];
    const i0 = Math.ceil(cx * ROAD_CHUNK / GRID), i1 = Math.ceil((cx + 1) * ROAD_CHUNK / GRID);
    const j0 = Math.ceil(cz * ROAD_CHUNK / GRID), j1 = Math.ceil((cz + 1) * ROAD_CHUNK / GRID);
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) for (let dir = 0; dir < 2; dir++){
      const isMajor = major(dir === 0 ? j : i);
      if (!isMajor && hf(h2(i * 2 + dir, j, sKeep)) > 0.82) continue;
      // the grid only inside towns
      const [mx, mz] = bend((i + (dir === 0 ? 0.5 : 0)) * GRID, (j + (dir === 1 ? 0.5 : 0)) * GRID);
      if (!inTown(mx, mz)) continue;
      const pts = new Float32Array((SAMPLES + 1) * 2);
      let onLand = true;
      for (let k = 0; k <= SAMPLES; k++){
        const t = k / SAMPLES;
        const [x, z] = bend((i + (dir === 0 ? t : 0)) * GRID, (j + (dir === 1 ? t : 0)) * GRID);
        if (!world.isLand(x, z)){ onLand = false; break; }
        pts[2 * k] = x; pts[2 * k + 1] = z;
      }
      if (!onLand) continue;
      c.push({ id: h2(i * 2 + dir, j, sId), pts, w: isMajor ? 14 : 9, major: isMajor, type: isMajor ? 1 : 0, town: true });
    }
    for (const e of pieces.get(key) || []) c.push(e);
    cache.set(key, c);
    if (cache.size > 4096) cache.delete(cache.keys().next().value);
    return c;
  }
  /** A lookup grid (32 m cells) of the roads from chunk (cx, cz) and its neighbours, each listed in every cell
   *  its centre line comes within reach of (its half width + sidewalk + 4 m). near(x, z) gives the roads that
   *  can matter at a point, instead of checking every road nearby. */
  const indexes = new Map(), IC = 32;
  function index(cx, cz){
    const key = key2(cx, cz);
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
          const k = key2(gx, gz); let l = cells.get(k); if (!l){ l = []; cells.set(k, l); } l.push(e);
        }
    }
    const EMPTY = [];
    ix = { near: (x, z) => cells.get(key2(Math.floor(x / IC), Math.floor(z / IC))) || EMPTY };
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
  return { chunk, around, index, bend, townAt, cached: (cx, cz) => cache.has(key2(cx, cz)) };
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
