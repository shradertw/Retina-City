/* The overhead map (Z): the natural maps as layers (L to switch), roads, buildings, street lights, chunk
   borders and you. Scroll to zoom (around the pointer), drag to pan, double-click to centre on yourself, Z or Esc to close.
   Chunks are generated as they come into view, a few milliseconds' worth per frame, so the map never stalls;
   finer detail shows as you zoom in. */
import { current } from '../gen/current.js';
import { state } from '../core/state.js';
import { ROAD_CHUNK, SAMPLES } from '../gen/roads.js';
import { LIFE, METALS } from '../gen/world.js';
import { radiusKm } from '../gen/history.js';
import { ZONES } from '../gen/districts.js';
import { eraOf, namesOf } from '../gen/tech.js';
import { TRAITS, describe } from '../gen/traits.js';

// map layers: what each shows, and its legend
const LAYERS = [
  { key: 'terrain', name: 'Terrain', legend: 'green low land to brown and grey high ground, shaded from the north-west; blue water, rivers' },
  { key: 'temp', name: 'Temperature', legend: 'blue -10 °C, white 10 °C, red 30 °C' },
  { key: 'humid', name: 'Humidity', legend: 'tan dry to dark blue wet' },
  { key: 'fert', name: 'Fertility', legend: 'grey barren to bright green fertile' },
  { key: 'life', name: 'Life', legend: '' },
  { key: 'metals', name: 'Metals', legend: METALS.map((m, i) => m).join(', ') + ' (dot size = deposit size)' },
  { key: 'districts', name: 'Districts', legend: 'from year 650: green housing, blue shops and offices, ochre industry; darker = more storeys' },
];
// town blocks by district (housing, shops and offices, industry) and storeys (1-2, 3-5, 6-12, 13+)
const ZONE_COL = [null, ['#b9dc8f', '#8cc46a', '#5f9e4a', '#3d7434'], ['#a6cdf2', '#6aa4e3', '#3f78c9', '#27509a'], ['#f0d08a', '#ddb05a', '#b98934', '#8a6222']];
const band = (st) => st <= 2 ? 0 : st <= 5 ? 1 : st <= 12 ? 2 : 3;
const LIFE_COL = [[18, 40, 60], [40, 80, 110], [214, 200, 150], [235, 240, 245], [150, 150, 120], [40, 80, 55], [160, 150, 100],
  [150, 175, 80], [55, 110, 50], [220, 190, 120], [190, 170, 80], [25, 95, 40], [130, 125, 120]];
const METAL_COL = ['#c0603a', '#d08a3a', '#222222', '#f2d24a'];
LAYERS[4].legend = LIFE.slice(2).map((n) => n).join(', ');

export function initMap(){
  const cv = /** @type {HTMLCanvasElement} */ (document.getElementById('map'));
  const info = document.getElementById('mapInfo');
  const ctx = cv.getContext('2d');
  const timeBox = document.getElementById('mapTime'), yearIn = /** @type {HTMLInputElement} */ (document.getElementById('mapYear'));
  const yearOut = document.getElementById('mapYearOut'), playBtn = document.getElementById('mapPlay');
  // what the map shows (the Show menu); the choices are remembered
  const SHOW = [['land', 'Settlement land (tags)'], ['blocks', 'Town blocks (at the end)'], ['streets', 'Streets and junctions (grey none, white stop, yellow signals, blue roundabout)'], ['buildings', 'Buildings (as in 3D)'], ['towns', 'Buildings: farm homes (cream), workshops (brown), shops (blue), factories (purple), housing (green), empty (grey)'], ['names', 'Names'], ['farms', 'Farmland'],
    ['roads', 'Main roads and freeways'], ['raids', 'Raids (recent: red won, grey driven off)'], ['tracks', 'Tracks and footpaths'], ['centres', 'Distribution centres'], ['metals', 'Metal deposits (Metals layer)'], ['you', 'You']];
  const show = Object.fromEntries(SHOW.map(([k]) => [k, true]));
  try { Object.assign(show, JSON.parse(localStorage.getItem('retina-map-show') || '{}')); } catch (_){ }
  const filterBox = document.getElementById('mapFilter'), filterList = document.getElementById('mapFilterList');
  for (const [k, label] of SHOW){
    const l = document.createElement('label'), c = document.createElement('input');
    c.type = 'checkbox'; c.checked = !!show[k];
    c.addEventListener('change', () => { show[k] = c.checked; try { localStorage.setItem('retina-map-show', JSON.stringify(show)); } catch (_){ } });
    l.append(c, ' ' + label); filterList.append(l);
  }
  let step = -1, playing = false, playT = 0, lastHist = null, farmImg = null, farmFor = null, farmStep = -1;
  const ageOf = (h, s) => { let a = 0, s0 = 0; while (a < h.ages.length - 1 && s > s0 + h.ages[a].steps){ s0 += h.ages[a].steps; a++; } return h.ages[a]; };
  const showYear = () => {
    const h = current.history; if (!h) return;
    if (h.version === 2){
      let m = 0; for (const s of h.settlements) m |= s.knowAt[step];
      yearOut.textContent = 'Year ' + h.year[step] + ' · ' + (m ? 'most advanced: ' + eraOf(m).toLowerCase() : 'foragers only');
    } else yearOut.textContent = 'Year ' + h.year[step] + ' · ' + ageOf(h, step).name.toLowerCase();
  };
  let blockKey = null, blockFor = null;      // block grid -> block, for the hover readout (built when needed)
  yearIn.addEventListener('input', () => { step = Number(yearIn.value); playing = false; playBtn.textContent = 'Play'; showYear(); });
  playBtn.addEventListener('click', () => {
    playing = !playing; playBtn.textContent = playing ? 'Pause' : 'Play';
    if (playing && step >= current.history.steps) step = 0;
    playT = performance.now();
  });
  for (const el of [timeBox, yearIn, playBtn, filterBox]) el.addEventListener('pointerdown', (e) => e.stopPropagation());
  let open = false, cx = 0, cz = 0, scale = 0.25, landImg = null, landFor = null, landLayer = -1, drag = null, layer = 0;
  const W = () => cv.width, H = () => cv.height;
  const dpr = () => Math.min(window.devicePixelRatio || 1, 2);
  const toX = (x) => W() / 2 + (x - cx) * scale * dpr(), toY = (z) => H() / 2 - (z - cz) * scale * dpr();

  // the current layer as an image, one pixel per world grid cell
  function land(){
    const w = current.world;
    if (landFor === w && landLayer === layer) return landImg;
    const c = document.createElement('canvas'); c.width = w.res; c.height = w.res;
    const g = c.getContext('2d'), img = g.createImageData(w.res, w.res), R = w.res, key = LAYERS[layer].key;
    const lerp = (a, b, t) => a + (b - a) * Math.min(Math.max(t, 0), 1);
    for (let j = 0; j < R; j++) for (let i = 0; i < R; i++){
      const k = j * R + i, o = ((R - 1 - j) * R + i) * 4;     // north up
      const wt = w.water[k], h = w.elev[k];
      let r, gg, b;
      // hill shading: light from the north-west
      const hx = w.elev[j * R + Math.min(i + 1, R - 1)] - w.elev[j * R + Math.max(i - 1, 0)];
      const hz = w.elev[Math.min(j + 1, R - 1) * R + i] - w.elev[Math.max(j - 1, 0) * R + i];
      const shade = Math.min(Math.max(1 + (-hx + hz) / (2 * w.cell) * 1.6, 0.55), 1.35);
      if (wt === 1 || wt === 2){
        const dpt = Math.min(Math.max(-w.height[k] / (w.relief * 0.6), 0), 1);
        r = lerp(28, 10, dpt); gg = lerp(62, 26, dpt); b = lerp(88, 50, dpt);
        if (wt === 2){ r += 10; gg += 18; b += 22; }
      } else if (key === 'terrain' || key === 'metals' || key === 'districts'){
        const u = h / w.relief;
        if (u < 0.25){ r = lerp(70, 120, u / 0.25); gg = lerp(105, 125, u / 0.25); b = lerp(60, 72, u / 0.25); }
        else if (u < 0.6){ r = lerp(120, 125, (u - 0.25) / 0.35); gg = lerp(125, 105, (u - 0.25) / 0.35); b = lerp(72, 80, (u - 0.25) / 0.35); }
        else { r = lerp(125, 205, (u - 0.6) / 0.4); gg = lerp(105, 200, (u - 0.6) / 0.4); b = lerp(80, 195, (u - 0.6) / 0.4); }
        r *= shade; gg *= shade; b *= shade;
        if (key === 'metals' || key === 'districts'){ const m = (r + gg + b) / 3; r = gg = b = m * 0.8; }
        if (wt === 3){ r = 70; gg = 150; b = 215; }
      } else if (key === 'temp'){
        const t = w.temp[k];
        if (t < 10){ const u = (t + 10) / 20; r = lerp(40, 240, u); gg = lerp(90, 240, u); b = lerp(200, 240, u); }
        else { const u = (t - 10) / 20; r = lerp(240, 200, u); gg = lerp(240, 50, u); b = lerp(240, 40, u); }
        r *= shade; gg *= shade; b *= shade;
      } else if (key === 'humid'){
        const u = w.humid[k]; r = lerp(205, 25, u) * shade; gg = lerp(180, 70, u) * shade; b = lerp(130, 150, u) * shade;
      } else if (key === 'fert'){
        const u = w.fert[k]; r = lerp(110, 60, u) * shade; gg = lerp(105, 200, u) * shade; b = lerp(100, 40, u) * shade;
        if (wt === 3){ r = 70; gg = 150; b = 215; }
      } else {
        const L = LIFE_COL[w.life[k]]; r = L[0] * shade; gg = L[1] * shade; b = L[2] * shade;
        if (wt === 3){ r = 70; gg = 150; b = 215; }
      }
      img.data[o] = r; img.data[o + 1] = gg; img.data[o + 2] = b; img.data[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    landImg = c; landFor = w; landLayer = layer;
    return c;
  }

  /* ---- the history simulation (src/gen/sim.js): land tags and farmland replayed from their change lists up to
     the chosen year, buildings standing that year, settlement names; roads and town blocks as at the end ---- */
  let sim = null;
  const tagColour = (t) => { const hh = ((t * 2654435761) >>> 0) / 4294967296; const a = hh * 6.2832; return [150 + 90 * Math.cos(a), 150 + 90 * Math.cos(a + 2.1), 150 + 90 * Math.cos(a + 4.2)]; };
  function replay(hist){
    const L = hist.land, N = L.res * L.res;
    if (!sim || sim.hist !== hist){
      const mk = () => { const c = document.createElement('canvas'); c.width = c.height = L.res; return c; };
      sim = { hist, tag: new Int32Array(N), farm: new Uint8Array(N), at: -1, ti: 0, fi: 0, tagImg: mk(), farmImg: mk() };
    }
    if (sim.at === step) return;
    if (step < sim.at){ sim.tag.fill(-1); sim.farm.fill(0); sim.ti = 0; sim.fi = 0; }
    if (sim.at < 0) sim.tag.fill(-1);
    const te = L.tagEv, fe = L.farmEv;
    while (sim.ti < te.length && te[sim.ti + 1] <= step){ sim.tag[te[sim.ti]] = te[sim.ti + 2]; sim.ti += 3; }
    while (sim.fi < fe.length && fe[sim.fi + 1] <= step){ sim.farm[fe[sim.fi]] = fe[sim.fi + 2]; sim.fi += 3; }
    sim.at = step;
    const R = L.res;
    const gt = sim.tagImg.getContext('2d'), it = gt.createImageData(R, R);
    const gf = sim.farmImg.getContext('2d'), iF = gf.createImageData(R, R);
    for (let j = 0; j < R; j++) for (let i = 0; i < R; i++){
      const c = j * R + i, o = ((R - 1 - j) * R + i) * 4, t = sim.tag[c];
      if (t >= 0){ const col = tagColour(t); it.data[o] = col[0]; it.data[o + 1] = col[1]; it.data[o + 2] = col[2]; it.data[o + 3] = 70; }
      if (sim.farm[c]){ const v = ((i * 7 + j * 13) % 5) / 5; iF.data[o] = 210 + 30 * v; iF.data[o + 1] = 190 + 20 * v; iF.data[o + 2] = 95 + 40 * v; iF.data[o + 3] = 130; }
    }
    gt.putImageData(it, 0, 0); gf.putImageData(iF, 0, 0);
  }
  function drawSim(hist, d){
    if (hist !== lastHist){ lastHist = hist; step = hist.steps; yearIn.max = String(hist.steps); playing = false; playBtn.textContent = 'Play'; timeBox.hidden = false; }
    if (playing && performance.now() - playT > 90){ playT = performance.now(); step++; if (step >= hist.steps){ step = hist.steps; playing = false; playBtn.textContent = 'Play'; } }
    yearIn.value = String(step); showYear();
    replay(hist);
    const L = hist.land, span = L.res * L.cell * scale * d;
    ctx.imageSmoothingEnabled = false;
    if (show.land) ctx.drawImage(sim.tagImg, toX(-L.half), toY(L.res * L.cell - L.half), span, span);
    if (show.farms) ctx.drawImage(sim.farmImg, toX(-L.half), toY(L.res * L.cell - L.half), span, span);
    // town blocks as at the end
    const BK = hist.blocks;
    if (show.blocks && BK && step >= BK.from && BK.size * scale * d >= 1.2){
      const v = BK.snap[0], bp = BK.size * scale * d, gap = bp > 6 ? bp * 0.12 : 0, paths = [];
      for (let b = 0; b < v.length; b++){
        const c = v[b]; if (!c) continue;
        const sx = toX(-BK.half + BK.i[b] * BK.size), sy = toY(-BK.half + (BK.j[b] + 1) * BK.size);
        if (sx > W() || sy > H() || sx + bp < 0 || sy + bp < 0) continue;
        const q = (c >> 6) * 4 + band(c & 63);
        (paths[q] || (paths[q] = new Path2D())).rect(sx + gap / 2, sy + gap / 2, bp - gap, bp - gap);
      }
      for (let q = 4; q < 16; q++) if (paths[q]){ ctx.globalAlpha = 0.6; ctx.fillStyle = ZONE_COL[q >> 2][q & 3]; ctx.fill(paths[q]); ctx.globalAlpha = 1; }
    }
    // roads (stage 1: built at the end)
    const ROAD_STYLE = [['rgba(120,84,48,0.9)', 4, 0.8], ['rgba(236,226,200,0.95)', 8, 1.3], ['rgba(255,214,140,1)', 18, 2.2]];
    if (show.roads) for (let cls = 0; cls < 3; cls++){
      const [col, wm, wmin] = ROAD_STYLE[cls];
      ctx.strokeStyle = col; ctx.lineWidth = Math.max(wmin * d, wm * scale * d);
      ctx.beginPath();
      for (const r of hist.roads){
        if (r.cls !== cls || r.step > step) continue;
        const P = r.pts;
        ctx.moveTo(toX(P[0]), toY(P[1]));
        for (let n = 2; n < P.length; n += 2) ctx.lineTo(toX(P[n]), toY(P[n + 1]));
      }
      ctx.stroke();
    }
    // streets grown with the towns, built by this year: tracks, streets, main streets; junction controls
    const ST = hist.streets;
    if (ST && (show.streets || show.roads || show.tracks)){
      // the road network by level (footpaths, tracks, streets and roads, main roads, freeways); older histories:
      // tracks, streets, main streets
      const net = !!ST.level, P = [new Path2D(), new Path2D(), new Path2D(), new Path2D(), new Path2D()];
      for (let i = 0; i < ST.n; i++){
        if (ST.born[i] > step || (ST.died && ST.died[i] && ST.died[i] <= step)) continue;
        const lv = net ? ST.level[i] : ST.cls[i] + 1;
        if (lv <= 1 ? !show.tracks : lv === 2 ? !show.streets : !(show.roads || show.streets)) continue;
        const p = P[lv]; p.moveTo(toX(ST.ax[i]), toY(ST.az[i])); p.lineTo(toX(ST.bx[i]), toY(ST.bz[i]));
      }
      ctx.lineCap = 'round';
      ctx.setLineDash([1.5 * d, 3 * d]); ctx.strokeStyle = 'rgba(150,120,80,0.8)'; ctx.lineWidth = Math.max(0.6 * d, 2 * scale * d); ctx.stroke(P[0]);
      ctx.setLineDash([3 * d, 3 * d]); ctx.strokeStyle = 'rgba(120,84,48,0.9)'; ctx.lineWidth = Math.max(0.8 * d, 4 * scale * d); ctx.stroke(P[1]);
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(236,228,210,0.95)'; ctx.lineWidth = Math.max(1 * d, 10 * scale * d); ctx.stroke(P[2]);
      ctx.strokeStyle = 'rgba(255,214,140,1)'; ctx.lineWidth = Math.max(1.4 * d, 18 * scale * d); ctx.stroke(P[3]);
      ctx.strokeStyle = 'rgba(240,150,70,1)'; ctx.lineWidth = Math.max(2 * d, 28 * scale * d); ctx.stroke(P[4]);
      const J = hist.junctions;
      if (J && scale > 0.05){
        const col = ['#9a9a9a', '#ffffff', '#f2c230', '#3b6fd8'], r = Math.max(2 * d, 5 * scale * d);
        for (let i = 0; i < J.length; i += 5){
          if (J[i + 4] > step) continue;
          ctx.fillStyle = col[J[i + 2]]; ctx.beginPath(); ctx.arc(toX(J[i]), toY(J[i + 1]), r, 0, 6.2832); ctx.fill();
        }
      }
    }
    // raids in the last few frames: red where the raiders won, grey where they were driven off
    const RD = hist.raids;
    if (show.raids && RD){
      ctx.lineWidth = 2 * d; ctx.setLineDash([6 * d, 4 * d]);
      for (let i = 0; i < RD.length; i += 4){
        const f = RD[i]; if (f > step || f < step - 4) continue;
        const A = hist.settlements[RD[i + 1]], T2 = hist.settlements[RD[i + 2]];
        if (!(A.popAt[f] > 0 && T2.popAt[f] > 0)) continue;           // (one side gone that same step: no place to draw from)
        ctx.strokeStyle = RD[i + 3] ? 'rgba(220,40,30,0.9)' : 'rgba(150,150,150,0.8)';
        ctx.beginPath(); ctx.moveTo(toX(A.xAt[f] * 1000), toY(A.zAt[f] * 1000)); ctx.lineTo(toX(T2.xAt[f] * 1000), toY(T2.zAt[f] * 1000)); ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    // buildings standing this year: farm homes light, workshops brown, shops blue
    const Bd = hist.buildings, bs = Math.max(1.6 * d, 12 * scale * d);
    if (show.towns && scale > 0.004){
      const homes = new Path2D(), crafts = new Path2D(), shops = new Path2D(), empty = new Path2D(), fac = new Path2D(), housing = new Path2D();
      const x0 = cx - W() / 2 / (scale * d) - 50, x1 = cx + W() / 2 / (scale * d) + 50, z0 = cz - H() / 2 / (scale * d) - 50, z1 = cz + H() / 2 / (scale * d) + 50;
      for (let b = 0; b < Bd.n; b++){
        if (Bd.born[b] > step || (Bd.died[b] && Bd.died[b] <= step)) continue;
        const x = Bd.x[b], z = Bd.z[b];
        if (x < x0 || x > x1 || z < z0 || z > z1) continue;
        const kd = Bd.kind[b];
        (Bd.empty && Bd.empty[b] && Bd.empty[b] <= step ? empty : kd === 3 ? shops : kd === 2 ? crafts : kd === 4 ? fac : kd === 5 ? housing : homes).rect(toX(x) - bs / 2, toY(z) - bs / 2, bs, bs);
      }
      ctx.fillStyle = '#f4e3c0'; ctx.fill(homes); ctx.fillStyle = '#a0522d'; ctx.fill(crafts); ctx.fillStyle = '#4f86d6'; ctx.fill(shops); ctx.fillStyle = '#6d6d6d'; ctx.fill(empty); ctx.fillStyle = '#6b4f8a'; ctx.fill(fac); ctx.fillStyle = '#9fd18a'; ctx.fill(housing);
      ctx.strokeStyle = 'rgba(20,14,8,0.7)'; ctx.lineWidth = 1; ctx.stroke(homes); ctx.stroke(crafts); ctx.stroke(shops); ctx.stroke(empty); ctx.stroke(fac); ctx.stroke(housing);
    }
    // names, biggest first, as many as fit
    if (show.names){
      ctx.font = (10 * d) + 'px "Martian Mono", ui-monospace, monospace';
      const labels = [];
      for (const st of hist.settlements){
        const pop = st.popAt[step]; if (!(pop > 0)) continue;
        const sx = toX(st.xAt[step] * 1000), sy = toY(st.zAt[step] * 1000);
        if (sx < -50 || sy < -20 || sx > W() + 50 || sy > H() + 20) continue;
        labels.push([pop, st.name + ' ' + Math.round(pop).toLocaleString(), sx, sy]);
      }
      labels.sort((a, b) => b[0] - a[0]);
      const placed = [];
      ctx.fillStyle = '#f4ead2'; ctx.strokeStyle = 'rgba(10,8,6,0.85)'; ctx.lineWidth = 3 * d;
      for (const [, name, sx, sy] of labels){
        const tx = sx + 6 * d, ty = sy - 6 * d, tw = ctx.measureText(name).width;
        if (placed.some(([x, y, w2]) => Math.abs(y - ty) < 12 * d && tx < x + w2 && x < tx + tw)) continue;
        if (placed.length > 150) break;
        ctx.strokeText(name, tx, ty); ctx.fillText(name, tx, ty); placed.push([tx, ty, tw]);
      }
    }
  }

  function draw(){
    if (!open) return;
    requestAnimationFrame(draw);
    const w = current.world, d = dpr();
    if (cv.width !== Math.round(innerWidth * d) || cv.height !== Math.round(innerHeight * d)){ cv.width = Math.round(innerWidth * d); cv.height = Math.round(innerHeight * d); }
    ctx.fillStyle = '#0a1620'; ctx.fillRect(0, 0, W(), H());
    ctx.imageSmoothingEnabled = scale * w.cell < 8;
    ctx.drawImage(land(), toX(-w.half), toY(w.half), w.size * scale * d, w.size * scale * d);
    // which chunks are in view; generate missing ones within a time budget
    const x0 = cx - W() / 2 / (scale * d), x1 = cx + W() / 2 / (scale * d), z0 = cz - H() / 2 / (scale * d), z1 = cz + H() / 2 / (scale * d);
    const c0x = Math.floor(Math.max(x0, -w.half) / ROAD_CHUNK), c1x = Math.floor(Math.min(x1, w.half) / ROAD_CHUNK);
    const c0z = Math.floor(Math.max(z0, -w.half) / ROAD_CHUNK), c1z = Math.floor(Math.min(z1, w.half) / ROAD_CHUNK);
    const showBuildings = scale >= 0.06, showLamps = scale >= 0.8, t0 = performance.now();
    let pending = 0;
    // chunks nearest the centre of the view first
    const list = [];
    for (let z = c0z; z <= c1z; z++) for (let x = c0x; x <= c1x; x++) list.push([x, z, Math.hypot((x + 0.5) * ROAD_CHUNK - cx, (z + 0.5) * ROAD_CHUNK - cz)]);
    list.sort((a, b) => a[2] - b[2]);
    if (list.length > 4000) list.length = 4000;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    // town streets (and, from step 4e-2, buildings), once zoomed in enough to see them; streets are drawn later,
    // above the town blocks
    const streets = new Path2D(), mains = new Path2D(), bld = [new Path2D(), new Path2D(), new Path2D(), new Path2D(), new Path2D()], doors = new Path2D(), lights = new Path2D();
    const wantB = show.buildings && showBuildings;
    if (!((show.streets || wantB) && scale >= 0.03)) list.length = 0;
    for (const [x, z] of list){
      const fresh = !current.roads.cached(x, z) || (wantB && !current.blocks.cached(x, z));
      if (fresh && performance.now() - t0 > 20){ pending++; continue; }
      if (show.streets) for (const e of current.roads.chunk(x, z)){
        if (e.pattern === undefined) continue;             // the history's roads are drawn with the history
        const P = e.major ? mains : streets;
        for (let k = 0; k <= SAMPLES; k++){ const px = toX(e.pts[2 * k]), pz = toY(e.pts[2 * k + 1]); if (k) P.lineTo(px, pz); else P.moveTo(px, pz); }
      }
      if (wantB){
        const ch = current.blocks.chunk(x, z);
        for (const b of ch.buildings){
          const P = bld[b.kind], vx = -b.uz, vz = b.ux;
          P.moveTo(toX(b.x - b.ux * b.hx - vx * b.hz), toY(b.z - b.uz * b.hx - vz * b.hz));
          P.lineTo(toX(b.x + b.ux * b.hx - vx * b.hz), toY(b.z + b.uz * b.hx - vz * b.hz));
          P.lineTo(toX(b.x + b.ux * b.hx + vx * b.hz), toY(b.z + b.uz * b.hx + vz * b.hz));
          P.lineTo(toX(b.x - b.ux * b.hx + vx * b.hz), toY(b.z - b.uz * b.hx + vz * b.hz));
          P.closePath();
          if (showLamps && b.door){                           // door: a dot on the front, which faces the road
            const fx = b.x + b.ux * b.door.off + vx * b.hz * -b.side, fz = b.z + b.uz * b.door.off + vz * b.hz * -b.side;
            doors.rect(toX(fx) - 1.5 * d, toY(fz) - 1.5 * d, 3 * d, 3 * d);
          }
        }
        if (showLamps) for (const l of ch.lamps){ lights.moveTo(toX(l.x) + 1.6 * d, toY(l.z)); lights.arc(toX(l.x), toY(l.z), 1.6 * d, 0, 6.2832); }
      }
    }
    // settlements at the chosen year: their ground, coloured by when they were founded (older = deeper amber)
    const hist = current.history;
    if (hist && hist.version === 2) drawSim(hist, d);
    if (hist && hist.version !== 2){
      if (hist !== lastHist){ lastHist = hist; step = hist.steps; yearIn.max = String(hist.steps); playing = false; playBtn.textContent = 'Play'; timeBox.hidden = false; }
      if (playing && performance.now() - playT > 120){ playT = performance.now(); step++; if (step >= hist.steps){ step = hist.steps; playing = false; playBtn.textContent = 'Play'; } }
      yearIn.value = String(step); showYear();
      // farm plots (fields in a patchwork of tones), drawn to an image when the year changes
      const F = hist.farms;
      if (farmFor !== hist || farmStep !== step){
        farmFor = hist; farmStep = step;
        farmImg = farmImg || document.createElement('canvas');
        if (farmImg.width !== F.res){ farmImg.width = F.res; farmImg.height = F.res; }
        const g = farmImg.getContext('2d'), img = g.createImageData(F.res, F.res);
        for (let j = 0; j < F.res; j++) for (let i = 0; i < F.res; i++){
          const p = j * F.res + i;
          if (F.owner[p] < 0 || F.since[p] > step || (F.until[p] && F.until[p] <= step)) continue;
          const o = ((F.res - 1 - j) * F.res + i) * 4, t = ((i * 7 + j * 13) % 5) / 5;
          img.data[o] = 205 + 30 * t; img.data[o + 1] = 190 + 20 * t; img.data[o + 2] = 90 + 40 * t; img.data[o + 3] = 120;
        }
        g.putImageData(img, 0, 0);
      }
      ctx.imageSmoothingEnabled = false;
      if (show.farms) ctx.drawImage(farmImg, toX(-F.half), toY(F.res * F.cell - F.half), F.res * F.cell * scale * d, F.res * F.cell * scale * d);
      // town blocks (from year 650), once they are big enough on screen to tell apart
      const BK = hist.blocks;
      let blocksShown = false;
      if (show.blocks && BK && step >= BK.from && BK.size * scale * d >= 1.2){
        blocksShown = true;
        const v = BK.snap[step - BK.from], bp = BK.size * scale * d, gap = bp > 6 ? bp * 0.12 : 0, paths = [];
        for (let q = 0; q < 16; q++) paths.push(null);
        for (let b = 0; b < v.length; b++){
          const c = v[b]; if (!c) continue;
          const sx = toX(-BK.half + BK.i[b] * BK.size), sy = toY(-BK.half + (BK.j[b] + 1) * BK.size);
          if (sx > W() || sy > H() || sx + bp < 0 || sy + bp < 0) continue;
          const q = (c >> 6) * 4 + band(c & 63);
          (paths[q] || (paths[q] = new Path2D())).rect(sx + gap / 2, sy + gap / 2, bp - gap, bp - gap);
        }
        for (let q = 4; q < 16; q++) if (paths[q]){ ctx.fillStyle = ZONE_COL[q >> 2][q & 3]; ctx.fill(paths[q]); }
      }
      // town streets, then buildings (brick, concrete, towers), doors and street lights
      ctx.strokeStyle = 'rgba(236,228,210,0.9)';
      ctx.lineWidth = Math.max(1 * d, 12 * scale * d); ctx.stroke(streets);
      ctx.lineWidth = Math.max(1.4 * d, 24 * scale * d); ctx.stroke(mains);
      ['#9a6a55', '#8f8d86', '#7d8ea6', '#b9a888', '#8a8478'].forEach((c, k) => { ctx.fillStyle = c; ctx.fill(bld[k]); });
      ctx.strokeStyle = 'rgba(20,16,12,0.55)'; ctx.lineWidth = 1; for (const P of bld) ctx.stroke(P);
      ctx.fillStyle = '#f0b25c'; ctx.fill(doors);
      ctx.fillStyle = '#ffd27a'; ctx.fill(lights);
      // roads by class: farm tracks, roads, main roads (wider on screen when zoomed in)
      const ROAD_STYLE = [['rgba(120,84,48,0.9)', 4, 0.8], ['rgba(236,226,200,0.95)', 8, 1.3], ['rgba(255,214,140,1)', 18, 2.2]];
      for (let cls = scale < 0.02 ? 1 : 0; cls < 3; cls++){      // farm tracks only once zoomed in a little
        if (cls === 0 ? !show.tracks : !show.roads) continue;
        const [col, wm, wmin] = ROAD_STYLE[cls];
        ctx.strokeStyle = col; ctx.lineWidth = Math.max(wmin * d, wm * scale * d);
        ctx.setLineDash(cls === 0 && scale < 0.5 ? [3 * d, 2 * d] : []);
        ctx.beginPath();
        for (const r of hist.roads){
          if (r.cls !== cls || r.step > step) continue;
          const P = r.pts;
          ctx.moveTo(toX(P[0]), toY(P[1]));
          for (let n = 2; n < P.length; n += 2) ctx.lineTo(toX(P[n]), toY(P[n + 1]));
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);
      // distribution centres: small dark squares
      ctx.fillStyle = '#3b2a18'; ctx.strokeStyle = '#f0d9a8'; ctx.lineWidth = 1 * d;
      if (show.centres) for (const c of hist.centres){
        if (c.born > step) continue;
        const sz = Math.max(3 * d, 60 * scale * d), sx = toX(c.x * 1000), sy = toY(c.z * 1000);
        ctx.fillRect(sx - sz / 2, sy - sz / 2, sz, sz); ctx.strokeRect(sx - sz / 2, sy - sz / 2, sz, sz);
      }
      ctx.lineWidth = 1 * d; ctx.font = (10 * d) + 'px "Martian Mono", ui-monospace, monospace';
      const labels = [];
      for (const st of hist.settlements){
        const pop = st.popAt[step];
        if (!(pop > 0)) continue;
        const area = st.areaAt ? st.areaAt[step] : 0;
        const r = Math.max((area > 0 ? Math.sqrt(area / Math.PI) : radiusKm(pop)) * 1000 * scale * d, 2 * d), sx = toX(st.xAt[step] * 1000), sz = toY(st.zAt[step] * 1000);
        if (sx < -r || sz < -r || sx > W() + r || sz > H() + r) continue;
        // its blocks are drawn, or hidden on purpose (the land shows, with a dot for the town's middle)
        if (!show.towns){ labels.push([pop, st.name, sx, sz, 2 * d]); continue; }
        if (area > 0 && (blocksShown || !show.blocks)){
          if (!blocksShown){ ctx.fillStyle = '#f4ead2'; ctx.strokeStyle = 'rgba(20,14,8,0.8)'; ctx.beginPath(); ctx.arc(sx, sz, 3 * d, 0, 6.2832); ctx.fill(); ctx.stroke(); }
          labels.push([pop, st.name, sx, sz, blocksShown ? r * 0.4 : 3 * d]); continue;
        }
        const age = 1 - st.born / hist.steps;
        ctx.fillStyle = `rgba(${Math.round(255 - 40 * age)},${Math.round(200 - 90 * age)},${Math.round(120 - 80 * age)},0.85)`;
        ctx.strokeStyle = 'rgba(20,14,8,0.8)';
        ctx.beginPath(); ctx.arc(sx, sz, r, 0, 6.2832); ctx.fill(); ctx.stroke();
        labels.push([pop, st.name, sx, sz, r]);
      }
      // names: biggest first, as many as fit without crowding
      labels.sort((a, b) => b[0] - a[0]);
      const placed = [];
      ctx.fillStyle = '#f4ead2'; ctx.strokeStyle = 'rgba(10,8,6,0.85)'; ctx.lineWidth = 3 * d;
      if (show.names) for (const [pop, name, sx, sz, r] of labels){
        const tx = sx + r + 3 * d, ty = sz + 3 * d, tw = ctx.measureText(name).width;
        if (placed.some(([x, y, w2]) => Math.abs(y - ty) < 12 * d && tx < x + w2 && x < tx + tw)) continue;
        if (placed.length > 120) break;
        ctx.strokeText(name, tx, ty); ctx.fillText(name, tx, ty); placed.push([tx, ty, tw]);
      }
    }
    // metal deposits
    if (LAYERS[layer].key === 'metals' && show.metals){
      for (const m of w.metals){
        ctx.fillStyle = METAL_COL[m.type]; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(toX(m.x), toY(m.z), Math.max(2.5, m.size * 300 * scale) * d, 0, 6.2832); ctx.fill(); ctx.stroke();
      }
    }
    // you: an arrow pointing where you look
    const px = toX(state.pos[0]), pz = toY(state.pos[2]), a = state.yaw, s = 9 * d;
    if (show.you){
    ctx.save(); ctx.translate(px, pz); ctx.rotate(a);
    ctx.fillStyle = '#f0b25c'; ctx.strokeStyle = '#0b0e10'; ctx.lineWidth = 2 * d;
    ctx.beginPath(); ctx.moveTo(0, -s); ctx.lineTo(s * 0.6, s * 0.7); ctx.lineTo(0, s * 0.35); ctx.lineTo(-s * 0.6, s * 0.7); ctx.closePath();
    ctx.stroke(); ctx.fill(); ctx.restore();
    }
    // scale bar
    const nice = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];
    const m = nice.find((v) => v * scale >= 90) || 50000, bw = m * scale * d, by = H() - 28 * d, bx = 20 * d;
    ctx.fillStyle = '#e8e4d6'; ctx.fillRect(bx, by, bw, 2 * d);
    ctx.font = (11 * d) + 'px "Martian Mono", ui-monospace, monospace'; ctx.fillText(m >= 1000 ? m / 1000 + ' km' : m + ' m', bx, by - 6 * d);
    const hs = current.history;
    info.textContent = `World ${current.options.size} km · seed ${current.options.seed}` + (pending ? ` · generating ${pending} chunks…` : '')
      + (hs ? ` · ${hs.settlements.filter((t) => t.popAt[step] > 0).length} settlements in year ${hs.year[step]}` : '')
      + ' · scroll to zoom · drag to pan · double-click: back to you · Z to close'
      + `\nLayer (L): ${LAYERS[layer].name} — ${LAYERS[layer].legend}` + hover;
  }

  cv.addEventListener('wheel', (e) => {
    e.preventDefault(); e.stopPropagation();
    const d = dpr(), mx = e.clientX * d, my = e.clientY * d;
    const wx = cx + (mx - W() / 2) / (scale * d), wz = cz - (my - H() / 2) / (scale * d);
    scale = Math.max(0.002, Math.min(8, scale * (e.deltaY < 0 ? 1.18 : 1 / 1.18)));
    cx = wx - (mx - W() / 2) / (scale * d); cz = wz + (my - H() / 2) / (scale * d);
  }, { passive: false });
  cv.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, cx, cz }; cv.setPointerCapture(e.pointerId); e.stopPropagation(); });
  let hover = '';
  cv.addEventListener('pointermove', (e) => {
    if (drag){ cx = drag.cx - (e.clientX - drag.x) / scale; cz = drag.cz + (e.clientY - drag.y) / scale; }
    // what is under the pointer
    const w = current.world, d = dpr();
    const x = cx + (e.clientX * d - W() / 2) / (scale * d), z = cz - (e.clientY * d - H() / 2) / (scale * d);
    if (!w || Math.abs(x) > w.half || Math.abs(z) > w.half){ hover = ''; return; }
    const k = w.gridIndex(x, z), wt = w.water[k];
    const h = current.history;
    let town = '';
    if (h && h.version === 2 && sim){
      const L = h.land, li = Math.floor((x + L.half) / L.cell), lj = Math.floor((z + L.half) / L.cell);
      const c = li >= 0 && lj >= 0 && li < L.res && lj < L.res ? lj * L.res + li : -1;
      const t = c >= 0 ? sim.tag[c] : -1;
      if (t >= 0){
        const st = h.settlements[t], k = st.knowAt[step];
        town = `\n${st.name}: ${st.popAt[step] > 0 ? Math.round(st.popAt[step]).toLocaleString() + ' people' : 'ghost town (no one lives here)'} · founded year ${h.year[st.born]} · ${eraOf(k).toLowerCase()}`
          + (k ? `\nKnows: ${namesOf(k).join(', ')}` : '');
        if (st.traitsAt && st.popAt[step] > 0){
          const NT = TRAITS.length, v = (i) => st.traitsAt[step * NT + i] / 255;
          const words = TRAITS.map((t, i) => describe(i, v(i))).filter(Boolean);
          town += `\nWays: ${words.length ? words.join(', ') : 'middling in everything'} (` + TRAITS.map((t, i) => t.key + ' ' + v(i).toFixed(2)).join(', ') + ')';
        }
        if (st.raids || st.raided) town += `\nRaids: made ${st.raids || 0} (won ${st.wins || 0}) · raided ${st.raided || 0} times (over the whole history)`;
        const found = h.log.filter((e) => e.tag === t && e.step <= step && e.tech >= 0).map((e) => `${e.text.replace(st.name + ' discovers ', '')} (${h.year[e.step]})`);
        if (found.length) town += `\nDiscovered here: ${found.join(', ')}`;
      }
      if (c >= 0 && sim.farm[c]) town += '\nFarmland';
      // the building under the pointer
      const Bd = h.buildings, rr = Math.max(15, 6 / scale);
      let best = -1, bd = rr;
      for (let b = 0; b < Bd.n; b++){
        if (Bd.born[b] > step || (Bd.died[b] && Bd.died[b] <= step)) continue;
        const dd = Math.hypot(Bd.x[b] - x, Bd.z[b] - z); if (dd < bd){ bd = dd; best = b; }
      }
      if (best >= 0) town += `\n${['Home of a farming family', '', 'Workshop and home of crafts people', 'Shop and home of traders', 'Factory', 'Homes of factory workers'][Bd.kind[best]]}` + (Bd.st ? ` · ${Bd.st[best]} storey${Bd.st[best] > 1 ? 's' : ''}` + (Bd.rebuilt[best] && Bd.rebuilt[best] <= step ? ` (rebuilt year ${h.year[Bd.rebuilt[best]]})` : '') : '') + `, built year ${h.year[Bd.born[best]]}` + (Bd.empty[best] && Bd.empty[best] <= step ? ` · empty since year ${h.year[Bd.empty[best]]}` : '') + (Bd.died[best] ? ` · falls down year ${h.year[Bd.died[best]]}` : '');
      const recent = h.log.filter((e) => e.step <= step).slice(-3).map((e) => `${h.year[e.step]}: ${e.text}`);
      if (recent.length) town += `\nLatest: ${recent.join(' · ')}`;
      hover = `\nHere: ${wt === 1 ? 'sea' : wt === 2 ? 'lake' : wt === 3 ? 'river' : LIFE[w.life[k]]} · height ${Math.round(w.elev[k])} m · fertility ${(w.fert[k] * 100).toFixed(0)}%` + town;
      return;
    }
    if (h && step >= 0){
      let best = null, bd = 1e9;
      for (const st of h.settlements){
        const pop = st.popAt[step]; if (!(pop > 0)) continue;
        const dd = Math.hypot(st.xAt[step] * 1000 - x, st.zAt[step] * 1000 - z), lim = Math.max(radiusKm(pop) * 1000, 6 / scale);
        if (dd < lim && dd < bd){ bd = dd; best = st; }
      }
      // a farm plot or a centre here?
      const F = h.farms, fi = Math.floor((x + F.half) / F.cell), fj = Math.floor((z + F.half) / F.cell);
      const fo = fi >= 0 && fj >= 0 && fi < F.res && fj < F.res ? F.owner[fj * F.res + fi] : -1;
      const fu = fo >= 0 ? F.until[fj * F.res + fi] : 0;
      if (!best && fo >= 0 && F.since[fj * F.res + fi] <= step && !(fu && fu <= step)) town = `\nFarmland of ${h.settlements[fo].name} since year ${h.year[F.since[fj * F.res + fi]]}`;
      const cen = h.centres.find((c) => c.born <= step && Math.hypot(c.x * 1000 - x, c.z * 1000 - z) < Math.max(80, 6 / scale));
      if (cen) town += `\nDistribution centre, since year ${h.year[cen.born]}`;
      if (best) town = `\n${best.name}: ${Math.round(best.popAt[step]).toLocaleString()} people · founded year ${h.year[best.born]}`
        + (best.died && best.died <= step ? '' : best.died ? (best.mergedInto >= 0 ? ` · merges into ${h.settlements[best.mergedInto].name} in year ${h.year[best.died]}` : ` · gone by year ${h.year[best.died]}`) : '');
      // a town block here?
      const BK = h.blocks;
      if (show.blocks && BK && step >= BK.from){
        if (blockFor !== BK){ blockFor = BK; blockKey = new Map(); for (let b = 0; b < BK.n; b++) blockKey.set(BK.j[b] * BK.res + BK.i[b], b); }
        const b = blockKey.get(Math.floor((z + BK.half) / BK.size) * BK.res + Math.floor((x + BK.half) / BK.size)), v = BK.snap[step - BK.from];
        if (b !== undefined && b < v.length && v[b]){
          let built = BK.born[b];
          for (let e = 0; e < BK.evB.length && BK.evS[e] <= step; e++) if (BK.evB[e] === b) built = BK.evS[e];
          const sto = v[b] & 63;
          town += `\nBlock: ${ZONES[v[b] >> 6]} · ${sto} storey${sto > 1 ? 's' : ''} · built year ${h.year[built]} · ${h.settlements[BK.owner[b]].name}`;
        }
      }
    }
    hover = `\nHere: ${wt === 1 ? 'sea' : wt === 2 ? 'lake' : wt === 3 ? 'river' : LIFE[w.life[k]]} · height ${Math.round(w.elev[k])} m · ${w.temp[k].toFixed(1)} °C`
      + ` · humidity ${(w.humid[k] * 100).toFixed(0)}% · fertility ${(w.fert[k] * 100).toFixed(0)}%` + town;
  });
  cv.addEventListener('pointerup', () => { drag = null; });
  cv.addEventListener('dblclick', () => { cx = state.pos[0]; cz = state.pos[2]; });
  cv.addEventListener('contextmenu', (e) => e.preventDefault());

  return {
    isOpen: () => open,
    /** next (+1) or previous (-1) layer */
    layer(step){ layer = (layer + step + LAYERS.length) % LAYERS.length; },
    toggle(){
      if (!current.world) return false;
      open = !open;
      cv.hidden = !open; info.hidden = !open; timeBox.hidden = !open || !current.history;
      if (open){ cx = state.pos[0]; cz = state.pos[2]; if (document.pointerLockElement) document.exitPointerLock(); state.keys.clear(); draw(); }
      return open;
    },
  };
}
