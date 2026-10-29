import { SEED, CELL, HALF, LAMP_TOP, hu, h2, hf, rnd } from './world/hash.js';
import { CITY_N, city, buildCity, getBld, slabBoxesJS } from './world/cityplan.js';
import { compilePrograms, nextPaint } from './core/gpu.js';
import { loadReport } from './ui/loading.js';
import { initStartPanel } from './ui/startpanel.js';
import { initMap } from './ui/map.js';
import { buildWorld } from './gen/world.js';
import { makeRoads } from './gen/roads.js';
import { makeBlocks } from './gen/blocks.js';
import { current } from './gen/current.js';
import { BUILD } from './version.js';
import { VS, FS, LUMA, LIDS, PROJ, CELLFN } from './shaders/common.js';
import { SCENE_FS } from './shaders/scene.js';
import { state } from './core/state.js';
import { $, D2R, sstep } from './core/util.js';
import { onSlab, groundAt, lampJS, lampBasesJS, lampLuxJS, collide, bldCache, bldAt, sdBox3, mapJS, groundJS, castJS } from './world/query.js';
import { skyDir, DAY_TABLE, dayLog, SKY_TABLE, skyLog, elongation, moonHours, fmtClock, phaseName, computeSky, realMoonDec, advanceSky } from './sky/sky.js';
import { drawDials, syncCycleUI, initDials } from './ui/dials.js';
import { drawCompass } from './ui/compass.js';
import { RESOLVE_FS, ACCUM_FS, DOF_FS, DOWN_FS, GDOWN_FS, BDOWN_FS, BUP_FS, STREAK_FS, AFTER_FS, SQAVG_FS, LIDGLOW_FS, METER_FS, PRESENT_FS } from './shaders/post.js';

// Everything that runs: WebGL setup, state and controls, sky, movement, the frame loop and the eye.
async function start(){
"use strict";
/* ---------------- WebGL setup ---------------- */
const canvas = document.getElementById("view");
const errBox = (msg) => { const d = document.createElement("div"); d.className = "err"; d.textContent = msg; document.body.appendChild(d); };
const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, powerPreference: "high-performance" });
if (!gl){ errBox("This page needs WebGL2. Try a current Chrome, Edge or Firefox with hardware acceleration enabled."); return; }
const floatFB = !!gl.getExtension("EXT_color_buffer_float");

let sceneP, resolveP, accumP, presentP, dofP, meterP, downP, downT = null, gdownP, bdownP, bupP, streakP, glareH = null, glareD = [], glareU = [], streakT = null, streakA = null, streakB = null, afterP, afterT = null, sqavgP, sqAvgT = null, lidglowP, lidGlowT = null, sqAvgI = 0, sqDt = 0;
// Loading: all shaders compile at once; the city plan is generated on this thread meanwhile.
// The start screen: world options and Generate (the new generator, shown on the map for now; the 3D view
// still draws the old city until the renderer switch). Nothing heavy happens before Generate is pressed:
// the first press builds the world, then compiles the shaders and the old city plan.
const load = loadReport({ onReady: () => startPanel.setShadersReady() });
let generatedOnce = null;
const firstGenerate = new Promise((resolve) => { generatedOnce = resolve; });
const startPanel = initStartPanel({ onGenerate: (opts) => {
  const t = performance.now();
  const w = buildWorld(opts), roads = makeRoads(w);
  Object.assign(current, { world: w, roads, blocks: makeBlocks(w, roads), options: opts });
  current.blocks.chunk(Math.floor(state.pos[0] / 512), Math.floor(state.pos[2] / 512));   // the start area, ready on the map
  load.set("World (" + opts.size + " km)", performance.now() - t);
  window.__lastWorldMs = performance.now() - t;
  if (generatedOnce){ generatedOnce(); generatedOnce = null; }
} });
const worldMap = initMap();
$("buildStamp").textContent = "Build " + BUILD;
window.__gen = current;
load.set("Page and modules", performance.now());
await firstGenerate;
const tGenerate = performance.now() - (window.__lastWorldMs || 0);
load.set("Shaders and city plan", "working…");
await nextPaint();
try {
  const t0 = performance.now();
  const P = await compilePrograms(gl, VS, { sceneP: SCENE_FS, resolveP: RESOLVE_FS, accumP: ACCUM_FS, presentP: PRESENT_FS,
    dofP: DOF_FS, meterP: METER_FS, downP: DOWN_FS, gdownP: GDOWN_FS, bdownP: BDOWN_FS, bupP: BUP_FS, streakP: STREAK_FS,
    afterP: AFTER_FS, sqavgP: SQAVG_FS, lidglowP: LIDGLOW_FS },
    () => { const t = performance.now(); buildCity(); load.set("City plan", performance.now() - t); },
    { serial: new URLSearchParams(location.search).has("serial"), onEach: (name, ms) => load.set("  " + name.replace(/P$/, ""), ms) });
  ({ sceneP, resolveP, accumP, presentP, dofP, meterP, downP, gdownP, bdownP, bupP, streakP, afterP, sqavgP, lidglowP } = P);
  load.set("Shaders and city plan", performance.now() - t0);
}
catch (e){ errBox("Shader error:\n" + e.message); window.__shaderError = e.message; load.fail(); return; }
const tSetup = performance.now();
window.__ready = true;

// the city plan (bound to texture unit 12 before each scene draw)
const cityTex = gl.createTexture();
{ const t = cityTex;
  gl.activeTexture(gl.TEXTURE12); gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, CITY_N * 6, CITY_N, 0, gl.RGBA, gl.FLOAT, city.data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.activeTexture(gl.TEXTURE0); }
const vbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

const FMT = floatFB ? gl.RGBA16F : gl.RGBA8;
function makeTarget(w, h, opts = {}){
  const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
  const levels = opts.mips ? Math.floor(Math.log2(Math.max(w, h))) + 1 : 1;
  gl.texStorage2D(gl.TEXTURE_2D, levels, FMT, w, h);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, opts.mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, opts.repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { tex, fbo, w, h };
}
function freeTarget(t){ if (t){ gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); } }

let dofT = null, dofMaxR = 0, diploMaxD = 1;   // diploMaxD: largest |1/distance - 1/focus| seen by the probes
// eye light meter: rendered to one pixel and read back asynchronously (no frame stall)
let meterT = null, meterPbo = null, meterFence = null;
const meterBuf = new Float32Array(8);
let W = 0, H = 0, resolveTs = [null, null], resIdx = 0, havePrev = false, hist = [null, null], histIdx = 0;
let atlasT = null, atlasKey = "", lpT = null, lpKey = "", needReset = true;
function resize(){
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(2, Math.round(window.innerWidth * dpr * state.scale));
  const h = Math.max(2, Math.round(window.innerHeight * dpr * state.scale));
  if (w === W && h === H) return;
  W = w; H = h; canvas.width = w; canvas.height = h;
  freeTarget(resolveTs[0]); freeTarget(resolveTs[1]); freeTarget(hist[0]); freeTarget(hist[1]); freeTarget(dofT);
  resolveTs = [makeTarget(w, h), makeTarget(w, h)]; hist = [makeTarget(w, h), makeTarget(w, h)]; dofT = makeTarget(w, h); havePrev = false;
  atlasKey = ""; needReset = true;
  if (!state.mouseGaze){ state.gaze = [w/2, h/2]; }
  updateReadouts();
}

/* ---------------- State and controls ---------------- */
const modeBtns = [$("m0"), $("m1"), $("m2")];
const modeNames = ["Eye mode", "Standard rendering", "Detail map"];
function setMode(m){
  state.mode = m;
  modeBtns.forEach((b, i) => b.setAttribute("aria-pressed", String(i === m)));
  $("legend").hidden = m !== 2;
  $("crossnote").textContent = "Seed " + SEED + " · " + modeNames[m];
}
modeBtns.forEach((b, i) => b.addEventListener("click", () => setMode(i)));

function arcmin(rad){ return rad * 10800 / Math.PI; }
// Projection: returns the half-width of the projection plane and the angle actually used.
function projection(){
  const d = state.panini ? state.paniniD : 0;
  let limit = 85;                                           // a flat perspective image cannot reach 90° to each side
  if (state.panini) limit = Math.min(105, (d >= 1.02 ? 180 : Math.acos(0.02 - d) * 180 / Math.PI) * 0.995);
  const half = Math.min(state.fov / 2, limit);
  const phi = half * Math.PI / 180;
  const xmax = (d + 1) / (d + Math.cos(phi)) * Math.sin(phi);
  return { d, half, xmax, limited: half < state.fov / 2 - 0.01 };
}
function fmtArcmin(a){ return a < 0.1 ? a.toFixed(3) : a < 1 ? a.toFixed(2) : a.toFixed(1); }
function updateReadouts(){
  const pr = projection();
  const pix = arcmin(2 * pr.xmax / (W || 1));             // centre pixel, unzoomed, as the viewer sees it
  $("acuityOut").textContent = fmtArcmin(state.acuity) + "′";
  $("fovOut").textContent = pr.limited ? state.fov + "° (using " + Math.round(pr.half * 2) + "°)" : state.fov + "°";
  $("zoomOut").textContent = state.zoomLevel.toFixed(2) + "×";
  $("paniniOut").textContent = state.paniniD.toFixed(2);
  ["ring0","ring1","ring2"].forEach(r => $(r + "Out").textContent = state[r] + "°");
  $("paniniSub").setAttribute("aria-disabled", String(!state.panini));
  $("ringSub").setAttribute("aria-disabled", String(!state.rings));
  $("cellOut").textContent = state.cell + " px";
  $("pupilOut").textContent = state.pupil.toFixed(1) + " mm" + (state.autoPupil ? " (auto)" : "");
  $("pupil").disabled = state.autoPupil;
  $("cloudOut").textContent = Math.round(state.cloud * 100) + "%";
  $("lampGainOut").textContent = state.lampGain.toFixed(2) + "x";
  $("moonSizeOut").textContent = state.moonSize.toFixed(2) + "x real";
  { const d = state.sunDec, n = Math.abs(d) < 1 ? "equinox" : d >= 22.9 ? "midsummer" : d <= -22.9 ? "midwinter" : d > 0 ? "summer side" : "winter side";
    const noon = 90 - Math.abs(state.lat - d);
    $("sunDecOut").textContent = n + " · noon sun " + Math.round(noon) + "°"; }
  $("dayMinOut").textContent = state.dayMin + " min";
  $("reflReachOut").textContent = state.reflReach + " m";
  $("phaseStepOut").textContent = state.phaseStep + "°";
  $("moonDecOut").textContent = (state.moonDec >= 0 ? "+" : "") + state.moonDec.toFixed(1) + "° · highest " + Math.round(90 - Math.abs(state.lat - state.moonDec)) + "°";
  $("latOut").textContent = state.lat.toFixed(1) + "° N";
  $("adUpOut").textContent = state.adUp.toFixed(2) + " s";
  $("adDownOut").textContent = state.adDown.toFixed(2) + " s";
  $("puUpOut").textContent = state.puUp.toFixed(2) + " s";
  $("puDownOut").textContent = state.puDown.toFixed(2) + " s";
  $("brightWOut").textContent = state.brightW.toFixed(2);
  $("gazeKOut").textContent = state.gazeK.toFixed(2);
  $("gazeMaxLOut").textContent = Math.round(Math.pow(10, state.gazeMaxL)) + "x";
  $("pupilBrightOut").textContent = state.pupilBright.toFixed(2);
  $("scatterOut").textContent = state.scatter.toFixed(2) + "% of light";
  $("streaksOut").textContent = state.streaks.toFixed(2) + "x";
  $("afterOut").textContent = state.after.toFixed(2) + "x";
  $("blinkSOut").textContent = "~" + state.blinkS.toFixed(1) + " s";
  $("sqSensOut").textContent = state.sqSens.toFixed(1) + "x";
  $("ageOut").textContent = state.age + " years";
  $("adaptSpeedOut").textContent = (state.adaptSpeed ?? 1).toFixed(2) + "x";
  $("fringeOut").textContent = state.fringe.toFixed(1) + "x";
  $("astigOut").textContent = state.astig > 0 ? Math.round(state.astig * 100) + "%" : "none";
  $("astigAxisOut").textContent = state.astigAxis + "°";
  $("lidBrightOut").textContent = Math.round(state.lidBright * 100) + "% of measured";
  $("attnKOut").textContent = state.attnK.toFixed(1) + "×";
  $("attnSub").setAttribute("aria-disabled", String(!state.attn));
  $("bodySpdOut").textContent = state.bodySpd + "°/s";
  $("eyeRadOut").textContent = state.eyeRad + "% of height";
  $("headSpdOut").textContent = state.headSpd + " px/s";
  $("recenterOut").textContent = state.recenter === 0 ? "off" : state.recenter.toFixed(1) + "/s";
  $("nearPtOut").textContent = state.nearPt + " cm";
  $("dofGainOut").textContent = state.dofGain <= 1.001 ? "1× (physical)" : state.dofGain.toFixed(1) + "× (exaggerated)";
  $("refocusOut").textContent = state.refocus === 0 ? "instant" : state.refocus.toFixed(2) + " s";
  $("dofSub").setAttribute("aria-disabled", String(!state.dof));
  PRESETS.forEach((pr, i) => $("pre" + i).setAttribute("aria-pressed", String(Math.abs(state.mult - pr.mult) < 0.01 && Math.abs(state.e2 - pr.e2) < 0.05)));
  $("multOut").textContent = state.mult.toFixed(2) + "×";
  $("e2Out").textContent = state.e2.toFixed(1) + "°";
  $("keepOut").textContent = Math.round(state.keep * 100) + "%";
  $("fovSub").setAttribute("aria-disabled", String(!state.foveated));
  $("tempSub").setAttribute("aria-disabled", String(!state.temporal));
  $("lay0").setAttribute("aria-pressed", String(state.layout === 0)); $("lay1").setAttribute("aria-pressed", String(state.layout === 1));
  $("edge0").setAttribute("aria-pressed", String(!state.smooth)); $("edge1").setAttribute("aria-pressed", String(state.smooth));
  $("rProj").textContent = state.panini ? "Panini " + state.paniniD.toFixed(2) : (pr.limited ? "rectilinear, max 170°" : "rectilinear");
  $("scaleOut").textContent = Math.round(state.scale * 100) + "%";
  $("rFovea").textContent = fmtArcmin(state.acuity) + "′ ≈ 20/" + (20 * state.acuity < 1 ? (20 * state.acuity).toFixed(2) : Math.round(20 * state.acuity));
  $("rPixel").textContent = pix.toFixed(2) + "′";
  // eccentricity where the receptor becomes larger than one pixel
  const e = Math.max(0, (pix / state.acuity - 1) * 2.3);
  $("rCross").textContent = pix <= state.acuity ? "everywhere" : e.toFixed(1) + "° from gaze";
  $("rGaze").textContent = state.mouseGaze ? (state.gazeFrozen ? "held (middle mouse to move)" : "follows mouse") : "center";
  $("rMove").textContent = state.fly ? "flying" : "walking";
}
const bindRange = (id, key, cb) => $(id).addEventListener("input", (e) => { state[key] = parseFloat(e.target.value); if (cb) cb(); updateReadouts(); });
$("acuity").addEventListener("input", (e) => { state.acuityS = parseFloat(e.target.value); state.acuity = 0.01 * Math.pow(800, state.acuityS); updateReadouts(); });
bindRange("fov", "fov"); bindRange("scale", "scale", () => resize());
bindRange("zoom", "zoomLevel"); bindRange("paniniD", "paniniD");
bindRange("ring0", "ring0"); bindRange("ring1", "ring1"); bindRange("ring2", "ring2");
bindRange("bodySpd", "bodySpd"); bindRange("eyeRad", "eyeRad"); bindRange("headSpd", "headSpd"); bindRange("recenter", "recenter");
const CAM_NOTES = [
  "Mouse turns the view; the crosshair is the gaze point.",
  "Mouse moves your gaze; your head follows up to 80° either side of your body, then only the gaze moves. The body never turns on its own: A/D turn it (the view stays put). Hold left mouse: the body swings to the view, the mouse turns head and body together, and A/D strafe.",
  "Slow mouse moves your eyes inside the circle, then your head; fast mouse turns head and body together. Hold left mouse: eyes and body snap to the view, the mouse turns everything together, and A/D strafe.",
  "Eye + head looking by default. Hold left mouse: eyes snap to centre and the mouse turns only your head, like Tank. A/D always turn the body."
];
const CAM_CODES = ["standard", "tank", "eyehead", "hybrid"];
const hasEyes = () => state.camMode === 2 || state.camMode === 3;
const hasGazeOff = () => state.camMode !== 0;   // modes where the gaze can sit off the screen centre
function setCamMode(m){
  state.camMode = m;
  [0, 1, 2, 3].forEach(i => $("cam" + i).setAttribute("aria-pressed", String(i === m)));
  $("camNote").textContent = CAM_NOTES[m];
  $("eyeSub").hidden = !(m === 2 || m === 3);
  $("bodySub").hidden = m === 0;
  state.bodyYaw = state.yaw; state.bodyTurn = false; state.eyeOff = [0, 0];
  if (m !== 0 && state.mouseGaze) setMouseGaze(false);
  updateReadouts();
}
[0, 1, 2, 3].forEach(i => $("cam" + i).addEventListener("click", () => setCamMode(i)));
bindRange("pupil", "pupil"); bindRange("cloud", "cloud"); bindRange("lampGain", "lampGain"); bindRange("moonSize", "moonSize");
bindRange("sunDec", "sunDec"); bindRange("moonDec", "moonDec"); bindRange("lat", "lat");
bindRange("dayMin", "dayMin"); bindRange("phaseStep", "phaseStep");
const ADAPT_KEYS = ["adUp", "adDown", "puUp", "puDown", "brightW", "gazeK", "gazeMaxL", "pupilBright", "scatter", "streaks", "after", "blinkS", "sqSens", "lidBright", "astig", "astigAxis", "age", "fringe"];
const ADAPT_DEF = { adUp: 0.4, adDown: 0.5, puUp: 0.3, puDown: 0.3, brightW: 0.1, gazeK: 0.3, gazeMaxL: 0.3, pupilBright: 2, scatter: 0.5, streaks: 1, after: 1, blinkS: 10, sqSens: 1, lidBright: 0.3, astig: 0, astigAxis: 30, age: 25, fringe: 1 };
for (const k of ADAPT_KEYS) bindRange(k, k);
Object.assign(state, ADAPT_DEF);
state.adaptSpeed = 1;
// simple mode: one speed for adaptation and pupil (writes the four detailed times)
$("adaptSpeed").addEventListener("input", (e) => {
  state.adaptSpeed = parseFloat(e.target.value);
  for (const k of ["adUp", "adDown", "puUp", "puDown"]){ state[k] = +(ADAPT_DEF[k] / state.adaptSpeed).toFixed(2); $(k).value = state[k]; }
  updateReadouts();
});
const setAdaptDetail = (advanced) => {
  $("adaptSec").className = "toggles " + (advanced ? "adapt-adv" : "adapt-simple");
  $("adSimple").setAttribute("aria-pressed", String(!advanced)); $("adAdv").setAttribute("aria-pressed", String(advanced));
  try { localStorage.setItem("retina-adapt-adv", advanced ? "1" : "0"); } catch (_){ }
};
$("adSimple").addEventListener("click", () => setAdaptDetail(false));
$("adAdv").addEventListener("click", () => setAdaptDetail(true));
try { setAdaptDetail(localStorage.getItem("retina-adapt-adv") === "1"); } catch (_){ }
$("adaptReset").addEventListener("click", () => { for (const k of ADAPT_KEYS){ state[k] = ADAPT_DEF[k]; $(k).value = state[k]; } state.adaptSpeed = 1; $("adaptSpeed").value = 1; updateReadouts(); });
$("cloudLight").addEventListener("change", (e) => { state.cloudLight = e.target.checked; });
$("lamps").addEventListener("change", (e) => { state.lamps = e.target.checked; });
$("lids").addEventListener("change", (e) => { state.lids = e.target.checked; });
$("afterOn").addEventListener("change", (e) => { state.afterOn = e.target.checked; });
$("autoPupil").addEventListener("change", (e) => { state.autoPupil = e.target.checked; updateReadouts(); });
$("attn").addEventListener("change", (e) => { state.attn = e.target.checked; updateReadouts(); });
bindRange("attnK", "attnK"); bindRange("nearPt", "nearPt"); bindRange("dofGain", "dofGain"); bindRange("refocus", "refocus");
function setDof(v){ state.dof = v; $("dof").checked = v; updateReadouts(); }
function setDiplo(v){ state.diplo = v; $("diplo").checked = v; }
$("dof").addEventListener("change", (e) => setDof(e.target.checked));
$("diplo").addEventListener("change", (e) => setDiplo(e.target.checked));
bindRange("cell", "cell"); bindRange("mult", "mult"); bindRange("e2", "e2"); bindRange("keep", "keep");
// Perceived: how sharp the periphery seems (eyes keep jumping, the brain fills in from memory).
// Retinal: measured acuity of a single still eye.
const PRESETS = [{ mult: 2, e2: 10 }, { mult: 1, e2: 2.3 }];
const REALISTIC = { mult: 1, e2: 2.3, nearPt: 12, refocus: 0.35, panini: false, fov: 90, attn: false, dofGain: 1 };
let realBackup = null;
function syncControls(){
  for (const id of ["mult", "e2", "nearPt", "refocus", "fov", "dofGain", "paniniD"]) $(id).value = state[id];
  $("panini").checked = state.panini; $("attn").checked = state.attn;
}
function setRealistic(on){
  $("realistic").checked = on;
  if (on){
    realBackup = {}; for (const k in REALISTIC) realBackup[k] = state[k];
    Object.assign(state, REALISTIC);
  } else if (realBackup){ Object.assign(state, realBackup); realBackup = null; }
  syncControls(); needReset = true; updateReadouts();
}
$("realistic").addEventListener("change", (e) => setRealistic(e.target.checked));
// changing one of those settings by hand while Realistic is on keeps the change and leaves Realistic
for (const id of ["mult", "e2", "nearPt", "refocus", "fov", "dofGain", "panini", "attn", "pre0", "pre1"]){
  $(id).addEventListener(id.startsWith("pre") ? "click" : "input", () => { if (realBackup){ realBackup = null; $("realistic").checked = false; } });
}
function setPreset(i){ Object.assign(state, PRESETS[i]); $("mult").value = state.mult; $("e2").value = state.e2; updateReadouts(); }
$("pre0").addEventListener("click", () => setPreset(0)); $("pre1").addEventListener("click", () => setPreset(1));
function setFoveated(v){ state.foveated = v; $("foveated").checked = v; updateReadouts(); }
function setLayout(v){ state.layout = v; updateReadouts(); }
function setSmooth(v){ state.smooth = v; updateReadouts(); }
function setTemporal(v){ state.temporal = v; $("temporal").checked = v; needReset = true; updateReadouts(); }
$("foveated").addEventListener("change", (e) => setFoveated(e.target.checked));
$("temporal").addEventListener("change", (e) => setTemporal(e.target.checked));
$("fast").addEventListener("change", (e) => { state.fast = e.target.checked; });
// reflections: remembered in this browser only (a rendering choice, not part of a view)
const saveRefl = () => { try { localStorage.setItem("retina-refl", JSON.stringify([state.reflOn, state.reflMode, state.reflReach])); } catch (_){ } };
const syncRefl = () => {
  $("reflOn").checked = state.reflOn; $("reflReach").value = state.reflReach;
  $("reflSub").setAttribute("aria-disabled", String(!state.reflOn));
  for (const m of [1, 2, 3]) $("refl" + m).setAttribute("aria-pressed", String(state.reflMode === m));
};
try { const v = JSON.parse(localStorage.getItem("retina-refl") || "null"); if (v){ state.reflOn = !!v[0]; state.reflMode = [1, 2, 3].includes(v[1]) ? v[1] : 2; state.reflReach = Number(v[2]) || 400; } } catch (_){ }
syncRefl();
$("reflOn").addEventListener("change", (e) => { state.reflOn = e.target.checked; syncRefl(); saveRefl(); });
for (const m of [1, 2, 3]) $("refl" + m).addEventListener("click", () => { state.reflMode = m; syncRefl(); saveRefl(); });
$("reflReach").addEventListener("input", (e) => { state.reflReach = parseFloat(e.target.value); saveRefl(); updateReadouts(); });
$("lay0").addEventListener("click", () => setLayout(0)); $("lay1").addEventListener("click", () => setLayout(1));
$("edge0").addEventListener("click", () => setSmooth(false)); $("edge1").addEventListener("click", () => setSmooth(true));
if (!floatFB){ $("temporal").disabled = true; state.temporal = false; $("temporal").checked = false; }
function setPanini(v){ state.panini = v; $("panini").checked = v; updateReadouts(); }
$("panini").addEventListener("change", (e) => setPanini(e.target.checked));
function setRings(v){ state.rings = v; $("rings").checked = v; updateReadouts(); }
function setMouseGaze(v){
  if (v && state.camMode !== 0) setCamMode(0);
  state.mouseGaze = v; $("mouseGaze").checked = v; state.gazeFrozen = false;
  if (v && document.pointerLockElement) document.exitPointerLock();
  if (!v) state.gaze = [W/2, H/2];
  updateReadouts();
}
function setFly(v){ state.fly = v; $("fly").checked = v; updateReadouts(); }
$("rings").addEventListener("change", (e) => setRings(e.target.checked));
$("mouseGaze").addEventListener("change", (e) => setMouseGaze(e.target.checked));
$("fly").addEventListener("change", (e) => setFly(e.target.checked));

function keyLabel(code){
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return code.replace("Left", "").replace("Right", "");
}
function showPanelKey(){ const l = keyLabel(state.panelKey); $("hintKey").textContent = l; $("keyLegend").textContent = l; $("panelKeyShow").textContent = l; }
try { const k = localStorage.getItem("retina-panel-key"); if (k) state.panelKey = k; } catch (_){ }
showPanelKey();
function setPanel(v){ state.panel = v; $("panel").hidden = !v; $("hint").hidden = v; }
$("rebind").addEventListener("click", () => {
  state.rebinding = !state.rebinding;
  $("rebind").setAttribute("aria-pressed", String(state.rebinding));
  $("rebind").textContent = state.rebinding ? "Press a key…" : "Change";
});

/* ---------------- View codes: seed + position + direction + settings ---------------- */
const MODES = ["eye", "standard", "detail"];
function heading(){ let d = (state.yaw * 180 / Math.PI) % 360; if (d < 0) d += 360; return d; }
function compass(d){ return ["N","NE","E","SE","S","SW","W","NW"][Math.round(d / 45) % 8]; }
function viewCode(){
  const p = state.pos.map(v => v.toFixed(2)).join(",");
  return "RC1 seed=" + SEED + " pos=" + p + " heading=" + heading().toFixed(1) + " pitch=" + (state.pitch * 180 / Math.PI).toFixed(1)
    + " fov=" + state.fov + " mode=" + MODES[state.mode] + " fly=" + (state.fly ? 1 : 0)
    + " cells=" + (state.foveated ? (state.layout ? "rings" : "grid") : "off") + " base=" + state.cell
    + " edges=" + (state.smooth ? "smooth" : "hard") + " blend=" + (state.temporal ? 1 : 0)
    + " acuity=" + state.acuity.toFixed(2) + " panini=" + (state.panini ? state.paniniD.toFixed(2) : "off")
    + " time=" + state.timeH.toFixed(2) + " phase=" + state.phaseDeg.toFixed(0) + " cloud=" + state.cloud.toFixed(2) + " cloudlight=" + (state.cloudLight ? 1 : 0) + " lamps=" + (state.lamps ? 1 : 0) + " lampgain=" + state.lampGain.toFixed(2) + " moonsize=" + state.moonSize + " season=" + state.sunDec + " moondec=" + state.moonDec + " lat=" + state.lat + (state.cycle ? " cycle=" + state.dayMin + " realmoon=" + (state.realMoon ? 1 : 0) + " pstep=" + state.phaseStep : "") + " adapt=" + ADAPT_KEYS.map(k => +state[k].toFixed(2)).join(",")
    + (state.moonCouple ? "" : " moon=" + state.moonH.toFixed(2)) + " attn=" + (state.attn ? state.attnK.toFixed(1) : 0) + " autopupil=" + (state.autoPupil ? 1 : 0)
    + " focus=" + (state.dof ? "on" : "off") + " pupil=" + state.pupil.toFixed(1) + " near=" + state.nearPt + " diplo=" + (state.diplo ? 1 : 0)
    + " blur=" + state.dofGain.toFixed(1)
    + (state.camMode === 0 && state.mouseGaze ? " gaze=" + (state.gaze[0] / W).toFixed(3) + "," + (state.gaze[1] / H).toFixed(3) : "")
    + " cam=" + CAM_CODES[state.camMode]
    + (state.camMode !== 0 ? " body=" + (((state.bodyYaw * 180 / Math.PI) % 360 + 360) % 360).toFixed(1) : "")
    + (hasGazeOff() ? " eye=" + state.eyeOff.map(v => (v / H).toFixed(3)).join(",") : "");
}
function codeMsg(t){ $("codeMsg").textContent = t; clearTimeout(codeMsg.t); codeMsg.t = setTimeout(() => { $("codeMsg").textContent = ""; }, 2500); }
function copyCode(){
  const code = viewCode(), box = $("codeOut");
  box.value = code;
  const fallback = () => { if (state.panel){ box.focus(); box.select(); codeMsg("Selected; press Ctrl+C"); } else codeMsg("Open the panel (" + keyLabel(state.panelKey) + ") to copy"); };
  try { navigator.clipboard.writeText(code).then(() => codeMsg("Copied"), fallback); } catch (_){ fallback(); }
}
function applyCode(text){
  const kv = {}; (text || "").replace(/(\w+)=([^\s]+)/g, (_, k, v) => { kv[k] = v; });
  if (!kv.pos){ codeMsg("No position found in that code"); return; }
  const pos = kv.pos.split(",").map(Number);
  if (pos.length !== 3 || pos.some(isNaN)){ codeMsg("Position should be three numbers"); return; }
  if (kv.seed && Number(kv.seed) !== SEED) codeMsg("Different seed (" + kv.seed + "); the city will not match");
  else codeMsg("Moved");
  state.pos = pos;
  if (kv.heading) state.yaw = Number(kv.heading) * Math.PI / 180;
  if (kv.pitch) state.pitch = Number(kv.pitch) * Math.PI / 180;
  if (kv.fly) setFly(kv.fly === "1");
  if (kv.fov){ state.fov = Number(kv.fov); $("fov").value = state.fov; }
  if (kv.mode && MODES.indexOf(kv.mode) >= 0) setMode(MODES.indexOf(kv.mode));
  if (kv.cells){ if (kv.cells === "off") setFoveated(false); else { setFoveated(true); setLayout(kv.cells === "rings" ? 1 : 0); } }
  if (kv.base){ state.cell = Number(kv.base); $("cell").value = state.cell; }
  if (kv.edges) setSmooth(kv.edges === "smooth");
  if (kv.blend && floatFB) setTemporal(kv.blend === "1");
  if (kv.acuity){ state.acuity = Number(kv.acuity); state.acuityS = Math.log(state.acuity / 0.01) / Math.log(800); $("acuity").value = state.acuityS; }
  if (kv.panini){ if (kv.panini === "off") setPanini(false); else { state.paniniD = Number(kv.panini); $("paniniD").value = state.paniniD; setPanini(true); } }
  if (kv.focus) setDof(kv.focus === "on");
  if (kv.pupil){ state.pupil = Number(kv.pupil); $("pupil").value = state.pupil; }
  if (kv.time) state.timeH = ((Number(kv.time) % 24) + 24) % 24;
  if (kv.phase) state.phaseDeg = ((Number(kv.phase) % 360) + 360) % 360;
  if (kv.cloud){ state.cloud = Number(kv.cloud); $("cloud").value = state.cloud; }
  if (kv.cloudlight){ state.cloudLight = kv.cloudlight === "1"; $("cloudLight").checked = state.cloudLight; }
  if (kv.lamps){ state.lamps = kv.lamps === "1"; $("lamps").checked = state.lamps; }
  if (kv.season){ state.sunDec = Number(kv.season); $("sunDec").value = state.sunDec; }
  if (kv.moondec){ state.moonDec = Number(kv.moondec); $("moonDec").value = state.moonDec; }
  if (kv.lat){ state.lat = Number(kv.lat); $("lat").value = state.lat; }
  if (kv.cycle){ state.cycle = true; state.dayMin = Number(kv.cycle) || 24; $("dayMin").value = state.dayMin; }
  else state.cycle = false;
  state.realMoon = state.cycle && kv.realmoon === "1";
  if (kv.pstep){ state.phaseStep = Number(kv.pstep); $("phaseStep").value = state.phaseStep; }
  syncCycleUI();
  if (kv.moonsize){ state.moonSize = Number(kv.moonsize); $("moonSize").value = state.moonSize; }
  if (kv.lampgain){ state.lampGain = Number(kv.lampgain); $("lampGain").value = state.lampGain; }
  if (kv.adapt){ kv.adapt.split(",").map(Number).forEach((v, i) => { const k = ADAPT_KEYS[i]; if (k && isFinite(v)){ state[k] = v; $(k).value = v; } }); }
  if (kv.moon){ state.moonCouple = false; state.moonH = ((Number(kv.moon) % 24) + 24) % 24; $("moonCouple").checked = false; }
  else if (kv.time){ state.moonCouple = true; $("moonCouple").checked = true; }
  drawDials();
  if (kv.attn){ const k = Number(kv.attn); state.attn = k > 0; $("attn").checked = state.attn; if (k >= 1){ state.attnK = k; $("attnK").value = k; } }
  if (kv.autopupil){ state.autoPupil = kv.autopupil === "1"; $("autoPupil").checked = state.autoPupil; }
  if (kv.diplo) setDiplo(kv.diplo === "1");
  if (kv.near){ state.nearPt = Number(kv.near); $("nearPt").value = state.nearPt; }
  if (kv.cam === "headbody") kv.cam = "tank";   // older codes
  if (kv.cam && CAM_CODES.indexOf(kv.cam) >= 0) setCamMode(CAM_CODES.indexOf(kv.cam));
  if (kv.blur){ state.dofGain = Number(kv.blur); $("dofGain").value = state.dofGain; }
  if (kv.gaze && state.camMode === 0){
    const g = kv.gaze.split(",").map(Number);
    if (g.length === 2 && !g.some(isNaN)){ setMouseGaze(true); state.gaze = [g[0] * W, g[1] * H]; }
  } else if (state.mouseGaze) setMouseGaze(false);
  if (kv.body && state.camMode !== 0){ const bb = Number(kv.body) * Math.PI / 180; state.bodyYaw = state.yaw - wrapA(state.yaw - bb); }
  if (kv.eye && hasGazeOff()){ const e2 = kv.eye.split(",").map(Number); if (e2.length === 2 && !e2.some(isNaN)) state.eyeOff = [e2[0] * H, e2[1] * H]; }
  needReset = true;
  updateReadouts();
}
$("copyCode").addEventListener("click", copyCode);
$("goCode").addEventListener("click", () => applyCode($("codeIn").value));
$("codeOut").addEventListener("focus", (e) => e.target.select());

// panel groups remember whether they were open
document.querySelectorAll("details.grp").forEach((d) => {
  try { const v = localStorage.getItem("retina-grp-" + d.dataset.key); if (v !== null) d.open = v === "1"; } catch (_){ }
  d.addEventListener("toggle", () => { try { localStorage.setItem("retina-grp-" + d.dataset.key, d.open ? "1" : "0"); } catch (_){ } if (d.dataset.key === "sky" && d.open) drawDials(); });
});

const start = $("start");
start.addEventListener("click", () => { if (!startPanel.ready()) return; start.hidden = true; tryLock(); });
function tryLock(force){
  if (state.mouseGaze && !force) return;
  freshLock = true;
  const fail = () => { state.noLock = true; state.tempLock = false; };
  try { const r = canvas.requestPointerLock(); if (r && r.catch) r.catch(fail); } catch (_){ fail(); }
}
let freshLock = false;   // true until the first movement after a capture has been seen
document.addEventListener("pointerlockchange", () => {
  if (!document.pointerLockElement){ state.tempLock = false; freshLock = true; }
});
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

// Only presses on the view itself reach the camera: the panel and other overlays sit on top of the
// canvas, so clicks on them never arrive here.
let drag = null;   // fallback look-by-dragging, only if the browser refuses to capture the mouse
canvas.addEventListener("mousedown", (e) => {
  start.hidden = true;
  if (e.button === 2){ state.rmb = true; return; }          // right mouse: zoom, in every mode
  if (e.button !== 0) return;
  e.preventDefault();
  // preventDefault also stops the browser from giving this page keyboard focus, so give it back
  // (otherwise, after clicking elsewhere in the host page, WASD would not reach the city)
  try { window.focus(); canvas.focus({ preventScroll: true }); } catch (_){ }
  state.lmb = true;
  if (!document.pointerLockElement){
    if (state.noLock) drag = { x: e.clientX, y: e.clientY };
    else { state.tempLock = true; tryLock(true); }          // hold left mouse to look; the cursor stays put
  }
  if (state.camMode === 3) state.lmbHead = true;                              // hybrid: head-only look while held
  else if (state.camMode !== 0){ state.lmbBody = true; state.bodyTurn = true; }   // body swings to face the view
});
// middle mouse: free or capture the mouse, without changing where the gaze is
window.addEventListener("mousedown", (e) => {
  if (e.button !== 1) return;
  e.preventDefault();
  try { window.focus(); canvas.focus({ preventScroll: true }); } catch (_){ }
  if (state.mouseGaze && !document.pointerLockElement){
    // gaze mode: first press holds focus where it is and frees the cursor; next press moves focus to the cursor
    if (!state.gazeFrozen) state.gazeFrozen = true;
    else {
      const k = W / window.innerWidth;
      state.gaze = [e.clientX * k, (window.innerHeight - e.clientY) * k];
      state.gazeFrozen = false;
    }
    updateReadouts();
    return;
  }
  if (document.pointerLockElement) document.exitPointerLock();
  else if (!state.mouseGaze){ start.hidden = true; tryLock(); }
}, true);
window.addEventListener("auxclick", (e) => { if (e.button === 1) e.preventDefault(); });
window.addEventListener("mouseup", (e) => {
  if (e.button === 2){ state.rmb = false; return; }
  if (e.button !== 0) return;
  state.lmb = false; state.lmbBody = false; state.lmbHead = false; drag = null;
  if (state.tempLock){ state.tempLock = false; if (document.pointerLockElement) document.exitPointerLock(); }
});
window.addEventListener("wheel", (e) => {
  if (state.fHeld){
    // hold F and scroll: the most the eyes will open (scroll up = wider)
    e.preventDefault();
    state.fScrolled = true;
    state.maxOpen = Math.max(0, Math.min(1, state.maxOpen + (e.deltaY < 0 ? 0.06 : -0.06)));
    return;
  }
  if (!state.rmb) return;                  // right mouse held: zoom
  e.preventDefault();
  state.zoomLevel = Math.max(1, Math.min(4, state.zoomLevel * (e.deltaY < 0 ? 1.08 : 1 / 1.08)));
  $("zoom").value = state.zoomLevel; updateReadouts();
}, { passive: false });
const SENS = 0.0022;
const wrapA = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const NECK = 85 * Math.PI / 180, NECK_MAX = 160 * Math.PI / 180;
// Head angle relative to the body. Not wrapped: a head turned 200 degrees one way is not 160 the other.
const headOff = () => state.yaw - state.bodyYaw;
// Past 85 degrees the body turns to follow, faster the further past: ~0.5 deg/s at 1 deg over,
// ~340 deg/s at 75 deg over. 160 degrees is a hard stop.
// Tank: the head follows the gaze but stops 80 degrees either side of the body; past that only the
// gaze (eyes) keeps going, up to ~45 degrees further or the screen edge. The body never follows.
const TANK_NECK = 80 * Math.PI / 180;
function tankSettle(){
  if (!W) return;
  const pa = 2 * projection().xmax / state.zoom / W;        // radians per render pixel near the centre
  const g = state.yaw + state.eyeOff[0] * pa;               // where the gaze points (horizontal)
  state.yaw = Math.min(Math.max(g, state.bodyYaw - TANK_NECK), state.bodyYaw + TANK_NECK);
  const maxEye = Math.min(W / 2 - 24, (45 * Math.PI / 180) / pa);
  state.eyeOff = [Math.max(-maxEye, Math.min(maxEye, (g - state.yaw) / pa)), 0];
}
function softNeck(dt){
  const off = headOff(), over = (Math.abs(off) - NECK) * 180 / Math.PI;
  if (over <= 0) return;
  const rate = over * (0.5 + 4 * over / 75);                       // degrees per second
  state.bodyYaw += Math.sign(off) * Math.min(rate * dt, over) * Math.PI / 180;
  const off2 = headOff();
  if (Math.abs(off2) > NECK_MAX) state.bodyYaw = state.yaw - Math.sign(off2) * NECK_MAX;
}
// Eye + head: slow movement moves the eyes (cursor), fast movement turns the head.
function eyeHeadMove(dx, dy, t){
  const dtE = Math.max(0.004, Math.min(0.1, (t - state.mLastT) / 1000)); state.mLastT = t;
  const v = Math.hypot(dx, dy) / dtE;
  state.mSpeed += (v - state.mSpeed) * 0.5;
  const T = state.headSpd;
  const x = Math.min(Math.max((state.mSpeed - 0.5*T) / (1.5*T), 0), 1);
  const toHead = x*x*(3 - 2*x);                          // share of the movement that turns the head
  const s = SENS / state.zoom;                           // radians per mouse count
  // fast movement turns the head and the body together; slow movement goes to the eyes, then the head
  state.yaw += dx * toHead * s; state.pitch -= dy * toHead * s;
  state.bodyYaw += dx * toHead * s;
  // Eyes and head use the same angle per mouse count, so the split never changes where the gaze lands.
  const pa = 2 * projection().xmax / state.zoom / W;     // radians per render pixel near the centre
  let ox = state.eyeOff[0] + dx * (1 - toHead) * s / pa, oy = state.eyeOff[1] - dy * (1 - toHead) * s / pa;
  const R = state.eyeRad / 100 * H, r = Math.hypot(ox, oy);
  if (r > R){
    // eyes at their limit: the rest turns the head
    const over = (r - R) * pa, ux = ox / r, uy = oy / r;
    state.yaw += ux * over; state.pitch += uy * over;
    ox = ux * R; oy = uy * R;
  }
  state.eyeOff = [ox, oy];
}
window.addEventListener("pointermove", (e) => {
  if (document.pointerLockElement === canvas){
    const dx = e.movementX, dy = e.movementY, s = SENS / state.zoom;
    // Browsers can report one bogus jump (the cursor's old position) right after capture: ignore it
    if (freshLock){ freshLock = false; if (Math.abs(dx) + Math.abs(dy) > 150) return; }
    if (state.lmbBody){
      // left mouse held: head and body turn together from the centre of the view
      state.yaw += dx * s; state.pitch -= dy * s; state.bodyYaw += dx * s;
    } else if (state.camMode === 1){ state.yaw += dx * s; state.pitch -= dy * s; tankSettle(); }
    else if (hasEyes() && !state.lmbHead) eyeHeadMove(dx, dy, e.timeStamp);
    else { state.yaw += dx * s; state.pitch -= dy * s; }   // head only (standard, tank, hybrid while held)
  } else {
    if (state.mouseGaze && !state.lmb && !state.gazeFrozen){
      const k = W / window.innerWidth;
      state.gaze = [e.clientX * k, (window.innerHeight - e.clientY) * k];
    }
    if (drag){
      const dx = (e.clientX - drag.x) * SENS, dy = (e.clientY - drag.y) * SENS;
      state.yaw += dx; state.pitch -= dy; if (state.lmbBody) state.bodyYaw += dx;
      drag.x = e.clientX; drag.y = e.clientY;
    }
  }
  state.pitch = Math.max(-1.45, Math.min(1.45, state.pitch));
});
// touch: drag to look, second finger walks forward
let touches = 0;
canvas.addEventListener("touchstart", (e) => { touches = e.touches.length; start.hidden = true; }, { passive: true });
canvas.addEventListener("touchend", (e) => { touches = e.touches.length; }, { passive: true });

window.addEventListener("keydown", (e) => {
  const k = e.code;
  if (state.rebinding){
    e.preventDefault();
    if (k !== "Escape"){ state.panelKey = k; try { localStorage.setItem("retina-panel-key", k); } catch (_){ } showPanelKey(); }
    state.rebinding = false; $("rebind").setAttribute("aria-pressed", "false"); $("rebind").textContent = "Change";
    return;
  }
  if (k === state.panelKey){ setPanel(!state.panel); return; }
  if (e.target && e.target.id === "codeIn"){ if (k === "Enter") applyCode(e.target.value); return; }
  if (e.target && e.target.type === "number") return;      // typing a seed
  if (k === "KeyZ" && !e.repeat){ worldMap.toggle(); e.preventDefault(); return; }
  if (worldMap.isOpen()){ if (k === "Escape") worldMap.toggle(); return; }   // the map takes no movement keys
  if (e.target && (e.target.tagName === "INPUT")) { if (!["KeyW","KeyA","KeyS","KeyD","KeyQ","KeyE"].includes(k)) return; }
  if (k === "Digit1" || k === "Digit2" || k === "Digit3" || k === "Digit4"){
    const n = Number(k.slice(5)) - 1;
    if (!e.shiftKey) setCamMode(n); else if (n < 3) setMode(n);
  }
  else if (k === "KeyG") setMouseGaze(!state.mouseGaze);
  else if (k === "KeyR") setRings(!state.rings);
  else if (k === "KeyF"){ if (!e.repeat){ state.fHeld = true; state.fDown = performance.now(); state.fScrolled = false; } }
  else if (k === "Space" && !e.repeat){
    const now = performance.now();
    if (now - state.lastSpace < 300){ setFly(!state.fly); state.lastSpace = 0; }
    else {
      state.lastSpace = now;
      if (!state.fly && state.jumpH <= 0) state.vy = 3.1;      // ~0.5 m jump
    }
  }
  else if (k === "KeyP") setPanini(!state.panini);
  else if (k === "KeyK") copyCode();
  else if (k === "KeyO") setProfiler(!prof.on);
  else if (k === "KeyX") setCamMode((state.camMode + 1) % 4);
  else if (k === "KeyN") setDof(!state.dof);
  else if (k === "KeyM") setDiplo(!state.diplo);
  else if (k === "KeyV") setFoveated(!state.foveated);
  else if (k === "KeyL") setLayout(state.layout ? 0 : 1);
  else if (k === "KeyB") setSmooth(!state.smooth);
  else if (k === "KeyT" && floatFB) setTemporal(!state.temporal);
  if (["Space","ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(k)) e.preventDefault();
  state.keys.add(k);
});
window.addEventListener("keyup", (e) => {
  state.keys.delete(e.code);
  if (e.code === "KeyF" && state.fHeld){
    state.fHeld = false;
    if (performance.now() - state.fDown < 250){ if (state.blinkT < 0) state.blinkT = 0; }   // tap: blink
    else if (!state.fScrolled) state.maxOpen = 1;                                          // held, no scroll: reset
  }
});
// Focus lost (e.g. a click outside the page): forget held keys and buttons so nothing stays stuck
window.addEventListener("blur", () => {
  state.keys.clear(); state.fHeld = false;
  state.lmb = false; state.lmbBody = false; state.lmbHead = false; state.rmb = false; drag = null;
  if (state.tempLock){ state.tempLock = false; if (document.pointerLockElement) document.exitPointerLock(); }
});
window.addEventListener("resize", resize);

/* ---------------- Movement and collision (uses the same world data) ---------------- */
// eyelid edge height from the screen centre (same as lidA() in the shaders), at the middle of the screen
const lidA = (L) => (1 - L) * 0.62 - 0.06 * L;
function step(dt){
  const k = state.keys;
  const run = k.has("ShiftLeft") || k.has("ShiftRight");
  const speed = state.fly ? (run ? 60 : 18) : (run ? 9 : 3.2);
  const zTarget = state.rmb ? state.zoomLevel : 1;
  state.zoom += (zTarget - state.zoom) * Math.min(1, dt * 12);
  const turn = 1.6 * dt / state.zoom;
  if (k.has("ArrowLeft")) state.yaw -= turn; if (k.has("ArrowRight")) state.yaw += turn;
  if (k.has("ArrowUp")) state.pitch += turn; if (k.has("ArrowDown")) state.pitch -= turn;
  state.pitch = Math.max(-1.45, Math.min(1.45, state.pitch));
  const hasBody = state.camMode !== 0;
  if (hasBody){
    // A / D turn only the body (the view stays put) unless left mouse is held, which makes them strafe.
    // If the head would pass its limit, it is pulled along.
    if (!state.lmbBody){
      const tb = ((k.has("KeyD") ? 1 : 0) - (k.has("KeyA") ? 1 : 0)) * state.bodySpd * Math.PI / 180 * dt;
      if (tb !== 0){
        state.bodyYaw += tb;
        if (state.camMode !== 1){
          const off = headOff();
          if (Math.abs(off) > NECK) state.yaw = state.bodyYaw + Math.sign(off) * NECK;
        }
      }
    }
    if (state.bodyTurn){
      const off = headOff();
      state.bodyYaw += off * (1 - Math.exp(-dt * 14));
      if (Math.abs(off) < 0.003 && !state.lmbBody) state.bodyTurn = false;   // keeps tracking while held
    }
    if (state.camMode === 1){ if (!state.lmbBody) tankSettle(); }
    else softNeck(dt);
  } else state.bodyYaw = state.yaw;
  const snapEyes = state.lmbBody || state.lmbHead;
  if ((hasEyes() && (state.recenter > 0 || snapEyes) || (state.camMode === 1 && snapEyes)) && W){
    // the head slowly turns toward the gaze while the eyes drift back, so the gaze stays on the same spot
    // (quickly while left mouse is held, so turning starts from the centre of the view)
    const pr = projection(), pa = 2 * pr.xmax / state.zoom / W;   // radians per render pixel, approx.
    const a = 1 - Math.exp(-dt * (snapEyes ? 14 : state.recenter));
    const mx = state.eyeOff[0] * a, my = state.eyeOff[1] * a;
    state.yaw += mx * pa; state.pitch += my * pa;
    state.eyeOff = [state.eyeOff[0] - mx, state.eyeOff[1] - my];
    state.pitch = Math.max(-1.45, Math.min(1.45, state.pitch));
  }
  const fx = Math.sin(state.bodyYaw), fz = Math.cos(state.bodyYaw);
  let mx = 0, mz = 0, my = 0;
  if (k.has("KeyW") || touches >= 2){ mx += fx; mz += fz; }
  if (k.has("KeyS")){ mx -= fx; mz -= fz; }
  const strafe = !hasBody || state.lmbBody;
  // Q / E always strafe; A / D strafe only when they are not turning the body
  if ((strafe && k.has("KeyD")) || k.has("KeyE")){ mx += fz; mz -= fx; }
  if ((strafe && k.has("KeyA")) || k.has("KeyQ")){ mx -= fz; mz += fx; }
  const len = Math.hypot(mx, mz) || 1;
  state.pos[0] += mx / len * speed * dt; state.pos[2] += mz / len * speed * dt;
  const g = groundAt(state.pos[0], state.pos[2]);
  if (state.fly){
    if (k.has("Space")) my += 1; if (k.has("KeyC")) my -= 1;
    state.pos[1] = Math.max(g + 0.4, state.pos[1] + my * speed * dt);
    state.walkY = null; state.jumpH = 0; state.vy = 0;
  } else {
    // walking: eye height follows the ground smoothly; a jump adds a simple ballistic arc on top
    if (state.walkY === null) state.walkY = state.pos[1] - state.jumpH;
    state.walkY += (g + 1.7 - state.walkY) * Math.min(1, dt * 10);
    if (state.vy !== 0 || state.jumpH > 0){
      state.jumpH += state.vy * dt; state.vy -= 9.81 * dt;
      if (state.jumpH <= 0){ state.jumpH = 0; state.vy = 0; }
    }
    state.pos[1] = state.walkY + state.jumpH;
  }
  collide(state.pos);
}

/* ---------------- Sky: sun and moon from the dials, light levels from the sun's height ---------------- */
function setSkyUniforms(u, k){
  gl.uniform3f(u.uSunDir, ...k.sun.dir); gl.uniform3f(u.uMoonDir, ...k.moon.dir);
  gl.uniform1f(u.uMoonSize, state.moonSize); gl.uniform1f(u.uMoonPhase, (180 - elongation()) * Math.PI / 180); gl.uniform3f(u.uKeyDir, ...k.keyDir);
  gl.uniform3f(u.uKeyCol, ...k.keyCol); gl.uniform3f(u.uSunColor, ...k.sunColor); gl.uniform3f(u.uAmbTint, ...k.ambTint);
  gl.uniform3f(u.uFogCol, ...k.fog);
  gl.uniform1f(u.uSunK, k.sunK); gl.uniform1f(u.uSunDiskK, k.sunDiskK); gl.uniform1f(u.uCloudGrey, k.cloudGrey); gl.uniform1f(u.uShadowK, k.shadowK); gl.uniform1f(u.uAmbK, k.ambK); gl.uniform1f(u.uSkyK, k.skyK); gl.uniform1f(u.uTwi, k.twi);
  gl.uniform1f(u.uNightSky, k.nightSky); gl.uniform1f(u.uMoonDisk, k.moonDisk); gl.uniform1f(u.uAbsScale, 5000 * k.L);
  gl.uniform1f(u.uLampK, k.lampK); gl.uniform1f(u.uLampEmit, k.lampEmit);
  gl.uniform1f(u.uCloud, state.cloud); gl.uniform2f(u.uCloudOff, state.cloudT * 6, state.cloudT * 2.5);
  gl.uniformMatrix3fv(u.uStarRot, false, k.rot);
}

window.__sky = { advanceSky, viewCode: () => viewCode(), computeSky: () => computeSky() };   // for automated checks
initDials(updateReadouts);

/* ---------------- Frame loop ---------------- */
function halton(i, b){ let f = 1, r = 0; while (i > 0){ f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; }
// JS copy of the projection, used for the gaze direction
function projDirJS(px, py, xmax, d){
  const qx = (px - 0.5*W) / (0.5*W) * xmax, qy = (py - 0.5*H) / (0.5*W) * xmax;
  if (d <= 0){ const l = Math.hypot(qx, qy, 1); return [qx/l, qy/l, 1/l]; }
  const k = qx*qx / ((d+1)*(d+1));
  const dscr = k*k*d*d - (k+1)*(k*d*d - 1);
  const clon = (-k*d + Math.sqrt(Math.max(dscr, 0))) / (k+1);
  const S = (d+1) / Math.max(d + clon, 1e-4);
  const lon = Math.atan2(qx, S*clon), lat = Math.atan2(qy, S);
  return [Math.cos(lat)*Math.sin(lon), Math.sin(lat), Math.cos(lat)*Math.cos(lon)];
}

// Everything the cell layout needs, in screen pixels.
function samplingParams(){
  const pr = projection();
  const pixVis = 2 * pr.xmax / W;                          // angle of one centre pixel, as the viewer sees it
  const A = (state.acuity * Math.PI / 10800) / pixVis;     // foveal receptor size in pixels
  // with attention on, cells are sized for the sharpest case (attended), since attention is decided per surface
  const R2 = (state.e2 * (state.attn && state.mode !== 1 ? state.attnK : 1) * Math.PI / 180) / pixVis;   // falloff in pixels
  const base = state.cell, mult = state.mult;
  const fov = state.foveated && state.mode !== 1;
  const lpMode = fov && state.layout === 1;
  const cellPx = (r) => fov ? Math.max(base, mult*A*(1 + r/R2)) : base;
  const rmax = Math.hypot(W, H);
  let r0 = 0, s = 1, Nth = 1, Nr = 1;
  if (lpMode){
    s = mult*A/R2;
    r0 = R2 * Math.max(1, base/(mult*A) - 1);
    s = Math.max(s, base/(r0 + R2));
    Nth = Math.min(4096, Math.max(32, Math.round(2*Math.PI/s))); s = 2*Math.PI/Nth;
    Nr = Math.min(4096, Math.max(1, Math.ceil(Math.log((rmax + R2)/(r0 + R2))/s) + 2));
  }
  const dofCells = state.dof && fov && !lpMode && floatFB;
  let K = 1;
  if (dofCells) K = 8;
  else if (fov){
    const rTop = lpMode ? Math.min(rmax, r0 + 2*s*(r0 + R2) + 64) : rmax;
    K = Math.min(8, Math.max(1, Math.floor(Math.log2(cellPx(rTop)/base)) + 2));
  }
  const lv = [];
  for (let k = 0; k < K; k++){ const c = base * 2**k; lv.push({ w: Math.ceil(W/c), h: Math.ceil(H/c), cell: c, x: 0, y: 0 }); }
  let y = 0;
  for (let k = 1; k < K; k++){ lv[k].x = lv[0].w; lv[k].y = y; y += lv[k].h; }
  const atlasW = lv[0].w + (K > 1 ? lv[1].w : 0), atlasH = Math.max(lv[0].h, y);
  return { pr, pixVis, A, R2, base, mult, fov, lpMode, dofCells, cellPx, r0, s, Nth, Nr, K, lv, atlasW, atlasH };
}
function ensureTargets(sp){
  const mips = !sp.fov;
  const key = sp.atlasW + "x" + sp.atlasH + ":" + mips;
  if (key !== atlasKey){ freeTarget(atlasT); atlasT = makeTarget(sp.atlasW, sp.atlasH, { mips }); atlasKey = key; needReset = true; }
  if (sp.lpMode){
    const k2 = sp.Nth + "x" + sp.Nr;
    if (k2 !== lpKey){ freeTarget(lpT); lpT = makeTarget(sp.Nth, sp.Nr, { repeat: true }); lpKey = k2; needReset = true; }
  }
}
// Approximate ray count: screen area divided by cell area, summed over 32 px blocks.
function estimateRays(sp, gaze){
  if (!sp.fov) return Math.ceil(W/sp.base) * Math.ceil(H/sp.base);
  let n = 0; const B = 32;
  for (let y = 0; y < H; y += B) for (let x = 0; x < W; x += B){
    const r = Math.hypot(x + B/2 - gaze[0], y + B/2 - gaze[1]);
    let area;
    if (sp.lpMode && r >= sp.r0) area = sp.s*sp.s * Math.max(r, 1) * (r + sp.R2);
    else { const c = sp.cellPx(r); area = c*c; }
    n += Math.min(B, W - x) * Math.min(B, H - y) / Math.max(area, 1);
  }
  return n;
}
function bodyText(){
  const off = headOff() * 180 / Math.PI;
  return Math.abs(off) < 2 ? " · body ahead" : " · head " + Math.round(Math.abs(off)) + "° " + (off > 0 ? "right" : "left") + " of body";
}
function lightName(lg){
  const names = [[-0.5, "full sun"], [-1.5, "overcast"], [-2.5, "heavy overcast"], [-3.5, "sunset"], [-4.5, "civil twilight"],
                 [-5.5, "deep twilight"], [-6.6, "full moon"], [-7.6, "quarter moon"], [-99, "starlight"]];
  for (const [t, n] of names) if (lg > t) return n + " (×10^" + lg.toFixed(1) + ")";
}
function fmtLum(cd){ return cd >= 100 ? Math.round(cd).toLocaleString() + " cd/m²" : cd >= 1 ? cd.toFixed(1) + " cd/m²" : cd.toPrecision(2) + " cd/m²"; }
// How light an adapted scene looks, as a fraction of a sunlit street's lightness, by adapting
// luminance (log10 cd/m2): ~60% at the end of civil twilight, ~22% under a full moon, ~6% by starlight.
// Converted to a linear light factor for the screen (lightness ~ light^(1/2.2)).
const PERCEIVED = [[-6, 0.05], [-5.4, 0.06], [-4, 0.12], [-2.7, 0.22], [-2, 0.32], [-1, 0.45], [0, 0.6], [1.5, 0.9], [2.93, 1], [5, 1.04]];
function perceivedFor(La){ return Math.pow(lightnessFor(La), 2.2); }
function lightnessFor(La){
  const x = Math.log10(Math.max(La, 1e-9));
  if (x <= PERCEIVED[0][0]) return PERCEIVED[0][1];
  for (let i = 1; i < PERCEIVED.length; i++){
    const [x1, y1] = PERCEIVED[i], [x0, y0] = PERCEIVED[i - 1];
    if (x <= x1) return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
  }
  return PERCEIVED[PERCEIVED.length - 1][1];
}
// Moon & Spencer (1944): pupil diameter in mm from adapting luminance in cd/m2
const pupilFor = (La) => 4.9 - 3 * Math.tanh(0.4 * Math.log10(Math.max(La, 1e-7)));
// Age: the largest pupil shrinks (~8 mm at 20 to ~5 mm at 80); the eye scatters more light (CIE age factor
// 1 + (age / 62.5)^4: ~1.4x at 50, ~2.6x at 70); the lens yellows and absorbs more blue.
const maxPupil = () => Math.max(4, Math.min(8, 8 - 0.05 * (state.age - 20)));
const pupilAge = (La) => Math.min(pupilFor(La), maxPupil());
const ageGlare = () => 1 + Math.pow(state.age / 62.5, 4);
function fmtDist(m){ return m >= 1000 ? "far" : m >= 100 ? Math.round(m) + " m" : m.toFixed(1) + " m"; }
function fmtCount(n){ return n >= 1e6 ? (n/1e6).toFixed(2) + "M" : n >= 1e3 ? Math.round(n/1e3) + "k" : String(Math.round(n)); }

let whereT = 1, last = performance.now(), fpsAcc = 0, fpsN = 0, fpsT = 0, frameNo = 0, prevCam = null, lastSig = "", raysTxt = "";
/* ---------------- Profiler (key O): time per stage, averaged over 30 frames ----------------
   Each stage waits for the GPU to finish (gl.finish), so the numbers show where time goes, but the
   frame rate while profiling is a little lower than normal. */
const prof = { on: false, acc: {}, n: 0, last: 0, order: [], fb: null, px: new Uint8Array(4) };
// Reading one pixel back makes the CPU wait until the GPU has finished everything queued so far
// (gl.finish alone does not reliably wait in every browser).
function gpuSync(){
  if (!prof.fb){ const t = makeTarget(1, 1); prof.fb = t.fbo; }
  const prev = gl.getParameter(gl.FRAMEBUFFER_BINDING);
  gl.bindFramebuffer(gl.FRAMEBUFFER, prof.fb);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, floatFB ? gl.FLOAT : gl.UNSIGNED_BYTE, floatFB ? new Float32Array(4) : prof.px);
  gl.bindFramebuffer(gl.FRAMEBUFFER, prev);
}
function pstart(){ if (!prof.on) return; gpuSync(); prof.last = performance.now(); }
function pmark(name){
  if (!prof.on) return;
  gpuSync();
  const t = performance.now();
  if (!(name in prof.acc)){ prof.acc[name] = 0; prof.order.push(name); }
  prof.acc[name] += t - prof.last; prof.last = t;
}
function pend(){
  if (!prof.on) return;
  if (++prof.n < 30) return;
  const total = prof.order.reduce((a, k) => a + prof.acc[k], 0) / prof.n;
  const lines = prof.order.map(k => (prof.acc[k] / prof.n).toFixed(2).padStart(7) + " ms  " + k);
  $("prof").textContent = "Stage timings (avg of 30 frames)\n" + lines.join("\n") + "\n" + total.toFixed(2).padStart(7) + " ms  total";
  prof.acc = {}; prof.order = []; prof.n = 0;
}
function setProfiler(v){ prof.on = v; prof.acc = {}; prof.order = []; prof.n = 0; $("prof").hidden = !v; $("prof").textContent = "Profiling…"; }
window.__prof = prof;

/* ---------------- The eye, step by step (called from frame()) ----------------
   fx carries this frame's values: dt, sky, camera axes (fwd, right, up), eyeScale, lightMul, sp, outTex. */

// Light falling on the lids from sources off screen (the sun on the face), in scene units.
function updateFaceLight(fx){
  const { dt, sky, fwd, right, up, eyeScale, lightMul, sp, outTex } = fx;
  // Light falling on the closed lids from in front, including lights that are off screen: sun or moon
  // (if not in shadow), sky, street lights. In scene units (as a white surface facing you would show).
  if (frameNo % 6 === 0){
    const kd = sky.keyDir, kc = sky.keyCol;
    const facing = Math.max(fwd[0] * kd[0] + fwd[1] * kd[1] + fwd[2] * kd[2], 0);
    let sunlit = 0;
    if (facing > 0 && kc[0] + kc[1] + kc[2] > 0) sunlit = castJS(state.pos, kd) >= 1799 ? 1 : 0;
    // the sun (or moon) is added here directly; the blurred view supplies everything else
    // the same total light as the sun's disk would give if it were on screen (disk energy / pi)
    const kScale = sky.sunK > 1e-3 && sky.sunDiskK > 0 ? 2.6e5 * 0.00465 * 0.00465 * sky.sunDiskK / sky.sunK : 2.6;
    // always computed here, on screen or off: the drawn sun is too small to be sampled steadily
    const sunOn = kScale * facing * sunlit;
    const fn = [fwd[0], fwd[1] + 0.3, fwd[2]], fl = Math.hypot(...fn);
    const lamp = sky.lampK > 0 ? lampLuxJS(state.pos, fn.map(x => x / fl)) * sky.lampK * 0.8 : 0;
    state.faceT = [0, 1, 2].map(i => kc[i] * sunOn + lamp * [1, 0.62, 0.24][i]);
  }
}

// Eyelids: blinking (moisture timer), squinting (glare score), the player's setting (F), and the brow.
function updateEyelids(fx){
  const { dt, sky, fwd, right, up, eyeScale, lightMul, sp, outTex } = fx;
  const kE = (tau) => 1 - Math.exp(-dt / tau);
  if (state.lids && state.mode === 0){
    // Squint: how much follows the glare score (soft ramp, smoothed); the upper lid and brow do most of it
    // and aim to stop just below a strong source above; the lower lid rises less, fully only for the sun.
    // squint from the de Boer rating: starts past "disturbing" (3), full beyond "unbearable" (0); the
    // sensitivity setting shifts the scale (2x sensitivity = one step of 0.6)
    const sh = 2 * Math.log10(state.sqSens), rating = state.glareRating ?? 9;
    // The pupil is the first defence: squinting comes in fully only once it is near its smallest (~2.2 mm).
    // With a wide night-time pupil, at most a quarter of the squint.
    const pupilSat = sstep(3.2, 2.2, state.pupil);
    const St = sstep(3.0 + sh, 0.0 + sh, rating) * (0.25 + 0.75 * pupilSat);
    state.sqS += (St - state.sqS) * kE(St > state.sqS ? 0.15 : 0.15);
    const S = state.sqS;
    const softU = 0.01 + 0.025 * state.lidUp;
    // lid closure that puts the upper edge just below the aim point (inverse of lidA)
    const aimT = Math.min(1, Math.max(0, (0.62 - (Math.min(state.sqAim, 0.62) - softU - 0.035)) / 0.68));
    // blend from a general squint to "just below the light" by how much strong light is above
    const aimMix = sstep(0, 3, state.sqW || 0);
    state.sqAimS = (state.sqAimS ?? 0.6) + ((0.6 + (aimT - 0.6) * aimMix) - (state.sqAimS ?? 0.6)) * kE(0.08);
    const aim = state.sqAimS;
    // upper lid: with a strong source above in view, close to just below it; otherwise a general squint
    const manualLock = state.maxOpen < 0.999;                 // F + scroll set: auto-squint off until reset
    // ignore changes under ~2%, so the lids can settle completely when nothing really changes
    const upT = manualLock ? 0 : S * aim;
    if (Math.abs(upT - state.lidAuto) > 0.02 || upT === 0) state.lidAuto += (upT - state.lidAuto) * (upT === 0 ? 1 : 0.5);
    const lowAuto = manualLock ? 0 : 0.4 * S;                  // lower lid: rises at most 40% from squinting
    state.lidManual += ((1 - state.maxOpen) - state.lidManual) * kE(0.06);
    const heldUp = Math.max(state.lidAuto, state.lidManual), heldLow = Math.max(lowAuto, state.lidManual);
    const held = 0.5 * (heldUp + heldLow);
    // brow: lowers a little in bright light, more when squinting
    const browT = 0.35 * sstep(0, 3.5, Math.log10(state.neuralLa)) + (manualLock ? 0 : 0.65 * S);
    state.brow += (browT - state.brow) * kE(0.5);
    if (held > 0.95) state.moisture = Math.min(1, state.moisture + dt / 0.6);
    else state.moisture -= dt / state.blinkInt * (1 - 0.9 * held);
    if (state.moisture <= 0 && state.blinkT < 0){
      state.blinkT = 0; state.moisture = 1; state.blinkInt = state.blinkS * (0.67 + 0.66 * Math.random());
    }
    let b = 0;
    if (state.blinkT >= 0){
      // a blink: closes in 0.05 s, opens in 0.08 s
      if (state.blinkT === 0) state.lashSeed = Math.random() * 1000;   // lashes settle differently after each blink
      const t = state.blinkT;
      b = t < 0.05 ? sstep(0, 1, t / 0.05) : 1 - sstep(0, 1, (t - 0.05) / 0.08);
      state.blinkT += dt; if (state.blinkT > 0.13){ state.blinkT = -1; state.sinceBlink = 0; }
    }
    state.lidUp = Math.max(heldUp, b); state.lidLow = Math.max(heldLow, b);
    state.lid = 0.5 * (state.lidUp + state.lidLow);
  } else { state.lid = 0; state.lidUp = 0; state.lidLow = 0; state.lidAuto = 0; state.lidManual = 0; state.blinkT = -1; state.sqS = 0; }
}

// Light meter: shrink the frame, average the squint map over time, measure into 2 pixels, read back
// asynchronously (the result is used over the next frames).
function runLightMeter(fx){
  const { dt, sky, fwd, right, up, eyeScale, lightMul, sp, outTex } = fx;
  /* pass 3b: light meter (read back without waiting; used for the next frames) */
  if (floatFB && state.mode !== 2){
    if (!meterT){ meterT = makeTarget(2, 1); meterPbo = gl.createBuffer(); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, meterPbo); gl.bufferData(gl.PIXEL_PACK_BUFFER, 32, gl.STREAM_READ); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); }
    if (meterFence){
      const st = gl.clientWaitSync(meterFence, 0, 0);
      if (st === gl.ALREADY_SIGNALED || st === gl.CONDITION_SATISFIED){
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, meterPbo); gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, meterBuf); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        gl.deleteSync(meterFence); meterFence = null;
          if (isFinite(meterBuf[2])) state.measPupil = meterBuf[2];
        if (isFinite(meterBuf[4])) state.glareRating = meterBuf[4];
        if (isFinite(meterBuf[5])) state.sqAim = meterBuf[5];
        if (isFinite(meterBuf[6])) state.sqW = meterBuf[6];
        if (isFinite(meterBuf[0])){
          const base = Math.max(Math.exp(meterBuf[0]), isFinite(meterBuf[1]) ? state.brightW * meterBuf[1] : 0);
          // the centre of vision adapts to what it is looking at: looking at the sun or a lamp raises the
          // adaptation level (up to 2000x), so everything else looks dark
          const glare = isFinite(meterBuf[3]) ? Math.min(state.gazeK * meterBuf[3], Math.pow(10, state.gazeMaxL) * base) : 0;
          state.measV = Math.max(base, glare);
        }
      }
    }
    if (!meterFence && frameNo % 3 === 0){
      const dw = Math.ceil(W / 8), dh = Math.ceil(H / 8);
      if (!downT || downT.w !== dw || downT.h !== dh){ freeTarget(downT); downT = makeTarget(dw, dh, { mips: true }); }
      gl.bindFramebuffer(gl.FRAMEBUFFER, downT.fbo); gl.viewport(0, 0, dw, dh);
      gl.useProgram(downP.p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, outTex); gl.uniform1i(downP.u.uSrc, 0);
      gl.uniform2i(downP.u.uSrcSize, W, H);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindTexture(gl.TEXTURE_2D, downT.tex); gl.generateMipmap(gl.TEXTURE_2D);
      // squint input averaged over ~0.3 s per screen spot
      if (!sqAvgT){ sqAvgT = [makeTarget(128, 64), makeTarget(128, 64)]; for (const t of sqAvgT){ gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); } gl.bindTexture(gl.TEXTURE_2D, downT.tex); }
      gl.bindFramebuffer(gl.FRAMEBUFFER, sqAvgT[1 - sqAvgI].fbo); gl.viewport(0, 0, 128, 64);
      gl.useProgram(sqavgP.p);
      gl.uniform1i(sqavgP.u.uSrc, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, sqAvgT[sqAvgI].tex); gl.uniform1i(sqavgP.u.uPrev, 1);
      gl.uniform1f(sqavgP.u.uLod, Math.max(0, Math.log2(dw / 128)));
      gl.uniform1f(sqavgP.u.uK, 1 - Math.exp(-Math.min(sqDt, 0.5) / 0.3)); sqDt = 0;
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      sqAvgI = 1 - sqAvgI;
      // light on the lids: a smooth, wide average of the scene
      if (!lidGlowT) lidGlowT = makeTarget(32, 16);
      gl.bindFramebuffer(gl.FRAMEBUFFER, lidGlowT.fbo); gl.viewport(0, 0, 32, 16);
      gl.useProgram(lidglowP.p); gl.uniform1i(lidglowP.u.uSrc, 0);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, downT.tex);
      gl.uniform1f(lidglowP.u.uLod, Math.max(0, Math.log2(dw / 24)));
      gl.uniform1f(lidglowP.u.uOmega, (W / 24) * (H / 12) * sp.pixVis * sp.pixVis);
      gl.uniform2f(lidglowP.u.uScrPx, W, H); gl.uniform1f(lidglowP.u.uPixRad, sp.pixVis);
      gl.uniform1f(lidglowP.u.uCapL, 60.0);   // scene units x 0.9: well above sky, sunlit walls and lamp pools
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, sqAvgT[sqAvgI].tex);                 // unit 1: the averaged map, for the meter
      gl.activeTexture(gl.TEXTURE0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, meterT.fbo); gl.viewport(0, 0, 2, 1);
      gl.useProgram(meterP.p);
      gl.uniform1i(meterP.u.uSrc, 0); gl.uniform1i(meterP.u.uSqMap, 1);
      // squint: judged as if the eyes were open (closing them darkens adaptation, which must not feed back)
      const sqScale = eyeScale * state.lidT;
      gl.uniform1f(meterP.u.uOnScr, sqScale); gl.uniform1f(meterP.u.uLidNow, state.lidUp);
      gl.uniform1f(meterP.u.uCdU, lightMul * 5000 / 0.9); gl.uniform1f(meterP.u.uLu, state.neuralLa / Math.max(state.lidT, 0.02));
      gl.uniform1f(meterP.u.uOmega, (W / 64) * (H / 32) * sp.pixVis * sp.pixVis);
      gl.uniform2f(meterP.u.uScrPx, W, H); gl.uniform1f(meterP.u.uPixRad, sp.pixVis);
      gl.uniform1f(meterP.u.uCap, Math.max(30 * state.measV, 1e-3));
      gl.uniform1f(meterP.u.uLod, Math.max(0, Math.log2(Math.max(dw / 24, dh / 14))));
      const fovPx = (4 * Math.PI / 180) / sp.pixVis;   // ~4 degrees, in screen pixels
      gl.uniform2f(meterP.u.uGazeUV, state.gaze[0] / W, state.gaze[1] / H);
      gl.uniform2f(meterP.u.uFovR, fovPx / W, fovPx / H);
      gl.uniform1f(meterP.u.uFovLod, Math.max(0, Math.log2(fovPx / 32)));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, meterPbo); gl.readPixels(0, 0, 2, 1, gl.RGBA, gl.FLOAT, 0); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      meterFence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); gl.flush();
    }
  }

}

// Light inside the eye: the half-size frame, the blur chain (glow, light through the lids) and streaks.
function runEyeOptics(fx){
  const { dt, sky, fwd, right, up, eyeScale, lightMul, sp, outTex } = fx;
  // light scattered inside the eye: a chain of smooth blurs (glow) and the streaks
  const glowOn = floatFB && state.mode === 0 && state.scatter > 0;
  const streakOn = floatFB && state.mode === 0 && state.streaks > 0;
  state.sinceBlink = (state.sinceBlink ?? 9) + dt;
  sqDt += dt;
  const lidsOn = floatFB && state.mode === 0 && state.lid > 0.001;
  const afterOn = floatFB && state.mode === 0 && state.afterOn && state.after > 0;
  if (glowOn || streakOn || lidsOn || afterOn){
    const hw = Math.ceil(W / 2), hh = Math.ceil(H / 2);
    if (!glareH || glareH.w !== hw || glareH.h !== hh){
      freeTarget(glareH); glareH = makeTarget(hw, hh);
      for (const t of glareD.concat(glareU)) freeTarget(t);
      glareD = []; glareU = [];
      // levels 1/4 ... 1/512 of the screen; the glow uses 1/8 and coarser (about 1.5 to 50 degrees wide)
      for (let k = 1; k <= 8; k++){ const w = Math.max(1, Math.ceil(W / Math.pow(2, k + 1))), h = Math.max(1, Math.ceil(H / Math.pow(2, k + 1))); glareD.push(makeTarget(w, h)); glareU.push(makeTarget(w, h)); }
      freeTarget(streakT); streakT = makeTarget(hw, hh);
      freeTarget(streakA); streakA = makeTarget(hw, hh); freeTarget(streakB); streakB = makeTarget(hw, hh);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, glareH.fbo); gl.viewport(0, 0, hw, hh);
    gl.useProgram(gdownP.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, outTex); gl.uniform1i(gdownP.u.uSrc, 0);
    gl.uniform2i(gdownP.u.uSrcSize, W, H);
    gl.uniform1f(gdownP.u.uLidU, state.lids && state.mode === 0 ? state.lidUp : 0);
    gl.uniform1f(gdownP.u.uLidL, state.lids && state.mode === 0 ? state.lidLow : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (glowOn || lidsOn){
      gl.useProgram(bdownP.p); gl.uniform1i(bdownP.u.uSrc, 0);
      let src = glareH;
      for (const t of glareD){
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo); gl.viewport(0, 0, t.w, t.h);
        gl.bindTexture(gl.TEXTURE_2D, src.tex); gl.uniform2f(bdownP.u.uDst, t.w, t.h);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        src = t;
      }
    }
    if (glowOn){
      // weights: most light stays close to the source (each wider level gets 55% of the one before)
      const lv = [1, 2, 3, 4, 5, 6, 7];              // glareD indices used: 1/8 .. 1/512
      const wts = lv.map((_, i) => Math.pow(0.55, i)), wsum = wts.reduce((a, b) => a + b, 0);
      gl.useProgram(bupP.p); gl.uniform1i(bupP.u.uSrc, 0); gl.uniform1i(bupP.u.uBase, 1);
      for (let i = lv.length - 2; i >= 0; i--){
        const k = lv[i], t = glareU[k];
        const coarser = i === lv.length - 2 ? glareD[lv[i + 1]] : glareU[lv[i + 1]];
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo); gl.viewport(0, 0, t.w, t.h);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, glareD[k].tex);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, coarser.tex);
        gl.uniform2f(bupP.u.uDst, t.w, t.h);
        gl.uniform1f(bupP.u.uW, wts[i] / wsum);
        gl.uniform1f(bupP.u.uSrcW, i === lv.length - 2 ? wts[i + 1] / wsum : 1);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
    }
    if (streakOn){
      // lines: [direction (radians), strength, length (degrees)]
      const L = state.lid, lines = [];
      // lid edges and lashes are mostly out of the light's path with the eyes wide open: their spikes
      // come with squinting; wide open, mostly the faint lens-fibre star remains
      lines.push([Math.PI / 2, 0.05 + 2.95 * sstep(0.15, 0.85, L), 10 + 25 * L]);     // eyelid edges (vertical)
      const lashW = 0.05 + 0.95 * sstep(0.1, 0.6, L);
      // eyelashes: a pattern from the seed; a blink jolts it (random) and it settles back within ~0.15 s
      let sd = (SEED * 7919) % 233280; const rnd1 = () => { sd = (sd * 9301 + 49297) % 233280; return sd / 233280; };
      let sj = Math.floor(state.lashSeed * 233) % 233280; const rnd2 = () => { sj = (sj * 9301 + 49297) % 233280; return sj / 233280; };
      const jolt = Math.exp(-(state.sinceBlink || 9) / 0.12);
      for (let j = 0; j < 2; j++) lines.push([(rnd1() - 0.5) * 0.9 + (rnd2() - 0.5) * 0.8 * jolt, (0.4 + 0.5 * rnd1()) * lashW, 18 + 22 * rnd1()]);
      for (let j = 0; j < 3; j++) lines.push([j * Math.PI / 3 + 0.3, 0.12, 5]);      // lens fibres
      // astigmatism: the eye focuses one direction differently, smearing point lights into a line along it
      if (state.astig > 0) lines.push([state.astigAxis * Math.PI / 180, 3.0 * state.astig, 6 + 30 * state.astig]);
      gl.bindFramebuffer(gl.FRAMEBUFFER, streakT.fbo); gl.viewport(0, 0, hw, hh);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(streakP.p);
      const su2 = streakP.u;
      gl.uniform1i(su2.uSrc, 0); gl.uniform1f(su2.uScale, eyeScale); gl.uniform1f(su2.uLid, state.lidUp); gl.uniform1f(su2.uLidLo, state.lidLow);
      gl.activeTexture(gl.TEXTURE0);
      // each line twice: a short bright core and a long faint tail (diffraction falls off steeply, then lingers)
      const runs = [];
      for (const [ang, w, lenDeg] of lines){ runs.push([ang, w, lenDeg * 0.12]); runs.push([ang, w * 0.06, lenDeg * 0.5]); }
      for (const [ang, w, lenDeg] of runs){
        const lenPx = (lenDeg * Math.PI / 180) / sp.pixVis / 2;      // fall-off length in half-size pixels
        gl.uniform2f(su2.uDir, Math.cos(ang), Math.sin(ang));
        gl.uniform1f(su2.uAtt, Math.exp(-1 / Math.max(lenPx, 1)));
        let src = glareH;
        for (let pass = 0; pass < 4; pass++){
          const last = pass === 3, dst = last ? streakT : (pass % 2 === 0 ? streakA : streakB);
          gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
          gl.bindTexture(gl.TEXTURE_2D, src.tex);
          gl.uniform1f(su2.uStep, Math.pow(4, pass)); gl.uniform1i(su2.uFirst, pass === 0 ? 1 : 0);
          gl.uniform1f(su2.uGain, last ? w : 1);
          if (last){ gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); }
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          if (last) gl.disable(gl.BLEND);
          src = dst;
        }
      }
    }
  }
  return { glowOn, streakOn, lidsOn, afterOn };
}

// After-images: the retina map follows the gaze point with a slight delay.
function runAfterimages(fx, afterOn){
  const { dt, sky, fwd, right, up, eyeScale, lightMul, sp, outTex } = fx;
  // after-images: the retina map follows the gaze point with a slight delay
  if (!state.gazeLag) state.gazeLag = state.gaze.slice();
  { const kg = 1 - Math.exp(-dt / 0.05); state.gazeLag[0] += (state.gaze[0] - state.gazeLag[0]) * kg; state.gazeLag[1] += (state.gaze[1] - state.gazeLag[1]) * kg; }
  if (afterOn){
    const aw = Math.ceil(W * 1.5 / 8), ah = Math.ceil(H * 1.5 / 8);   // 1.5x the screen, so it still covers it when the gaze is off-centre
    if (!afterT || afterT.w !== aw || afterT.h !== ah){
      if (afterT) afterT.t.forEach(freeTarget);
      afterT = { w: aw, h: ah, i: 0, t: [makeTarget(aw, ah), makeTarget(aw, ah), makeTarget(aw, ah), makeTarget(aw, ah)] };
      for (const t of afterT.t){ gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
    }
    const i0 = afterT.i, F0 = afterT.t[i0 * 2], S0 = afterT.t[i0 * 2 + 1], F1 = afterT.t[(1 - i0) * 2], S1 = afterT.t[(1 - i0) * 2 + 1];
    gl.useProgram(afterP.p);
    const au2 = afterP.u;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, F0.tex); gl.uniform1i(au2.uPrevF, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, S0.tex); gl.uniform1i(au2.uPrevS, 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, glareH.tex); gl.uniform1i(au2.uSrc, 2);
    gl.uniform2f(au2.uScreen, W, H); gl.uniform2f(au2.uGazeLag, state.gazeLag[0], state.gazeLag[1]); gl.uniform2f(au2.uGridC, aw * 4, ah * 4);
    gl.uniform1f(au2.uOpen, 1);   // the half-size frame is already masked by the lids
    gl.uniform1f(au2.uTd, 4 * lightMul * 5000 / 0.9 * Math.PI * Math.pow(state.pupil / 2, 2));   // x scene value = trolands
    gl.uniform1f(au2.uDt, Math.min(dt, 0.1));
    gl.viewport(0, 0, aw, ah);
    gl.bindFramebuffer(gl.FRAMEBUFFER, F1.fbo); gl.uniform1i(au2.uWhich, 0); gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, S1.fbo); gl.uniform1i(au2.uWhich, 1); gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
    afterT.i = 1 - i0;
  }

}

function frame(now){
  // while the map covers the screen, the city is paused (nothing to see, and the map gets the machine)
  if (worldMap.isOpen()){ last = now; requestAnimationFrame(frame); return; }
  pstart();
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  step(dt);
  advanceSky(dt);
  const sp = samplingParams();
  ensureTargets(sp);
  const gaze = state.mouseGaze ? state.gaze : hasGazeOff() ? [W/2 + state.eyeOff[0], H/2 + state.eyeOff[1]] : [W/2, H/2];

  fpsAcc += dt; fpsN++; fpsT += dt;
  whereT += dt;
  if (whereT > 0.1){
    whereT = 0;
    const hd = heading();
    $("where").textContent = "x " + state.pos[0].toFixed(1) + "  y " + state.pos[1].toFixed(1) + "  z " + state.pos[2].toFixed(1)
      + " · heading " + Math.round(hd) + "° " + compass(hd) + " · pitch " + Math.round(state.pitch * 180 / Math.PI) + "°"
      + (state.dof ? " · focus " + fmtDist(1 / state.focusD) : "") + " · pupil " + state.pupil.toFixed(1) + " mm"
      + (state.camMode !== 0 ? bodyText() : "");
    $("rFocus").textContent = fmtDist(1 / state.focusD);
    $("rPupil").textContent = state.pupil.toFixed(1) + " mm" + (state.autoPupil ? " (auto)" : "");
    $("rLum").textContent = fmtLum(state.measV * (state.lightNorm || 1) * 5000);
    $("lightOut").textContent = lightName(state.lightLog);
    if (state.cycle){
      if (document.querySelector('details[data-key="sky"]')?.open) drawDials();
      if (state.realMoon && state.panel){ $("moonDec").value = state.moonDec; updateReadouts(); }
    }
    const kk = computeSky();
    $("elevOut").textContent = Math.round(kk.sun.el) + "° / " + Math.round(kk.moon.el) + "°";
    if (state.panel) $("pupilOut").textContent = state.pupil.toFixed(1) + " mm" + (state.autoPupil ? " (auto)" : "");
    if (state.panel && document.activeElement !== $("codeOut")) $("codeOut").value = viewCode();
  }
  if (fpsT > 0.5){
    const rays = estimateRays(sp, gaze);
    raysTxt = (sp.dofCells ? "≤ " : "") + fmtCount(rays) + " (" + (100 * rays / (W*H)).toFixed(rays / (W*H) < 0.1 ? 1 : 0) + "% of pixels)";
    $("rRays").textContent = raysTxt;
    $("fps").innerHTML = "<b>" + Math.round(fpsN / fpsAcc) + " fps</b> · " + W + "×" + H + " · " + (sp.dofCells ? "≤ " : "") + fmtCount(rays) + " rays" + (state.zoom > 1.02 ? " · " + state.zoom.toFixed(1) + "× zoom" : "");
    fpsAcc = 0; fpsN = 0; fpsT = 0;
  }

  const cp = Math.cos(state.pitch);
  const fwd = [Math.sin(state.yaw) * cp, Math.sin(state.pitch), Math.cos(state.yaw) * cp];
  let right = [fwd[2], 0, -fwd[0]]; const rl = Math.hypot(right[0], right[2]) || 1; right = [right[0]/rl, 0, right[2]/rl];
  const up = [fwd[1]*right[2] - fwd[2]*right[1], fwd[2]*right[0] - fwd[0]*right[2], fwd[0]*right[1] - fwd[1]*right[0]];
  const rot = new Float32Array([...right, ...up, ...fwd]);
  const d = sp.pr.d;
  const xmax = sp.pr.xmax / state.zoom;
  const acuityRad = state.acuity * Math.PI / 10800;
  const gd = projDirJS(gaze[0], gaze[1], xmax, d);
  // Focus: distance of whatever is under the gaze point, eased in diopters like the eye's lens
  const gw = [right[0]*gd[0] + up[0]*gd[1] + fwd[0]*gd[2], right[1]*gd[0] + up[1]*gd[1] + fwd[1]*gd[2], right[2]*gd[0] + up[2]*gd[1] + fwd[2]*gd[2]];
  // the lens cannot focus closer than the near point; anything nearer stays blurred
  const tG = castJS(state.pos, gw);
  const targetD = Math.min(1 / Math.max(tG, 0.01), 100 / state.nearPt);
  const aP = [state.pos[0] + gw[0]*tG, state.pos[1] + gw[1]*tG, state.pos[2] + gw[2]*tG];
  const aCell = [Math.floor((aP[0] + gw[0] * 0.05) / CELL), Math.floor((aP[2] + gw[2] * 0.05) / CELL)];   // just inside the surface
  const aBld = tG < 1800 && aP[1] > 0.2 && bldAt(aCell[0], aCell[1]).kind >= 0;

  // Eye adaptation. La = light reaching the eye (cd/m2), from the meter reading of the last frames.
  // The pupil follows quickly when light rises and slowly when it falls; the retina adapts more slowly.
  state.cloudT += dt;
  const sky = computeSky();
  const lightMul = sky.L;                    // scene units -> real light (cd/m2 = value x 5000 x lightMul)
  const fx = { dt, sky, fwd, right, up, lightMul, sp, xmax, d, eyeScale: 1, outTex: null };
  state.lightNorm = lightMul;
  state.lightLog = Math.log10(sky.Ltrue);    // natural light level, for the readout
  // floor: the eye never judges a view darker than ~2% of a normal street, so a dark wall up close
  // cannot drive the brightness gain without limit
  // Eyelids. Three things can close them: blinking (a moisture timer that runs down more slowly the more
  // closed the eyes are), squinting at light far above the eye's level, and the player (F).
  const kE = (tau) => 1 - Math.exp(-dt / tau);
  updateFaceLight(fx);
  updateEyelids(fx);
  // light reaching the eye: the share of the (strongly centre-weighted) view inside the lid opening, plus
  // the ~2% that passes through the lids. The opening is around the centre, so a squint costs little light.
  const erf = (x) => Math.tanh(1.128 * x + 0.1029 * x * x * x);
  const openShare = Math.max(0, 0.5 * (erf(lidA(state.lidUp) * 3.46) + erf(lidA(state.lidLow) * 3.46)));
  const lidPass = openShare + (1 - openShare) * 0.023;     // lids pass ~2.3% of light (luminance-weighted)
  // Darkness behind the lids changes adaptation only on a dark-adaptation timescale (~15 s; real dark
  // adaptation takes minutes), so a blink or a squint leaves the eye adapted to the scene: closed lids look
  // dark at night, and stay shut in the sun for a while to see them brighten to red.
  state.lidT += (lidPass - state.lidT) * kE(lidPass < state.lidT ? 15.0 : 0.3);
  const La = Math.max(Math.max(state.measV, 0.0034) * lightMul * 5000 * state.lidT, 1e-7);
  const towards = (cur, target, tUp, tDown) => {
    const lc = Math.log(cur), lt = Math.log(target), tau = lt > lc ? tUp : tDown;
    return Math.exp(lc + (lt - lc) * (1 - Math.exp(-dt / tau)));
  };
  // The pupil answers to all the light entering the eye, so a bright lamp or the sun anywhere in view
  // closes it, even while the eye stays adapted to the darker things it is looking at.
  const LaPupil = Math.max(La, state.pupilBright * (state.measPupil || 0) * lightMul * 5000 * state.lidT);
  state.pupilLa = towards(state.pupilLa, LaPupil, state.puUp, state.puDown);
  state.neuralLa = towards(state.neuralLa, La, state.adUp, state.adDown);
  if (state.autoPupil){ state.pupil = pupilAge(state.pupilLa); if (state.panel && frameNo % 6 === 0){ $("pupil").value = state.pupil; } }
  const LaRef = 850, Dref = pupilFor(LaRef);   // ~a sunlit street view: at this level the image matches the unadapted render
  // standard view: like a camera with auto exposure (shows the scene at a normal brightness)
  // Brightness on screen. The eye adjusts to what it is looking at (exposure follows the adapted
  // luminance), but how bright a scene can look is limited by the light level: dark adaptation cannot
  // make starlight look like day. perceivedFor() gives that ceiling; the pupil lagging behind the
  // adapted level gives the brief dimming or glare after a change.
  const eyeScale = state.mode === 1 ? 1
    : perceivedFor(state.neuralLa) * (LaRef * lightMul / state.neuralLa) * Math.pow(state.pupil / pupilAge(state.neuralLa), 2);
  const kF = state.refocus > 0 ? 1 - Math.exp(-dt / state.refocus) : 1;
  state.focusD += (targetD - state.focusD) * kF;
  const dofOn = state.dof && state.mode !== 1;
  if (dofOn){
    // sample a 7x5 grid of rays to find the largest blur radius on screen (pixels)
    let mr = 0, md = 0;
    const pupilEff = state.pupil / 1000 * state.dofGain;
    for (let j = 0; j < 5; j++) for (let i = 0; i < 7; i++){
      const dd = projDirJS((i + 0.5) / 7 * W, (j + 0.5) / 5 * H, xmax, d);
      const wd = [right[0]*dd[0] + up[0]*dd[1] + fwd[0]*dd[2], right[1]*dd[0] + up[1]*dd[1] + fwd[1]*dd[2], right[2]*dd[0] + up[2]*dd[1] + fwd[2]*dd[2]];
      const dist = castJS(state.pos, wd);
      mr = Math.max(mr, 0.5 * pupilEff * Math.abs(1 / Math.max(dist, 0.05) - state.focusD) / sp.pixVis);
      md = Math.max(md, Math.abs(1 / Math.max(dist, 0.05) - state.focusD));
    }
    // grow at once, shrink slowly, so a thin near object between probe rays is not missed for long
    dofMaxR = Math.min(Math.max(mr * 1.25, dofMaxR * 0.9), 0.025 * W);
    diploMaxD = Math.max(md, Math.min(diploMaxD, 50) * 0.9);
  } else { dofMaxR = 0; diploMaxD = 1e3; }   // without the probes, double vision searches its full range
  const prevRes = resolveTs[1 - resIdx], curRes = resolveTs[resIdx];
  const temporal = state.temporal && floatFB;
  frameNo++;
  const jit = temporal ? [halton(frameNo % 16 + 1, 2) - 0.5, halton(frameNo % 16 + 1, 3) - 0.5] : [0, 0];
  const sig = [state.mode, sp.fov, sp.lpMode, state.cell, state.smooth, temporal].join();
  if (sig !== lastSig){ needReset = true; lastSig = sig; }

  pmark("CPU: movement, focus, probes");
  /* pass 1: one ray per cell */
  gl.useProgram(sceneP.p);
  const su = sceneP.u;
  gl.uniform2f(su.uRes, W, H); gl.uniform3f(su.uCamPos, ...state.pos);
  gl.uniformMatrix3fv(su.uCamRot, false, rot);
  gl.uniform1f(su.uXmax, xmax); gl.uniform1f(su.uPanini, d); gl.uniform1f(su.uZoom, state.zoom);
  gl.uniform2f(su.uGaze, gaze[0], gaze[1]); gl.uniform3f(su.uGazeDir, gd[0], gd[1], gd[2]);
  gl.uniform1f(su.uAcuity, acuityRad); gl.uniform1i(su.uMode, state.mode); gl.uniform1ui(su.uSeed, SEED);
  gl.uniform1i(su.uFov, sp.fov ? 1 : 0); gl.uniform1i(su.uLpMode, sp.lpMode ? 1 : 0); gl.uniform1i(su.uFast, state.fast ? 1 : 0);
  gl.uniform1f(su.uBase, sp.base); gl.uniform1f(su.uMult, sp.mult); gl.uniform1f(su.uA, sp.A); gl.uniform1f(su.uR2, sp.R2);
  gl.uniform1f(su.uR0, sp.r0); gl.uniform1f(su.uNth, sp.Nth); gl.uniform1f(su.uS, sp.s); gl.uniform1f(su.uE2, state.e2);
  gl.uniform1f(su.uPixVis, sp.pixVis); gl.uniform2f(su.uJit, jit[0], jit[1]);
  setSkyUniforms(su, sky); gl.uniform1f(su.uEyeScale, eyeScale); gl.uniform1i(su.uCity, 12); gl.uniform1i(su.uZero, 0);
  gl.uniform1i(su.uReflMode, state.reflOn ? state.reflMode : 0); gl.uniform1f(su.uReflReach, state.reflReach);
  gl.activeTexture(gl.TEXTURE12); gl.bindTexture(gl.TEXTURE_2D, cityTex); gl.activeTexture(gl.TEXTURE0);
  const setFocus = (u) => {
    gl.uniform1f(u.uFocusD, state.focusD); gl.uniform1f(u.uPupil, state.pupil / 1000 * state.dofGain);
    gl.uniform1i(u.uDof, dofOn ? 1 : 0); gl.uniform1i(u.uDofCells, sp.dofCells && dofOn ? 1 : 0);
    gl.uniform1i(u.uHavePrev, havePrev ? 1 : 0); gl.uniform1i(u.uPrevDepth, 2);
  };
  setFocus(su);
  gl.uniform1i(su.uAttn, state.attn && state.mode !== 1 ? 1 : 0); gl.uniform1i(su.uAttnBld, aBld ? 1 : 0);
  gl.uniform1f(su.uAttnK, state.attnK); gl.uniform3f(su.uAttnP, aP[0], aP[1], aP[2]); gl.uniform2f(su.uAttnCell, aCell[0], aCell[1]);
  gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, prevRes.tex); gl.activeTexture(gl.TEXTURE0);

  gl.bindFramebuffer(gl.FRAMEBUFFER, atlasT.fbo);
  if (floatFB){ gl.viewport(0, 0, sp.atlasW, sp.atlasH); gl.clearColor(0, 0, 0, -1); gl.clear(gl.COLOR_BUFFER_BIT); }
  gl.enable(gl.SCISSOR_TEST);
  gl.uniform1i(su.uLayout, 0);
  for (let k = 0; k < sp.K; k++){
    const l = sp.lv[k];
    gl.viewport(l.x, l.y, l.w, l.h); gl.scissor(l.x, l.y, l.w, l.h);
    gl.uniform1f(su.uCell, l.cell); gl.uniform1i(su.uLvl, k); gl.uniform2f(su.uLvlOff, l.x, l.y);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  if (sp.lpMode){
    gl.bindFramebuffer(gl.FRAMEBUFFER, lpT.fbo);
    gl.viewport(0, 0, sp.Nth, sp.Nr); gl.scissor(0, 0, sp.Nth, sp.Nr);
    gl.uniform1i(su.uLayout, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  gl.disable(gl.SCISSOR_TEST);
  const blur = !sp.fov && state.mode === 0;
  if (blur){ gl.bindTexture(gl.TEXTURE_2D, atlasT.tex); gl.generateMipmap(gl.TEXTURE_2D); }

  pmark("scene rays (cells)");
  /* pass 2: reassemble cells into a screen image */
  gl.bindFramebuffer(gl.FRAMEBUFFER, curRes.fbo);
  gl.viewport(0, 0, W, H);
  gl.useProgram(resolveP.p);
  const ru = resolveP.u;
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, atlasT.tex); gl.uniform1i(ru.uAtlas, 0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, sp.lpMode ? lpT.tex : atlasT.tex); gl.uniform1i(ru.uLP, 1);
  gl.activeTexture(gl.TEXTURE0);
  const offs = new Float32Array(16), sizes = new Float32Array(16);
  sp.lv.forEach((l, k) => { offs[2*k] = l.x; offs[2*k+1] = l.y; sizes[2*k] = l.w; sizes[2*k+1] = l.h; });
  gl.uniform2fv(ru["uLvlOffA[0]"], offs); gl.uniform2fv(ru["uLvlSizeA[0]"], sizes);
  gl.uniform2f(ru.uRes, W, H); gl.uniform2f(ru.uGaze, gaze[0], gaze[1]); gl.uniform2f(ru.uAtlasSize, sp.atlasW, sp.atlasH);
  gl.uniform1i(ru.uK, sp.K); gl.uniform1i(ru.uFov, sp.fov ? 1 : 0); gl.uniform1i(ru.uLpMode, sp.lpMode ? 1 : 0);
  gl.uniform1i(ru.uSmooth, state.smooth ? 1 : 0); gl.uniform1i(ru.uBlur, blur ? 1 : 0);
  gl.uniform1f(ru.uBase, sp.base); gl.uniform1f(ru.uMult, sp.mult); gl.uniform1f(ru.uA, sp.A); gl.uniform1f(ru.uR2, sp.R2);
  gl.uniform1f(ru.uR0, sp.r0); gl.uniform1f(ru.uNth, sp.Nth); gl.uniform1f(ru.uNr, sp.Nr); gl.uniform1f(ru.uS, sp.s);
  gl.uniform1f(ru.uPixVis, sp.pixVis); setFocus(ru);
  gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, prevRes.tex); gl.activeTexture(gl.TEXTURE0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  pmark("assemble cells");
  /* pass 2b: spread out-of-focus edges */
  let colTex = curRes.tex;
  if (dofOn && dofMaxR > 0.75){
    gl.bindFramebuffer(gl.FRAMEBUFFER, dofT.fbo);
    gl.viewport(0, 0, W, H);
    gl.useProgram(dofP.p);
    const du = dofP.u;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, curRes.tex); gl.uniform1i(du.uSrc, 0);
    gl.uniform2f(du.uRes, W, H); gl.uniform1f(du.uPixVis, sp.pixVis); gl.uniform1f(du.uFocusD, state.focusD);
    gl.uniform1f(du.uPupil, state.pupil / 1000 * state.dofGain); gl.uniform1f(du.uMaxR, dofMaxR);
    gl.uniform1i(du.uN, Math.max(8, Math.min(48, Math.round(dofMaxR * dofMaxR * 0.5))));   // ~ one sample per 2 px² of the disk
    gl.uniform1f(du.uRot, temporal ? frameNo * 0.7853981 : 0.0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    colTex = dofT.tex;
  }

  pmark("focus blur spread");
  /* pass 3: blend with the reprojected previous frames */
  let outTex = colTex;
  if (temporal){
    const cur = hist[histIdx], prv = hist[1 - histIdx];
    gl.bindFramebuffer(gl.FRAMEBUFFER, cur.fbo);
    gl.useProgram(accumP.p);
    const au = accumP.u;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, colTex); gl.uniform1i(au.uCur, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, prv.tex); gl.uniform1i(au.uHist, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform2f(au.uRes, W, H); gl.uniform2f(au.uGaze, gaze[0], gaze[1]);
    gl.uniform1i(au.uFov, sp.fov ? 1 : 0); gl.uniform1f(au.uBase, sp.base); gl.uniform1f(au.uMult, sp.mult);
    gl.uniform1f(au.uA, sp.A); gl.uniform1f(au.uR2, sp.R2); gl.uniform1f(au.uPixVis, sp.pixVis);
    setFocus(au); gl.uniform1i(au.uPrevDepth, 0);
    gl.uniformMatrix3fv(au.uCamRot, false, rot); gl.uniform3f(au.uCamPos, ...state.pos);
    gl.uniform1f(au.uXmax, xmax); gl.uniform1f(au.uPanini, d);
    const pc = prevCam || { rot, pos: state.pos.slice(), xmax, d };
    gl.uniformMatrix3fv(au.uPrevRot, false, pc.rot); gl.uniform3f(au.uPrevPos, ...pc.pos);
    gl.uniform1f(au.uPrevXmax, pc.xmax); gl.uniform1f(au.uPrevPanini, pc.d);
    gl.uniform1f(au.uKeep, state.keep); gl.uniform1i(au.uReset, (needReset || !prevCam) ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    outTex = cur.tex; histIdx = 1 - histIdx;
  }
  needReset = false;
  havePrev = true; resIdx = 1 - resIdx;
  prevCam = { rot, pos: state.pos.slice(), xmax, d };

  pmark("frame blending");
  fx.outTex = outTex; fx.eyeScale = eyeScale;
  runLightMeter(fx);

  const { glowOn, streakOn, lidsOn, afterOn } = runEyeOptics(fx);
  runAfterimages(fx, afterOn);

  pmark("light meter");
  /* pass 4: present */
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, W, H);
  gl.useProgram(presentP.p);
  const pu = presentP.u;
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, outTex); gl.uniform1i(pu.uTex, 0);
  gl.uniform2f(pu.uRes, W, H); gl.uniform2f(pu.uGaze, gaze[0], gaze[1]);
  gl.uniform1f(pu.uXmax, sp.pr.xmax); gl.uniform1f(pu.uPanini, d); gl.uniform1f(pu.uPixVis, sp.pixVis);
  gl.uniform1i(pu.uMode, state.mode); gl.uniform1i(pu.uRings, state.rings ? 1 : 0); gl.uniform1i(pu.uFast, state.fast ? 1 : 0);
  gl.uniform3f(pu.uRingR, state.ring0, state.ring1, state.ring2);
  gl.uniform1f(pu.uFocusD, state.focusD); gl.uniform1f(pu.uIPD, 0.063);
  gl.uniform1i(pu.uDiploN, Math.max(2, Math.min(24, Math.ceil((0.063 * diploMaxD / sp.pixVis * 0.5 * 1.25) / 4) + 1)));
  gl.uniform1i(pu.uDiplo, state.diplo && state.mode !== 1 ? 1 : 0);
  gl.uniform3f(pu.uEyeRing, W/2, H/2, hasEyes() ? state.eyeRad / 100 * H : 0);
  gl.uniform1f(pu.uScale, eyeScale); gl.uniform1f(pu.uCdPerUnit, lightMul * 5000);
  gl.uniform1i(pu.uNight, state.mode === 0 ? 1 : 0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, glowOn ? glareU[1].tex : outTex); gl.uniform1i(pu.uGlare, 1);
  gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, streakOn ? streakT.tex : outTex); gl.uniform1i(pu.uStreak, 2);
  gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, lidsOn && lidGlowT ? lidGlowT.tex : outTex); gl.uniform1i(pu.uLidBlur, 3);
  gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, lidsOn ? glareD[1].tex : outTex); gl.uniform1i(pu.uSq0, 7);
  gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, lidsOn ? glareH.tex : outTex); gl.uniform1i(pu.uHalf, 4);
  gl.uniform1f(pu.uLid, lidsOn ? state.lid : 0);
  { const ft = state.faceT || [0, 0, 0], k = 1 - Math.exp(-dt / 0.4);
    state.faceLight = (state.faceLight || [0, 0, 0]).map((v, i) => v + (ft[i] - v) * k); }
  gl.uniform1f(pu.uLidBright, state.lidBright);
  gl.uniform3f(pu.uLidAmb, state.faceLight[0] * 0.9, state.faceLight[1] * 0.9, state.faceLight[2] * 0.9);
  gl.uniform1f(pu.uLidUp, lidsOn ? state.lidUp : 0); gl.uniform1f(pu.uLidLow, lidsOn ? state.lidLow : 0);
  gl.uniform1f(pu.uBrow, state.lids && state.mode === 0 ? state.brow : -1);
  if (afterOn){
    const ia = afterT.i;     // the stores just written
    gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, afterT.t[ia * 2].tex); gl.uniform1i(pu.uAftF, 5);
    gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, afterT.t[ia * 2 + 1].tex); gl.uniform1i(pu.uAftS, 6);
    gl.uniform2f(pu.uGazeLag, state.gazeLag[0], state.gazeLag[1]);
    gl.uniform2f(pu.uAftC, afterT.w * 4, afterT.h * 4); gl.uniform2f(pu.uAftSize, afterT.w * 8, afterT.h * 8);
    { const td = state.neuralLa * Math.PI * Math.pow(state.pupil / 2, 2); gl.uniform1f(pu.uBgBleach, td / (td + 20000)); }
  } else {
    gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, outTex); gl.uniform1i(pu.uAftF, 5);
    gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, outTex); gl.uniform1i(pu.uAftS, 6);
  }
  gl.uniform1f(pu.uAfterK, afterOn ? state.after : 0);
  gl.uniform1f(pu.uAftFade, 0.35 + 0.65 * Math.exp(-(state.sinceBlink ?? 9) / 4));   // Troxler fading
  gl.activeTexture(gl.TEXTURE0);
  gl.uniform1f(pu.uGlareK, glowOn ? Math.min(state.scatter / 100 * ageGlare(), 0.5) : 0);
  { const y = sstep(35, 80, state.age), on = state.mode === 0;
    gl.uniform3f(pu.uLensTint, 1, on ? 1 - 0.12 * y : 1, on ? 1 - 0.4 * y : 1); }
  gl.uniform1f(pu.uFringe, state.mode === 0 ? 1.2 * state.fringe : 0);
  gl.uniform1f(pu.uStreakK, streakOn ? 3e-5 * state.streaks : 0);
  { const a = state.astigAxis * Math.PI / 180; gl.uniform3f(pu.uAstig, Math.cos(a), Math.sin(a) * W / H, 0.04 * state.astig); }
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.activeTexture(gl.TEXTURE0);
  drawCompass();
  pmark("final image + overlays");
  pend();
  window.__frames = (window.__frames || 0) + 1;
  if (window.__frames === 1){ load.set("Setup and first frame", performance.now() - tSetup); load.set("Total from Generate", performance.now() - tGenerate); load.ready(); }
  requestAnimationFrame(frame);
}

resize();
setMode(0);
updateReadouts();
window.__setView = (o) => { Object.assign(state, o); updateReadouts(); };
window.__getBld = getBld; window.__state = state;
requestAnimationFrame(frame);
}
start().catch((e) => { window.__shaderError = window.__shaderError || String(e); throw e; });
