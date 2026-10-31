import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {resolveRepository,readSelected} from './lib/github.mjs';
import {analyse,estimate} from './lib/model.mjs';
import {LIMITS} from './lib/evidence.mjs';
import {saveInterview,listInterviews,openInterview,ping,createDraft,getDraft,pruneDrafts,ConflictError,NotFoundError,ValidationError} from './lib/db.mjs';

const snapshots=new Map();
// Server-authoritative analysis results. /api/analyse mints a token here; /api/save
// reads evidence, validated analysis and provenance from this cache instead of
// trusting browser-submitted source text or model metadata. Entries expire with
// the snapshots they were derived from. When persistence is enabled the same
// payload is ALSO written to a durable analysis_draft so the first save survives
// token expiry or an application restart (Finding 4).
const analyses=new Map();
const DB_ENABLED=!!process.env.DATABASE_URL;

// Assign stable question ids so saved responses bind to a question, never to an
// array position. Deterministic per run from the validated analysis order.
function withQids(analysis){
 return {...analysis,questions:analysis.questions.map((q,i)=>({...q,qid:q.qid||('q'+(i+1))}))};
}

export function createApp(){return http.createServer(async(req,res)=>{
 const reply=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
 const fail=(e)=>{const status=e instanceof ConflictError?409:e instanceof NotFoundError?404:e instanceof ValidationError?400:400;reply(status,{error:e.message||'Request failed'});};
 try{
 const host=req.headers.host;if(!/^127\.0\.0\.1:\d+$/.test(host||''))return reply(403,{error:'Local access only'});
 if(req.method==='GET'){
 const routes={'/':'index.html','/app.js':'app.js','/style.css':'style.css'};const file=routes[req.url];if(!file)return reply(404,{error:'Not found'});
 res.writeHead(200,{'Content-Type':file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.js')?'text/javascript':'text/css','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",'Cache-Control':'no-store'});res.end(await readFile(new URL('./public/'+file,import.meta.url)));return;
 }
 if(req.method!=='POST'||req.headers.origin!==`http://${host}`||!req.headers['content-type']?.startsWith('application/json'))return reply(403,{error:'Same-origin JSON requests only'});
 // Persistence payloads carry server-validated source text; allow a larger body
 // than analysis requests, but still bounded.
 const limit=(req.url==='/api/save')?400000:25000;
 let raw='';for await(const c of req){raw+=c;if(Buffer.byteLength(raw)>limit)return reply(413,{error:'Request too large'});}const body=JSON.parse(raw);

 // ---- Persistence endpoints ----
 if(req.url==='/api/db/health')return reply(200,{enabled:DB_ENABLED,ok:DB_ENABLED?await ping().then(()=>true).catch(()=>false):false});
 if(req.url==='/api/interviews'){if(!DB_ENABLED)throw Error('Persistence is not configured (set DATABASE_URL).');return reply(200,{interviews:await listInterviews()});}
 if(req.url==='/api/open'){if(!DB_ENABLED)throw Error('Persistence is not configured (set DATABASE_URL).');if(typeof body.interviewId!=='string')throw Error('interviewId required');return reply(200,await openInterview(body.interviewId,typeof body.runId==='string'?body.runId:null));}
 if(req.url==='/api/save')return await handleSave(body,reply);

 if(req.url==='/api/resolve'){
 for(const [id,s]of snapshots)if(s.expires<Date.now()){snapshots.delete(id);}
 for(const [t,a]of analyses)if(a.expires<Date.now())analyses.delete(t);
 if(snapshots.size>=20)throw Error('Snapshot limit reached; restart or wait 30 minutes');
 const snapshot=await resolveRepository(body.url,body.demo===true);const id=randomUUID();snapshots.set(id,{...snapshot,expires:Date.now()+1800000});return reply(200,{id,...snapshot});
 }
 const snapshot=snapshots.get(body.snapshotId);if(!snapshot||snapshot.expires<Date.now())throw Error('Snapshot expired; load the repository again');
 if(typeof body.focus!=='string'||!body.focus.trim()||body.focus.length>LIMITS.textChars||typeof body.history!=='string'||body.history.length>LIMITS.textChars)throw Error('Focus required; focus and history each limited to 6,000 characters');
 const files=await readSelected(snapshot,body.paths);
 if(req.url==='/api/estimate')return reply(200,{...estimate(files,body.focus,body.history),mode:process.env.MODEL_MODE||'mock',model:process.env.MODEL_NAME||null});
 if(req.url!=='/api/analyse')return reply(404,{error:'Not found'});
 if(process.env.MODEL_MODE==='deepseek'&&body.paidConfirmed!==true)throw Error('Review estimate and confirm paid request first');
 const result=await analyse(files,body.focus,body.history);
 const analysis=withQids(result.analysis);
 const unread=snapshot.files.filter(f=>!body.paths.includes(f.path)).map(f=>f.path);
 // Authoritative evidence + analysis for a possible save. Minted per analysis.
 const analysisToken=randomUUID();
 const evidence={repository:snapshot.repository,commitSha:snapshot.sha,source:snapshot.source,retrievedAt:snapshot.retrievedAt,files,unread,excludedEntries:snapshot.excludedEntries};
 const runInputs={focus:body.focus,history:body.history,paths:[...body.paths]};
 analyses.set(analysisToken,{evidence,analysis,model:result.model,runInputs,expires:Date.now()+1800000});
 // Durable draft so the FIRST save works after token expiry / restart (Finding 4).
 // Evidence and analysis stay server-authoritative; the draft is the server's own
 // copy, not browser-submitted. Pruned opportunistically.
 let draftId=null;
 if(DB_ENABLED){try{pruneDrafts().catch(()=>{});draftId=await createDraft({evidence,analysis,runInputs,model:result.model});}catch(e){draftId=null;}}
 reply(200,{schemaVersion:'l2ai-assess.v1',analysisToken,draftId,...evidence,focus:body.focus,history:body.history,analysis,model:result.model});
 }catch(e){fail(e);}
 });}

// Save handler: evidence/analysis/provenance are taken from the server's own
// authoritative source — the in-memory analysis cache OR the durable draft
// (restart-safe), never from the browser. Only teacher-editable fields are
// accepted from the client. Response question ids are validated against the
// authoritative analysis inside the transaction (lib/db.mjs reconcileResponses).
async function handleSave(body,reply){
 if(!DB_ENABLED)throw Error('Persistence is not configured (set DATABASE_URL).');
 const title=body.title;
 if(typeof title!=='string'||!title.trim()||title.length>200)throw Error('Interview title required (max 200 characters).');
 if(typeof body.focus!=='string'||!body.focus.trim()||body.focus.length>LIMITS.textChars)throw Error('Focus required; max 6,000 characters.');
 if(body.history!==undefined&&(typeof body.history!=='string'||body.history.length>LIMITS.textChars))throw Error('History must be text up to 6,000 characters.');
 if(body.teacherReview!==undefined&&(typeof body.teacherReview!=='string'||body.teacherReview.length>20000))throw Error('Teacher review too long.');

 const payload={
  interviewId:typeof body.interviewId==='string'?body.interviewId:undefined,
  expectedVersion:Number.isInteger(body.expectedVersion)?body.expectedVersion:undefined,
  idempotencyKey:typeof body.idempotencyKey==='string'?body.idempotencyKey:undefined,
  title,focus:body.focus,history:body.history??'',teacherReview:body.teacherReview??'',
  responses:shapeResponses(body.responses)
 };

 // Resolve the authoritative prepared analysis for a NEW run from either the
 // in-memory token or the durable draft (so first save survives restart).
 let auth=null;
 if(body.analysisToken){
  const mem=analyses.get(body.analysisToken);
  if(mem&&mem.expires>=Date.now())auth=mem;
 }
 if(!auth&&typeof body.draftId==='string'){
  const draft=await getDraft(body.draftId);
  if(draft)auth={evidence:draft.evidence,analysis:draft.analysis,runInputs:draft.runInputs,model:draft.model};
 }

 if(auth){
  payload.evidence=auth.evidence;
  payload.run={analysis:auth.analysis,runInputs:auth.runInputs,model:auth.model};
  payload.draftId=typeof body.draftId==='string'?body.draftId:undefined;
 }else if(body.analysisToken||body.draftId){
  throw Error('Analysis draft expired or not found; re-run Prepare interview before saving a new analysis.');
 }else{
  // Saving edits to an already-persisted run without re-analysing.
  payload.runId=typeof body.runId==='string'?body.runId:undefined;
  if(!payload.interviewId)throw Error('Nothing to save: provide an analysisToken/draftId (new run) or an existing interviewId.');
 }
 const saved=await saveInterview(payload);
 reply(200,saved);
}

// Basic shape/length validation only. Authoritative question-id validation and
// original_question derivation happen in lib/db.mjs against the target run.
function shapeResponses(responses){
 if(responses===undefined)return undefined;
 if(!Array.isArray(responses)||responses.length>50)throw Error('Invalid responses.');
 return responses.map(r=>{
  if(typeof r.questionId!=='string'||!r.questionId||r.questionId.length>50)throw Error('Invalid response question id.');
  const field=(v,max)=>{if(v===undefined||v===null)return '';if(typeof v!=='string'||v.length>max)throw Error('Response field too long.');return v;};
  return {
   questionId:r.questionId,
   editedQuestion:field(r.editedQuestion,6000),
   studentSelfReport:field(r.studentSelfReport,12000),
   teacherVerification:field(r.teacherVerification,12000)
  };
 });
}

if(process.argv[1]===new URL(import.meta.url).pathname){const port=Number(process.env.PORT||3400);createApp().listen(port,'127.0.0.1',()=>console.log(`L2AI Project Assess: http://127.0.0.1:${port} (mode ${process.env.MODEL_MODE||'mock'}, persistence ${DB_ENABLED?'on':'off'})`));}
