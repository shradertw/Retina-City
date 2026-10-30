/* Keeps the render cells of the 9 x 9 chunks around the player on the GPU (and in memory, for the
   JavaScript world queries). Each chunk has a fixed slot, chosen by its position (wrapping around), so moving
   one chunk over replaces one row of slots and leaves the rest untouched. Missing chunks are built nearest
   first, and those in front of the player before those behind. A cell whose tag does not match its chunk
   (a slot not yet refilled) reads as empty, in the shaders and here.

   Textures: cells 144 x 144 (one texel per cell, wrapping), lists 4096 x 243 (3 rows per slot),
   land 1 texel per world-grid cell (height; below 0 is water), lights near the camera 128 x 1. */
import { RC, CN, SLOT_TEX, WTEX_W, SLOT_ROWS, chunkTag, makeCells } from '../gen/cells.js';
import { ROAD_CHUNK, key2 } from '../gen/roads.js';

export const NS = 9, NREACH = (NS - 1) / 2, LAMP_MAX = 128;
const mod = (a, n) => ((a % n) + n) % n;

export function makeStream(gl){
  const tex = (w, h, fmt, filter) => {
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, fmt, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };
  const cellsTex = tex(NS * CN, NS * CN, gl.RGBA32F, gl.NEAREST);
  const listTex = tex(WTEX_W, NS * NS * SLOT_ROWS, gl.RGBA32F, gl.NEAREST);
  const lampTex = tex(LAMP_MAX, 1, gl.RGBA32F, gl.NEAREST);
  let landTex = null, cellsGen = null, gen = null, world = null;
  const slots = new Array(NS * NS).fill(null);      // the pack in each slot
  const packs = new Map();                           // chunk key -> pack (the ones in slots)
  const lamps = { n: 0, at: [Infinity, Infinity], r: 0, data: new Float32Array(LAMP_MAX * 4) };
  const stats = { built: 0, lastMs: 0, pending: 0 };

  /** a new world: drop everything */
  function reset(g){
    gen = g; world = g.world; cellsGen = makeCells(g.roads, g.blocks);
    slots.fill(null); packs.clear();
    gl.bindTexture(gl.TEXTURE_2D, cellsTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, NS * CN, NS * CN, gl.RGBA, gl.FLOAT, new Float32Array(NS * CN * NS * CN * 4));
    if (landTex) gl.deleteTexture(landTex);
    // heights are small numbers: half floats keep them and can be filtered (land and water blend like the generator's)
    landTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, landTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, world.res, world.res, 0, gl.RED, gl.FLOAT, world.height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    lamps.n = 0; lamps.at = [Infinity, Infinity];
  }
  function put(p){
    const s = mod(p.cz, NS) * NS + mod(p.cx, NS);
    const old = slots[s];
    if (old) packs.delete(key2(old.cx, old.cz));
    slots[s] = p; packs.set(key2(p.cx, p.cz), p);
    gl.bindTexture(gl.TEXTURE_2D, listTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, s * SLOT_ROWS, WTEX_W, SLOT_ROWS, gl.RGBA, gl.FLOAT, p.data);
    gl.bindTexture(gl.TEXTURE_2D, cellsTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, mod(p.cx, NS) * CN, mod(p.cz, NS) * CN, CN, CN, gl.RGBA, gl.FLOAT, p.cells);
    stats.built++; stats.lastMs = p.ms;
  }
  /** the chunks that should be loaded but are not, best first */
  function wanted(pos, yaw){
    const pcx = Math.floor(pos[0] / ROAD_CHUNK), pcz = Math.floor(pos[2] / ROAD_CHUNK);
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const out = [];
    for (let dz = -NREACH; dz <= NREACH; dz++) for (let dx = -NREACH; dx <= NREACH; dx++){
      const cx = pcx + dx, cz = pcz + dz;
      if (packs.has(key2(cx, cz))) continue;
      const vx = (cx + 0.5) * ROAD_CHUNK - pos[0], vz = (cz + 0.5) * ROAD_CHUNK - pos[2], d = Math.hypot(vx, vz);
      // in front counts as up to 600 m nearer
      out.push({ cx, cz, score: d - 600 * Math.max(0, (vx * fx + vz * fz) / Math.max(d, 1)) });
    }
    out.sort((a, b) => a.score - b.score);
    return out;
  }
  /** fill missing slots: everything now (start-up), or within a time budget (ms) per frame */
  function update(pos, yaw, budget = Infinity){
    if (!gen) return false;
    const t0 = performance.now(), list = wanted(pos, yaw);
    stats.pending = list.length;
    if (!list.length){ updateLamps(pos); return false; }
    for (const c of list){
      put(cellsGen.pack(c.cx, c.cz));
      stats.pending--;
      if (performance.now() - t0 > budget) break;
    }
    lamps.at = [Infinity, Infinity];   // new chunks may bring lights nearer
    updateLamps(pos);
    return true;
  }
  // the street lights nearest the camera, for their glow seen from afar (refreshed after moving 4 m)
  function updateLamps(pos){
    if (Math.hypot(pos[0] - lamps.at[0], pos[2] - lamps.at[1]) < 4 && lamps.n > 0) return;
    const pcx = Math.floor(pos[0] / ROAD_CHUNK), pcz = Math.floor(pos[2] / ROAD_CHUNK), all = [];
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++){
      if (!packs.has(key2(pcx + dx, pcz + dz))) continue;
      for (const l of gen.blocks.chunk(pcx + dx, pcz + dz).lamps) all.push([Math.hypot(l.x - pos[0], l.z - pos[2]), l]);
    }
    all.sort((a, b) => a[0] - b[0]);
    lamps.n = Math.min(all.length, LAMP_MAX);
    lamps.r = lamps.n === LAMP_MAX ? all[LAMP_MAX - 1][0] : 1e9;
    for (let i = 0; i < lamps.n; i++){ const l = all[i][1]; lamps.data.set([l.x, l.z, l.ax, l.az], i * 4); }
    lamps.at = [pos[0], pos[2]];
    gl.bindTexture(gl.TEXTURE_2D, lampTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, LAMP_MAX, 1, gl.RGBA, gl.FLOAT, lamps.data);
  }
  /** bind the textures to units from u0 (cells, lists, land, lights) and set a program's uniforms */
  function bind(u, u0){
    const t = [cellsTex, listTex, landTex, lampTex];
    for (let i = 0; i < 4; i++){ gl.activeTexture(gl.TEXTURE0 + u0 + i); gl.bindTexture(gl.TEXTURE_2D, t[i]); }
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(u.uCells, u0); gl.uniform1i(u.uList, u0 + 1); gl.uniform1i(u.uLand, u0 + 2); gl.uniform1i(u.uLampTex, u0 + 3);
    gl.uniform1i(u.uLampN, lamps.n); gl.uniform1f(u.uLampR, lamps.r);
    if (world) gl.uniform1f(u.uWorldHalf, world.half);
  }
  return { reset, update, bind, packs, stats, get gen(){ return gen; } };
}
export { RC, CN, chunkTag };
