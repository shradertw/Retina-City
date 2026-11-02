/* Road routing over the land: the cheapest route on a grid of at least 64 m (heights averaged; a cell is
   water if most of it is sea or lake, and a river cell if a river runs through it). Slopes cost more, rivers
   need a bridge (4x), lakes and sea cannot be crossed, and an existing road is much cheaper to follow, so
   routes bundle into main roads. Used by the history simulation (src/gen/sim.js). */

/** @param {import('./world.js').World} w */
export function makeRouter(w){
  const { res, cell, half } = w;
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
  /** routing cell of world point (x, z) in metres */
  const at = (x, z) => {
    const i = Math.min(rres - 1, Math.max(0, Math.floor((x + half) / rcell))), j = Math.min(rres - 1, Math.max(0, Math.floor((z + half) / rcell)));
    return j * rres + i;
  };
  const road = new Uint16Array(RN), since = new Int16Array(RN);     // routes sharing each cell; step it was built
  const paths = [];
  const gScore = new Float32Array(RN), from = new Int32Array(RN), stamp = new Int32Array(RN), heap = new Heap(RN * 2);
  let search = 0;
  const DI = [1, -1, 0, 0, 1, 1, -1, -1], DJ = [0, 0, 1, -1, 1, -1, 1, -1];
  /** least-cost route from cell a to cell goal (A*, within a box around them) @returns {number[] | null} */
  function route(a, goal){
    search++;
    const ai = a % rres, aj = (a / rres) | 0, gi = goal % rres, gj = (goal / rres) | 0;
    const m = Math.max(20, Math.round(0.3 * Math.hypot(gi - ai, gj - aj)));
    const i0 = Math.max(0, Math.min(ai, gi) - m), i1 = Math.min(rres - 1, Math.max(ai, gi) + m);
    const j0 = Math.max(0, Math.min(aj, gj) - m), j1 = Math.min(rres - 1, Math.max(aj, gj) + m);
    heap.size = 0;
    gScore[a] = 0; from[a] = -1; stamp[a] = search; heap.push(a, 0);
    while (heap.size){
      const k = heap.pop(), g = gScore[k];
      if (k === goal){ const path = []; for (let c = k; c >= 0; c = from[c]) path.push(c); return path; }
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
        heap.push(n, ng + 0.4 * rcell * Math.hypot(ni - gi, nj - gj));
      }
    }
    return null;
  }
  /** route between two world points and keep it as a road built at step */
  function link(ax, az, bx, bz, step, kind = 'road'){
    const p = route(at(ax, az), at(bx, bz));
    if (!p || p.length < 2) return false;
    for (const k of p){ if (!road[k]) since[k] = step; road[k] = Math.min(65535, road[k] + 1); }
    paths.push({ cells: Int32Array.from(p), step, kind });
    return true;
  }
  /** the roads as world polylines (smoothed), each with its class from how many routes share it:
   *  0 track, 1 road, 2 main road */
  function finish(){
    for (const r of paths){
      let use = 0;
      const pts = new Float32Array(r.cells.length * 2);
      r.cells.forEach((k, n) => { pts[2 * n] = -half + ((k % rres) + 0.5) * rcell; pts[2 * n + 1] = -half + (((k / rres) | 0) + 0.5) * rcell; use = Math.max(use, road[k]); });
      for (let pass = 0; pass < 3; pass++){
        const q = pts.slice();
        for (let n = 1; n < r.cells.length - 1; n++){
          q[2 * n] = 0.25 * pts[2 * n - 2] + 0.5 * pts[2 * n] + 0.25 * pts[2 * n + 2];
          q[2 * n + 1] = 0.25 * pts[2 * n - 1] + 0.5 * pts[2 * n + 1] + 0.25 * pts[2 * n + 3];
        }
        pts.set(q);
      }
      r.pts = pts; r.use = use; r.cls = r.kind === 'track' && use < 3 ? 0 : use >= 6 ? 2 : 1;
    }
    return { roads: paths, roadGrid: { res: rres, cell: rcell, use: road, since } };
  }
  return { at, route, link, finish, rres, rcell, road };
}

// a binary heap of cell indices by a float priority (smallest first)
export class Heap {
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
