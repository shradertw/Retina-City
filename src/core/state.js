/* Everything the controls, the eye and the frame loop read and change. */
export const state = {
  mode: 0, acuity: 1, acuityS: 0.6889, fov: 210, scale: 1, rings: false, mouseGaze: false, fly: false,
  panini: true, paniniD: 5, ring0: 2.5, ring1: 9, ring2: 30, zoomLevel: 2, zoom: 1, rmb: false,
  panelKey: "KeyH", rebinding: false,
  camMode: 0, lmbHead: false, bodySpd: 120, bodyYaw: 0, bodyTurn: false, lmbBody: false, tempLock: false, noLock: false,
  eyeOff: [0, 0], eyeRad: 22, headSpd: 700, recenter: 1.2, mSpeed: 0, mLastT: 0,
  dofGain: 1, dof: true, pupil: 3, refocus: 0.05, nearPt: 20, diplo: true, focusD: 1/20,
  attn: true, attnK: 2.5, autoPupil: true, lightLog: 0,
  timeH: 13.5, moonH: 9.0, phaseDeg: 90, moonCouple: true, reflOn: true, reflMode: 2, reflReach: 400, cycle: false, dayMin: 24, realMoon: false, phaseStep: 30, phaseDebt: 0, cloud: 0.35, cloudLight: false, lamps: true, lampGain: 1, moonSize: 5, sunDec: 0, moonDec: 0, lat: 47.6, lids: true, afterOn: true, gazeLag: null, lid: 0, lidAuto: 0, lidManual: 0, lidT: 1, fHeld: false, fDown: 0, fScrolled: false, maxOpen: 1, glareRating: 9, sqAim: 1, sqS: 0, lidUp: 0, lidLow: 0, brow: 0,
  moisture: 1, blinkInt: 10, blinkT: -1, lashSeed: 1, jumpH: 0, vy: 0, walkY: null, lastSpace: 0, lightNorm: 1, cloudT: 0, measV: 0.17, pupilLa: 850, neuralLa: 850,
  cell: 1, foveated: true, layout: 0, mult: 2, e2: 10, smooth: true, temporal: true, keep: 0.85, fast: true,
  pos: [0.4, 1.7, -30], yaw: 0, pitch: 0.06, gaze: [0, 0], keys: new Set(), panel: true
};
