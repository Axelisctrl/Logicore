const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let convs=[],cur=null,busy=false,live='',mem=[];
const COL={'CORRECT':'--ok','PARTIALLY CORRECT':'--part','INCORRECT':'--bad','INCONCLUSIVE':'--unk'},col=v=>`var(${COL[String(v).toUpperCase()]||'--unk'})`;
const C=()=>convs.find(c=>c.id===cur);
function load(){try{return JSON.parse(localStorage.getItem('lc_convs'))||[]}catch{return mem}}
function persist(){mem=convs;try{localStorage.setItem('lc_convs',JSON.stringify(convs))}catch{}}
function code(v){try{return v===undefined?sessionStorage.getItem('lc_code'):sessionStorage.setItem('lc_code',v)}catch{}}
async function api(url,body,retry=true){
  const hd={'content-type':'application/json'},k=code();if(k)hd['x-access-code']=k;
  let r,j;try{r=await fetch(url,{method:'POST',headers:hd,body:JSON.stringify(body)});j=await r.json()}catch{throw new Error('Could not reach the server. Check your connection and try again.')}
  if(r.status===401&&j.code==='access'&&retry){const c=prompt('Access code');if(c){code(c);return api(url,body,false)}}
  if(!r.ok)throw new Error(j.error||'Request failed ('+r.status+')');return j}
function newConv(){const c={id:Date.now()+'',title:'New conversation',messages:[]};convs.unshift(c);cur=c.id;persist();draw()}
function draw(){
  $('#list').innerHTML=convs.map(c=>`<div class="ci ${c.id===cur?'on':''}" data-id="${c.id}"><span>${esc(c.title)}</span><b data-del="${c.id}" title="Delete">×</b></div>`).join('');
  const c=C(),box=$('#msgs');
  if(!c||!c.messages.length){box.innerHTML='<div class="empty"><h2>What are we working on?</h2><p>Chat as usual. Press Verify Answer under any reply, or type “verify this answer”, to get a structured logic report.</p></div>';return}
  box.innerHTML=c.messages.map((m,i)=>{
    if(m.kind==='report')return `<div class="m"><div class="card" style="border-left-color:${col(m.report.verdict)}"><div><div class="who">LOGICORE verification</div><span class="chip" style="background:${col(m.report.verdict)}">${esc(m.report.verdict)}</span></div><button class="vb" data-rep="${i}">Open report</button></div></div>`;
    if(m.kind==='error')return `<div class="m"><div class="err">${esc(m.content)}</div></div>`;
    const v=m.role==='assistant'&&!m.kind?`<button class="vb" data-ver="${i}" ${busy?'disabled':''}>Verify Answer</button>`:'';
    return `<div class="m ${m.role}"><div class="who">${m.role==='user'?'You':'LOGICORE'}</div><div class="t">${esc(m.content)}</div>${v}</div>`}).join('')
   +(busy?`<div class="m assistant"><div class="who">LOGICORE</div><div class="t">${live?esc(live):'<span class="dots">Working…</span>'}</div></div>`:'');
  box.scrollTop=box.scrollHeight}
function chatInput(c){const h=[];
  for(const m of c.messages.filter(m=>!m.kind)){const l=h[h.length-1];if(l&&l.role===m.role)l.content+='\n\n'+m.content;else h.push({role:m.role,content:m.content})}
  return h}
async function run(fn){busy=true;live='';draw();try{await fn()}catch(e){C().messages.push({kind:'error',content:'Error: '+e.message})}busy=false;live='';persist();draw()}
const INTENT=/^\s*(verify|check the logic|check this logic|is this argument valid|examine the reasoning|find logical mistakes|apply logicore)|verify whether/i;
function lastAnswer(c){for(let i=c.messages.length-1;i>=0;i--){const m=c.messages[i];if(m.role==='assistant'&&!m.kind)return i}return -1}
function prelimChecks(t){const out=[],w=t.trim().split(/\s+/).filter(Boolean).length;
  if(w<4)out.push('Very short input: little reasoning to examine.');
  const ab=[...new Set((t.match(/\b(always|never|all|none|everyone|nobody|proves?|impossible|certainly|guaranteed)\b/gi)||[]).map(x=>x.toLowerCase()))];
  if(ab.length)out.push('Absolute wording found ('+ab.join(', ')+'): check whether the claim is overstated.');
  const re=/(\d+(?:\.\d+)?)\s*([+\-*\/×x÷])\s*(\d+(?:\.\d+)?)\s*=\s*(\d+(?:\.\d+)?)/g;let m;
  while((m=re.exec(t))){const a=+m[1],b=+m[3],o=m[2],v=o==='+'?a+b:o==='-'?a-b:(o==='*'||o==='×'||o==='x')?a*b:a/b;
    out.push(Math.abs(v-+m[4])<1e-9*Math.max(1,Math.abs(v))?`Arithmetic OK: ${m[0]}`:`Arithmetic mismatch: ${m[0]} (computed ${+v.toFixed(6)})`)}
  if(!out.length)out.push('No pattern-level issues found. This says nothing about the reasoning itself.');return out}
async function verifyText(q,a,source,ctx){const prelim=prelimChecks(a);
  const report=await api('/api/verify',{question:q,answer:a,source:source||'',context:ctx||''});
  Object.assign(report,{original:a,question:q,source:source||'',prelim});C().messages.push({kind:'report',report});openRep(report)}
async function verifyMsg(i){const c=C(),m=c.messages[i];let q='(no earlier question)';
  for(let j=i-1;j>=0;j--)if(c.messages[j].role==='user'&&!c.messages[j].kind){q=c.messages[j].content;break}
  const ctx=c.messages.slice(Math.max(0,i-7),i-1).filter(x=>!x.kind).map(x=>(x.role==='user'?'User: ':'Assistant: ')+x.content.slice(0,400)).join('\n');
  await verifyText(q,m.content,'',ctx)}
async function send(){const t=$('#in').value.trim();if(!t||busy)return;$('#in').value='';const c=C();
  if(c.title==='New conversation')c.title=t.slice(0,40);
  if(INTENT.test(t)){const li=lastAnswer(c);c.messages.push({kind:'cmd',role:'user',content:t});
    if(t.length>=90)return run(()=>verifyText('(argument submitted by the user)',t,'',''));
    if(li<0){c.messages.push({kind:'error',content:'There is no answer to verify yet. Ask something first, or paste an argument after “verify”.'});persist();return draw()}
    return run(()=>verifyMsg(li))}
  c.messages.push({role:'user',content:t});
  await run(async()=>{const r=await api('/api/chat',{messages:chatInput(c)});c.messages.push({role:'assistant',content:r.text})})}
const sec=(h,b)=>`<h3>${h}</h3><p>${esc(b)}</p>`;
function openRep(r){$('#repin').innerHTML=`<button class="cl" id="cx" aria-label="Close report">×</button>${r.source?`<p class="note" style="margin:0 0 6px">Answer produced by ${esc(r.source)}</p>`:''}${r.question&&r.question[0]!=='('?`<b>Original question</b><div class="orig" style="margin:6px 0 12px;max-height:100px">${esc(r.question)}</div>`:''}<b>Original answer</b><div class="orig" style="margin-top:6px">${esc(r.original)}</div>
<div class="pre"><b>Preliminary automated checks</b> (simple pattern scan, no AI, not a verification)<ul>${(r.prelim||[]).map(x=>`<li>${esc(x)}</li>`).join('')}</ul></div>
<div class="ind">Completed AI verification: LOGICORE’s independent assessment, separate from the original answer above</div>
<p class="note">Evidence stage used the model’s own knowledge only. No external fact-check was performed.</p>
${r.claims?sec('Main claims of the answer',r.claims):''}${sec('Linguistic analysis',r.linguistic)}${sec('Contextual analysis',r.contextual)}${sec('Relevant disciplines',r.disciplines)}${sec('Identified premises',r.premises)}${sec('Identified conclusions',r.conclusions)}${sec('Logical reconstruction',r.reconstruction)}${sec('Logical validity',r.validity)}${sec('Detected errors and contradictions',r.errors)}${sec('Evidence assessment',r.evidence)}${sec('Corrected answer',r.corrected)}
<h3>Final verdict</h3><span class="chip" style="background:${col(r.verdict)}">${esc(r.verdict)}</span><p style="margin-top:8px">${esc(r.verdict_explanation)}</p>`;
  $('#rep').classList.add('open');$('#cx').onclick=()=>$('#rep').classList.remove('open')}
$('#msgs').onclick=e=>{const t=e.target;if(t.dataset.ver&&!busy)run(()=>verifyMsg(+t.dataset.ver));if(t.dataset.rep)openRep(C().messages[+t.dataset.rep].report)};
$('#list').onclick=e=>{const d=e.target.dataset.del;
  if(d){convs=convs.filter(c=>c.id!==d);if(cur===d)cur=convs[0]&&convs[0].id;if(!convs.length)return newConv();persist();return draw()}
  const el=e.target.closest('.ci');if(el){cur=el.dataset.id;$('#side').classList.remove('show');draw()}};
$('#nw').onclick=()=>{newConv();$('#side').classList.remove('show')};$('#send').onclick=send;$('#mb').onclick=()=>$('#side').classList.toggle('show');
$('#in').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}};
$('#ext').onclick=()=>{$('#side').classList.remove('show');$('#xd').showModal()};$('#xc').onclick=()=>$('#xd').close();
$('#xv').onclick=()=>{if(busy)return;const q=$('#xq').value.trim(),a=$('#xa').value.trim(),src=$('#xs').value;
  if(!q||!a){$('#xe').textContent='Add both the original question and the AI answer.';return}
  $('#xe').textContent='';$('#xd').close();C().messages.push({kind:'cmd',role:'user',content:`Verify this ${src} answer.\n\nQuestion: ${q}`});
  $('#xq').value=$('#xa').value='';run(()=>verifyText(q,a,src,''))};
convs=load();if(convs.length)cur=convs[0].id;else newConv();draw();
