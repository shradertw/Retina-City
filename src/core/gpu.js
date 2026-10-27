/* Shader programs, compiled all at once.
   Every program's compile and link is started before any result is asked for, so the browser can work on
   them in parallel (KHR_parallel_shader_compile) while the page does other work (the city plan). Asking
   for a result too early would make the page wait for that one shader. */
// opts.serial: compile one program at a time and report each one's time through opts.onEach(name, ms),
// to find which shader is slow (slower overall).
export async function compilePrograms(gl, vsSource, sources, whileCompiling, opts = {}){
  const ext = gl.getExtension('KHR_parallel_shader_compile');
  const wait = async (p) => { if (ext) while (!gl.getProgramParameter(p, ext.COMPLETION_STATUS_KHR)) await new Promise((r) => setTimeout(r, 8)); else gl.getProgramParameter(p, gl.LINK_STATUS); };
  const vs = gl.createShader(gl.VERTEX_SHADER); gl.shaderSource(vs, vsSource); gl.compileShader(vs);
  const jobs = [];
  for (const [name, fsSource] of Object.entries(sources)){
    const fs = gl.createShader(gl.FRAGMENT_SHADER); gl.shaderSource(fs, fsSource); gl.compileShader(fs);
    const p = gl.createProgram(); gl.attachShader(p, vs); gl.attachShader(p, fs);
    gl.bindAttribLocation(p, 0, 'aPos');
    const t = performance.now(); gl.linkProgram(p);
    if (opts.serial){ await wait(p); opts.onEach && opts.onEach(name, performance.now() - t); }
    jobs.push({ name, p, fs });
  }
  if (whileCompiling) whileCompiling();
  if (ext){
    const done = (j) => gl.getProgramParameter(j.p, ext.COMPLETION_STATUS_KHR);
    while (!jobs.every(done)) await new Promise((r) => setTimeout(r, 8));
  }
  const out = {};
  for (const j of jobs){
    if (!gl.getProgramParameter(j.p, gl.LINK_STATUS)){
      const log = gl.getShaderInfoLog(j.fs) || gl.getShaderInfoLog(vs) || gl.getProgramInfoLog(j.p);
      throw new Error(j.name + ': ' + log);
    }
    const u = {}, n = gl.getProgramParameter(j.p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++){ const info = gl.getActiveUniform(j.p, i); u[info.name] = gl.getUniformLocation(j.p, info.name); }
    out[j.name] = { p: j.p, u };
  }
  return out;
}
// Resolves after the browser has had a chance to draw (so a progress message shows before heavy work).
export const nextPaint = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
