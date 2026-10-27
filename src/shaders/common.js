/* Shader pieces shared by several programs. */
/* ---------------- Shaders ---------------- */
export const VS = `#version 300 es
in vec2 aPos; void main(){ gl_Position = vec4(aPos,0.0,1.0); }`;

/* Shared shader pieces. */
export const FS = `#version 300 es
precision highp float;
out vec4 outColor;
`;

export const LUMA = `
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);    // brightness weights of red, green, blue
float luma(vec3 c){ return dot(c, LUMA); }
`;

// Eyelid shape (also in lidA() in JS): height of a lid's edge from the screen centre (screen units, toward
// its own side; negative = past the centre), for lid closure L (0 open, 1 shut) at horizontal position
// xr (-1..1). The opening narrows toward the corners as the lids close; shut lids overlap.
export const LIDS = `
float lidA(float L, float xr){ return (1.0 - L) * 0.62 * (1.0 - 0.35 * L * xr * xr) - 0.06 * L; }
`;

export const PROJ = `
uniform float uXmax;   // half-width of the projection plane (after zoom)
uniform float uPanini; // Panini strength d (0 = rectilinear)
// Screen pixel -> view-space ray. General Panini (Sharpless) inverse; d = 0 is a normal perspective camera.
vec3 projDir(vec2 px){
  vec2 q = (px - 0.5*uRes) / (0.5*uRes.x) * uXmax;
  if (uPanini <= 0.0) return normalize(vec3(q, 1.0));
  float d = uPanini;
  float k = q.x*q.x / ((d + 1.0)*(d + 1.0));
  float dscr = k*k*d*d - (k + 1.0)*(k*d*d - 1.0);
  float clon = (-k*d + sqrt(max(dscr, 0.0))) / (k + 1.0);
  float S = (d + 1.0) / max(d + clon, 1e-4);
  float lon = atan(q.x, S*clon);
  float lat = atan(q.y, S);
  return vec3(cos(lat)*sin(lon), sin(lat), cos(lat)*cos(lon));
}
// angle covered by one screen pixel at this spot (varies across a Panini image)
float pixelAngle(vec2 px){
  vec3 a = projDir(px);
  return max(length(projDir(px + vec2(1.0, 0.0)) - a), length(projDir(px + vec2(0.0, 1.0)) - a));
}`;

/* Cell size, with focus. Needs uRes, uFov, uBase, uMult, uA, uR2, uPixVis declared first. */
export const CELLFN = `
uniform float uFocusD, uPupil;   // focal distance in diopters (1/m), pupil diameter in metres
uniform int uDof, uDofCells, uHavePrev;
uniform sampler2D uPrevDepth;    // last frame's distances: cells are sized before their rays are cast
// Blur from focus, as an angle: pupil diameter x |1/distance - 1/focal distance|
float defocusAng(float d){ return uDof == 1 ? uPupil * abs(1.0/max(d, 0.05) - uFocusD) : 0.0; }
float prevDepthAt(vec2 q){
  return uHavePrev == 1 ? texelFetch(uPrevDepth, ivec2(clamp(q, vec2(0.0), uRes - 1.0)), 0).a : 1.0/max(uFocusD, 1e-4);
}
// Cell size in screen pixels at r pixels from the gaze point, for a surface d metres away
float cellPx(float r, float d){
  if (uFov == 0) return uBase;
  float rec = uMult*uA*(1.0 + r/uR2);
  float df = uDofCells == 1 ? defocusAng(d) / uPixVis : 0.0;
  return max(uBase, sqrt(rec*rec + df*df));
}`;
