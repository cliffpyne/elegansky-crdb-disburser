/** The /live page: shows the worker's current step, timeline, and live screenshot. */
export function livePageHtml(token: string): string {
  const t = JSON.stringify(token);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>CRDB Disburser — Live</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body{font-family:system-ui,Arial,sans-serif;margin:0;background:#0f3d2e;color:#eafff5}
  header{background:#0a2e22;padding:12px 18px;font-size:18px;font-weight:600}
  .wrap{display:flex;flex-wrap:wrap;gap:16px;padding:16px}
  .col{flex:1;min-width:320px}
  .card{background:#13503b;border-radius:10px;padding:14px;margin-bottom:14px}
  .step{font-size:20px;font-weight:700;color:#bfffe0}
  .muted{color:#9fd9c2;font-size:13px}
  img{width:100%;border:2px solid #1e6e52;border-radius:8px;background:#fff}
  ul{list-style:none;padding:0;margin:0;max-height:60vh;overflow:auto}
  li{padding:6px 8px;border-bottom:1px solid #1e6e52;font-size:14px}
  li time{color:#9fd9c2;font-size:12px;margin-right:8px}
</style></head>
<body>
<header>🟢 CRDB Disburser — Live View</header>
<div class="wrap">
  <div class="col">
    <div class="card"><div class="muted">Current step</div><div class="step" id="step">…</div>
      <div class="muted" id="meta"></div></div>
    <div class="card"><div class="muted">Step timeline (newest first)</div><ul id="steps"></ul></div>
  </div>
  <div class="col">
    <div class="card"><div class="muted">Live screenshot</div><img id="shot" alt="waiting for screenshot…"></div>
  </div>
</div>
<script>
const token=${t};
const q=(p)=>p+'?token='+encodeURIComponent(token);
async function tick(){
  try{
    const r=await fetch('/internal/worker/status'+'?token='+encodeURIComponent(token));
    const d=await r.json();
    const s=d.status;
    document.getElementById('step').textContent=s?s.step:'(idle — no recent activity)';
    document.getElementById('meta').textContent=s?('worker: '+(s.worker||'?')+'  ·  '+new Date(s.ts).toLocaleString()):'';
    document.getElementById('steps').innerHTML=(d.steps||[]).map(x=>'<li><time>'+new Date(x.ts).toLocaleTimeString()+'</time>'+x.step+'</li>').join('');
  }catch(e){}
  // refresh screenshot with cache-buster
  document.getElementById('shot').src='/internal/worker/shot?token='+encodeURIComponent(token)+'&_='+Date.now();
}
tick(); setInterval(tick,2500);
</script>
</body></html>`;
}
