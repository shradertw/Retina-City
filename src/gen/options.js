/* World generation options. The start screen is built from this list, so a new option is one more entry
   here (plus whatever reads it). Kinds: 'range' (slider) and 'seed' (number with a dice button). */
export const WORLD_OPTIONS = [
  { key: 'size', label: 'World size', kind: 'range', min: 1, max: 256, step: 1, def: 32, unit: 'km' },
  { key: 'seed', label: 'Seed', kind: 'seed', min: 0, max: 999999, def: 1337 },
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
