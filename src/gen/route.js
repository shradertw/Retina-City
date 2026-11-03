/* Road routing over the land: the cheapest route on a grid of at least 64 m (heights averaged; a cell is
   water if most of it is sea or lake, and a river cell if a river runs through it). Slopes cost more, rivers
   need a bridge (4x), lakes and sea cannot be crossed, and an existing road is much cheaper to follow, so
   routes bundle into main roads. Used by the history simulation (src/gen/sim.js).
   Road health: every cell of road has a health (1 new or just repaired, 0 gone) and a surface (0 dirt, 1 gravel,
   2 stone setts, 3 asphalt). It wears a little each year on its own (dirt fastest; setts slowest) and more under
   traffic; when worn, the settlement it belongs to repairs it if it has people to do it, and lays the best
   surface it knows; a road nobody uses or repairs keeps wearing until it is gone. See tick(). */
// wear per tick (25 years): on its own, and the most traffic can add (by surface: dirt, gravel, setts, asphalt)
export const WEAR_BASE = [0.12, 0.08, 0.02, 0.05], WEAR_USE = [0.35, 0.25, 0.06, 0.12];
export const REPAIR_AT = 0.5;

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
  const health = new Float32Array(RN), surf = new Uint8Array(RN), owner = new Int32Array(RN).fill(-1), use = new Float32Array(RN);
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
        // (a heuristic above the cheapest cost per metre, 0.35 on roads: the search heads for the goal sooner,
        // at the price of routes that are sometimes a little longer than the best)
        heap.push(n, ng + 0.6 * rcell * Math.hypot(ni - gi, nj - gj));
      }
    }
    return null;
  }
  /** route between two world points and keep it as a road built at step @returns {number} its index or -1 */
  // (s0: the surface its builders lay; own: the settlement that keeps it)
  function link(ax, az, bx, bz, step, kind = 'road', s0 = 0, own = -1){
    const p = route(at(ax, az), at(bx, bz));
    if (!p || p.length < 2) return -1;
    for (const k of p){ if (!road[k]){ since[k] = step; health[k] = 1; surf[k] = s0; owner[k] = own; } road[k] = Math.min(65535, road[k] + 1); }
    paths.push({ cells: Int32Array.from(p), step, kind, traffic: 0, recent: 0, owner: own });
    return paths.length - 1;
  }
  /* One tick of road health (every 25 years). ownerOf(k, path): the settlement keeping cell k (by the land it
     is on, else the path's builder) or null; canRepair(s): it has people to do it; best(s, k): the best surface
     it knows for this road. A gone cell on a road still carrying traffic is laid again. */
  function tick(step, ownerOf, canRepair, best){
    use.fill(0);
    for (const r of paths){ if (r.recent > 0) for (const k of r.cells) use[k] += r.recent; r.recent = 0; }
    let gone = 0;
    for (let k = 0; k < RN; k++){
      if (!road[k] && !(use[k] > 2)) continue;
      const o = ownerOf(k);
      if (!road[k]){
        // a road still used where it had worn away: laid again by those who use it
        if (o && canRepair(o)){ road[k] = 1; since[k] = step; health[k] = 1; surf[k] = best(o, k); }
        continue;
      }
      const u = use[k] / (use[k] + 20), sf = surf[k];
      health[k] -= WEAR_BASE[sf] + WEAR_USE[sf] * u;
      if (health[k] < REPAIR_AT && use[k] > 0.5 && o && canRepair(o)){ health[k] = 1; surf[k] = Math.max(sf, best(o, k)); continue; }
      if (health[k] <= 0){ road[k] = 0; health[k] = 0; gone++; }
    }
    return gone;
  }
  /** the roads as world polylines (smoothed), each with its class: from the traffic each path carries (when
   *  given: summed over the paths sharing each cell; the busiest sixth are main roads), else from how many
   *  routes share it: 0 track, 1 road, 2 main road */
  function finish(){
    const byTraffic = paths.some((r) => r.traffic > 0);
    let cellT = null, mainAt = Infinity;
    if (byTraffic){
      cellT = new Float32Array(RN);
      for (const r of paths) for (const k of r.cells) cellT[k] += r.traffic;
      // main road: the busiest sixth of the road network's cells
      const vals = [];
      for (let k = 0; k < RN; k++) if (road[k]) vals.push(cellT[k]);
      vals.sort((a, b) => a - b);
      mainAt = Math.max(1, vals[Math.floor(vals.length * 5 / 6)] || 1);
    }
    // Each path is cut into runs: a stretch already laid by an earlier path is not laid again (routes that
    // follow existing roads would otherwise lie on top of them), and a run ends where the class changes.
    const clsOf = (r, k) => byTraffic ? (cellT[k] >= mainAt ? 2 : 1) : (r.kind === 'track' && road[k] < 3 ? 0 : road[k] >= 6 ? 2 : 1);
    // health level: 3 good, 2 worn, 1 broken, 0 overgrown
    const lvl = (k) => health[k] >= 0.75 ? 3 : health[k] >= 0.5 ? 2 : health[k] >= 0.25 ? 1 : 0;
    const keyOf = (r, k, k2) => Math.min(clsOf(r, k), clsOf(r, k2)) + 4 * surf[k] + 16 * Math.min(lvl(k), lvl(k2));
    const laid = new Set(), out = [];
    const emit = (r, cells) => {
      const pts = new Float32Array(cells.length * 2);
      cells.forEach((k, n) => { pts[2 * n] = -half + ((k % rres) + 0.5) * rcell; pts[2 * n + 1] = -half + (((k / rres) | 0) + 0.5) * rcell; });
      for (let pass = 0; pass < 3; pass++){
        const q = pts.slice();
        for (let n = 1; n < cells.length - 1; n++){
          q[2 * n] = 0.25 * pts[2 * n - 2] + 0.5 * pts[2 * n] + 0.25 * pts[2 * n + 2];
          q[2 * n + 1] = 0.25 * pts[2 * n - 1] + 0.5 * pts[2 * n + 1] + 0.25 * pts[2 * n + 3];
        }
        pts.set(q);
      }
      const kk = cells.run;
      out.push({ cells: Int32Array.from(cells), pts, step: r.step, kind: r.kind, cls: kk & 3, surf: (kk >> 2) & 3, health: kk >> 4, traffic: r.traffic });
    };
    for (const r of paths){
      let run = [];
      for (let n = 0; n + 1 < r.cells.length; n++){
        const a = r.cells[n], b = r.cells[n + 1], pk = Math.min(a, b) * RN + Math.max(a, b);
        const fresh = !laid.has(pk) && road[a] > 0 && road[b] > 0, cl = fresh ? keyOf(r, a, b) : -1;   // (worn-away cells: a gap)
        if (run.length && (!fresh || cl !== run.run)){ if (run.length > 1) emit(r, run); run = []; }
        if (!fresh) continue;
        laid.add(pk);
        if (!run.length){ run.push(a); run.run = cl; }
        run.push(b);
      }
      if (run.length > 1) emit(r, run);
    }
    paths.length = 0; paths.push(...out);
    return { roads: paths, roadGrid: { res: rres, cell: rcell, use: road, since } };
  }
  return { at, route, link, tick, finish, rres, rcell, road, paths, health, surf, owner };
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
