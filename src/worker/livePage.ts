/** The /live page: one card per worker (current step, timeline, live screenshot). */
export function livePageHtml(token: string): string {
  const t = JSON.stringify(token);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>CRDB Disburser — Live</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body{font-family:system-ui,Arial,sans-serif;margin:0;background:#0f3d2e;color:#eafff5}
  header{background:#0a2e22;padding:12px 18px;font-size:18px;font-weight:600;display:flex;justify-content:space-between}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:16px;padding:16px}
  .worker{background:#13503b;border-radius:10px;padding:14px}
  .wid{font-size:15px;font-weight:700;color:#bfffe0}
  .dot{height:9px;width:9px;border-radius:50%;display:inline-block;margin-right:6px}
  .step{font-size:18px;font-weight:700;margin:8px 0;color:#eafff5}
  .muted{color:#9fd9c2;font-size:12px}
  img{width:100%;border:2px solid #1e6e52;border-radius:8px;background:#fff;margin-top:8px}
  ul{list-style:none;padding:0;margin:8px 0 0;max-height:200px;overflow:auto}
  li{padding:4px 6px;border-bottom:1px solid #1e6e52;font-size:13px}
  li time{color:#9fd9c2;font-size:11px;margin-right:6px}
  .empty{padding:24px;color:#9fd9c2}
</style></head>
<body>
<header><span>🟢 CRDB Disburser — Live</span><span class="muted" id="clock"></span></header>
<div class="grid" id="grid"><div class="empty">Loading workers…</div></div>
<script>
const token=${t};
const qs='?token='+encodeURIComponent(token);
function fresh(ts){return (Date.now()-ts) < 90000;} // green if seen in last 90s
async function tick(){
  document.getElementById('clock').textContent=new Date().toLocaleTimeString();
  try{
    const r=await fetch('/internal/worker/status'+qs);
    const d=await r.json();
    const ws=d.workers||[];
    if(!ws.length){document.getElementById('grid').innerHTML='<div class="empty">No workers have reported yet. Waiting…</div>';return;}
    document.getElementById('grid').innerHTML=ws.map(w=>{
      const s=w.status||{};
      const live=fresh(s.ts||0);
      const steps=(w.steps||[]).slice(0,15).map(x=>'<li><time>'+new Date(x.ts).toLocaleTimeString()+'</time>'+x.step+'</li>').join('');
      // Only load a screenshot if one actually exists (avoids 404 flicker while idle).
      const img = w.hasShot
        ? '<img src="/internal/worker/shot?worker='+encodeURIComponent(w.id)+'&token='+encodeURIComponent(token)+'&_='+Math.floor(Date.now()/2500)+'">'
        : '<div class="muted" style="padding:10px 0">no screenshot (idle — shots appear during a cycle)</div>';
      return '<div class="worker">'
        +'<div class="wid"><span class="dot" style="background:'+(live?'#46e08a':'#888')+'"></span>'+w.id+'</div>'
        +'<div class="step">'+(s.step||'—')+'</div>'
        +'<div class="muted">'+(s.ts?new Date(s.ts).toLocaleString():'')+(live?'  · live':'  · idle')+'</div>'
        +img
        +'<ul>'+steps+'</ul>'
        +'</div>';
    }).join('');
  }catch(e){}
}
tick(); setInterval(tick,2500);
</script>
</body></html>`;
}
