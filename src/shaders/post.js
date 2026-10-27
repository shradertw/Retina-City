/* After the scene: resolve, focus blur, frame blending, the eye's optics (glare, streaks, lids,
   after-images), the light meter and the final image. */
import { VS, FS, LUMA, LIDS, PROJ, CELLFN } from './common.js';

/* Reassemble the cells into a screen image (hard blocks or smooth blend). */
export const RESOLVE_FS = `#version 300 es
precision highp float;
out vec4 outColor;
uniform sampler2D uAtlas;
uniform sampler2D uLP;
uniform vec2 uRes, uGaze, uAtlasSize;
uniform vec2 uLvlOffA[8];
uniform vec2 uLvlSizeA[8];
uniform int uK, uFov, uLpMode, uSmooth, uBlur;
uniform float uBase, uMult, uA, uR2, uR0, uNth, uNr, uS, uPixVis;
${CELLFN}

// Cells skipped this frame carry a negative distance.
vec4 gridHard(int k, vec2 px){
  float cell = uBase * exp2(float(k));
  ivec2 sz = ivec2(uLvlSizeA[k]);
  ivec2 ti = clamp(ivec2(floor(px / cell)), ivec2(0), sz - 1);
  return texelFetch(uAtlas, ivec2(uLvlOffA[k]) + ti, 0);
}
// Bilinear blend of the four nearest cells, ignoring any that were skipped.
vec4 gridSmooth(int k, vec2 px){
  float cell = uBase * exp2(float(k));
  vec2 sz = uLvlSizeA[k];
  vec2 tc = px / cell - 0.5;
  vec2 i0 = floor(tc), fr = tc - i0;
  vec3 acc = vec3(0.0); float wsum = 0.0, dn = -1.0, wbest = -1.0;
  for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++){
    ivec2 ti = ivec2(clamp(i0 + vec2(float(i), float(j)), vec2(0.0), sz - 1.0));
    vec4 sm = texelFetch(uAtlas, ivec2(uLvlOffA[k]) + ti, 0);
    float w = (i == 0 ? 1.0 - fr.x : fr.x) * (j == 0 ? 1.0 - fr.y : fr.y);
    if (sm.a < 0.0) continue;
    acc += sm.rgb * w; wsum += w;
    if (w > wbest){ wbest = w; dn = sm.a; }
  }
  if (wsum <= 0.0) return vec4(0.0, 0.0, 0.0, -1.0);
  return vec4(acc / wsum, dn);
}
vec4 gridAt(int k, vec2 px, bool hard){ return hard ? gridHard(k, px) : gridSmooth(k, px); }
// Use level k; if those cells were skipped (something moved since last frame), try nearby sizes.
vec4 gridFallback(int k, vec2 px, bool hard){
  vec4 sm = gridAt(k, px, hard);
  for (int i = 1; i < 8; i++){
    if (sm.a >= 0.0) break;
    if (k - i >= 0){ sm = gridAt(k - i, px, hard); if (sm.a >= 0.0) break; }
    if (k + i < uK) sm = gridAt(k + i, px, hard);
  }
  return sm;
}
vec4 lpSample(vec2 px, bool hard){
  vec2 v = px - uGaze;
  float r = length(v);
  float u = (atan(v.y, v.x) / 6.2831853 + 0.5) * uNth;
  float w = log((r + uR2) / (uR0 + uR2)) / uS;
  if (hard){
    ivec2 ti = ivec2(int(mod(floor(u), uNth)), clamp(int(floor(w)), 0, int(uNr) - 1));
    return texelFetch(uLP, ti, 0);
  }
  return textureLod(uLP, vec2(u / uNth, w / uNr), 0.0);
}

void main(){
  vec2 px = gl_FragCoord.xy;
  float r = distance(px, uGaze);
  bool hard = uSmooth == 0;
  if (uFov == 0){
    vec4 c = gridHard(0, px);
    float dN = c.a;
    if (!hard) c.rgb = gridSmooth(0, px).rgb;
    if (uBlur == 1){
      // uniform cells: blur from a mip chain by receptor size and focus
      float rec = uA*(1.0 + r/uR2);
      float df = defocusAng(dN) / uPixVis;
      float lod = log2(max(sqrt(rec*rec + df*df)/uBase, 1.0));
      if (lod > 0.01){
        vec2 uv = px / (uBase * uAtlasSize);
        vec2 o = exp2(lod) * 0.5 / uAtlasSize;
        c.rgb = textureLod(uAtlas, uv, lod).rgb * 0.4
          + (textureLod(uAtlas, uv + vec2(o.x, o.y), lod).rgb + textureLod(uAtlas, uv + vec2(-o.x, o.y), lod).rgb
           + textureLod(uAtlas, uv + vec2(o.x, -o.y), lod).rgb + textureLod(uAtlas, uv - o, lod).rgb) * 0.15;
      }
    }
    outColor = vec4(c.rgb, dN);
    return;
  }
  float band = uS * (uR0 + uR2);
  if (uLpMode == 1 && r >= uR0 + (hard ? 0.0 : band)){
    outColor = vec4(lpSample(px, hard).rgb, lpSample(px, true).a);
    return;
  }
  float L = log2(cellPx(r, prevDepthAt(px)) / uBase);
  int k0 = clamp(int(floor(L)), 0, uK - 1);
  vec4 g = gridFallback(k0, px, hard);
  float dN = hard ? g.a : gridFallback(k0, px, true).a;
  vec3 col = g.rgb;
  if (!hard && k0 + 1 < uK){
    vec4 g1 = gridSmooth(k0 + 1, px);
    if (g1.a >= 0.0) col = mix(col, g1.rgb, clamp(L - float(k0), 0.0, 1.0));
  }
  if (uLpMode == 1 && r >= uR0){
    col = mix(col, lpSample(px, false).rgb, clamp((r - uR0) / band, 0.0, 1.0));
  }
  outColor = vec4(col, dN);
}`;

/* Blend with the previous frame, reprojected through the camera's motion. */
export const ACCUM_FS = `#version 300 es
precision highp float;
out vec4 outColor;
uniform sampler2D uCur;
uniform sampler2D uHist;
uniform vec2 uRes, uGaze;
uniform mat3 uCamRot, uPrevRot;
uniform vec3 uCamPos, uPrevPos;
uniform float uPrevXmax, uPrevPanini, uKeep;
uniform int uReset, uFov;
uniform float uBase, uMult, uA, uR2, uPixVis;
${PROJ}
${CELLFN}
vec2 fwdProj(vec3 d){
  float lon = atan(d.x, d.z);
  float lat = asin(clamp(d.y, -1.0, 1.0));
  float den = uPrevPanini + cos(lon);
  if (den <= 1e-3) return vec2(-1e6);
  float S = (uPrevPanini + 1.0) / den;
  vec2 q = vec2(S*sin(lon), S*tan(lat));
  return q / uPrevXmax * 0.5 * uRes.x + 0.5 * uRes;
}
void main(){
  vec2 px = gl_FragCoord.xy;
  vec4 c = texelFetch(uCur, ivec2(px), 0);
  if (uReset == 1){ outColor = c; return; }
  vec3 p = uCamPos + (uCamRot * projDir(px)) * c.a;
  vec3 v = transpose(uPrevRot) * (p - uPrevPos);
  vec2 pp = fwdProj(v / length(v));
  if (pp.x < 0.0 || pp.y < 0.0 || pp.x >= uRes.x || pp.y >= uRes.y){ outColor = c; return; }
  vec3 hst = texture(uHist, pp / uRes).rgb;
  if (any(isnan(hst)) || any(isinf(hst))) hst = c.rgb;   // never let a bad value persist
  // Limit history to the colours found in this cell and its neighbouring cells.
  // An edge cell sees both sides, so it can average; a moving smear falls outside the range and is cut.
  float cs = max(cellPx(distance(px, uGaze), c.a), 1.0);
  vec3 mn = c.rgb, mx = c.rgb;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++){
    if (i == 0 && j == 0) continue;
    vec2 q = clamp(px + vec2(float(i), float(j)) * cs, vec2(0.0), uRes - 1.0);
    vec3 n = texelFetch(uCur, ivec2(q), 0).rgb;
    mn = min(mn, n); mx = max(mx, n);
  }
  hst = clamp(hst, mn, mx);
  outColor = vec4(mix(c.rgb, hst, uKeep), c.a);
}`;

/* Let out-of-focus objects spread past their own silhouettes.
   Each pixel gathers nearby pixels whose blur disk reaches it. A background pixel may not spread
   over a sharper object in front of it; a blurry foreground object does spread over the background. */

export const DOF_FS = `#version 300 es
precision highp float;
out vec4 outColor;
uniform sampler2D uSrc;
uniform vec2 uRes;
uniform float uPixVis, uFocusD, uPupil, uMaxR, uRot;
uniform int uN;            // samples: fewer when the largest blur on screen is small
float cocPx(float d){ return min(0.5 * uPupil * abs(1.0/max(d, 0.05) - uFocusD) / uPixVis, uMaxR); }
void main(){
  vec2 px = gl_FragCoord.xy;
  vec4 c0 = texelFetch(uSrc, ivec2(px), 0);
  float s0 = cocPx(c0.a);
  vec3 acc = c0.rgb; float tot = 1.0;
  for (int i = 0; i < 48; i++){
    if (i >= uN) break;
    float r = uMaxR * sqrt((float(i) + 0.5) / float(uN));
    float th = float(i) * 2.39996323 + uRot;
    vec2 q = clamp(px + r * vec2(cos(th), sin(th)), vec2(0.0), uRes - 1.0);
    vec4 sm = texelFetch(uSrc, ivec2(q), 0);
    float ss = cocPx(sm.a);
    if (sm.a > c0.a) ss = min(ss, s0 * 2.0);
    float m = smoothstep(r - 0.75, r + 0.75, ss);
    acc += mix(acc / tot, sm.rgb, m); tot += 1.0;
  }
  outColor = vec4(acc / tot, c0.a);
}`;

/* Light meter, step 1: shrink the image 8x in each direction, averaging every pixel, so even a
   lamp only a pixel or two wide counts. r = mean light, g = mean log light, b = share of open sky. */

export const DOWN_FS = `${FS}${LUMA}uniform sampler2D uSrc;
uniform ivec2 uSrcSize;
void main(){
  ivec2 o = ivec2(gl_FragCoord.xy) * 8;
  float m = 0.0, lg = 0.0, sky = 0.0;
  for (int j = 0; j < 8; j++) for (int i = 0; i < 8; i++){
    vec4 c = texelFetch(uSrc, min(o + ivec2(i, j), uSrcSize - 1), 0);
    float Y = luma(c.rgb * 4.0);
    m += Y; lg += log(max(Y, 1e-4)); sky += c.a > 5000.0 ? 1.0 : 0.0;
  }
  outColor = vec4(m, lg, sky, 64.0) / 64.0;
}`;
/* Light scattered inside the eye.
   Step 1: the frame at half size (colour average of 2 x 2 pixels). */

export const GDOWN_FS = `${FS}${LUMA}${LIDS}
uniform sampler2D uSrc;
uniform ivec2 uSrcSize;
uniform float uLidU, uLidL;   // light behind the lids never enters the eye: it makes no glow, streaks or after-images
void main(){
  ivec2 o = ivec2(gl_FragCoord.xy) * 2;
  vec2 u = (gl_FragCoord.xy * 2.0) / vec2(uSrcSize);
  float xr = (u.x - 0.5) * 2.0, yr = u.y - 0.5, aU = lidA(uLidU, xr), aL = lidA(uLidL, xr);
  float open = (uLidU > 0.0 ? 1.0 - smoothstep(aU - 0.015, aU + 0.015, yr) : 1.0) * (uLidL > 0.0 ? 1.0 - smoothstep(aL - 0.015, aL + 0.015, -yr) : 1.0);
  vec3 m = texelFetch(uSrc, min(o, uSrcSize - 1), 0).rgb + texelFetch(uSrc, min(o + ivec2(1, 0), uSrcSize - 1), 0).rgb
         + texelFetch(uSrc, min(o + ivec2(0, 1), uSrcSize - 1), 0).rgb + texelFetch(uSrc, min(o + ivec2(1, 1), uSrcSize - 1), 0).rgb;
  outColor = vec4(m * 0.25 * open, 1.0);
}`;

/* Step 2: halve again and again with a smooth 13-tap filter (no blocks). */
export const BDOWN_FS = `${FS}${LUMA}uniform sampler2D uSrc;
uniform vec2 uDst;     // size of the target
void main(){
  vec2 uv = gl_FragCoord.xy / uDst, t = 1.0 / vec2(textureSize(uSrc, 0));
  vec3 a = texture(uSrc, uv + t * vec2(-2.0, 2.0)).rgb, b = texture(uSrc, uv + t * vec2(0.0, 2.0)).rgb, c = texture(uSrc, uv + t * vec2(2.0, 2.0)).rgb;
  vec3 d = texture(uSrc, uv + t * vec2(-2.0, 0.0)).rgb, e = texture(uSrc, uv).rgb, f = texture(uSrc, uv + t * vec2(2.0, 0.0)).rgb;
  vec3 g = texture(uSrc, uv + t * vec2(-2.0, -2.0)).rgb, h = texture(uSrc, uv + t * vec2(0.0, -2.0)).rgb, i = texture(uSrc, uv + t * vec2(2.0, -2.0)).rgb;
  vec3 j = texture(uSrc, uv + t * vec2(-1.0, 1.0)).rgb, k = texture(uSrc, uv + t * vec2(1.0, 1.0)).rgb;
  vec3 l = texture(uSrc, uv + t * vec2(-1.0, -1.0)).rgb, m = texture(uSrc, uv + t * vec2(1.0, -1.0)).rgb;
  outColor = vec4(e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125, 1.0);
}`;

/* Step 3: back up the chain: each level = its own blur x weight + the coarser sum, smoothly enlarged. */
export const BUP_FS = `${FS}${LUMA}uniform sampler2D uSrc;    // coarser running sum (or the coarsest level)
uniform sampler2D uBase;   // this level's blur
uniform vec2 uDst;
uniform float uW, uSrcW;   // weight of this level; weight for the source (only for the coarsest level)
void main(){
  vec2 uv = gl_FragCoord.xy / uDst, t = 1.0 / vec2(textureSize(uSrc, 0));
  vec3 s = texture(uSrc, uv).rgb * 4.0
         + (texture(uSrc, uv + vec2(t.x, 0.0)).rgb + texture(uSrc, uv - vec2(t.x, 0.0)).rgb
          + texture(uSrc, uv + vec2(0.0, t.y)).rgb + texture(uSrc, uv - vec2(0.0, t.y)).rgb) * 2.0
         + texture(uSrc, uv + t).rgb + texture(uSrc, uv - t).rgb
         + texture(uSrc, uv + vec2(t.x, -t.y)).rgb + texture(uSrc, uv + vec2(-t.x, t.y)).rgb;
  outColor = vec4(texture(uBase, uv).rgb * uW + s / 16.0 * uSrcW, 1.0);
}`;
/* Glare streaks. Light bends around straight edges and spreads at right angles to them (diffraction):
   the horizontal eyelid edges throw a vertical line (long when squinting), the eyelashes a few
   near-horizontal ones (they settle differently after each blink), and the lens fibres a faint star.
   Each line is drawn by stretching the bright light along its direction in 4 passes (steps of 1, 4, 16,
   64 pixels, 7 taps each), which gives a continuous line up to ~250 half-size pixels long. */

export const STREAK_FS = `${FS}${LUMA}${LIDS}uniform sampler2D uSrc;
uniform vec2 uDir;          // line direction (unit)
uniform float uStep, uAtt;  // tap spacing (half-size pixels); fall-off per pixel
uniform float uScale, uGain;
uniform int uFirst;         // 1 = keep only light far over white
uniform float uLid, uLidLo; // upper / lower eyelid: light behind them makes no streaks
void main(){
  vec2 sz = vec2(textureSize(uSrc, 0));
  vec3 acc = vec3(0.0);
  for (int i = -3; i <= 3; i++){
    float o = float(i) * uStep;
    vec3 c = texture(uSrc, (gl_FragCoord.xy + uDir * o) / sz).rgb;
    if (uFirst == 1){
      float Y = luma(c) * 4.0 * uScale;
      c *= max(Y - 4.0, 0.0) / max(Y, 1e-6);
      vec2 u = (gl_FragCoord.xy + uDir * o) / sz;
      float xr = (u.x - 0.5) * 2.0, yr = u.y - 0.5, aU = lidA(uLid, xr), aL = lidA(uLidLo, xr);
      c *= (1.0 - smoothstep(aU - 0.01, aU + 0.01, yr)) * (1.0 - smoothstep(aL - 0.01, aL + 0.01, -yr));
    }
    acc += c * pow(uAtt, abs(o));
  }
  outColor = vec4(acc * uGain, 1.0);
}`;
/* After-images. A low-resolution map fixed to the retina (centred on the gaze point), one cell per ~8 screen
   pixels. Intense light uses up the cone pigment in each cell, per colour: a fast store (seen for a few
   seconds) and a slow one (fills only with long exposure, lasts up to ~30 s). Without new light the map
   soon spreads into a blur. Pass 0 writes the fast store, pass 1 the slow one (a = how recently light came). */

export const AFTER_FS = `${FS}${LUMA}
uniform sampler2D uPrevF, uPrevS, uSrc;   // previous stores; half-size frame
uniform vec2 uScreen, uGazeLag, uGridC;   // screen size; delayed gaze point; centre of the map (pixels)
uniform float uOpen, uDt;
uniform float uTd;        // scene value -> retinal illuminance (trolands: cd/m2 x pupil area in mm2)
uniform int uWhich;
vec3 neighbours(sampler2D t, ivec2 c, ivec2 mx){
  return (texelFetch(t, clamp(c + ivec2(1, 0), ivec2(0), mx), 0).rgb + texelFetch(t, clamp(c - ivec2(1, 0), ivec2(0), mx), 0).rgb
        + texelFetch(t, clamp(c + ivec2(0, 1), ivec2(0), mx), 0).rgb + texelFetch(t, clamp(c - ivec2(0, 1), ivec2(0), mx), 0).rgb) * 0.25;
}
void main(){
  ivec2 cell = ivec2(gl_FragCoord.xy), mx = textureSize(uPrevF, 0) - 1;
  vec2 scr = (vec2(cell) + 0.5) * 8.0 + uGazeLag - uGridC;           // where this retina cell looks on screen
  vec3 raw = vec3(0.0);
  if (all(greaterThanEqual(scr, vec2(0.0))) && all(lessThan(scr, uScreen))) raw = texture(uSrc, scr / uScreen).rgb * uOpen;
  // Cone pigment is used up at a rate of (retinal illuminance) / Q, Q ~ 2.5 million troland-seconds
  // (63% used up). Sun: instant. Sunlit wall: ~2% a second. A lamp lens glimpsed for a moment: ~1%.
  vec3 e = raw * uTd / 2.5e6;                                        // per second, per colour
  float lit = clamp(max(e.r, max(e.g, e.b)) * 20.0, 0.0, 1.0);
  float h = max(texelFetch(uPrevS, cell, 0).a * exp(-uDt), lit);
  float diff = (1.0 - h) * min(1.0, 3.0 * uDt);                      // no new light: spread into a blur
  bool fast = uWhich == 0;
  vec3 v = fast ? mix(texelFetch(uPrevF, cell, 0).rgb, neighbours(uPrevF, cell, mx), diff)
                : mix(texelFetch(uPrevS, cell, 0).rgb, neighbours(uPrevS, cell, mx), diff);
  float rate = fast ? 1.0 : 0.3, tau = fast ? 3.0 : 30.0;
  v = clamp(v + (rate * e * (1.0 - v) - v / tau) * uDt, 0.0, 1.0);
  outColor = vec4(v, fast ? 0.0 : h);
}`;
/* Squint input: brightness across the screen (128 x 64), averaged over time at each spot, so the tiny
   frame-to-frame shifts of the rendering do not make the lids pump. */

export const SQAVG_FS = `${FS}${LUMA}uniform sampler2D uSrc, uPrev;
uniform float uLod, uK;      // mip level of the shrunk frame; blend toward the new value
void main(){
  vec2 uv = gl_FragCoord.xy / vec2(128.0, 64.0);
  float now = textureLod(uSrc, uv, uLod).r;
  outColor = vec4(mix(texelFetch(uPrev, ivec2(gl_FragCoord.xy), 0).r, now, uK), 0.0, 0.0, 1.0);
}`;
/* Light falling on the eyelids (32 x 16). Eyelid skin is a diffuser: its glow follows the illuminance from
   everything in front (each part's brightness x the solid angle it covers, / pi), the same units as the
   off-screen sun term, so nothing jumps when the sun crosses the screen edge. A gentle tilt (at most 2x)
   keeps the side facing a bright source brighter. */

export const LIDGLOW_FS = `${FS}
uniform sampler2D uSrc;   // the light meter's small image (r = brightness)
uniform float uLod;
uniform float uOmega;     // solid angle of one of the 24 x 12 samples (steradians)
uniform vec2 uScrPx;      // screen size in pixels
uniform float uPixRad;    // angle of one screen pixel at the centre (radians)
uniform float uCapL;      // brightness cap: leaves out the sun's disc
void main(){
  vec2 uv = gl_FragCoord.xy / vec2(32.0, 16.0);
  float E = 0.0, loc = 0.0, ws = 0.0;
  for (int j = 0; j < 12; j++) for (int i = 0; i < 24; i++){
    vec2 sp = (vec2(float(i), float(j)) + 0.5) / vec2(24.0, 12.0);
    float L = min(textureLod(uSrc, sp, uLod).r, uCapL);    // the sun's disc is added separately (steadily)
    // a lid facing forward catches light from the side at a slant (same as the off-screen term)
    float ang = min(length((sp - 0.5) * uScrPx) * uPixRad, 1.5708);
    E += L * uOmega * cos(ang);
    vec2 d = (sp - uv) * vec2(1.0, 0.6);
    float w = exp(-dot(d, d) / 0.12);
    loc += w * L; ws += w;
  }
  float mean = E / (uOmega * 288.0);
  float tilt = clamp(0.7 + 0.3 * (loc / ws) / max(mean, 1e-9), 0.5, 2.0);
  outColor = vec4(E / 3.14159 * tilt, 0.0, 0.0, 1.0);
}`;
/* Light meter, step 2: into a single pixel.
   r = centre-weighted log-average (what the eye adapts to), g = the same as a plain average with very
   bright spots capped, b = plain average over the whole field, nothing capped (what drives the pupil:
   it closes for a bright lamp or the sun anywhere in view), a = plain average near the centre of view,
   nothing capped: the retina at the centre of vision adapts to what it looks at, so looking at the sun
   or a lamp lowers sensitivity everywhere. */

export const METER_FS = `${FS}${LUMA}uniform sampler2D uSrc;
uniform float uLod;   // mip level whose texels cover one of the 24 x 14 sample areas
uniform float uCap;   // samples above this (a lamp lens, the sun) count as this in the plain average
uniform vec2 uGazeUV, uFovR;   // gaze point and the ~4 degree area around it, in screen units
uniform float uFovLod;
uniform sampler2D uSqMap;   // squint: brightness map averaged over time (128 x 64)
uniform float uOnScr;       // squint: scene value -> on-screen brightness (1 = white)
uniform float uCdU;         // squint: scene value -> cd/m2
uniform float uLu;          // squint: luminance the eye is adapted to (cd/m2)
uniform float uOmega;       // squint: solid angle of one map cell (steradians)
uniform vec2 uScrPx;        // squint: screen size in pixels
uniform float uPixRad;      // squint: angle of one screen pixel (radians)
uniform float uLidNow;      // squint: current upper lid
void main(){
  if (gl_FragCoord.x > 1.0){
    // Second pixel: discomfort glare as a de Boer rating (1 unbearable, 3 disturbing, 5 just acceptable,
    // 7 satisfactory, 9 just noticeable). Each light source adds its illuminance at the eye E (lux), weighted
    // down by its angle from the line of sight (arcmin^0.46) and counted more above the line of sight; the
    // eye's adaptation raises the tolerance, with a floor (0.04 cd/m2), so dark streets do not make every
    // light unbearable. Also: the lowest upper-lid opening that leaves out strong sources above.
    float S = 0.0, W = 0.0, E = 0.0;
    for (int j = 0; j < 32; j++) for (int i = 0; i < 64; i++){       // every other cell of the (smooth) map
      vec2 uv = (vec2(float(i), float(j)) * 2.0 + 1.0) / vec2(128.0, 64.0);
      float Yt = texelFetch(uSqMap, ivec2(i, j) * 2, 0).r;
      float Lcd = Yt * uCdU;
      vec2 q = uv - 0.5;
      if (Lcd > max(10.0 * uLu, 30.0)){                              // a light source, against its surroundings
        float theta = max(length(q * uScrPx) * uPixRad * 3437.7, 10.0);   // arcmin from the line of sight
        S += Lcd * uOmega / pow(theta, 0.46) * (q.y > 0.0 ? 1.0 : 0.5);
      }
      float x = max(Yt * uOnScr - 2.0, 0.0);                          // on screen, above 2x white
      if (x > 0.0 && q.y > 0.0){
        // strong light above the line of sight: a smooth weighted "lowest point" (soft minimum, no cut-off)
        float w = smoothstep(5.0, 40.0, x), xr = q.x * 2.0;
        W += w; E += w * exp(-60.0 * q.y / (1.0 - 0.35 * uLidNow * xr * xr));
      }
    }
    float rating = S > 0.0 ? 5.0 - 2.0 * log(S / (0.003 * (1.0 + sqrt(uLu / 0.04)))) / log(10.0) : 9.0;
    float best = W > 1e-4 ? -log(max(E / W, 1e-30)) / 60.0 : 1.0;
    outColor = vec4(rating, best, W, 1.0);
    return;
  }
  float s = 0.0, ws = 0.0, m = 0.0, mp = 0.0, wps = 0.0, mc = 0.0, wcs = 0.0;
  // what the centre of vision is looking at, nothing capped
  for (int j = -4; j <= 4; j++) for (int i = -4; i <= 4; i++){
    vec2 o = vec2(float(i), float(j)) / 4.0;
    if (dot(o, o) > 1.0) continue;
    vec2 uv = clamp(uGazeUV + o * uFovR, 0.0, 1.0);
    mc += textureLod(uSrc, uv, uFovLod).r; wcs += 1.0;
  }
  for (int j = 0; j < 14; j++) for (int i = 0; i < 24; i++){
    vec2 uv = (vec2(float(i), float(j)) + 0.5) / vec2(24.0, 14.0);
    vec4 c = textureLod(uSrc, uv, uLod);
    vec2 q = uv - 0.5;
    // the eye sets itself mostly by the things it looks at; open sky counts less
    float w = exp(-dot(q, q) * 6.0) * mix(1.0, 0.25, c.b);
    s += w * c.g; m += w * min(c.r, uCap); ws += w;
    float wp = exp(-dot(q, q) * 2.0);
    mp += wp * c.r; wps += wp;
  }
  outColor = vec4(s / ws, m / ws, mp / wps, mc / wcs);
}`;

/* Final screen: peripheral colour loss, rings, crosshair. */
export const PRESENT_FS = `${FS}${LUMA}${LIDS}uniform sampler2D uTex;
uniform sampler2D uGlare;   // glow: light scattered in the eye (blur sum, 1/8 size)
uniform sampler2D uStreak;  // glare streaks (half size)
uniform float uGlareK;      // share of light scattered into the glow (0 = off)
uniform float uStreakK;     // strength of the streaks (0 = off)
uniform vec3 uLensTint;     // the ageing lens absorbs some blue (1 = clear)
uniform float uFringe;      // colour fringing: red/blue shift at the screen's side edges (pixels)
uniform vec3 uAstig;        // astigmatism: direction (x, y) and how far the glow is stretched (screen units)
uniform float uLid;         // eyelids, average of the two: 0 open, 1 shut
uniform float uLidUp, uLidLow;   // upper and lower lid
uniform float uBrow;        // eyebrow: lowers in bright light (-1 = off)
uniform float uLidBright;   // eyelid brightness setting (1 = measured transmission)
uniform vec3 uLidAmb;       // light on the lids from sources off screen (sun on the face), as a white surface would show it
uniform sampler2D uLidBlur; // light falling on the lids (smooth 32 x 16 map, r = brightness)
uniform sampler2D uHalf;    // half-size frame: slight blur along the lid edges
uniform sampler2D uSq0;     // 1/8 size blur: the view through a squint
uniform sampler2D uAftF, uAftS;   // after-image stores (fixed to the retina)
uniform float uAfterK;            // strength (0 = off)
uniform vec2 uGazeLag, uAftC, uAftSize;   // delayed gaze point, map centre and size (pixels)
uniform float uBgBleach;          // share of pigment used up by the current surroundings
uniform float uAftFade;           // fading of after-images fixed on the retina (1 just after a blink)
uniform vec2 uRes, uGaze;
uniform float uPixVis, uFocusD, uIPD;
uniform int uDiploN;       // search steps (4 px each): enough for the largest double-image shift on screen
uniform float uScale;     // light level x eye adaptation x pupil: multiplies scene light before tone mapping
uniform float uCdPerUnit; // cd/m2 of one unit of scene light at the current light level
uniform int uNight;       // 1 = simulate rods and cones (eye view)
vec3 aces(vec3 x){ return clamp((x*(2.51*x + 0.03)) / (x*(2.43*x + 0.59) + 0.14), 0.0, 1.0); }
uniform int uMode, uRings, uFast, uDiplo;
uniform vec3 uEyeRing;   // centre x, y and radius in pixels of the eye-movement circle (radius 0 = hidden)
uniform vec3 uRingR;
${PROJ}
// How far (pixels) each eye's image of this surface is pulled sideways.
// The two eyes aim at the focal point; a surface at another depth lands on mismatched spots.
// Small mismatches fuse into one image (Panum's area: ~15 arcmin at the fovea, wider outward).
float eyeShift(float d, float eDeg){
  float disp = uIPD * abs(1.0/max(d, 0.05) - uFocusD);
  float fuse = radians((15.0 + 3.6*eDeg) / 60.0);
  return max(disp - fuse, 0.0) / uPixVis * 0.5;
}
// What one eye sees at px: the surface whose own shift lands it here (nearest one wins).
vec3 eyeView(vec2 px, float sgn, float eDeg){
  vec4 best = texelFetch(uTex, ivec2(px), 0);
  float bestD = eyeShift(best.a, eDeg) <= 2.0 ? best.a : 1e9;
  for (int i = 1; i <= 24; i++){
    if (i > uDiploN) break;
    float o = float(i) * 4.0;
    vec2 q = px + vec2(sgn * o, 0.0);
    if (q.x < 0.0 || q.x >= uRes.x) break;
    vec4 sm = texelFetch(uTex, ivec2(q), 0);
    if (abs(eyeShift(sm.a, eDeg) - o) <= 2.5 && sm.a < bestD){ bestD = sm.a; best = sm; }
  }
  return best.rgb;
}
void main(){
  vec2 px = gl_FragCoord.xy;
  // Eyelids: two edges, each free to cross the centre (upper edge aU above it, lower aL below it).
  // Where they overlap, both cover.
  vec2 uv0 = px / uRes;
  float xr = (uv0.x - 0.5) * 2.0, yr = uv0.y - 0.5;
  float aU = lidA(uLidUp, xr), aL = lidA(uLidLow, xr);
  float softU = 0.01 + 0.025 * uLidUp, softL = 0.01 + 0.025 * uLidLow;
  float covU = uLidUp > 0.0 ? smoothstep(aU - softU, aU + softU, yr) : 0.0;
  float covL = uLidLow > 0.0 ? smoothstep(aL - softL, aL + softL, -yr) : 0.0;
  float cover = 1.0 - (1.0 - covU) * (1.0 - covL);
  float edgeU = uLidUp > 0.0 ? exp(-pow((yr - aU) / 0.025, 2.0)) : 0.0;
  float edgeL = uLidLow > 0.0 ? exp(-pow((-yr - aL) / 0.025, 2.0)) : 0.0;
  float lidEdge = max(edgeU, edgeL);
  // the film of tears along each lid edge bends the view a little toward that edge
  vec2 pxs = px + vec2(0.0, (edgeU - edgeL) * 0.006 * uRes.y);
  float eDeg, pixDeg;
  if (uFast == 1){ pixDeg = degrees(uPixVis); eDeg = distance(px, uGaze) * pixDeg; }
  else { eDeg = degrees(acos(clamp(dot(projDir(px), projDir(uGaze)), -1.0, 1.0))); pixDeg = uRings == 1 ? degrees(pixelAngle(px)) : 1.0; }
  vec3 c = (uDiplo == 1 ? 0.5 * (eyeView(pxs, 1.0, eDeg) + eyeView(pxs, -1.0, eDeg)) : texelFetch(uTex, ivec2(pxs), 0).rgb) * 4.0;
  if (uFringe > 0.0){
    // the eye bends red and blue slightly differently: away from the centre they land a little apart
    vec2 off = (pxs - 0.5 * uRes) / (0.5 * uRes.x) * uFringe;
    vec3 base = texture(uTex, pxs / uRes).rgb;
    c.r += (texture(uTex, (pxs + off) / uRes).r - base.r) * 4.0;
    c.b += (texture(uTex, (pxs - off) / uRes).b - base.b) * 4.0;
    c = max(c, 0.0);
  }
  c *= uLensTint;
  if (uLid > 0.0){
    c = mix(c, texture(uHalf, pxs / uRes).rgb * 4.0, 0.6 * lidEdge);                       // softened edge
    // Eyelashes: a band along each lid edge that reaches further in than the lid, so the lashes from top
    // and bottom meet before the lids do. They are far too close to focus on: they smear light up and down
    // and dim it a little. Squinting adds the same vertical smear over the whole opening.
    float lash = max(smoothstep(aU - 0.03 - 0.10 * uLidUp, aU, yr), smoothstep(aL - 0.03 - 0.10 * uLidLow, aL, -yr));
    float sq = smoothstep(0.1, 0.9, uLid);
    float amt = max(lash, 0.7 * sq);
    if (amt > 0.001){
      float rad = (0.004 + 0.02 * amt) * uRes.y;                       // smear length in pixels
      vec3 vb = vec3(0.0); float ws = 0.0;
      for (int k = -6; k <= 6; k++){
        float o = float(k) / 6.0, w = exp(-o * o * 2.0);
        vb += texture(uHalf, (pxs + vec2(0.0, o * rad)) / uRes).rgb * w; ws += w;
      }
      vec3 iso = texture(uSq0, pxs / uRes).rgb;
      vec3 sm = mix(vb / ws, iso, 0.25 * sq) * 4.0;
      c = mix(c, sm, 0.85 * amt) * (1.0 - 0.25 * lash) * (1.0 - 0.45 * sq);
    }
  }
  // Light through the lids (measured: ~9% of red, 0.5% of green, 0.4% of blue gets through), lit by what
  // is in front plus the sun when it shines on the face from off screen. It then goes through the same
  // adaptation, rod/cone and tone steps as everything else: dim in shade, bright red in direct sun, and
  // black at night, when the rods (blind to red) do the seeing.
  if (cover > 0.0) c = mix(c, (vec3(texture(uLidBlur, uv0).r) + uLidAmb) * vec3(0.09, 0.005, 0.004) * uLidBright, cover);
  if (uBrow >= 0.0){
    // eyebrow: an out-of-focus dark shape along the top of the view, lower when furrowed
    float browY = 0.47 - 0.08 * uBrow + 0.05 * xr * xr;      // its lower edge, above the centre
    c *= 1.0 - 0.92 * smoothstep(browY - 0.05, browY + 0.07, uv0.y - 0.5);
  }
  if (uGlareK > 0.0 || uStreakK > 0.0){
    // Light scattered in the eye's lens, cornea and fluid: a small share of all light spreads into a glow
    // around where it came from (taken from the source, so the total stays the same), and very bright
    // sources also throw thin streaks.
    vec2 uv = uv0;
    float stk = mix(1.0, 1.0 - cover, smoothstep(0.4, 0.8, uLid));   // nearly shut: streaks stop at the lids
    vec3 gl = texture(uGlare, uv).rgb;
    if (uAstig.z > 0.0){
      // astigmatism stretches the glow along one direction
      gl = vec3(0.0);
      for (int k = -3; k <= 3; k++) gl += texture(uGlare, uv + uAstig.xy * uAstig.z * float(k) / 3.0).rgb * (1.0 - abs(float(k)) / 4.0);
      gl /= 4.0;
    }
    c = c * (1.0 - uGlareK) + (uGlareK * gl + uStreakK * texture(uStreak, uv).rgb * stk) * 4.0;
  }
  vec3 aftB = vec3(0.0);
  if (uAfterK > 0.0){
    vec2 ur = (px - uGazeLag + uAftC) / uAftSize;
    if (all(greaterThanEqual(ur, vec2(0.0))) && all(lessThanEqual(ur, vec2(1.0)))){
      vec4 F = texture(uAftF, ur), S = texture(uAftS, ur);
      // in bright light much of the pigment is used up everywhere already, so the spot stands out less;
      // and an image fixed on the retina fades from awareness within seconds, returning after a blink
      float vis = (1.0 - uBgBleach) * uAftFade;
      aftB = clamp((F.rgb + S.rgb) * vis * uAfterK, 0.0, 1.0);
      // 1. used-up pigment: a little less sensitive to that colour (the gain downstream mostly makes up for
      //    it, so half the pigment gone is only a slight shift)
      c *= 1.0 - 0.3 * aftB;
      // 2. used-up pigment also signals weakly, like a faint light (~0.5 cd/m2 when fully used up), in the
      //    opposite colour: invisible in daylight, a glow in the dark or with the eyes shut
      float mB = max(aftB.r, max(aftB.g, aftB.b));
      vec3 comp = (vec3(mB) - aftB) + 0.3 * mB * vec3(0.45, 0.7, 1.0);
      c += comp * 0.5 / max(uCdPerUnit, 1e-9);
    }
  }
  if (uMode != 2){
    vec3 lin = c;
    c = lin * uScale;
    if (uNight == 1){
      // Cones (colour) need light; below a few cd/m2 the rods (no colour, most sensitive to
      // blue-green) take over. Mixed between ~0.005 and ~5 cd/m2 of real luminance.
      float Y = luma(lin) * uCdPerUnit;
      float cone = smoothstep(-2.3, 0.7, log(max(Y, 1e-9)) / log(10.0));
      float rod = dot(c, vec3(0.05, 0.45, 0.50));
      c = mix(rod * vec3(0.82, 0.93, 1.15), c, cone);
      c = mix(c, vec3(luma(c)), 0.18 * smoothstep(12.0, 60.0, eDeg));   // slightly less saturated off-centre
    }
    // Tone mapping on brightness, keeping the colour: an orange lamp pool stays orange however bright.
    // Only light far over the top of the range fades toward white.
    float Yt = luma(c);
    if (Yt > 1e-6){
      vec3 cl = c * (aces(vec3(Yt)).x / Yt);
      float mx = max(cl.r, max(cl.g, cl.b));
      // (light through the lids only gets redder-brighter, never whiter)
      if (mx > 1.0) cl = mix(cl / mx, vec3(1.0), clamp((mx - 1.0) / mx, 0.0, 1.0) * (1.0 - cover));
      c = cl;
    } else c = vec3(0.0);
  }
  c = pow(max(c, 0.0), vec3(1.0/2.2));
  if (uRings == 1){
    float ring = 0.0;
    for (int i = 0; i < 3; i++){
      float r = i == 0 ? uRingR.x : (i == 1 ? uRingR.y : uRingR.z);
      ring = max(ring, 1.0 - smoothstep(0.0, 1.5, abs(eDeg - r) / pixDeg));
    }
    c = mix(c, vec3(0.94, 0.70, 0.36), ring * 0.8);
  }
  if (uEyeRing.z > 0.0){
    float rr = abs(distance(px, uEyeRing.xy) - uEyeRing.z);
    c = mix(c, vec3(0.96, 0.94, 0.88), (1.0 - smoothstep(0.0, 1.2, rr)) * 0.11);
  }
  vec2 d = abs(px - uGaze);
  float arm = step(d.x, 1.0) * step(4.0, d.y) * step(d.y, 11.0) + step(d.y, 1.0) * step(4.0, d.x) * step(d.x, 11.0);
  float halo = step(d.x, 2.5) * step(2.5, d.y) * step(d.y, 12.5) + step(d.y, 2.5) * step(2.5, d.x) * step(d.x, 12.5);
  c = mix(c, vec3(0.0), clamp(halo, 0.0, 1.0) * 0.55);
  c = mix(c, vec3(0.96, 0.94, 0.88), clamp(arm, 0.0, 1.0));
  outColor = vec4(c, 1.0);
}`;
