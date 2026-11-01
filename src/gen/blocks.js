/* Buildings, doors and street lights along the town roads, generated in the same 512 m chunks as the roads.
   Each side of each town road proposes buildings in a row behind its sidewalk, turned to face the road. What
   gets proposed comes from the history's town block just behind the sidewalk (src/gen/districts.js): its
   district, storeys and the year it was last built (see FORMS below). No block there: nothing is built.
   A proposal is dropped if it sits on any road or sidewalk, or overlaps a proposal with a higher priority (a
   seeded number). Proposals and priorities depend only on the seed, the roads and the history, so the result
   is the same whatever order chunks are generated in. */
import { h2, hf, rnd } from '../world/hash.js';
import { salt } from './noise.js';
import { ROAD_CHUNK, SAMPLES, sidewalkOf, distToRoad, key2, LAT, PATTERNS, nearRiver, roadToBox } from './roads.js';

/**
 * @typedef {{ x: number, z: number, ux: number, uz: number, hx: number, hz: number, h: number, podH: number,
 *             kind: number, prio: number, door: { off: number, code: number } | null }} Building
 *   (ux, uz) = the frontage direction; the front faces the road on the -v side, v = (-uz, ux) x side
 * @typedef {{ x: number, z: number, ax: number, az: number }} Lamp   (ax, az) = the arm's direction, over the road
 */
/* Building forms by district and the block's storeys; r(k) is a seeded number 0-1. Sizes in metres:
   w frontage, d depth, back setback from the sidewalk, gap to the next building along the street.
   kind: 0 brick, 1 concrete, 2 glass tower on a podium. Storeys are 3.2 m (industry 5.5 m).
     housing  1-2 storeys   detached houses with front yards and gaps between
              3-5           terraces (row houses) and small flats, wall to wall at the sidewalk
              6+            on old-core and grid-era streets, flats wall to wall at the sidewalk (perimeter
                            blocks); elsewhere apartment blocks set back with space around them
     shops and offices  1-4 shops wall to wall; 5-12 offices; 13+ towers on podiums
     industry           big sheds set back from the street, one or two tall storeys
   Brick for the older buildings, concrete (and glass) more often the newer they are. */
function form(zone, st, year, r, pattern){
  const brick = (p) => (r(9) < p ? 0 : 1);
  const old = year < 620 ? 0.85 : year < 760 ? 0.5 : year < 840 ? 0.25 : 0.1;
  const vary = (n, k) => Math.max(1, n + Math.floor(r(k) * (2 * k + 1)) - k);
  if (zone === 1){
    if (st <= 2) return { w: 8 + 5 * r(1), d: 8 + 4 * r(2), back: 3 + 5 * r(3), gap: 3 + 6 * r(4), st: Math.max(1, st - (r(5) < 0.4 ? 1 : 0)), kind: brick(old + 0.15) };
    if (st <= 5) return { w: 6 + 4 * r(1), d: 10 + 4 * r(2), back: 1.5 * r(3), gap: r(4) < 0.85 ? 0.2 : 3, st: vary(st, 1), kind: brick(old + 0.1) };
    if (pattern === 0 || pattern === 1) return { w: 14 + 12 * r(1), d: 12 + 4 * r(2), back: 0, gap: r(4) < 0.85 ? 0.2 : 4, st: vary(st, 1), kind: brick(old * 0.7) };
    return { w: 22 + 18 * r(1), d: 13 + 5 * r(2), back: 3 + 4 * r(3), gap: 6 + 8 * r(4), st: vary(st, 2), kind: brick(old * 0.5) };
  }
  if (zone === 2){
    if (st <= 4) return { w: 8 + 8 * r(1), d: 14 + 10 * r(2), back: 0, gap: r(4) < 0.8 ? 0.2 : 2, st: vary(st, 1), kind: brick(old) };
    if (st <= 12) return { w: 16 + 14 * r(1), d: 16 + 10 * r(2), back: r(3), gap: 0.5 + 3 * r(4), st: vary(st, 2), kind: brick(old * 0.4) };
    return { w: 24 + 12 * r(1), d: 22 + 8 * r(2), back: 2, gap: 4 + 6 * r(4), st: vary(st, 3), kind: 2, podH: 6.4 };
  }
  return { w: 25 + 30 * r(1), d: 22 + 20 * r(2), back: 6 + 8 * r(3), gap: 6 + 10 * r(4), st: st > 1 && r(5) < 0.5 ? 2 : 1, kind: 1, storeyH: 5.5 };
}
/** @param {import('./world.js').World} world @param {ReturnType<import('./roads.js').makeRoads>} roads */
export function makeBlocks(world, roads){
  const seed = world.seed, sB = salt(seed, 21), sL = salt(seed, 22), sD = salt(seed, 23);
  const proposals = new Map(), finals = new Map();
  const chunkOf = (v) => Math.floor(v / ROAD_CHUNK);

  // walks a road's polyline: point and unit direction at distance s from its start
  function along(e, s){
    const p = e.pts;
    for (let k = 0; k < SAMPLES; k++){
      const ax = p[2 * k], az = p[2 * k + 1], dx = p[2 * k + 2] - ax, dz = p[2 * k + 3] - az, len = Math.hypot(dx, dz);
      if (s <= len || k === SAMPLES - 1){ const t = Math.min(s / len, 1); return [ax + dx * t, az + dz * t, dx / len, dz / len]; }
      s -= len;
    }
    return [p[0], p[1], 1, 0];
  }
  const roadLength = (e) => { let L = 0; const p = e.pts; for (let k = 0; k < SAMPLES; k++) L += Math.hypot(p[2 * k + 2] - p[2 * k], p[2 * k + 3] - p[2 * k + 1]); return L; };
  // clear of every nearby road and its sidewalks?

  /** buildings proposed by the roads of chunk (cx, cz), already checked against roads @returns {Building[]} */
  function propose(cx, cz){
    const key = key2(cx, cz);
    let out = proposals.get(key);
    if (out) return out;
    out = [];
    const near = roads.index(cx, cz), BL = roads.blocks;
    if (!BL){ proposals.set(key, out); return out; }
    for (const e of roads.chunk(cx, cz)){
      if (!e.town) continue;                               // buildings only along town roads
      const L = roadLength(e);
      for (const side of [-1, 1]){
        let s = 2 + 3 * hf(h2(e.id, side, sB)), n = 0;
        while (s < L - 4 && n < 200){
          const h = h2(e.id ^ (side > 0 ? 0x55 : 0xAA), n++, sB);
          // the town block just behind the sidewalk here
          const [qx0, qz0, qtx, qtz] = along(e, Math.min(s + 4, L));
          const SW = sidewalkOf(e), probe = e.w / 2 + SW + 8, q = roads.block(qx0 - qtz * side * probe, qz0 + qtx * side * probe);
          if (q < 0){ s += 10; continue; }
          const F = form(BL.zone[q], BL.st[q], BL.built[q], (k) => rnd(h, 10 + k), e.pattern === undefined ? 1 : e.pattern);
          // between town streets, a building takes at most half the depth from one street to the next
          const room = e.pattern === undefined ? 1e9 : (PATTERNS[e.pattern].n * LAT - e.w) / 2 - SW - 0.5;
          const back = Math.min(F.back, Math.max(0, room - 8)), d = Math.max(6, Math.min(F.d, room - back)), w = F.w;
          if (s + w > L - 2) break;
          const [px, pz, tx, tz] = along(e, s + w / 2);
          const vx = -tz * side, vz = tx * side;                              // away from the road
          const off = e.w / 2 + SW + back + d / 2;
          const b = { x: px + vx * off, z: pz + vz * off, ux: tx, uz: tz, hx: w / 2, hz: d / 2, side, kind: F.kind,
            h: F.st * (F.storeyH || 3.2), podH: F.podH || 0, prio: rnd(h, 5), door: null, hash: h };
          s += w + F.gap;
          // the whole footprint must keep clear of every road and its sidewalks (roads listed anywhere under
          // it, tested against the box itself), stand on land, and keep 25 m from rivers
          let ok = true;
          const roadsHere = new Set();
          const nu = Math.ceil(b.hx / 12), nv = Math.ceil(b.hz / 12);
          for (let a = -nu; a <= nu && ok; a++) for (let c = -nv; c <= nv; c++){
            const qx = b.x + tx * b.hx * a / nu + vx * b.hz * c / nv, qz = b.z + tz * b.hx * a / nu + vz * b.hz * c / nv;
            for (const o of near.near(qx, qz)) roadsHere.add(o);
            if ((Math.abs(a) === nu || Math.abs(c) === nv) && (!world.isLand(qx, qz) || nearRiver(world, qx, qz, 25))){ ok = false; break; }
          }
          if (ok) for (const o of roadsHere) if (roadToBox(o, b.x, b.z, tx, tz, b.hx, b.hz) < o.w / 2 + sidewalkOf(o) - 0.05){ ok = false; break; }
          if (ok) out.push(b);
        }
      }
    }
    proposals.set(key, out);
    if (proposals.size > 2048) proposals.delete(proposals.keys().next().value);
    return out;
  }

  // do two turned boxes overlap? (separating axis test on the four edge directions)
  function overlap(a, b){
    const axes = [[a.ux, a.uz], [-a.uz, a.ux], [b.ux, b.uz], [-b.uz, b.ux]];
    const dx = b.x - a.x, dz = b.z - a.z;
    for (const [ax, az] of axes){
      const ra = a.hx * Math.abs(a.ux * ax + a.uz * az) + a.hz * Math.abs(-a.uz * ax + a.ux * az);
      const rb = b.hx * Math.abs(b.ux * ax + b.uz * az) + b.hz * Math.abs(-b.uz * ax + b.ux * az);
      if (Math.abs(dx * ax + dz * az) > ra + rb - 0.01) return false;
    }
    return true;
  }

  /** the final buildings and lamps of chunk (cx, cz) */
  function chunk(cx, cz){
    const key = key2(cx, cz);
    let f = finals.get(key);
    if (f) return f;
    // proposals of this chunk and its neighbours, in a 40 m grid for quick lookups
    const grid = new Map(), G = 40;
    const cellKey = (x, z) => key2(Math.floor(x / G), Math.floor(z / G));
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) for (const b of propose(cx + dx, cz + dz)){
      const k = cellKey(b.x, b.z); let l = grid.get(k); if (!l){ l = []; grid.set(k, l); } l.push(b);
    }
    const buildings = [];
    for (const b of propose(cx, cz)){
      const r = Math.hypot(b.hx, b.hz), reach = Math.ceil((r + 36) / G);        // 36 m: the largest half-diagonal
      const gx = Math.floor(b.x / G), gz = Math.floor(b.z / G);
      let beaten = false;
      for (let j = -reach; j <= reach && !beaten; j++) for (let i = -reach; i <= reach && !beaten; i++){
        for (const o of grid.get(key2(gx + i, gz + j)) || []){
          if (o === b || o.prio < b.prio || (o.prio === b.prio && o.hash <= b.hash)) continue;
          if (overlap(b, o)){ beaten = true; break; }
        }
      }
      if (!beaten) buildings.push(finish(b));
    }
    // street lights every ~32 m along each road, alternating sides, clear of crossing roads
    const lamps = [];
    const ix = roads.index(cx, cz);
    for (const e of roads.chunk(cx, cz)){
      if (!e.town || e.type === 2) continue;               // street lights only in towns
      const L = roadLength(e);
      for (let s = 10, n = 0; s < L - 4; s += 32, n++){
        const side = (hf(h2(e.id, n, sL)) < 0.5) ? -1 : 1;
        const [px, pz, tx, tz] = along(e, s);
        const vx = -tz * side, vz = tx * side, off = e.w / 2 + 0.6;
        const x = px + vx * off, z = pz + vz * off;
        if (ix.near(x, z).some((o) => o !== e && distToRoad(o, x, z) < o.w / 2 + 0.4)) continue;
        lamps.push({ x, z, ax: -vx, az: -vz });
      }
    }
    f = { buildings, lamps };
    finals.set(key, f);
    if (finals.size > 1024) finals.delete(finals.keys().next().value);
    return f;
  }

  // the door (height and kind come with the proposal)
  function finish(b){
    const h = b.hash;
    // a door on the front, 90% of the time (same codes as before: type x 64 + variety x 16 + colour x 4 + double x 2 + transom)
    const hd = h2(h, 1, sD);
    if (rnd(hd, 0) < 0.9 && b.hx > 2.5){
      const tp = b.kind === 0 ? [0.6, 0.15] : b.kind === 1 ? [0.2, 0.4] : [0.05, 0.75];
      const t = rnd(hd, 2), type = t < tp[0] ? 0 : t < tp[0] + tp[1] ? 1 : 2;
      const dbl = rnd(hd, 3) < [0.25, 0.55, 0.3][type] ? 1 : 0, tr = rnd(hd, 4) < [0.45, 0.3, 0.12][type] ? 1 : 0;
      b.door = { off: (2 * rnd(hd, 1) - 1) * (b.hx - 2.2),
                 code: type * 64 + Math.floor(rnd(hd, 5) * 4) * 16 + Math.floor(rnd(hd, 6) * 4) * 4 + dbl * 2 + tr };
    }
    return b;
  }
  return { chunk, chunkOf, cached: (cx, cz) => finals.has(key2(cx, cz)) };
}
