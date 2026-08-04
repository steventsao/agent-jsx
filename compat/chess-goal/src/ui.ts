export function renderUi(): Response {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Agent JSX Chess Goal</title>
  <style>
    :root{color-scheme:dark;--ink:#f5f1e8;--muted:#a9a59d;--panel:#191a1d;--line:#303238;--gold:#e6b85c}
    *{box-sizing:border-box}body{margin:0;background:#101114;color:var(--ink);font:15px/1.45 ui-sans-serif,system-ui,sans-serif}
    main{width:min(1100px,calc(100% - 32px));margin:32px auto;display:grid;grid-template-columns:minmax(320px,680px) minmax(260px,1fr);gap:28px}
    h1{font:600 clamp(28px,4vw,50px)/1.05 ui-serif,Georgia,serif;margin:0 0 8px}.eyebrow{color:var(--gold);letter-spacing:.16em;text-transform:uppercase;font-size:11px}
    .sub{color:var(--muted);margin:0 0 22px}.board{aspect-ratio:1;display:grid;grid-template-columns:repeat(8,1fr);border:1px solid #4a4d55;box-shadow:0 24px 70px #0008}
    .square{display:grid;place-items:center;font-size:clamp(28px,6.2vw,62px);user-select:none}.light{background:#d8c7a5;color:#111}.dark{background:#6e7859;color:#111}.last{box-shadow:inset 0 0 0 4px #e6b85caa}
    aside{background:var(--panel);border:1px solid var(--line);padding:20px;align-self:start}.row{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0}
    button,input{font:inherit;border:1px solid #41444c;border-radius:7px;background:#23252a;color:var(--ink);padding:10px 12px}button{cursor:pointer}button.primary{background:var(--gold);color:#17130a;border-color:var(--gold);font-weight:700}button:disabled{opacity:.45;cursor:not-allowed}
    input{width:100%}label{display:block;color:var(--muted);font-size:12px;margin-top:14px}.status{border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:14px 0;margin:16px 0}.agent{font-weight:700}.error{color:#ff9f91;white-space:pre-wrap}
    .phase{color:var(--gold);font-size:12px;letter-spacing:.08em;text-transform:uppercase}
    ol{list-style:none;padding:0;max-height:320px;overflow:auto;display:grid;gap:12px}li{color:#d7d3ca;display:grid;gap:5px}.move-meta{color:var(--muted);font-size:12px}.thought{position:relative;border:1px solid #41444c;border-radius:16px;padding:10px 12px;background:#24262c;color:#f0ece2}.white .thought{margin-right:24px;border-bottom-left-radius:5px}.black .thought{margin-left:24px;border-bottom-right-radius:5px;background:#302b22;border-color:#5c4d31}.thinking{color:var(--gold);font-style:italic}
    .log{margin-top:16px;border-top:1px solid var(--line);padding-top:10px;max-height:180px;overflow:auto;font:12px/1.6 ui-monospace,monospace;color:var(--muted);white-space:pre-wrap}
    .log .applied{color:#cfe3b8}.log .refused{color:#ff9f91}
    @media(max-width:800px){main{grid-template-columns:1fr;margin-top:20px}.square{font-size:clamp(30px,10vw,58px)}}
  </style>
</head>
<body><main>
  <section><div class="eyebrow">Agent JSX · Goal Layer · Cloudflare Think</div><h1>Two models. Three phases.</h1><p class="sub">A goal machine — white ⇄ black, both ended → over — decides which model seat is mounted. Every hand-over is an attributed transition; chess.js refuses illegal moves and the same phase re-prompts the seat with the refusal.</p><div id="board" class="board" aria-label="Chess board"></div></section>
  <aside>
    <div id="status" class="status">Enter the demo token, then load a game.</div>
    <label for="token">Demo access token</label><input id="token" type="password" autocomplete="off" placeholder="Worker access token">
    <label for="game">Game id</label><input id="game" value="demo" maxlength="64">
    <div class="row"><button id="load">Load</button><button id="step" class="primary">Play one move</button><button id="auto">Auto play</button><button id="reset">Reset</button></div>
    <div id="error" class="error" role="alert"></div><ol id="moves"></ol>
    <div id="log" class="log"></div>
  </aside>
</main>
<script nonce="${nonce}">
const pieces={p:'♟',r:'♜',n:'♞',b:'♝',q:'♛',k:'♚',P:'♙',R:'♖',N:'♘',B:'♗',Q:'♕',K:'♔'};
const board=document.querySelector('#board'),statusEl=document.querySelector('#status'),movesEl=document.querySelector('#moves'),logEl=document.querySelector('#log'),errorEl=document.querySelector('#error'),tokenEl=document.querySelector('#token'),gameEl=document.querySelector('#game'),stepEl=document.querySelector('#step'),autoEl=document.querySelector('#auto');
tokenEl.value=sessionStorage.getItem('chess-goal-demo-token')||'';let current=null,auto=false;
function squares(fen){const out=[];for(const row of fen.split(' ')[0].split('/'))for(const c of row){if(/\\d/.test(c))for(let i=0;i<Number(c);i++)out.push('');else out.push(c)}return out}
function paint(state){current=state;board.innerHTML='';const last=state.history.at(-1)?.uci||'';squares(state.fen).forEach((p,i)=>{const file='abcdefgh'[i%8],rank=8-Math.floor(i/8),sq=file+rank,el=document.createElement('div');el.className='square '+((Math.floor(i/8)+i)%2?'dark':'light')+(last.includes(sq)?' last':'');el.textContent=pieces[p]||'';el.setAttribute('aria-label',sq+(p?' '+p:''));board.append(el)});const phase=state.goal?.phase||'?';const side=phase==='black'?'Gemini · black':phase==='white'?'OpenAI · white':'match over';statusEl.innerHTML='<div class="phase">goal phase: '+phase+'</div><div class="agent">'+side+'</div><div>'+state.status+' · '+state.history.length+' plies · cap '+state.maxPlies+'</div>'+(state.lastError?'<div class="error">domain refused: '+state.lastError.slice(0,140)+'</div>':'');movesEl.innerHTML='';state.history.forEach((m,i)=>{const li=document.createElement('li');li.className=m.side;const meta=document.createElement('div');meta.className='move-meta';meta.textContent=(i+1)+'. '+m.side+' '+m.san+' ('+m.uci+')';const thought=document.createElement('div');thought.className='thought';thought.textContent=m.thought||m.note||'Move selected.';li.append(meta,thought);movesEl.append(li)});movesEl.scrollTop=movesEl.scrollHeight;logEl.innerHTML='';(state.log||[]).forEach(e=>{const line=document.createElement('div');line.className=e.changed?'applied':'refused';line.textContent=e.changed?(e.source.phase+'['+(e.source.child||'-')+'] '+e.outcome+' ▶ '+e.to+(e.san?' ('+e.san+')':'')):(e.source.phase+'['+(e.source.child||'-')+'] '+e.outcome+' ⊘ '+(e.ignored||'ignored'));logEl.append(line)});logEl.scrollTop=logEl.scrollHeight;stepEl.disabled=!['playing','check'].includes(state.status);if(stepEl.disabled)stopAuto()}
async function api(action,method='GET',body){sessionStorage.setItem('chess-goal-demo-token',tokenEl.value);errorEl.textContent='';const game=encodeURIComponent(gameEl.value||'demo');const headers={'content-type':'application/json'};if(tokenEl.value)headers.authorization='Bearer '+tokenEl.value;const res=await fetch('/api/games/'+game+'/'+action,{method,headers,body:body?JSON.stringify(body):undefined});const json=await res.json();if(!res.ok)throw new Error(json.error||('HTTP '+res.status));return json}
async function load(){try{paint((await api('state')).state)}catch(e){errorEl.textContent=e.message}}
async function step(){stepEl.disabled=true;const phase=current?.goal?.phase;const who=phase==='black'?'Gemini':'OpenAI';statusEl.innerHTML='<div class="agent">'+who+'</div><div class="thinking">thinking through the position…</div>';try{paint((await api('step','POST')).state)}catch(e){errorEl.textContent=e.message;if(current)paint(current)}finally{if(current&&['playing','check'].includes(current.status))stepEl.disabled=false}}
function stopAuto(){auto=false;autoEl.textContent='Auto play'}async function toggleAuto(){auto=!auto;autoEl.textContent=auto?'Stop':'Auto play';while(auto&&current&&['playing','check'].includes(current.status)){await step();if(errorEl.textContent)stopAuto();await new Promise(r=>setTimeout(r,450))}}
document.querySelector('#load').onclick=load;stepEl.onclick=step;autoEl.onclick=toggleAuto;document.querySelector('#reset').onclick=async()=>{stopAuto();try{paint((await api('reset','POST',{maxPlies:16})).state)}catch(e){errorEl.textContent=e.message}};
paint({fen:'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',history:[],status:'playing',maxPlies:16,goal:{phase:'white'},log:[]});
</script></body></html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; connect-src 'self'; img-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  });
}
