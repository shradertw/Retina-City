/* World history on the natural maps (steps 4b and 4c). Every chance is a hash of the seed, the step and a
   counter, so the same world always has the same history. The result keeps every settlement's population
   and place at every step, and the year each farm, centre and road appeared, so the map can replay it.

   Age 2, years 0-500 (50 steps of 10 years): settlements
   Founding   each step a few spots are drawn at random, weighted by how good they are to live on (fertile,
              flat, near fresh water; the coast helps too). A spot too near an existing settlement is skipped.
              A new settlement has 20-80 people.
   Growth     a settlement farms the land around it, out to farmReach beyond its edge. The food there sets
              how many people it can feed; neighbours whose farmland overlaps share it. Growth is logistic
              toward that limit (and shrinks above it). River and coast raise the limit (trade, fishing).
   Trade      a settlement also lives off trade with the people around it (within ~15 km, nearer counts more),
              and the bigger it already is, the more of that trade it captures: market towns emerge among
              villages. Rivers, the coast and (from age 3) roads carry trade further.
   Setbacks   now and then a settlement loses part of its people (fire, plague, raids); under 15 it dies out.
   Merging    settlements that grow into each other merge into the larger one.

   Age 3, years 500-650 (30 steps of 5 years): farms, distribution centres and roads; settlements go on as above
   Farms      land is farmed in plots of about 200 m. Each settlement takes the most fertile free plots within
              its reach until they feed its people (farming is better than in age 2). Plots of a settlement
              that dies out fall free.
   Centres    where a settlement's farmland is large and no distribution centre is within CENTRE_GAP, one
              appears in the middle of those farms.
   Roads      the cheapest route over the land: slopes cost more, rivers need a bridge, lakes and sea cannot be
              crossed, and an existing road is much cheaper to follow, so routes bundle into main roads.
              Each centre is linked to its nearest settlement or two; each settlement of LINK_POP+ people to
              its nearest neighbours; and each step each centre runs a farm track to its plot farthest from
              any road. A road's class comes from how many routes share it. */
import { h2, rnd } from '../world/hash.js';
import { salt } from './noise.js';
import { chamfer } from './world.js';

export const AGES = [{ name: 'Settlements', from: 0, steps: 50, years: 10 }, { name: 'Farms and roads', from: 500, steps: 30, years: 5 }];
const DENSITY = 3000;          // people per km2 of settled ground (old towns were dense)
const FOOD2 = 90, FOOD3 = 125; // people one km2 of fully fertile land feeds, in age 2 and with age 3 farming
const GROWTH = 0.13;           // growth per 10 years while well below the limit
const CENTRE_FARM = 3;         // km2 of a settlement's farmland that calls for a distribution centre
const CENTRE_GAP = 4;          // km between distribution centres
const LINK_POP = 150;          // settlements this big are linked by road to their neighbours

/** radius (km) of the ground a population covers */
export const radiusKm = (pop) => Math.sqrt(pop / (DENSITY * Math.PI));

/** @param {import('./world.js').World} w @param {Record<string, number>} [o] start-screen options */
export function runHistory(w, o = {}, onProgress = null){
  const t0 = performance.now(), times = {};
  let tl = t0;
  const lap = (name) => { const t = performance.now(); times[name] = (times[name] || 0) + t - tl; tl = t; };
  const farmReach = o.farm ?? 2.5, minGap = o.gap ?? 1.2;
  const trade = 0.35 * (o.trade ?? 100) / 100, setback = 0.025 * (o.setbacks ?? 100) / 100;
  const rate = (o.settleRate ?? 100) / 100, links = Math.round(o.links ?? 2), tracks = (o.tracks ?? 100) / 100;
  const { res, cell, half } = w, N = res * res, cellKm = cell / 1000, cellKm2 = cellKm * cellKm;
  const S = salt(w.seed, 40);
  // distances (m) to the sea and to fresh water
  const dSea = chamfer(res, cell, (k) => w.water[k] === 1);
  const dFresh = chamfer(res, cell, (k) => w.water[k] === 2 || w.water[k] === 3);
  // how good each cell is to settle (0 on water), and a running total to draw spots from
  const cum = new Float64Array(N), slope = new Float32Array(N);
  let total = 0, landKm2 = 0;
  for (let j = 0; j < res; j++) for (let i = 0; i < res; i++){
    const k = j * res + i;
    const hx = w.elev[j * res + Math.min(i + 1, res - 1)] - w.elev[j * res + Math.max(i - 1, 0)];
    const hz = w.elev[Math.min(j + 1, res - 1) * res + i] - w.elev[Math.max(j - 1, 0) * res + i];
    slope[k] = Math.hypot(hx, hz) / (2 * cell);
    if (w.water[k]){ cum[k] = total; continue; }
    landKm2 += cellKm2;
    const flat = Math.max(0, 1 - slope[k] / 0.15);
    const water = 0.25 + 0.75 * Math.exp(-dFresh[k] / 600) + 0.3 * Math.exp(-dSea[k] / 800);
    total += Math.pow(w.fert[k], 1.5) * flat * flat * water; cum[k] = total;
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
  lap('maps');

  const STEPS = AGES[0].steps + AGES[1].steps, year = new Int16Array(STEPS + 1);
  for (let s = 0; s <= STEPS; s++) year[s] = s <= AGES[0].steps ? s * AGES[0].years : AGES[1].from + (s - AGES[0].steps) * AGES[1].years;
  const list = [];
  // a coarse grid of 4 km buckets for neighbour searches
  const BK = 4, buckets = new Map(), bkey = (x, z) => Math.floor(x / BK) * 100003 + Math.floor(z / BK);
  const addB = (s) => { const key = bkey(s.x, s.z); let b = buckets.get(key); if (!b){ b = []; buckets.set(key, b); } b.push(s); };
  const rebucket = () => { buckets.clear(); for (const s of list) if (s.alive) addB(s); };
  const near = (x, z, R) => {
    const out = [], n = Math.ceil(R / BK);
    for (let b = -n; b <= n; b++) for (let a = -n; a <= n; a++){ const l = buckets.get(bkey(x + a * BK, z + b * BK)); if (l) out.push(...l); }
    return out;
  };

  // ---- age 3 state: farm plots, centres, roads ----
  const fm = Math.max(1, Math.round(200 / cell)), fres = Math.floor(res / fm), fcell = fm * cell, fcellKm2 = (fcell / 1000) ** 2;
  const plotFert = new Float32Array(fres * fres), owner = new Int32Array(fres * fres).fill(-1), plotSince = new Int16Array(fres * fres);
  for (let j = 0; j < fres; j++) for (let i = 0; i < fres; i++){
    let f = 0, landN = 0;
    for (let b = 0; b < fm; b++) for (let a = 0; a < fm; a++){
      const k = (j * fm + b) * res + i * fm + a;
      if (w.water[k] === 1 || w.water[k] === 2) continue;
      landN++; f += w.fert[k] * Math.max(0, 1 - slope[k] / 0.25);
    }
    plotFert[j * fres + i] = landN * 2 > fm * fm ? f / landN : 0;
  }
  const plotX = (i) => (-half + (i + 0.5) * fcell) / 1000;     // km
  const centres = [], roadPaths = [];
  // Roads are routed on a grid of at least 64 m (finer than that only costs time): heights averaged, a cell is
  // water if most of it is sea or lake, and a river cell if a river runs through it.
  const rf = Math.max(1, Math.round(64 / cell)), rres = Math.floor(res / rf), rcell = rf * cell, RN = rres * rres;
  const relev = new Float32Array(RN), rwater = new Uint8Array(RN);
  for (let j = 0; j < rres; j++) for (let i = 0; i < rres; i++){
    let e = 0, wet = 0, river = 0;
    for (let b = 0; b < rf; b++) for (let a = 0; a < rf; a++){
      const k = (j * rf + b) * res + i * rf + a;
      e += w.elev[k]; if (w.water[k] === 1 || w.water[k] === 2) wet++; if (w.water[k] === 3) river++;
    }
    relev[j * rres + i] = e / (rf * rf);
    rwater[j * rres + i] = wet * 2 > rf * rf ? 1 : river ? 3 : 0;
  }
  const atR = (x, z) => {
    const i = Math.min(rres - 1, Math.max(0, Math.floor((x * 1000 + half) / rcell))), j = Math.min(rres - 1, Math.max(0, Math.floor((z * 1000 + half) / rcell)));
    return j * rres + i;
  };
  const road = new Uint16Array(RN), roadSince = new Int16Array(RN);   // routes sharing each cell; step it was built
  let roadDist = null;                                       // metres to the nearest road cell (refreshed per step)
  const linked = new Set();

  // Least-cost route between two cells (A*, within a box around them), or to the nearest road (goal = -1).
  const gScore = new Float32Array(RN), from = new Int32Array(RN), stamp = new Int32Array(RN), heap = new Heap(RN * 2);
  let search = 0;
  const DI = [1, -1, 0, 0, 1, 1, -1, -1], DJ = [0, 0, 1, -1, 1, -1, 1, -1];
  function route(a, goal, maxKm){
    search++;
    const ai = a % rres, aj = (a / rres) | 0;
    let i0, i1, j0, j1, gi = 0, gj = 0;
    if (goal >= 0){
      gi = goal % rres; gj = (goal / rres) | 0;
      const m = Math.max(20, Math.round(0.3 * Math.hypot(gi - ai, gj - aj)));
      i0 = Math.max(0, Math.min(ai, gi) - m); i1 = Math.min(rres - 1, Math.max(ai, gi) + m);
      j0 = Math.max(0, Math.min(aj, gj) - m); j1 = Math.min(rres - 1, Math.max(aj, gj) + m);
    } else {
      const m = Math.ceil(maxKm * 1000 / rcell);
      i0 = Math.max(0, ai - m); i1 = Math.min(rres - 1, ai + m); j0 = Math.max(0, aj - m); j1 = Math.min(rres - 1, aj + m);
    }
    heap.size = 0;
    gScore[a] = 0; from[a] = -1; stamp[a] = search; heap.push(a, 0);
    while (heap.size){
      const k = heap.pop(), g = gScore[k];
      if (k === goal || (goal < 0 && road[k] && k !== a)){
        const path = [];
        for (let c = k; c >= 0; c = from[c]) path.push(c);
        return path;
      }
      const i = k % rres, j = (k / rres) | 0;
      for (let d = 0; d < 8; d++){
        const ni = i + DI[d], nj = j + DJ[d];
        if (ni < i0 || nj < j0 || ni > i1 || nj > j1) continue;
        const n = nj * rres + ni, wt = rwater[n];
        if (wt === 1 && n !== goal) continue;
        const len = d < 4 ? rcell : rcell * 1.4142, s = Math.abs(relev[n] - relev[k]) / len;
        let c = len * (1 + 30 * s * s) * (wt === 3 ? 4 : 1);
        if (road[n]) c *= 0.35;
        const ng = g + c;
        if (stamp[n] === search && ng >= gScore[n]) continue;
        stamp[n] = search; gScore[n] = ng; from[n] = k;
        // toward the goal; or, looking for any road, toward the nearest one (by the distance map)
        const hcost = goal >= 0 ? 0.4 * rcell * Math.hypot(ni - gi, nj - gj) : 0.35 * roadDist[n];
        heap.push(n, ng + hcost);
      }
    }
    return null;
  }
  function build(path, step, kind){
    if (!path || path.length < 2) return;
    for (const k of path){ if (!road[k]) roadSince[k] = step; road[k] = Math.min(65535, road[k] + 1); }
    roadPaths.push({ cells: Int32Array.from(path), step, kind });
  }
  lap('maps');

  // ---- the steps ----
  const attempts = Math.max(1, Math.round(landKm2 / 400 * rate));
  let made = 0;
  for (let step = 1; step <= STEPS; step++){
    const age3 = step > AGES[0].steps, dt = age3 ? 0.5 : 1;     // fraction of a 10-year step
    rebucket();
    // founding (slower once roads and farms take over)
    const tries = age3 ? Math.round(attempts * 0.3) : step <= 10 ? attempts * 2 : attempts;
    for (let a = 0; a < tries && total > 0; a++){
      const hA = h2(step, a, S);
      const u = rnd(hA, 1) * total;
      let lo = 0, hi = N - 1;                 // the first cell whose running total reaches u
      while (lo < hi){ const mid = (lo + hi) >> 1; if (cum[mid] < u) lo = mid + 1; else hi = mid; }
      const x = (-half + ((lo % res) + rnd(hA, 2)) * cell) / 1000, z = (-half + (((lo / res) | 0) + rnd(hA, 3)) * cell) / 1000;
      if (w.water[at(x, z)]) continue;
      if (near(x, z, minGap + 3).some((t) => Math.hypot(t.x - x, t.z - z) < radiusKm(t.pop) + minGap)) continue;
      const id = made++;
      const s = { id, name: makeName(h2(id, 7, S)), x, z, born: step, died: 0, alive: true, mergedInto: -1, onRoad: false,
        pop: 20 + 60 * rnd(hA, 4), popAt: new Float32Array(STEPS + 1), xAt: new Float32Array(STEPS + 1), zAt: new Float32Array(STEPS + 1),
        plots: [], supply: 0, fx: 0, fz: 0, market: 0, others: 0 };
      list.push(s); addB(s);
    }
    lap('founding');
    // growth toward what the land around can feed, shared with neighbours whose farmland overlaps
    for (const s of list){
      if (!s.alive) continue;
      const r = radiusKm(s.pop), R = r + farmReach;
      let K = (age3 ? FOOD3 : FOOD2) * foodAround(s.x, s.z, R);
      const k = at(s.x, s.z);
      K *= 1 + 0.25 * Math.exp(-dFresh[k] / 500) + 0.35 * Math.exp(-dSea[k] / 1000);
      // neighbours: farmland shared with them, and trade with them (refreshed every second step)
      if (step % 2 === 1 || s.born === step){
        let others = 0, market = 0;
        for (const t of near(s.x, s.z, 12)){
          if (t === s || !t.alive) continue;
          const Rt = radiusKm(t.pop) + farmReach, d = Math.hypot(t.x - s.x, t.z - s.z);
          if (d < R + Rt) others += t.pop * (1 - d / (R + Rt));
          market += t.pop * Math.exp(-d / (s.onRoad && t.onRoad ? 6.5 : 5));
        }
        s.others = others; s.market = market;
      }
      const others = s.others, market = s.market;
      K = K * s.pop / (s.pop + 0.5 * others);
      const access = 1 + Math.exp(-dFresh[k] / 500) + Math.exp(-dSea[k] / 1000) + (s.onRoad ? 0.5 : 0);
      K = Math.max(10, K + trade * market * access * (s.pop / (s.pop + 800)));
      const hS = h2(step, s.id + 1000003, S);
      s.pop += dt * GROWTH * s.pop * (1 - s.pop / K) * (0.6 + 0.8 * rnd(hS, 1));
      if (rnd(hS, 2) < setback * dt) s.pop *= 0.3 + 0.4 * rnd(hS, 3);
      if (s.pop < 15){ s.alive = false; s.died = step; }
    }
    // merging: settlements whose edges touch become one (the larger absorbs the smaller, and its farms)
    rebucket();
    for (const s of list){
      if (!s.alive) continue;
      for (const t of near(s.x, s.z, 6)){
        if (t === s || !t.alive || !s.alive) continue;
        const d = Math.hypot(t.x - s.x, t.z - s.z);
        if (d > radiusKm(s.pop) + radiusKm(t.pop)) continue;
        const [big, small] = s.pop >= t.pop ? [s, t] : [t, s];
        const f = small.pop / (big.pop + small.pop);
        big.x += (small.x - big.x) * f; big.z += (small.z - big.z) * f; big.pop += small.pop;
        small.alive = false; small.died = step; small.mergedInto = big.id;
        for (const p of small.plots) owner[p] = big.id;
        big.plots.push(...small.plots); big.supply += small.supply; big.fx += small.fx; big.fz += small.fz;
        small.plots = []; small.supply = 0; small.fx = small.fz = 0;
        big.onRoad = big.onRoad || small.onRoad;
      }
    }
    lap('growth');
    if (age3){
      // farms of settlements that died out fall free
      for (const s of list) if (!s.alive && s.plots.length){ for (const p of s.plots) owner[p] = -1; s.plots = []; s.supply = 0; s.fx = s.fz = 0; }
      // each settlement takes the best free plots within reach until they feed its people
      for (const s of list){
        if (!s.alive) continue;
        const need = s.pop / FOOD3;                        // km2 of fully fertile land
        if (s.supply >= need) continue;
        const R = radiusKm(s.pop) + farmReach, ci = Math.floor(toI(s.x) / fm), cj = Math.floor(toI(s.z) / fm), m = Math.ceil(R * 1000 / fcell);
        const cand = [];
        for (let j = Math.max(0, cj - m); j <= Math.min(fres - 1, cj + m); j++) for (let i = Math.max(0, ci - m); i <= Math.min(fres - 1, ci + m); i++){
          const p = j * fres + i;
          if (owner[p] >= 0 || plotFert[p] < 0.08) continue;
          const d = Math.hypot(plotX(i) - s.x, plotX(j) - s.z);
          if (d > R || d < radiusKm(s.pop)) continue;
          cand.push([plotFert[p] * Math.exp(-d / 2), p]);
        }
        cand.sort((a, b) => b[0] - a[0]);
        for (const [, p] of cand){
          if (s.supply >= need) break;
          owner[p] = s.id; plotSince[p] = step; s.plots.push(p); s.supply += plotFert[p] * fcellKm2;
          s.fx += plotX(p % fres); s.fz += plotX((p / fres) | 0);
        }
      }
      lap('farms');
      // distribution centres in the middle of large farmland without one
      for (const s of list){
        if (!s.alive || s.plots.length * fcellKm2 < CENTRE_FARM) continue;
        const x = s.fx / s.plots.length, z = s.fz / s.plots.length;
        if (centres.some((c) => Math.abs(c.x - x) < CENTRE_GAP && Math.abs(c.z - z) < CENTRE_GAP && Math.hypot(c.x - x, c.z - z) < CENTRE_GAP)) continue;
        // on the nearest of its plots (so it stands on farmland, not in a lake)
        let best = s.plots[0], bd = 1e9;
        for (const p of s.plots){ const d = Math.hypot(plotX(p % fres) - x, plotX((p / fres) | 0) - z); if (d < bd){ bd = d; best = p; } }
        const c = { id: centres.length, x: plotX(best % fres), z: plotX((best / fres) | 0), born: step, by: s.id };
        centres.push(c);
        // linked to the nearest settlement or two
        const byDist = near(c.x, c.z, 12).filter((t) => t.alive).map((t) => [Math.hypot(t.x - c.x, t.z - c.z), t]).sort((a, b) => a[0] - b[0]);
        for (let n = 0; n < Math.min(2, byDist.length); n++){
          if (n === 1 && byDist[n][0] > 8) break;
          build(route(atR(c.x, c.z), atR(byDist[n][1].x, byDist[n][1].z)), step, 'road');
          byDist[n][1].onRoad = true;
        }
      }
      lap('centres');
      // settlements linked to their nearest neighbours
      for (const s of list){
        if (!s.alive || s.pop < LINK_POP) continue;
        const others = near(s.x, s.z, 20).filter((t) => t !== s && t.alive && t.pop >= 100)
          .map((t) => [Math.hypot(t.x - s.x, t.z - s.z), t]).filter((e) => e[0] < 20).sort((a, b) => a[0] - b[0]);
        for (let n = 0; n < Math.min(links, others.length); n++){
          const t = others[n][1], key = Math.min(s.id, t.id) * 1e6 + Math.max(s.id, t.id);
          if (linked.has(key)) continue;
          linked.add(key);
          build(route(atR(s.x, s.z), atR(t.x, t.z)), step, 'road');
          s.onRoad = t.onRoad = true;
        }
      }
      lap('roads');
      // farm tracks: each centre reaches its plot farthest from any road
      roadDist = chamfer(rres, rcell, (k) => road[k] > 0);
      const m5 = Math.ceil(5000 / fcell);
      for (const c of centres){
        const nT = Math.floor(tracks) + (rnd(h2(step, c.id, S + 9), 1) < tracks % 1 ? 1 : 0);
        const ci = Math.floor(toI(c.x) / fm), cj = Math.floor(toI(c.z) / fm);
        for (let n = 0; n < nT; n++){
          let best = -1, bd = 600;
          for (let j = Math.max(0, cj - m5); j <= Math.min(fres - 1, cj + m5); j++) for (let i = Math.max(0, ci - m5); i <= Math.min(fres - 1, ci + m5); i++){
            const p = j * fres + i;
            if (owner[p] < 0) continue;
            const d = roadDist[atR(plotX(i), plotX(j))];
            if (d > bd && (i - ci) * (i - ci) + (j - cj) * (j - cj) <= m5 * m5){ bd = d; best = p; }
          }
          if (best < 0) break;
          const path = route(atR(plotX(best % fres), plotX((best / fres) | 0)), -1, 5);
          build(path, step, 'track');
          if (path) for (const k of path) roadDist[k] = 0;
        }
      }
      lap('tracks');
    }
    for (const s of list){ s.popAt[step] = s.alive ? s.pop : 0; s.xAt[step] = s.x; s.zAt[step] = s.z; }
    if (onProgress) onProgress(step / STEPS, year[step]);
  }
  // road paths as world-space polylines (metres), each with its class: how many routes share it (the most-used
  // stretch along it), and when it was built
  for (const r of roadPaths){
    let use = 0;
    const pts = new Float32Array(r.cells.length * 2);
    r.cells.forEach((k, n) => { pts[2 * n] = -half + ((k % rres) + 0.5) * rcell; pts[2 * n + 1] = -half + (((k / rres) | 0) + 0.5) * rcell; use = Math.max(use, road[k]); });
    // smoothed: routes move cell to cell (zigzags); a few passes of neighbour averaging, ends kept
    for (let pass = 0; pass < 3; pass++){
      const q = pts.slice();
      for (let n = 1; n < r.cells.length - 1; n++){
        q[2 * n] = 0.25 * pts[2 * n - 2] + 0.5 * pts[2 * n] + 0.25 * pts[2 * n + 2];
        q[2 * n + 1] = 0.25 * pts[2 * n - 1] + 0.5 * pts[2 * n + 1] + 0.25 * pts[2 * n + 3];
      }
      pts.set(q);
    }
    r.pts = pts; r.use = use; r.cls = r.kind === 'track' && use < 3 ? 0 : use >= 6 ? 2 : 1;   // 0 track, 1 road, 2 main road
  }
  for (const s of list){ delete s.plots; }
  const alive = list.filter((s) => s.alive);
  return { steps: STEPS, year, ages: AGES, settlements: list, alive: alive.length,
    biggest: alive.reduce((m, s) => Math.max(m, s.pop), 0), landKm2,
    farms: { res: fres, cell: fcell, owner, since: plotSince, half }, centres, roads: roadPaths,
    roadGrid: { res: rres, cell: rcell, use: road, since: roadSince },
    ms: performance.now() - t0, times };
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
// a binary heap of cell indices by a float priority (smallest first)
class Heap {
  constructor(n){ this.k = new Int32Array(n); this.p = new Float32Array(n); this.size = 0; }
  push(k, p){
    if (this.size >= this.k.length) return;
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
