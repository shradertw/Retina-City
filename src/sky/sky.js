/* Sun and moon positions from the time dials, season and latitude; light levels from their heights;
   the day/night cycle. */
import { state } from '../core/state.js';
import { D2R, sstep } from '../core/util.js';

// direction of a body at hour angle H and declination dec (radians), seen from latitude state.lat;
// x east, y up, z north. Declination is how far north of the celestial equator the body is: the sun's
// goes from -23.4 degrees (winter solstice) to +23.4 (summer), the moon's swings up to about +-28.6.
export function skyDir(H, dec = 0){
  const lat = state.lat * D2R;
  const sinEl = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H);
  const el = Math.asin(Math.max(-1, Math.min(1, sinEl)));
  const az = Math.atan2(-Math.sin(H) * Math.cos(dec), Math.sin(dec) * Math.cos(lat) - Math.cos(dec) * Math.sin(lat) * Math.cos(H));
  return { dir: [Math.sin(az) * Math.cos(el), sinEl, Math.cos(az) * Math.cos(el)], el: el / D2R };
}
// Daylight (sun plus sky) relative to a high sun, as log10, from typical outdoor illuminance.
export const DAY_TABLE = [[-90, -9.5], [-18, -9.5], [-12, -7.0], [-6, -4.5], [-3, -3.2], [0, -2.0], [5, -1.1], [10, -0.65], [20, -0.3], [30, -0.12], [42.4, 0], [60, 0.07], [90, 0.1]];   // above 42 degrees: a little brighter still (summer)
export function dayLog(el){
  if (el <= DAY_TABLE[0][0]) return DAY_TABLE[0][1];
  for (let i = 1; i < DAY_TABLE.length; i++){
    const [e1, v1] = DAY_TABLE[i], [e0, v0] = DAY_TABLE[i - 1];
    if (el <= e1) return v0 + (v1 - v0) * (el - e0) / (e1 - e0);
  }
  return 0;
}
// Sky brightness relative to a clear noon sky (log10), from typical measured sky luminance.
// When the sun is down all light comes from the sky itself, so the sky outshines the ground.
export const SKY_TABLE = [[-90, -6.5], [-18, -6.5], [-12, -4.7], [-6, -2.5], [-3, -1.5], [0, -0.82], [5, -0.45], [10, -0.3], [20, -0.12], [42.4, 0]];
export function skyLog(el){
  if (el <= SKY_TABLE[0][0]) return SKY_TABLE[0][1];
  for (let i = 1; i < SKY_TABLE.length; i++){
    const [e1, v1] = SKY_TABLE[i], [e0, v0] = SKY_TABLE[i - 1];
    if (el <= e1) return v0 + (v1 - v0) * (el - e0) / (e1 - e0);
  }
  return 0;
}
export const elongation = () => ((180 - state.phaseDeg) % 360 + 360) % 360;   // moon's angle from the sun, east
export function moonHours(){ return state.moonCouple ? (((state.timeH - elongation() / 15) % 24) + 24) % 24 : state.moonH; }
export function fmtClock(h){ const hh = Math.floor(h), mm = Math.round((h - hh) * 60); return String(hh % 24).padStart(2, "0") + ":" + String(mm % 60).padStart(2, "0"); }
export function phaseName(e){
  const n = [[22.5, "new"], [67.5, "waxing crescent"], [112.5, "first quarter"], [157.5, "waxing gibbous"], [202.5, "full"],
             [247.5, "waning gibbous"], [292.5, "last quarter"], [337.5, "waning crescent"], [361, "new"]];
  for (const [t, name] of n) if (e < t) return name;
}
export function computeSky(){
  const Hs = (state.timeH - 12) * 15 * D2R, Hm = (moonHours() - 12) * 15 * D2R;
  const sun = skyDir(Hs, state.sunDec * D2R), moon = skyDir(Hm, state.moonDec * D2R);
  const e = elongation(), alpha = Math.abs(180 - e);                          // phase angle, 0 = full
  const moonBright = Math.pow(10, -0.4 * (0.026 * alpha + 4e-9 * Math.pow(alpha, 4)));
  // Clouds (when they affect lighting): block the direct sun, scatter part of it back as skylight,
  // dim the total (full overcast ~20% of clear daylight), cut moonlight, grey the sky, soften shadows.
  const cc = state.cloudLight ? state.cloud : 0;
  const block = 0.97 * sstep(0.2, 0.95, cc), dim = 1 - 0.6 * cc * cc;
  const day0 = Math.pow(10, dayLog(sun.el));
  const sunPart0 = day0 * 0.8 * sstep(-1, 3, sun.el);
  const sunPart = sunPart0 * (1 - block);
  const skyPart = ((day0 - sunPart0) + sunPart0 * block * 0.35) * dim;
  const day = sunPart + skyPart;
  const moonTotal = 2.5e-6 * moonBright * (moon.el > 0 ? Math.pow(10, dayLog(moon.el)) : 0) * sstep(-1, 2, moon.el) * (1 - 0.9 * Math.pow(cc, 1.5));
  const starTotal = 5e-9 * (1 - 0.5 * cc);
  const Ltrue = day + moonTotal + starTotal;
  // Scene light is stored divided by L. A floor keeps lamp-lit surfaces at night within the image's range.
  const L = Math.max(Ltrue, 3e-5);
  const skyAbs = Math.pow(10, skyLog(sun.el)) * (1 - 0.5 * cc * cc);
  const sr = Math.min(Math.max(sun.dir[1] / 0.35, 0), 1);
  const sunColor = [1, 0.65 + 0.35 * sr, 0.35 + 0.65 * sr];
  const sunK = sunPart / (0.8 * L), moonK = moonTotal * 0.8 / (0.8 * L);
  let keyDir = [0, 1, 0], keyCol = [0, 0, 0];
  if (sun.el > -0.5 && sunK > 1e-3){ keyDir = sun.dir; keyCol = sunColor.map(c => c * sunK); }
  else if (moon.el > 0 && moonK > 1e-3){ keyDir = moon.dir; keyCol = [0.92 * moonK, 0.95 * moonK, 1.0 * moonK]; }
  const twi = 1 - sstep(-0.10, 0.30, sun.dir[1]);
  const skyK = skyAbs / L;
  const nightSky = (4e-8 * (1 - 0.5 * cc) + 2 * moonTotal) / L;      // airglow (~2e-4 cd/m2) plus moonlit sky
  const ambTint = [1 - 0.25 * twi, 1 - 0.1 * twi, 1 + 0.15 * twi];
  const fog = [0.60, 0.68, 0.78].map((c, i) => c * skyK * (i === 0 ? 1 + 0.2 * twi : 1) + [0.45, 0.55, 0.85][i] * nightSky);
  // star field turns about the celestial pole with the time of day
  const ax = [0, Math.sin(state.lat * D2R), Math.cos(state.lat * D2R)], th = -Hs, cs = Math.cos(th), sn = Math.sin(th), oc = 1 - cs;
  const rot = new Float32Array([
    cs + ax[0]*ax[0]*oc,        ax[1]*ax[0]*oc + ax[2]*sn, ax[2]*ax[0]*oc - ax[1]*sn,
    ax[0]*ax[1]*oc - ax[2]*sn,  cs + ax[1]*ax[1]*oc,       ax[2]*ax[1]*oc + ax[0]*sn,
    ax[0]*ax[2]*oc + ax[1]*sn,  ax[1]*ax[2]*oc - ax[0]*sn, cs + ax[2]*ax[2]*oc]);
  const moonExt = 0.35 + 0.65 * sstep(0, 0.3, moon.dir[1]);
  // street lights: on from shortly before sunset to shortly after sunrise
  const lampOn = state.lamps ? 1 - sstep(0, 5, sun.el) : 0;
  return { sun, moon, L, Ltrue, lampOn, lampK: lampOn * state.lampGain * 2.6 / 0.8e5 / L, lampEmit: lampOn * state.lampGain * 2.5 / L, sunK, keyDir, keyCol, sunColor, twi, skyK, nightSky, ambTint, fog, rot, e,
           sunDiskK: sunPart0 / (0.8 * L), cloudGrey: cc, shadowK: 60 * (1 - cc) + 4 * cc,
           // ambient: the ground is lit by the sky, so it follows the sky's brightness (1 at noon)
           ambK: skyAbs / L + (moonTotal + starTotal) / L,
           // At night the disk is drawn far below its real brightness (the patch of retina looking at it adapts
           // on its own). In daylight it shows at roughly its real contrast: the full moon (~2500 cd/m2) against
           // a blue sky of ~3000-8000 cd/m2 adds about a quarter to the sky behind it, faint but findable.
           moonDisk: (0.5 + 400 * skyAbs) * moonExt / L };
}
export function realMoonDec(){
  const lamS = Math.asin(Math.max(-1, Math.min(1, state.sunDec / 23.44)));   // the sun's place on the ecliptic (spring side)
  return Math.asin(Math.sin(23.44 * D2R) * Math.sin(lamS + elongation() * D2R)) / D2R;
}
export function advanceSky(dt){
  if (!state.cycle) return;
  const dH = dt * 24 / (state.dayMin * 60), dDays = dH / 24;
  state.timeH = ((state.timeH + dH) % 24 + 24) % 24;
  if (state.realMoon){
    state.phaseDeg = ((state.phaseDeg - 360 / 29.53 * dDays) % 360 + 360) % 360;   // elongation grows
    state.moonDec = realMoonDec();
    return;
  }
  if (!state.moonCouple) state.moonH = ((state.moonH + dH) % 24 + 24) % 24;
  state.phaseDebt += state.phaseStep * dDays;
  const mEl = skyDir((moonHours() - 12) * 15 * D2R, state.moonDec * D2R).el;
  const rate = mEl < -1 ? 4 : state.phaseDebt > 1.5 * state.phaseStep ? 1.5 : 0;   // per day, in steps
  const pay = Math.min(state.phaseDebt, rate * state.phaseStep * dDays);
  state.phaseDebt -= pay;
  state.phaseDeg = ((state.phaseDeg - pay) % 360 + 360) % 360;
}
