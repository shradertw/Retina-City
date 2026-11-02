/* World generation options. The start screen is built from this list, so a new option is one more entry
   here (plus whatever reads it). Kinds: 'range' (slider) and 'seed' (number with a dice button). Options with
   a group are shown together in a fold-out section of that name. */
export const WORLD_OPTIONS = [
  { key: 'size', label: 'World size', kind: 'range', min: 1, max: 256, step: 1, def: 32, unit: 'km' },
  { key: 'lat', label: 'Latitude', kind: 'range', min: 0, max: 70, step: 1, def: 45, unit: '°' },
  { key: 'seed', label: 'Seed', kind: 'seed', min: 0, max: 999999, def: 1337 },
  // the history simulation: see src/gen/sim.js
  { key: 'duration', group: 'History', label: 'Duration', kind: 'range', min: 100, max: 10000, step: 100, def: 1000, unit: 'years' },
  { key: 'startDensity', group: 'History', label: 'People at the start (foragers), per 100 km² of land', kind: 'range', min: 10, max: 300, step: 10, def: 60, unit: 'people' },
  { key: 'tagRadius', group: 'History', label: 'Settlement radius (a lone building starts a new one)', kind: 'range', min: 0.3, max: 3, step: 0.1, def: 1, unit: 'km' },
  { key: 'rival', group: 'History', label: 'Chance a building joins a rival settlement', kind: 'range', min: 0, max: 30, step: 1, def: 5, unit: '%' },
  { key: 'discovery', group: 'History', label: 'Pace of discovery: chance an average farming family invents the plough within 100 years', kind: 'range', min: 2, max: 60, step: 1, def: 15, unit: '%' },
  { key: 'sharedKnow', group: 'History', label: 'Knowledge shared by the whole settlement', kind: 'check', min: 0, max: 1, def: 0 },
  { key: 'setbackRisk', group: 'History', label: 'Setbacks: chance a settlement has a fire, plague or raid within 100 years (each costs 15-40% of its people)', kind: 'range', min: 0, max: 90, step: 1, def: 33, unit: '%' },
  { key: 'links', group: 'History', label: 'Roads from each town to its nearest', kind: 'range', min: 1, max: 4, step: 1, def: 2, unit: 'towns' },
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
