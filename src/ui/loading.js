/* Loading progress on the start card: each stage and how long it took. Kept on the card after loading
   (and in window.__loadTimes and the console) so slow stages on a given machine are easy to spot.
   onReady is called once the shaders and the old city are ready (the start panel shows the title). */
export function loadReport(hooks = {}){
  const list = document.getElementById('loadList'), title = document.getElementById('startTitle');
  const rows = new Map();
  const show = () => { list.textContent = [...rows].map(([k, v]) => k.padEnd(24, ' ') + v).join('\n'); };
  return {
    set(name, ms){ rows.set(name, typeof ms === 'number' ? (ms / 1000).toFixed(2) + ' s' : ms); show(); },
    ready(){
      if (hooks.onReady) hooks.onReady();
      window.__loadTimes = Object.fromEntries(rows);
      console.table(window.__loadTimes);
    },
    fail(){ title.textContent = 'Could not start'; },
  };
}
