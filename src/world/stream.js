/* Keeps the render cells of the chunks around the player on the GPU (and in memory, for the JavaScript world
   queries). Each chunk has a fixed slot, chosen by its position (wrapping around), so moving one chunk over
   replaces one row of slots and leaves the rest untouched. A cell whose tag does not match its chunk (a slot
   not yet filled, or emptied) reads as empty, in the shaders and here.

   Chunks are built in a background worker (on this thread only if the browser cannot start one), nearest
   first, and those in front of the player before those behind. Only chunks within the visible range are
   kept: setRange() sets it from how far the eye can actually see (see main.js); chunks well beyond it are
   dropped, and come back when the range grows again.

   Textures: cells 144 x 144 (one texel per cell, wrapping), lists 4096 x 243 (3 rows per slot),
   land 1 texel per world-grid cell (height; below 0 is water), lights near the camera 128 x 1. */
import { RC, CN, SLOT_TEX, WTEX_W, SLOT_ROWS, chunkTag, makeCells } from '../gen/cells.js';
import { ROAD_CHUNK, key2 } from '../gen/roads.js';

export const NS = 9, NREACH = (NS - 1) / 2, LAMP_MAX = 128, MAX_RANGE = NREACH * ROAD_CHUNK;
const IN_FLIGHT = 6;                                  // requests the worker holds at once while running
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
  const emptyCells = new Float32Array(CN * CN * 4);
  let landTex = null, cellsGen = null, gen = null, world = null, genId = 0, range = MAX_RANGE;
  const slots = new Array(NS * NS).fill(null);      // the pack in each slot
  const packs = new Map();                           // chunk key -> pack (the ones in slots)
  const asked = new Set(), arrived = [];             // requested from the worker; results not yet uploaded
  const lamps = { n: 0, at: [Infinity, Infinity], r: 0, data: new Float32Array(LAMP_MAX * 4) };
  const stats = { built: 0, dropped: 0, buildMs: 0, pending: 0, range, worker: false };

  // the worker (module workers: Firefox 114+, Chrome 80+); without one, chunks are built here
  let worker = null;
  try {
    worker = new Worker(new URL('../gen/worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => { if (e.data.id === genId) arrived.push(e.data.p); };
    worker.onerror = (e) => { console.warn('chunk worker failed; building chunks on the main thread', e.message || e); worker = null; stats.worker = false; asked.clear(); };
    stats.worker = true;
  } catch (e){ worker = null; }

  /** a new world: drop everything */
  function reset(g){
    gen = g; world = g.world; cellsGen = null; genId++;
    slots.fill(null); packs.clear(); asked.clear(); arrived.length = 0;
    if (worker) worker.postMessage({ type: 'init', options: g.options, id: genId });
    gl.bindTexture(gl.TEXTURE_2D, cellsTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, NS * CN, NS * CN, gl.RGBA, gl.FLOAT, new Float32Array(NS * CN * NS * CN * 4));
    if (landTex) gl.deleteTexture(landTex);
    // heights are small numbers: half floats keep them and can be filtered (land and water blend like the generator's)
    landTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, landTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, world.res, world.res, 0, gl.RED, gl.FLOAT, world.height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    lamps.n = 0; lamps.at = [Infinity, Infinity];
    stats.built = stats.dropped = 0; stats.buildMs = 0;
  }
  const slotOf = (cx, cz) => mod(cz, NS) * NS + mod(cx, NS);
  function put(p){
    const s = slotOf(p.cx, p.cz);
    const old = slots[s];
    if (old) packs.delete(key2(old.cx, old.cz));
    slots[s] = p; packs.set(key2(p.cx, p.cz), p);
    gl.bindTexture(gl.TEXTURE_2D, listTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, s * SLOT_ROWS, WTEX_W, SLOT_ROWS, gl.RGBA, gl.FLOAT, p.data);
    gl.bindTexture(gl.TEXTURE_2D, cellsTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, mod(p.cx, NS) * CN, mod(p.cz, NS) * CN, CN, CN, gl.RGBA, gl.FLOAT, p.cells);
    stats.built++; stats.buildMs += p.ms;
  }
  function drop(s){
    const p = slots[s];
    slots[s] = null; packs.delete(key2(p.cx, p.cz));
    gl.bindTexture(gl.TEXTURE_2D, cellsTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, mod(p.cx, NS) * CN, mod(p.cz, NS) * CN, CN, CN, gl.RGBA, gl.FLOAT, emptyCells);
    stats.dropped++;
  }
  // distance from pos to the nearest point of chunk (cx, cz)
  const chunkDist = (pos, cx, cz) => Math.hypot(
    Math.max(cx * ROAD_CHUNK - pos[0], 0, pos[0] - (cx + 1) * ROAD_CHUNK), Math.max(cz * ROAD_CHUNK - pos[2], 0, pos[2] - (cz + 1) * ROAD_CHUNK));
  /** the chunks within range that are not loaded yet, best first */
  function wanted(pos, yaw){
    const pcx = Math.floor(pos[0] / ROAD_CHUNK), pcz = Math.floor(pos[2] / ROAD_CHUNK);
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const out = [];
    for (let dz = -NREACH; dz <= NREACH; dz++) for (let dx = -NREACH; dx <= NREACH; dx++){
      const cx = pcx + dx, cz = pcz + dz, k = key2(cx, cz);
      if (packs.has(k)) continue;
      const near = chunkDist(pos, cx, cz);
      if (near > range) continue;
      const vx = (cx + 0.5) * ROAD_CHUNK - pos[0], vz = (cz + 0.5) * ROAD_CHUNK - pos[2], d = Math.hypot(vx, vz);
      // in front counts as up to 600 m nearer
      out.push({ cx, cz, k, score: d - 600 * Math.max(0, (vx * fx + vz * fz) / Math.max(d, 1)) });
    }
    out.sort((a, b) => a.score - b.score);
    return out;
  }
  /** the visible range (m): chunks beyond it are not built; well beyond it they are dropped */
  function setRange(r){ range = Math.min(Math.max(r, 0), MAX_RANGE); stats.range = range; }
  /** Bring the loaded chunks up to date. budget: ms for building on this thread (no worker), or Infinity at
   *  start-up (then every wanted chunk is requested at once). Returns true if anything changed. */
  function update(pos, yaw, budget = Infinity){
    if (!gen) return false;
    let changed = false;
    // results from the worker: keep those still wanted
    while (arrived.length){
      const p = arrived.shift(), k = key2(p.cx, p.cz);
      asked.delete(k);
      if (Math.abs(p.cx - Math.floor(pos[0] / ROAD_CHUNK)) > NREACH || Math.abs(p.cz - Math.floor(pos[2] / ROAD_CHUNK)) > NREACH) continue;
      put(p); changed = true;
    }
    // drop chunks well beyond the range
    for (let s = 0; s < slots.length; s++){
      const p = slots[s];
      if (p && chunkDist(pos, p.cx, p.cz) > range + ROAD_CHUNK){ drop(s); changed = true; }
    }
    const list = wanted(pos, yaw).filter((c) => !asked.has(c.k));
    stats.pending = list.length + asked.size;
    if (worker){
      const room = budget === Infinity ? list.length : IN_FLIGHT - asked.size;
      for (const c of list.slice(0, Math.max(room, 0))){ asked.add(c.k); worker.postMessage({ type: 'pack', id: genId, cx: c.cx, cz: c.cz }); }
    } else if (list.length){
      if (!cellsGen) cellsGen = makeCells(gen.roads, gen.blocks);
      const t0 = performance.now();
      for (const c of list){
        put(cellsGen.pack(c.cx, c.cz)); stats.pending--; changed = true;
        if (performance.now() - t0 > budget) break;
      }
    }
    if (changed) lamps.at = [Infinity, Infinity];   // new chunks may bring lights nearer
    updateLamps(pos);
    return changed;
  }
  /** resolves once every chunk wanted around pos is loaded (start-up) */
  function ready(pos, yaw){
    return new Promise((resolve) => {
      const check = () => { update(pos, yaw); if (stats.pending === 0) resolve(); else setTimeout(check, 10); };
      check();
    });
  }
  // the street lights nearest the camera, for their glow seen from afar (refreshed after moving 4 m)
  function updateLamps(pos){
    if (Math.hypot(pos[0] - lamps.at[0], pos[2] - lamps.at[1]) < 4 && lamps.n > 0) return;
    const pcx = Math.floor(pos[0] / ROAD_CHUNK), pcz = Math.floor(pos[2] / ROAD_CHUNK), all = [];
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++){
      const p = packs.get(key2(pcx + dx, pcz + dz));
      if (!p) continue;
      for (let i = 0; i < p.lamps.length; i += 4) all.push([Math.hypot(p.lamps[i] - pos[0], p.lamps[i + 1] - pos[2]), i, p.lamps]);
    }
    all.sort((a, b) => a[0] - b[0]);
    lamps.n = Math.min(all.length, LAMP_MAX);
    lamps.r = lamps.n === LAMP_MAX ? all[LAMP_MAX - 1][0] : 1e9;
    for (let i = 0; i < lamps.n; i++){ const [, o, L] = all[i]; lamps.data.set(L.subarray(o, o + 4), i * 4); }
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
  return { reset, update, ready, setRange, bind, packs, stats, get gen(){ return gen; } };
}
export { RC, CN, chunkTag };
