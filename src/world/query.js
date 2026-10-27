/* The world evaluated in JavaScript, from the same city plan as the shaders: ground height, street
   lights, collision, and one ray for the focal distance. */
import { CELL, LAMP_TOP } from './hash.js';
import { getBld, slabBoxesJS } from './cityplan.js';
import { state } from '../core/state.js';
import { sstep } from '../core/util.js';

export function onSlab(x, z){
  const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
  const lx = x - (cx + 0.5) * CELL, lz = z - (cz + 0.5) * CELL;
  return slabBoxesJS(bldAt(cx, cz).flags).some(s => lx >= s[0] && lz >= s[1] && lx <= s[2] && lz <= s[3]);
}
export function groundAt(x, z){ return onSlab(x, z) ? 0.15 : 0; }
// the intersection's light (same as lampAt() in the shader): null, or corner signs and arm direction
export function lampJS(nx, nz){
  const code = bldAt(nx, nz).lamp - 1;
  if (code < 0) return null;
  const sx = (code & 1) ? 1 : -1, sz = (code & 2) ? 1 : -1;
  return { sx, sz, ax: (code & 4) === 0 ? -sx : 0, az: (code & 4) === 0 ? 0 : -sz };
}
export function lampBasesJS(nx, nz){
  const l = lampJS(nx, nz);
  return l ? [[nx * CELL + l.sx * 5.5, nz * CELL + l.sz * 5.5]] : [];
}
// light from the street lights falling on a surface at p facing n (lux, without the brightness setting)
export function lampLuxJS(p, n){
  let E = 0;
  const c0 = [Math.floor(p[0] / CELL), Math.floor(p[2] / CELL)];
  for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++){
    const nx = c0[0] + i, nz = c0[1] + j, l = lampJS(nx, nz);
    if (!l) continue;
    const { sx, sz, ax, az } = l;
    const lx = nx * CELL + sx * 5.5 + ax * 2.5, lz = nz * CELL + sz * 5.5 + az * 2.5, ly = LAMP_TOP - 0.35;
    const v = [p[0] - lx, p[1] - ly, p[2] - lz], d2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
    if (d2 > 160 || v[1] > -0.05) continue;
    const d = Math.sqrt(d2), cone = sstep(0.77, 0.93, -v[1] / d);
    E += 750 * cone * Math.max(-(n[0] * v[0] + n[1] * v[1] + n[2] * v[2]) / d, 0) / Math.max(d2, 0.25);
  }
  return E;
}
export function collide(p){
  const r = 0.12;
  // street-light poles
  for (const [bx, bz] of lampBasesJS(Math.round(p[0] / CELL), Math.round(p[2] / CELL))){
    const dx = p[0] - bx, dz = p[2] - bz, d = Math.hypot(dx, dz), m = 0.09 + r;
    if (d < m && p[1] < LAMP_TOP + 0.5){ const k = (m - d) / Math.max(d, 1e-4); p[0] += dx * k; p[2] += dz * k; }
  }
  // buildings of the four lots around the nearest intersection
  const nx = Math.round(p[0] / CELL), nz = Math.round(p[2] / CELL);
  const boxes = [];
  for (let j = -1; j <= 0; j++) for (let i = -1; i <= 0; i++){
    const cx = nx + i, cz = nz + j, b = bldAt(cx, cz);
    if (b.kind < 0) continue;
    const ox = (cx + 0.5) * CELL, oz = (cz + 0.5) * CELL;
    boxes.push({ x: ox + b.cx, z: oz + b.cz, hx: b.hx, hz: b.hz, top: b.podH + b.h });
    if (b.podH > 0) boxes.push({ x: ox + 0.5 * (b.x0 + b.x1), z: oz + 0.5 * (b.z0 + b.z1), hx: 0.5 * (b.x1 - b.x0), hz: 0.5 * (b.z1 - b.z0), top: b.podH });
  }
  const lx = p[0], lz = p[2];
  for (const bx of boxes){
    const dx = lx - bx.x, dz = lz - bx.z;
    const ox = bx.hx + r - Math.abs(dx), oz = bx.hz + r - Math.abs(dz);
    if (ox > 0 && oz > 0 && p[1] < bx.top + 1.0){
      if (state.fly && p[1] > bx.top - 1.5){ p[1] = bx.top + 1.0; continue; }
      if (ox < oz) p[0] += Math.sign(dx || 1) * ox; else p[2] += Math.sign(dz || 1) * oz;
    }
  }
}
// The same world, evaluated in JavaScript: one ray from the gaze point finds the focal distance.
export const bldCache = new Map();
export function bldAt(cx, cz){
  const key = cx * 100003 + cz;
  let b = bldCache.get(key);
  if (!b){ if (bldCache.size > 4096) bldCache.clear(); b = getBld(cx, cz); bldCache.set(key, b); }
  return b;
}
export function sdBox3(x, y, z, bx, by, bz){
  const qx = Math.abs(x) - bx, qy = Math.abs(y) - by, qz = Math.abs(z) - bz;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, Math.max(qy, qz)), 0);
}
export function mapJS(x, y, z){
  // same as map() in the shader: the four lots around the nearest intersection
  const nx = Math.round(x / CELL), nz = Math.round(z / CELL);
  let d = 1e9;   // buildings only; the ground is found exactly in castJS
  for (let j = -1; j <= 0; j++) for (let i = -1; i <= 0; i++){
    const cx = nx + i, cz = nz + j, b = bldAt(cx, cz);
    if (b.kind < 0) continue;
    const lx = x - (cx + 0.5) * CELL, lz = z - (cz + 0.5) * CELL;
    d = Math.min(d, sdBox3(lx - b.cx, y - (b.podH + b.h * 0.5), lz - b.cz, b.hx, b.h * 0.5, b.hz));
    if (b.podH > 0) d = Math.min(d, sdBox3(lx - 0.5 * (b.x0 + b.x1), y - b.podH * 0.5, lz - 0.5 * (b.z0 + b.z1), 0.5 * (b.x1 - b.x0), b.podH * 0.5, 0.5 * (b.z1 - b.z0)));
  }
  const inf = Math.max(Math.abs(x - nx * CELL), Math.abs(z - nz * CELL));
  return Math.min(d, Math.max(CELL - inf, y - 140));
}
export function groundJS(o, dir){
  if (dir[1] > -1e-6) return 1800;
  const t15 = (0.15 - o[1]) / dir[1];
  if (t15 > 0){
    if (onSlab(o[0] + dir[0] * t15, o[2] + dir[2] * t15)) return t15;
  }
  return -o[1] / dir[1];
}
export function castJS(o, dir){
  const tMax = Math.min(groundJS(o, dir), 1800);
  let t = 0, ph = 1e9;
  for (let i = 0; i < 400; i++){
    const x = o[0] + dir[0]*t, y = o[1] + dir[1]*t, z = o[2] + dir[2]*t;
    if (y > 150 && dir[1] > 0) return 1800;
    const h = mapJS(x, y, z);
    if (h < 0.0004*t + 0.0008) return t;
    t += h > 0.85 * ph ? Math.max(h, 0.02 * t) : h;   // skimming along a wall: longer steps
    ph = h;
    if (t > tMax) return tMax;
  }
  return Math.min(t, tMax);
}

