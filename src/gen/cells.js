/* Render cells: what the shaders and the JavaScript world queries read.
   Each 512 m chunk is cut into 16 x 16 cells of 32 m. A cell lists, in this order:
     the buildings whose footprint comes within PAD of it      3 texels each
     the street lights within LAMP_REACH of it (their light)   1 texel each
     the road pieces whose road or sidewalk reaches into it    3 texels each
     the junction things standing in it (props)                1 texel each
   The items are copied into each cell's list (no second lookup), so a chunk is self-contained: it can be
   uploaded to the GPU, replaced or dropped on its own. Each cell also records how many rings of empty cells
   surround it (a ray can cross that whole square in one jump) and the height of its tallest item (a ray
   above that cannot hit anything listed here).

   Texel layouts (RGBA float):
     building  (centre x, z, frontage direction x, z)   the frontage direction is turned so that its left-hand
               (half frontage, half depth, top, podium)  normal (-z, x) points away from the road: the front
               (kind, light + variety, door offset, door code)   face is at local z = -half depth. Door code -1 = none.
               kind: 0 brick, 1 concrete, 2 glass tower on a podium, 3 timber frame, 4 rough stone. Variety 0-1;
               light (the whole part): 0 no one lives there (dark at night), 1 candles and oil lamps, 2 electric.
     deck      a raised stretch of road, in the building list: (centre x, z, direction x, z)
               (half length, minus half width (negative: a deck), height at the -direction end, at the + end)
               (5, 0, 0, -1). Both ends 2.5 m up or more: a deck on pillars with barriers; else an embankment,
               solid down to the ground (ramps and the approaches of overpasses).
     light     (pole x, z, arm direction x, z): the arm direction is a unit vector for an electric light on an
               8 m pole, half that for a gas lamp on a 3.6 m post (no arm: the lantern is on the post)
     road      (start x, z, end x, z)
               (half width, distance along the road at the start, road length, kind)
               kind: 0 street, 1 main street or main road, 2 farm track, 3 road; + 8 for a road level with the
               ground (no curb, no sidewalk: country roads, and town streets before sidewalks); + 16 x the junction
               control at the start, + 64 x at the end (0 none, 1 stop, 2 signals, 3 roundabout: see
               src/gen/network.js); + 256 x the surface (0 dirt, 1 gravel, 2 stone setts, 3 asphalt); + 1024 x
               its health (3 good, 2 worn, 1 broken, 0 overgrown)
               (height at the start, at the end, the junction's edge at the piece's start, at its end): heights
               in m (raised roads are left out of the ground, and drawn as decks); the junction's edge is how
               far from the piece's end the crossing road's side is (0: no junction there): crossings and stop
               lines are drawn just outside it
     prop      (x, z, kind, angle or radius): kind 1 traffic light (facing angle: the way its traffic comes
               from), 2 stop sign (the same), 3 roundabout island (radius)
     cell      (first texel of the list in the chunk's block, counts and rings (see below), chunk tag, tops)
               counts: buildings + 64 x lights + 4096 x roads + 262144 x empty rings + 2097152 x props
               tops: the cell's tallest top and its 128 m block's (4 x 4 cells), in quarter metres rounded
               up: cell + 1024 x block. A ray above the block's top can cross the whole block at once.
   A pack also carries the chunk's own street lights (x, z, arm x, z), for the glows seen from afar. */
import { rnd } from '../world/hash.js';
import { ROAD_CHUNK, SAMPLES } from './roads.js';

export const RC = 32, CN = ROAD_CHUNK / RC, PAD = 8, LAMP_REACH = 13, SIDEWALK_REACH = 5, LAMP_H = 8;
export const MAXB = 47, MAXL = 15, MAXR = 63, RINGS = 5, MAXP = 7;   // (6 bits each in the cell: up to 63; props 3 bits)
// (a slot per chunk, 81 of them: every texel's index x 16 + a material must stay below 2^24, where a 32-bit float
// still holds every whole number, for the shaders' hit materials; 81 x 12288 x 16 is just under)
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
    const lb = [], ll = [], lr = [], lp = [];
    for (let i = 0; i < CN * CN; i++){ lb.push([]); ll.push([]); lr.push([]); lp.push([]); }
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
        const rec = [b.x, b.z, ux, uz, b.hx, b.hz, tp, podH, b.kind, Math.min(rnd(b.hash, 10), 0.999) + (b.light === undefined ? 2 : b.light), b.door ? b.door.off * s : 0, b.door ? b.door.code : -1];
        visit(b.x - ex - PAD, b.z - ez - PAD, b.x + ex + PAD, b.z + ez + PAD, (i, j) => {
          occ[j * G + i] = 1;
          const k = inner(i, j);
          if (k >= 0){ lb[k].push(rec); top[k] = Math.max(top[k], tp); }
        });
      }
      for (const l of ch.lamps){
        const hx = l.x + l.ax * 2.5, hz = l.z + l.az * 2.5;
        const x0 = Math.min(l.x, hx) - 0.5, x1 = Math.max(l.x, hx) + 0.5, z0 = Math.min(l.z, hz) - 0.5, z1 = Math.max(l.z, hz) + 0.5;
        const ak = l.gas ? 0.5 : 1, rec = [l.x, l.z, l.ax * ak, l.az * ak];
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
    // junction things (props), once each: by position
    const props = new Map();
    const addProp = (x, z, kind, a) => { const k = Math.round(x * 2) * 1e7 + Math.round(z * 2); if (!props.has(k)) props.set(k, [x, z, kind, a]); };
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) for (const e of roads.chunk(cx + dx, cz + dz)){
      const p = e.pts, hw = e.w / 2, reach = hw + SIDEWALK_REACH;
      let L = 0;
      for (let k = 0; k < SAMPLES; k++) L += Math.hypot(p[2 * k + 2] - p[2 * k], p[2 * k + 3] - p[2 * k + 1]);
      const H0 = e.h0 || 0, H1 = e.h1 || 0, mA = e.mouthA || 0, mB = e.mouthB || 0;
      // junction things at its ends: a traffic light on the right-hand side of the way in (traffic keeps right),
      // a stop sign there on a street meeting a main road, a roundabout's island in the middle
      for (const [end, jc, m] of [[0, (e.jc || 0) & 3, mA], [1, ((e.jc || 0) >> 2) & 3, mB]]){
        if (!jc || !m || Math.max(H0, H1) > 0.3) continue;
        const k0 = end ? SAMPLES : 0, k1 = end ? SAMPLES - 1 : 1;
        const nxp = p[2 * k0], nzp = p[2 * k0 + 1], ix = p[2 * k1] - nxp, iz = p[2 * k1 + 1] - nzp, il = Math.hypot(ix, iz) || 1;
        const ux = ix / il, uz = iz / il;                          // from the junction out along this road
        const ang = Math.atan2(ux, uz);                            // (the way its traffic comes from)
        // right-hand side for traffic coming in (toward the junction, -u): its right is (-uz, ux) turned
        const rx = uz, rz = -ux, side = hw + (e.walk === false ? 1.0 : 1.2);
        if (jc === 2) addProp(nxp + ux * (m + 1) + rx * side, nzp + uz * (m + 1) + rz * side, 1, ang);
        else if (jc === 1) addProp(nxp + ux * (m + 1.5) + rx * side, nzp + uz * (m + 1.5) + rz * side, 2, ang);
        else if (jc === 3) addProp(nxp, nzp, 3, Math.max(3, Math.min(9, m - 8)));
      }
      let s0 = 0;
      for (let k = 0; k < SAMPLES; k++){
        const ax = p[2 * k], az = p[2 * k + 1], bx = p[2 * k + 2], bz = p[2 * k + 3];
        const ha = H0 + (H1 - H0) * s0 / (L || 1), sl = Math.hypot(bx - ax, bz - az), hb = H0 + (H1 - H0) * (s0 + sl) / (L || 1);
        const rec = [ax, az, bx, bz, hw, s0, L, e.type + (e.town && e.walk !== false ? 0 : 8) + 16 * (e.jc || 0) + 256 * (e.surf === undefined ? 3 : e.surf) + 1024 * (e.health === undefined ? 3 : e.health),
          ha, hb, mA, mB];
        s0 += sl;
        // a raised stretch: a deck (or embankment) in the building lists
        if (Math.max(ha, hb) > 0.3 && sl > 0.5){
          const ux = (bx - ax) / sl, uz = (bz - az) / sl, mx = (ax + bx) / 2, mz = (az + bz) / 2, dw = hw + 0.6;
          const drec = [mx, mz, ux, uz, sl / 2 + 0.3, -dw, ha, hb, 5, 0, 0, -1], tp = Math.max(ha, hb) + 1.2;
          const ex = Math.abs(ux) * (sl / 2) + Math.abs(uz) * dw, ez = Math.abs(uz) * (sl / 2) + Math.abs(ux) * dw;
          visit(mx - ex - PAD, mz - ez - PAD, mx + ex + PAD, mz + ez + PAD, (i, j) => {
            occ[j * G + i] = 1;
            const c = inner(i, j);
            if (c >= 0){ lb[c].push(drec); top[c] = Math.max(top[c], tp); }
          });
        }
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
    for (const pr of props.values()){
      const r = pr[2] === 3 ? pr[3] + 10 : 4;
      visit(pr[0] - r - PAD, pr[1] - r - PAD, pr[0] + r + PAD, pr[1] + r + PAD, (i, j) => {
        const c = inner(i, j);
        if (c < 0) return;
        if (pr[2] !== 3){ occ[j * G + i] = 1; top[c] = Math.max(top[c], 6); }
        lp[c].push(pr);
      });
    }
    // write the cells and their lists
    const cells = new Float32Array(CN * CN * 4), data = new Float32Array(SLOT_TEX * 4), tag = chunkTag(cx, cz);
    const stop = new Float32Array((CN / 4) * (CN / 4));
    for (let j = 0; j < CN; j++) for (let i = 0; i < CN; i++){ const b = (j >> 2) * (CN / 4) + (i >> 2); stop[b] = Math.max(stop[b], top[j * CN + i]); }
    let off = 0;
    for (let j = 0; j < CN; j++) for (let i = 0; i < CN; i++){
      const k = j * CN + i;
      let nB = lb[k].length, nL = ll[k].length, nR = lr[k].length, nP = lp[k].length;
      if (nB > MAXB || nL > MAXL || nR > MAXR || nP > MAXP){ warn(`a cell lists ${nB} buildings, ${nL} lights, ${nR} road pieces, ${nP} props (dropping the extra)`); nB = Math.min(nB, MAXB); nL = Math.min(nL, MAXL); nR = Math.min(nR, MAXR); nP = Math.min(nP, MAXP); }
      if (off + nB * 3 + nL + nR * 3 + nP > SLOT_TEX){ warn('a chunk has more than fits in its block (leaving cells empty)'); nB = nL = nR = nP = 0; }
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
      cells[4 * k] = off; cells[4 * k + 1] = nB + 64 * nL + 4096 * nR + 262144 * e + 2097152 * nP; cells[4 * k + 2] = tag;
      cells[4 * k + 3] = Math.min(Math.ceil(top[k] * 4), 1023) + 1024 * Math.min(Math.ceil(stop[(j >> 2) * (CN / 4) + (i >> 2)] * 4), 1023);
      for (let n = 0; n < nB; n++){ data.set(lb[k][n], off * 4); off += 3; }
      for (let n = 0; n < nL; n++){ data.set(ll[k][n], off * 4); off += 1; }
      for (let n = 0; n < nR; n++){ data.set(lr[k][n], off * 4); off += 3; }
      for (let n = 0; n < nP; n++){ data.set(lp[k][n], off * 4); off += 1; }
    }
    const own = blocks.chunk(cx, cz).lamps, lamps = new Float32Array(own.length * 4);
    own.forEach((l, n) => { const ak = l.gas ? 0.5 : 1; lamps.set([l.x, l.z, l.ax * ak, l.az * ak], n * 4); });
    return { cx, cz, cells, data, lamps, used: off, ms: performance.now() - t0 };
  }
  return { pack };
}
