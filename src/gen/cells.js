/* Render cells: what the shaders and the JavaScript world queries read.
   Each 512 m chunk is cut into 16 x 16 cells of 32 m. A cell lists, in this order:
     the buildings whose footprint comes within PAD of it      3 texels each
     the street lights within LAMP_REACH of it (their light)   1 texel each
     the road pieces whose road or sidewalk reaches into it    2 texels each
   The items are copied into each cell's list (no second lookup), so a chunk is self-contained: it can be
   uploaded to the GPU, replaced or dropped on its own. Each cell also records how many rings of empty cells
   surround it (a ray can cross that whole square in one jump) and the height of its tallest item (a ray
   above that cannot hit anything listed here).

   Texel layouts (RGBA float):
     building  (centre x, z, frontage direction x, z)   the frontage direction is turned so that its left-hand
               (half frontage, half depth, top, podium)  normal (-z, x) points away from the road: the front
               (kind, variety, door offset, door code)   face is at local z = -half depth. Door code -1 = none.
     light     (pole x, z, arm direction x, z)
     road      (start x, z, end x, z)
               (half width, distance along the road at the start, road length, 1 = main road)
     cell      (first texel of the list in the chunk's block, counts and rings (see below), chunk tag, tops)
               counts: buildings + 64 x lights + 4096 x roads + 262144 x empty rings
               tops: the cell's tallest top and its 128 m block's (4 x 4 cells), in quarter metres rounded
               up: cell + 1024 x block. A ray above the block's top can cross the whole block at once.
   A pack also carries the chunk's own street lights (x, z, arm x, z), for the glows seen from afar. */
import { rnd } from '../world/hash.js';
import { ROAD_CHUNK, SAMPLES } from './roads.js';

export const RC = 32, CN = ROAD_CHUNK / RC, PAD = 8, LAMP_REACH = 13, SIDEWALK_REACH = 3.5, LAMP_H = 8;
export const MAXB = 31, MAXL = 15, MAXR = 31, RINGS = 5;
export const SLOT_TEX = 12288, WTEX_W = 4096, SLOT_ROWS = SLOT_TEX / WTEX_W;
// a chunk's tag: written into its cells, so a cell in a reused slot is recognised as stale (0 = nothing)
export const chunkTag = (cx, cz) => (cx + 512) * 1024 + (cz + 512) + 1;

let warned = false;
const warn = (m) => { if (!warned){ console.warn('render cells: ' + m); warned = true; } };

/** @param {ReturnType<import('./roads.js').makeRoads>} roads @param {ReturnType<import('./blocks.js').makeBlocks>} blocks */
export function makeCells(roads, blocks){
  /** the render cells of chunk (cx, cz) */
  function pack(cx, cz){
    const t0 = performance.now();
    const B = RINGS - 1, G = CN + 2 * B;                    // cells around the chunk, for the empty rings
    const gx0 = cx * CN - B, gz0 = cz * CN - B;
    const lb = [], ll = [], lr = [];
    for (let i = 0; i < CN * CN; i++){ lb.push([]); ll.push([]); lr.push([]); }
    const occ = new Uint8Array(G * G), top = new Float32Array(CN * CN);
    // cells (in the extended grid) overlapped by a box
    const visit = (x0, z0, x1, z1, fn) => {
      const i0 = Math.max(0, Math.floor(x0 / RC) - gx0), i1 = Math.min(G - 1, Math.floor(x1 / RC) - gx0);
      const j0 = Math.max(0, Math.floor(z0 / RC) - gz0), j1 = Math.min(G - 1, Math.floor(z1 / RC) - gz0);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(i, j);
    };
    const inner = (i, j) => i >= B && j >= B && i < B + CN && j < B + CN ? (j - B) * CN + (i - B) : -1;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++){
      const ch = blocks.chunk(cx + dx, cz + dz);
      for (const b of ch.buildings){
        const s = b.side, ux = b.ux * s, uz = b.uz * s;
        const ex = Math.abs(ux) * b.hx + Math.abs(uz) * b.hz, ez = Math.abs(uz) * b.hx + Math.abs(ux) * b.hz;
        const podH = b.kind === 2 ? b.podH : 0, tp = podH + b.h;
        const rec = [b.x, b.z, ux, uz, b.hx, b.hz, tp, podH, b.kind, rnd(b.hash, 10), b.door ? b.door.off * s : 0, b.door ? b.door.code : -1];
        visit(b.x - ex - PAD, b.z - ez - PAD, b.x + ex + PAD, b.z + ez + PAD, (i, j) => {
          occ[j * G + i] = 1;
          const k = inner(i, j);
          if (k >= 0){ lb[k].push(rec); top[k] = Math.max(top[k], tp); }
        });
      }
      for (const l of ch.lamps){
        const hx = l.x + l.ax * 2.5, hz = l.z + l.az * 2.5;
        const x0 = Math.min(l.x, hx) - 0.5, x1 = Math.max(l.x, hx) + 0.5, z0 = Math.min(l.z, hz) - 0.5, z1 = Math.max(l.z, hz) + 0.5;
        const rec = [l.x, l.z, l.ax, l.az];
        visit(x0 - PAD, z0 - PAD, x1 + PAD, z1 + PAD, (i, j) => {
          occ[j * G + i] = 1;
          const k = inner(i, j);
          if (k >= 0) top[k] = Math.max(top[k], LAMP_H + 0.2);
        });
        visit(x0 - LAMP_REACH, z0 - LAMP_REACH, x1 + LAMP_REACH, z1 + LAMP_REACH, (i, j) => {
          const k = inner(i, j);
          if (k >= 0) ll[k].push(rec);
        });
      }
    }
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) for (const e of roads.chunk(cx + dx, cz + dz)){
      const p = e.pts, hw = e.w / 2, reach = hw + SIDEWALK_REACH;
      let L = 0;
      for (let k = 0; k < SAMPLES; k++) L += Math.hypot(p[2 * k + 2] - p[2 * k], p[2 * k + 3] - p[2 * k + 1]);
      let s0 = 0;
      for (let k = 0; k < SAMPLES; k++){
        const ax = p[2 * k], az = p[2 * k + 1], bx = p[2 * k + 2], bz = p[2 * k + 3];
        const rec = [ax, az, bx, bz, hw, s0, L, e.major ? 1 : 0];
        s0 += Math.hypot(bx - ax, bz - az);
        visit(Math.min(ax, bx) - reach, Math.min(az, bz) - reach, Math.max(ax, bx) + reach, Math.max(az, bz) + reach, (i, j) => {
          const c = inner(i, j);
          if (c < 0) return;
          // the cell's centre must be within reach of the piece (plus the cell's half diagonal)
          const qx = (gx0 + i + 0.5) * RC, qz = (gz0 + j + 0.5) * RC, ex = bx - ax, ez = bz - az;
          const t = Math.max(0, Math.min(1, ((qx - ax) * ex + (qz - az) * ez) / (ex * ex + ez * ez || 1)));
          if (Math.hypot(qx - ax - ex * t, qz - az - ez * t) <= reach + RC * 0.7072) lr[c].push(rec);
        });
      }
    }
    // write the cells and their lists
    const cells = new Float32Array(CN * CN * 4), data = new Float32Array(SLOT_TEX * 4), tag = chunkTag(cx, cz);
    const stop = new Float32Array((CN / 4) * (CN / 4));
    for (let j = 0; j < CN; j++) for (let i = 0; i < CN; i++){ const b = (j >> 2) * (CN / 4) + (i >> 2); stop[b] = Math.max(stop[b], top[j * CN + i]); }
    let off = 0;
    for (let j = 0; j < CN; j++) for (let i = 0; i < CN; i++){
      const k = j * CN + i;
      let nB = lb[k].length, nL = ll[k].length, nR = lr[k].length;
      if (nB > MAXB || nL > MAXL || nR > MAXR){ warn(`a cell lists ${nB} buildings, ${nL} lights, ${nR} road pieces (dropping the extra)`); nB = Math.min(nB, MAXB); nL = Math.min(nL, MAXL); nR = Math.min(nR, MAXR); }
      if (off + nB * 3 + nL + nR * 2 > SLOT_TEX){ warn('a chunk has more than fits in its block (leaving cells empty)'); nB = nL = nR = 0; }
      // empty rings: distance (in cells) to the nearest cell with something in it, up to RINGS
      let e = 0;
      if (occ[(j + B) * G + i + B]){ e = 0; }
      else {
        e = RINGS;
        for (let r = 1; r < RINGS && e === RINGS; r++){
          for (let b = -r; b <= r && e === RINGS; b++) for (let a = -r; a <= r; a++){
            if (Math.max(Math.abs(a), Math.abs(b)) !== r) continue;
            if (occ[(j + B + b) * G + i + B + a]){ e = r; break; }
          }
        }
      }
      cells[4 * k] = off; cells[4 * k + 1] = nB + 64 * nL + 4096 * nR + 262144 * e; cells[4 * k + 2] = tag;
      cells[4 * k + 3] = Math.min(Math.ceil(top[k] * 4), 1023) + 1024 * Math.min(Math.ceil(stop[(j >> 2) * (CN / 4) + (i >> 2)] * 4), 1023);
      for (let n = 0; n < nB; n++){ data.set(lb[k][n], off * 4); off += 3; }
      for (let n = 0; n < nL; n++){ data.set(ll[k][n], off * 4); off += 1; }
      for (let n = 0; n < nR; n++){ data.set(lr[k][n], off * 4); off += 2; }
    }
    const own = blocks.chunk(cx, cz).lamps, lamps = new Float32Array(own.length * 4);
    own.forEach((l, n) => lamps.set([l.x, l.z, l.ax, l.az], n * 4));
    return { cx, cz, cells, data, lamps, used: off, ms: performance.now() - t0 };
  }
  return { pack };
}
