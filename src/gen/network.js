/* The road network: every road, street, track and footpath of the history (src/gen/sim.js) in one graph of
   nodes (junctions, bends, ends) and straight edges between them. Where two edges cross they meet at a
   junction (the graph stays planar until freeways, which will cross over or under).

   Each edge has a level, a surface, a health and the traffic it carries:
     level     0 footpath, 1 track, 2 street or road, 3 main road, 4 freeway (stage 2); its width comes from it
     surface   0 dirt, 1 gravel, 2 stone setts, 3 asphalt
     health    1 new or just repaired ... 0 gone; it wears on its own and with traffic (src/gen/route.js has the
               rates), and the settlement keeping it repairs it while it has fed people, laying the best
               surface it knows
   Traffic (every 25 years, tick): each town's trips between homes and its market run along the fastest way
   over its streets (a tree from the town's middle), and the trade between towns along the fastest way between
   their middles. Speed comes from level, surface and health, and falls as a road crowds. A road that stays
   crowded is raised a level (and lower roads crowding it beside it are removed to make room); one that stays
   quiet falls a level, down to a footpath, and a footpath nobody uses wears away (a road homes face keeps
   its level: they need it). Main roads keep apart:
   of two running side by side within MAIN_GAP, the quieter one falls back to a street.

   Town streets grow as towns need frontage (grow): along the roads into town first; then side streets
   branch off at about right angles, a block apart, and continue or turn to meet each other, closing blocks.
   Towns whose people plan (planning 0-1) pull every new street onto a grid along the town's axis; others
   follow the lie of their roads. Streets meet at 60 degrees or more.

   Roads between towns (link) are found on the land grid (src/gen/route.js: slopes, rivers, existing roads
   much cheaper) and laid only where no road runs yet: where the route meets the network it follows it. */
import { WEAR_BASE, WEAR_USE, REPAIR_AT } from './route.js';

export const LEVEL_W = [2, 4, 9, 16, 28];       // width (m): footpath, track, street or road, main road, freeway
const SPEED = [4, 10, 25, 45, 90];              // km/h on a good surface, in good repair
const SURF_K = [0.6, 0.8, 0.9, 1];              // dirt, gravel, setts, asphalt
// what a level carries before it crowds: people's trips (or food's worth of trade) per 25 years
export const CAP = [20, 100, 1500, 15000, 150000];
const MAIN_GAP = 300;
const TRADE_K = 0.25;                           // traffic per unit of food traded (a guess: carts carry many people's food)                           // m: main roads side by side closer than this: one falls back
const SNAP = 0.3;                               // a new street ends on a node within this share of a block
const NB = 25, EB = 60;                         // bucket sizes (m): nodes, edges

/** @param {{ landOk: (x: number, z: number) => boolean, rnd: (a: number, k: number) => number,
 *            router: any, tagAt: (x: number, z: number) => number, half: number }} c */
export function makeNetwork(c){
  const nx = [], nz = [], ntag = [], nborn = [], nedges = [];
  const ea = [], eb = [], elev = [], ew = [], esf = [], eh = [], eborn = [], edied = [], etag = [], euse = [], eload = [], equiet = [];
  const nbk = new Map(), ebk = new Map(), nodesOf = new Map();
  const key = (a, b) => a * 1000003 + b;
  const addTo = (m, k, v) => { let l = m.get(k); if (!l){ l = []; m.set(k, l); } l.push(v); };
  const R = c.router;

  // ---- nodes and edges ----
  // which nodes are connected (union-find; a road worn away is not taken out of it: routes over it fail and
  // are found again)
  const dsu = [];
  const find = (n) => { while (dsu[n] !== n){ dsu[n] = dsu[dsu[n]]; n = dsu[n]; } return n; };
  const connected = (a, b) => find(a) === find(b);
  function addNode(x, z, tag, born){
    const id = nx.length;
    nx.push(x); nz.push(z); ntag.push(tag); nedges.push([]); nborn.push(born); dsu.push(id);
    addTo(nbk, key(Math.floor(x / NB), Math.floor(z / NB)), id);
    if (tag >= 0) addTo(nodesOf, tag, id);
    return id;
  }
  const other = (e, n) => ea[e] === n ? eb[e] : ea[e];
  const elen = (e) => Math.hypot(nx[eb[e]] - nx[ea[e]], nz[eb[e]] - nz[ea[e]]);
  function edgeBetween(a, b){ for (const e of nedges[a]) if (other(e, a) === b) return e; return -1; }
  // the land-grid cells an edge runs through, marked so that routes between towns follow existing roads
  function mark(e, d){
    const ax = nx[ea[e]], az = nz[ea[e]], bx = nx[eb[e]], bz = nz[eb[e]], L = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(L / (R.rcell * 0.5))), seen = new Set();
    for (let k = 0; k <= n; k++){ const q = R.at(ax + (bx - ax) * k / n, az + (bz - az) * k / n); if (!seen.has(q)){ seen.add(q); R.road[q] = Math.max(0, R.road[q] + d); } }
  }
  function bucketEdge(e){
    const a = ea[e], b = eb[e], x0 = Math.min(nx[a], nx[b]), x1 = Math.max(nx[a], nx[b]), z0 = Math.min(nz[a], nz[b]), z1 = Math.max(nz[a], nz[b]);
    for (let j = Math.floor(z0 / EB); j <= Math.floor(z1 / EB); j++) for (let i = Math.floor(x0 / EB); i <= Math.floor(x1 / EB); i++) addTo(ebk, key(i, j), e);
  }
  function rawEdge(a, b, lev, born, tag, sf){
    const ex = edgeBetween(a, b);
    if (ex >= 0) return ex;
    const id = ea.length;
    ea.push(a); eb.push(b); elev.push(lev); ew.push(LEVEL_W[lev]); esf.push(sf); eh.push(1); eborn.push(born); edied.push(0);
    etag.push(tag); euse.push(0); eload.push(0); equiet.push(0);
    nedges[a].push(id); nedges[b].push(id);
    bucketEdge(id); mark(id, 1);
    dsu[find(a)] = find(b);
    return id;
  }
  function removeEdge(e, born){
    if (edied[e]) return;
    edied[e] = Math.max(1, born); mark(e, -1);
    for (const n of [ea[e], eb[e]]){ const l = nedges[n], i = l.indexOf(e); if (i >= 0){ l[i] = l[l.length - 1]; l.pop(); } }
  }
  /** live edges near a box (each once) */
  function edgesNear(x0, z0, x1, z1, fn){
    const seen = new Set();
    for (let j = Math.floor(z0 / EB); j <= Math.floor(z1 / EB); j++) for (let i = Math.floor(x0 / EB); i <= Math.floor(x1 / EB); i++)
      for (const e of ebk.get(key(i, j)) || []){ if (edied[e] || seen.has(e)) continue; seen.add(e); fn(e); }
  }
  /** split edge e at (x, z): its nearer end node if within 6 m, else a new node there @returns {number} the node */
  function splitAt(e, x, z, born){
    const a = ea[e], b = eb[e];
    if (Math.hypot(nx[a] - x, nz[a] - z) < 6) return a;
    if (Math.hypot(nx[b] - x, nz[b] - z) < 6) return b;
    const m = addNode(x, z, ntag[a] >= 0 ? ntag[a] : ntag[b], born);
    // e keeps its first half; its second half is a new edge with the same level, surface, health, use
    mark(e, -1);
    { const l = nedges[b], i = l.indexOf(e); l[i] = l[l.length - 1]; l.pop(); }
    eb[e] = m; nedges[m].push(e); bucketEdge(e); mark(e, 1);
    const f = ea.length;
    ea.push(m); eb.push(b); elev.push(elev[e]); ew.push(ew[e]); esf.push(esf[e]); eh.push(eh[e]); eborn.push(eborn[e]); edied.push(0);
    etag.push(etag[e]); euse.push(euse[e]); eload.push(eload[e]); equiet.push(equiet[e]);
    nedges[m].push(f); nedges[b].push(f); bucketEdge(f); mark(f, 1);
    return m;
  }
  /** an edge from node a to node b; where it crosses an edge, both are split there (a junction)
   *  @returns {number[]} the edges laid */
  function addEdge(a, b, lev, born, tag, sf){
    const ax = nx[a], az = nz[a], bx = nx[b], bz = nz[b], dx = bx - ax, dz = bz - az;
    const hits = [];
    edgesNear(Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz), (e) => {
      const p = ea[e], q = eb[e];
      if (p === a || q === a || p === b || q === b) return;
      const ex = nx[q] - nx[p], ez = nz[q] - nz[p], den = dx * ez - dz * ex;
      if (Math.abs(den) < 1e-9) return;
      const t = ((nx[p] - ax) * ez - (nz[p] - az) * ex) / den, u = ((nx[p] - ax) * dz - (nz[p] - az) * dx) / den;
      if (t > 1e-4 && t < 1 - 1e-4 && u > -1e-4 && u < 1 + 1e-4) hits.push([t, e]);
    });
    hits.sort((p, q) => p[0] - q[0]);
    const out = [];
    let prev = a;
    for (const [t, e] of hits){
      if (edied[e]) continue;
      const m = splitAt(e, ax + dx * t, az + dz * t, born);
      if (m === prev || m === b) continue;
      out.push(rawEdge(prev, m, lev, born, tag, sf)); prev = m;
    }
    if (prev !== b) out.push(rawEdge(prev, b, lev, born, tag, sf));
    return out;
  }
  function nearestNode(x, z, r, tag = -1, not = -1, live = true){
    let best = -1, bd = r;
    const n = Math.ceil(r / NB), ci = Math.floor(x / NB), cj = Math.floor(z / NB);
    for (let b = -n; b <= n; b++) for (let a = -n; a <= n; a++) for (const id of nbk.get(key(ci + a, cj + b)) || []){
      if (id === not || (tag >= 0 && ntag[id] !== tag) || (live && !nedges[id].length)) continue;
      const d = Math.hypot(nx[id] - x, nz[id] - z); if (d < bd){ bd = d; best = id; }
    }
    return best;
  }
  const segDist = (px, pz, ax, az, bx, bz) => {
    const ex = bx - ax, ez = bz - az, t = Math.max(0, Math.min(1, ((px - ax) * ex + (pz - az) * ez) / (ex * ex + ez * ez || 1)));
    return Math.hypot(px - ax - ex * t, pz - az - ez * t);
  };
  // the smallest angle (cosine) between a new edge from node n toward (dx, dz) and the edges there
  function maxCos(n, dx, dz){
    const L = Math.hypot(dx, dz) || 1; let m = -1;
    for (const e of nedges[n]){ const o = other(e, n), ox = nx[o] - nx[n], oz = nz[o] - nz[n]; m = Math.max(m, (ox * dx + oz * dz) / ((Math.hypot(ox, oz) || 1) * L)); }
    return m;
  }

  // ---- speed and the fastest ways ----
  const speedOf = (e) => SPEED[elev[e]] * SURF_K[esf[e]] * (0.6 + 0.4 * eh[e]) / (1 + 0.5 * Math.min(4, eload[e]) ** 2);
  const timeOf = (e) => elen(e) / speedOf(e);
  let gS = new Float64Array(0), stamp = new Int32Array(0), via = new Int32Array(0), search = 0;
  const grow2 = () => { if (gS.length < nx.length){ const n = Math.max(1024, nx.length * 2); gS = new Float64Array(n); stamp = new Int32Array(n); via = new Int32Array(n); } };
  // a small binary heap of [priority, node]
  class Q { constructor(){ this.p = []; this.n = []; } get size(){ return this.p.length; }
    push(pr, v){ const p = this.p, n = this.n; let i = p.length; p.push(pr); n.push(v); while (i > 0){ const u = (i - 1) >> 1; if (p[u] <= pr) break; p[i] = p[u]; n[i] = n[u]; i = u; } p[i] = pr; n[i] = v; }
    pop(){ const p = this.p, n = this.n, top = n[0], lp = p.pop(), ln = n.pop(); if (p.length){ let i = 0; for (;;){ let k = 2 * i + 1; if (k >= p.length) break; if (k + 1 < p.length && p[k + 1] < p[k]) k++; if (p[k] >= lp) break; p[i] = p[k]; n[i] = n[k]; i = k; } p[i] = lp; n[i] = ln; } return top; } }
  /** the fastest way from node s to node t (A* by travel time) @returns {number[] | null} its edges */
  function fastest(s, t, maxLen = 60000){
    grow2(); search++;
    const tx = nx[t], tz = nz[t], vmax = SPEED[4], q = new Q();
    gS[s] = 0; stamp[s] = search; via[s] = -1; q.push(Math.hypot(nx[s] - tx, nz[s] - tz) / vmax, s);
    let pops = 0;
    while (q.size && pops++ < 200000){
      const n = q.pop();
      if (n === t){ const out = []; for (let k = t; via[k] >= 0; k = other(via[k], k)) out.push(via[k]); return out; }
      const g = gS[n];
      for (const e of nedges[n]){
        const m = other(e, n), ng = g + timeOf(e);
        if (stamp[m] === search && ng >= gS[m]) continue;
        if (Math.hypot(nx[m] - nx[s], nz[m] - nz[s]) > maxLen) continue;
        stamp[m] = search; gS[m] = ng; via[m] = e;
        q.push(ng + Math.hypot(nx[m] - tx, nz[m] - tz) / vmax, m);
      }
    }
    return null;
  }
  /** the fastest ways from node s to every node within reach (m): visit order and the edge each came by */
  function tree(s, reach){
    grow2(); search++;
    const q = new Q(), order = [];
    gS[s] = 0; stamp[s] = search; via[s] = -1; q.push(0, s);
    const done = new Set();
    while (q.size){
      const n = q.pop();
      if (done.has(n)) continue;
      done.add(n); order.push(n);
      for (const e of nedges[n]){
        const m = other(e, n), ng = gS[n] + timeOf(e);
        if (done.has(m) || (stamp[m] === search && ng >= gS[m])) continue;
        if (Math.hypot(nx[m] - nx[s], nz[m] - nz[s]) > reach) continue;
        stamp[m] = search; gS[m] = ng; via[m] = e; q.push(ng, m);
      }
    }
    return { order, via: (n) => stamp[n] === search ? via[n] : -1, reached: (n) => stamp[n] === search && done.has(n) };
  }

  // ---- towns ----
  /** settlement s's core node (made if needed); s.nodes: the nodes carrying its tag */
  function core(s, born){
    if (s.coreNode === undefined){
      s.coreNode = nearestNode(s.core[0], s.core[1], 30, -1, -1, true);
      if (s.coreNode < 0) s.coreNode = addNode(s.core[0], s.core[1], s.id, born);
      if (!nodesOf.has(s.id)) nodesOf.set(s.id, []);
      if (ntag[s.coreNode] !== s.id) nodesOf.get(s.id).push(s.coreNode);
      s.nodes = nodesOf.get(s.id);
    }
    return s.coreNode;
  }
  // the town's frame: its axis (the first road at its middle, or chosen) and its block size
  function frame(s, a, wide){
    if (s.axis === undefined){
      const n = s.coreNode, e = nedges[n].find((q) => elev[q] >= 1);
      s.axis = e !== undefined ? Math.atan2(nz[other(e, n)] - nz[n], nx[other(e, n)] - nx[n]) : c.rnd(a, 1) * Math.PI;
    }
    if (s.block === undefined) s.block = 70 + 30 * c.rnd(a, 2);
    return { ax: s.axis, G: wide ? s.block * 1.15 : s.block * 0.8 };
  }
  // can a street run from node n to (x, z) (ending on node b, or -1 for a new node)? It keeps to buildable
  // land, keeps half a block from streets beside it (other than those it meets), crosses others only at
  // 60 degrees or more, and meets the streets at its ends at 60 degrees or more.
  // (from node n, or from a point (ax, az) on edge `on` when n is -1)
  function clear(n, x, z, b, G, ax = nx[n], az = nz[n], on = -1){
    for (let k = 1; k <= 5; k++){ const t = k / 6; if (!c.landOk(ax + (x - ax) * t, az + (z - az) * t)) return false; }
    if (b < 0 && !c.landOk(x, z)) return false;
    if (n >= 0 && maxCos(n, x - ax, z - az) > 0.5) return false;
    if (b >= 0 && maxCos(b, ax - x, az - z) > 0.5) return false;
    const mx = (ax + x) / 2, mz = (az + z) / 2, L = Math.hypot(x - ax, z - az) || 1, dx = (x - ax) / L, dz = (z - az) / L;
    let ok = true;
    edgesNear(Math.min(ax, x) - G, Math.min(az, z) - G, Math.max(ax, x) + G, Math.max(az, z) + G, (e) => {
      if (!ok || e === on) return;
      const p = ea[e], q = eb[e];
      if (p === n || q === n || (b >= 0 && (p === b || q === b))) return;
      const ex = nx[q] - nx[p], ez = nz[q] - nz[p], el = Math.hypot(ex, ez) || 1, cs = Math.abs(dx * ex + dz * ez) / el;
      // a street beside it, roughly parallel: half a block away at least
      if (cs > 0.7 && segDist(mx, mz, nx[p], nz[p], nx[q], nz[q]) < G * 0.5) ok = false;
      // a new end close to a street (it would not quite reach it)
      if (b < 0 && segDist(x, z, nx[p], nz[p], nx[q], nz[q]) < G * 0.3) ok = false;
      // crossing at a sharp angle
      if (cs > 0.5){
        const den = (x - ax) * ez - (z - az) * ex;
        if (Math.abs(den) > 1e-9){ const t = ((nx[p] - ax) * ez - (nz[p] - az) * ex) / den, u = ((nx[p] - ax) * (z - az) - (nz[p] - az) * (x - ax)) / den; if (t > 0 && t < 1 && u > 0 && u < 1) ok = false; }
      }
    });
    return ok;
  }
  /** grow settlement s's streets by one; wide: the wheel is known; outward: suburbs (cars); sf: the surface
   *  laid; plan: how much its people plan (0-1) @returns {number} the new edge or -1 */
  function grow(s, born, a, outward = false, sf = 0, plan = 0, wide = true){
    core(s, born);
    const { ax: axis, G } = frame(s, a, wide);
    const nodes = s.nodes, cx = s.core[0], cz = s.core[1];
    // a point pulled toward the town's grid (lattice of block size G along its axis), by how much it plans
    const ca = Math.cos(axis), sa = Math.sin(axis);
    const toGrid = (x, z) => {
      if (plan <= 0) return [x, z];
      const u = (x - cx) * ca + (z - cz) * sa, v = -(x - cx) * sa + (z - cz) * ca, gu = Math.round(u / G) * G, gv = Math.round(v / G) * G;
      const qx = cx + gu * ca - gv * sa, qz = cz + gu * sa + gv * ca;
      return [x + (qx - x) * plan, z + (qz - z) * plan];
    };
    const dirOf = (ang) => { if (plan > 0){ const k = Math.round((ang - axis) / (Math.PI / 2)); ang += (axis + k * Math.PI / 2 - ang) * plan; } return ang; };
    for (let t = 0; t < 14; t++){
      // a node to grow from (nearer the middle more likely; further out for suburbs), with room for a street
      let n = -1;
      for (let k = 0; k < 4; k++){
        const m = nodes[Math.floor(c.rnd(a, 10 + t * 4 + k) * nodes.length)];
        if (m === undefined || nedges[m].length >= 4) continue;
        const dm = Math.hypot(nx[m] - cx, nz[m] - cz), dn = n < 0 ? 0 : Math.hypot(nx[n] - cx, nz[n] - cz);
        if (n < 0 || (outward ? dm > dn : dm < dn)) n = m;
      }
      let from = n, ang, len = G * (0.85 + 0.3 * c.rnd(a, 20 + t));
      const deg = n >= 0 ? nedges[n].length : -1;
      const rr = c.rnd(a, 30 + t);
      if (n < 0 || rr < 0.45){
        // a side street off the middle of a street or road of the town (ribbon: roads into town first)
        const es = [];
        for (const m of nodes) for (const e of nedges[m]) if (elev[e] >= 2 && elen(e) > G * 1.1) es.push(e);
        if (!es.length && n < 0) continue;
        if (es.length){
          const e = es[Math.floor(c.rnd(a, 40 + t) * es.length)], p = ea[e], q = eb[e], L = elen(e);
          const u = Math.min(0.5, (G * (0.5 + c.rnd(a, 45 + t))) / L), px = nx[p] + (nx[q] - nx[p]) * u, pz = nz[p] + (nz[q] - nz[p]) * u;
          const side = c.rnd(a, 50 + t) < 0.5 ? 1 : -1, base = Math.atan2(nz[q] - nz[p], nx[q] - nx[p]);
          ang = dirOf(base + side * (Math.PI / 2 + (1 - plan) * (c.rnd(a, 55 + t) - 0.5) * 0.35));
          const ex = px + Math.cos(ang) * len, ez = pz + Math.sin(ang) * len;
          // (the branch must be clear before the street is split for it)
          const [gx, gz] = toGrid(ex, ez);
          if (!clear(-1, gx, gz, -1, G, px, pz, e)) continue;
          from = splitAt(e, px, pz, born);
          if (ntag[from] !== s.id){ ntag[from] = s.id; nodes.push(from); }
          return addEdge(from, addNode(gx, gz, s.id, born), 2, born, s.id, sf)[0];
        }
      }
      if (deg === 0) ang = dirOf(axis + (c.rnd(a, 60 + t) < 0.5 ? Math.PI : 0));
      else {
        const e = nedges[n][Math.floor(c.rnd(a, 61 + t) * deg)], o = other(e, n);
        const base = Math.atan2(nz[n] - nz[o], nx[n] - nx[o]);            // along the street, away from its other end
        // a dead end continues (60%) or turns to close a block; a node on a street branches off at a right angle
        ang = deg === 1 && c.rnd(a, 70 + t) < 0.6 ? base + (1 - plan) * (c.rnd(a, 80 + t) - 0.5) * 0.3
          : base + (c.rnd(a, 90 + t) < 0.5 ? 1 : -1) * (Math.PI / 2 + (1 - plan) * (c.rnd(a, 100 + t) - 0.5) * 0.35);
        ang = dirOf(ang);
      }
      let [x, z] = toGrid(nx[from] + Math.cos(ang) * len, nz[from] + Math.sin(ang) * len);
      // end on a node near there (closing a block) when the angles allow
      let b = nearestNode(x, z, G * SNAP, -1, from);
      if (b >= 0 && (edgeBetween(from, b) >= 0 || Math.hypot(nx[b] - nx[from], nz[b] - nz[from]) < G * 0.5)) b = -1;
      if (b >= 0){ x = nx[b]; z = nz[b]; }
      if (!clear(from, x, z, b, G)) { if (b >= 0){ b = -1; [x, z] = toGrid(nx[from] + Math.cos(ang) * len, nz[from] + Math.sin(ang) * len); if (!clear(from, x, z, -1, G)) continue; } else continue; }
      if (b < 0) b = addNode(x, z, s.id, born);
      return addEdge(from, b, 2, born, s.id, sf)[0];
    }
    return -1;
  }
  /** spots facing settlement s's streets: [x, z] a building's middle, set back from the street */
  // (r: streets nearer the middle are likelier, by distance r; 0: any street alike)
  function frontage(s, n, a, r = 0){
    const out = [], es = [], wt = [];
    let sum = 0;
    for (const nd of s.nodes || []) for (const e of nedges[nd]) if (elev[e] >= 2){
      const w2 = r > 0 ? Math.exp(-Math.hypot((nx[ea[e]] + nx[eb[e]]) / 2 - s.core[0], (nz[ea[e]] + nz[eb[e]]) / 2 - s.core[1]) / r) : 1;
      es.push(e); wt.push(w2); sum += w2;
    }
    if (!es.length || sum <= 0) return out;
    for (let t = 0; t < n; t++){
      let u0 = c.rnd(a, 200 + t) * sum, k = 0;
      while (k < es.length - 1 && u0 > wt[k]){ u0 -= wt[k]; k++; }
      const e = es[k], p = ea[e], q = eb[e];
      const u = 0.15 + 0.7 * c.rnd(a, 300 + t), side = c.rnd(a, 400 + t) < 0.5 ? -1 : 1;
      const dx = nx[q] - nx[p], dz = nz[q] - nz[p], L = Math.hypot(dx, dz) || 1, off = ew[e] / 2 + 3 + 6 + 3 * c.rnd(a, 500 + t);
      out.push([nx[p] + dx * u - dz / L * off * side, nz[p] + dz * u + dx / L * off * side]);
    }
    return out;
  }
  /** a track from a farmstead at (x, z) to the nearest node of its settlement (if it is far from one) */
  function track(x, z, tag, born){
    const n = nearestNode(x, z, 1500, tag, -1, false);
    if (n < 0 || Math.hypot(nx[n] - x, nz[n] - z) < 120) return;
    const m = addNode(x, z, tag, born);
    addEdge(n, m, 1, born, tag, 0);
  }

  // ---- roads between towns ----
  /** a road from settlement u's middle to t's: the route found on the land grid, laid where it runs off the
   *  network (a node every ~2 grid cells, smoothed), following the network where it meets it
   *  @returns {boolean} whether the two are now connected */
  function link(u, t, born, lev, sf){
    const A = core(u, born), Bn = core(t, born);
    const cells = R.route(R.at(nx[A], nz[A]), R.at(nx[Bn], nz[Bn]));
    if (!cells) return false;
    cells.reverse();                                     // (route gives them from the goal back)
    const rc = R.rcell, cxy = (k) => [-c.half + ((k % R.rres) + 0.5) * rc, -c.half + (((k / R.rres) | 0) + 0.5) * rc];
    const onNet = (k) => R.road[k] > 0;
    let cur = A, i = 0;
    const N = cells.length;
    const tagOf = (x, z) => { const g = c.tagAt(x, z); return g >= 0 ? g : u.id; };
    // lay road along cells i..j (every other cell, smoothed), from the current node
    const lay = (i0, j0) => {
      const pts = [];
      for (let k = i0; k <= j0; k += 2) pts.push(cxy(cells[k]));
      if ((j0 - i0) % 2) pts.push(cxy(cells[j0]));
      for (let pass = 0; pass < 2; pass++) for (let k = 1; k < pts.length - 1; k++) pts[k] = [(pts[k - 1][0] + 2 * pts[k][0] + pts[k + 1][0]) / 4, (pts[k - 1][1] + 2 * pts[k][1] + pts[k + 1][1]) / 4];
      for (const [x, z] of pts){
        if (Math.hypot(x - nx[cur], z - nz[cur]) < rc * 0.9) continue;
        const m = nearestNode(x, z, 20, -1, cur);
        const nn = m >= 0 ? m : addNode(x, z, c.tagAt(x, z), born);
        addEdge(cur, nn, lev, born, tagOf(x, z), sf); cur = nn;
      }
    };
    while (i < N){
      const on = onNet(cells[i]);
      let j = i; while (j + 1 < N && onNet(cells[j + 1]) === on) j++;
      // where the route meets the network, follow it to the node nearest where it leaves (if the two are
      // connected: else, as where there is no road, lay road along the route)
      let followed = false;
      if (on){
        const [ex, ez] = cxy(cells[j]);
        const exit = j === N - 1 ? Bn : nearestNode(ex, ez, rc * 1.2);
        if (exit >= 0 && (exit === cur || connected(cur, exit))){ cur = exit; followed = true; }
      }
      if (!followed){
        lay(i, j);
        // into the next stretch of network: its nearest node
        if (j + 1 < N){ const [x, z] = cxy(cells[j + 1]); const m = nearestNode(x, z, rc * 1.2, -1, cur); if (m >= 0 && Math.hypot(nx[m] - nx[cur], nz[m] - nz[cur]) < rc * 2.5){ addEdge(cur, m, lev, born, tagOf(x, z), sf); cur = m; } }
      }
      i = j + 1;
    }
    if (cur !== Bn && !connected(cur, Bn) && Math.hypot(nx[Bn] - nx[cur], nz[Bn] - nz[cur]) < rc * 3) addEdge(cur, Bn, lev, born, tagOf(nx[Bn], nz[Bn]), sf);
    return true;
  }

  // ---- traffic, levels and health, every 25 years ----
  /* o: { keeper(tag) the settlement keeping a road or null; canRepair(s); best(s, level) the best surface s
     knows for that level; maxLevel(s) the highest level it can build; homes: Map tag -> [x, z, people, ...];
     towns: settlements (with core nodes) and the reach of their trips (m); flows: [settlementA, B, amount] } */
  let lastRoutes = new Map();
  function tick(born, o){
    // town trips: from each home to the town's middle, along the fastest ways (a tree from the middle)
    for (const [s, reach] of o.towns){
      if (s.coreNode === undefined || !nedges[s.coreNode].length) continue;
      const hs = o.homes.get(s.id);
      if (!hs) continue;
      const T0 = tree(s.coreNode, reach), w = new Map();
      for (let k = 0; k < hs.length; k += 3){
        const n = nearestNode(hs[k], hs[k + 1], 250);
        if (n >= 0 && T0.reached(n)) w.set(n, (w.get(n) || 0) + hs[k + 2]);
      }
      for (let k = T0.order.length - 1; k > 0; k--){
        const n = T0.order[k], v = w.get(n);
        if (!v) continue;
        const e = T0.via(n); if (e < 0) continue;
        euse[e] += v; const p = other(e, n); w.set(p, (w.get(p) || 0) + v);
      }
    }
    // trade between towns along the fastest ways (the busiest flows first; ways found again each tick)
    const flows = o.flows.slice().sort((p, q) => q[2] - p[2]).slice(0, 250);
    for (const [A, B, amt0] of flows){
      if (A.coreNode === undefined || B.coreNode === undefined || !connected(A.coreNode, B.coreNode)) continue;
      const amt = amt0 * TRADE_K;
      const k = A.id * 1e6 + B.id;
      let pth = lastRoutes.get(k);
      if (!pth || pth.some((e) => edied[e])){ pth = fastest(A.coreNode, B.coreNode, 60000); if (pth) lastRoutes.set(k, pth); }
      if (pth) for (const e of pth) euse[e] += amt;
    }
    lastRoutes = new Map([...lastRoutes].filter(([, p]) => p && !p.some((e) => edied[e])));
    if (born % 2 === 0) lastRoutes.clear();               // (and found afresh every other tick: roads change)
    // roads homes face (within 40 m of a lived-in home) are never let down a level: homes need their street
    const fronted = new Set();
    for (const hs of o.homes.values()) for (let k = 0; k < hs.length; k += 3){
      const x = hs[k], z = hs[k + 1];
      let be = -1, bd = 40;
      edgesNear(x - 40, z - 40, x + 40, z + 40, (e) => { const d = segDist(x, z, nx[ea[e]], nz[ea[e]], nx[eb[e]], nz[eb[e]]); if (d < bd){ bd = d; be = e; } });
      if (be >= 0) fronted.add(be);
    }
    // levels and health
    let gone = 0, up = 0, down = 0;
    const n = ea.length;
    for (let e = 0; e < n; e++){
      if (edied[e]) continue;
      const lev = elev[e], ld = euse[e] / CAP[lev];
      eload[e] = 0.5 * eload[e] + 0.5 * ld;
      const own = o.keeper(etag[e]);
      if (eload[e] > 1 && own && lev < o.maxLevel(own) && o.canRepair(own)){ raise(e, born); up++; }
      else if (eload[e] < 0.02 && lev > 0 && !fronted.has(e)){ if (++equiet[e] >= 2){ elev[e] = lev - 1; ew[e] = LEVEL_W[lev - 1]; equiet[e] = 0; down++; } }
      else equiet[e] = 0;
      // wear, repair, worn away
      const sf = esf[e], u = eload[e] / (eload[e] + 1);
      eh[e] -= WEAR_BASE[sf] + WEAR_USE[sf] * u;
      if (eh[e] < REPAIR_AT && (euse[e] > 0 || fronted.has(e)) && own && o.canRepair(own)){ eh[e] = 1; esf[e] = Math.max(sf, o.best(own, elev[e])); }
      else if (eh[e] <= 0){ removeEdge(e, born); gone++; }
      euse[e] = 0;
    }
    return { gone, up, down };
  }
  // raise edge e a level; lower roads crowding it alongside are removed to make room; a main road too close
  // beside another main road: the quieter one falls back
  function raise(e, born){
    const lev = elev[e] + 1, p = ea[e], q = eb[e], mx = (nx[p] + nx[q]) / 2, mz = (nz[p] + nz[q]) / 2, L = elen(e) || 1;
    const dx = (nx[q] - nx[p]) / L, dz = (nz[q] - nz[p]) / L;
    elev[e] = lev; ew[e] = LEVEL_W[lev]; equiet[e] = 0;
    const r = lev >= 3 ? MAIN_GAP : LEVEL_W[lev] / 2 + 15;
    edgesNear(mx - r, mz - r, mx + r, mz + r, (f) => {
      if (f === e || ea[f] === p || ea[f] === q || eb[f] === p || eb[f] === q) return;
      const a = ea[f], b = eb[f], fl = elen(f) || 1, cs = Math.abs(((nx[b] - nx[a]) * dx + (nz[b] - nz[a]) * dz) / fl);
      if (cs < 0.85) return;
      // beside it: off to one side (its middle away from e's line) and level with it along e (a road further
      // along the same line is its continuation, not a neighbour)
      const fx = (nx[a] + nx[b]) / 2 - mx, fz = (nz[a] + nz[b]) / 2 - mz, along = fx * dx + fz * dz, d = Math.abs(fx * dz - fz * dx);
      if (Math.abs(along) > L / 2 + fl / 2 || d < 6) return;
      if (elev[f] < lev && d < LEVEL_W[lev] / 2 + 15 && eload[f] < eload[e] * 0.5) removeEdge(f, born);        // make room
      else if (lev >= 3 && elev[f] >= 3 && d < MAIN_GAP){
        if (eload[f] <= eload[e]){ elev[f] = 2; ew[f] = LEVEL_W[2]; } else { elev[e] = 2; ew[e] = LEVEL_W[2]; }
      }
    });
  }

  /** the network as plain data, with junction controls (by the streets that meet: 3 roundabout five or more
   *  ways, 2 signals two or more main roads, 1 stop sign a street meets a main road, 0 none) */
  function finish(){
    const n = ea.length;
    const jtype = new Uint8Array(nx.length), jlist = [];
    for (let k = 0; k < nx.length; k++){
      const legs = nedges[k].filter((e) => elev[e] >= 2 && !edied[e]), deg = legs.length;
      if (deg < 3) continue;
      const mains = legs.filter((e) => elev[e] >= 3).length;
      const t = deg >= 5 ? 3 : mains >= 2 ? 2 : mains >= 1 ? 1 : 0;
      jtype[k] = t; jlist.push(nx[k], nz[k], t, deg, nborn[k]);
    }
    const f32 = (f) => Float32Array.from({ length: n }, (_, i) => f(i));
    const hl = (h) => h >= 0.75 ? 3 : h >= 0.5 ? 2 : h >= 0.25 ? 1 : 0;
    return {
      streets: { n, ax: f32((i) => nx[ea[i]]), az: f32((i) => nz[ea[i]]), bx: f32((i) => nx[eb[i]]), bz: f32((i) => nz[eb[i]]),
        w: f32((i) => ew[i]), cls: Uint8Array.from(elev), level: Uint8Array.from(elev), born: Int16Array.from(eborn), tag: Int32Array.from(etag),
        ja: Uint8Array.from({ length: n }, (_, i) => jtype[ea[i]]), jb: Uint8Array.from({ length: n }, (_, i) => jtype[eb[i]]),
        health: Uint8Array.from(eh, hl), surf: Uint8Array.from(esf), died: Int16Array.from(edied) },
      junctions: Float32Array.from(jlist),
    };
  }
  const stats = () => { const c2 = [0, 0, 0, 0, 0]; let live = 0; for (let e = 0; e < ea.length; e++) if (!edied[e]){ live++; c2[elev[e]]++; } return { edges: ea.length, live, byLevel: c2, nodes: nx.length }; };
  return { core, grow, frontage, track, link, tick, finish, nearestNode, fastest, stats, edgeCount: () => ea.length };
}
