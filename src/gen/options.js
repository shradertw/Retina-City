/* World generation options. The start screen is built from this list, so a new option is one more entry
   here (plus whatever reads it). Kinds: 'range' (slider) and 'seed' (number with a dice button). Options with
   a group are shown together in a fold-out section of that name. */
export const WORLD_OPTIONS = [
  { key: 'size', label: 'World size', kind: 'range', min: 1, max: 256, step: 1, def: 32, unit: 'km' },
  { key: 'lat', label: 'Latitude', kind: 'range', min: 0, max: 70, step: 1, def: 45, unit: '°' },
  { key: 'seed', label: 'Seed', kind: 'seed', min: 0, max: 999999, def: 1337 },
  // settlements (age 2): see src/gen/history.js
  { key: 'settleRate', group: 'History', label: 'New settlements', kind: 'range', min: 25, max: 400, step: 25, def: 100, unit: '%' },
  { key: 'gap', group: 'History', label: 'Spacing between settlements', kind: 'range', min: 0.3, max: 5, step: 0.1, def: 1.2, unit: 'km' },
  { key: 'farm', group: 'History', label: 'Farmland around a settlement', kind: 'range', min: 0.5, max: 6, step: 0.1, def: 2.5, unit: 'km' },
  { key: 'trade', group: 'History', label: 'Pull of bigger towns (trade)', kind: 'range', min: 0, max: 400, step: 10, def: 100, unit: '%' },
  { key: 'setbacks', group: 'History', label: 'Setbacks (fire, plague, raids)', kind: 'range', min: 0, max: 400, step: 10, def: 100, unit: '%' },
];
const STORE = 'retina-world-options';
// the saved choices (or defaults), checked against the list above
export function loadWorldOptions(){
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch (_){ }
  const out = {};
  for (const o of WORLD_OPTIONS){
    const v = Number(saved[o.key]);
    out[o.key] = Number.isFinite(v) ? Math.min(o.max, Math.max(o.min, v)) : o.def;
  }
  return out;
}
export function saveWorldOptions(opts){ try { localStorage.setItem(STORE, JSON.stringify(opts)); } catch (_){ } }
