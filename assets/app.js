// ═══════════════════════════════════════════════════════════
//  UNIFIED — working demo app (stock screener + portfolio tracker)
//  100% client-side. Data is illustrative/editable in-session.
// ═══════════════════════════════════════════════════════════
let USD_PLN = 4.00;              // live FX (USD→PLN), refreshed from Frankfurter
const clamp = (x,a,b)=>Math.max(a,Math.min(b,x));
function fmt(n){ return Math.round(n).toLocaleString('pl-PL') + ' PLN'; }
function fmtCur(n,cur){ return cur==='USD' ? '$'+Math.round(n).toLocaleString('en-US') : Math.round(n).toLocaleString('pl-PL')+' PLN'; }
function pct(x){ return (x>=0?'+':'')+x.toFixed(1)+'%'; }
function toPLN(n,cur){ return cur==='USD' ? n*USD_PLN : n; }

// ═══════════════════════════════════════════════════════════
//  LIVE MARKET DATA — real-time quotes, 100% client-side, $0
//  • US stocks  → Finnhub      (real-time)
//  • Crypto     → CoinGecko    (keyless)
//  • USD/PLN FX → Frankfurter  (keyless)
//  • Other (WSE/bonds) → seeded values, shown as "delayed"
//  Symbols we can't fetch keep their seeded price and degrade gracefully.
// ═══════════════════════════════════════════════════════════
const FINNHUB_KEY = localStorage.getItem('unified_fhkey') || 'd8e76spr01qm5f802vi0d8e76spr01qm5f802vig';
const CRYPTO_IDS  = { BTC:'bitcoin', ETH:'ethereum', SOL:'solana', ADA:'cardano', DOT:'polkadot', XRP:'ripple' };
let lastUpdated = null;          // Date of last successful refresh
let isRefreshing = false;

// Decide where a holding's live price comes from.
function priceSource(ticker, cur){
  if (CRYPTO_IDS[ticker]) return 'coingecko';
  if (cur === 'USD')      return 'finnhub';      // US-listed
  return 'seed';                                 // WSE / bonds / unknown → no free live source
}

async function fetchJSON(url, ms=8000){
  const ctrl = new AbortController();
  const id = setTimeout(()=>ctrl.abort(), ms);
  try { const r = await fetch(url, {signal:ctrl.signal}); if(!r.ok) throw new Error(r.status); return await r.json(); }
  finally { clearTimeout(id); }
}

// Pull live FX, crypto and US-stock prices and write them onto the holdings.
async function refreshPrices(){
  if (isRefreshing) return; isRefreshing = true;
  renderLiveBar();   // show "updating…"
  try {
    // 1) FX USD→PLN (best-effort; keeps last value on failure)
    try { const fx = await fetchJSON('https://api.frankfurter.dev/v1/latest?base=USD&symbols=PLN');
          if (fx?.rates?.PLN) USD_PLN = fx.rates.PLN; } catch(_){}

    // 1b) WSE quotes — our own auto-updated JSON (a GitHub Action pulls Stooq
    //     server-side every ~30 min, since Stooq sends no browser CORS header).
    let wse = {};
    try { const w = await fetchJSON('assets/wse.json?t='+Date.now()); wse = w?.quotes || {}; } catch(_){}

    // 2) Collect the distinct symbols we can fetch
    const all = portfolios.flatMap(p => p.holdings.map(h => ({h, cur:p.cur})));
    const cryptoIds = [...new Set(all.filter(x=>priceSource(x.h.t,x.cur)==='coingecko').map(x=>CRYPTO_IDS[x.h.t]))];
    const usSyms     = [...new Set(all.filter(x=>priceSource(x.h.t,x.cur)==='finnhub').map(x=>x.h.t))];

    // 3) Crypto — one batched CoinGecko call (prices already in PLN + USD)
    let cg = {};
    if (cryptoIds.length){
      try { cg = await fetchJSON('https://api.coingecko.com/api/v3/simple/price?ids='+cryptoIds.join(',')+'&vs_currencies=usd,pln&include_24hr_change=true'); } catch(_){}
    }
    // 4) US stocks — parallel Finnhub quotes
    const fh = {};
    await Promise.all(usSyms.map(async s=>{
      try { const q = await fetchJSON('https://finnhub.io/api/v1/quote?symbol='+encodeURIComponent(s)+'&token='+FINNHUB_KEY);
            if (q && typeof q.c === 'number' && q.c > 0) fh[s] = q; } catch(_){}
    }));

    // 5) Write results onto holdings
    portfolios.forEach(p => p.holdings.forEach(h => {
      const src = priceSource(h.t, p.cur);
      if (src === 'coingecko'){
        const d = cg[CRYPTO_IDS[h.t]];
        if (d){ h.price = p.cur==='USD' ? d.usd : d.pln; h.day = d.usd_24h_change; h.live = true; h.src='Crypto'; }
        else h.live = false;
      } else if (src === 'finnhub'){
        const q = fh[h.t];
        if (q){ h.price = q.c; h.day = q.dp; h.live = true; h.src='NYSE/NASDAQ'; }
        else h.live = false;
      } else if (wse[h.t]){
        h.price = wse[h.t].price; h.day = wse[h.t].day; h.live = true; h.src='WSE (Stooq)';
      } else { h.live = false; h.src='WSE (delayed)'; }
    }));
    lastUpdated = new Date();
  } finally {
    isRefreshing = false;
    persist();
    renderSidebar(); renderMain(); renderLiveBar();
  }
}

// Status line under the dashboard header.
function renderLiveBar(){
  const bar = document.getElementById('liveBar'); if(!bar) return;
  const liveCount = portfolios.flatMap(p=>p.holdings).filter(h=>h.live).length;
  const total = portfolios.flatMap(p=>p.holdings).length;
  let dotCls='off', label='Prices not yet loaded';
  if (isRefreshing){ dotCls=''; label='Updating live prices…'; }
  else if (lastUpdated){
    const t = lastUpdated.toLocaleTimeString('pl-PL',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
    dotCls = liveCount? '' : 'stale';
    label = `${liveCount}/${total} live · updated ${t}`;
  }
  bar.innerHTML = `<span class="live-dot ${dotCls}"></span>
    <span>${label}</span>
    <span class="lv-sep">·</span>
    <span class="lv-pill">USD/PLN ${USD_PLN.toFixed(3)}</span>
    <span class="lv-sep">·</span>
    <span title="US stocks: Finnhub · WSE: Stooq · Crypto: CoinGecko · FX: Frankfurter">Live: US + WSE + crypto</span>`;
}

// ─── Persistence (localStorage) ────────────────────────────
const STORE_KEY = 'unified_portfolios_v1';
function persist(){
  try {
    const data = portfolios.map(p=>({ id:p.id, name:p.name, cur:p.cur, benchmark:p.benchmark, benchVs:p.benchVs, dividends:p.dividends,
      holdings: p.holdings.map(h=>({t:h.t,n:h.n,qty:h.qty,price:h.price,cost:h.cost,score:h.score})) }));
    localStorage.setItem(STORE_KEY, JSON.stringify(data));
  } catch(_){}
}
function loadState(){
  try {
    const raw = localStorage.getItem(STORE_KEY); if(!raw) return;
    const data = JSON.parse(raw);
    if (Array.isArray(data) && data.length){ portfolios.length=0; data.forEach(p=>portfolios.push(p)); }
  } catch(_){}
}

// ─── Portfolio tracker: data ───────────────────────────────
const portfolios = [
  { id:'main', name:'Main IKE', cur:'PLN', benchmark:'WIG20', benchVs:4.1, dividends:2340, holdings:[
    {t:'PKN', n:'PKN Orlen',  qty:120, price:68.40,  cost:59.90,  score:82},
    {t:'CDR', n:'CD Projekt', qty:45,  price:142.20, cost:152.60, score:54},
    {t:'PZU', n:'PZU Group',  qty:200, price:44.80,  cost:41.29,  score:68},
    {t:'KGH', n:'KGHM',       qty:80,  price:128.50, cost:142.00, score:49},
  ]},
  { id:'ustech', name:'US Tech', cur:'USD', benchmark:'S&P 500', benchVs:-1.2, dividends:120, holdings:[
    {t:'AAPL', n:'Apple Inc.', qty:30, price:192.50, cost:157.70, score:75},
    {t:'MSFT', n:'Microsoft',  qty:18, price:415.30, cost:298.00, score:80},
    {t:'NVDA', n:'Nvidia',     qty:25, price:118.40, cost:64.20,  score:63},
  ]},
  { id:'crypto', name:'Crypto', cur:'PLN', benchmark:'BTC', benchVs:-3.2, dividends:0, holdings:[
    {t:'BTC', n:'Bitcoin',  qty:0.12, price:248000, cost:262000, score:58},
    {t:'ETH', n:'Ethereum', qty:3.5,  price:9800,   cost:9100,   score:55},
  ]},
  { id:'bonds', name:'Bonds & Deposits', cur:'PLN', benchmark:'Inflation', benchVs:2.0, dividends:1850, holdings:[
    {t:'EDO', n:'10Y Treasury (EDO)', qty:300, price:104.20, cost:100.00, score:70},
    {t:'DEP', n:'Bank Deposit 6%',    qty:100, price:100.00, cost:100.00, score:60},
  ]},
];
let activePid = 'main';
let sortKey = null, sortDir = -1;

function holdingsOf(pid){
  if(pid==='all') return portfolios.flatMap(p => p.holdings.map(h => ({...h, cur:p.cur})));
  const p = portfolios.find(x=>x.id===pid);
  return p.holdings.map(h => ({...h, cur:p.cur}));
}
function statsOf(pid){
  let valPLN=0, invPLN=0, div=0;
  const list = pid==='all' ? portfolios : [portfolios.find(x=>x.id===pid)];
  list.forEach(p=>{
    p.holdings.forEach(h=>{ valPLN+=toPLN(h.qty*h.price,p.cur); invPLN+=toPLN(h.qty*h.cost,p.cur); });
    div += p.dividends;
  });
  return { valPLN, invPLN, plAbs:valPLN-invPLN, plPct: invPLN? (valPLN-invPLN)/invPLN*100 : 0, div };
}

function renderSidebar(){
  const rows = portfolios.map(p=>{
    const s=statsOf(p.id);
    const cls = p.plPct<0?'':'';
    return `<div class="portfolio-item ${p.id===activePid?'active':''}" data-pid="${p.id}">
      <div><div class="p-name">${p.name}</div><div class="p-val">${fmtCur(p.id==='all'?s.valPLN:portStatsCur(p),p.cur)}</div></div>
      <div class="p-change ${s.plPct>=0?'positive':'negative'}">${pct(s.plPct)}</div></div>`;
  }).join('');
  const all=statsOf('all');
  const groupRow = `<div class="portfolio-item ${activePid==='all'?'active':''}" data-pid="all">
      <div><div class="p-name">▣ GROUP: All</div><div class="p-val">${fmt(all.valPLN)}</div></div>
      <div class="p-change ${all.plPct>=0?'positive':'negative'}">${pct(all.plPct)}</div></div>`;
  document.getElementById('dashSidebar').innerHTML =
    `<div style="font-size:0.65rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:0.75rem;">Portfolios</div>`
    + rows + groupRow;
  document.querySelectorAll('#dashSidebar .portfolio-item').forEach(el=>{
    el.addEventListener('click',()=>{ activePid=el.dataset.pid; sortKey=null; renderSidebar(); renderMain(); });
  });
}
function portStatsCur(p){ // portfolio value in its own currency
  return p.holdings.reduce((a,h)=>a+h.qty*h.price,0);
}

function scoreColor(s){ return s>=70?'var(--accent)':s>=55?'var(--accent3)':'var(--accent2)'; }

function holdingsTable(pid, sortable){
  let list = holdingsOf(pid);
  if(sortKey){
    const val=h=>({value:h.qty*h.price, pl:(h.price-h.cost)/h.cost, score:h.score, qty:h.qty, price:h.price}[sortKey]);
    list=[...list].sort((a,b)=>(val(a)-val(b))*sortDir);
  }
  const th=(k,label)=> sortable ? `<th style="cursor:pointer" data-sort="${k}">${label}${sortKey===k?(sortDir<0?' ↓':' ↑'):''}</th>` : `<th>${label}</th>`;
  const rows = list.map(h=>{
    const val=h.qty*h.price, plp=(h.price-h.cost)/h.cost*100;
    const tick = h.live ? ` <span class="live-tick" title="Live price (${h.src||''})">●</span>` : '';
    const dayLine = (h.live && typeof h.day==='number')
      ? `<div class="px-day ${h.day>=0?'positive':'negative'}">${pct(h.day)} today</div>` : '';
    return `<tr>
      <td><span class="ticker-badge">${h.t}</span>${tick}</td>
      <td>${h.n}</td>
      <td style="font-family:'DM Mono',monospace">${h.qty}</td>
      <td style="font-family:'DM Mono',monospace">${fmtCur(h.price,h.cur)}${dayLine}</td>
      <td style="font-family:'DM Mono',monospace">${fmtCur(val,h.cur)}</td>
      <td class="${plp>=0?'positive':'negative'}" style="font-family:'DM Mono',monospace">${pct(plp)}</td>
      <td><div class="score-bar-wrap"><div class="score-bar"><div class="score-bar-fill" style="width:${h.score}%;background:${scoreColor(h.score)}"></div></div><div class="score-val" style="color:${scoreColor(h.score)}">${h.score}</div></div></td>
    </tr>`;
  }).join('');
  return `<table class="holdings-table"><thead><tr>
    ${th('','Ticker')}${th('','Company')}${th('qty','Qty')}${th('price','Price')}${th('value','Value')}${th('pl','P/L')}${th('score','Score')}
  </tr></thead><tbody>${rows}</tbody></table>`;
}

function kpiRow(pid){
  const s=statsOf(pid); const p=portfolios.find(x=>x.id===pid);
  const bench = pid==='all' ? null : p.benchVs;
  return `<div class="kpi-row">
    <div class="kpi"><div class="kpi-label">Total Value</div><div class="kpi-value" style="color:var(--accent)">${fmt(s.valPLN)}</div><div class="kpi-sub ${s.plPct>=0?'positive':''}">${pct(s.plPct)} total</div></div>
    <div class="kpi"><div class="kpi-label">Profit / Loss</div><div class="kpi-value" style="color:${s.plAbs>=0?'var(--accent)':'var(--accent2)'}">${(s.plAbs>=0?'+':'−')+fmt(Math.abs(s.plAbs))}</div><div class="kpi-sub">vs. ${fmt(s.invPLN)} invested</div></div>
    <div class="kpi"><div class="kpi-label">vs. ${bench!==null?p.benchmark:'Benchmarks'}</div><div class="kpi-value" style="color:var(--accent2)">${bench!==null?pct(bench):'+2.7%'}</div><div class="kpi-sub">benchmark</div></div>
    <div class="kpi"><div class="kpi-label">Dividends</div><div class="kpi-value">${fmt(s.div)}</div><div class="kpi-sub">received YTD</div></div>
  </div>`;
}

let dashView='overview';
function renderMain(){
  const pid=activePid, main=document.getElementById('dashMain');
  if(dashView==='overview'){
    main.innerHTML = kpiRow(pid) + holdingsTable(pid,false);
  } else if(dashView==='holdings'){
    main.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem;">
        <div style="font-size:0.8rem;color:var(--muted)">${holdingsOf(pid).length} positions · click a column to sort</div>
        <button class="dash-btn" onclick="addHolding()">+ Add Holding</button></div>`
      + holdingsTable(pid,true);
    main.querySelectorAll('th[data-sort]').forEach(th=>{
      if(!th.dataset.sort) return;
      th.addEventListener('click',()=>{ const k=th.dataset.sort; sortDir = sortKey===k? -sortDir : -1; sortKey=k; renderMain(); });
    });
  } else if(dashView==='performance'){
    main.innerHTML = performanceView(pid);
  } else if(dashView==='tax'){
    main.innerHTML = taxView(pid);
  }
}

function performanceView(pid){
  const list=holdingsOf(pid);
  const totalPLN=list.reduce((a,h)=>a+toPLN(h.qty*h.price,h.cur),0);
  const byAlloc=[...list].sort((a,b)=>toPLN(b.qty*b.price,b.cur)-toPLN(a.qty*a.price,a.cur));
  const byPl=[...list].map(h=>({...h,plp:(h.price-h.cost)/h.cost*100})).sort((a,b)=>b.plp-a.plp);
  const best=byPl[0], worst=byPl[byPl.length-1];
  const bars=byAlloc.map(h=>{
    const w=toPLN(h.qty*h.price,h.cur)/totalPLN*100;
    return `<div style="margin-bottom:0.6rem;">
      <div style="display:flex;justify-content:space-between;font-size:0.78rem;margin-bottom:0.25rem;"><span><span class="ticker-badge">${h.t}</span> ${h.n}</span><span style="font-family:'DM Mono',monospace;color:var(--muted)">${w.toFixed(1)}%</span></div>
      <div class="score-bar"><div class="score-bar-fill" style="width:${w}%;background:var(--accent)"></div></div></div>`;
  }).join('');
  return `<div class="kpi-row" style="margin-bottom:1.25rem;">
      <div class="kpi"><div class="kpi-label">Best Performer</div><div class="kpi-value positive" style="font-size:1rem">${best.t} ${pct(best.plp)}</div></div>
      <div class="kpi"><div class="kpi-label">Worst Performer</div><div class="kpi-value negative" style="font-size:1rem">${worst.t} ${pct(worst.plp)}</div></div>
      <div class="kpi"><div class="kpi-label">Positions</div><div class="kpi-value">${list.length}</div></div>
      <div class="kpi"><div class="kpi-label">Diversification</div><div class="kpi-value" style="color:var(--accent2)">${new Set(list.map(h=>h.t)).size} assets</div></div>
    </div>
    <div style="font-size:0.73rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.07em;margin-bottom:0.9rem;">Allocation by Position</div>
    ${bars}`;
}

function realizedGains(pid){ // treat winners as realized gains, losers as losses (demo)
  let gains=0, losses=0;
  holdingsOf(pid).forEach(h=>{ const d=toPLN((h.price-h.cost)*h.qty,h.cur); if(d>=0) gains+=d; else losses+=-d; });
  return { gains, losses };
}
function taxView(pid){
  const g=realizedGains(pid); const net=Math.max(0,g.gains-g.losses); const tax=net*0.19;
  return `<div style="font-size:0.73rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.07em;margin-bottom:1rem;">Realized P/L Summary (this portfolio)</div>
    <div class="tax-result">
      <div class="tax-result-row"><span class="label">Unrealized/Realized Gains</span><span class="value">${fmt(g.gains)}</span></div>
      <div class="tax-result-row"><span class="label">Losses</span><span class="value negative">− ${fmt(g.losses)}</span></div>
      <div class="tax-result-row"><span class="label">Net Taxable Base</span><span class="value">${fmt(net)}</span></div>
      <div class="tax-result-row" style="margin-top:0.5rem;"><span class="label" style="color:var(--text)">Est. Capital Tax (19%)</span><span class="value" style="color:var(--accent);font-size:1.1rem">${fmt(tax)}</span></div>
    </div>
    <button class="btn-accent" style="margin-top:1rem;width:100%;" onclick="sendToTax(${g.gains.toFixed(0)},${g.losses.toFixed(0)})">Send to PIT-38 Calculator ↓</button>`;
}
function sendToTax(gains,losses){
  document.getElementById('gains').value=Math.round(gains);
  document.getElementById('losses').value=Math.round(losses);
  calcTax();
  document.getElementById('tax').scrollIntoView({behavior:'smooth'});
}
function addHolding(){
  const t=prompt('Ticker (e.g. ALV):'); if(!t) return;
  const n=prompt('Company name:',t)||t;
  const qty=parseFloat(prompt('Quantity:','10'))||0;
  const price=parseFloat(prompt('Current price (in portfolio currency):','100'))||0;
  const cost=parseFloat(prompt('Average buy price:',price))||price;
  const p=portfolios.find(x=>x.id===(activePid==='all'?'main':activePid));
  p.holdings.push({t:t.toUpperCase(),n,qty,price,cost,score:Math.round(clamp((price/cost-1)*200+60,5,95))});
  persist(); renderSidebar(); renderMain();
  refreshPrices();   // pull a live quote for the new position if available
}

// ─── Stock screener ────────────────────────────────────────
const companies = [
  {n:'PKN Orlen',t:'PKN',flag:'🇵🇱',ex:'WSE',sec:'Energy',pe:7.2,pb:0.8,roe:18.4,dy:5.2,de:0.6,rg:12},
  {n:'Volkswagen AG',t:'VOW3',flag:'🇩🇪',ex:'XETRA',sec:'Auto',pe:5.4,pb:0.5,roe:16.1,dy:7.8,de:0.9,rg:6},
  {n:'Johnson & Johnson',t:'JNJ',flag:'🇺🇸',ex:'NYSE',sec:'Healthcare',pe:14.2,pb:5.1,roe:22.3,dy:3.1,de:0.5,rg:8},
  {n:'Rio Tinto',t:'RIO',flag:'🇬🇧',ex:'LSE',sec:'Materials',pe:9.8,pb:2.1,roe:15.6,dy:6.4,de:0.4,rg:3},
  {n:'Dino Polska',t:'DNP',flag:'🇵🇱',ex:'WSE',sec:'Retail',pe:18.4,pb:4.8,roe:28.7,dy:0.0,de:0.7,rg:21},
  {n:'Apple Inc.',t:'AAPL',flag:'🇺🇸',ex:'NASDAQ',sec:'Tech',pe:29.5,pb:46,roe:147,dy:0.5,de:1.5,rg:8},
  {n:'Allianz SE',t:'ALV',flag:'🇩🇪',ex:'XETRA',sec:'Insurance',pe:11.2,pb:1.7,roe:14.8,dy:5.1,de:0.3,rg:5},
  {n:'TotalEnergies',t:'TTE',flag:'🇫🇷',ex:'EPA',sec:'Energy',pe:7.8,pb:1.2,roe:17.2,dy:4.9,de:0.5,rg:4},
  {n:'Nvidia',t:'NVDA',flag:'🇺🇸',ex:'NASDAQ',sec:'Tech',pe:55,pb:48,roe:91,dy:0.03,de:0.4,rg:60},
  {n:'Unilever',t:'ULVR',flag:'🇬🇧',ex:'LSE',sec:'Staples',pe:17.1,pb:6.2,roe:38,dy:3.6,de:1.1,rg:4},
  {n:'KGHM',t:'KGH',flag:'🇵🇱',ex:'WSE',sec:'Materials',pe:12.5,pb:0.9,roe:9.2,dy:2.1,de:0.6,rg:-2},
  {n:'Santander',t:'SAN',flag:'🇪🇸',ex:'BME',sec:'Banking',pe:6.1,pb:0.7,roe:12.4,dy:4.2,de:0.0,rg:9},
];
// Fundamental score model (0-100) — the scoring engine
function scoreOf(c){
  const peS=clamp((25-c.pe)/25,0,1), pbS=clamp((6-c.pb)/6,0,1), roeS=clamp(c.roe/30,0,1),
        dyS=clamp(c.dy/8,0,1), deS=clamp((1.5-c.de)/1.5,0,1), rgS=clamp((c.rg+5)/40,0,1);
  return Math.round(100*(0.22*peS+0.13*pbS+0.25*roeS+0.13*dyS+0.12*deS+0.15*rgS));
}
const metricMap={PE:'pe',PB:'pb',ROE:'roe',DY:'dy',DE:'de',RG:'rg'};
const presets=[
  {id:'pe', label:'P/E &lt; 20', test:c=>c.pe<20, on:true},
  {id:'roe',label:'ROE &gt; 15%', test:c=>c.roe>15, on:true},
  {id:'de', label:'Debt/Equity &lt; 1', test:c=>c.de<1, on:true},
  {id:'dy', label:'Div Yield &gt; 3%', test:c=>c.dy>3, on:false},
  {id:'rg', label:'Revenue Growth &gt; 10%', test:c=>c.rg>10, on:false},
];
let marketOn=true; const customFilters=[];
function pillClass(s){ return s>=70?'high':s>=55?'mid':'low'; }
function activeTests(){
  const t=presets.filter(p=>p.on).map(p=>p.test);
  customFilters.forEach(f=>{ const k=metricMap[f.metric]; t.push(c=> f.op==='<'? c[k]<f.val : c[k]>f.val); });
  return t;
}
function renderScreener(){
  // chips
  const chips=[`<div class="filter-chip ${marketOn?'active':''}" data-kind="market">🌍 All Markets</div>`]
    .concat(presets.map(p=>`<div class="filter-chip ${p.on?'active':''}" data-kind="preset" data-id="${p.id}">${p.label}</div>`))
    .concat(customFilters.map((f,i)=>`<div class="filter-chip active" data-kind="custom" data-i="${i}">${f.metric} ${f.op} ${f.val} ✕</div>`))
    .concat([`<div class="filter-chip" data-kind="add">+ Add Filter</div>`]).join('');
  document.getElementById('screenerFilters').innerHTML=chips;
  // rows
  const tests=activeTests();
  const rows=companies.filter(c=>tests.every(fn=>fn(c)))
    .map(c=>({...c,score:scoreOf(c)})).sort((a,b)=>b.score-a.score);
  const tbody=document.querySelector('#screenerTable tbody');
  tbody.innerHTML = rows.length ? rows.map(c=>`<tr>
      <td><span class="flag">${c.flag}</span></td>
      <td><strong>${c.n}</strong> <span style="color:var(--muted);font-size:0.72rem">${c.t}</span></td>
      <td style="color:var(--muted)">${c.ex}</td>
      <td style="color:var(--muted)">${c.sec}</td>
      <td style="font-family:'DM Mono',monospace">${c.pe}</td>
      <td style="font-family:'DM Mono',monospace">${c.pb}</td>
      <td style="font-family:'DM Mono',monospace;color:${c.roe>=15?'var(--accent)':'var(--accent3)'}">${c.roe}%</td>
      <td style="font-family:'DM Mono',monospace">${c.dy}%</td>
      <td><span class="score-pill ${pillClass(c.score)}">${c.score}</span></td>
    </tr>`).join('')
    : `<tr><td colspan="9" style="text-align:center;color:var(--muted);padding:1.5rem">No companies match all active filters — loosen a criterion.</td></tr>`;
  // count line in section desc handled separately
  const cnt=document.getElementById('screenerCount'); if(cnt) cnt.textContent=rows.length;
  // wire chips
  document.querySelectorAll('#screenerFilters .filter-chip').forEach(chip=>{
    chip.addEventListener('click',()=>{
      const k=chip.dataset.kind;
      if(k==='preset'){ const p=presets.find(x=>x.id===chip.dataset.id); p.on=!p.on; }
      else if(k==='market'){ marketOn=!marketOn; }
      else if(k==='custom'){ customFilters.splice(+chip.dataset.i,1); }
      else if(k==='add'){ addFilter(); }
      renderScreener();
    });
  });
}
function addFilter(){
  const m=(prompt('Metric to filter — PE, PB, ROE, DY, DE or RG:','ROE')||'').toUpperCase().trim();
  if(!metricMap[m]) { if(m) alert('Unknown metric: '+m); return; }
  const op=(prompt('Operator — type < or > :','>')||'').trim();
  if(op!=='<'&&op!=='>'){ alert('Operator must be < or >'); return; }
  const val=parseFloat(prompt('Threshold value:','15'));
  if(isNaN(val)) return;
  customFilters.push({metric:m,op,val});
}

// ─── TAX CALCULATOR (PIT-38) ───────────────────────────────
function calcTax(){
  const gains=parseFloat(document.getElementById('gains').value)||0;
  const losses=parseFloat(document.getElementById('losses').value)||0;
  const cf=parseFloat(document.getElementById('carryforward').value)||0;
  const fdiv=parseFloat(document.getElementById('foreigndiv').value)||0;
  const withheld=parseFloat(document.getElementById('withheld').value)||0;
  const net=Math.max(0,gains-losses-cf);
  const captax=net*0.19, polishDivTax=fdiv*0.19;
  const credit=Math.min(withheld,polishDivTax);
  const divTaxDue=Math.max(0,polishDivTax-credit);
  const total=captax+divTaxDue;
  document.getElementById('r-gains').textContent=fmt(gains);
  document.getElementById('r-losses').textContent='− '+fmt(losses);
  document.getElementById('r-cf').textContent='− '+fmt(cf);
  document.getElementById('r-base').textContent=fmt(net);
  document.getElementById('r-captax').textContent=fmt(captax);
  document.getElementById('r-divtax').textContent=fmt(polishDivTax);
  document.getElementById('r-credit').textContent='− '+fmt(credit);
  document.getElementById('r-total').textContent=fmt(total);
  window._taxState={gains,losses,cf,fdiv,withheld,net,captax,polishDivTax,credit,total};
}
function exportTax(){
  const s=window._taxState||{};
  const rows=[['PIT-38 Capital Gains Report','unifiedinvest.online'],['Generated',new Date().toISOString().slice(0,10)],[],
    ['Field','Amount (PLN)'],
    ['Capital gains',s.gains],['Capital losses',s.losses],['Loss carryforward',s.cf],
    ['Net taxable base',s.net],['Capital tax (19%)',Math.round(s.captax)],
    ['Foreign dividends',s.fdiv],['Foreign dividend tax (19%)',Math.round(s.polishDivTax)],
    ['Foreign tax credit',s.credit],['TOTAL TAX DUE (PIT-38)',Math.round(s.total)]];
  const csv=rows.map(r=>r.map(v=>typeof v==='string'&&v.includes(',')?'"'+v+'"':v).join(',')).join('\n');
  const blob=new Blob([csv],{type:'text/csv'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download='PIT-38-unified-'+new Date().toISOString().slice(0,10)+'.csv';
  document.body.appendChild(a); a.click(); a.remove();
}

// ─── tabs ──────────────────────────────────────────────────
document.querySelectorAll('.dash-btn[data-view]').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('.dash-btn[data-view]').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active'); dashView=btn.dataset.view; sortKey=null; renderMain();
  });
});

// ─── animate on scroll ─────────────────────────────────────
const observer=new IntersectionObserver((entries)=>{entries.forEach(e=>{if(e.isIntersecting)e.target.classList.add('visible');});},{threshold:0.1});
document.querySelectorAll('.animate-in').forEach(el=>observer.observe(el));

// ─── init ──────────────────────────────────────────────────
loadState();                                   // restore saved portfolios/holdings
renderSidebar(); renderMain(); renderScreener(); calcTax(); renderLiveBar();
refreshPrices();                               // pull live prices on load
setInterval(()=>{ if(!document.hidden) refreshPrices(); }, 60000);  // auto-refresh every 60s
