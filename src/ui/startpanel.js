/* The start screen's world options, built from the list in gen/options.js, and its title, which follows
   what is ready: "New world" until a world is generated; then the map is open and the 3D view is loaded only
   when asked for (a click on the card: its shaders take a while to compile); "Loading…" meanwhile; then
   "Click to enter the city". */
import { WORLD_OPTIONS, loadWorldOptions, saveWorldOptions } from '../gen/options.js';

/** @param {{ onGenerate: (opts: Record<string, number>) => void, onLoad3D: () => void }} hooks */
export function initStartPanel(hooks){
  const box = document.getElementById('worldOptions'), btn = document.getElementById('generate');
  const title = document.getElementById('startTitle');
  const opts = loadWorldOptions();
  let shadersReady = false, worldReady = false, loading = false;
  const startEl = document.getElementById('start');
  const showTitle = () => {
    title.textContent = !worldReady ? 'New world' : shadersReady ? 'Click to enter the city'
      : loading ? 'Loading the 3D city…' : 'World ready · Z: map · click here to load the 3D city';
    startEl.classList.toggle('ready', worldReady && (shadersReady || !loading));   // the hand cursor only when a click does something
  };
  const groups = new Map();
  for (const o of WORLD_OPTIONS){
    let parent = box;
    if (o.group){
      // a fold-out section per group (closed at first)
      let g = groups.get(o.group);
      if (!g){
        g = document.createElement('details'); g.className = 'wgroup';
        const sm = document.createElement('summary'); sm.textContent = o.group; g.append(sm);
        g.addEventListener('click', (e) => e.stopPropagation());
        box.append(g); groups.set(o.group, g);
      }
      parent = g;
    }
    const row = document.createElement('div'); row.className = 'wopt';
    const id = 'wopt-' + o.key;
    const label = document.createElement('label'); label.htmlFor = id; label.textContent = o.label;
    const out = document.createElement('output');
    const input = document.createElement('input'); input.id = id;
    input.min = String(o.min); input.max = String(o.max); input.value = String(opts[o.key]);
    const show = () => { out.textContent = o.kind === 'range' ? opts[o.key] + ' ' + (o.unit || '') + (o.note ? ' · ' + o.note(opts[o.key]) : '') : ''; };
    row.append(label, out);
    if (o.kind === 'range'){ input.type = 'range'; input.step = String(o.step); row.append(input); }
    else {
      input.type = 'number'; input.step = '1';
      const dice = document.createElement('button'); dice.type = 'button'; dice.textContent = 'Random'; dice.className = 'dice';
      dice.addEventListener('click', (e) => { e.stopPropagation(); opts[o.key] = Math.floor(Math.random() * (o.max + 1)); input.value = String(opts[o.key]); });
      const pair = document.createElement('div'); pair.className = 'seedrow'; pair.append(input, dice); row.append(pair);
    }
    input.addEventListener('input', () => {
      const v = Number(input.value);
      const st = o.step || 1;                     // keep to the option's steps (some are tenths)
      if (Number.isFinite(v)) opts[o.key] = Math.min(o.max, Math.max(o.min, +(Math.round(v / st) * st).toFixed(3)));
      show();
    });
    row.addEventListener('click', (e) => e.stopPropagation());   // adjusting an option does not enter the city
    show(); parent.append(row);
  }
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    saveWorldOptions(opts);
    btn.disabled = true; btn.textContent = 'Generating…';
    setTimeout(() => {                     // let the button's new label show before the work starts
      hooks.onGenerate({ ...opts });
      worldReady = true; btn.disabled = false; btn.textContent = 'Generate again'; showTitle();
    }, 30);
  });
  startEl.addEventListener('click', () => {
    if (!worldReady || shadersReady || loading) return;
    loading = true; showTitle();
    hooks.onLoad3D();
  });
  showTitle();
  return {
    setShadersReady(){ shadersReady = true; showTitle(); },
    ready: () => shadersReady && worldReady,
  };
}
