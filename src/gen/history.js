/* World history, age 2 (step 4b): settlements over 500 years, in 50 steps of 10 years, on the natural maps.

   Founding   each step a few spots are drawn at random, weighted by how good they are to live on (fertile,
              flat, near fresh water; the coast helps too). A spot too near an existing settlement is skipped.
              A new settlement has 20-80 people.
   Growth     a settlement farms the land around it, out to FARM_REACH beyond its edge. The food there sets
              how many people it can feed; neighbours whose farmland overlaps share it. Growth is logistic
              toward that limit (and shrinks above it). River and coast raise the limit (trade, fishing).
   Trade      a settlement also lives off trade with the people around it (within ~15 km, nearer counts more),
              and the bigger it already is, the more of that trade it captures: market towns emerge among
              villages. Rivers and the coast carry trade further.
   Setbacks   now and then a settlement loses part of its people (fire, plague, raids); under 15 it dies out.
   Merging    settlements that grow into each other merge into the larger one.

   Every chance is a hash of the seed, the step and a counter, so the same world always has the same history.
   The result keeps each settlement's population at every step, so the map can replay it. */
import { h2, rnd } from '../world/hash.js';
import { salt } from './noise.js';
import { chamfer } from './world.js';

export const AGE2 = { steps: 50, years: 10 };
const DENSITY = 3000;          // people per km2 of settled ground (old towns were dense)
let FARM_REACH = 2.5;          // km of farmland beyond a settlement's edge (start-screen option)
const FOOD = 90;               // people one km2 of fully fertile land feeds (pre-industrial)
const GROWTH = 0.13;           // growth per step (10 years) while well below the limit
let SETBACK = 0.025;           // chance per settlement per step of a setback (option: x 0-4)
let MIN_GAP = 1.2;             // km between a new settlement and the edge of an existing one (option)
let TRADE = 0.35;              // people a settlement can feed per person of trade around it (option: x 0-4)

/** radius (km) of the ground a population covers */
export const radiusKm = (pop) => Math.sqrt(pop / (DENSITY * Math.PI));

/** @param {import('./world.js').World} w @param {Record<string, number>} [o] start-screen options */
export function runAge2(w, o = {}){
  const t0 = performance.now();
  FARM_REACH = o.farm ?? 2.5; MIN_GAP = o.gap ?? 1.2;
  TRADE = 0.35 * (o.trade ?? 100) / 100; SETBACK = 0.025 * (o.setbacks ?? 100) / 100;
  const rate = (o.settleRate ?? 100) / 100;
  const { res, cell, half } = w, N = res * res, cellKm = cell / 1000, cellKm2 = cellKm * cellKm;
  const S = salt(w.seed, 40);
  // distances (m) to the sea and to fresh water
  const dSea = chamfer(res, cell, (k) => w.water[k] === 1);
  const dFresh = chamfer(res, cell, (k) => w.water[k] === 2 || w.water[k] === 3);
  // how good each cell is to settle (0 on water), and a running total to draw spots from
  const score = new Float64Array(N), cum = new Float64Array(N);
  let total = 0, landKm2 = 0;
  for (let j = 0; j < res; j++) for (let i = 0; i < res; i++){
    const k = j * res + i;
    if (w.water[k]){ cum[k] = total; continue; }
    landKm2 += cellKm2;
    const hx = w.elev[j * res + Math.min(i + 1, res - 1)] - w.elev[j * res + Math.max(i - 1, 0)];
    const hz = w.elev[Math.min(j + 1, res - 1) * res + i] - w.elev[Math.max(j - 1, 0) * res + i];
    const slope = Math.hypot(hx, hz) / (2 * cell);
    const flat = Math.max(0, 1 - slope / 0.15);
    const water = 0.25 + 0.75 * Math.exp(-dFresh[k] / 600) + 0.3 * Math.exp(-dSea[k] / 800);
    score[k] = Math.pow(w.fert[k], 1.5) * flat * flat * water;
    total += score[k]; cum[k] = total;
  }
  // food: fertility x area, as a summed-area table (box sums in constant time)
  const R1 = res + 1, sat = new Float64Array(R1 * R1);
  for (let j = 0; j < res; j++){
    let row = 0;
    for (let i = 0; i < res; i++){
      const k = j * res + i;
      row += w.water[k] === 1 || w.water[k] === 2 ? 0 : w.fert[k] * cellKm2;
      sat[(j + 1) * R1 + i + 1] = sat[j * R1 + i + 1] + row;
    }
  }
  const toI = (x) => (x * 1000 + half) / cell;
  // food within a square of half-size R km around (x, z) km, scaled to the circle inside it
  function foodAround(x, z, R){
    const i0 = Math.max(0, Math.floor(toI(x - R))), i1 = Math.min(res, Math.ceil(toI(x + R)));
    const j0 = Math.max(0, Math.floor(toI(z - R))), j1 = Math.min(res, Math.ceil(toI(z + R)));
    if (i1 <= i0 || j1 <= j0) return 0;
    return (sat[j1 * R1 + i1] - sat[j0 * R1 + i1] - sat[j1 * R1 + i0] + sat[j0 * R1 + i0]) * (Math.PI / 4);
  }
  const at = (x, z) => w.gridIndex(x * 1000, z * 1000);

  const STEPS = AGE2.steps, list = [];
  // a coarse grid of 4 km buckets for neighbour searches
  const BK = 4, buckets = new Map(), bkey = (x, z) => Math.floor(x / BK) * 100003 + Math.floor(z / BK);
  const rebucket = () => {
    buckets.clear();
    for (const s of list) if (s.alive){ const key = bkey(s.x, s.z); let b = buckets.get(key); if (!b){ b = []; buckets.set(key, b); } b.push(s); }
  };
  const near = (x, z, R) => {
    const out = [], n = Math.ceil(R / BK);
    for (let b = -n; b <= n; b++) for (let a = -n; a <= n; a++){ const l = buckets.get(bkey(x + a * BK, z + b * BK)); if (l) out.push(...l); }
    return out;
  };
  // founding attempts per step: about one per 400 km2 of land, more in the first century
  const attempts = Math.max(1, Math.round(landKm2 / 400 * rate));
  let made = 0;
  for (let step = 1; step <= STEPS; step++){
    rebucket();
    // founding
    const tries = step <= 10 ? attempts * 2 : attempts;
    for (let a = 0; a < tries && total > 0; a++){
      const hA = h2(step, a, S);
      const u = rnd(hA, 1) * total;
      let lo = 0, hi = N - 1;                 // the first cell whose running total reaches u
      while (lo < hi){ const mid = (lo + hi) >> 1; if (cum[mid] < u) lo = mid + 1; else hi = mid; }
      const x = (-half + ((lo % res) + rnd(hA, 2)) * cell) / 1000, z = (-half + (((lo / res) | 0) + rnd(hA, 3)) * cell) / 1000;
      if (w.water[at(x, z)]) continue;
      if (near(x, z, MIN_GAP + 3).some((o) => Math.hypot(o.x - x, o.z - z) < radiusKm(o.pop) + MIN_GAP)) continue;
      const id = made++;
      const s = { id, name: makeName(h2(id, 7, S)), x, z, born: step, died: 0, alive: true, mergedInto: -1,
        pop: 20 + 60 * rnd(hA, 4), popAt: new Float32Array(STEPS + 1), xAt: new Float32Array(STEPS + 1), zAt: new Float32Array(STEPS + 1) };
      list.push(s);
      const key = bkey(x, z); let b = buckets.get(key); if (!b){ b = []; buckets.set(key, b); } b.push(s);
    }
    // growth toward what the land around can feed, shared with neighbours whose farmland overlaps
    for (const s of list){
      if (!s.alive) continue;
      const r = radiusKm(s.pop), R = r + FARM_REACH;
      let K = FOOD * foodAround(s.x, s.z, R);
      const k = at(s.x, s.z);
      K *= 1 + 0.25 * Math.exp(-dFresh[k] / 500) + 0.35 * Math.exp(-dSea[k] / 1000);
      let others = 0, market = 0;
      for (const o of near(s.x, s.z, 16)){
        if (o === s || !o.alive) continue;
        const Ro = radiusKm(o.pop) + FARM_REACH, d = Math.hypot(o.x - s.x, o.z - s.z);
        if (d < R + Ro) others += o.pop * (1 - d / (R + Ro));
        market += o.pop * Math.exp(-d / 5);
      }
      K = K * s.pop / (s.pop + 0.5 * others);
      const access = 1 + Math.exp(-dFresh[k] / 500) + Math.exp(-dSea[k] / 1000);
      K = Math.max(10, K + TRADE * market * access * (s.pop / (s.pop + 800)));
      const hS = h2(step, s.id + 1000003, S);
      s.pop += GROWTH * s.pop * (1 - s.pop / K) * (0.6 + 0.8 * rnd(hS, 1));
      if (rnd(hS, 2) < SETBACK) s.pop *= 0.3 + 0.4 * rnd(hS, 3);
      if (s.pop < 15){ s.alive = false; s.died = step; }
    }
    // merging: settlements whose edges touch become one (the larger absorbs the smaller)
    rebucket();
    for (const s of list){
      if (!s.alive) continue;
      for (const o of near(s.x, s.z, 6)){
        if (o === s || !o.alive || !s.alive) continue;
        const d = Math.hypot(o.x - s.x, o.z - s.z);
        if (d > radiusKm(s.pop) + radiusKm(o.pop)) continue;
        const [big, small] = s.pop >= o.pop ? [s, o] : [o, s];
        const f = small.pop / (big.pop + small.pop);
        big.x += (small.x - big.x) * f; big.z += (small.z - big.z) * f; big.pop += small.pop;
        small.alive = false; small.died = step; small.mergedInto = big.id;
      }
    }
    for (const s of list){ s.popAt[step] = s.alive ? s.pop : 0; s.xAt[step] = s.x; s.zAt[step] = s.z; }
  }
  const alive = list.filter((s) => s.alive);
  return { steps: STEPS, yearsPerStep: AGE2.years, settlements: list, alive: alive.length,
    biggest: alive.reduce((m, s) => Math.max(m, s.pop), 0), landKm2, ms: performance.now() - t0 };
}

// Settlement names from syllables (seeded): two or three parts, sometimes with an ending.
const A = ['bar', 'cal', 'dun', 'el', 'fen', 'gar', 'hal', 'ive', 'kel', 'lin', 'mar', 'nor', 'os', 'pen', 'quel', 'ros', 'sal', 'tor', 'ul', 'ven', 'wil', 'yar', 'ash', 'brin', 'cor', 'dor'];
const B = ['a', 'e', 'i', 'o', 'an', 'en', 'in', 'on', 'ar', 'er', 'el', 'ow', 'ey', 'ith'];
const C = ['ton', 'by', 'ford', 'ham', 'wick', 'stead', 'mouth', 'bury', 'dale', 'field', 'holm', 'mere', 'brook', 'ley', 'well', 'gate'];
function makeName(h){
  let n = A[Math.floor(rnd(h, 1) * A.length)];
  if (rnd(h, 2) < 0.6) n += B[Math.floor(rnd(h, 3) * B.length)];
  n += C[Math.floor(rnd(h, 4) * C.length)];
  return n[0].toUpperCase() + n.slice(1);
}
