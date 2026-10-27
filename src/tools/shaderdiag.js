/* Compile-time diagnostic: compiles the scene shader once per variant, each with some features switched
   off, one after another, and lists the times. Each source gets a unique comment so the browser's shader
   cache cannot skip the work. */
import { VS } from '../shaders/common.js';
import { SCENE_FS } from '../shaders/scene.js';

const VARIANTS = [
  ['Everything', []],
  ['Without reflections', ['NO_REFL']],
  ['Without doors', ['NO_DOORS']],
  ['Without street-light glow', ['NO_SPRITES']],
  ['Without sun shadows', ['NO_SHADOW']],
  ['Without surface materials', ['NO_MATERIALS']],
  ['Without street-light lighting', ['NO_LAMPLIGHT']],
  ['Without stars, moon, clouds', ['NO_SKYDETAIL']],
  ['All of the above off', ['NO_REFL', 'NO_DOORS', 'NO_SPRITES', 'NO_SHADOW', 'NO_MATERIALS', 'NO_LAMPLIGHT', 'NO_SKYDETAIL']],
];
const out = document.getElementById('out');
const line = (t) => { out.textContent += t + '\n'; };
const paint = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

async function run(){
  const gl = document.createElement('canvas').getContext('webgl2');
  if (!gl){ line('WebGL2 is not available.'); return; }
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  line('Browser: ' + navigator.userAgent);
  line('Renderer: ' + (dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)));
  const ext = gl.getExtension('KHR_parallel_shader_compile');
  line('Parallel compile extension: ' + (ext ? 'yes' : 'no'));
  line('');
  const vs = gl.createShader(gl.VERTEX_SHADER); gl.shaderSource(vs, VS); gl.compileShader(vs);
  const rows = [];
  for (const [name, flags] of VARIANTS){
    line(name.padEnd(32, ' ') + 'compiling…'); await paint();
    const defs = flags.map((f) => '#define ' + f).join('\n');
    const src = SCENE_FS.replace('#version 300 es', '#version 300 es\n' + defs + '\n// run ' + Date.now() + ' ' + Math.random());
    const t0 = performance.now();
    const fs = gl.createShader(gl.FRAGMENT_SHADER); gl.shaderSource(fs, src); gl.compileShader(fs);
    const p = gl.createProgram(); gl.attachShader(p, vs); gl.attachShader(p, fs); gl.bindAttribLocation(p, 0, 'aPos'); gl.linkProgram(p);
    if (ext) while (!gl.getProgramParameter(p, ext.COMPLETION_STATUS_KHR)) await new Promise((r) => setTimeout(r, 20));
    const ok = gl.getProgramParameter(p, gl.LINK_STATUS);
    const ms = performance.now() - t0;
    rows.push([name, ms]);
    out.textContent = out.textContent.replace(name.padEnd(32, ' ') + 'compiling…', name.padEnd(32, ' ') + (ms / 1000).toFixed(1) + ' s' + (ok ? '' : '  FAILED: ' + (gl.getShaderInfoLog(fs) || gl.getProgramInfoLog(p)).slice(0, 200)));
    gl.deleteProgram(p); gl.deleteShader(fs);
    await paint();
  }
  line('');
  line('Done. A screenshot of this page is all I need.');
  window.__diag = rows;
}
run();
