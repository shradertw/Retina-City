/* The natural world (step 4a), generated once when the player presses Generate, on a grid of 32 m cells
   (coarser for big worlds, so the grid stays at most 1024 x 1024). Each map is built from the ones before it:

     sea level     how much of the world is under water: a number per seed
     elevation     continents, erosion and peaks; ocean all round the edges; metres above (or below) the sea
     lakes         hollows that fill with water up to their rim
     temperature   set by the latitude, colder with height (about 6.5 degC per km)
     humidity      wet and dry regions, wetter near water and where warm, drier with height and behind mountains
     rivers        rain (humidity) flowing downhill to the sea; big flows carve shallow valleys
     metals        scattered deposits of iron, copper, coal and gold, more in hills
     fertility     capacity for life: comfortable temperature, moisture, low and flat ground, rivers
     life          what grows where (tundra, forest, grassland, desert...) from temperature and humidity

   world.height is the height above the water surface (sea or lake) in metres: above 0 is land. */
import { fbmTable, salt } from './noise.js';
import { h2, rnd } from '../world/hash.js';

// life: the kind of land cover (index into this list; 0 and 1 are water)
export const LIFE = ['ocean', 'lake', 'beach', 'ice', 'tundra', 'boreal forest', 'cold steppe', 'grassland',
  'temperate forest', 'desert', 'savanna', 'rainforest', 'bare rock'];
export const METALS = ['iron', 'copper', 'coal', 'gold'];

/**
 * @typedef {{ size: number, seed: number, lat: number, half: number, res: number, cell: number, relief: number,
 *   height: Float32Array, water: Uint8Array, flow: Float32Array, temp: Float32Array, humid: Float32Array,
 *   fert: Float32Array, life: Uint8Array, metals: { type: number, x: number, z: number, size: number }[],
 *   heightAt: (x: number, z: number) => number, isLand: (x: number, z: number) => boolean, ms: number, times: Record<string, number> }} World
 *   water: 0 land, 1 ocean, 2 lake, 3 river
 */
/** @param {{ size: number, seed: number, lat?: number }} opts @returns {World} */
export function buildWorld(opts){
  const t0 = performance.now(), times = {};
  let tl = t0;
  const lap = (name) => { const t = performance.now(); times[name] = t - tl; tl = t; };
  const size = opts.size * 1000, half = size / 2, seed = opts.seed >>> 0, lat = opts.lat ?? 45;
  const res = Math.max(64, Math.min(1024, Math.round(size / 32))), cell = size / res, N = res * res;
  const X = (i) => -half + (i + 0.5) * cell;
  // height range: gentle for small worlds, up to 2.5 km for big ones (slopes stay walkable at city scale)
  const relief = Math.min(Math.max(size * 0.04, 150), 2500);

  // ---- elevation: continents, erosion, peaks and valleys ----
  const Lc = Math.max(size / 2.5, 4000), Le = Math.max(size / 5, 2500), Lp = Math.max(size / 9, 900);
  const nC = fbmTable(salt(seed, 1), 6, -half / Lc, half / Lc);
  const nE = fbmTable(salt(seed, 2), 4, -half / Le, half / Le);
  const nP = fbmTable(salt(seed, 3), 5, -half / Lp, half / Lp);
  const nD = fbmTable(salt(seed, 4), 3, -half / (Lp * 0.3), half / (Lp * 0.3));
  const e = new Float32Array(N);
  for (let j = 0; j < res; j++) for (let i = 0; i < res; i++){
    const x = X(i), z = X(j);
    // distance toward the border (0 centre, 1 edge), part square and part round, wobbled by the erosion
    // noise so the coast does not follow the square edge of the world
    const edge = 0.3 * Math.max(Math.abs(x), Math.abs(z)) / half + 0.6 * Math.hypot(x, z) / half + 0.4 * (nE(x / Le, z / Le) - 0.5);
    const fall = Math.min(Math.max((edge - 0.5) / 0.4, 0), 1);
    const centre = Math.exp(-Math.pow(Math.hypot(x, z) / (0.15 * size + 800), 2));   // land near the start, usually
    const cont = nC(x / Lc, z / Lc) + 0.2 * centre - 0.9 * fall * fall;
    const ero = nE(x / Le, z / Le);                                      // high = worn down (flat)
    const r = 1 - Math.abs(2 * nP(x / Lp, z / Lp) - 1);                  // ridges along the noise's midline
    const inland = Math.min(Math.max((cont - 0.45) / 0.15, 0), 1);
    e[j * res + i] = cont + inland * (1 - ero) * (0.55 * r * r * r + 0.06 * nD(x / (Lp * 0.3), z / (Lp * 0.3)));
  }
  // sea level: the seed picks how much is land (35-65%)
  const landFrac = 0.35 + 0.3 * rnd(salt(seed, 5), 1);
  const sorted = e.slice().sort();
  const sea = sorted[Math.floor((1 - landFrac) * (N - 1))], top = sorted[N - 1], bottom = sorted[0];
  // to metres: land up to the relief, sea floor down to 1.5 x the relief
  const elev = new Float32Array(N);
  for (let k = 0; k < N; k++) elev[k] = e[k] > sea ? (e[k] - sea) / (top - sea) * relief : (e[k] - sea) / (sea - bottom) * relief * 1.5;
  lap('elevation');

  // ---- ocean: water below sea level connected to the border; lakes: hollows filled up to their rim ----
  // (priority flood from the border: each cell's water surface is the lowest rim it has to spill over)
  // The flood also records, for each cell, the neighbour it was reached from: following those leads every
  // cell downhill (through lakes, over their outlets) to the sea, which is the way rain runs off.
  const water = new Uint8Array(N), surf = new Float32Array(N), down = new Int32Array(N).fill(-1), visit = new Uint32Array(N);
  let nv = 0;
  // Shallow hollows are left dry (the noise makes thousands of them); only real basins become lakes. The water
  // still runs through the shallow ones on its way down.
  const lakeMin = Math.max(3, relief * 0.012);
  {
    const heap = new MinHeap(N), seen = new Uint8Array(N);
    for (let i = 0; i < res; i++) for (const k of [i, (res - 1) * res + i, i * res, i * res + res - 1]) if (!seen[k]){ seen[k] = 1; surf[k] = Math.max(elev[k], 0); heap.push(k, surf[k]); }
    while (heap.size){
      const k = heap.pop(), s = surf[k], i = k % res, j = (k / res) | 0;
      visit[nv++] = k;
      for (let d = 0; d < 4; d++){
        const ni = i + (d === 0 ? 1 : d === 1 ? -1 : 0), nj = j + (d === 2 ? 1 : d === 3 ? -1 : 0);
        if (ni < 0 || nj < 0 || ni >= res || nj >= res) continue;
        const n = nj * res + ni;
        if (seen[n]) continue;
        seen[n] = 1; surf[n] = Math.max(elev[n], s); down[n] = k; heap.push(n, surf[n]);
      }
    }
    for (let k = 0; k < N; k++){
      if (elev[k] <= 0 && surf[k] <= 0) water[k] = 1;                               // sea
      else if (surf[k] - elev[k] > lakeMin) water[k] = 2;                           // a lake, if deep enough
    }
  }
  lap('lakes');

  // distance to open water (ocean or lake), metres: two-pass chamfer transform
  const distW = chamfer(res, cell, (k) => water[k] === 1 || water[k] === 2);
  lap('distance to water');

  // ---- temperature (degC): the latitude's average, a little noise, colder with height ----
  const temp = new Float32Array(N), Lt = Math.max(size / 3, 3000);
  const nT = fbmTable(salt(seed, 6), 4, -half / Lt, half / Lt);
  const base = 28 - 0.006 * lat * lat;                       // equator ~28, 45 deg ~16, 60 deg ~6.4, 70 deg ~-1
  for (let j = 0; j < res; j++) for (let i = 0; i < res; i++){
    const k = j * res + i;
    temp[k] = base + 6 * (nT(X(i) / Lt, X(j) / Lt) - 0.5) - 6.5 * Math.abs(elev[k]) / 1000;   // colder up high and down deep
  }
  lap('temperature');

  // ---- humidity (0-1): wet and dry regions, water nearby, warmth; less with height and behind mountains ----
  // Wind from the west: a mountain upwind (lower x) casts a rain shadow that fades over ~5 km.
  const humid = new Float32Array(N), Lh = Math.max(size / 3.5, 2500);
  const nH = fbmTable(salt(seed, 7), 5, -half / Lh, half / Lh);
  for (let j = 0; j < res; j++){
    let upwind = 0;
    for (let i = 0; i < res; i++){
      const k = j * res + i, h = Math.max(elev[k], 0);
      upwind = Math.max(h, upwind - cell * 0.12);                          // the highest ground upwind, fading
      if (water[k] === 1){ humid[k] = 0; continue; }                        // nothing below sea level (for now)
      const near = Math.exp(-distW[k] / Math.max(4000, size * 0.08));   // moist air reaches further inland on big land
      const shadow = Math.min(Math.max((upwind - h - 150) / 600, 0), 1);
      humid[k] = clamp01(0.75 * nH(X(i) / Lh, X(j) / Lh) - 0.2 + 0.3 * near + 0.012 * (temp[k] - 12) - 0.15 * h / Math.max(relief, 500) - 0.35 * shadow);
    }
  }
  lap('humidity');

  // ---- rivers: rain on each cell runs along the flood's paths (cells reached later drain to earlier ones) ----
  const flow = new Float32Array(N);
  {
    const cellKm2 = cell * cell / 1e6;
    for (let k = 0; k < N; k++) flow[k] = water[k] === 1 ? 0 : (0.2 + humid[k]) * cellKm2;   // rain on this cell, km2
    for (let v = nv - 1; v >= 0; v--){ const k = visit[v]; if (down[k] >= 0) flow[down[k]] += flow[k]; }
    // a river where enough rain gathers (catchment of a few km2, scaled a little with the world)
    const riverAt = Math.max(2, size / 1000 * 0.15);
    for (let k = 0; k < N; k++){
      if (water[k] || flow[k] < riverAt) continue;
      water[k] = 3;
      // a shallow valley: deeper for bigger rivers, never below the water around it
      elev[k] = Math.max(elev[k] - Math.min(4 * Math.log2(flow[k] / riverAt + 1), relief * 0.05), 0.5);
    }
  }
  lap('rivers');

  // distance to any water including rivers, for fertility and a little extra humidity near rivers
  const distR = chamfer(res, cell, (k) => water[k] !== 0);
  for (let k = 0; k < N; k++) if (water[k] !== 1) humid[k] = clamp01(humid[k] + 0.12 * Math.exp(-distR[k] / 600));

  // ---- metals: deposits in cells of ~2 km; more likely under hills ----
  const metals = [], mc = Math.max(2000, size / 64), mn = Math.ceil(size / mc);
  const chance = [0.22, 0.12, 0.16, 0.025];
  for (let b = 0; b < mn; b++) for (let a = 0; a < mn; a++){
    const hb = h2(a, b, salt(seed, 8));
    for (let t = 0; t < METALS.length; t++){
      const x = -half + (a + rnd(hb, 10 + t * 3)) * mc, z = -half + (b + rnd(hb, 11 + t * 3)) * mc;
      const k = gridIndex(x, z), h = elev[k];
      if (water[k] === 1) continue;
      const hill = Math.min(Math.max(h / (relief * 0.4), 0), 1);
      if (rnd(hb, 12 + t * 3) < chance[t] * (0.4 + 1.6 * hill)) metals.push({ type: t, x, z, size: 0.3 + rnd(hb, 30 + t) * 0.7 });
    }
  }
  lap('metals');

  // ---- fertility and life ----
  const fert = new Float32Array(N), life = new Uint8Array(N);
  for (let j = 0; j < res; j++) for (let i = 0; i < res; i++){
    const k = j * res + i;
    if (water[k] === 1){ life[k] = 0; continue; }
    if (water[k] === 2){ life[k] = 1; continue; }
    const h = Math.max(elev[k], 0), T = temp[k], H = humid[k];
    const slope = Math.hypot(elev[j * res + Math.min(i + 1, res - 1)] - elev[j * res + Math.max(i - 1, 0)],
                             elev[Math.min(j + 1, res - 1) * res + i] - elev[Math.max(j - 1, 0) * res + i]) / (2 * cell);
    const comfy = Math.exp(-Math.pow((T - 17) / 10, 2));
    const wet = Math.min(Math.max((H - 0.1) / 0.5, 0), 1);
    const flat = 1 - Math.min(Math.max((slope - 0.04) / 0.25, 0), 1);
    const low = 1 - 0.6 * Math.min(Math.max((h - relief * 0.3) / (relief * 0.7), 0), 1);
    fert[k] = clamp01(comfy * wet * flat * low + 0.25 * Math.exp(-distR[k] / 400) * comfy);
    let L;
    if (slope > 0.55 || h > relief * 0.85) L = 12;                                   // bare rock
    else if (h < 3 && distW[k] < cell * 2.5 && water[k] !== 3) L = 2;                // beach
    else if (T < -6) L = 3;
    else if (T < 0) L = 4;
    else if (T < 6) L = H > 0.4 ? 5 : 6;
    else if (T < 20) L = H > 0.5 ? 8 : 7;
    else L = H < 0.2 ? 9 : H < 0.45 ? 10 : 11;
    life[k] = L;
  }
  lap('fertility and life');

  // the height above the water surface (sea, lake or river level), as the rest of the code reads it
  const height = new Float32Array(N);
  for (let k = 0; k < N; k++) height[k] = water[k] === 1 ? Math.min(elev[k], -0.5) : water[k] === 2 ? elev[k] - surf[k] : Math.max(elev[k], 0.3);

  function gridIndex(x, z){
    const i = Math.min(res - 1, Math.max(0, Math.floor((x + half) / cell))), j = Math.min(res - 1, Math.max(0, Math.floor((z + half) / cell)));
    return j * res + i;
  }
  const heightAt = (x, z) => {
    const fx = (x + half) / cell - 0.5, fz = (z + half) / cell - 0.5;
    if (fx < 0 || fz < 0 || fx > res - 1 || fz > res - 1) return -1;
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
    const i1 = Math.min(i + 1, res - 1), j1 = Math.min(j + 1, res - 1);
    const a = height[j * res + i], b = height[j * res + i1], c = height[j1 * res + i], d = height[j1 * res + i1];
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  return { size, seed, lat, half, res, cell, relief, height, elev, water, flow, temp, humid, fert, life, metals,
    heightAt, isLand: (x, z) => heightAt(x, z) > 0, gridIndex, ms: performance.now() - t0, times };
}

/** A world made from data built elsewhere (the background worker gets the grids instead of rebuilding them). */
export function worldFromData(d){
  const { res, cell, half, height } = d;
  const heightAt = (x, z) => {
    const fx = (x + half) / cell - 0.5, fz = (z + half) / cell - 0.5;
    if (fx < 0 || fz < 0 || fx > res - 1 || fz > res - 1) return -1;
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
    const i1 = Math.min(i + 1, res - 1), j1 = Math.min(j + 1, res - 1);
    const a = height[j * res + i], b = height[j * res + i1], c = height[j1 * res + i], e = height[j1 * res + i1];
    return a + (b - a) * u + (c - a) * v + (a - b - c + e) * u * v;
  };
  return { ...d, heightAt, isLand: (x, z) => heightAt(x, z) > 0 };
}

const DX = [1, -1, 0, 0, 1, 1, -1, -1], DZ = [0, 0, 1, -1, 1, -1, 1, -1];
const clamp01 = (v) => v < 0 ? 0 : v > 1 ? 1 : v;
// distance (m) from every cell to the nearest cell where src(k) is true (two passes, 8 neighbours)
export function chamfer(res, cell, src){
  const N = res * res, d = new Float32Array(N), a = cell, b = cell * Math.SQRT2;
  for (let k = 0; k < N; k++) d[k] = src(k) ? 0 : 1e9;
  for (let j = 0; j < res; j++) for (let i = 0; i < res; i++){
    const k = j * res + i;
    let v = d[k];
    if (i > 0) v = Math.min(v, d[k - 1] + a);
    if (j > 0){ v = Math.min(v, d[k - res] + a); if (i > 0) v = Math.min(v, d[k - res - 1] + b); if (i < res - 1) v = Math.min(v, d[k - res + 1] + b); }
    d[k] = v;
  }
  for (let j = res - 1; j >= 0; j--) for (let i = res - 1; i >= 0; i--){
    const k = j * res + i;
    let v = d[k];
    if (i < res - 1) v = Math.min(v, d[k + 1] + a);
    if (j < res - 1){ v = Math.min(v, d[k + res] + a); if (i < res - 1) v = Math.min(v, d[k + res + 1] + b); if (i > 0) v = Math.min(v, d[k + res - 1] + b); }
    d[k] = v;
  }
  return d;
}
// a binary heap of cell indices by a float priority (smallest first)
class MinHeap {
  constructor(n){ this.k = new Uint32Array(n); this.p = new Float32Array(n); this.size = 0; }
  push(k, p){
    let i = this.size++;
    while (i > 0){ const up = (i - 1) >> 1; if (this.p[up] <= p) break; this.k[i] = this.k[up]; this.p[i] = this.p[up]; i = up; }
    this.k[i] = k; this.p[i] = p;
  }
  pop(){
    const top = this.k[0], k = this.k[--this.size], p = this.p[this.size];
    let i = 0;
    for (;;){
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.p[c + 1] < this.p[c]) c++;
      if (this.p[c] >= p) break;
      this.k[i] = this.k[c]; this.p[i] = this.p[c]; i = c;
    }
    this.k[i] = k; this.p[i] = p;
    return top;
  }
}
