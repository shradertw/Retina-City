/* The start screen's world options, built from the list in gen/options.js, and its title, which follows
   what is ready: "New world" until a world is generated, "Loading…" while shaders still compile, then
   "Click to enter the city". */
import { WORLD_OPTIONS, loadWorldOptions, saveWorldOptions } from '../gen/options.js';

/** @param {{ onGenerate: (opts: Record<string, number>) => void }} hooks */
export function initStartPanel(hooks){
  const box = document.getElementById('worldOptions'), btn = document.getElementById('generate');
  const title = document.getElementById('startTitle');
  const opts = loadWorldOptions();
  let shadersReady = false, worldReady = false;
  const showTitle = () => { title.textContent = !worldReady ? 'New world' : !shadersReady ? 'Loading…' : 'Click to enter the city'; };
  for (const o of WORLD_OPTIONS){
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
      if (Number.isFinite(v)) opts[o.key] = Math.min(o.max, Math.max(o.min, Math.round(v)));
      show();
    });
    row.addEventListener('click', (e) => e.stopPropagation());   // adjusting an option does not enter the city
    show(); box.append(row);
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
  showTitle();
  return {
    setShadersReady(){ shadersReady = true; showTitle(); },
    ready: () => shadersReady && worldReady,
  };
}
