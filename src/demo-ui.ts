// Single-page demo: a buyer hires the agent, pays through escrow, and verifies the result.
// The page only calls the public API routes. No third-party scripts or fonts.
export const demoHtml = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Origin Travel Agent</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#14171c;--mute:#5d6673;--line:#e1e5ea;--accent:#2f5bea;--ok:#12805c;--warn:#a15c00;--bad:#c0322b;--chip:#eef1f6}
@media (prefers-color-scheme:dark){:root{--bg:#0e1013;--card:#171a1f;--ink:#eceef2;--mute:#9aa3b0;--line:#272c34;--accent:#7b9bff;--ok:#43c59a;--warn:#e0a24a;--bad:#ff7a72;--chip:#20252d}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:880px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:22px;margin:0}h2{font-size:15px;margin:0 0 12px;letter-spacing:.01em}
.top{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:16px}
.sub{color:var(--mute);margin:2px 0 0}
.badge{font-size:12px;padding:4px 10px;border-radius:999px;background:var(--chip);border:1px solid var(--line);white-space:nowrap}
.badge.sim{color:var(--warn);border-color:var(--warn)}.badge.live{color:var(--ok);border-color:var(--ok)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:16px}
.row{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
label{display:block;font-size:12px;color:var(--mute);margin-bottom:4px}
select,input{width:100%;padding:9px 10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--ink);font:inherit}
button{font:inherit;padding:10px 16px;border-radius:8px;border:0;background:var(--accent);color:#fff;font-weight:600;cursor:pointer}
button:disabled{opacity:.5;cursor:default}
button.ghost{background:var(--chip);color:var(--ink);border:1px solid var(--line);font-weight:500;padding:6px 10px;font-size:13px}
.actions{margin-top:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
ol{list-style:none;margin:0;padding:0}
li.step{display:grid;grid-template-columns:28px 1fr;gap:10px;padding:10px 0;border-top:1px solid var(--line)}
li.step:first-child{border-top:0}
.dot{width:22px;height:22px;border-radius:50%;border:2px solid var(--line);display:grid;place-items:center;font-size:12px;margin-top:2px}
.step.active .dot{border-color:var(--accent);border-top-color:transparent;animation:spin 1s linear infinite}
.step.done .dot{background:var(--ok);border-color:var(--ok);color:#fff}
.step.fail .dot{background:var(--bad);border-color:var(--bad);color:#fff}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.step.active .dot{animation:none}}
.t{font-weight:600}.d{color:var(--mute);font-size:13px;word-break:break-all}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
a{color:var(--accent)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px}
.pick{border:1px solid var(--line);border-radius:10px;padding:12px;background:var(--bg)}
.pick .k{font-size:12px;color:var(--mute);text-transform:uppercase;letter-spacing:.04em}
.pick .v{font-size:20px;font-weight:700;margin:2px 0}
.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}
details pre{white-space:pre-wrap;word-break:break-all;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px;max-height:320px;overflow:auto}
.hidden{display:none}
</style>
</head>
<body>
<main>
  <div class="top">
    <div><h1>Origin Travel Agent</h1><p class="sub">Hire an AI agent for a paid trip search. Escrow, work, and proof in one flow.</p></div>
    <span id="mode" class="badge">checking settlement…</span>
  </div>

  <section class="card">
    <h2>1. The buyer's request</h2>
    <div class="row">
      <div><label for="trip">Trip</label><select id="trip"></select></div>
      <div><label for="date">Departure</label><input id="date" type="date"></div>
      <div><label for="nights">Hotel nights</label><input id="nights" type="number" min="1" max="14" value="3"></div>
    </div>
    <div class="actions">
      <button id="go">Hire the agent for 1 test USDM</button>
      <span id="hint" class="d"></span>
    </div>
  </section>

  <section class="card" id="flow" hidden>
    <h2>2. What happens</h2>
    <ol id="steps"></ol>
  </section>

  <section class="card" id="out" hidden>
    <h2>3. The delivered trip</h2>
    <div id="picks" class="grid"></div>
    <div class="actions"><button class="ghost" id="copy">Copy full JSON</button></div>
    <details style="margin-top:10px"><summary class="d">Raw result</summary><pre id="raw"></pre></details>
  </section>
</main>
<script>
(function(){
  var TRIPS=[
    {name:'Singapore → Bangkok',o:'SIN',d:'BKK',city:'Bangkok',cc:'TH'},
    {name:'London → Paris',o:'LHR',d:'CDG',city:'Paris',cc:'FR'},
    {name:'New York → Los Angeles',o:'JFK',d:'LAX',city:'Los Angeles',cc:'US'},
    {name:'Singapore → Tokyo',o:'SIN',d:'NRT',city:'Tokyo',cc:'JP'}
  ];
  var $=function(id){return document.getElementById(id)};
  var caps=null,last=null,busy=false;
  var STEPS=[
    ['req','Request sent','The buyer asks the agent to search flights and hotels.'],
    ['terms','Payment terms signed','The agent quotes a price and deadlines, bound to this exact request.'],
    ['pay','Buyer pays into escrow','Funds are locked. The agent only gets paid if it delivers.'],
    ['work','Agent searches suppliers','Live flight and hotel searches run only after the funds are locked.'],
    ['submit','Result hash recorded','The agent commits to its exact answer with a hash.'],
    ['verify','Buyer verifies the proof','The buyer recomputes both hashes locally. A mismatch means refund.']
  ];
  function iso(d){return d.toISOString().slice(0,10)}
  function addDays(s,n){var d=new Date(s+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return iso(d)}
  function sha256(text){return crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)).then(function(b){return Array.prototype.map.call(new Uint8Array(b),function(x){return x.toString(16).padStart(2,'0')}).join('')})}
  function rnd(n){var a=new Uint8Array(n);crypto.getRandomValues(a);return Array.prototype.map.call(a,function(x){return x.toString(16).padStart(2,'0')}).join('').slice(0,n)}
  function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
  function money(m){return m&&m.amount?esc(m.currency)+' '+Number(m.amount).toLocaleString(undefined,{maximumFractionDigits:2}):'n/a'}
  function short(s){s=String(s||'');return s.length>26?s.slice(0,14)+'…'+s.slice(-8):s}
  function sleep(ms){return new Promise(function(r){setTimeout(r,ms)})}
  function api(path,body){
    var opt=body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{};
    return fetch(path,opt).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error((j.error&&j.error.message)||('HTTP '+r.status));return j})});
  }

  var ul=$('steps');
  function drawSteps(){ul.innerHTML=STEPS.map(function(s){return '<li class="step" id="s-'+s[0]+'"><span class="dot"></span><div><div class="t">'+s[1]+'</div><div class="d" id="d-'+s[0]+'">'+s[2]+'</div></div></li>'}).join('')}
  function mark(id,state,detail){var el=$('s-'+id);el.className='step '+state;var dot=el.querySelector('.dot');dot.textContent=state==='done'?'✓':state==='fail'?'!':'';if(detail!=null)$('d-'+id).innerHTML=detail}

  function init(){
    $('trip').innerHTML=TRIPS.map(function(t,i){return '<option value="'+i+'">'+t.name+'</option>'}).join('');
    $('date').value=addDays(iso(new Date()),30);
    $('date').min=addDays(iso(new Date()),1);
    api('/v1/capabilities').then(function(c){
      caps=c;var m=c.masumi&&c.masumi.mode,b=$('mode');
      if(m==='simulated'){b.textContent='Rehearsal: simulated settlement';b.className='badge sim';$('hint').textContent='No real funds move. Every proof is labelled simulated.'}
      else if(m==='live'){b.textContent='Cardano Preprod escrow (test funds)';b.className='badge live';$('hint').textContent='Payment must come from a funded Masumi buyer wallet.'}
      else{b.textContent='Payments not configured';b.className='badge';$('go').disabled=true;$('hint').textContent='The payment service is not configured on this deployment.'}
    }).catch(function(){$('mode').textContent='API unreachable';$('go').disabled=true});
  }

  function render(result){
    var s=result.summary||{},f=s.flights||{},h=s.hotels||{},html='';
    if(f.cheapest)html+='<div class="pick"><div class="k">Cheapest flight</div><div class="v">'+money(f.cheapest.total)+'</div><div>'+esc(f.cheapest.airline)+' · '+esc(f.cheapest.route)+' · '+(f.cheapest.stops?f.cheapest.stops+' stop(s)':'nonstop')+'</div><div class="d">'+esc(f.offers_found)+' offers searched</div></div>';
    if(f.fastest&&f.fastest.duration_minutes)html+='<div class="pick"><div class="k">Fastest flight</div><div class="v">'+Math.floor(f.fastest.duration_minutes/60)+'h '+(f.fastest.duration_minutes%60)+'m</div><div>'+esc(f.fastest.airline)+' · '+money(f.fastest.total)+'</div></div>';
    (h.top_rated||[]).forEach(function(x,i){html+='<div class="pick" id="hotel-'+esc(x.id)+'"><div class="k">'+(i===0?'Top-rated hotel':'Hotel option')+'</div><div class="v">'+money(x.total)+'</div><div>'+esc(x.name)+(x.stars?' · '+esc(x.stars)+'★':'')+'</div><div class="d">'+(x.refundable?'Free cancellation available':'Non-refundable rate')+'</div></div>'});
    if(s.estimated_total)html+='<div class="pick"><div class="k">Estimated trip total</div><div class="v">'+(s.estimated_total.amount?money(s.estimated_total):'n/a')+'</div><div class="d">'+esc(s.estimated_total.basis)+'</div></div>';
    $('picks').innerHTML=html||'<div class="d">The search completed but returned no priced options.</div>';
    $('raw').textContent=JSON.stringify(result,null,2);$('out').hidden=false;
    (h.top_rated||[]).forEach(enrich);
  }
  function enrich(x){
    api('/v1/stays/hotels/'+encodeURIComponent(x.id)).then(function(r){
      var d=r.data,el=$('hotel-'+x.id);if(!el)return;
      var photo=d.photos&&d.photos[0]&&d.photos[0].url,extra='';
      if(photo)extra+='<img alt="" loading="lazy" src="'+esc(photo)+'" style="width:100%;height:130px;object-fit:cover;border-radius:8px;margin-bottom:8px">';
      var tail='';
      if(d.facilities&&d.facilities.length)tail+='<div class="d" style="margin-top:6px">'+d.facilities.slice(0,5).map(esc).join(' · ')+'</div>';
      var hl=d.review_highlights;
      if(hl&&hl.pros&&hl.pros.length)tail+='<div class="d ok" style="margin-top:4px">+ '+hl.pros.slice(0,3).map(esc).join(', ')+'</div>';
      if(hl&&hl.cons&&hl.cons.length)tail+='<div class="d warn">− '+hl.cons.slice(0,2).map(esc).join(', ')+'</div>';
      if(d.check_in_from)tail+='<div class="d" style="margin-top:4px">Check-in from '+esc(d.check_in_from)+(d.check_out_by?' · out by '+esc(d.check_out_by):'')+'</div>';
      el.innerHTML=extra+el.innerHTML+tail;
    }).catch(function(){});
  }

  async function run(){
    if(busy)return;busy=true;$('go').disabled=true;$('out').hidden=true;$('flow').hidden=false;drawSteps();
    var cur='req';
    try{
      var t=TRIPS[+$('trip').value],dep=$('date').value,n=Math.max(1,Math.min(14,+$('nights').value||3));
      var req={flights:{slices:[{origin:t.o,destination:t.d,departure_date:dep}],passengers:[{type:'adult'}],max_connections:1},
               stays:{check_in_date:dep,check_out_date:addDays(dep,n),rooms:[{adults:1}],location:{city:t.city,country_code:t.cc},currency:'EUR',limit:10}};
      var input={trip_request_json:JSON.stringify(req)},nonce=rnd(20);
      mark('req','active');
      var job=await api('/start_job',{identifier_from_purchaser:nonce,input_data:input});
      mark('req','done');cur='terms';
      var price=caps&&caps.masumi?(Number(caps.masumi.price_atomic)/1e6)+' USDM':'1 USDM';
      mark('terms','done','Price '+esc(price)+' · escrow ID <code>'+esc(short(job.blockchainIdentifier))+'</code> · pay by '+new Date(job.payByTime).toLocaleTimeString()+' · seller key <code>'+esc(short(job.sellerVKey))+'</code>');
      cur='pay';mark('pay','active');
      if(job.settlement==='simulated'){
        await sleep(900);await api('/v1/demo/simulate-payment',{job_id:job.id});
        mark('pay','done','Escrow funded (<b class="warn">simulated</b>, no real funds).');
      }else{
        $('d-pay').innerHTML='Waiting for an on-chain payment of the quoted amount to escrow ID <code>'+esc(short(job.blockchainIdentifier))+'</code> from a Masumi buyer wallet. Run <code>npm run demo:buy</code> or pay through Sokosumi.';
      }
      var st,started=Date.now(),sub=false;
      for(;;){
        st=await api('/status?job_id='+job.id);
        if(st.transactions&&st.transactions.payment&&$('s-pay').className.indexOf('done')<0){mark('pay','done','Escrow funded. '+txLink(st.transactions.payment,st.settlement));cur='work';mark('work','active')}
        if(st.phase==='search_pending'||st.phase==='submit_pending'||st.phase==='awaiting_result'){if($('s-work').className.indexOf('done')<0){cur='work';mark('work','active')}}
        if(st.phase==='awaiting_result'&&!sub){sub=true;mark('work','done');cur='submit';mark('submit','active','Result hash <code>'+esc(short(st.result_hash))+'</code> submitted, waiting for confirmation.')}
        if(st.status==='completed')break;
        if(st.status==='failed')throw new Error('Job failed: '+(st.error||st.phase));
        if(Date.now()-started>5*60*1000)throw new Error('Timed out waiting for the job.');
        await sleep(1500);
      }
      mark('work','done');mark('submit','done','Result hash <code>'+esc(short(st.result_hash))+'</code> confirmed. '+txLink(st.transactions&&st.transactions.result,st.settlement));
      cur='verify';mark('verify','active');
      var inH=await sha256(nonce+';'+JSON.stringify(input)),outH=await sha256(nonce+';'+st.result);
      var okIn=inH===st.input_hash,okOut=outH===st.result_hash;
      if(!okIn||!okOut){mark('verify','fail','<span class="bad">Hash mismatch ('+(okIn?'result':'request')+'). A real buyer would request a refund.</span>');throw new Error('Verification failed')}
      mark('verify','done','<span class="ok">Both hashes match.</span> The result is exactly what the agent committed to.');
      last=JSON.parse(st.result);render(last);
    }catch(e){
      if(cur&&$('s-'+cur)&&$('s-'+cur).className.indexOf('done')<0)mark(cur,'fail','<span class="bad">'+esc(e.message)+'</span>');
    }finally{busy=false;$('go').disabled=false}
  }
  function txLink(tx,settlement){
    if(!tx)return '';
    if(settlement==='simulated'||String(tx).indexOf('sim-')===0)return 'Reference <code>'+esc(short(tx))+'</code> <span class="warn">(simulated)</span>';
    return '<a target="_blank" rel="noopener" href="https://preprod.cardanoscan.io/transaction/'+encodeURIComponent(tx)+'">View on Cardanoscan</a>';
  }
  $('go').addEventListener('click',run);
  $('copy').addEventListener('click',function(){if(last)navigator.clipboard.writeText(JSON.stringify(last,null,2)).then(function(){$('copy').textContent='Copied'})});
  init();
})();
</script>
</body>
</html>`;
