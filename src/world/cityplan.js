import { SEED, h2, hf, rnd } from './hash.js';

/* ---------------- The city plan ----------------
   Lots sit on a 44 m grid: a 34 m square of ground with a 10 m road on every side. Each road segment
   between two neighbouring lots is either kept as a street or filled in, joining the two lots into one
   block, so blocks come out as bars, L shapes and bigger clumps. The chance of filling in follows smooth
   noise: mostly small blocks, with some districts of huge ones. Then:
   - dead ends: an intersection left with only one open street either closes that stub or carries the
     street on straight (a few cul-de-sacs are kept);
   - closed-off loops of street are joined to the rest of the network (a few are kept);
   - buildings fill their lots: behind the sidewalk on street sides, and across a filled-in segment
     either meeting the neighbour's building or leaving a 4 m alley (seeded per segment).
   Computed once here; the map repeats every 256 lots (~11 km). The shader reads it from a texture. */
export const CITY_N = 256;
function smooth01(a, b, x){ const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); }
export const city = (() => {
  const N = CITY_N, M = N - 1;
  const L = (x, z) => ((z & M) * N) + (x & M);
  const mE = new Uint8Array(N * N), mN = new Uint8Array(N * N), lockE = new Uint8Array(N * N);
  // merge chance from smooth noise that wraps with the map
  const G = 8, NG = N / G;
  const gv = (i, j) => hf(h2(((i % NG) + NG) % NG, ((j % NG) + NG) % NG, (SEED ^ 0x77A1) >>> 0));
  const noise = (x, z) => {
    const fx = x / G, fz = z / G, i = Math.floor(fx), j = Math.floor(fz);
    let u = fx - i, v = fz - j; u = u * u * (3 - 2 * u); v = v * v * (3 - 2 * v);
    return (gv(i, j) * (1 - u) + gv(i + 1, j) * u) * (1 - v) + (gv(i, j + 1) * (1 - u) + gv(i + 1, j + 1) * u) * v;
  };
  const pM = new Float32Array(N * N);
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) pM[L(x, z)] = 0.3 + 0.6 * smooth01(0.62, 0.9, noise(x + 0.5, z + 0.5));
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++){
    const i = L(x, z);
    mE[i] = hf(h2(x, z, (SEED ^ 0x3E01) >>> 0)) < 0.5 * (pM[i] + pM[L(x + 1, z)]) ? 1 : 0;
    mN[i] = hf(h2(x, z, (SEED ^ 0x3E02) >>> 0)) < 0.5 * (pM[i] + pM[L(x, z + 1)]) ? 1 : 0;
  }
  // the starting point stands on a north-south street at x = 0: keep it open
  for (let j = -4; j < 4; j++){ mE[L(-1, j)] = 0; lockE[L(-1, j)] = 1; }
  // the four road segments meeting at intersection (i, j) (the lot (i, j)'s south-west corner): N, S, E, W
  const arms = (i, j) => [[mE, L(i - 1, j)], [mE, L(i - 1, j - 1)], [mN, L(i, j - 1)], [mN, L(i - 1, j - 1)]];
  const OPP = [1, 0, 3, 2], STEP = [[0, 1], [0, -1], [1, 0], [-1, 0]];
  const openCount = (i, j) => { let o = 0; for (const [a, ix] of arms(i, j)) if (!a[ix]) o++; return o; };
  // 1. dead ends
  for (let pass = 0; pass < 100; pass++){
    let changed = 0;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++){
      const a = arms(i, j); let o = 0, k = -1;
      for (let q = 0; q < 4; q++) if (!a[q][0][a[q][1]]){ o++; k = q; }
      if (o !== 1) continue;
      const hn = h2(i, j, (SEED ^ 0xDE4D) >>> 0);
      if (hf(hn) < 0.04) continue;                                   // a rare cul-de-sac
      const [arr, ix] = a[k], [oarr, oix] = a[OPP[k]];
      const locked = arr === mE && lockE[ix];
      if (!locked && rnd(hn, pass + 1) < 0.5) arr[ix] = 1; else oarr[oix] = 0;
      changed++;
    }
    if (!changed) break;
  }
  // 2. closed-off street networks: join each to the main one along the shortest way through the blocks
  const comp = new Int32Array(N * N), seen = new Int32Array(N * N), prev = new Int32Array(N * N), prevQ = new Int8Array(N * N);
  const queue = new Int32Array(N * N); let stamp = 0;
  for (let iter = 0; iter < 8; iter++){
    comp.fill(-1); const sizes = [], firsts = [];
    for (let n0 = 0; n0 < N * N; n0++){
      if (comp[n0] >= 0 || openCount(n0 & M, n0 >> 8) === 0) continue;
      const c = sizes.length; let qh = 0, qt = 0; queue[qt++] = n0; comp[n0] = c;
      while (qh < qt){
        const n = queue[qh++], i = n & M, j = n >> 8, a = arms(i, j);
        for (let q = 0; q < 4; q++){ if (a[q][0][a[q][1]]) continue; const m = L(i + STEP[q][0], j + STEP[q][1]); if (comp[m] < 0){ comp[m] = c; queue[qt++] = m; } }
      }
      sizes.push(qt); firsts.push(n0);
    }
    let big = 0; for (let c = 1; c < sizes.length; c++) if (sizes[c] > sizes[big]) big = c;
    let joined = 0;
    for (let c = 0; c < sizes.length; c++){
      if (c === big || hf(h2(firsts[c] & M, firsts[c] >> 8, (SEED ^ 0xC0A1) >>> 0)) < 0.03) continue;   // a few stay closed
      stamp++; let qh = 0, qt = 0;
      for (let n = 0; n < N * N; n++) if (comp[n] === c){ queue[qt++] = n; seen[n] = stamp; prev[n] = -1; }
      let hitN = -1;
      while (qh < qt && hitN < 0){
        const n = queue[qh++], i = n & M, j = n >> 8;
        for (let q = 0; q < 4; q++){
          const m = L(i + STEP[q][0], j + STEP[q][1]);
          if (seen[m] === stamp) continue;
          seen[m] = stamp; prev[m] = n; prevQ[m] = q; queue[qt++] = m;
          if (comp[m] === big){ hitN = m; break; }
        }
      }
      for (let m = hitN; m >= 0 && prev[m] >= 0; m = prev[m]){
        const n = prev[m], [arr, ix] = arms(n & M, n >> 8)[prevQ[m]]; arr[ix] = 0;
        if (comp[m] !== big) comp[m] = big;
      }
      for (let n = 0; n < N * N; n++) if (comp[n] === c) comp[n] = big;
      joined++;
    }
    if (!joined) break;
  }
  // 3. buildings, sidewalks and street lights, 4 texels per lot:
  //    0: footprint (x0, z0, x1, z1) of the building, or of the podium under a tower (lot-local metres)
  //    1: building/tower centre and half sizes; 2: height, podium height, kind, variation; 3: flags, lamp
  //    4: door position along the W, E, S, N walls (999 = none); 5: door codes (type, variety, colour, double, transom)
  const data = new Float32Array(N * N * 24);
  const alley = (x, z, s) => hf(h2(x, z, (SEED ^ s) >>> 0)) < 0.35;
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++){
    const i = L(x, z), o = (z * N * 6 + x * 6) * 4;
    data[o + 16] = data[o + 17] = data[o + 18] = data[o + 19] = 999;
    const mW = mE[L(x - 1, z)], mEe = mE[i], mS = mN[L(x, z - 1)], mNn = mN[i];
    // a lot's corner piece of an intersection square belongs to the block only when that intersection is
    // fully inside the block (all four segments filled in); otherwise it is road
    const inSW = openCount(x, z) === 0, inSE = openCount(x + 1, z) === 0, inNW = openCount(x, z + 1) === 0, inNE = openCount(x + 1, z + 1) === 0;
    const flags = (mW ? 1 : 0) | (mEe ? 2 : 0) | (mS ? 4 : 0) | (mNn ? 8 : 0)
                | (mW && mS && inSW ? 16 : 0) | (mEe && mS && inSE ? 32 : 0) | (mW && mNn && inNW ? 64 : 0) | (mEe && mNn && inNE ? 128 : 0);
    // street light at intersection (x, z): the seed picks a corner and which open street its arm reaches over
    const a = arms(x, z), open = a.map(([arr, ix]) => !arr[ix]);
    const valid = [];
    for (let c = 0; c < 8; c++){
      const sx = (c & 1) ? 1 : -1, sz = (c & 2) ? 1 : -1;
      if ((c & 4) === 0 ? open[sz > 0 ? 0 : 1] : open[sx > 0 ? 2 : 3]) valid.push(c);
    }
    const lamp = valid.length ? valid[h2(x, z, (SEED ^ 0x1A3B) >>> 0) % valid.length] + 1 : 0;
    data[o + 12] = flags; data[o + 13] = lamp;
    const h = h2(x, z, SEED), r = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(k => rnd(h, k));
    data[o + 11] = r[7];
    if (r[1] < 0.08){ data[o + 10] = -1; continue; }                    // an open plaza
    // A building reaching across two joined sides would fill a corner that is road: it pulls back on one
    // of the two sides (seeded) to stand behind the sidewalk there.
    const bx = [mW, mEe, mS, mNn];                                   // building reaches across: W, E, S, N
    for (const [a, b2, inside, k] of [[0, 2, inSW, 0], [1, 2, inSE, 1], [0, 3, inNW, 2], [1, 3, inNE, 3]])
      if (bx[a] && bx[b2] && !inside) bx[rnd(h, 30 + k) < 0.5 ? a : b2] = 0;
    const ext = (m, al, k) => m ? (al ? 20 : 22) : 14 - (rnd(h, 10 + k) < 0.25 ? rnd(h, 20 + k) * 3 : 0);
    const x0 = -ext(bx[0], alley(x - 1, z, 0xA11E), 0), x1 = ext(bx[1], alley(x, z, 0xA11E), 1);
    const z0 = -ext(bx[2], alley(x, z - 1, 0xA11F), 2), z1 = ext(bx[3], alley(x, z, 0xA11F), 3);
    const rcx = 0.5 * (x0 + x1), rcz = 0.5 * (z0 + z1), rhx = 0.5 * (x1 - x0), rhz = 0.5 * (z1 - z0);
    const xw = x >= N / 2 ? x - N : x, zw = z >= N / 2 ? z - N : z;
    const dist = Math.hypot(xw + 0.5, zw + 0.5);
    let kind, bh, podH = 0, cx = rcx, cz = rcz, hx = rhx, hz = rhz;
    if (r[2] < 0.36){ kind = 0; bh = (3 + Math.floor(r[5] * 7)) * 3.2; }
    else if (r[2] < 0.68){ kind = 1; bh = (5 + Math.floor(r[5] * 14)) * 3.2; }
    else {
      kind = 2; let fl = 12 + Math.floor(r[5] * r[5] * 30);
      fl = Math.floor(fl * (1 + (0.45 - 1) * smooth01(0, 1, (dist - 10) / 20))); bh = fl * 3.2; podH = 6.4;
      hx = Math.min(7 + r[3] * 5, rhx - 1.5); hz = Math.min(7 + r[4] * 5, rhz - 1.5);
      cx = rcx + (rhx - 1.5 - hx) * (r[6] * 2 - 1); cz = rcz + (rhz - 1.5 - hz) * (r[8] * 2 - 1);
    }
    data.set([x0, z0, x1, z1, cx, cz, hx, hz, bh, podH, kind], o);
    // Doors: each wall facing an open street, 90% of the time, kept 2.2 m from the corners. The type mostly
    // suits the building: brick mostly wood, concrete metal or glass, tower podiums mostly glass.
    // code = type (0 wood, 1 glass, 2 metal) x 64 + variety x 16 + colour x 4 + double x 2 + transom
    const faces = [[mW, z0, z1], [mEe, z0, z1], [mS, x0, x1], [mNn, x0, x1]];
    const tp = kind === 0 ? [0.6, 0.15] : kind === 1 ? [0.2, 0.4] : [0.05, 0.75];
    for (let k = 0; k < 4; k++){
      const [mg, lo, hi] = faces[k], hd = h2(x * 4 + k, z, (SEED ^ 0xD00B) >>> 0);
      if (mg || hi - lo < 5.5 || rnd(hd, 0) > 0.9) continue;
      const t = rnd(hd, 2), type = t < tp[0] ? 0 : t < tp[0] + tp[1] ? 1 : 2;
      const dbl = rnd(hd, 3) < [0.25, 0.55, 0.3][type] ? 1 : 0, tr = rnd(hd, 4) < [0.45, 0.3, 0.12][type] ? 1 : 0;
      data[o + 16 + k] = lo + 2.2 + rnd(hd, 1) * (hi - lo - 4.4);
      data[o + 20 + k] = type * 64 + Math.floor(rnd(hd, 5) * 4) * 16 + Math.floor(rnd(hd, 6) * 4) * 4 + dbl * 2 + tr;
    }
  }
  return { N, data, L };
})();
export function getBld(cx, cz){
  const o = (((cz & (CITY_N - 1)) * CITY_N * 6) + (cx & (CITY_N - 1)) * 6) * 4, d = city.data;
  return { x0: d[o], z0: d[o + 1], x1: d[o + 2], z1: d[o + 3], cx: d[o + 4], cz: d[o + 5], hx: d[o + 6], hz: d[o + 7],
           h: d[o + 8], podH: d[o + 9], kind: d[o + 10], flags: d[o + 12], lamp: d[o + 13],
           doorPos: [d[o + 16], d[o + 17], d[o + 18], d[o + 19]], doorCode: [d[o + 20], d[o + 21], d[o + 22], d[o + 23]] };
}
// Sidewalk slab of a lot, as up to six boxes (x0, z0, x1, z1 in lot-local metres): the 34 m square, a 5 m strip
// out to the lot edge on each joined side, and a 5 m corner square where the intersection is inside the block.
export function slabBoxesJS(f){
  const bs = [[-17, -17, 17, 17]];
  if (f & 1) bs.push([-22, -17, -17, 17]); if (f & 2) bs.push([17, -17, 22, 17]);
  if (f & 4) bs.push([-17, -22, 17, -17]); if (f & 8) bs.push([-17, 17, 17, 22]);
  if (f & 16) bs.push([-22, -22, -17, -17]); if (f & 32) bs.push([17, -22, 22, -17]);
  if (f & 64) bs.push([-22, 17, -17, 22]); if (f & 128) bs.push([17, 17, 22, 22]);
  return bs;
}
