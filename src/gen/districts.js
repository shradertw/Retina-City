/* Districts and density (ages 4 and 5, step 4d). Towns are managed as blocks of BLOCK metres on one grid
   over the world. A block has a district (housing, shops and offices, or industry), a number of storeys and
   the year it was (last) built; how much floor it holds follows from those.

   Start (year 650)  every town gets the blocks its floor space needs, nearest its middle first: shops and
                     offices in the middle, some industry where it suits (edge, water, roads), housing the rest.
                     A block's build year comes from the town's own growth: the year the town first reached it.
   Demand            each step a town's people need floor: homes (more per person as the years pass), shops and
                     offices and workshops for the jobs (0.45 per person; the industry share is a setting and
                     falls after year 800).
   Out or up         when a district is short of floor, part of the shortfall is built upward (more in bigger
                     towns; least for industry, most for housing) by rebuilding the most central blocks taller,
                     and the rest outward, on free land next to the town, chosen by what suits that district.
   Storeys           a rebuilt block gets more storeys the more central it is, up to a limit that grows with
                     the era and the town's size. Housing near industry counts as more central (the jobs).
   Renewal           blocks over 60 years old are sometimes rebuilt in the style of the day; after year 780,
                     industry inside a town sometimes turns into housing or offices.
   Farms             farmland under a new block is lost (the history keeps when).
   For the map, the state of every block is kept at every step: district << 6 | storeys (0 = nothing). */
import { h2, rnd } from '../world/hash.js';
import { chamfer } from './world.js';

export const BLOCK = 64;
export const ZONES = ['', 'housing', 'shops and offices', 'industry'];
const RES = 1, COM = 2, IND = 3, DI = [1, -1, 0, 0], DJ = [0, 0, 1, -1];
const BUILD = BLOCK * BLOCK * 0.7;                      // buildable m2 of a block (the rest is streets)
const COVER = [0, 0.3, 0.55, 0.5];                      // share of that built over, by district
const floorOf = (z, st) => BUILD * COVER[z] * st;
const lerpT = (pts, x) => {
  if (x <= pts[0][0]) return pts[0][1];
  for (let n = 1; n < pts.length; n++) if (x <= pts[n][0]){ const [a, va] = pts[n - 1], [b, vb] = pts[n]; return va + (vb - va) * (x - a) / (b - a); }
  return pts[pts.length - 1][1];
};
// the most storeys anyone builds, by year
const ERA_CAP = [[650, 4], [720, 6], [780, 10], [820, 20], [900, 40]];

/**
 * @param {{ w: any, list: any[], o: Record<string, number>, year: Int16Array, S: number, slope: Float32Array,
 *   dFresh: Float32Array, dSea: Float32Array, road: Uint16Array, rres: number, rcell: number, atR: (x: number, z: number) => number,
 *   roadDist: () => Float32Array, clearFarm: (x: number, z: number, step: number) => void, radiusKm: (p: number) => number, steps: number, from: number }} c
 */
export function makeDistricts(c){
  const { w, list, o, year, S } = c, half = w.half, BRES = Math.ceil(w.size / BLOCK);
  const indShare0 = (o.industry ?? 30) / 100, upK = (o.up ?? 100) / 100, renew = (o.renew ?? 100) / 100;
  // blocks (grown as needed)
  let n = 0, cap = 4096;
  let bi = new Int32Array(cap), bj = new Int32Array(cap), own = new Int32Array(cap), zone = new Uint8Array(cap);
  let st = new Uint8Array(cap), born = new Int16Array(cap), built = new Int16Array(cap);
  let inner = new Uint8Array(cap);                            // 1: no free land next to it (stays so)
  const grow = () => {
    cap *= 2;
    const g = (a) => { const b = new a.constructor(cap); b.set(a); return b; };
    bi = g(bi); bj = g(bj); own = g(own); zone = g(zone); st = g(st); born = g(born); built = g(built); inner = g(inner);
  };
  const at = new Map();                                       // j * BRES + i -> block
  const evB = [], evS = [], snap = [];
  const cx = (i) => -half + (i + 0.5) * BLOCK;               // block centre, metres
  const usable = (i, j) => {
    if (i < 0 || j < 0 || i >= BRES || j >= BRES || at.has(j * BRES + i)) return false;
    const k = w.gridIndex(cx(i), cx(j));
    return w.water[k] === 0 && c.slope[k] < 0.25;
  };
  // industrial blocks counted per 4 x 4 blocks (kept up to date as blocks change), for housing near industry
  let mainDist = null;
  const HC = 4, HR = Math.ceil(BRES / HC), indHeat = new Uint16Array(HR * HR);
  const heat = (b, d) => { indHeat[Math.floor(bj[b] / HC) * HR + Math.floor(bi[b] / HC)] += d; };
  const indNear = (i, j) => {
    const hi = Math.floor(i / HC), hj = Math.floor(j / HC);
    let s = 0;
    for (let b = Math.max(0, hj - 1); b <= Math.min(HR - 1, hj + 1); b++) for (let a = Math.max(0, hi - 1); a <= Math.min(HR - 1, hi + 1); a++) s += indHeat[b * HR + a];
    return Math.min(1, s / 12);
  };
  const extent = (s) => Math.max(120, Math.sqrt(s.nb * BLOCK * BLOCK / Math.PI));   // metres
  const cap4 = (s, y) => Math.max(1, Math.min(lerpT(ERA_CAP, y), 2 + s.pop / 3000));
  // how central a block counts for a district (0-1)
  function value(s, b, z){
    const d = Math.hypot(cx(bi[b]) - s.x * 1000, cx(bj[b]) - s.z * 1000), R = extent(s);
    if (z === COM) return Math.exp(-d / (0.45 * R));
    if (z === RES) return Math.min(1, 0.8 * Math.exp(-d / (0.6 * R)) + 0.35 * indNear(bi[b], bj[b]));
    return 0.25;
  }
  const target = (s, b, z, y) => Math.max(1, Math.round(1 + (cap4(s, y) - 1) * Math.pow(value(s, b, z), 2)));
  // storeys of a new block
  const st0 = (z, y, h) => z === IND ? 1 + (rnd(h, 1) < 0.3 ? 1 : 0) : z === COM ? 2 + (rnd(h, 1) < 0.4 ? 1 : 0) : y < 740 ? 1 + (rnd(h, 1) < 0.5 ? 1 : 0) : 2 + (rnd(h, 1) < 0.3 ? 1 : 0);
  const indShare = (s, y) => indShare0 * (y < 800 ? 1 : 1 - 0.4 * (y - 800) / 100) * s.pop / (s.pop + 1500);
  function demand(s, y){
    const t = Math.min(1, Math.max(0, (y - 650) / 250)), jobs = s.pop * 0.45, ind = indShare(s, y);
    return [0, s.pop * (22 + 18 * t), jobs * (1 - ind) * (18 + 7 * t), jobs * ind * (45 + 25 * t)];
  }
  function place(s, i, j, z, storeys, b0, step){
    if (n >= cap) grow();
    const b = n++;
    bi[b] = i; bj[b] = j; own[b] = s.id; zone[b] = z; st[b] = storeys; born[b] = b0; built[b] = b0;
    at.set(j * BRES + i, b); s.blocks.push(b); s.nb++; s.floor[z] += floorOf(z, storeys);
    if (z === IND) heat(b, 1);
    c.clearFarm(cx(i), cx(j), step);
    return b;
  }
  function rebuild(s, b, z, storeys, step){
    s.floor[zone[b]] -= floorOf(zone[b], st[b]);
    if (zone[b] === IND) heat(b, -1);
    if (z === IND) heat(b, 1);
    zone[b] = z; st[b] = Math.min(63, storeys); built[b] = step;
    s.floor[z] += floorOf(z, st[b]);
    evB.push(b); evS.push(step);
  }
  // how well a free block suits a district
  function suit(s, i, j, z, R){
    const x = cx(i), zz = cx(j), d = Math.hypot(x - s.x * 1000, zz - s.z * 1000) / R;
    const k = w.gridIndex(x, zz), r = c.atR(x / 1000, zz / 1000), rd = c.roadDist()[r];
    let same = 0, com = 0, ind = 0;
    for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++){
      const q = at.get((j + b) * BRES + i + a); if (q === undefined || !st[q]) continue;
      if (zone[q] === z) same++; if (zone[q] === COM) com++; if (zone[q] === IND) ind++;
    }
    let v = -d + 0.4 * rnd(h2(i, j, S + z), 1);
    if (z === COM) v += 1.5 * Math.exp(-d / 0.5) + (mainDist && mainDist[r] < 150 ? 0.8 : 0) + 0.15 * same;
    else if (z === IND) v += 1.0 * d + (c.dFresh[k] < 400 || c.dSea[k] < 600 ? 0.7 : 0) + (rd < 200 ? 0.6 : 0) + 0.5 * s.metal + 0.6 * same - 0.6 * com;
    else v += 0.3 * same - 0.25 * ind;
    return v;
  }

  /** year 650: every town gets the blocks its floor space needs */
  function init(step){
    mainDist = chamfer(c.rres, c.rcell, (k) => c.road[k] >= 4);
    const y = year[step], order = list.filter((s) => s.alive).sort((a, b) => b.pop - a.pop);
    for (const s of order){
      s.blocks = []; s.nb = 0; s.floor = [0, 0, 0, 0];
      // industry potential: metal nearby
      let dm = 1e9; for (const m of w.metals) dm = Math.min(dm, Math.hypot(m.x - s.x * 1000, m.z - s.z * 1000));
      s.metal = Math.exp(-dm / 3000);
      const dem = demand(s, y), big = s.pop > 3000 ? 1 : 0;
      const sr = [0, 1 + big, 2 + (s.pop > 8000 ? 1 : 0), 1];
      const need = [0, 0, 0, 0];
      for (let z = 1; z <= 3; z++) need[z] = Math.ceil(dem[z] * 1.05 / floorOf(z, sr[z]));
      if (s.pop < 400) need[IND] = 0;
      const total = need[1] + need[2] + need[3];
      // free land nearest the middle
      const ci = Math.floor((s.x * 1000 + half) / BLOCK), cj = Math.floor((s.z * 1000 + half) / BLOCK);
      const m = Math.ceil(Math.sqrt(total / Math.PI) * 1.6) + 2, cand = [];
      for (let j = cj - m; j <= cj + m; j++) for (let i = ci - m; i <= ci + m; i++)
        if (usable(i, j)) cand.push([Math.hypot(i - ci, j - cj), i, j]);
      cand.sort((a, b) => a[0] - b[0]);
      const take = cand.slice(0, total);
      if (!take.length) continue;
      const dmax = take[take.length - 1][0] + 0.5;
      // when the town first reached each distance (from its growth: the old radius as a share of today's)
      const r0 = c.radiusKm(s.pop), when = (dd) => { for (let t = s.born; t <= step; t++) if (c.radiusKm(s.popAt[t] || 0) >= r0 * dd / dmax) return t; return step; };
      // commerce: the nearest; industry: the best suited of the rest; housing: the others
      const zoneOf = new Uint8Array(take.length).fill(RES);
      for (let q = 0; q < Math.min(need[COM], take.length); q++) zoneOf[q] = COM;
      // industry in one to three clusters, each grown around the best suited spot left
      if (need[IND]){
        const R = dmax * BLOCK, nC = Math.min(3, 1 + Math.floor(need[IND] / 40));
        let left = need[IND];
        for (let cl = 0; cl < nC && left > 0; cl++){
          let best = -1, bv = -1e9;
          for (let q = need[COM]; q < take.length; q++){ if (zoneOf[q] !== RES) continue; const v = suit(s, take[q][1], take[q][2], IND, R); if (v > bv){ bv = v; best = q; } }
          if (best < 0) break;
          const near = [];
          for (let q = need[COM]; q < take.length; q++) if (zoneOf[q] === RES) near.push([Math.hypot(take[q][1] - take[best][1], take[q][2] - take[best][2]), q]);
          near.sort((a, b) => a[0] - b[0]);
          const k = Math.min(near.length, Math.ceil(need[IND] / nC), left);
          for (let q = 0; q < k; q++) zoneOf[near[q][1]] = IND;
          left -= k;
        }
      }
      take.forEach(([dd, i, j], q) => {
        const z = zoneOf[q], h = h2(i, j, S + 77);
        const extra = z === COM && dd < dmax * 0.3 ? 1 : 0;
        place(s, i, j, z, sr[z] + extra + (rnd(h, 2) < 0.2 ? 1 : 0), when(dd), step);
      });
    }
    record(step);
  }

  /** one step of ages 4-5 */
  function step(step){
    const y = year[step];
    if (step % 4 === 0) mainDist = chamfer(c.rres, c.rcell, (k) => c.road[k] >= 4);
    for (const s of list){
      if (!s.alive){
        // gone: its blocks stand empty (merged towns hand theirs over, see merge)
        if (s.blocks && s.blocks.length){ for (const b of s.blocks){ if (zone[b] === IND && st[b]) heat(b, -1); st[b] = 0; } s.blocks = []; s.nb = 0; }
        continue;
      }
      if (!s.blocks){ s.blocks = []; s.nb = 0; s.floor = [0, 0, 0, 0]; s.metal = 0; }
      const dem = demand(s, y), R = extent(s);
      let front = null;
      for (const z of [IND, COM, RES]){
        let short = dem[z] - s.floor[z];
        if (short < 0.3 * floorOf(z, 1)) continue;
        // up: rebuild the most central blocks of this district taller (each town every second step; in
        // between, that share of the shortfall waits for it)
        const f = Math.min(0.85, upK * (R / 1000) / (R / 1000 + 1.2)) * [0, 1, 0.6, 0.15][z];
        const upStep = (step + s.id) % 2 === 0, capNow = Math.round(cap4(s, y));
        let up = upStep ? short * 2 * f : 0;
        if (!upStep) short -= short * f;
        // (a town's blocks are listed roughly from the middle outward: its first blocks were placed nearest
        // the middle, and later ones at its edge)
        if (up > 0) for (const b of s.blocks){
          if (up <= 0) break;
          if (zone[b] !== z || !st[b] || st[b] >= capNow || step - built[b] < 6) continue;
          const t = target(s, b, z, y);
          if (t <= st[b]) continue;
          const gain = floorOf(z, t - st[b]);
          rebuild(s, b, z, t, step); up -= gain; short -= gain;
        }
        // out: new blocks on free land next to the town
        if (short <= 0) continue;
        if (!s.nb){
          const i = Math.floor((s.x * 1000 + half) / BLOCK), j = Math.floor((s.z * 1000 + half) / BLOCK);
          if (usable(i, j)){ place(s, i, j, z, st0(z, y, h2(i, j, S + step)), step, step); short -= floorOf(z, st[n - 1]); }
          if (short <= 0) continue;
        }
        if (!front){
          const seen = new Set(); front = [];
          for (const b of s.blocks){
            if (inner[b]) continue;
            let free = 0;
            for (let q = 0; q < 4; q++){
              const i = bi[b] + DI[q], j = bj[b] + DJ[q], k = j * BRES + i;
              if (seen.has(k)){ free = 1; continue; }
              if (usable(i, j)){ seen.add(k); front.push([i, j]); free = 1; }
            }
            if (!free) inner[b] = 1;
          }
        }
        // scored: all of the free land around, or (big towns) a random share of it, 4 times what is needed
        const want = Math.ceil(short / floorOf(z, 2)) * 4 + 50, every = Math.max(1, Math.floor(front.length / want));
        const sc = [];
        for (let q = (step + s.id) % every; q < front.length; q += every) sc.push([suit(s, front[q][0], front[q][1], z, R), q]);
        sc.sort((a, b) => b[0] - a[0]);
        const usedQ = [];
        for (const [, q] of sc){
          if (short <= 0) break;
          const [i, j] = front[q];
          if (!usable(i, j)) continue;
          const sto = st0(z, y, h2(i, j, S + step));
          place(s, i, j, z, sto, step, step); short -= floorOf(z, sto); usedQ.push(q);
        }
        if (usedQ.length){ const u = new Set(usedQ); front = front.filter((_, q) => !u.has(q)); }
      }
    }
    // renewal: old blocks rebuilt in the style of the day
    // (blocks drawn at random: 2.5% of all of them per step at 100%; the young ones are left)
    const tries = Math.round(n * renew * 0.025);
    for (let q = 0; q < tries; q++){
      const h = h2(q, step, S + 91), b = Math.floor(rnd(h, 1) * n);
      if (!st[b] || step - built[b] < 12) continue;
      const s = list[own[b]];
      if (!s.alive) continue;
      let z = zone[b];
      if (z === IND && y >= 780){
        const d = Math.hypot(cx(bi[b]) - s.x * 1000, cx(bj[b]) - s.z * 1000);
        if (d < 0.6 * extent(s) && rnd(h, 2) < 0.5) z = rnd(h, 3) < 0.6 ? RES : COM;
      }
      const t = target(s, b, z, y);
      rebuild(s, b, z, Math.max(z === zone[b] ? st[b] : 1, Math.round(t * (0.6 + 0.4 * rnd(h, 4)))), step);
    }
    record(step);
  }
  function record(step){
    const v = new Uint8Array(n);
    for (let b = 0; b < n; b++) v[b] = st[b] ? zone[b] << 6 | Math.min(63, st[b]) : 0;
    snap.push(v);
    for (const s of list) if (s.areaAt) s.areaAt[step] = s.alive && s.nb ? s.nb * BLOCK * BLOCK / 1e6 : 0;
  }
  /** settlement small grows into big: its blocks change hands */
  function merge(big, small){
    if (!small.blocks) return;
    if (!big.blocks){ big.blocks = []; big.nb = 0; big.floor = [0, 0, 0, 0]; big.metal = small.metal || 0; }
    for (const b of small.blocks) own[b] = big.id;
    big.blocks.push(...small.blocks); big.nb += small.nb;
    for (let z = 1; z <= 3; z++) big.floor[z] += small.floor[z];
    small.blocks = []; small.nb = 0; small.floor = [0, 0, 0, 0];
  }
  function finish(from){
    for (const s of list){ delete s.blocks; delete s.floor; delete s.nb; delete s.metal; }
    return { size: BLOCK, res: BRES, half, from, n,
      i: bi.slice(0, n), j: bj.slice(0, n), owner: own.slice(0, n), born: born.slice(0, n),
      snap, evB: Int32Array.from(evB), evS: Int16Array.from(evS) };
  }
  return { init, step, merge, finish };
}
