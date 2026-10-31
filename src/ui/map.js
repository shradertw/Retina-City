/* The overhead map (Z): the natural maps as layers (L to switch), roads, buildings, street lights, chunk
   borders and you. Scroll to zoom (around the pointer), drag to pan, double-click to centre on yourself, Z or Esc to close.
   Chunks are generated as they come into view, a few milliseconds' worth per frame, so the map never stalls;
   finer detail shows as you zoom in. */
import { current } from '../gen/current.js';
import { state } from '../core/state.js';
import { ROAD_CHUNK, SAMPLES } from '../gen/roads.js';
import { LIFE, METALS } from '../gen/world.js';

// map layers: what each shows, and its legend
const LAYERS = [
  { key: 'terrain', name: 'Terrain', legend: 'green low land to brown and grey high ground, shaded from the north-west; blue water, rivers' },
  { key: 'temp', name: 'Temperature', legend: 'blue -10 °C, white 10 °C, red 30 °C' },
  { key: 'humid', name: 'Humidity', legend: 'tan dry to dark blue wet' },
  { key: 'fert', name: 'Fertility', legend: 'grey barren to bright green fertile' },
  { key: 'life', name: 'Life', legend: '' },
  { key: 'metals', name: 'Metals', legend: METALS.map((m, i) => m).join(', ') + ' (dot size = deposit size)' },
];
const LIFE_COL = [[18, 40, 60], [40, 80, 110], [214, 200, 150], [235, 240, 245], [150, 150, 120], [40, 80, 55], [160, 150, 100],
  [150, 175, 80], [55, 110, 50], [220, 190, 120], [190, 170, 80], [25, 95, 40], [130, 125, 120]];
const METAL_COL = ['#c0603a', '#d08a3a', '#222222', '#f2d24a'];
LAYERS[4].legend = LIFE.slice(2).map((n) => n).join(', ');

export function initMap(){
  const cv = /** @type {HTMLCanvasElement} */ (document.getElementById('map'));
  const info = document.getElementById('mapInfo');
  const ctx = cv.getContext('2d');
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
      } else if (key === 'terrain' || key === 'metals'){
        const u = h / w.relief;
        if (u < 0.25){ r = lerp(70, 120, u / 0.25); gg = lerp(105, 125, u / 0.25); b = lerp(60, 72, u / 0.25); }
        else if (u < 0.6){ r = lerp(120, 125, (u - 0.25) / 0.35); gg = lerp(125, 105, (u - 0.25) / 0.35); b = lerp(72, 80, (u - 0.25) / 0.35); }
        else { r = lerp(125, 205, (u - 0.6) / 0.4); gg = lerp(105, 200, (u - 0.6) / 0.4); b = lerp(80, 195, (u - 0.6) / 0.4); }
        r *= shade; gg *= shade; b *= shade;
        if (key === 'metals'){ const m = (r + gg + b) / 3; r = gg = b = m * 0.8; }
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
    for (const [x, z] of list){
      const fresh = !current.roads.cached(x, z) || (showBuildings && !current.blocks.cached(x, z));
      if (fresh && performance.now() - t0 > 20){ pending++; continue; }
      for (const e of current.roads.chunk(x, z)){
        ctx.strokeStyle = e.major ? '#d8cfb8' : '#a9a49a';
        ctx.lineWidth = Math.max(e.major ? 1.6 : 1, e.w * scale * d);
        ctx.beginPath();
        for (let k = 0; k <= SAMPLES; k++){ const px = toX(e.pts[2 * k]), pz = toY(e.pts[2 * k + 1]); if (k) ctx.lineTo(px, pz); else ctx.moveTo(px, pz); }
        ctx.stroke();
      }
      if (showBuildings){
        const ch = current.blocks.chunk(x, z);
        for (const b of ch.buildings){
          ctx.fillStyle = b.kind === 2 ? '#7f8a99' : b.kind === 1 ? '#8b8a84' : '#93705f';
          const vx = -b.uz, vz = b.ux;
          ctx.beginPath();
          ctx.moveTo(toX(b.x - b.ux * b.hx - vx * b.hz), toY(b.z - b.uz * b.hx - vz * b.hz));
          ctx.lineTo(toX(b.x + b.ux * b.hx - vx * b.hz), toY(b.z + b.uz * b.hx - vz * b.hz));
          ctx.lineTo(toX(b.x + b.ux * b.hx + vx * b.hz), toY(b.z + b.uz * b.hx + vz * b.hz));
          ctx.lineTo(toX(b.x - b.ux * b.hx + vx * b.hz), toY(b.z - b.uz * b.hx + vz * b.hz));
          ctx.closePath(); ctx.fill();
          if (showLamps && b.door){                           // door: a dot on the front, which faces the road
            const fx = b.x + b.ux * b.door.off + vx * b.hz * -b.side, fz = b.z + b.uz * b.door.off + vz * b.hz * -b.side;
            ctx.fillStyle = '#f0b25c'; ctx.fillRect(toX(fx) - 1.5 * d, toY(fz) - 1.5 * d, 3 * d, 3 * d);
          }
        }
        if (showLamps){
          ctx.fillStyle = '#ffd27a';
          for (const l of ch.lamps){ ctx.beginPath(); ctx.arc(toX(l.x), toY(l.z), 1.6 * d, 0, 6.2832); ctx.fill(); }
        }
      }
    }
    // metal deposits
    if (LAYERS[layer].key === 'metals'){
      for (const m of w.metals){
        ctx.fillStyle = METAL_COL[m.type]; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(toX(m.x), toY(m.z), Math.max(2.5, m.size * 300 * scale) * d, 0, 6.2832); ctx.fill(); ctx.stroke();
      }
    }
    // chunk borders
    if (scale >= 0.03 && scale < 2){
      ctx.strokeStyle = 'rgba(240,178,92,0.18)'; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = c0x; x <= c1x + 1; x++){ ctx.moveTo(toX(x * ROAD_CHUNK), toY(Math.max(z0, -w.half))); ctx.lineTo(toX(x * ROAD_CHUNK), toY(Math.min(z1, w.half))); }
      for (let z = c0z; z <= c1z + 1; z++){ ctx.moveTo(toX(Math.max(x0, -w.half)), toY(z * ROAD_CHUNK)); ctx.lineTo(toX(Math.min(x1, w.half)), toY(z * ROAD_CHUNK)); }
      ctx.stroke();
    }
    // you: an arrow pointing where you look
    const px = toX(state.pos[0]), pz = toY(state.pos[2]), a = state.yaw, s = 9 * d;
    ctx.save(); ctx.translate(px, pz); ctx.rotate(a);
    ctx.fillStyle = '#f0b25c'; ctx.strokeStyle = '#0b0e10'; ctx.lineWidth = 2 * d;
    ctx.beginPath(); ctx.moveTo(0, -s); ctx.lineTo(s * 0.6, s * 0.7); ctx.lineTo(0, s * 0.35); ctx.lineTo(-s * 0.6, s * 0.7); ctx.closePath();
    ctx.stroke(); ctx.fill(); ctx.restore();
    // scale bar
    const nice = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];
    const m = nice.find((v) => v * scale >= 90) || 50000, bw = m * scale * d, by = H() - 28 * d, bx = 20 * d;
    ctx.fillStyle = '#e8e4d6'; ctx.fillRect(bx, by, bw, 2 * d);
    ctx.font = (11 * d) + 'px "Martian Mono", ui-monospace, monospace'; ctx.fillText(m >= 1000 ? m / 1000 + ' km' : m + ' m', bx, by - 6 * d);
    info.textContent = `World ${current.options.size} km · seed ${current.options.seed}` + (pending ? ` · generating ${pending} chunks…` : '')
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
    hover = `\nHere: ${wt === 1 ? 'sea' : wt === 2 ? 'lake' : wt === 3 ? 'river' : LIFE[w.life[k]]} · height ${Math.round(w.elev[k])} m · ${w.temp[k].toFixed(1)} °C`
      + ` · humidity ${(w.humid[k] * 100).toFixed(0)}% · fertility ${(w.fert[k] * 100).toFixed(0)}%`;
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
      cv.hidden = !open; info.hidden = !open;
      if (open){ cx = state.pos[0]; cz = state.pos[2]; if (document.pointerLockElement) document.exitPointerLock(); state.keys.clear(); draw(); }
      return open;
    },
  };
}
