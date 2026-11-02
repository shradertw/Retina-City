/* Town streets, grown during the history simulation (src/gen/sim.js) as towns need them.
   A settlement's street network starts at its middle (the core node). New town buildings face a street;
   when the frontage near where they want to be is used up, the network grows by one street segment:
     - from a node with free sides: an end continues roughly straight (within 25 degrees), or any node
       branches off at roughly a right angle;
     - 40-60 m long before the wheel is known, 50-85 m after; 8 m wide before, 10 m after (main streets 12 m,
       16 m in towns of 2,500+ town people);
     - it ends on an existing node if one is within SNAP m (a junction), as long as the streets there meet
       at 30 degrees or more;
     - it never crosses another street, leaves room for buildings beside others (its middle 40 m from them,
       a new end 30 m), and keeps to buildable land
       (off water and clear of rivers).
   Farmsteads far from any street get a track to the nearest node.
   At the end each node with three or more streets is a junction with a control type:
     3 roundabout  five or more ways (counting the settlement's roads to other settlements at its core)
     2 signals     two or more main streets meet
     1 stop sign   a side street meets a main street
     0 none        side streets only */
const SNAP = 22, NB = 25, EB = 60;

/** @param {{ landOk: (x: number, z: number) => boolean, rnd: (a: number, k: number) => number }} c */
export function makeStreets(c){
  const nx = [], nz = [], ntag = [], nedges = [], nborn = [];
  const ea = [], eb = [], ew = [], ecls = [], eborn = [], etag = [];
  const nbk = new Map(), ebk = new Map();
  const key = (a, b) => a * 1000003 + b;
  const addTo = (m, k, v) => { let l = m.get(k); if (!l){ l = []; m.set(k, l); } l.push(v); };
  function addNode(x, z, tag, born){
    const id = nx.length;
    nx.push(x); nz.push(z); ntag.push(tag); nedges.push([]); nborn.push(born);
    addTo(nbk, key(Math.floor(x / NB), Math.floor(z / NB)), id);
    return id;
  }
  function addEdge(a, b, w, cls, born, tag){
    const id = ea.length;
    ea.push(a); eb.push(b); ew.push(w); ecls.push(cls); eborn.push(born); etag.push(tag);
    nedges[a].push(id); nedges[b].push(id);
    const x0 = Math.min(nx[a], nx[b]), x1 = Math.max(nx[a], nx[b]), z0 = Math.min(nz[a], nz[b]), z1 = Math.max(nz[a], nz[b]);
    for (let j = Math.floor(z0 / EB); j <= Math.floor(z1 / EB); j++) for (let i = Math.floor(x0 / EB); i <= Math.floor(x1 / EB); i++) addTo(ebk, key(i, j), id);
    return id;
  }
  function nearestNode(x, z, r, tag = -1, not = -1){
    let best = -1, bd = r;
    const n = Math.ceil(r / NB), ci = Math.floor(x / NB), cj = Math.floor(z / NB);
    for (let b = -n; b <= n; b++) for (let a = -n; a <= n; a++) for (const id of nbk.get(key(ci + a, cj + b)) || []){
      if (id === not || (tag >= 0 && ntag[id] !== tag)) continue;
      const d = Math.hypot(nx[id] - x, nz[id] - z); if (d < bd){ bd = d; best = id; }
    }
    return best;
  }
  const cross = (ax, az, bx, bz, cx, cz, dx, dz) => {
    const d1 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx), d2 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
    const d3 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax), d4 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
    return d1 * d2 < 0 && d3 * d4 < 0;
  };
  const segDist = (px, pz, ax, az, bx, bz) => {
    const ex = bx - ax, ez = bz - az, t = Math.max(0, Math.min(1, ((px - ax) * ex + (pz - az) * ez) / (ex * ex + ez * ez || 1)));
    return Math.hypot(px - ax - ex * t, pz - az - ez * t);
  };
  /** can a street run from node a to point (x, z) (ending on node b, or -1 for a new node)? */
  function clear(a, x, z, b){
    const ax = nx[a], az = nz[a];
    for (let k = 1; k <= 4; k++){ const t = k / 5; if (!c.landOk(ax + (x - ax) * t, az + (z - az) * t)) return false; }
    if (b < 0 && !c.landOk(x, z)) return false;
    const mx = (ax + x) / 2, mz = (az + z) / 2;
    const seen = new Set();
    for (let j = Math.floor((Math.min(az, z) - 25) / EB); j <= Math.floor((Math.max(az, z) + 25) / EB); j++)
      for (let i = Math.floor((Math.min(ax, x) - 25) / EB); i <= Math.floor((Math.max(ax, x) + 25) / EB); i++)
        for (const e of ebk.get(key(i, j)) || []){
          if (seen.has(e)) continue; seen.add(e);
          const p = ea[e], q = eb[e];
          const shares = p === a || q === a || (b >= 0 && (p === b || q === b));
          if (!shares && cross(ax, az, x, z, nx[p], nz[p], nx[q], nz[q])) return false;
          // room for buildings between it and other streets: its middle (and a new end) at least 40 m (30 m)
          // from them
          if (!shares && segDist(mx, mz, nx[p], nz[p], nx[q], nz[q]) < 40) return false;
          if (!shares && b < 0 && segDist(x, z, nx[p], nz[p], nx[q], nz[q]) < 30) return false;
        }
    return true;
  }
  // the smallest angle between a new street from node n toward (dx, dz) and the streets already there
  function angleOk(n, dx, dz){
    const L = Math.hypot(dx, dz) || 1;
    for (const e of nedges[n]){
      const o = ea[e] === n ? eb[e] : ea[e], ox = nx[o] - nx[n], oz = nz[o] - nz[n], ol = Math.hypot(ox, oz) || 1;
      if ((ox * dx + oz * dz) / (ol * L) > 0.866) return false;            // within 30 degrees
    }
    return true;
  }
  /** settlement s's core node (made if needed) */
  function core(s, born){
    if (s.coreNode === undefined){ s.coreNode = addNode(s.core[0], s.core[1], s.id, born); s.nodes = [s.coreNode]; }
    return s.coreNode;
  }
  /** grow settlement s's network by one street; wide: the wheel is known @returns {number} the new edge or -1 */
  function grow(s, born, wide, a, outward = false){
    core(s, born);
    const nodes = s.nodes;
    for (let t = 0; t < 10; t++){
      // a node with free sides, nearer the middle more likely (towns fill in before they spread); outward:
      // further out more likely (suburbs, once people have cars)
      let n = -1;
      for (let k = 0; k < 4; k++){
        const m = nodes[Math.floor(c.rnd(a, 10 + t * 4 + k) * nodes.length)];
        if (nedges[m].length >= 4) continue;
        const dm = Math.hypot(nx[m] - s.core[0], nz[m] - s.core[1]), dn = n < 0 ? 0 : Math.hypot(nx[n] - s.core[0], nz[n] - s.core[1]);
        if (n < 0 || (outward ? dm > dn : dm < dn)) n = m;
      }
      if (n < 0) continue;
      let ang;
      const deg = nedges[n].length;
      if (deg === 0) ang = (s.axis ?? (s.axis = c.rnd(a, 1) * 6.2832)) + (c.rnd(a, 50 + t) < 0.5 ? Math.PI : 0);
      else {
        const e = nedges[n][Math.floor(c.rnd(a, 60 + t) * deg)], o = ea[e] === n ? eb[e] : ea[e];
        const base = Math.atan2(nz[n] - nz[o], nx[n] - nx[o]);           // along the street, away from its other end
        ang = deg === 1 && c.rnd(a, 70 + t) < 0.6 ? base + (c.rnd(a, 80 + t) - 0.5) * 0.87
          : base + (c.rnd(a, 90 + t) < 0.5 ? 1 : -1) * (Math.PI / 2 + (c.rnd(a, 100 + t) - 0.5) * 0.52);
      }
      const L = wide ? 50 + 35 * c.rnd(a, 110 + t) : 40 + 20 * c.rnd(a, 110 + t);
      let x = nx[n] + Math.cos(ang) * L, z = nz[n] + Math.sin(ang) * L;
      if (!angleOk(n, x - nx[n], z - nz[n])) continue;
      // end on a node nearby (a junction) when the angles there allow it
      let b = nearestNode(x, z, SNAP, s.id, n);
      if (b >= 0 && (nedges[b].some((e) => ea[e] === n || eb[e] === n) || !angleOk(b, nx[n] - nx[b], nz[n] - nz[b]))) b = -1;
      if (b >= 0){ x = nx[b]; z = nz[b]; }
      if (!clear(n, x, z, b)) continue;
      if (b < 0){ b = addNode(x, z, s.id, born); nodes.push(b); }
      return addEdge(n, b, wide ? 10 : 8, 1, born, s.id);
    }
    return -1;
  }
  /** spots facing settlement s's streets: [x, z] a building's middle, set back from the street */
  function frontage(s, n, a){
    const out = [], es = [];
    for (const nd of s.nodes || []) for (const e of nedges[nd]) if (ecls[e] > 0) es.push(e);
    if (!es.length) return out;
    for (let t = 0; t < n; t++){
      const e = es[Math.floor(c.rnd(a, 200 + t) * es.length)], p = ea[e], q = eb[e];
      const u = 0.15 + 0.7 * c.rnd(a, 300 + t), side = c.rnd(a, 400 + t) < 0.5 ? -1 : 1;
      const dx = nx[q] - nx[p], dz = nz[q] - nz[p], L = Math.hypot(dx, dz) || 1, off = ew[e] / 2 + 3 + 6 + 3 * c.rnd(a, 500 + t);
      out.push([nx[p] + dx * u - dz / L * off * side, nz[p] + dz * u + dx / L * off * side]);
    }
    return out;
  }
  /** a track from a farmstead at (x, z) to the nearest node of its settlement (if it is far from one) */
  function track(x, z, tag, born){
    const n = nearestNode(x, z, 1500, tag);
    if (n < 0 || Math.hypot(nx[n] - x, nz[n] - z) < 120) return;
    const m = addNode(x, z, tag, born);
    addEdge(n, m, 4, 0, born, tag);
  }
  /** the network as plain data, with main streets and junction controls; links: roads to other settlements
   *  meeting at each settlement's core node */
  function finish(T, links){
    const n = ea.length;
    // main streets: in towns of 800+ town people, the streets nearest the middle (more in bigger towns)
    for (const s of T){
      if (s.coreNode === undefined || !(s.townPeak > 800)) continue;
      const r = 50 + 40 * Math.sqrt(s.townPeak / 1000);
      for (const nd of s.nodes) for (const e of nedges[nd]){
        if (ecls[e] !== 1) continue;
        const p = ea[e], q = eb[e];
        if (Math.hypot((nx[p] + nx[q]) / 2 - s.core[0], (nz[p] + nz[q]) / 2 - s.core[1]) < r){ ecls[e] = 2; ew[e] = s.townPeak > 2500 ? 16 : 12; }
      }
    }
    const jtype = new Uint8Array(nx.length), jlist = [];
    for (let k = 0; k < nx.length; k++){
      const legs = nedges[k].filter((e) => ecls[e] > 0), extra = links.get(k) || 0, deg = legs.length + extra;
      if (deg < 3) continue;
      const mains = legs.filter((e) => ecls[e] === 2).length + extra;
      const t = deg >= 5 ? 3 : mains >= 2 ? 2 : mains >= 1 ? 1 : 0;
      jtype[k] = t; jlist.push(nx[k], nz[k], t, deg, nborn[k]);
    }
    const f32 = (f) => Float32Array.from({ length: n }, (_, i) => f(i));
    return {
      streets: { n, ax: f32((i) => nx[ea[i]]), az: f32((i) => nz[ea[i]]), bx: f32((i) => nx[eb[i]]), bz: f32((i) => nz[eb[i]]),
        w: f32((i) => ew[i]), cls: Uint8Array.from(ecls), born: Int16Array.from(eborn), tag: Int32Array.from(etag),
        ja: Uint8Array.from({ length: n }, (_, i) => jtype[ea[i]]), jb: Uint8Array.from({ length: n }, (_, i) => jtype[eb[i]]) },
      junctions: Float32Array.from(jlist),
    };
  }
  return { core, grow, frontage, track, finish, nearestNode, edgeCount: () => ea.length };
}
