export function renderUi(): Response {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Agent JSX Parse PM</title>
  <style>
    :root{color-scheme:dark;--ink:#f5f1e8;--muted:#a9a59d;--panel:#191a1d;--line:#303238;--gold:#e6b85c;--green:#9fce7d;--red:#ff9f91}
    *{box-sizing:border-box}body{margin:0;background:#101114;color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,sans-serif}
    main{width:min(1060px,calc(100% - 32px));margin:32px auto;display:grid;grid-template-columns:minmax(300px,1fr) minmax(280px,360px);gap:26px}
    h1{font:600 clamp(26px,4vw,44px)/1.08 ui-serif,Georgia,serif;margin:0 0 8px}.eyebrow{color:var(--gold);letter-spacing:.16em;text-transform:uppercase;font-size:11px}
    .sub{color:var(--muted);margin:0 0 18px}
    aside{background:var(--panel);border:1px solid var(--line);padding:18px;align-self:start}
    label{display:block;color:var(--muted);font-size:12px;margin-top:12px}
    input{width:100%;font:inherit;border:1px solid #41444c;border-radius:7px;background:#23252a;color:var(--ink);padding:9px 11px}
    .row{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0 0}
    button{font:inherit;border:1px solid #41444c;border-radius:7px;background:#23252a;color:var(--ink);padding:9px 12px;cursor:pointer}
    button.primary{background:var(--gold);color:#17130a;border-color:var(--gold);font-weight:700}
    .error{color:var(--red);white-space:pre-wrap;margin-top:10px}
    .plan{display:flex;gap:6px;flex-wrap:wrap;margin:14px 0}
    .phase{border:1px solid var(--line);border-radius:999px;padding:5px 12px;color:var(--muted);font-size:13px}
    .phase.active{border-color:var(--gold);color:var(--gold);font-weight:700}
    .stat{border-top:1px solid var(--line);padding:10px 0;font-size:14px}
    .bar{height:8px;border-radius:4px;background:#23252a;overflow:hidden;margin-top:6px}.bar div{height:100%;background:var(--gold)}
    .seg{border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:10px 0;background:#17181b}
    .seg .id{color:var(--gold);font-size:12px}.seg .label{color:var(--green);font-size:12px;margin-left:8px}.seg p{margin:6px 0 0;color:#d7d3ca;font-size:13px}
    .log{margin-top:14px;border-top:1px solid var(--line);padding-top:10px;max-height:200px;overflow:auto;font:12px/1.6 ui-monospace,monospace;color:var(--muted);white-space:pre-wrap}
    .log .applied{color:var(--green)}.log .refused{color:var(--red)}
    pre.cp{background:#17181b;border:1px solid var(--line);border-radius:8px;padding:10px;font:12px/1.5 ui-monospace,monospace;color:#cfc9bd;overflow:auto}
    @media(max-width:820px){main{grid-template-columns:1fr}}
  </style>
</head>
<body><main>
  <section>
    <div class="eyebrow">Agent JSX · Goal Layer · cloudflare agents</div>
    <h1>A project manager for a parse job.</h1>
    <p class="sub">The plan is a goal machine; the budget is the PM's checkbook; children get attenuated region grants; every metered call is preceded by a durable checkpoint. Pause on exhaustion, top up, resume without rework.</p>
    <div id="plan" class="plan"></div>
    <div id="stats"></div>
    <pre id="cp" class="cp">no checkpoint yet</pre>
    <div id="segments"></div>
    <div id="log" class="log"></div>
  </section>
  <aside>
    <label for="token">Demo access token</label><input id="token" type="password" autocomplete="off">
    <label for="job">Job id</label><input id="job" value="demo" maxlength="64">
    <label for="budget">Budget (USD)</label><input id="budget" value="0.05">
    <label for="amount">Top-up (USD)</label><input id="amount" value="0.025">
    <div class="row">
      <button id="run" class="primary">Run</button>
      <button id="status">Status</button>
      <button id="topup">Top up</button>
      <button id="resume">Resume</button>
    </div>
    <div id="error" class="error" role="alert"></div>
  </aside>
</main>
<script nonce="${nonce}">
const $=(id)=>document.getElementById(id);
$('token').value=sessionStorage.getItem('parse-pm-token')||'';
const PLAN=['ingest','layout','extract','paused','assemble','verify','done'];
function paint(s){
  $('plan').innerHTML=PLAN.map(p=>'<span class="phase'+(p===s.phase?' active':'')+'">'+p+'</span>').join('');
  const pct=s.budgetUsd>0?Math.min(100,Math.round(100*s.spentUsd/s.budgetUsd)):0;
  $('stats').innerHTML='<div class="stat">spent $'+s.spentUsd.toFixed(4)+' of $'+s.budgetUsd.toFixed(4)+' · '+s.callCount+' metered calls · '+s.ledger.length+' ledger entries<div class="bar"><div style="width:'+pct+'%"></div></div></div>'+(s.refusals.length?'<div class="stat" style="color:var(--red)">refused at '+s.refusals[s.refusals.length-1].regionId+' — top up to resume</div>':'');
  $('cp').textContent=s.checkpoint?JSON.stringify({seq:s.checkpoint.seq,reason:s.checkpoint.reason,regionId:s.checkpoint.regionId,completedRegions:s.checkpoint.completedRegions,spentUsd:s.checkpoint.spentUsd,callCount:s.checkpoint.callCount},null,1):'no checkpoint yet';
  $('segments').innerHTML=(s.segments||[]).map(seg=>'<div class="seg"><span class="id">'+seg.id+'</span><span class="label">'+seg.label+'</span><p>'+seg.text.slice(0,180)+'…</p></div>').join('')||'<p class="sub">no segments yet</p>';
  $('log').innerHTML=(s.log||[]).map(e=>'<div class="'+(e.changed?'applied':'refused')+'">'+(e.changed?(e.source.phase+'['+(e.source.child||'-')+'] '+e.outcome+' ▶ '+e.to+' ($'+e.spentUsd.toFixed(3)+')'):(e.source.phase+'['+(e.source.child||'-')+'] '+e.outcome+' ⊘ '+(e.ignored||'ignored')))+'</div>').join('');
  $('log').scrollTop=$('log').scrollHeight;
}
async function api(action,method,body){
  sessionStorage.setItem('parse-pm-token',$('token').value);$('error').textContent='';
  const headers={'content-type':'application/json'};if($('token').value)headers.authorization='Bearer '+$('token').value;
  const res=await fetch('/api/parse/'+encodeURIComponent($('job').value||'demo')+'/'+action,{method,headers,body:body?JSON.stringify(body):undefined});
  const json=await res.json();if(!res.ok)throw new Error(json.error||('HTTP '+res.status));return json;
}
const go=(action,method,body)=>()=>api(action,method,body&&body()).then(paint).catch(e=>{$('error').textContent=e.message});
$('run').onclick=go('run','POST',()=>({budgetUsd:Number($('budget').value)||0.05}));
$('status').onclick=go('status','GET');
$('topup').onclick=go('topup','POST',()=>({amountUsd:Number($('amount').value)||0.025}));
$('resume').onclick=go('resume','POST');
</script></body></html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  });
}
