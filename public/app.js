const $=id=>document.getElementById(id);
// record: the in-browser interview working copy. New fields for persistence:
//   interviewId, version  -> identify + optimistic concurrency for the saved row
//   runId                 -> which analysis_run the current answers belong to
//   runs                  -> [{id,runNumber,model,createdAt}] for the run selector
//   analysisToken         -> server-authoritative handle for a freshly prepared run
//                            (null once the run is persisted / reopened)
let snapshot=null,record=null,busy=false,estimateKey=null;
let dirty=false;               // unsaved teacher edits present
let saveState='none';          // none|unsaved|saving|saved|failed|conflict
const node=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
function status(message,error=false){$('status').textContent=message;$('status').className=error?'error':'';}
async function api(path,data){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const d=await r.json();if(!r.ok){const e=Error(d.error||'Request failed');e.status=r.status;throw e;}return d;}

function controls(){for(const e of document.querySelectorAll('#repo, #filter, #focus, #history, #files input'))e.disabled=busy||e.dataset.available==='false';for(const id of ['load','demo','analyse','estimate'])$(id).disabled=busy||(['analyse','estimate'].includes(id)&&!snapshot);$('save').disabled=busy||!record;}
async function task(fn){if(busy)return;busy=true;controls();try{await fn();}catch(e){status(e.message,true);}finally{busy=false;controls();}}

function setSaveState(s,msg){saveState=s;const el=$('save-state');el.className='savestate '+(s==='none'?'':s);el.textContent=msg||({none:'',unsaved:'Unsaved',saving:'Saving…',saved:'Saved',failed:'Save failed',conflict:'Conflict — reopen'}[s]||'');}
function markDirty(){if(!record)return;dirty=true;if(saveState!=='unsaved')setSaveState('unsaved');}

function invalidate(){
 if(!confirmDiscardUnsaved())return false;
 record=null;dirty=false;setSaveState('none');$('interview').hidden=true;$('runbar').hidden=true;estimateKey=null;$('paid').hidden=true;$('paid-confirm').checked=false;$('budget').hidden=true;
 document.querySelectorAll('.ilist-item.active').forEach(e=>e.classList.remove('active'));
 return true;
}
function confirmDiscardUnsaved(){if(dirty&&record){return window.confirm('You have unsaved edits that will be lost. Continue without saving?');}return true;}

function payload(){return {snapshotId:snapshot?.id,paths:[...document.querySelectorAll('#files input:checked')].map(e=>e.value),focus:$('focus').value,history:$('history').value};}
function renderFiles(){const filter=$('filter').value.toLowerCase();for(const label of $('files').children)label.hidden=!label.dataset.path.toLowerCase().includes(filter);$('counts').textContent=`${document.querySelectorAll('#files input:checked').length}/5 selected · ${snapshot.files.length} eligible files · ${snapshot.excludedEntries} excluded tree entries. ${snapshot.demo?'Offline demo includes content for 3 files only.':''}`;}

async function load(demo){if(!invalidate())return;snapshot=null;$('selection').hidden=true;controls();status('Resolving a fixed repository version…');const d=await api('/api/resolve',{url:$('repo').value,demo});snapshot=d;$('snapshot').textContent=`${d.repository} @ ${d.sha} · ${d.source} · ${d.retrievedAt}`;$('files').replaceChildren();for(const f of d.files){const label=node('label');label.dataset.path=f.path;const c=node('input');c.type='checkbox';c.value=f.path;c.disabled=!f.available;c.dataset.available=String(f.available);label.append(c,node('span',`${f.path} (${f.size} bytes)${!f.available?' · not cached':''}`));if(demo&&f.available)c.checked=true;c.addEventListener('change',()=>{if(!invalidate()){c.checked=!c.checked;return;}renderFiles();});$('files').append(label);}$('selection').hidden=false;renderFiles();status('Snapshot pinned. Choose files and review your assessment focus.');}

$('repo-form').onsubmit=e=>{e.preventDefault();task(()=>load(false));};$('demo').onclick=()=>task(()=>load(true));$('filter').oninput=renderFiles;
for(const id of ['repo','focus','history'])$(id).addEventListener('input',()=>{if(!invalidate()){return;}if(id==='repo'){snapshot=null;$('selection').hidden=true;$('snapshot').textContent='Repository URL changed; load a new snapshot.';controls();}});

$('estimate').onclick=()=>task(async()=>{const p=payload();const d=await api('/api/estimate',p);$('budget').textContent=JSON.stringify(d,null,2);$('budget').hidden=false;estimateKey=JSON.stringify(p);$('paid').hidden=d.mode!=='deepseek';status('Estimate prepared. Unknown prices remain unknown.');});

function ref(c){const wrap=node('div');const link=node('a',`${c.path}:${c.startLine}–${c.endLine}`);link.href=`https://github.com/${record.repository}/blob/${record.commitSha}/${c.path.split('/').map(encodeURIComponent).join('/')}#L${c.startLine}-L${c.endLine}`;link.target='_blank';link.rel='noopener noreferrer';wrap.append(link,node('blockquote',c.quote));return wrap;}

// Render the full interview UI from a record. `responses` optionally pre-fills
// teacher-editable fields (used when reopening a saved run).
function renderInterview(responsesByQid){
 const d=record;
 $('understanding').textContent=d.analysis.summary;
 $('model').textContent=`${d.model.mode==='mock'?'MOCK · simulated analysis':'Model draft · teacher review required'} | ${d.model.name} | ${d.model.analysedAt} | tokens: ${d.model.usage?JSON.stringify(d.model.usage):'not available'} | USD: ${d.model.costUsd??'unknown'}`;
 $('observations').replaceChildren();
 for(const o of d.analysis.observations){const card=node('div',undefined,'card');card.append(node('span',o.kind,'pill'),node('p',o.text),ref(o.evidence));$('observations').append(card);}
 $('questions').replaceChildren();
 d.analysis.questions.forEach((q,i)=>{
  const qid=q.qid||('q'+(i+1));
  const pre=responsesByQid?.[qid];
  const card=node('article',undefined,'card');
  const label=node('label',`Question ${i+1}`);label.htmlFor='q'+i;
  const input=node('textarea');input.id='q'+i;input.rows=2;input.value=(pre&&pre.editedQuestion)?pre.editedQuestion:q.text;input.maxLength=6000;input.dataset.qid=qid;input.dataset.original=q.text;
  const editedNote=node('p','Original model rationale and references below.','muted');
  const refreshNote=()=>{editedNote.textContent=input.value===q.text?'Original model rationale and references below.':'Edited by teacher. Review whether the original rationale and references still fit this question.';};
  input.addEventListener('input',()=>{refreshNote();markDirty();});refreshNote();
  card.append(label,input,editedNote,node('p','Why ask: '+q.why),node('p','Want to understand: '+q.intent));
  q.evidence.forEach(c=>card.append(ref(c)));
  const answerLabel=node('label','Student self-report · teacher-entered');answerLabel.htmlFor='a'+i;
  const answer=node('textarea');answer.id='a'+i;answer.rows=3;answer.maxLength=12000;answer.placeholder='Record the student’s answer. It is not verified by the materials.';if(pre)answer.value=pre.studentSelfReport||'';answer.addEventListener('input',markDirty);
  const verifyLabel=node('label','Teacher verification / unresolved points');verifyLabel.htmlFor='v'+i;
  const verify=node('textarea');verify.id='v'+i;verify.rows=2;verify.maxLength=12000;verify.placeholder='What supports or conflicts with the answer? What do you need to check?';if(pre)verify.value=pre.teacherVerification||'';verify.addEventListener('input',markDirty);
  card.append(answerLabel,answer,verifyLabel,verify);
  $('questions').append(card);
 });
 $('limitations').replaceChildren(...d.analysis.limitations.map(v=>node('li',v)));
 $('interview').hidden=false;
}

function renderRunBar(){
 const runs=record.runs||[];
 if(runs.length<=0){$('runbar').hidden=true;return;}
 const sel=$('run-select');sel.replaceChildren();
 runs.forEach(r=>{const o=node('option',`Run ${r.runNumber} · ${r.model?.mode||'?'} · ${new Date(r.createdAt).toLocaleString()}`);o.value=r.id;sel.append(o);});
 if(record.runId)sel.value=record.runId;
 $('run-note').textContent=runs.length>1?'Selecting another run loads its questions and recorded answers. Each run keeps its own answers.':'This interview has one analysis run.';
 $('runbar').hidden=false;
}

// Prepare an interview = a fresh preparation that becomes run 1 of a NEW saved
// interview. Re-analysis that adds a run to an existing interview is supported by
// the server/API (and tested), but is not a one-click UI action in this iteration
// because generating a run requires reloading source after a restart; exposing it
// ambiguously risks mis-attaching or overwriting work. Earlier runs of an
// interview that has several are still selectable/inspectable via the run bar.
$('analyse').onclick=()=>task(async()=>{
 const p=payload();p.paidConfirmed=$('paid-confirm').checked&&estimateKey===JSON.stringify(p);
 if(!invalidate())return;
 status('Reading selected text and preparing questions…');
 const d=await api('/api/analyse',p);
 record={...d,analysis:structuredClone(d.analysis),interviewStartedAt:new Date().toISOString(),interviewId:null,version:null,runId:null,runs:[],analysisToken:d.analysisToken,idempotencyKey:undefined};
 $('title').value='';
 renderInterview(null);renderRunBar();dirty=false;setSaveState('unsaved');
 $('review').value='';
 controls();status('Interview ready. Add a title, edit questions, record answers, then Save.');$('interview').scrollIntoView({behavior:'smooth'});
});

$('title').addEventListener('input',markDirty);
$('review').addEventListener('input',markDirty);

// Collect teacher-editable responses from the DOM for saving/export.
function collectResponses(){return record.analysis.questions.map((q,i)=>({questionId:q.qid||('q'+(i+1)),originalQuestion:q.text,editedQuestion:$('q'+i).value,studentSelfReport:$('a'+i).value,teacherVerification:$('v'+i).value}));}

// Save to the local database. Visible failure states; never reports saved early.
$('save').onclick=()=>task(async()=>{
 if(!record)throw Error('Prepare or open an interview first.');
 const title=$('title').value.trim();
 if(!title)throw Error('Enter an interview title before saving.');
 setSaveState('saving');status('Saving to local database…');
 const body={title,focus:record.focus,history:record.history||'',teacherReview:$('review').value,responses:collectResponses()};
 if(record.interviewId){body.interviewId=record.interviewId;body.expectedVersion=record.version;body.runId=record.runId;}
 if(record.analysisToken){body.analysisToken=record.analysisToken;}
 if(!record.idempotencyKey)record.idempotencyKey=crypto.randomUUID();
 if(!record.interviewId)body.idempotencyKey=record.idempotencyKey;
 try{
  const saved=await api('/api/save',body);
  applySaved(saved);
  dirty=false;setSaveState('saved');status(`Saved. Interview "${saved.interview.title}" (version ${saved.interview.version}).`);
  refreshList();
 }catch(e){
  if(e.status===409){setSaveState('conflict');status(e.message,true);}
  else{setSaveState('failed');status('Save failed: '+e.message+' Your edits remain in this tab.',true);}
 }
});

// Adopt an authoritative saved/opened record into the working copy.
function applySaved(saved){
 const ev=saved.evidence,run=saved.selectedRun;
 record={
  schemaVersion:'l2ai-assess.v1',
  repository:ev.repository,commitSha:ev.commitSha,source:ev.source,retrievedAt:ev.retrievedAt,
  files:ev.files,unread:ev.unread,excludedEntries:ev.excludedEntries,
  focus:saved.interview.focus,history:saved.interview.history,
  analysis:structuredClone(run.analysis),model:run.model,
  interviewId:saved.interview.id,version:saved.interview.version,
  runId:run.id,runs:saved.runs,analysisToken:null,
  idempotencyKey:record?.idempotencyKey
 };
 $('title').value=saved.interview.title;
 $('review').value=saved.interview.teacherReview||'';
 const byQid={};for(const r of run.responses)byQid[r.questionId]=r;
 renderInterview(byQid);renderRunBar();
}

// ---- Saved interviews library ----
async function refreshList(){
 try{
  const d=await api('/api/interviews',{});
  const list=$('interviews');list.replaceChildren();
  if(!d.interviews.length){list.append(node('p','No saved interviews yet.','muted'));return;}
  d.interviews.forEach(it=>{
   const row=node('div',undefined,'ilist-item');row.dataset.id=it.id;
   if(record&&record.interviewId===it.id)row.classList.add('active');
   row.append(node('span',it.title),node('span',`${it.repository||'—'} · ${it.commitSha?it.commitSha.slice(0,8):'no evidence'} · ${it.runCount} run(s) · v${it.version} · ${new Date(it.updatedAt).toLocaleString()}`,'meta'));
   row.onclick=()=>openInterview(it.id);
   list.append(row);
  });
 }catch(e){$('interviews').replaceChildren(node('p','Could not load saved interviews: '+e.message,'muted'));}
}
$('refresh-list').onclick=()=>task(refreshList);

async function openInterview(id,runId){task(async()=>{
 if(!invalidate())return;
 status('Opening saved interview…');
 const saved=await api('/api/open',{interviewId:id,runId:runId||null});
 applySaved(saved);
 dirty=false;setSaveState('saved');
 controls();refreshList();
 status(`Opened "${saved.interview.title}". Continue editing, then Save.`);
 $('interview').scrollIntoView({behavior:'smooth'});
});}

$('run-select').onchange=()=>{const id=$('run-select').value;if(record&&id&&id!==record.runId){if(!confirmDiscardUnsaved()){$('run-select').value=record.runId;return;}openInterview(record.interviewId,id);}};

$('new-interview').onclick=()=>{if(!invalidate())return;snapshot=null;$('selection').hidden=true;$('snapshot').textContent='';$('title').value='';$('review').value='';controls();status('Started a new interview. Load a repository snapshot to begin.');window.scrollTo({top:0,behavior:'smooth'});};

// ---- Export (unchanged substance; now labels unsaved edits and ids) ----
function exportRecord(){if(!record)throw Error('Prepare an interview first');return {
 schemaVersion:record.schemaVersion,repository:record.repository,commitSha:record.commitSha,source:record.source,retrievedAt:record.retrievedAt,
 focus:record.focus,history:record.history,files:record.files,unread:record.unread,excludedEntries:record.excludedEntries,
 analysis:record.analysis,model:record.model,
 interviewId:record.interviewId||null,analysisRunId:record.runId||null,
 persistence:record.interviewId?(dirty?'Saved record WITH unsaved edits included in this export':'Saved record; export matches last save'):'Not saved to database; export only',
 unsavedEdits:!!dirty&&!!record.interviewId,
 exportedAt:new Date().toISOString(),teacherReview:$('review').value,
 interview:record.analysis.questions.map((q,i)=>({qid:q.qid||('q'+(i+1)),originalQuestion:q.text,question:$('q'+i).value,edited:$('q'+i).value!==q.text,why:q.why,intent:q.intent,materialBasis:q.evidence,studentSelfReport:$('a'+i).value,teacherVerification:$('v'+i).value,verificationStatus:'Teacher judgement required; no automatic corroboration'})),
 evidencePolicy:'Material-supported excerpts, model interpretations, student self-reports and teacher review are separate. No authorship or contribution conclusion. Question references do not verify an answer.'};}

function markdown(r){const cite=c=>`[${c.path}:${c.startLine}-${c.endLine}](https://github.com/${r.repository}/blob/${r.commitSha}/${c.path.split('/').map(encodeURIComponent).join('/')}#L${c.startLine}-L${c.endLine})\n\n${c.quote.split('\n').map(l=>'> '+l).join('\n')}`;return [`# L2AI Project Assess interview record`, `Mode: ${r.model.mode} | model: ${r.model.name}`,`Interview id: ${r.interviewId||'unsaved'} | Analysis run: ${r.analysisRunId||'unsaved'} | Persistence: ${r.persistence}`,`Repository: https://github.com/${r.repository}\n\nCommit: ${r.commitSha}\n\nSource: ${r.source}\n\nAnalysed: ${r.model.analysedAt}\n\nExported: ${r.exportedAt}`,`## Selected files\n${r.files.map(f=>`- ${f.path} | blob ${f.blobSha} | SHA-256 ${f.sha256}`).join('\n')}`,`## Assessment focus\n${r.focus}`,`## Historical context (unverified pasted text)\n${r.history||'Not supplied'}`,`## Provisional understanding\n${r.analysis.summary}`,`## Material-supported observations\n${r.analysis.observations.map(o=>`### ${o.kind}\n${o.text}\n\n${cite(o.evidence)}`).join('\n\n')}`,`## Interview\n${r.interview.map((q,i)=>`### ${i+1}. ${q.question}\n\nOriginal model prompt: ${q.originalQuestion}\n\nEdited: ${q.edited}\n\nWhy: ${q.why}\n\nIntent: ${q.intent}\n\nOriginal material basis (review for edited prompts; does not verify answer):\n${q.materialBasis.map(cite).join('\n\n')}\n\n**Student self-report:**\n${q.studentSelfReport||'No answer recorded'}\n\n**Teacher verification / pending:**\n${q.teacherVerification||'Not reviewed'}`).join('\n\n')}`,`## Teacher review and follow-up\n${r.teacherReview||'Not recorded'}`,`## Limitations\n${r.analysis.limitations.map(v=>'- '+v).join('\n')}`,`## Unread eligible files\n${r.unread.map(v=>'- '+v).join('\n')}\n\nExcluded tree entries: ${r.excludedEntries}`,`## Model metadata\n\`\`\`json\n${JSON.stringify(r.model,null,2)}\n\`\`\``,r.evidencePolicy].join('\n\n');}

function download(type){const r=exportRecord();const b=new Blob([type==='json'?JSON.stringify(r,null,2):markdown(r)],{type:type==='json'?'application/json':'text/markdown'});const a=node('a');a.href=URL.createObjectURL(b);a.download=`l2ai-interview-${r.commitSha.slice(0,8)}.${type==='json'?'json':'md'}`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);status(r.unsavedEdits?'Export downloaded. It INCLUDES unsaved edits; use Save to persist them.':'Export downloaded. JSON includes selected source text for later review.');}
$('json').onclick=()=>download('json');$('markdown').onclick=()=>download('markdown');

// Database availability banner + initial library load.
(async()=>{try{const h=await api('/api/db/health',{});if(!h.enabled){$('db-state').textContent='Persistence off (no DATABASE_URL). Interviews stay in this tab only.';$('save').disabled=true;}else if(!h.ok){$('db-state').textContent='Database unreachable — saving will fail until it is available.';}else{$('db-state').textContent='Local database connected.';refreshList();}}catch(e){$('db-state').textContent='Persistence health check failed.';}})();

window.addEventListener('beforeunload',e=>{if(record&&dirty){e.preventDefault();e.returnValue='';}});
