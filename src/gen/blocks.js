/* Buildings, doors and street lights along the roads, generated in the same 512 m chunks as the roads.
   Each side of each road proposes buildings in a row behind its sidewalk, turned to face the road, with
   seeded frontage (14-30 m), depth (12-28 m) and setback. A proposal is dropped if it sits on any road or
   sidewalk, or overlaps a proposal with a higher priority (a seeded number). Proposals and priorities depend
   only on the seed and the roads, so the result is the same whatever order chunks are generated in. */
import { h2, hf, rnd } from '../world/hash.js';
import { salt } from './noise.js';
import { ROAD_CHUNK, SAMPLES, SIDEWALK, distToRoad } from './roads.js';

/**
 * @typedef {{ x: number, z: number, ux: number, uz: number, hx: number, hz: number, h: number, podH: number,
 *             kind: number, prio: number, door: { off: number, code: number } | null }} Building
 *   (ux, uz) = the frontage direction; the front faces the road on the -v side, v = (-uz, ux) x side
 * @typedef {{ x: number, z: number, ax: number, az: number }} Lamp   (ax, az) = the arm's direction, over the road
 */
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
  const clearOfRoads = (ix, x, z, pad) => ix.near(x, z).every((e) => distToRoad(e, x, z) >= e.w / 2 + SIDEWALK + pad);

  /** buildings proposed by the roads of chunk (cx, cz), already checked against roads @returns {Building[]} */
  function propose(cx, cz){
    const key = cx + ',' + cz;
    let out = proposals.get(key);
    if (out) return out;
    out = [];
    const near = roads.index(cx, cz);
    for (const e of roads.chunk(cx, cz)){
      const L = roadLength(e);
      for (const side of [-1, 1]){
        let s = 6 + 4 * hf(h2(e.id, side, sB)), n = 0;
        while (true){
          const h = h2(e.id ^ (side > 0 ? 0x55 : 0xAA), n++, sB);
          const w = 14 + 16 * rnd(h, 1), d = 12 + 16 * rnd(h, 2), back = rnd(h, 3) < 0.3 ? 2 * rnd(h, 4) : 0;
          if (s + w > L - 6) break;
          const [px, pz, tx, tz] = along(e, s + w / 2);
          const vx = -tz * side, vz = tx * side;                              // away from the road
          const off = e.w / 2 + SIDEWALK + back + d / 2;
          const b = { x: px + vx * off, z: pz + vz * off, ux: tx, uz: tz, hx: w / 2, hz: d / 2, side, h: 0, podH: 0, kind: 0, prio: rnd(h, 5), door: null, hash: h };
          s += w + 1.5 * rnd(h, 6);
          // the corners and side midpoints must keep clear of every road and sidewalk
          let ok = true;
          for (const [a, c] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]]){
            const qx = b.x + tx * b.hx * a + vx * b.hz * c, qz = b.z + tz * b.hx * a + vz * b.hz * c;
            if (!clearOfRoads(near, qx, qz, -0.05) || !world.isLand(qx, qz)){ ok = false; break; }
          }
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
    const key = cx + ',' + cz;
    let f = finals.get(key);
    if (f) return f;
    // proposals of this chunk and its neighbours, in a 40 m grid for quick lookups
    const grid = new Map(), G = 40;
    const cellKey = (x, z) => Math.floor(x / G) + ',' + Math.floor(z / G);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) for (const b of propose(cx + dx, cz + dz)){
      const k = cellKey(b.x, b.z); let l = grid.get(k); if (!l){ l = []; grid.set(k, l); } l.push(b);
    }
    const buildings = [];
    for (const b of propose(cx, cz)){
      const r = Math.hypot(b.hx, b.hz), reach = Math.ceil((r + 21) / G);        // 21 m: the largest half-diagonal
      const gx = Math.floor(b.x / G), gz = Math.floor(b.z / G);
      let beaten = false;
      for (let j = -reach; j <= reach && !beaten; j++) for (let i = -reach; i <= reach && !beaten; i++){
        for (const o of grid.get((gx + i) + ',' + (gz + j)) || []){
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

  // height, kind and door (towers more likely near the centre of the world, which is the start point for now)
  function finish(b){
    const h = b.hash, centre = Math.max(0, 1 - Math.hypot(b.x, b.z) / 3000);
    const r = rnd(h, 7), tower = rnd(h, 8) < 0.12 + 0.35 * centre;
    if (tower && b.hx > 8 && b.hz > 8){ b.kind = 2; b.h = (12 + Math.floor(rnd(h, 9) * rnd(h, 9) * 30)) * 3.2; b.podH = 6.4; }
    else if (r < 0.5){ b.kind = 0; b.h = (3 + Math.floor(rnd(h, 9) * 7)) * 3.2; }
    else { b.kind = 1; b.h = (5 + Math.floor(rnd(h, 9) * 14)) * 3.2; }
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
  return { chunk, chunkOf, cached: (cx, cz) => finals.has(cx + ',' + cz) };
}
