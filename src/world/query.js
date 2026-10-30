/* The world evaluated in JavaScript, from the same render cells as the shaders: standing height, street
   lights, collision, and one ray for the focal distance (and for what the eye is looking at). */
import { RC, CN, PAD, LAMP_H } from '../gen/cells.js';
import { ROAD_CHUNK, key2 } from '../gen/roads.js';
import { state } from '../core/state.js';
import { sstep } from '../core/util.js';

let packs = new Map(), world = null;
/** use these render cells (the stream's) and world */
export function setWorldData(p, w){ packs = p; world = w; }

/* the cell at (x, z): its pack and list, or null where nothing is loaded */
const C = { d: null, s: 0, nB: 0, nL: 0, nR: 0, e: 1, top: 0, x0: 0, z0: 0 };
function cellJS(x, z){
  const gx = Math.floor(x / RC), gz = Math.floor(z / RC);
  const cx = Math.floor(gx / CN), cz = Math.floor(gz / CN);
  C.x0 = gx * RC; C.z0 = gz * RC;
  const p = packs.get(key2(cx, cz));
  if (!p){ C.d = null; C.nB = C.nL = C.nR = 0; C.e = 1; C.top = 0; return C; }
  const k = ((gz - cz * CN) * CN + gx - cx * CN) * 4, v = p.cells[k + 1];
  C.d = p.data; C.s = p.cells[k]; C.nB = v & 63; C.nL = (v >> 6) & 63; C.nR = (v >> 12) & 63; C.e = v >> 18; C.top = p.cells[k + 3];
  return C;
}
export const isLandJS = (x, z) => !world || world.isLand(x, z);
export function sdBox3(x, y, z, bx, by, bz){
  const qx = Math.abs(x) - bx, qy = Math.abs(y) - by, qz = Math.abs(z) - bz;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, Math.max(qy, qz)), 0);
}
// a building (texel offset o in list d): distance from (x, y, z)
function bldDist(d, o, x, y, z){
  const i = o * 4, qx = x - d[i], qz = z - d[i + 1], ux = d[i + 2], uz = d[i + 3];
  const lx = qx * ux + qz * uz, lz = -qx * uz + qz * ux, hx = d[i + 4], hz = d[i + 5], top = d[i + 6], pod = d[i + 7];
  if (pod > 0){
    const th = (top - pod) * 0.5;
    return Math.min(sdBox3(lx, y - pod * 0.5, lz, hx, pod * 0.5, hz), sdBox3(lx, y - pod - th, lz, hx - 2.5, th, hz - 2.5));
  }
  return sdBox3(lx, y - top * 0.5, lz, hx, top * 0.5, hz);
}

/* Same as map() in the shader. Also sets the region a ray may jump through (see rayJump). */
const R = { lo: [0, 0], hi: [0, 0], top: 0, bound: 0, bld: -1, d: null };
export function mapJS(x, y, z){
  const c = cellJS(x, z), r = Math.max(c.e - 1, 0) * RC;
  R.lo[0] = c.x0 - r; R.lo[1] = c.z0 - r; R.hi[0] = c.x0 + RC + r; R.hi[1] = c.z0 + RC + r;
  R.bound = Math.min(x - R.lo[0], R.hi[0] - x, z - R.lo[1], R.hi[1] - z) + PAD;
  R.top = c.e > 0 ? -1e9 : c.top; R.bld = -1; R.d = c.d;
  if (c.e > 0) return R.bound;
  if (y > c.top + 1) return Math.min(y - c.top, R.bound);
  let best = 1e9;
  for (let n = 0; n < c.nB; n++){
    const o = c.s + n * 3, dd = bldDist(c.d, o, x, y, z);
    if (dd < best){ best = dd; R.bld = o; }
  }
  for (let n = 0; n < c.nL; n++){
    const i = (c.s + c.nB * 3 + n) * 4, bx = c.d[i], bz = c.d[i + 1];
    best = Math.min(best, Math.max(Math.hypot(x - bx, z - bz) - 0.09, y - LAMP_H, 0.15 - y));   // the pole
  }
  return best;
}
// how far a ray from p along dir can go without being able to hit anything: through the rest of an empty
// region, or (above everything in the cell) until it leaves the cell or comes down to its tallest top
function rayJump(p, dir){
  if (p[1] < R.top) return 0;
  const dx = Math.abs(dir[0]) < 1e-6 ? 1e-6 : dir[0], dz = Math.abs(dir[2]) < 1e-6 ? 1e-6 : dir[2];
  let t = Math.min(((dx > 0 ? R.hi[0] : R.lo[0]) - p[0]) / dx, ((dz > 0 ? R.hi[1] : R.lo[1]) - p[2]) / dz);
  if (dir[1] < 0) t = Math.min(t, (p[1] - R.top) / -dir[1]);
  return t + 0.01;
}

/* the road pieces at (x, z): signed distance to the nearest road edge (< 0 on a road) */
export function roadJS(x, z){
  const c = cellJS(x, z);
  let best = 1e9;
  for (let n = 0; n < c.nR; n++){
    const i = (c.s + c.nB * 3 + c.nL + n * 2) * 4, d = c.d;
    const ax = d[i], az = d[i + 1], ex = d[i + 2] - ax, ez = d[i + 3] - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez || 1)));
    best = Math.min(best, Math.hypot(x - ax - ex * t, z - az - ez * t) - d[i + 4]);
  }
  return best;
}
/** ground height: roads and water at 0, everything else (sidewalks, lots) 15 cm up */
export function groundAt(x, z){ return !isLandJS(x, z) || roadJS(x, z) < 0 ? 0 : 0.15; }

// light from the street lights falling on a surface at p facing n (lux, without the brightness setting)
export function lampLuxJS(p, n){
  const c = cellJS(p[0], p[2]);
  let E = 0;
  for (let k = 0; k < c.nL; k++){
    const i = (c.s + c.nB * 3 + k) * 4, d = c.d;
    const lx = d[i] + d[i + 2] * 2.5, lz = d[i + 1] + d[i + 3] * 2.5, ly = LAMP_H - 0.35;
    const v = [p[0] - lx, p[1] - ly, p[2] - lz], d2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
    if (d2 > 160 || v[1] > -0.05) continue;
    const dd = Math.sqrt(d2), cone = sstep(0.77, 0.93, -v[1] / dd);
    E += 750 * cone * Math.max(-(n[0] * v[0] + n[1] * v[1] + n[2] * v[2]) / dd, 0) / Math.max(d2, 0.25);
  }
  return E;
}

export function collide(p){
  const r = 0.12, c = cellJS(p[0], p[2]);
  if (!c.d) return;
  const d = c.d;
  // street-light poles
  for (let k = 0; k < c.nL; k++){
    const i = (c.s + c.nB * 3 + k) * 4, dx = p[0] - d[i], dz = p[2] - d[i + 1], dd = Math.hypot(dx, dz), m = 0.09 + r;
    if (dd < m && p[1] < LAMP_H + 0.5){ const s = (m - dd) / Math.max(dd, 1e-4); p[0] += dx * s; p[2] += dz * s; }
  }
  // buildings: pushed out of the footprint (podium and tower), in the building's own directions
  for (let n = 0; n < c.nB; n++){
    const i = (c.s + n * 3) * 4, ux = d[i + 2], uz = d[i + 3], top = d[i + 6], pod = d[i + 7];
    const boxes = pod > 0 ? [[d[i + 4], d[i + 5], pod], [d[i + 4] - 2.5, d[i + 5] - 2.5, top]] : [[d[i + 4], d[i + 5], top]];
    for (const [hx, hz, tp] of boxes){
      const qx = p[0] - d[i], qz = p[2] - d[i + 1], lx = qx * ux + qz * uz, lz = -qx * uz + qz * ux;
      const ox = hx + r - Math.abs(lx), oz = hz + r - Math.abs(lz);
      if (ox > 0 && oz > 0 && p[1] < tp + 1.0){
        if (state.fly && p[1] > tp - 1.5){ p[1] = tp + 1.0; continue; }
        let mx = 0, mz = 0;
        if (ox < oz) mx = Math.sign(lx || 1) * ox; else mz = Math.sign(lz || 1) * oz;
        p[0] += ux * mx - uz * mz; p[2] += uz * mx + ux * mz;
      }
    }
  }
}

/* the ground along a ray: roads and water at 0, the rest at 0.15 (curbs between) */
export function groundJS(o, dir){
  if (dir[1] > -1e-6) return 1800;
  const t15 = (0.15 - o[1]) / dir[1], t0 = -o[1] / dir[1], h = Math.hypot(dir[0], dir[2]);
  let t = Math.max(t15, 0);
  for (let k = 0; k < 12; k++){
    const x = o[0] + dir[0] * t, z = o[2] + dir[2] * t;
    if (!isLandJS(x, z)) return t0;
    const dR = roadJS(x, z);
    if (dR > 0) return t;                              // the sidewalk top, or a curb on the way down
    t += Math.max(-dR / Math.max(h, 1e-6), 0.02);
    if (t >= t0) return t0;
  }
  return t0;
}
/** One ray, the same as the shader's. hit.bld: the building it ends on (centre x, z), or null. */
export const hit = { bld: null };
export function castJS(o, dir){
  const tMax = Math.min(groundJS(o, dir), 1800);
  let t = 0, ph = 1e9;
  hit.bld = null;
  for (let i = 0; i < 400; i++){
    const p = [o[0] + dir[0] * t, o[1] + dir[1] * t, o[2] + dir[2] * t];
    if (p[1] > 150 && dir[1] > 0) return 1800;
    const h = mapJS(p[0], p[1], p[2]);
    if (h < 0.0004 * t + 0.0008){ if (R.bld >= 0) hit.bld = [R.d[R.bld * 4], R.d[R.bld * 4 + 1]]; return t; }
    let st = Math.min(h > 0.85 * ph ? Math.max(h, 0.02 * t) : h, R.bound);   // skimming along a wall: longer steps
    st = Math.max(st, rayJump(p, dir));
    ph = h; t += st;
    if (t > tMax) return tMax;
  }
  return Math.min(t, tMax);
}
/** a place to start: on the sidewalk of the road nearest (x, z), facing along it */
export function spawnNear(roads, x, z){
  let best = null;
  for (let r = 0; r <= 3 && !best; r++){
    const cx = Math.floor(x / ROAD_CHUNK), cz = Math.floor(z / ROAD_CHUNK);
    for (const e of roads.around(cx, cz, r)){
      const p = e.pts;
      for (let k = 0; k + 1 < p.length / 2; k++){
        const mx = (p[2 * k] + p[2 * k + 2]) / 2, mz = (p[2 * k + 1] + p[2 * k + 3]) / 2, d = Math.hypot(mx - x, mz - z);
        if (!best || d < best.d) best = { d, e, k, mx, mz };
      }
    }
  }
  if (!best) return null;
  const p = best.e.pts, k = best.k, dx = p[2 * k + 2] - p[2 * k], dz = p[2 * k + 3] - p[2 * k + 1], L = Math.hypot(dx, dz) || 1;
  const off = best.e.w / 2 + 1.5;
  return { pos: [best.mx - dz / L * off, 1.85, best.mz + dx / L * off], yaw: Math.atan2(dx / L, dz / L) };
}
