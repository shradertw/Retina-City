/* The history simulation (design: "Simulated history (v2)" in the design doc). From year 0 to the chosen
   duration, in 5-year steps, family groups live on the natural maps: they forage, learn to farm, settle,
   grow, split and die out; settlements are tags on the land that their buildings carry; discoveries are
   made and spread. Every chance is a hash of the seed, the step and a counter: the same world always has the
   same history.

   Households (family groups) are foragers, farmers or crafts people.
     Foragers   bands that move each step toward richer, emptier wild land; they grow slowly up to what the
                wild land feeds. A band can discover farming (an easy discovery on fertile land) or learn it
                from farming settlements nearby, and then settles: it builds a home on good land near water.
     Farmers    farm land cells near their home (up to FARM_REACH) until the harvest feeds them with some to
                spare; the harvest per km2 grows with discoveries. Too little food and they shrink.
     Crafts     live off the settlement's surplus (what its farmers grow beyond their own needs) and build in
                its middle, close together: where farmland is rich, villages become towns.
   A household above SPLIT people splits: a branch of 8-15 becomes crafts people if the settlement's surplus
   can feed them, else builds next to the family while farmland nearby is free, else starts a farmstead
   further out, else moves on to open land a few km away.
   Settlement tags: a building with no other building within the tag radius starts a new settlement and tags
   the untagged land within the radius. A building on tagged land takes that tag (with the rival chance, the
   tag of another settlement with buildings within the radius). Every building tags untagged land within the
   radius. Every 5 steps land (and the buildings on it) goes to the tag the buildings around it mostly carry,
   when that tag clearly dominates. A settlement with no buildings left is gone.
   Knowledge: see src/gen/tech.js. A household may make a discovery each step (more likely with more
   ingenuity, more spare food and a bigger settlement); knowledge spreads quickly within a settlement and
   more slowly between settlements in contact (the wheel widens contact). It belongs to households (lost when
   the last who knew it dies out) or, with the option, to the whole settlement. */
import { h2, rnd } from '../world/hash.js';
import { salt } from './noise.js';
import { chamfer } from './world.js';
import { makeName } from './history.js';
import { TECH, bit, yieldOf, eraOf } from './tech.js';
import { makeRouter } from './route.js';

export const STEP_YEARS = 5;
const BAND = 20;               // people in a forager band at the start
const WILD = 0.35;             // people one km2 of rich wild land feeds
const YIELD = 55;              // people one km2 of fully fertile farmland feeds, before discoveries
const SPLIT = 40;              // a household above this splits
const FARM_REACH = 2000;       // m: how far from home a household farms
const GAP = 22;                // m: least distance between buildings
const FARMER = 1, FORAGER = 0, CRAFTS = 2;
const RES_BITS = { copper: 1, iron: 2, coal: 4, river: 8 };

/** @param {import('./world.js').World} w @param {Record<string, number>} [o] */
export function runSim(w, o = {}, onProgress = null){
  const t0 = performance.now(), times = {};
  let tl = t0;
  const lap = (n) => { const t = performance.now(); times[n] = (times[n] || 0) + t - tl; tl = t; };
  const years = o.duration ?? 1000, steps = Math.max(1, Math.round(years / STEP_YEARS));
  const R = (o.tagRadius ?? 1) * 1000, rival = (o.rival ?? 5) / 100, shared = !!o.sharedKnow;
  // the settings are real likelihoods; here they become chances per 5-year step
  const perStep = (pc, years) => 1 - Math.pow(1 - Math.min(pc, 99.9) / 100, STEP_YEARS / years);
  // discovery: the chance that an average farming family (ingenuity 0.5, ordinary harvest, small village)
  // comes up with the plough within 100 years; every discovery's chance scales with it
  const pace = perStep(o.discovery ?? 15, 100) / (0.5 / TECH[1].difficulty);
  const startDensity = o.startDensity ?? 60;                    // people per 100 km2 of land at the start
  const setback = perStep(o.setbackRisk ?? 33, 100);            // a settlement's chance of a setback per step
  const links = Math.round(o.links ?? 2);
  const S = salt(w.seed, 60);
  const { res, cell, half } = w;
  // what is kept for the map: at most 400 frames (a long history keeps one frame per several steps); every
  // step and year below in the output is a frame
  const rec = Math.max(1, Math.ceil(steps / 400)), frames = Math.ceil(steps / rec), fr = (s) => Math.ceil(s / rec);
  const year = new Int16Array(frames + 1);
  for (let f = 0; f <= frames; f++) year[f] = Math.min(f * rec, steps) * STEP_YEARS;
  let cnt = 0;                                                  // counter for chances
  const chance = (a, k = 1) => rnd(h2(a, cnt++, S), k);

  // ---- land grid (~128 m) ----
  const lf = Math.max(1, Math.round(128 / cell)), LC = lf * cell, lres = Math.floor(res / lf), LN = lres * lres, cellKm2 = (LC / 1000) ** 2;
  const dFresh = chamfer(res, cell, (k) => w.water[k] === 2 || w.water[k] === 3);
  const dSea = chamfer(res, cell, (k) => w.water[k] === 1);
  const lfert = new Float32Array(LN), lwild = new Float32Array(LN), lbuild = new Uint8Array(LN), lwater = new Float32Array(LN);
  let landKm2 = 0;
  for (let j = 0; j < lres; j++) for (let i = 0; i < lres; i++){
    let f = 0, wild = 0, land = 0, river = 0, dw = 1e9;
    for (let b = 0; b < lf; b++) for (let a = 0; a < lf; a++){
      const wi = i * lf + a, wj = j * lf + b, k = wj * res + wi;
      if (w.water[k] === 3) river++;
      if (w.water[k]) continue;
      land++;
      const hx = w.elev[wj * res + Math.min(wi + 1, res - 1)] - w.elev[wj * res + Math.max(wi - 1, 0)];
      const hz = w.elev[Math.min(wj + 1, res - 1) * res + wi] - w.elev[Math.max(wj - 1, 0) * res + wi];
      const flat = Math.max(0, 1 - Math.hypot(hx, hz) / (2 * cell) / 0.2);
      f += w.fert[k] * flat;
      const L = w.life[k];
      const lw = L === 5 || L === 7 || L === 8 || L === 10 || L === 11 ? 1 : L === 6 || L === 4 ? 0.4 : 0.1;
      wild += lw * (0.4 + w.fert[k]) * (1 + 0.6 * Math.exp(-dSea[k] / 1500) + 0.4 * Math.exp(-dFresh[k] / 800));
      dw = Math.min(dw, dFresh[k]);
    }
    const c = j * lres + i;
    if (land * 2 <= lf * lf) continue;                         // mostly water: nothing here
    landKm2 += cellKm2;
    lfert[c] = f / land; lwild[c] = wild / land;
    lwater[c] = Math.exp(-dw / 700);                            // fresh water nearby (for homes)
    lbuild[c] = river ? 0 : 1;                                  // no building in a river cell
  }
  const landAt = (x, z) => {
    const i = Math.floor((x + half) / LC), j = Math.floor((z + half) / LC);
    return i < 0 || j < 0 || i >= lres || j >= lres ? -1 : j * lres + i;
  };
  const lx = (i) => -half + (i + 0.5) * LC;
  // resources within reach of a point (metal deposits within 6 km, a river within 2 km)
  const resourcesAt = (x, z) => {
    let m = 0;
    for (const d of w.metals){
      if (Math.hypot(d.x - x, d.z - z) > 6000) continue;
      if (d.type === 0) m |= RES_BITS.iron; else if (d.type === 1) m |= RES_BITS.copper; else if (d.type === 2) m |= RES_BITS.coal;
    }
    if (dFresh[w.gridIndex(x, z)] < 2000) m |= RES_BITS.river;
    return m;
  };
  const techRes = TECH.map((t) => t.resource ? RES_BITS[t.resource] : 0);
  lap('maps');

  // ---- state ----
  const ltag = new Int32Array(LN).fill(-1), lfarm = new Int32Array(LN).fill(-1);
  const tagEv = [], farmEv = [];                                // land changes, for the map's replay: [cell, step, value]
  const H = [];                                                 // households
  const B = { x: [], z: [], kind: [], tag: [], born: [], died: [], hh: [] };    // buildings (died 0 = standing)
  const T = [];                                                 // settlements (tags)
  const log = [];
  // buildings in buckets: coarse (tag radius) and fine (for spacing)
  const bkC = new Map(), bkF = new Map(), FG = 40;
  const key = (a, b) => a * 1000003 + b;
  const addTo = (m, k, v) => { let l = m.get(k); if (!l){ l = []; m.set(k, l); } l.push(v); };
  const removeFrom = (m, k, v) => { const l = m.get(k); if (l){ const i = l.indexOf(v); if (i >= 0){ l[i] = l[l.length - 1]; l.pop(); } } };
  const buildingsNear = (x, z, r) => {
    const out = [], n = Math.ceil(r / R), ci = Math.floor(x / R), cj = Math.floor(z / R);
    for (let b = -n; b <= n; b++) for (let a = -n; a <= n; a++) for (const id of bkC.get(key(ci + a, cj + b)) || [])
      if (Math.hypot(B.x[id] - x, B.z[id] - z) <= r) out.push(id);
    return out;
  };
  const spaceFree = (x, z) => {
    const ci = Math.floor(x / FG), cj = Math.floor(z / FG);
    for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) for (const id of bkF.get(key(ci + a, cj + b)) || [])
      if (Math.hypot(B.x[id] - x, B.z[id] - z) < GAP) return false;
    return true;
  };
  const buildable = (x, z) => { const c = landAt(x, z); return c >= 0 && lbuild[c] === 1 && spaceFree(x, z); };
  // ring offsets of land cells within reach, nearest first (for farmland and tag claims)
  const ring = (r) => {
    const n = Math.ceil(r / LC), out = [];
    for (let b = -n; b <= n; b++) for (let a = -n; a <= n; a++){ const d = Math.hypot(a, b) * LC; if (d <= r) out.push([a, b, d]); }
    return out.sort((p, q) => p[2] - q[2]);
  };
  const farmRing = ring(FARM_REACH), tagRing = ring(R);

  function newSettlement(x, z, step){
    const id = T.length;
    const s = { id, name: makeName(h2(id, 7, S)), born: fr(step), died: 0, alive: true, mergedInto: -1, onRoad: false, core: [x, z],
      popAt: new Float32Array(frames + 1), xAt: new Float32Array(frames + 1), zAt: new Float32Array(frames + 1), areaAt: new Float32Array(frames + 1),
      knowAt: new Int32Array(frames + 1), know: 0, nb: 0, cells: 0, pop: 0, x: x / 1000, z: z / 1000, crafts: 0, cap: 0, everB: 0 };
    T.push(s);
    return s;
  }
  function setTag(c, tag, step){
    const old = ltag[c];
    if (old === tag) return;
    if (old >= 0) T[old].cells--;
    ltag[c] = tag; T[tag].cells++;
    tagEv.push(c, fr(step), tag);
  }
  function claim(x, z, tag, step){
    const ci = Math.floor((x + half) / LC), cj = Math.floor((z + half) / LC);
    for (const [a, b] of tagRing){
      const i = ci + a, j = cj + b;
      if (i < 0 || j < 0 || i >= lres || j >= lres) continue;
      const c = j * lres + i;
      if (ltag[c] < 0 && lfert[c] + lwild[c] > 0) setTag(c, tag, step);
    }
  }
  /** a new building for household h at (x, z); its settlement tag by the rules above */
  function build(h, x, z, kind, step){
    const c = landAt(x, z), near = buildingsNear(x, z, R);
    let tag = ltag[c];
    if (tag < 0){
      if (!near.length) tag = newSettlement(x, z, step).id;
      else { let bd = 1e9; for (const id of near){ const d = Math.hypot(B.x[id] - x, B.z[id] - z); if (d < bd){ bd = d; tag = B.tag[id]; } } }
    }
    if (near.length && chance(h.id, 1) < rival){
      const others = near.filter((id) => B.tag[id] !== tag);
      if (others.length) tag = B.tag[others[Math.floor(chance(h.id, 2) * others.length)]];
    }
    const id = B.x.length;
    B.x.push(x); B.z.push(z); B.kind.push(kind); B.tag.push(tag); B.born.push(fr(step)); B.died.push(0); B.hh.push(h.id);
    addTo(bkC, key(Math.floor(x / R), Math.floor(z / R)), id); addTo(bkF, key(Math.floor(x / FG), Math.floor(z / FG)), id);
    const s = T[tag];
    s.nb++; s.everB++;
    if (shared){ s.know |= h.know; h.know = s.know; }
    h.b = id; h.tag = tag; h.x = x; h.z = z; h.res = resourcesAt(x, z);
    claim(x, z, tag, step);
    return id;
  }
  function abandon(h, step){
    if (h.b >= 0){
      const id = h.b;
      B.died[id] = fr(step);
      removeFrom(bkC, key(Math.floor(B.x[id] / R), Math.floor(B.z[id] / R)), id);
      removeFrom(bkF, key(Math.floor(B.x[id] / FG), Math.floor(B.z[id] / FG)), id);
      T[B.tag[id]].nb--;
      h.b = -1;
    }
    for (const c of h.cells){ lfarm[c] = -1; farmEv.push(c, fr(step), 0); }
    h.cells = []; h.cap = 0;
  }
  function newHousehold(x, z, people, ing, know, mode, step, parent = -1){
    const h = { id: H.length, x, z, people, ing, know, mode, tag: -1, b: -1, cells: [], cap: 0, food: 0, born: step, alive: true, parent, res: 0, ri: 0 };
    H.push(h);
    return h;
  }
  const inherit = (ing, a) => Math.min(1, Math.max(0.02, ing + 0.15 * (chance(a, 3) - 0.5)));
  // farmland: take free cells near home (own settlement's land or untagged), best first, until the harvest
  // reaches target people's worth
  function farm(h, target, step){
    const yf = YIELD * yieldOf(h.know) * cellKm2;
    if (h.cap * yf >= target) return;
    const ci = Math.floor((h.x + half) / LC), cj = Math.floor((h.z + half) / LC);
    let took = 0;
    // (the search resumes where it stopped: land nearer was taken; every 10 steps it starts over, as land
    // falls free when households die out)
    if (step % 10 === 0) h.ri = 0;
    for (; h.ri < farmRing.length; h.ri++){
      if (h.cap * yf >= target || took > 40) break;
      const [a, b] = farmRing[h.ri];
      const i = ci + a, j = cj + b;
      if (i < 0 || j < 0 || i >= lres || j >= lres) continue;
      const c = j * lres + i;
      if (lfarm[c] >= 0 || lfert[c] < 0.08 || (ltag[c] >= 0 && ltag[c] !== h.tag)) continue;
      lfarm[c] = h.id; h.cells.push(c); h.cap += lfert[c]; farmEv.push(c, fr(step), 1); took++;
    }
  }
  const freeLandNear = (x, z, r) => {
    const ci = Math.floor((x + half) / LC), cj = Math.floor((z + half) / LC), n = Math.ceil(r / LC);
    let f = 0;
    for (let b = -n; b <= n; b += 2) for (let a = -n; a <= n; a += 2){
      const i = ci + a, j = cj + b;
      if (i < 0 || j < 0 || i >= lres || j >= lres) continue;
      const c = j * lres + i;
      if (lfarm[c] < 0 && lfert[c] >= 0.15) f += lfert[c];
    }
    return f * 4;                                               // (every other cell sampled)
  };
  // a spot near (x, z) between rMin and rMax: the best of a few tries by fertility and water nearby
  function site(a, x, z, rMin, rMax, tries, needFree){
    let best = null, bs = -1;
    for (let t = 0; t < tries; t++){
      const ang = chance(a, 4) * 6.2832, d = rMin + (rMax - rMin) * Math.sqrt(chance(a, 5));
      const px = x + Math.cos(ang) * d, pz = z + Math.sin(ang) * d;
      if (Math.abs(px) > half - 200 || Math.abs(pz) > half - 200 || !buildable(px, pz)) continue;
      const c = landAt(px, pz);
      let s = lfert[c] * (0.5 + lwater[c]);
      if (needFree) s *= freeLandNear(px, pz, 900) / 50;
      if (s > bs){ bs = s; best = [px, pz]; }
    }
    return bs > 0.02 ? best : null;
  }

  // ---- start: forager bands over the land, more where wild food is rich ----
  {
    const n = Math.max(1, Math.round(landKm2 / 100 * startDensity / BAND));
    let total = 0; const cum = new Float64Array(LN);
    for (let c = 0; c < LN; c++){ total += lwild[c]; cum[c] = total; }
    for (let k = 0; k < n && total > 0; k++){
      const u = rnd(h2(k, 1, S), 1) * total;
      let lo = 0, hi = LN - 1;
      while (lo < hi){ const mid = (lo + hi) >> 1; if (cum[mid] < u) lo = mid + 1; else hi = mid; }
      const x = lx(lo % lres) + (rnd(h2(k, 2, S), 1) - 0.5) * LC, z = lx((lo / lres) | 0) + (rnd(h2(k, 3, S), 1) - 0.5) * LC;
      newHousehold(x, z, BAND * (0.7 + 0.6 * rnd(h2(k, 4, S), 1)), 0.15 + 0.7 * rnd(h2(k, 5, S), 1), 0, FORAGER, 0);
    }
  }
  // forager occupancy and wild food on a coarse grid (4 km)
  const FCm = 4000, fres = Math.ceil(w.size / FCm), fcap = new Float32Array(fres * fres), focc = new Float32Array(fres * fres);
  for (let c = 0; c < LN; c++){
    const i = Math.floor((lx(c % lres) + half) / FCm), j = Math.floor((lx((c / lres) | 0) + half) / FCm);
    fcap[j * fres + i] += lwild[c] * WILD * cellKm2;
  }
  const fAt = (x, z) => Math.min(fres - 1, Math.max(0, Math.floor((z + half) / FCm))) * fres + Math.min(fres - 1, Math.max(0, Math.floor((x + half) / FCm)));
  lap('start');

  const farmingBit = bit('farming'), wheelBit = bit('wheel');
  for (let step = 1; step <= steps; step++){
    // -- settlements: farmers' surplus (feeds crafts people), people and knowledge per settlement --
    for (const s of T){ s.cap = 0; s.crafts = 0; s.pop = 0; s.hh = 0; s.kc = s.kc || new Float32Array(TECH.length); s.kc.fill(0); }
    focc.fill(0);
    for (const h of H){
      if (!h.alive) continue;
      if (h.mode === FORAGER){ focc[fAt(h.x, h.z)] += h.people; continue; }
      const s = T[h.tag];
      s.pop += h.people; s.hh++;
      if (h.mode === FARMER){ h.food = h.cap * YIELD * yieldOf(h.know) * cellKm2; s.cap += Math.max(0, h.food - h.people); }
      else s.crafts += h.people;
      for (let t = 0; t < TECH.length; t++) if (h.know & (1 << t)) s.kc[t]++;
    }
    // contact between settlements: knowledge exposure from the others nearby (bigger and nearer count more)
    const live = T.filter((s) => s.nb > 0);
    const tb = new Map(), TB = 12000;
    for (const s of live){ s.cx = s.core[0]; s.cz = s.core[1]; addTo(tb, key(Math.floor(s.cx / TB), Math.floor(s.cz / TB)), s); }
    for (const s of live){
      s.ext = s.ext || new Float32Array(TECH.length); s.ext.fill(0);
      const range = (s.kc[TECH.findIndex((t) => t.key === 'wheel')] > 0 ? 9000 : 5000);
      const ci = Math.floor(s.cx / TB), cj = Math.floor(s.cz / TB);
      for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) for (const u of tb.get(key(ci + a, cj + b)) || []){
        if (u === s || !u.hh) continue;
        const d = Math.hypot(u.cx - s.cx, u.cz - s.cz), wgt = Math.exp(-d / range) * u.pop / (u.pop + 300);
        if (wgt < 0.01) continue;
        for (let t = 0; t < TECH.length; t++) s.ext[t] += wgt * (shared ? ((u.know >> t) & 1) : u.kc[t] / u.hh);
      }
    }
    lap('settlements');

    // -- households --
    const nH = H.length;
    for (let k = 0; k < nH; k++){
      const h = H[k];
      if (!h.alive) continue;
      const hS = h2(h.id, step, S);
      if (h.mode === FORAGER){
        // move toward richer, emptier wild land; grow up to what it feeds
        const here = fAt(h.x, h.z);
        let bx = h.x, bz = h.z, bs = fcap[here] - focc[here];
        for (let t = 0; t < 4; t++){
          const ang = rnd(hS, 10 + t) * 6.2832, d = 2000 + 5000 * rnd(hS, 20 + t);
          const px = h.x + Math.cos(ang) * d, pz = h.z + Math.sin(ang) * d, c = landAt(px, pz);
          if (c < 0 || lwild[c] <= 0) continue;
          const f = fAt(px, pz), sc = fcap[f] - focc[f] - h.people;
          if (sc > bs){ bs = sc; bx = px; bz = pz; }
        }
        if (bx !== h.x){ focc[here] -= h.people; h.x = bx; h.z = bz; focc[fAt(bx, bz)] += h.people; }
        const f = fAt(h.x, h.z), ratio = fcap[f] / Math.max(1, focc[f]);
        h.people *= Math.exp(STEP_YEARS * (0.006 * Math.min(ratio, 1.2) - 0.004)) * (0.95 + 0.1 * rnd(hS, 1));
        // farming: discovered (on fertile land) or learned from farming settlements nearby
        const c = landAt(h.x, h.z);
        const fert = c >= 0 ? lfert[c] : 0;
        let learn = pace * h.ing * 2 * Math.max(0, fert - 0.25) / TECH[0].difficulty, by = 'discovered';
        let near = 0;
        const ci = Math.floor(h.x / TB), cj = Math.floor(h.z / TB);
        for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) for (const u of tb.get(key(ci + a, cj + b)) || [])
          near += Math.exp(-Math.hypot(u.cx - h.x, u.cz - h.z) / 6000) * u.pop / (u.pop + 100);
        if (rnd(hS, 2) < learn){ h.know |= farmingBit; if (!log.some((e) => e.tech === 0)) log.push({ step: fr(step), tag: -1, tech: 0, text: `Farming is discovered by a band of foragers` }); }
        else if (rnd(hS, 3) < 0.3 * Math.min(1, near)){ h.know |= farmingBit; by = 'learned'; }
        if (h.know & farmingBit){
          // settle: a home on good land near water, within a few km
          const sp = site(h.id * 31 + step, h.x, h.z, 0, 3000, 10, true);
          if (sp){ h.mode = FARMER; build(h, sp[0], sp[1], 0, step); farm(h, h.people * 1.3, step); }
        }
        if (h.mode === FORAGER){
          if (h.people < 4){ h.alive = false; continue; }
          if (h.people > 45){ const p = 15 + 5 * rnd(hS, 4); h.people -= p; newHousehold(h.x + 3000 * (rnd(hS, 5) - 0.5), h.z + 3000 * (rnd(hS, 6) - 0.5), p, inherit(h.ing, h.id), h.know, FORAGER, step, h.id); }
        }
        continue;
      }
      const s = T[h.tag];
      // food: farmers from their fields (taking more land if they can), crafts people from the surplus
      let ratio;
      if (h.mode === FARMER){
        farm(h, h.people * 1.3, step);
        h.food = h.cap * YIELD * yieldOf(h.know) * cellKm2;
        ratio = h.food / h.people;
      } else ratio = s.crafts > 0 ? s.cap / s.crafts : 1;
      h.people *= Math.exp(STEP_YEARS * (0.011 * Math.min(ratio, 1.3) - 0.007)) * (0.95 + 0.1 * rnd(hS, 1));
      // knowledge: discoveries, and learning from the settlement and from settlements in contact
      if (shared) h.know = s.know;
      const spare = h.mode === CRAFTS ? 2 : 0.5 + Math.min(1, Math.max(0, ratio - 1) * 2);
      const size = 1 + 0.5 * Math.log10(1 + s.pop / 100);
      for (let t = 1; t < TECH.length; t++){
        const m = 1 << t, tk = TECH[t];
        if (h.know & m || (h.know & tk.mask) !== tk.mask) continue;
        if (techRes[t] && !(h.res & techRes[t])) continue;
        if (rnd(hS, 40 + t) < pace * h.ing * spare * size / tk.difficulty){
          h.know |= m;
          if (shared) s.know |= m;
          if (!s.found) s.found = 0;
          if (!(s.found & m)){ s.found |= m; log.push({ step: fr(step), tag: s.id, tech: t, text: `${s.name} discovers ${tk.name}` }); }
          continue;
        }
        const inside = shared ? 0 : s.hh > 1 ? s.kc[t] / s.hh : 0;
        if (rnd(hS, 60 + t) < 0.35 * Math.sqrt(inside) + 0.25 * Math.min(1, s.ext ? s.ext[t] : 0)){
          h.know |= m; if (shared) s.know |= m;
        }
      }
      // ingenuity drifts toward the settlement's level, a little up when food is plentiful
      h.ing = Math.min(1, h.ing + 0.02 * (Math.min(ratio, 1.5) - 1));
      // setbacks (fire, plague, raids) strike whole settlements; see below
      if (h.people < 4){ h.alive = false; abandon(h, step); continue; }
      // splitting
      if (h.people > SPLIT){
        const p = 8 + 7 * rnd(hS, 7);
        const nh = newHousehold(h.x, h.z, p, inherit(h.ing, h.id), h.know, FARMER, step, h.id);
        h.people -= p;
        let sp = null;
        if (s.cap - s.crafts > p * 1.2 && s.hh >= 4){
          // crafts people: in the settlement's middle, close together
          const r = 30 + 14 * Math.sqrt(s.nb);
          for (let t = 0; t < 12 && !sp; t++){ const q = site(nh.id * 7 + t, s.core[0], s.core[1], 0, r * (1 + t / 6), 1, false); if (q) sp = q; }
          if (sp){ nh.mode = CRAFTS; build(nh, sp[0], sp[1], 2, step); continue; }
        }
        if (freeLandNear(h.x, h.z, 1500) > p / (YIELD * yieldOf(h.know) * cellKm2) * 1.5) sp = site(nh.id * 11, h.x, h.z, 30, 160, 8, false);
        if (!sp) sp = site(nh.id * 13, h.x, h.z, 700, Math.max(1200, R * 1.8), 14, true);       // a farmstead further out
        if (!sp) sp = site(nh.id * 17, h.x, h.z, 3000, 9000, 16, true);                         // open land further away
        if (sp){ build(nh, sp[0], sp[1], 0, step); farm(nh, nh.people * 1.3, step); }
        else { h.people += p; nh.alive = false; }
      }
    }
    lap('households');
    // setbacks: now and then a settlement loses part of its people
    const hit = new Map();
    for (const s of live) if (rnd(h2(s.id, step, S + 5), 1) < setback) hit.set(s.id, 0.15 + 0.25 * rnd(h2(s.id, step, S + 5), 2));
    if (hit.size) for (const h of H) if (h.alive && h.mode !== FORAGER && hit.has(h.tag)) h.people *= 1 - hit.get(h.tag);
    // land changes hands: every 5 steps, to the tag the buildings around it mostly carry
    if (step % 5 === 0){
      const G = R / 2, inf = new Map();
      for (const h of H){
        if (!h.alive || h.b < 0) continue;
        const k = key(Math.floor(h.x / G), Math.floor(h.z / G));
        let m = inf.get(k); if (!m){ m = new Map(); inf.set(k, m); }
        m.set(h.tag, (m.get(h.tag) || 0) + h.people);
      }
      const sum = new Map();
      const around = (gi, gj) => {
        const k = key(gi, gj); let m = sum.get(k);
        if (m) return m;
        m = new Map();
        for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++){ const q = inf.get(key(gi + a, gj + b)); if (q) for (const [t, v] of q) m.set(t, (m.get(t) || 0) + v); }
        sum.set(k, m); return m;
      };
      const flips = new Map();
      for (const k of inf.keys()){
        const gi = Math.round(k / 1000003), gj = k - gi * 1000003;
        const i0 = Math.max(0, Math.floor((gi * G + half) / LC)), i1 = Math.min(lres - 1, Math.floor(((gi + 1) * G + half) / LC));
        const j0 = Math.max(0, Math.floor((gj * G + half) / LC)), j1 = Math.min(lres - 1, Math.floor(((gj + 1) * G + half) / LC));
        const m = around(gi, gj);
        let dom = -1, dw = 0;
        for (const [t, v] of m) if (v > dw){ dw = v; dom = t; }
        if (dom < 0) continue;
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++){
          const c = j * lres + i, cur = ltag[c];
          if (cur < 0 || cur === dom) continue;
          if (dw > 1.6 * (m.get(cur) || 0)){ setTag(c, dom, step); flips.set(c, dom); }
        }
      }
      // the buildings on land that changed hands go with it (and their households)
      if (flips.size) for (const h of H){
        if (!h.alive || h.b < 0) continue;
        const nt = flips.get(landAt(h.x, h.z));
        if (nt === undefined || nt === h.tag) continue;
        T[h.tag].nb--; T[nt].nb++; B.tag[h.b] = nt; h.tag = nt;
        if (shared){ T[nt].know |= h.know; }
      }
    }
    lap('tags');
    // record the settlements
    for (const s of T){ s.pop = 0; s.sx = 0; s.sz = 0; s.kn = 0; }
    for (const h of H){
      if (!h.alive || h.b < 0) continue;
      const s = T[h.tag];
      s.pop += h.people; s.sx += h.x * h.people; s.sz += h.z * h.people; s.kn |= h.know;
    }
    for (const s of T){
      if (!s.alive) continue;
      if (s.nb <= 0){ s.alive = false; s.died = fr(step); continue; }
      const f = fr(step);
      s.popAt[f] = s.pop; s.xAt[f] = s.pop > 0 ? s.sx / s.pop / 1000 : s.core[0] / 1000; s.zAt[f] = s.pop > 0 ? s.sz / s.pop / 1000 : s.core[1] / 1000;
      s.areaAt[f] = s.cells * cellKm2; s.knowAt[f] = shared ? s.know : s.kn;
      s.x = s.xAt[f]; s.z = s.zAt[f];
    }
    lap('record');
    if (onProgress) onProgress(step / steps, step * STEP_YEARS);
  }

  // ---- roads (stage 1): links between settlements at the end ----
  const router = makeRouter(w);
  const alive = T.filter((s) => s.alive);
  const linked = new Set();
  for (const s of alive){
    if (s.pop < 150) continue;
    const others = alive.filter((t) => t !== s && t.pop >= 80).map((t) => [Math.hypot(t.x - s.x, t.z - s.z), t]).filter((e) => e[0] < 25).sort((a, b) => a[0] - b[0]);
    for (let n = 0; n < Math.min(links, others.length); n++){
      const t = others[n][1], k = Math.min(s.id, t.id) * 1e6 + Math.max(s.id, t.id);
      if (linked.has(k)) continue;
      linked.add(k);
      if (router.link(s.core[0], s.core[1], t.core[0], t.core[1], frames)) s.onRoad = t.onRoad = true;
    }
  }
  const net = router.finish();
  lap('roads');

  // ---- town blocks (64 m) from the buildings standing at the end, for the 3D view (until districts come
  //      from the simulation): crafts buildings make shops and workshops, homes make housing ----
  const BS = 64, BRES = Math.ceil(w.size / BS), bmap = new Map();
  const nb = B.x.length;
  for (let id = 0; id < nb; id++){
    if (B.died[id]) continue;
    const i = Math.floor((B.x[id] + half) / BS), j = Math.floor((B.z[id] + half) / BS), k = j * BRES + i;
    let e = bmap.get(k); if (!e){ e = { i, j, crafts: 0, homes: 0, tag: B.tag[id], born: B.born[id], mason: 0 }; bmap.set(k, e); }
    if (B.kind[id] === 2) e.crafts++; else e.homes++;
    e.born = Math.min(e.born, B.born[id]);
    if (H[B.hh[id]].know & bit('masonry')) e.mason = 1;
  }
  const be = [...bmap.values()], bn = be.length;
  const blocks = { size: BS, res: BRES, half, from: frames, n: bn, i: new Int32Array(bn), j: new Int32Array(bn), owner: new Int32Array(bn),
    born: new Int16Array(bn), snap: [new Uint8Array(bn)], evB: new Int32Array(0), evS: new Int16Array(0) };
  be.forEach((e, q) => {
    blocks.i[q] = e.i; blocks.j[q] = e.j; blocks.owner[q] = e.tag; blocks.born[q] = e.born;
    const zone = e.crafts > e.homes ? 2 : 1, st = zone === 2 ? 2 + e.mason : 1 + e.mason;
    blocks.snap[0][q] = zone << 6 | st;
  });
  // farmland at the end, in the shape the 3D view reads (land use per plot)
  const owner = new Int32Array(LN);
  for (let c = 0; c < LN; c++) owner[c] = lfarm[c] >= 0 ? H[lfarm[c]].tag : -1;
  lap('blocks');

  const buildings = { n: nb, x: Float32Array.from(B.x), z: Float32Array.from(B.z), kind: Uint8Array.from(B.kind), tag: Int32Array.from(B.tag),
    born: Int16Array.from(B.born), died: Int16Array.from(B.died) };
  for (const s of T){ delete s.kc; delete s.ext; delete s.cx; delete s.cz; delete s.sx; delete s.sz; delete s.kn; delete s.hh; delete s.found; }
  const aliveN = alive.length;
  return {
    version: 2, steps: frames, year, stepYears: rec * STEP_YEARS, ages: [{ name: 'Simulation', from: 0, steps: frames, years: rec * STEP_YEARS }],
    settlements: T, alive: aliveN, biggest: alive.reduce((m, s) => Math.max(m, s.pop), 0), landKm2,
    people: H.reduce((a, h) => a + (h.alive ? h.people : 0), 0),
    buildings, land: { res: lres, cell: LC, half, tagEv: Int32Array.from(tagEv), farmEv: Int32Array.from(farmEv) },
    log, eras: T.map((s) => eraOf(s.knowAt[s.died || frames])),
    farms: { res: lres, cell: LC, owner, since: new Int16Array(LN), until: new Int16Array(LN), half },
    centres: [], roads: net.roads, roadGrid: net.roadGrid, blocks,
    ms: performance.now() - t0, times };
}
