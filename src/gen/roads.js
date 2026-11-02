/* Roads, in 512 m chunks, from two sources:
   - the world history's roads (src/gen/history.js): farm tracks, roads and main roads across the country, cut
     into pieces of 6 segments (24 m each) that belong to the chunk of their first point;
   - town streets, where the history built town blocks (src/gen/districts.js). Each town has one lattice of
     points LAT m apart, turned to line up with the main road nearest its middle. Each street pattern uses
     every n-th lattice line, so streets of different patterns meet at shared points (or end at the edge of
     their area). A street is kept where the block under its middle belongs to that town and pattern:
       old core   (blocks first built before year 500)  every line (60 m), points moved a lot, many dropped
       grid era   (500-750)                             every 2nd (120 m), straight, every 4th a main street
       late era   (750 on)                              every 3rd (180 m), streets bow in gentle curves
       industry   (any year)                            every 4th (240 m), few streets
     Widths: old streets 8 m (two narrow lanes); town streets 12 m (two lanes and parking); main streets 24 m
     (four lanes, a turn lane and parking); industrial streets 14 m (wide lanes for trucks).
     A lattice point is moved by an amount set by the pattern of the block under it (so every street that
     meets there agrees on where it is); late streets also bow between their ends. Both ends of a street must
     be on or next to the town's blocks. A street that would run alongside one of the history's roads is left
     out (the road is the main street).
   Every road is a polyline of 7 points with a width. Town roads (town streets, and history roads through town
   blocks) have curbs, sidewalks, buildings and street lights; country roads lie level with the fields.
   Each chunk is built from the seed, the history and its own position only: the same in any order. */
import { h2, hf, rnd } from '../world/hash.js';
import { vnoise, salt } from './noise.js';

export const ROAD_CHUNK = 512, GRID = 88, SAMPLES = 6;
// street patterns: every n-th lattice line, how far lattice points move (m), how far streets bow between
// their ends (m), share of streets dropped, width (m), main street every major-th line and its width
export const LAT = 60;
export const PATTERNS = [
  { name: 'old core', n: 1, A: 12, bow: 4, drop: 0.3, w: 8 },
  { name: 'grid', n: 2, A: 2, bow: 0, drop: 0.08, w: 12, major: 4, wMain: 24 },
  { name: 'late', n: 3, A: 12, bow: 30, drop: 0.2, w: 12 },
  { name: 'industry', n: 4, A: 4, bow: 0, drop: 0.15, w: 14 },
];
/** a town block's street pattern, from its district and the year it was first built */
export const patternOf = (zone, born) => zone === 3 ? 3 : born < 500 ? 0 : born < 750 ? 1 : 2;
/** a number key for a pair of integers (faster than text keys like "3,-2") */
export const key2 = (x, z) => (x + 524288) * 1048576 + (z + 524288);
export const SIDEWALK = 3;                                   // sidewalk width beyond each road edge (m)
export const SIDEWALK_MAIN = 4.5;                            // ... along roads wider than 18 m (main streets)
/** the sidewalk width along road e (the shader uses the same rule: half width over 9 m) */
export const sidewalkOf = (e) => (e.w > 18 ? SIDEWALK_MAIN : SIDEWALK);

/** @typedef {{ id: number, pts: Float32Array, w: number, major: boolean, type: number, town: boolean }} Road
 *  type: 0 street, 1 main street or main road, 2 farm track, 3 road */
// widths (m) of the history's road classes: farm track, road, main road
// widths (m) of the history's road classes (farm track, road, main road): in the country (track; two lanes
// with shoulders; four lanes with shoulders) and where they run through a town (a lane and a half; two lanes
// with parking; four lanes, a turn lane and parking)
const CLASS_W = [4, 8, 18], CLASS_W_TOWN = [6, 12, 16], CLASS_TYPE = [2, 3, 1];

/** The history's roads, towns and town blocks (as they stand at the end), as the road and building generators
 *  need them: plain data, so it can go to a worker.
 *  towns: [x, z, radius, people, street angle, settlement id, x0, z0, x1, z1 (the box around its blocks)]
 *  blocks: every standing block: key (j x res + i), district, storeys, owner, year first built, year last built
 *  @param {any} history */
export function roadNetwork(history){
  const towns = [], paths = history ? history.roads.map((r) => ({ pts: r.pts, cls: r.cls, clsAt: r.clsAt })) : [];
  if (!history) return { towns, paths, blocks: null };
  const BK = history.blocks;
  // blocks still standing at the end
  let blocks = null;
  const box = new Map();
  if (BK){
    const v = BK.snap[BK.snap.length - 1], n = v.reduce((a, c) => a + (c ? 1 : 0), 0);
    blocks = { res: BK.res, half: BK.half, size: BK.size, key: new Int32Array(n), zone: new Uint8Array(n), st: new Uint8Array(n),
      owner: new Int32Array(n), born: new Int16Array(n), built: new Int16Array(n), ind: new Uint8Array(n) };
    const last = new Int16Array(BK.n).fill(-1);
    for (let e = 0; e < BK.evB.length; e++) last[BK.evB[e]] = BK.evS[e];
    let q = 0;
    for (let b = 0; b < v.length; b++){
      if (!v[b]) continue;
      blocks.key[q] = BK.j[b] * BK.res + BK.i[b]; blocks.zone[q] = v[b] >> 6; blocks.st[q] = v[b] & 63; blocks.owner[q] = BK.owner[b];
      blocks.born[q] = history.year[BK.born[b]]; blocks.built[q] = history.year[last[b] >= 0 ? last[b] : BK.built ? BK.built[b] : BK.born[b]];
      blocks.ind[q] = BK.ind ? BK.ind[b] : (v[b] >> 6) === 3 ? 1 : 0;
      const x = -BK.half + BK.i[b] * BK.size, z = -BK.half + BK.j[b] * BK.size;
      let bx = box.get(BK.owner[b]); if (!bx){ bx = [x, z, x, z]; box.set(BK.owner[b], bx); }
      bx[0] = Math.min(bx[0], x); bx[1] = Math.min(bx[1], z); bx[2] = Math.max(bx[2], x + BK.size); bx[3] = Math.max(bx[3], z + BK.size);
      q++;
    }
  }
  // road points in 1 km buckets, for each town's street angle (the direction of the road nearest its middle)
  const pb = new Map();
  for (const p of paths){
    if (p.cls < 1) continue;
    for (let n = 0; n + 1 < p.pts.length / 2; n++){
      const x = p.pts[2 * n], z = p.pts[2 * n + 1], k = key2(Math.floor(x / 1000), Math.floor(z / 1000));
      let l = pb.get(k); if (!l){ l = []; pb.set(k, l); } l.push(x, z, p.pts[2 * n + 2] - x, p.pts[2 * n + 3] - z);
    }
  }
  for (const s of history.settlements){
    if (!s.alive) continue;
    const bx = box.get(s.id);
    // the town's extent: its blocks (from age 4), else the old-town density of 3000 people per km2
    const area = s.areaAt ? s.areaAt[s.areaAt.length - 1] : 0;
    const r = (area > 0 ? Math.sqrt(area / Math.PI) : Math.sqrt(s.pop / (3000 * Math.PI))) * 1000;
    if (r < 60 && !bx) continue;
    const x = s.x * 1000, z = s.z * 1000;
    let ang = 0, bd = 1e18;
    for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++){
      const l = pb.get(key2(Math.floor(x / 1000) + a, Math.floor(z / 1000) + b)); if (!l) continue;
      for (let n = 0; n < l.length; n += 4){ const d = (l[n] - x) ** 2 + (l[n + 1] - z) ** 2; if (d < bd){ bd = d; ang = Math.atan2(l[n + 3], l[n + 2]); } }
    }
    towns.push([x, z, r * 1.25 + 60, s.pop, ang, s.id, ...(bx || [x - r, z - r, x + r, z + r])]);
  }
  return { towns, paths, blocks, streets: history.streets || null };
}

/** @param {import('./world.js').World} world @param {{ towns: number[][], paths: { pts: Float32Array, cls: number }[] }} [net] */
export function makeRoads(world, net = { towns: [], paths: [] }){
  const seed = world.seed, sId = salt(seed, 14);

  const cache = new Map();
  // towns in 1 km buckets (by the box around their blocks), for "which towns reach here?"
  const tb = new Map(), byId = new Map();
  for (const t of net.towns){
    byId.set(t[5], t);
    for (let b = Math.floor(t[7] / 1000); b <= Math.floor(t[9] / 1000); b++) for (let a = Math.floor(t[6] / 1000); a <= Math.floor(t[8] / 1000); a++){
      const k = key2(a, b); let l = tb.get(k); if (!l){ l = []; tb.set(k, l); } l.push(t);
    }
  }
  // the town blocks: grid key -> index
  const BL = net.blocks, blockAt = new Map();
  if (BL) for (let q = 0; q < BL.key.length; q++) blockAt.set(BL.key[q], q);
  /** the town block at (x, z), or -1 */
  const block = (x, z) => {
    if (!BL) return -1;
    const i = Math.floor((x + BL.half) / BL.size), j = Math.floor((z + BL.half) / BL.size);
    if (i < 0 || j < 0 || i >= BL.res || j >= BL.res) return -1;
    const q = blockAt.get(j * BL.res + i);
    return q === undefined ? -1 : q;
  };
  // in town: on a block or next to one (a street runs along the edge of its blocks)
  const inTown = (x, z) => {
    if (!BL) return (tb.get(key2(Math.floor(x / 1000), Math.floor(z / 1000))) || []).some((t) => Math.hypot(x - t[0], z - t[1]) < t[2]);
    for (const [a, b] of [[0, 0], [12, 0], [-12, 0], [0, 12], [0, -12]]) if (block(x + a, z + b) >= 0) return true;
    return false;
  };
  /** the town at (x, z) ([x, z, radius, people, ...]), or null */
  const townAt = (x, z) => {
    const q = block(x, z);
    if (q >= 0) return byId.get(BL.owner[q]) || null;
    return (tb.get(key2(Math.floor(x / 1000), Math.floor(z / 1000))) || []).find((t) => Math.hypot(x - t[0], z - t[1]) < t[2]) || null;
  };
  // the history's roads, resampled every 24 m and cut into pieces of 6 segments, by chunk of their first point
  const pieces = new Map(), sP = salt(seed, 15), STEP = 24;
  net.paths.forEach((path, pi) => {
    const P = path.pts, n = P.length / 2;
    if (n < 2) return;
    const out = [P[0], P[1]], src = [0];                    // src: the path point each sample comes from
    let carry = 0;
    for (let k = 0; k + 1 < n; k++){
      const ax = P[2 * k], az = P[2 * k + 1], bx = P[2 * k + 2], bz = P[2 * k + 3], L = Math.hypot(bx - ax, bz - az);
      let t = STEP - carry;
      while (t <= L){ out.push(ax + (bx - ax) * t / L, az + (bz - az) * t / L); src.push(k); t += STEP; }
      carry = L - (t - STEP);
    }
    if (carry > 1){ out.push(P[2 * n - 2], P[2 * n - 1]); src.push(n - 1); }
    const m = out.length / 2;
    for (let s0 = 0, run = 0; s0 + 1 < m; s0 += SAMPLES, run++){
      const pts = new Float32Array((SAMPLES + 1) * 2);
      for (let q = 0; q <= SAMPLES; q++){ const idx = Math.min(s0 + q, m - 1); pts[2 * q] = out[2 * idx]; pts[2 * q + 1] = out[2 * idx + 1]; }
      const mid = SAMPLES;                                   // centre point of the piece
      const cls = path.clsAt ? path.clsAt[src[Math.min(s0 + 3, m - 1)]] : path.cls;   // (its class there, when it varies along the road)
      const town = inTown(pts[mid], pts[mid + 1]);
      const e = { id: h2(pi, run, sP), pts, w: (town ? CLASS_W_TOWN : CLASS_W)[cls], major: cls === 2, type: CLASS_TYPE[cls], town };
      const k = key2(Math.floor(pts[0] / ROAD_CHUNK), Math.floor(pts[1] / ROAD_CHUNK));
      let l = pieces.get(k); if (!l){ l = []; pieces.set(k, l); } l.push(e);
    }
  });
  // history road pieces' segments in 64 m buckets, to keep town streets from doubling them
  const segB = new Map();
  for (const l of pieces.values()) for (const e of l){
    const p = e.pts;
    for (let k = 0; k < SAMPLES; k++){
      const mx = (p[2 * k] + p[2 * k + 2]) / 2, mz = (p[2 * k + 1] + p[2 * k + 3]) / 2, sk = key2(Math.floor(mx / 64), Math.floor(mz / 64));
      let b = segB.get(sk); if (!b){ b = []; segB.set(sk, b); } b.push(mx, mz, p[2 * k + 2] - p[2 * k], p[2 * k + 3] - p[2 * k + 1]);
    }
  }
  /** a history road runs along (within dist m of (x, z), within 30 degrees of direction (dx, dz))? */
  function alongRoad(x, z, dx, dz, dist){
    const L = Math.hypot(dx, dz) || 1, n = Math.ceil(dist / 64);
    for (let b = -n; b <= n; b++) for (let a = -n; a <= n; a++){
      const l = segB.get(key2(Math.floor(x / 64) + a, Math.floor(z / 64) + b)); if (!l) continue;
      for (let q = 0; q < l.length; q += 4){
        if (Math.hypot(l[q] - x, l[q + 1] - z) > dist) continue;
        const c = Math.abs(l[q + 2] * dx + l[q + 3] * dz) / (L * (Math.hypot(l[q + 2], l[q + 3]) || 1));
        if (c > 0.866) return true;
      }
    }
    return false;
  }
  const sNode = salt(seed, 40), sBow = salt(seed, 41);
  // a town's frame: (u, v) metres along and across its street angle, from its middle
  const toWorld = (t, u, v) => { const c = Math.cos(t[4]), sn = Math.sin(t[4]); return [t[0] + u * c - v * sn, t[1] + u * sn + v * c]; };
  /** lattice point (k, m) of town t, moved by the pattern of the block under it @returns {[number, number]} (u, v) */
  function node(t, k, m){
    const [x, z] = toWorld(t, k * LAT, m * LAT), q = block(x, z);
    const A = q >= 0 ? PATTERNS[patternOf(BL.zone[q], BL.born[q])].A : 3;
    const hN = h2(k + t[5] * 7919, m, sNode);
    return [k * LAT + A * (2 * rnd(hN, 1) - 1), m * LAT + A * (2 * rnd(hN, 2) - 1)];
  }
  // on or next to the town's blocks (within one block)?
  const nearTown = (t, x, z) => { for (const [a, b] of [[0, 0], [40, 0], [-40, 0], [0, 40], [0, -40]]){ const q = block(x + a, z + b); if (q >= 0 && BL.owner[q] === t[5]) return true; } return false; };
  // streets grown by the history simulation (src/gen/streets.js): each a straight piece, by chunk of its start
  const ST = net.streets, simStreets = new Map();
  if (ST) for (let i = 0; i < ST.n; i++){
    const ax = ST.ax[i], az = ST.az[i], bx = ST.bx[i], bz = ST.bz[i], cls = ST.cls[i];
    const pts = new Float32Array((SAMPLES + 1) * 2);
    for (let q = 0; q <= SAMPLES; q++){ pts[2 * q] = ax + (bx - ax) * q / SAMPLES; pts[2 * q + 1] = az + (bz - az) * q / SAMPLES; }
    // junction controls at its ends (0 none, 1 stop, 2 signals, 3 roundabout), for the markings
    const e = { id: h2(i, 7, sId), pts, w: ST.w[i], major: cls === 2, type: cls === 2 ? 1 : cls === 1 ? 0 : 2, town: cls > 0, jc: cls > 0 ? ST.ja[i] + 4 * ST.jb[i] : 0, street: true };
    const k = key2(Math.floor(ax / ROAD_CHUNK), Math.floor(az / ROAD_CHUNK));
    let l = simStreets.get(k); if (!l){ l = []; simStreets.set(k, l); } l.push(e);
  }
  /** town streets whose first point lies in chunk (cx, cz) */
  function townStreets(cx, cz, out){
    if (ST){
      for (const e of simStreets.get(key2(cx, cz)) || []){
        const p = e.pts, n2 = 2 * SAMPLES;
        if (e.town && alongRoad((p[0] + p[n2]) / 2, (p[1] + p[n2 + 1]) / 2, p[n2] - p[0], p[n2 + 1] - p[1], 15)) continue;
        out.push(e);
      }
      return;
    }
    if (!BL) return;
    const x0 = cx * ROAD_CHUNK, z0 = cz * ROAD_CHUNK, x1 = x0 + ROAD_CHUNK, z1 = z0 + ROAD_CHUNK;
    const seen = new Set();
    for (let b = Math.floor(z0 / 1000); b <= Math.floor((z1 - 1) / 1000); b++) for (let a = Math.floor(x0 / 1000); a <= Math.floor((x1 - 1) / 1000); a++)
    for (const t of tb.get(key2(a, b)) || []){
      if (seen.has(t[5]) || t[6] > x1 || t[8] < x0 || t[7] > z1 || t[9] < z0) continue;
      seen.add(t[5]);
      const c = Math.cos(t[4]), sn = Math.sin(t[4]);
      // the chunk's corners in the town's frame
      let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9;
      for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]){
        const u = (x - t[0]) * c + (z - t[1]) * sn, v = -(x - t[0]) * sn + (z - t[1]) * c;
        u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
      }
      const pad = 12, nodes = new Map();
      const nodeC = (k, m) => { const key = key2(k, m); let p = nodes.get(key); if (!p){ p = node(t, k, m); nodes.set(key, p); } return p; };
      const k0 = Math.floor((u0 - pad) / LAT), k1 = Math.ceil((u1 + pad) / LAT), m0 = Math.floor((v0 - pad) / LAT), m1 = Math.ceil((v1 + pad) / LAT);
      PATTERNS.forEach((P, f) => {
        const n = P.n, sK = salt(seed, 50 + f);
        for (let m = Math.ceil(m0 / n) * n; m <= m1; m += n) for (let k = Math.ceil(k0 / n) * n; k <= k1; k += n) for (let dir = 0; dir < 2; dir++){
          // dir 0: from lattice point (k, m) to (k + n, m); dir 1: to (k, m + n)
          const a = nodeC(k, m), [ax, az] = toWorld(t, a[0], a[1]);
          if (Math.floor(ax / ROAD_CHUNK) !== cx || Math.floor(az / ROAD_CHUNK) !== cz) continue;
          const line = (dir === 0 ? m : k) / n;
          const isMajor = !!P.major && ((line % P.major) + P.major) % P.major === 0;
          const hS = h2(k * 2 + dir + t[5] * 7919, m, sK);
          if (!isMajor && hf(hS) < P.drop) continue;
          const [mx, mz] = toWorld(t, (k + (dir === 0 ? n / 2 : 0)) * LAT, (m + (dir === 1 ? n / 2 : 0)) * LAT);
          const q = block(mx, mz);
          if (q < 0 || BL.owner[q] !== t[5] || patternOf(BL.zone[q], BL.born[q]) !== f) continue;
          const b = dir === 0 ? nodeC(k + n, m) : nodeC(k, m + n), [bx, bz] = toWorld(t, b[0], b[1]);
          if (!nearTown(t, ax, az) || !nearTown(t, bx, bz)) continue;
          // the points between the ends: straight, or bowed to one side (late streets, a little in old ones)
          const along = (dir === 0 ? k : m) / n + 0.5, bow = P.bow * (2 * vnoise(along / 3.3, line * 1.7 + 0.5, sBow) - 1), du = b[0] - a[0], dv = b[1] - a[1], L = Math.hypot(du, dv) || 1;
          const pts = new Float32Array((SAMPLES + 1) * 2);
          let onLand = true;
          for (let s2 = 0; s2 <= SAMPLES; s2++){
            const tt = s2 / SAMPLES, o = bow * Math.sin(Math.PI * tt);
            const [x, z] = toWorld(t, a[0] + du * tt - dv / L * o, a[1] + dv * tt + du / L * o);
            if (!world.isLand(x, z) || nearRiver(world, x, z, 20)){ onLand = false; break; }   // (no bridges on town streets yet)
            pts[2 * s2] = x; pts[2 * s2 + 1] = z;
          }
          if (!onLand) continue;
          if (alongRoad((ax + bx) / 2, (az + bz) / 2, bx - ax, bz - az, n * LAT * 0.4)) continue;
          out.push({ id: h2(k * 4 + dir * 2 + f * 8, m, sId + t[5]), pts, w: isMajor ? P.wMain : P.w, major: isMajor, type: isMajor ? 1 : 0, town: true, pattern: f });
        }
      });
    }
  }
  /** roads whose first point lies in chunk (cx, cz) @returns {Road[]} */
  function chunk(cx, cz){
    const key = key2(cx, cz);
    let c = cache.get(key);
    if (c) return c;
    c = [];
    townStreets(cx, cz, c);
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
      const pad = e.w / 2 + sidewalkOf(e) + 4, p = e.pts;
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
  return { chunk, around, index, townAt, block, blocks: BL, cached: (cx, cz) => cache.has(key2(cx, cz)) };
}

/** Is (x, z) within clear metres of a river? Rivers are cells of the world grid (water code 3); a river is
 *  taken to run anywhere in its cell, so this keeps clear of the whole cell plus the margin.
 *  @param {any} world */
export function nearRiver(world, x, z, clear = 25){
  const c = world.cell, r = Math.ceil(clear / c) + 1;
  const i0 = Math.floor((x + world.half) / c), j0 = Math.floor((z + world.half) / c);
  for (let j = j0 - r; j <= j0 + r; j++) for (let i = i0 - r; i <= i0 + r; i++){
    if (i < 0 || j < 0 || i >= world.res || j >= world.res || world.water[j * world.res + i] !== 3) continue;
    // distance from the point to the cell's square
    const dx = Math.max(0, Math.abs(x - (-world.half + (i + 0.5) * c)) - c / 2), dz = Math.max(0, Math.abs(z - (-world.half + (j + 0.5) * c)) - c / 2);
    if (dx * dx + dz * dz < clear * clear) return true;
  }
  return false;
}
/** Distance from road e's centre line to a turned box (centre x, z; along (ux, uz); half sizes hx, hz). */
export function roadToBox(e, x, z, ux, uz, hx, hz){
  const p = e.pts; let best = 1e9;
  const loc = (px, pz) => [(px - x) * ux + (pz - z) * uz, -(px - x) * uz + (pz - z) * ux];
  const toBox = (u, v) => Math.hypot(Math.max(0, Math.abs(u) - hx), Math.max(0, Math.abs(v) - hz));
  const corners = [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]];
  for (let k = 0; k < SAMPLES; k++){
    const [au, av] = loc(p[2 * k], p[2 * k + 1]), [bu, bv] = loc(p[2 * k + 2], p[2 * k + 3]);
    // does the segment cross the box? (clip it to the box's slabs)
    let t0 = 0, t1 = 1;
    const du = bu - au, dv = bv - av;
    const clip = (d, a, h) => {
      if (Math.abs(d) < 1e-9) return Math.abs(a) <= h;
      let ta = (-h - a) / d, tb = (h - a) / d; if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb); return t0 <= t1;
    };
    if (clip(du, au, hx) && clip(dv, av, hz)) return 0;
    best = Math.min(best, toBox(au, av), toBox(bu, bv));
    const L2 = du * du + dv * dv || 1;
    for (const [cu, cv] of corners){
      const t = Math.max(0, Math.min(1, ((cu - au) * du + (cv - av) * dv) / L2));
      best = Math.min(best, Math.hypot(cu - au - du * t, cv - av - dv * t));
    }
  }
  return best;
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
