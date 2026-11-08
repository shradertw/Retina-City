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

   Town streets grow as towns need frontage (grow): along the roads into town first; then side streets leave
   them square, a block apart, and run on or turn square to meet each other, closing blocks into a grid that
   follows the roads it grew from. Towns whose people plan keep it square and even; others bend a little
   and vary their blocks. Streets meet at 60 degrees or more.

   Roads between towns (link) are found on the land grid (src/gen/route.js: slopes, rivers, existing roads
   much cheaper) and laid only where no road runs yet: where the route meets the network it follows it. */
import { WEAR_BASE, WEAR_USE, REPAIR_AT } from './route.js';

export const LEVEL_W = [2, 4, 9, 16, 28];       // width (m): footpath, track, street or road, main road, freeway
const SPEED = [4, 10, 25, 45, 90];              // km/h on a good surface, in good repair
const SURF_K = [0.6, 0.8, 0.9, 1];              // dirt, gravel, setts, asphalt
// what a level carries before it crowds: people's trips (or food's worth of trade) per 25 years
export const CAP = [20, 100, 1500, 15000, 150000];
const MAIN_GAP = 300;
const KNOT = 35;                                // m: no new junction this close to another
const MERGE = 30;                               // m: junctions joined by a road shorter than this become one
const TRADE_K = 0.25;                           // traffic per unit of food traded (a guess: carts carry many people's food)                           // m: main roads side by side closer than this: one falls back
const NB = 25, EB = 60;                         // bucket sizes (m): nodes, edges

/** @param {{ landOk: (x: number, z: number) => boolean, rnd: (a: number, k: number) => number,
 *            router: any, tagAt: (x: number, z: number) => number, half: number }} c */
export function makeNetwork(c){
  const nx = [], nz = [], ntag = [], nborn = [], nedges = [], nh = [];   // nh: height of the road there (m)
  const ea = [], eb = [], elev = [], ew = [], esf = [], eh = [], eborn = [], edied = [], etag = [], euse = [], eload = [], equiet = [];
  const eramp = [], ejam = [];                    // a freeway ramp; ticks a main road has stayed crowded
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
    nx.push(x); nz.push(z); ntag.push(tag); nedges.push([]); nborn.push(born); dsu.push(id); nh.push(0);
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
    etag.push(tag); euse.push(0); eload.push(0); equiet.push(0); eramp.push(0); ejam.push(0);
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
  // ---- keeping the network in one piece (see "Roads keep their level" in tick) ----
  /** can node from reach any of targets without passing through node avoid or edge skip, or along a freeway?
   *  (a search of up to
   *  limit nodes; a search that runs out is taken as yes: it has reached a big part of the network) */
  function reaches(from, targets, avoid = -1, skip = -1, limit = 5000, viaFreeway = false){
    if (targets.has(from)) return true;
    const seen = new Set([from]), q = [from];
    for (let h = 0; h < q.length; h++){
      if (seen.size > limit) return true;
      for (const f of nedges[q[h]]){
        if (f === skip || edied[f] || (elev[f] === 4 && !viaFreeway)) continue;   // (not along a freeway unless asked: walkers cannot)
        const o = other(f, q[h]);
        if (o === avoid || seen.has(o)) continue;
        if (targets.has(o)) return true;
        seen.add(o); q.push(o);
      }
    }
    return false;
  }
  /** edge e can go without cutting anything off: one of its ends is a dead end, or its ends stay joined
   *  another way */
  const safeToRemove = (e) => nedges[ea[e]].length <= 1 || nedges[eb[e]].length <= 1 || reaches(ea[e], new Set([eb[e]]), -1, e);
  /** the lowest level edge e may be let down to: a track if it is paved (stone setts or asphalt), and no more
   *  than one level below the weaker of its two ends (each end: the best road meeting it there, a freeway
   *  counting as a main road; an open end: none) */
  function floorOf(e){
    let weak = 9;
    for (const n of [ea[e], eb[e]]){
      let best = -1;
      for (const f of nedges[n]) if (f !== e && !edied[f]) best = Math.max(best, Math.min(3, elev[f]));
      weak = Math.min(weak, best);
    }
    return Math.max(esf[e] >= 2 ? 1 : 0, weak - 1, 0);
  }
  /** a worn-out footpath that may vanish: no home faces it, every road at its ends is a footpath too, and it
   *  cuts nothing off */
  function mayVanish(e, fronted){
    if (elev[e] !== 0 || fronted.has(e)) return false;
    for (const n of [ea[e], eb[e]]) for (const f of nedges[n]) if (f !== e && !edied[f] && elev[f] > 0) return false;
    return safeToRemove(e);
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
    { const L = Math.hypot(nx[b] - nx[a], nz[b] - nz[a]) || 1, t = Math.hypot(x - nx[a], z - nz[a]) / L; nh[m] = nh[a] + (nh[b] - nh[a]) * t; }
    // e keeps its first half; its second half is a new edge with the same level, surface, health, use
    mark(e, -1);
    { const l = nedges[b], i = l.indexOf(e); l[i] = l[l.length - 1]; l.pop(); }
    eb[e] = m; nedges[m].push(e); bucketEdge(e); mark(e, 1);
    const f = ea.length;
    ea.push(m); eb.push(b); elev.push(elev[e]); ew.push(ew[e]); esf.push(esf[e]); eh.push(eh[e]); eborn.push(eborn[e]); edied.push(0);
    etag.push(etag[e]); euse.push(euse[e]); eload.push(eload[e]); equiet.push(equiet[e]); eramp.push(eramp[e]); ejam.push(ejam[e]);
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
      if ((lev === 4) !== (elev[e] === 4)) return;          // (a freeway and another road pass over or under: see grade())
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
  // travel time along an edge, in seconds
  const timeOf = (e) => elen(e) * 3.6 / speedOf(e);
  /* Passing through a junction costs time: traffic slows or stops there, more where more roads meet and for
     sharp turns, and much more where junctions crowd each other (queues spill from one into the next):
       3 roads 4 s, 4 roads 7 s, 5 or more 12 s; a turn sharper than 60 degrees 3 s; each other junction
       within JAM_R of it 8 s (counted each tick: jam)
     So traffic keeps to through roads with few junctions, and a tangle of junctions loses its traffic and,
     by the rules below, falls back and wears away. */
  const JAM_R = 40;
  let jam = new Uint8Array(0);
  function delayAt(n, ein, eout){
    if (ein < 0) return 0;
    const d = nedges[n].length;
    let t = d >= 5 ? 12 : d === 4 ? 7 : d === 3 ? 4 : 0;
    const a = other(ein, n), b = other(eout, n);
    const ax = nx[n] - nx[a], az = nz[n] - nz[a], bx = nx[b] - nx[n], bz = nz[b] - nz[n];
    if ((ax * bx + az * bz) / ((Math.hypot(ax, az) * Math.hypot(bx, bz)) || 1) < 0.5) t += 3;
    if (n < jam.length) t += 8 * jam[n];
    return t;
  }
  /** junction nodes (three or more roads) */
  const isJunction = (n) => nedges[n].length >= 3;
  /** another junction within r of node n (or of point (x, z)), other than not1 and not2 */
  function junctionNear(x, z, r, not1 = -1, not2 = -1){
    const k = Math.ceil(r / NB), ci = Math.floor(x / NB), cj = Math.floor(z / NB);
    for (let b = -k; b <= k; b++) for (let a = -k; a <= k; a++) for (const id of nbk.get(key(ci + a, cj + b)) || [])
      if (id !== not1 && id !== not2 && isJunction(id) && Math.hypot(nx[id] - x, nz[id] - z) < r) return true;
    return false;
  }
  let gS = new Float64Array(0), stamp = new Int32Array(0), via = new Int32Array(0), search = 0;
  const grow2 = () => { if (gS.length < nx.length){ const n = Math.max(1024, nx.length * 2); gS = new Float64Array(n); stamp = new Int32Array(n); via = new Int32Array(n); } };
  // a small binary heap of [priority, node]
  class Q { constructor(){ this.p = []; this.n = []; } get size(){ return this.p.length; }
    push(pr, v){ const p = this.p, n = this.n; let i = p.length; p.push(pr); n.push(v); while (i > 0){ const u = (i - 1) >> 1; if (p[u] <= pr) break; p[i] = p[u]; n[i] = n[u]; i = u; } p[i] = pr; n[i] = v; }
    pop(){ const p = this.p, n = this.n, top = n[0], lp = p.pop(), ln = n.pop(); if (p.length){ let i = 0; for (;;){ let k = 2 * i + 1; if (k >= p.length) break; if (k + 1 < p.length && p[k + 1] < p[k]) k++; if (p[k] >= lp) break; p[i] = p[k]; n[i] = n[k]; i = k; } p[i] = lp; n[i] = ln; } return top; } }
  /** the fastest way from node s to node t (A* by travel time) @returns {number[] | null} its edges */
  function fastest(s, t, maxLen = 60000){
    grow2(); search++;
    const tx = nx[t], tz = nz[t], vmax = SPEED[4] / 3.6, q = new Q();
    gS[s] = 0; stamp[s] = search; via[s] = -1; q.push(Math.hypot(nx[s] - tx, nz[s] - tz) / vmax, s);
    let pops = 0;
    while (q.size && pops++ < 200000){
      const n = q.pop();
      if (n === t){ const out = []; for (let k = t; via[k] >= 0; k = other(via[k], k)) out.push(via[k]); return out; }
      const g = gS[n];
      for (const e of nedges[n]){
        const m = other(e, n), ng = g + timeOf(e) + delayAt(n, via[n], e);
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
        const m = other(e, n), ng = gS[n] + timeOf(e) + delayAt(n, via[n], e);
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
    if (s.block === undefined) s.block = 60 + 25 * c.rnd(a, 2);
    return { ax: s.axis, G: wide ? s.block : s.block * 0.8 };
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
      // crossing: at a sharp angle never; elsewhere not near another junction (a knot)
      const den = (x - ax) * ez - (z - az) * ex;
      if (Math.abs(den) > 1e-9){
        const t = ((nx[p] - ax) * ez - (nz[p] - az) * ex) / den, u = ((nx[p] - ax) * (z - az) - (nz[p] - az) * (x - ax)) / den;
        if (t > 0 && t < 1 && u > 0 && u < 1 && (cs > 0.5 || elev[e] === 4 || eramp[e] || junctionNear(ax + (x - ax) * t, az + (z - az) * t, KNOT, p, q))) ok = false;
      }
    });
    // its ends: a junction made where another is within KNOT (a node on a street becomes one by this street)
    if (ok && n >= 0 && nedges[n].length >= 2 && junctionNear(ax, az, KNOT, n)) ok = false;
    if (ok && n < 0 && junctionNear(ax, az, KNOT)) ok = false;
    if (ok && b >= 0 && nedges[b].length >= 2 && junctionNear(x, z, KNOT, b)) ok = false;
    return ok;
  }
  // a node from point (x, z) toward angle ang, between rMin and rMax away, within tol (radians) of that way;
  // the one nearest the ideal distance rIdeal @returns {number} or -1
  function nodeToward(x, z, ang, rMin, rMax, tol, rIdeal, not = -1){
    let best = -1, bv = 1e9;
    const n = Math.ceil(rMax / NB), ci = Math.floor(x / NB), cj = Math.floor(z / NB), ca = Math.cos(ang), sa = Math.sin(ang), ct = Math.cos(tol);
    for (let b = -n; b <= n; b++) for (let a = -n; a <= n; a++) for (const id of nbk.get(key(ci + a, cj + b)) || []){
      if (id === not || !nedges[id].length || nedges[id].length >= 4) continue;
      const dx = nx[id] - x, dz = nz[id] - z, d = Math.hypot(dx, dz);
      if (d < rMin || d > rMax || (dx * ca + dz * sa) / d < ct) continue;
      const v = Math.abs(d - rIdeal); if (v < bv){ bv = v; best = id; }
    }
    return best;
  }
  /** grow settlement s's streets by one; wide: the wheel is known; outward: suburbs (cars); sf: the surface
   *  laid; plan: how much its people plan (0-1) @returns {number} the new edge or -1
   *  Side streets leave a street square to it, a block (G) from the junctions along it (the end nearer the
   *  middle first), or cross it where it runs straight through a node; a dead end runs on straight, or turns square to meet a node about a block away (closing a
   *  block); a street ends on a node only within 15 degrees of the way it was heading. Organic towns (plan 0)
   *  bend a little and vary their blocks; planned towns keep them square and even. */
  function grow(s, born, a, outward = false, sf = 0, plan = 0, wide = true){
    core(s, born);
    const { G: G0 } = frame(s, a, wide);
    const nodes = s.nodes, cx = s.core[0], cz = s.core[1];
    const jit = (1 - plan) * 0.12, vary = (1 - plan) * 0.3, TOL = 0.26;
    const mid = (x, z) => Math.hypot(x - cx, z - cz);
    const better = (dm, dn) => outward ? dm > dn : dm < dn;
    for (let t = 0; t < 16; t++){
      const G = G0 * (1 - vary / 2 + vary * c.rnd(a, 20 + t));
      // A: a dead end of the town's streets (nearer the middle likelier)
      if (c.rnd(a, 30 + t) < 0.5){
        let n = -1;
        for (let k = 0; k < 6; k++){
          const m = nodes[Math.floor(c.rnd(a, 10 + t * 6 + k) * nodes.length)];
          if (m === undefined || nedges[m].length !== 1 || elev[nedges[m][0]] < 2 || elev[nedges[m][0]] === 4 || eramp[nedges[m][0]] || nh[m] > 0.5) continue;
          if (n < 0 || better(mid(nx[m], nz[m]), mid(nx[n], nz[n]))) n = m;
        }
        if (n >= 0){
          const e = nedges[n][0], o = other(e, n), base = Math.atan2(nz[n] - nz[o], nx[n] - nx[o]);
          // close a block: turn square to meet a node about a block away, to either side
          const first = c.rnd(a, 40 + t) < 0.5 ? 1 : -1;
          for (const side of [first, -first]){
            const ang = base + side * Math.PI / 2, b = nodeToward(nx[n], nz[n], ang, 0.6 * G, 1.5 * G, TOL, G, n);
            if (b >= 0 && edgeBetween(n, b) < 0 && clear(n, nx[b], nz[b], b, G)) return addEdge(n, b, 2, born, s.id, sf)[0];
          }
          // or run on straight, a block
          const ang = base + jit * (c.rnd(a, 50 + t) - 0.5);
          let b = nodeToward(nx[n], nz[n], ang, 0.7 * G, 1.3 * G, TOL, G, n);
          if (b >= 0 && (edgeBetween(n, b) >= 0 || !clear(n, nx[b], nz[b], b, G))) b = -1;
          if (b >= 0) return addEdge(n, b, 2, born, s.id, sf)[0];
          const x = nx[n] + Math.cos(ang) * G, z = nz[n] + Math.sin(ang) * G;
          if (clear(n, x, z, -1, G)) return addEdge(n, addNode(x, z, s.id, born), 2, born, s.id, sf)[0];
          continue;
        }
      }
      // C: a cross street from a bend-free point on a street (a node where it runs straight on), square to it
      if (c.rnd(a, 35 + t) < 0.45){
        let n = -1;
        for (let k = 0; k < 6; k++){
          const m = nodes[Math.floor(c.rnd(a, 110 + t * 6 + k) * nodes.length)];
          if (m === undefined || nedges[m].length !== 2 || elev[nedges[m][0]] < 2 || elev[nedges[m][1]] < 2 || nh[m] > 0.5) continue;
          if (elev[nedges[m][0]] === 4 || elev[nedges[m][1]] === 4 || eramp[nedges[m][0]] || eramp[nedges[m][1]]) continue;
          const o1 = other(nedges[m][0], m), o2 = other(nedges[m][1], m);
          const ax1 = nx[o1] - nx[m], az1 = nz[o1] - nz[m], ax2 = nx[o2] - nx[m], az2 = nz[o2] - nz[m];
          if ((ax1 * ax2 + az1 * az2) / ((Math.hypot(ax1, az1) * Math.hypot(ax2, az2)) || 1) > -0.94) continue;   // (it bends there)
          if (n < 0 || better(mid(nx[m], nz[m]), mid(nx[n], nz[n]))) n = m;
        }
        if (n >= 0){
          const o = other(nedges[n][0], n), base = Math.atan2(nz[n] - nz[o], nx[n] - nx[o]);
          const ang = base + (c.rnd(a, 120 + t) < 0.5 ? 1 : -1) * (Math.PI / 2 + jit * (c.rnd(a, 125 + t) - 0.5));
          let b = nodeToward(nx[n], nz[n], ang, 0.6 * G, 1.4 * G, TOL, G, n);
          if (b >= 0 && (edgeBetween(n, b) >= 0 || !clear(n, nx[b], nz[b], b, G))) b = -1;
          if (b >= 0) return addEdge(n, b, 2, born, s.id, sf)[0];
          const x = nx[n] + Math.cos(ang) * G, z = nz[n] + Math.sin(ang) * G;
          if (clear(n, x, z, -1, G)) return addEdge(n, addNode(x, z, s.id, born), 2, born, s.id, sf)[0];
        }
      }
      // B: a side street off a street or road of the town, square to it
      const es = [];
      for (const m of nodes) for (const e of nedges[m]) if (elev[e] >= 2 && elev[e] < 4 && !eramp[e] && elen(e) >= 1.2 * G) es.push(e);
      if (!es.length){
        // no street yet: the first one, from the middle along the town's axis
        if (nedges[s.coreNode].length) continue;
        const ang = s.axis + (c.rnd(a, 60 + t) < 0.5 ? Math.PI : 0), x = cx + Math.cos(ang) * G, z = cz + Math.sin(ang) * G;
        if (clear(s.coreNode, x, z, -1, G)) return addEdge(s.coreNode, addNode(x, z, s.id, born), 2, born, s.id, sf)[0];
        continue;
      }
      let e = -1;
      for (let k = 0; k < 4; k++){
        const f = es[Math.floor(c.rnd(a, 70 + t * 4 + k) * es.length)];
        if (e < 0 || better(mid((nx[ea[f]] + nx[eb[f]]) / 2, (nz[ea[f]] + nz[eb[f]]) / 2), mid((nx[ea[e]] + nx[eb[e]]) / 2, (nz[ea[e]] + nz[eb[e]]) / 2))) e = f;
      }
      const L = elen(e), near0 = mid(nx[ea[e]], nz[ea[e]]) <= mid(nx[eb[e]], nz[eb[e]]);
      const p0 = near0 ? ea[e] : eb[e], p1 = other(e, p0), ux = (nx[p1] - nx[p0]) / L, uz = (nz[p1] - nz[p0]) / L;
      const d = L >= 2 * G ? G : L / 2, px = nx[p0] + ux * d, pz = nz[p0] + uz * d;
      const side = c.rnd(a, 80 + t) < 0.5 ? 1 : -1, base = Math.atan2(uz, ux);
      const ang = base + side * (Math.PI / 2 + jit * (c.rnd(a, 90 + t) - 0.5)), len = G * 0.9;
      let b = nodeToward(px, pz, ang, 0.7 * len, 1.3 * len, TOL, len);
      const x = b >= 0 ? nx[b] : px + Math.cos(ang) * len, z = b >= 0 ? nz[b] : pz + Math.sin(ang) * len;
      if (!clear(-1, x, z, b, G, px, pz, e)){ if (b < 0) continue; b = -1; const x2 = px + Math.cos(ang) * len, z2 = pz + Math.sin(ang) * len; if (!clear(-1, x2, z2, -1, G, px, pz, e)) continue; const from = splitAt(e, px, pz, born); if (ntag[from] !== s.id){ ntag[from] = s.id; nodes.push(from); } return addEdge(from, addNode(x2, z2, s.id, born), 2, born, s.id, sf)[0]; }
      const from = splitAt(e, px, pz, born);
      if (ntag[from] !== s.id){ ntag[from] = s.id; nodes.push(from); }
      return addEdge(from, b >= 0 ? b : addNode(x, z, s.id, born), 2, born, s.id, sf)[0];
    }
    return -1;
  }
  /** spots facing settlement s's streets: [x, z] a building's middle, set back from the street */
  // (r: streets nearer the middle are likelier, by distance r; 0: any street alike)
  function frontage(s, n, a, r = 0){
    const out = [], es = [], wt = [];
    let sum = 0;
    for (const nd of s.nodes || []) for (const e of nedges[nd]) if (elev[e] >= 2 && elev[e] < 4 && !eramp[e] && nh[ea[e]] < 0.5 && nh[eb[e]] < 0.5){
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
  // the node to join the network at, near (x, z) coming from node `from`: near, meeting the roads there at a
  // good angle, and not making a knot of junctions
  function joinNode(x, z, r, from){
    let best = -1, bv = 1e9;
    const k = Math.ceil(r / NB), ci = Math.floor(x / NB), cj = Math.floor(z / NB);
    for (let b = -k; b <= k; b++) for (let a = -k; a <= k; a++) for (const id of nbk.get(key(ci + a, cj + b)) || []){
      if (id === from || !nedges[id].length) continue;
      const d = Math.hypot(nx[id] - x, nz[id] - z);
      if (d > r) continue;
      let v = d;
      if (maxCos(id, nx[from] - nx[id], nz[from] - nz[id]) > 0.7) v += 150;       // a sharp merge
      if (nedges[id].length >= 2 && junctionNear(nx[id], nz[id], KNOT, id)) v += 100;   // a knot
      if (v < bv){ bv = v; best = id; }
    }
    return best;
  }
  /** a road from settlement u's middle to t's: the route found on the land grid, laid where it runs off the
   *  network (a node every ~2 grid cells, smoothed), following the network where it meets it
   *  @returns {boolean} whether the two are now connected */
  function link(u, t, born, lev, sf){
    const A = core(u, born), Bn = core(t, born);
    const cells = R.route(R.at(nx[A], nz[A]), R.at(nx[Bn], nz[Bn]));
    if (!cells) return false;
    cells.reverse();                                     // (route gives them from the goal back)
    const rc = R.rcell, cxy = (k) => [-c.half + ((k % R.rres) + 0.5) * rc, -c.half + (((k / R.rres) | 0) + 0.5) * rc];
    // (on the network: a road node within a cell of the route: a route a cell beside a road follows it)
    const onNet = (k) => { const [x, z] = cxy(k); return R.road[k] > 0 || nearestNode(x, z, rc * 0.9) >= 0; };
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
        if (j + 1 < N){ const [x, z] = cxy(cells[j + 1]); const m = joinNode(x, z, rc * 1.2, cur); if (m >= 0 && Math.hypot(nx[m] - nx[cur], nz[m] - nz[cur]) < rc * 2.5){ addEdge(cur, m, lev, born, tagOf(x, z), sf); cur = m; } }
      }
      i = j + 1;
    }
    if (cur !== Bn && !connected(cur, Bn) && Math.hypot(nx[Bn] - nx[cur], nz[Bn] - nz[cur]) < rc * 3) addEdge(cur, Bn, lev, born, tagOf(nx[Bn], nz[Bn]), sf);
    return true;
  }

  // ---- traffic, levels and health, every 25 years ----
  /* o: { keeper(tag) the settlement keeping a road or null; canRepair(s); best(s, level) the best surface s
     knows for that level; maxLevel(s) the highest level it can build; homes: Map tag -> [x, z, people, town home (1) or farm (0), ...];
     towns: settlements (with core nodes) and the reach of their trips (m); flows: [settlementA, B, amount] } */
  let lastRoutes = new Map();

  // ---- freeways (level 4) ----
  /* A main road that stays crowded for three ticks (75 years), where cars are known, may become a freeway: the
     settlement keeping it weighs converting the corridor it is part of (the run of main roads straight on
     through it, up to 12 km) against a new route beside it (a bypass, around crowded land), and builds the
     cheaper. Cost: a metre of freeway on open land 1, raised over crowded land (CROWD+ buildings within 100 m)
     3; a bypass also pays for the longer way (its extra length, weighed by the traffic).
     A freeway crosses other roads without junctions. Along a converted corridor, each road that met it:
       - an interchange (a diamond: four ramps between the freeway, 150 m either side, and the crossing road,
         60 m either side) at a main road crossing at least 1.5 km from the last interchange (or the first)
       - else an overpass or underpass, where the road is busy or a main road and runs on across
       - else cut: it ends 25 m short of the freeway
     Height: a freeway runs raised (7 m; 11 m within 80 m of a river) over crowded land, else on the ground,
     climbing or falling at most 5% (ramps). Roads crossing a freeway on the ground go over it at 7.5 m above
     it (their approaches at 5%); roads under a raised freeway stay on the ground. See grade(). */
  const CROWD = 8, SLOPE = 0.05, UPGRADE_JAM = 3;
  // a road's straight continuation through node n, coming by edge e (a road of the same level, within 30
  // degrees), or -1
  function straightOn(n, e, lev){
    const o = other(e, n), dx = nx[n] - nx[o], dz = nz[n] - nz[o], L = Math.hypot(dx, dz) || 1;
    let best = -1, bc = 0.85;
    for (const f of nedges[n]){
      if (f === e || (lev >= 0 && elev[f] !== lev) || eramp[f]) continue;
      const m = other(f, n), fx = nx[m] - nx[n], fz = nz[m] - nz[n], cs = (dx * fx + dz * fz) / (L * (Math.hypot(fx, fz) || 1));
      if (cs > bc){ bc = cs; best = f; }
    }
    return best;
  }
  /** the corridor of main roads through edge e: nodes in order and the edges between */
  function corridor(e){
    const nodes = [ea[e], eb[e]], edges = [e], seen = new Set([e]);
    let len = elen(e);
    for (const end of [1, 0]){
      for (;;){
        const n = end ? nodes[nodes.length - 1] : nodes[0], ein = end ? edges[edges.length - 1] : edges[0];
        const f = straightOn(n, ein, 3);
        if (f < 0 || seen.has(f) || len > 12000) break;
        seen.add(f); len += elen(f);
        if (end){ edges.push(f); nodes.push(other(f, n)); } else { edges.unshift(f); nodes.unshift(other(f, n)); }
      }
    }
    return { nodes, edges, len };
  }
  // move edge f's end at node n to node n2
  function detach(f, n, n2){
    mark(f, -1);
    if (ea[f] === n) ea[f] = n2; else eb[f] = n2;
    { const l = nedges[n], i = l.indexOf(f); if (i >= 0){ l[i] = l[l.length - 1]; l.pop(); } }
    nedges[n2].push(f); bucketEdge(f); mark(f, 1);
  }
  // raise a road to height H at node m, sloping down to the ground along it both ways (an overpass); where
  // the slope reaches the ground within an edge, a node there
  function rise(m, H){
    nh[m] = Math.max(nh[m], H);
    const D = H / SLOPE;
    for (const e0 of nedges[m].slice()){
      let n = m, e = e0, d = 0;
      for (let k = 0; k < 40 && e >= 0; k++){
        const o = other(e, n), L = elen(e);
        if (d + L > D){
          const t = (D - d) / L;
          if (t > 0.05){ const q = splitAt(e, nx[n] + (nx[o] - nx[n]) * t, nz[n] + (nz[o] - nz[n]) * t, nborn[n]); nh[q] = 0; }
          break;
        }
        d += L;
        nh[o] = Math.max(nh[o], H - SLOPE * d);
        const next = straightOn(o, e, -1);
        n = o; e = next;
      }
    }
  }
  /** heights along a freeway's nodes: raised over crowded land and near rivers, then slopes limited; ends:
   *  the heights its two ends must have (null: free), 0 where it ends on a road, a freeway's height where it
   *  branches from one */
  function heightsAlong(nodes, ends = null){
    const H = nodes.map((n) => c.nearRiver(nx[n], nz[n], 80) ? 11 : c.crowd(nx[n], nz[n], 100) >= CROWD ? 7 : 0);
    // (a short stretch of ground between raised stretches stays raised)
    for (let k = 1; k < nodes.length - 1; k++) if (!H[k] && H[k - 1] && H[k + 1]) H[k] = Math.min(H[k - 1], H[k + 1]);
    const d = (i, j) => Math.hypot(nx[nodes[i]] - nx[nodes[j]], nz[nodes[i]] - nz[nodes[j]]);
    for (let k = 1; k < nodes.length; k++) H[k] = Math.max(H[k], H[k - 1] - SLOPE * d(k, k - 1));
    for (let k = nodes.length - 2; k >= 0; k--) H[k] = Math.max(H[k], H[k + 1] - SLOPE * d(k, k + 1));
    const last = nodes.length - 1;
    if (ends){
      if (ends[0] !== null) H[0] = ends[0];
      if (ends[1] !== null) H[last] = ends[1];
      for (let k = 1; k <= last; k++) H[k] = Math.min(H[k], H[k - 1] + SLOPE * d(k, k - 1));
      for (let k = last - 1; k >= 0; k--) H[k] = Math.min(H[k], H[k + 1] + SLOPE * d(k, k + 1));
      for (let k = 1; k <= last; k++) H[k] = Math.max(H[k], H[k - 1] - SLOPE * d(k, k - 1));
      for (let k = last - 1; k >= 0; k--) H[k] = Math.max(H[k], H[k + 1] - SLOPE * d(k, k + 1));
    }
    nodes.forEach((n, k) => { const fixed = ends && ((k === 0 && ends[0] !== null) || (k === last && ends[1] !== null)); nh[n] = fixed ? H[k] : Math.max(nh[n], H[k]); });
  }
  // a node on the freeway about dist m along it from node k of the corridor (forward dir +1 or back -1),
  // splitting an edge if needed (the corridor keeps track) @returns {number} or -1
  function alongCorridor(cor, k, dist, dir, born){
    let d = 0, i = k;
    for (;;){
      const j = i + dir;
      if (j < 0 || j >= cor.nodes.length) return -1;
      const idx = Math.min(i, j), e = cor.edges[idx], L = elen(e);
      if (d + L >= dist){
        const a = cor.nodes[i], b = cor.nodes[j], t = (dist - d) / L;
        if (t < 0.15) return a;
        if (t > 0.85) return b;
        const m = splitAt(e, nx[a] + (nx[b] - nx[a]) * t, nz[a] + (nz[b] - nz[a]) * t, born);
        const lo = cor.nodes[idx], hi = cor.nodes[idx + 1];
        cor.nodes.splice(idx + 1, 0, m);
        cor.edges.splice(idx, 1, edgeBetween(lo, m), edgeBetween(m, hi));
        return m;
      }
      d += L; i = j;
    }
  }
  /** make the corridor a freeway (converted in place) */
  function convert(cor, born, sf){
    for (const e of cor.edges){ elev[e] = 4; ew[e] = LEVEL_W[4]; esf[e] = Math.max(esf[e], sf); eh[e] = 1; ejam[e] = 0; }
    heightsAlong(cor.nodes);
    const inCor = new Set(cor.edges);
    let sinceIx = 1e9, acc = 0;
    const plan = [];
    for (let k = 0; k < cor.nodes.length; k++){
      const n = cor.nodes[k];
      if (k > 0) acc += elen(cor.edges[k - 1]);
      const others = nedges[n].filter((f) => !inCor.has(f) && elev[f] !== 4);
      if (!others.length) continue;
      const main = others.some((f) => elev[f] >= 3);
      const end = k === 0 || k === cor.nodes.length - 1;
      if (end) continue;                                    // (the freeway's ends meet the roads at grade)
      if (main && (acc - sinceIx >= 1500 || sinceIx === 1e9)){ plan.push([n, 'ix']); sinceIx = acc; }
      else plan.push([n, 'cross']);
    }
    for (const [n, what] of plan){
      const others = nedges[n].filter((f) => !inCor.has(f) && elev[f] !== 4 && !eramp[f]);
      if (!others.length) continue;
      // the roads that meet it move to a node of their own at the same spot (over, under or cut)
      const n2 = addNode(nx[n], nz[n], ntag[n], born);
      const busy = (f) => elev[f] >= 3 || eload[f] >= 0.1;
      const keep = what === 'ix' ? others : others.filter((f) => busy(f) && straightOn(n, f, -1) >= 0 && others.includes(straightOn(n, f, -1)));
      // (a road whose far side cannot reach the other roads here another way is kept too, over or under: a
      // freeway never cuts a piece of the network off)
      if (what !== 'ix') for (const f of others){
        if (keep.includes(f)) continue;
        const far = new Set(others.filter((g) => g !== f).map((g) => other(g, n)));
        if ((far.size && !reaches(other(f, n), far, n)) || !reaches(other(f, n), new Set(), n, -1, 3000, true)) keep.push(f);
      }
      for (const f of others){
        if (keep.includes(f)){ detach(f, n, n2); continue; }
        // cut: it ends 25 m short
        const o = other(f, n), L = elen(f);
        if (L > 40){ const q = splitAt(f, nx[n] + (nx[o] - nx[n]) * 25 / L, nz[n] + (nz[o] - nz[n]) * 25 / L, born); const g = edgeBetween(n, q); if (g >= 0) removeEdge(g, born); }
        else removeEdge(f, born);
      }
      if (!nedges[n2].length) continue;
      if (nh[n] >= 5) nh[n2] = 0; else rise(n2, nh[n] + 7.5);
      // an interchange where planned, or where the roads here would otherwise be left an island (a town
      // strung along the old road, its only way out along it)
      if (what === 'ix' || !reaches(n2, new Set(), -1, -1, 3000, true)) diamond(cor, n, n2, born, sf);
    }
  }
  /** a diamond interchange where crossing road node n2 passes over or under freeway node n of corridor cor:
   *  ramps from the freeway 150 m either side to the crossing road 60 m either side */
  function diamond(cor, n, n2, born, sf){
    const legs = nedges[n2].slice(0, 2);
    const fwd = alongCorridor(cor, cor.nodes.indexOf(n), 150, 1, born), back = alongCorridor(cor, cor.nodes.indexOf(n), 150, -1, born);
    const ends = legs.map((f) => { const o = other(f, n2), L = elen(f); return L > 80 ? splitAt(f, nx[n2] + (nx[o] - nx[n2]) * 60 / L, nz[n2] + (nz[o] - nz[n2]) * 60 / L, born) : o; });
    for (const fn of [fwd, back]) for (const cn of ends){
      if (fn < 0 || cn < 0) continue;
      const r = rawEdge(fn, cn, 2, born, etag[cor.edges[0]], sf);
      eramp[r] = 1; ew[r] = 7;
      clearAlong([fn, cn], 8);
    }
  }
  /** a bypass: a new freeway from the corridor's first node to its last, around crowded land @returns {boolean} */
  function bypass(cor, born, sf){
    const A = cor.nodes[0], Bn = cor.nodes[cor.nodes.length - 1];
    const crowdCell = (k) => { const x = -c.half + ((k % R.rres) + 0.5) * R.rcell, z = -c.half + (((k / R.rres) | 0) + 0.5) * R.rcell; return 1 + 0.5 * c.crowd(x, z, 80); };
    const cells = R.route(R.at(nx[A], nz[A]), R.at(nx[Bn], nz[Bn]), crowdCell, false);
    if (!cells) return false;
    cells.reverse();
    const pts = [];
    for (let k = 2; k < cells.length - 2; k += 2){ const q = cells[k]; pts.push([-c.half + ((q % R.rres) + 0.5) * R.rcell, -c.half + (((q / R.rres) | 0) + 0.5) * R.rcell]); }
    for (let pass = 0; pass < 3; pass++) for (let k = 1; k < pts.length - 1; k++) pts[k] = [(pts[k - 1][0] + 2 * pts[k][0] + pts[k + 1][0]) / 4, (pts[k - 1][1] + 2 * pts[k][1] + pts[k + 1][1]) / 4];
    const nodes = [A];
    for (const [x, z] of pts) nodes.push(addNode(x, z, c.tagAt(x, z), born));
    nodes.push(Bn);
    for (let k = 0; k + 1 < nodes.length; k++) addEdge(nodes[k], nodes[k + 1], 4, born, etag[cor.edges[0]], sf);
    heightsAlong(nodes);
    return true;
  }
  // the cost of a corridor as a freeway in place, and of a bypass of it
  function costs(cor){
    let conv = 0;
    for (let k = 0; k + 1 < cor.nodes.length; k++){
      const a = cor.nodes[k], b = cor.nodes[k + 1], L = elen(cor.edges[k]);
      conv += L * (c.crowd((nx[a] + nx[b]) / 2, (nz[a] + nz[b]) / 2, 100) >= CROWD ? 3 : 1);
    }
    // (a bypass: about 1.3 times as long, on open land, and its extra length paid by the traffic again)
    const by = cor.len * 1.3 + cor.len * 0.3 * 2;
    return { conv, by };
  }
  /** freeways where main roads stay crowded @returns {number} built */
  function freeways(born, o){
    let built = 0;
    const done = new Set();
    for (let e = 0; e < ea.length && built < 3; e++){
      if (edied[e] || elev[e] !== 3 || ejam[e] < UPGRADE_JAM || done.has(e)) continue;
      const own = o.keeper(c.tagAt((nx[ea[e]] + nx[eb[e]]) / 2, (nz[ea[e]] + nz[eb[e]]) / 2)) || o.keeper(etag[e]);
      if (!own || o.maxLevel(own) < 4 || !o.canRepair(own)) continue;
      const cor = corridor(e);
      for (const f of cor.edges) done.add(f);
      if (cor.len < 1200) continue;
      const k = costs(cor), sf = o.best(own, 4);
      if (k.by < k.conv && bypass(cor, born, sf)){ for (const f of cor.edges) ejam[f] = 0; built++; continue; }
      convert(cor, born, sf); built++;
    }
    return built;
  }
  // ---- freeways planned: between cities, and in big cities ----
  /* Two more ways a freeway is built, both by a settlement that knows cars and has fed people:
       between cities   two big towns (BIG people or more) 4 to 30 km apart, for the people travelling between
                        them (more the bigger and nearer they are) and their trade: a freeway
                        from near the middle of one to near the middle of the other, planned for
                        directness and gentle slopes, around crowded land where it can. As more towns grow big
                        and trade more, the freeways join up into a web (a pair already joined by freeways
                        saves little from another).
       in a city        a town of CITY people or more: a freeway across it (along the way most of its homes
                        lie, passing beside its middle), later a second across the first; or, in a city of
                        RING_POP people or more, a ring around the edge of its built-up part (for traffic passing
                        through and between its outer parts). The candidates are weighed against each other, one built
                        at a time (a town looks again every CITY_EVERY ticks).
     Each must pay: the travel time it saves over the trips that would use it, against its length (more over
     crowded land). Times are estimates from the streets' speeds as they are now (cityOf, lineCost).
     Interchanges (diamonds) where it crosses main roads, at least 1.5 km apart (in a city 1 km, and busy
     streets count too) and 400 m from its ends; other
     crossings are left to grade(). A freeway clears its way: it demolishes the buildings in it, though where
     it runs raised it sometimes passes over a small one (a single storey: see demolish in src/gen/sim.js).
     Freeway meets freeway: a junction for now (interchanges between freeways are left for later). */
  const BIG = 5000, CITY = 5000, RING_POP = 10000, PAY_PAIR = 0.025, PAY_CITY = 0.05, CITY_EVERY = 4;
  // people travelling between two cities each tick: GRAVITY x one's people x the other's / their distance (m)
  // (the usual gravity rule: bigger and nearer cities exchange more), on top of their trade
  const GRAVITY = 0.05, PAIR_MAX = 30000, PAIR_LOOK = 12;
  const fwLog = [], tried = new Map();
  // routing cells within about 400 m of a freeway (a new one pays 4x to run there: no two side by side)
  const fwNear = new Uint8Array(R.rres * R.rres);
  function markFreeways(){
    fwNear.fill(0);
    const rr = Math.ceil(400 / R.rcell);
    for (let e = 0; e < ea.length; e++){
      if (edied[e] || elev[e] !== 4) continue;
      const a = ea[e], b = eb[e], n = Math.max(1, Math.ceil(elen(e) / R.rcell));
      for (let i = 0; i <= n; i++){
        const k = R.at(nx[a] + (nx[b] - nx[a]) * i / n, nz[a] + (nz[b] - nz[a]) * i / n), ci = k % R.rres, cj = (k / R.rres) | 0;
        for (let dj = -rr; dj <= rr; dj++) for (let di = -rr; di <= rr; di++){
          const ii = ci + di, jj = cj + dj;
          if (ii >= 0 && jj >= 0 && ii < R.rres && jj < R.rres && di * di + dj * dj <= rr * rr) fwNear[jj * R.rres + ii] = 1;
        }
      }
    }
  }
  let ticks = 0;
  const cellXZ = (k) => [-c.half + ((k % R.rres) + 0.5) * R.rcell, -c.half + (((k / R.rres) | 0) + 0.5) * R.rcell];
  /** a route for a freeway over the land, from (x0, z0) to (x1, z1): crowded land costs more (crowdK per
   *  building within 60 m) @returns {number[][] | null} points */
  function routePts(x0, z0, x1, z1, crowdK){
    const cells = R.route(R.at(x0, z0), R.at(x1, z1), (k) => { const [x, z] = cellXZ(k); return (1 + crowdK * c.crowd(x, z, 60)) * (fwNear[k] ? 4 : 1); }, false);
    if (!cells) return null;
    cells.reverse();
    const pts = [[x0, z0]];
    for (let k = 2; k < cells.length - 2; k += 2) pts.push(cellXZ(cells[k]));
    pts.push([x1, z1]);
    for (let pass = 0; pass < 3; pass++) for (let k = 1; k < pts.length - 1; k++) pts[k] = [(pts[k - 1][0] + 2 * pts[k][0] + pts[k + 1][0]) / 4, (pts[k - 1][1] + 2 * pts[k][1] + pts[k + 1][1]) / 4];
    return pts;
  }
  /** lay a freeway through points pts, from node A to node Bn (-1: new nodes there; closed: back to its start)
   *  @returns {{ nodes: number[], edges: number[], len: number }} */
  function layFreeway(pts, A, Bn, born, tag, sf, closed = false){
    const ends = [A >= 0 ? A : addNode(pts[0][0], pts[0][1], c.tagAt(pts[0][0], pts[0][1]), born)];
    for (let k = 1; k < pts.length - (closed ? 0 : 1); k++) ends.push(addNode(pts[k][0], pts[k][1], c.tagAt(pts[k][0], pts[k][1]), born));
    if (closed) ends.push(ends[0]);
    else { const q = pts[pts.length - 1]; ends.push(Bn >= 0 ? Bn : addNode(q[0], q[1], c.tagAt(q[0], q[1]), born)); }
    const nodes = [ends[0]], edges = [];
    let len = 0;
    for (let k = 0; k + 1 < ends.length; k++){
      if (ends[k] === ends[k + 1]) continue;
      let cur = ends[k];
      for (const e of addEdge(ends[k], ends[k + 1], 4, born, tag, sf)){ const o = other(e, cur); edges.push(e); nodes.push(o); len += elen(e); cur = o; }
    }
    return { nodes, edges, len };
  }
  /** demolish the buildings in the way of a road through nodes (half width r); over a raised stretch a
   *  single-storey building sometimes stays (the road passes over it) */
  function clearAlong(nodes, r){
    if (!c.demolish) return;
    for (let k = 0; k + 1 < nodes.length; k++){
      const a = nodes[k], b = nodes[k + 1], L = Math.hypot(nx[b] - nx[a], nz[b] - nz[a]), n = Math.max(1, Math.ceil(L / 20));
      for (let i = 0; i <= n; i++){ const t = i / n; c.demolish(nx[a] + (nx[b] - nx[a]) * t, nz[a] + (nz[b] - nz[a]) * t, r, nh[a] + (nh[b] - nh[a]) * t >= 6.5); }
    }
  }
  /** a new freeway's interchanges: diamonds where it crosses main roads, at least gap apart (in a city also
   *  busy streets: town) @returns {number} made */
  function interchanges(cor, born, sf, closed, gap = 1500, town = false){
    const fit = (g) => !eramp[g] && (elev[g] === 3 || (town && elev[g] === 2 && eload[g] >= 0.2));
    const hits = [];
    let acc = 0;
    for (let k = 0; k < cor.edges.length; k++){
      const p = cor.nodes[k], q = cor.nodes[k + 1], ax = nx[p], az = nz[p], dx = nx[q] - ax, dz = nz[q] - az, L = Math.hypot(dx, dz);
      edgesNear(Math.min(ax, nx[q]), Math.min(az, nz[q]), Math.max(ax, nx[q]), Math.max(az, nz[q]), (g) => {
        if (!fit(g)) return;
        const a = ea[g], b = eb[g], ex = nx[b] - nx[a], ez = nz[b] - nz[a], den = dx * ez - dz * ex;
        if (Math.abs(den) < 1e-9) return;
        const t = ((nx[a] - ax) * ez - (nz[a] - az) * ex) / den, u = ((nx[a] - ax) * dz - (nz[a] - az) * dx) / den;
        if (t > 0 && t < 1 && u > 0.02 && u < 0.98) hits.push([acc + t * L, ax + dx * t, az + dz * t]);
      });
      acc += L;
    }
    hits.sort((p, q) => p[0] - q[0]);
    let last = -1e9, made = 0;
    for (const [d, x, z] of hits){
      if (d - last < gap || (!closed && (d < 400 || d > cor.len - 400))) continue;
      // the freeway's edge and the main road's edge through (x, z) now (earlier interchanges split edges)
      let fk = -1, g = -1;
      for (let k = 0; k < cor.edges.length && fk < 0; k++){ const e = cor.edges[k]; if (!edied[e] && segDist(x, z, nx[ea[e]], nz[ea[e]], nx[eb[e]], nz[eb[e]]) < 1) fk = k; }
      edgesNear(x - 2, z - 2, x + 2, z + 2, (h) => { if (g < 0 && fit(h) && segDist(x, z, nx[ea[h]], nz[ea[h]], nx[eb[h]], nz[eb[h]]) < 1) g = h; });
      if (fk < 0 || g < 0) continue;
      const lo = cor.nodes[fk], hi = cor.nodes[fk + 1], F = splitAt(cor.edges[fk], x, z, born);
      if (F !== lo && F !== hi){ cor.nodes.splice(fk + 1, 0, F); cor.edges.splice(fk, 1, edgeBetween(lo, F), edgeBetween(F, hi)); }
      const X = splitAt(g, x, z, born);
      if (X === F || nedges[X].length < 2) continue;
      if (nh[F] >= 5) nh[X] = 0; else rise(X, nh[F] + 7.5);
      diamond(cor, F, X, born, sf);
      last = d; made++;
    }
    return made;
  }
  /** how a big town lies for freeways: the radius holding 90% of its town homes' people (m), how slow its
   *  streets are (s per m from its middle, for a typical home), and its homes [x, z, people, s to the middle] */
  function cityOf(s, o){
    const hs = o.homes.get(s.id);
    if (!hs) return null;
    const pts = [];
    for (let k = 0; k < hs.length; k += 4) if (hs[k + 3]) pts.push([hs[k], hs[k + 1], hs[k + 2], Math.hypot(hs[k] - s.core[0], hs[k + 1] - s.core[1])]);
    if (pts.length < 20) return null;
    pts.sort((p, q) => p[3] - q[3]);
    let all = 0; for (const p of pts) all += p[2];
    let acc = 0, r90 = pts[pts.length - 1][3], r75 = 0;
    for (const p of pts){ acc += p[2]; if (!r75 && acc >= 0.75 * all) r75 = p[3]; if (acc >= 0.9 * all){ r90 = p[3]; break; } }
    const T0 = tree(s.coreNode, 2.5 * r90 + 1000), homes = [], rat = [];
    for (const p of pts){
      const n = nearestNode(p[0], p[1], 250);
      if (n < 0 || !T0.reached(n) || p[3] < 50) continue;
      homes.push([p[0], p[1], p[2], gS[n]]); rat.push(gS[n] / p[3]);
    }
    if (!homes.length) return null;
    rat.sort((p, q) => p - q);
    return { r: Math.max(300, r90), edge: Math.max(400, 1.1 * r75), slow: rat[rat.length >> 1], homes, people: all };
  }
  // a freeway's estimated cost: its length (m), more over crowded land (sampled every 200 m along the line)
  function lineCost(x0, z0, x1, z1){
    const L = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.ceil(L / 200));
    let k = 0; for (let i = 0; i <= n; i++) k += c.crowd(x0 + (x1 - x0) * i / n, z0 + (z1 - z0) * i / n, 60);
    return L * (1 + 0.05 * k / (n + 1));
  }
  /** the end of a freeway near (x, z): a main road's node within 600 m (a street's counts double the distance) */
  function endNode(x, z){
    let best = -1, bd = 600;
    const k = Math.ceil(600 / NB), ci = Math.floor(x / NB), cj = Math.floor(z / NB);
    for (let b = -k; b <= k; b++) for (let a = -k; a <= k; a++) for (const id of nbk.get(key(ci + a, cj + b)) || []){
      if (nh[id] > 0.5 || !nedges[id].some((e) => elev[e] >= 2 && elev[e] < 4 && !eramp[e])) continue;
      const main = nedges[id].some((e) => elev[e] === 3), d = Math.hypot(nx[id] - x, nz[id] - z) * (main ? 1 : 2);
      if (d < bd){ bd = d; best = id; }
    }
    return best;
  }
  /** a freeway node a new freeway from (x0, z0) to (x1, z1) can branch from: one at most 25% out of its way
   *  that brings it closest to (x1, z1), at least 1 km closer than (x0, z0) is (else -1) */
  function forkNode(x0, z0, x1, z1){
    const D = Math.hypot(x1 - x0, z1 - z0);
    let best = -1, bd = D - 1000;
    for (let e = 0; e < ea.length; e++){
      if (edied[e] || elev[e] !== 4) continue;
      for (const n of [ea[e], eb[e]]){
        const a = Math.hypot(nx[n] - x0, nz[n] - z0), b = Math.hypot(x1 - nx[n], z1 - nz[n]);
        if (a + b <= 1.25 * D && b < bd && nedges[n].length <= 2){ bd = b; best = n; }
      }
    }
    return best;
  }
  /** a freeway from near (x0, z0) to near (x1, z1), ending on the roads there, or branching from a freeway
   *  already heading its way (fork: see forkNode); crowdK: how much it keeps off crowded land
   *  @returns {object | null} */
  function buildLine(x0, z0, x1, z1, crowdK, born, s, sf, fork = false, town = false){
    let A = fork ? forkNode(x0, z0, x1, z1) : -1, Bn = fork ? forkNode(x1, z1, x0, z0) : -1;
    if (A >= 0 && Bn >= 0 && Math.hypot(nx[A] - nx[Bn], nz[A] - nz[Bn]) < 2000) return null;   // (joined already, near enough)
    if (A < 0) A = endNode(x0, z0);
    if (Bn < 0) Bn = endNode(x1, z1);
    if (A < 0 || Bn < 0 || A === Bn) return null;
    const isFw = (n) => nedges[n].some((e) => elev[e] === 4);
    const pts = routePts(nx[A], nz[A], nx[Bn], nz[Bn], crowdK);
    if (!pts) return null;
    const ends = [isFw(A) ? nh[A] : 0, isFw(Bn) ? nh[Bn] : 0];
    const cor = layFreeway(pts, A, Bn, born, s.id, sf);
    if (cor.edges.length < 2) return null;
    heightsAlong(cor.nodes, ends);
    clearAlong(cor.nodes, LEVEL_W[4] / 2 + 6);
    cor.ix = interchanges(cor, born, sf, false, town ? 1000 : 1500, town);
    return cor;
  }
  /** a ring of freeway around s's middle at radius r */
  function buildRing(s, r, born, sf){
    const N = Math.max(8, Math.round(2 * Math.PI * r / 600)), way = [];
    for (let k = 0; k <= N; k++){ const a = 2 * Math.PI * k / N; way.push([s.core[0] + Math.cos(a) * r, s.core[1] + Math.sin(a) * r]); }
    const pts = [];
    for (let k = 0; k < N; k++){
      const seg = routePts(way[k][0], way[k][1], way[k + 1][0], way[k + 1][1], 0.15);
      if (!seg) return null;
      for (let i = k ? 1 : 0; i < seg.length; i++) pts.push(seg[i]);
    }
    pts.pop();                                      // (the last point is the first again)
    const cor = layFreeway(pts, -1, -1, born, s.id, sf, true);
    if (cor.edges.length < 4) return null;
    heightsAlong(cor.nodes);
    clearAlong(cor.nodes, LEVEL_W[4] / 2 + 6);
    cor.ix = interchanges(cor, born, sf, true, 1000, true);
    return cor;
  }
  /** freeways between big towns and in big cities; through: trade passing through each big town's middle
   *  @returns {number} built */
  function planned(born, o, through){
    ticks++;
    let built = 0;
    markFreeways();
    const big = [], info = new Map();
    for (const [s] of o.towns){
      if (s.pop < BIG || o.maxLevel(s) < 4 || !o.canRepair(s) || !nedges[s.coreNode].length) continue;
      const ci = cityOf(s, o);
      if (!ci) continue;
      s.fwR = ci.r; big.push(s); info.set(s, ci);
    }
    // between cities: the pairs with the most travel between them first (each looked at again after 3 ticks)
    const trade = new Map();
    for (const [A, Bt, amt] of o.flows) trade.set(Math.min(A.id, Bt.id) * 1e6 + Math.max(A.id, Bt.id), amt);
    const pairs = [];
    for (let i = 0; i < big.length; i++) for (let j = i + 1; j < big.length; j++){
      const A = big[i], Bt = big[j], d = Math.hypot(A.core[0] - Bt.core[0], A.core[1] - Bt.core[1]);
      if (d < 4000 || d > PAIR_MAX) continue;
      const pk = Math.min(A.id, Bt.id) * 1e6 + Math.max(A.id, Bt.id);
      if ((tried.get(pk) || 0) > ticks) continue;
      pairs.push([A, Bt, d, pk, GRAVITY * A.pop * Bt.pop / d + (trade.get(pk) || 0) * TRADE_K]);
    }
    pairs.sort((p, q) => q[4] - p[4]);
    for (const [A, Bt, d, pk, trips] of pairs.slice(0, PAIR_LOOK)){
      if (built >= 2) break;
      tried.set(pk, ticks + 3);
      if (!connected(A.coreNode, Bt.coreNode) || !fastest(A.coreNode, Bt.coreNode, d * 2 + 20000)) continue;
      const t0 = gS[Bt.coreNode], ia = info.get(A), ib = info.get(Bt);
      const t1 = (d * 1.15 - 0.6 * (ia.r + ib.r)) / 25 + 0.6 * (ia.r * ia.slow + ib.r * ib.slow) + 60;
      const save = Math.max(0, t0 - t1) * trips, cost = lineCost(A.core[0], A.core[1], Bt.core[0], Bt.core[1]);
      const rec = { born, kind: 'pair', a: A.id, b: Bt.id, pops: [Math.round(A.pop), Math.round(Bt.pop)], d: Math.round(d), t0: Math.round(t0), t1: Math.round(t1), trips: Math.round(trips), ratio: +(save * PAY_PAIR / cost).toFixed(2), built: false };
      fwLog.push(rec);
      if (save * PAY_PAIR < cost) continue;
      const ux = (Bt.core[0] - A.core[0]) / d, uz = (Bt.core[1] - A.core[1]) / d;
      const cor = buildLine(A.core[0] + ux * 0.6 * ia.r, A.core[1] + uz * 0.6 * ia.r, Bt.core[0] - ux * 0.6 * ib.r, Bt.core[1] - uz * 0.6 * ib.r, 0.3, born, A, o.best(A, 4), true);
      if (cor){ rec.built = true; rec.km = +(cor.len / 1000).toFixed(1); rec.ix = cor.ix; built++; tried.set(pk, 1e9); markFreeways(); }
    }
    // in cities: the biggest first, one freeway each at a time
    for (const s of big.sort((p, q) => q.pop - p.pop)){
      if (built >= 4) break;
      if (s.pop < CITY || (s.fwNext || 0) > ticks) continue;
      s.fwNext = ticks + CITY_EVERY;
      const ci = info.get(s), r = ci.r, cx = s.core[0], cz = s.core[1];
      const cands = [];
      // across it: along the way most of its homes lie (the people-weighted main axis), a second square to the first
      if ((s.fwCross || 0) < 2){
        let sxx = 0, szz = 0, sxz = 0;
        for (const [x, z, p] of ci.homes){ const dx = x - cx, dz = z - cz; sxx += p * dx * dx; szz += p * dz * dz; sxz += p * dx * dz; }
        const th = s.fwCross ? s.fwAxis + Math.PI / 2 : 0.5 * Math.atan2(2 * sxz, sxx - szz);
        const ux = Math.cos(th), uz = Math.sin(th), off = 0.15 * r, ox = -uz * off, oz = ux * off;
        let save = 0;
        for (const [x, z, p, t] of ci.homes){
          const dx = x - cx - ox, dz = z - cz - oz, u = dx * ux + dz * uz, v = Math.abs(-dx * uz + dz * ux);
          if (Math.abs(u) > 1.3 * r) continue;
          // (to the freeway on streets, to the interchange nearest it (375 m on average), along it, and from
          // where it passes the middle to the middle)
          const alt = (v + 375 + off) * ci.slow + Math.abs(u) / 25 + 30;
          save += p * Math.max(0, t - alt);
        }
        const x0 = cx + ox - ux * 1.3 * r, z0 = cz + oz - uz * 1.3 * r, x1 = cx + ox + ux * 1.3 * r, z1 = cz + oz + uz * 1.3 * r;
        cands.push({ kind: 'cross', save, cost: lineCost(x0, z0, x1, z1), x0, z0, x1, z1, th });
      }
      // around it: for traffic passing through, and a little for trips between its outer parts
      if (!s.fwRing && s.pop >= RING_POP){
        const re = ci.edge, thr = (through.get(s) || 0) * TRADE_K, across = 2 * re * ci.slow, around = Math.PI * re / 25 + 60;
        let outer = 0;
        for (const [x, z, p] of ci.homes) if (Math.hypot(x - cx, z - cz) > 0.6 * re) outer += p;
        cands.push({ kind: 'ring', save: (thr + 0.1 * outer) * Math.max(0, across - around), cost: 2 * Math.PI * re * 1.3 });
      }
      let best = null;
      for (const k of cands){ k.ratio = k.save * PAY_CITY / k.cost; if (!best || k.ratio > best.ratio) best = k; }
      if (!best) continue;
      const rec = { born, kind: best.kind, town: s.id, pop: Math.round(s.pop), r: Math.round(r), slow: +ci.slow.toFixed(3), ratio: +best.ratio.toFixed(2), others: cands.filter((k) => k !== best).map((k) => k.kind + ' ' + k.ratio.toFixed(2)).join(', '), built: false };
      fwLog.push(rec);
      if (best.ratio < 1) continue;
      const sf = o.best(s, 4);
      const cor = best.kind === 'ring' ? buildRing(s, ci.edge, born, sf) : buildLine(best.x0, best.z0, best.x1, best.z1, 0.08, born, s, sf, true, true);
      if (!cor) continue;
      rec.built = true; rec.km = +(cor.len / 1000).toFixed(1); rec.ix = cor.ix; built++; markFreeways();
      if (best.kind === 'ring') s.fwRing = 1; else { s.fwCross = (s.fwCross || 0) + 1; if (s.fwCross === 1) s.fwAxis = best.th; }
    }
    return built;
  }
  /** where a freeway and another road cross (with no junction) but at nearly the same height: the road goes
   *  over the freeway (busy roads), or is cut short of it */
  function grade(born){
    for (let f = 0; f < ea.length; f++){
      if (edied[f] || elev[f] !== 4) continue;
      const p = ea[f], q = eb[f], ax = nx[p], az = nz[p], dx = nx[q] - ax, dz = nz[q] - az;
      const hits = [];
      edgesNear(Math.min(ax, nx[q]), Math.min(az, nz[q]), Math.max(ax, nx[q]), Math.max(az, nz[q]), (g) => {
        if (elev[g] === 4) return;
        const a = ea[g], b = eb[g];
        if (a === p || a === q || b === p || b === q) return;
        const ex = nx[b] - nx[a], ez = nz[b] - nz[a], den = dx * ez - dz * ex;
        if (Math.abs(den) < 1e-9) return;
        const t = ((nx[a] - ax) * ez - (nz[a] - az) * ex) / den, u = ((nx[a] - ax) * dz - (nz[a] - az) * dx) / den;
        if (t > 0 && t < 1 && u > 0 && u < 1) hits.push([g, t, u]);
      });
      for (const [g, t, u] of hits){
        if (edied[g]) continue;
        const hf = nh[p] + (nh[q] - nh[p]) * t, hg = nh[ea[g]] + (nh[eb[g]] - nh[ea[g]]) * u;
        if (Math.abs(hf - hg) >= 5.5) continue;
        const x = ax + dx * t, z = az + dz * t;
        if (hf >= 5){ if (hg > 0.5) continue; continue; }      // (under a raised freeway: fine on the ground)
        // (a quiet road is cut, unless its two sides cannot reach each other another way: then it goes over)
        const cutOff = !reaches(ea[g], new Set([eb[g]]), -1, g);
        if (elev[g] >= 3 || eload[g] >= 0.1 || eramp[g] || cutOff){ const m = splitAt(g, x, z, born); rise(m, hf + 7.5); }
        else {
          const m = splitAt(g, x, z, born);
          for (const h of nedges[m].slice()){
            const o = other(h, m), L = elen(h);
            if (L > 40){ const r2 = splitAt(h, nx[m] + (nx[o] - nx[m]) * 25 / L, nz[m] + (nz[o] - nz[m]) * 25 / L, born); const g2 = edgeBetween(m, r2); if (g2 >= 0) removeEdge(g2, born); }
            else removeEdge(h, born);
          }
        }
      }
    }
  }

  // junctions joined by a road shorter than MERGE: one junction (the shorter road goes, the roads of the
  // other end move onto this one)
  function mergeClose(born){
    let merged = 0;
    for (let e = 0; e < ea.length; e++){
      if (edied[e] || elen(e) >= MERGE) continue;
      const a = ea[e], b = eb[e];
      if (!isJunction(a) || !isJunction(b) || elev[e] === 4 || eramp[e] || nh[a] > 0.5 || nh[b] > 0.5) continue;
      if (nedges[a].some((f) => elev[f] === 4) || nedges[b].some((f) => elev[f] === 4)) continue;
      removeEdge(e, born);
      for (const f of nedges[b].slice()){
        const o = other(f, b);
        if (o === a || edgeBetween(a, o) >= 0){ removeEdge(f, born); continue; }
        mark(f, -1);
        if (ea[f] === b) ea[f] = a; else eb[f] = a;
        { const l = nedges[b], i = l.indexOf(f); if (i >= 0){ l[i] = l[l.length - 1]; l.pop(); } }
        nedges[a].push(f); bucketEdge(f); mark(f, 1);
      }
      // (the junction sits between the two)
      nx[a] = (nx[a] + nx[b]) / 2; nz[a] = (nz[a] + nz[b]) / 2;
      addTo(nbk, key(Math.floor(nx[a] / NB), Math.floor(nz[a] / NB)), a);
      for (const f of nedges[a]) bucketEdge(f);
      merged++;
    }
    return merged;
  }
  // the settlement keeping edge e: the one whose land it is on now, else the one that built it
  const keeperOf = (e, o) => o.keeper(c.tagAt((nx[ea[e]] + nx[eb[e]]) / 2, (nz[ea[e]] + nz[eb[e]]) / 2)) || o.keeper(etag[e]);
  // the freeway a ramp joins (a live freeway edge at either end), or -1
  function rampOf(e){
    for (const n of [ea[e], eb[e]]) for (const f of nedges[n]) if (!edied[f] && elev[f] === 4) return f;
    return -1;
  }
  function tick(born, o){
    mergeClose(born);
    // how many other junctions crowd each junction (for the delay there)
    jam = new Uint8Array(nx.length);
    for (let n = 0; n < nx.length; n++){
      if (!isJunction(n)) continue;
      let k2 = 0;
      const k = Math.ceil(JAM_R / NB), ci = Math.floor(nx[n] / NB), cj = Math.floor(nz[n] / NB);
      for (let b = -k; b <= k; b++) for (let a = -k; a <= k; a++) for (const id of nbk.get(key(ci + a, cj + b)) || [])
        if (id !== n && isJunction(id) && Math.hypot(nx[id] - nx[n], nz[id] - nz[n]) < JAM_R) k2++;
      jam[n] = Math.min(4, k2);
    }
    // town trips: from each home to the town's middle, along the fastest ways (a tree from the middle); the
    // ways town homes' people take (shops, flats, workshops) stay streets at least
    const townWay = new Set();
    for (const [s, reach] of o.towns){
      if (s.coreNode === undefined || !nedges[s.coreNode].length) continue;
      const hs = o.homes.get(s.id);
      if (!hs) continue;
      const T0 = tree(s.coreNode, reach), w = new Map(), tw = new Set();
      for (let k = 0; k < hs.length; k += 4){
        const n = nearestNode(hs[k], hs[k + 1], 250);
        if (n >= 0 && T0.reached(n)){ w.set(n, (w.get(n) || 0) + hs[k + 2]); if (hs[k + 3]) tw.add(n); }
      }
      for (let k = T0.order.length - 1; k > 0; k--){
        const n = T0.order[k], v = w.get(n);
        if (!v) continue;
        const e = T0.via(n); if (e < 0) continue;
        euse[e] += v; const p = other(e, n); w.set(p, (w.get(p) || 0) + v);
        if (tw.has(n)){ townWay.add(e); tw.add(p); }
      }
    }
    // trade between towns along the fastest ways (the busiest flows first; ways found again each tick)
    const flows = o.flows.slice().sort((p, q) => q[2] - p[2]).slice(0, 250);
    const through = new Map(), passed = new Set(), bigNow = o.towns.map(([s]) => s).filter((s) => s.pop >= CITY && s.fwR);
    for (const [A, B, amt0] of flows){
      if (A.coreNode === undefined || B.coreNode === undefined || !connected(A.coreNode, B.coreNode)) continue;
      const amt = amt0 * TRADE_K;
      const k = A.id * 1e6 + B.id;
      let pth = lastRoutes.get(k);
      if (!pth || pth.some((e) => edied[e])){ pth = fastest(A.coreNode, B.coreNode, 60000); if (pth) lastRoutes.set(k, pth); }
      if (pth){
        for (const e of pth) euse[e] += amt;
        // trade passing through a big town's middle (for its ring): every few nodes of the way, near a town
        // that is neither end
        for (let i = 0; i < pth.length && bigNow.length; i += 4){
          const n = ea[pth[i]];
          for (const s of bigNow) if (s !== A && s !== B && Math.hypot(nx[n] - s.core[0], nz[n] - s.core[1]) < 0.8 * s.fwR && !passed.has(s)){ passed.add(s); through.set(s, (through.get(s) || 0) + amt0); }
        }
        passed.clear();
      }
    }
    lastRoutes = new Map([...lastRoutes].filter(([, p]) => p && !p.some((e) => edied[e])));
    if (born % 2 === 0) lastRoutes.clear();               // (and found afresh every other tick: roads change)
    // roads homes face (within 40 m of a lived-in home) are never let down a level: homes need their street
    const fronted = new Set();
    let access = 0;
    for (const hs of o.homes.values()) for (let k = 0; k < hs.length; k += 4){
      const x = hs[k], z = hs[k + 1], townHome = hs[k + 3];
      // (the nearest street or road it faces, else the nearest track or path)
      let be = -1, bd = 40, bs = -1, bsd = 40;
      edgesNear(x - 40, z - 40, x + 40, z + 40, (e) => { const d = segDist(x, z, nx[ea[e]], nz[ea[e]], nx[eb[e]], nz[eb[e]]); if (d < bd){ bd = d; be = e; } if (elev[e] >= 2 && d < bsd){ bsd = d; bs = e; } if (elev[e] >= 2 && d < 25) fronted.add(e); });
      if (bs >= 0) fronted.add(bs);
      else if (be < 0){
        // a town home with no road at all near (its street wore away while it stood empty): a street to it
        // from the nearest road, ending in front of it
        if (townHome && access++ < 400){
          const m = nearestNode(x, z, 150);
          if (m >= 0){
            const d = Math.hypot(nx[m] - x, nz[m] - z), qx = x + (nx[m] - x) * 14 / d, qz = z + (nz[m] - z) * 14 / d;
            if (d > 30){ const tg = c.tagAt(x, z); const f = addEdge(m, addNode(qx, qz, tg, born), 2, born, tg >= 0 ? tg : ntag[m], 0); for (const q of f) fronted.add(q); }
          }
        }
      } else {
        // a town home on a track or path: it is made a street again (shops and flats need one)
        fronted.add(be);
        if (townHome && elev[be] < 2){ elev[be] = 2; ew[be] = LEVEL_W[2]; }
      }
    }
    // levels and health. Roads keep their level: a road's level (footpath to freeway) changes only by
    // use, raised when crowded and let down a level after two quiet ticks (50 years), never below floorOf
    // (a paved road stays a track at least; no road more than a level below the weaker of its ends). Its
    // health (wear and repair) is separate: worn out, a road stays, broken. Only a footpath vanishes, and
    // only where nothing else needs it (mayVanish); nothing removes a road that would cut the network apart
    let gone = 0, up = 0, down = 0;
    const n = ea.length;
    for (let e = 0; e < n; e++){
      if (edied[e]) continue;
      const lev = elev[e], ld = euse[e] / CAP[lev];
      eload[e] = 0.5 * eload[e] + 0.5 * ld;
      // (kept by the settlement whose land it is on now, else the one that built it)
      const own = o.keeper(c.tagAt((nx[ea[e]] + nx[eb[e]]) / 2, (nz[ea[e]] + nz[eb[e]]) / 2)) || o.keeper(etag[e]);
      if (lev === 3){ ejam[e] = eload[e] > 1 ? ejam[e] + 1 : 0; }
      if (eload[e] > 1 && own && lev < 3 && lev < o.maxLevel(own) && o.canRepair(own)){ raise(e, born, fronted); up++; }
      else if (eload[e] < 0.02 && lev > 0 && lev < 4 && !eramp[e] && !fronted.has(e) && !(townWay.has(e) && lev <= 2) && lev - 1 >= floorOf(e)){ if (++equiet[e] >= 2){ elev[e] = lev - 1; ew[e] = LEVEL_W[lev - 1]; equiet[e] = 0; down++; } }
      else equiet[e] = 0;
      // wear and repair (a freeway's ramp is kept as the freeway is: by its keeper, to its surface, used or
      // not). Worn out, a road stays, broken, until it is mended or let down a level; only a footpath
      // vanishes (see mayVanish)
      const sf = esf[e], u = eload[e] / (eload[e] + 1);
      eh[e] -= WEAR_BASE[sf] + WEAR_USE[sf] * u;
      const fw = eramp[e] ? rampOf(e) : -1, fwOwn = fw >= 0 ? keeperOf(fw, o) : null;
      if (fwOwn){ if (eh[e] < REPAIR_AT && o.canRepair(fwOwn)){ eh[e] = 1; esf[e] = Math.max(sf, esf[fw], o.best(fwOwn, 4)); } }
      else if (eh[e] < REPAIR_AT && (euse[e] > 0 || fronted.has(e)) && own && o.canRepair(own)){ eh[e] = 1; esf[e] = Math.max(sf, o.best(own, elev[e])); }
      else if (eh[e] <= 0){ if (mayVanish(e, fronted)){ removeEdge(e, born); gone++; } else eh[e] = 0; }
      euse[e] = 0;
    }
    const fw = freeways(born, o) + planned(born, o, through);
    grade(born);
    const rejoined = rejoin(born, fronted);
    return { gone, up, down, fw, rejoined };
  }
  /** a piece of the network left on its own (any but the biggest): a track to the nearest road of a bigger
   *  piece within 400 m (not across a freeway); else a small one (under 40 roads) that no home faces goes
   *  @returns {number} pieces joined or cleared */
  function rejoin(born, fronted){
    const par = new Int32Array(nx.length);
    for (let i = 0; i < par.length; i++) par[i] = i;
    const f = (a) => { while (par[a] !== a){ par[a] = par[par[a]]; a = par[a]; } return a; };
    const live = [];
    for (let e = 0; e < ea.length; e++) if (!edied[e]){ par[f(ea[e])] = f(eb[e]); live.push(e); }
    const size = new Map(), members = new Map();
    for (const e of live){ const r = f(ea[e]); size.set(r, (size.get(r) || 0) + 1); }
    let top = -1; for (const [r, n] of size) if (top < 0 || n > size.get(top)) top = r;
    for (const e of live){ const r = f(ea[e]); if (r !== top){ let m = members.get(r); if (!m){ m = []; members.set(r, m); } m.push(e); } }
    let done = 0;
    for (const [r, es] of members){
      const nodes = new Set(); for (const e of es){ nodes.add(ea[e]); nodes.add(eb[e]); }
      let best = null, bd = 400;
      for (const a of nodes){
        const k = Math.ceil(400 / NB), ci = Math.floor(nx[a] / NB), cj = Math.floor(nz[a] / NB);
        for (let j = -k; j <= k; j++) for (let i = -k; i <= k; i++) for (const b of nbk.get(key(ci + i, cj + j)) || []){
          if (!nedges[b].length || f(b) === r || (size.get(f(b)) || 0) <= es.length || nh[b] > 0.5 || nedges[b].every((g) => elev[g] === 4)) continue;
          const d = Math.hypot(nx[b] - nx[a], nz[b] - nz[a]);
          if (d >= bd) continue;
          // (not across a freeway)
          let crosses = false;
          edgesNear(Math.min(nx[a], nx[b]), Math.min(nz[a], nz[b]), Math.max(nx[a], nx[b]), Math.max(nz[a], nz[b]), (g) => {
            if (crosses || elev[g] !== 4) return;
            const p = ea[g], q = eb[g], dx = nx[b] - nx[a], dz = nz[b] - nz[a], ex = nx[q] - nx[p], ez = nz[q] - nz[p], den = dx * ez - dz * ex;
            if (Math.abs(den) < 1e-9) return;
            const t = ((nx[p] - nx[a]) * ez - (nz[p] - nz[a]) * ex) / den, u = ((nx[p] - nx[a]) * dz - (nz[p] - nz[a]) * dx) / den;
            if (t > 0 && t < 1 && u > 0 && u < 1) crosses = true;
          });
          if (!crosses){ bd = d; best = [a, b]; }
        }
      }
      if (best){ addEdge(best[0], best[1], 1, born, ntag[best[1]], 0); done++; }
      else if (es.length < 40 && !es.some((e) => fronted.has(e))){ for (const e of es) removeEdge(e, born); done++; }
    }
    return done;
  }
  // raise edge e a level; lower roads crowding it alongside are removed to make room; a main road too close
  // beside another main road: the quieter one falls back
  function raise(e, born, fronted){
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
      if (elev[f] < lev && d < LEVEL_W[lev] / 2 + 15 && eload[f] < eload[e] * 0.5 && !fronted.has(f) && safeToRemove(f)) removeEdge(f, born);   // make room (if nothing is cut off)
      else if (lev >= 3 && elev[f] >= 3 && d < MAIN_GAP){
        if (eload[f] <= eload[e]){ elev[f] = 2; ew[f] = LEVEL_W[2]; } else { elev[e] = 2; ew[e] = LEVEL_W[2]; }
      }
    });
  }

  const wideAt = (n, e) => { let w = 0; for (const f of nedges[n]) if (f !== e && !edied[f] && elev[f] >= 2) w = Math.max(w, ew[f]); return w; };
  /** the network as plain data, with junction controls (by the streets that meet: 3 roundabout five or more
   *  ways, 2 signals two or more main roads, 1 stop sign a street meets a main road, 0 none) */
  function finish(){
    const n = ea.length;
    const jtype = new Uint8Array(nx.length), jlist = [], isJ = new Uint8Array(nx.length);
    for (let k = 0; k < nx.length; k++){
      const legs = nedges[k].filter((e) => elev[e] >= 2 && !edied[e]), deg = legs.length;
      if (deg < 3) continue;
      isJ[k] = 1;
      const mains = legs.filter((e) => elev[e] >= 3).length, fws = legs.filter((e) => elev[e] === 4).length;
      const t = fws >= 2 ? 0 : deg >= 5 ? 3 : mains >= 2 ? 2 : mains >= 1 ? 1 : 0;      // (freeways meeting: no control)
      jtype[k] = t; jlist.push(nx[k], nz[k], t, deg, nborn[k]);
    }
    const f32 = (f) => Float32Array.from({ length: n }, (_, i) => f(i));
    const hl = (h) => h >= 0.75 ? 3 : h >= 0.5 ? 2 : h >= 0.25 ? 1 : 0;
    return {
      streets: { n, ax: f32((i) => nx[ea[i]]), az: f32((i) => nz[ea[i]]), bx: f32((i) => nx[eb[i]]), bz: f32((i) => nz[eb[i]]),
        w: f32((i) => ew[i]), cls: Uint8Array.from(elev), level: Uint8Array.from(elev), born: Int16Array.from(eborn), tag: Int32Array.from(etag),
        // (junction control at each end: a stop sign stands only on the streets meeting a main road)
        ja: Uint8Array.from({ length: n }, (_, i) => jtype[ea[i]] === 1 && elev[i] >= 3 ? 0 : jtype[ea[i]]), jb: Uint8Array.from({ length: n }, (_, i) => jtype[eb[i]] === 1 && elev[i] >= 3 ? 0 : jtype[eb[i]]),
        health: Uint8Array.from(eh, hl), surf: Uint8Array.from(esf), died: Int16Array.from(edied),
        // (1: streets meet at that end, a junction; 0: a bend or an end)
        xa: Uint8Array.from({ length: n }, (_, i) => isJ[ea[i]]), xb: Uint8Array.from({ length: n }, (_, i) => isJ[eb[i]]),
        // heights of the road at its ends (m: raised freeways, overpasses and ramps), and freeway ramps
        ha: f32((i) => nh[ea[i]]), hb: f32((i) => nh[eb[i]]), ramp: Uint8Array.from(eramp),
        // the widest other street or road meeting it at each end (m; 0 none): where the junction's edge is
        wa: f32((i) => wideAt(ea[i], i)), wb: f32((i) => wideAt(eb[i], i)) },
      junctions: Float32Array.from(jlist),
    };
  }
  const stats = () => { const c2 = [0, 0, 0, 0, 0]; let live = 0; for (let e = 0; e < ea.length; e++) if (!edied[e]){ live++; c2[elev[e]]++; } return { edges: ea.length, live, byLevel: c2, nodes: nx.length, freeways: fwLog }; };
  return { core, grow, frontage, track, link, tick, finish, nearestNode, fastest, stats, edgeCount: () => ea.length };
}
