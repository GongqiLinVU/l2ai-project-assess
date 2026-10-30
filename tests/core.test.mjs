import {test} from 'node:test';
import assert from 'node:assert/strict';
import {repoName,allowed,textFile,validateAnalysis,mockAnalysis} from '../lib/evidence.mjs';
import {resolveRepository,readSelected} from '../lib/github.mjs';
import {analyse} from '../lib/model.mjs';
import {createApp} from '../server.mjs';
const url='https://github.com/GongqiLinVU/milestoneproject';
test('reject SSRF, extra URL parts, secret/dependency/binary/symlink candidates',()=>{
 for(const value of ['http://github.com/a/b','https://evil.test/a/b','https://github.com/a/b/tree/main','https://user@github.com/a/b','https://github.com/a/b?x=1'])assert.throws(()=>repoName(value));
 for(const path of ['.env','src/.env.example','node_modules/a.ts','build/a.js','private_key.json','a.png','../a.ts','package-lock.json'])assert.equal(allowed(path),false,path);
 assert.equal(allowed('src/feature.ts'),true);assert.equal(allowed('README.md',30001),false);
 assert.throws(()=>textFile('a.ts','hello\0world','sha'));assert.throws(()=>textFile('a.ts',"const password = 'longsecretvaluehere'",'sha'));
});
test('real pinned fixture → cited mock, no semantic or authorship claim',async()=>{
 const snapshot=await resolveRepository(url,true);assert.equal(snapshot.sha,'b098b353492c273004ca496cdbf7c0f1e1855dd7');
 const files=await readSelected(snapshot,['README.md','src/intakeStart.ts','tests/ai-session-intake/adaptive/intake-start.test.mjs']);
 assert.ok(files[1].content.includes('intakePriorContext'));assert.ok(files.every(f=>f.sha256.length===64));
 const r=await analyse(files,'Explain continuity and test limits','Previously: discuss the design',{});
 assert.equal(r.model.mode,'mock');assert.equal(r.model.costUsd,0);assert.equal(r.analysis.questions.length,4);assert.match(r.analysis.questions[3].text,/earlier/);
 const bad=structuredClone(r.analysis);bad.observations[0].evidence.quote='made-up quote';assert.throws(()=>validateAnalysis(bad,files));
 const invented=structuredClone(r.analysis);invented.questions[0].evidence[0].path='never-read.ts';assert.throws(()=>validateAnalysis(invented,files));
 const out=structuredClone(r.analysis);out.observations[0].evidence.endLine=999999;assert.throws(()=>validateAnalysis(out,files));
 await assert.rejects(()=>readSelected(snapshot,['.env']));await assert.rejects(()=>readSelected(snapshot,Array(6).fill('README.md')));await assert.rejects(()=>resolveRepository('https://github.com/other/repo',true));
});
test('paid calls blocked without explicit server opt-in; fabricated model citations rejected',async()=>{
 const files=[textFile('a.ts','export const value=1;','abc')];let calls=0;
 const fetcher=async()=>{calls++;return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(mockAnalysis(files,'Explain value',''))}}],usage:{prompt_tokens:10,completion_tokens:20},model:'configured-model'}));};
 await assert.rejects(()=>analyse(files,'focus','',{MODEL_MODE:'deepseek'},fetcher),/Paid calls disabled/);assert.equal(calls,0);
 const env={MODEL_MODE:'deepseek',ENABLE_PAID_CALLS:'true',MODEL_BASE_URL:'https://example.test/v1',MODEL_NAME:'configured-model',MODEL_API_KEY:'synthetic-test-key'};
 const r=await analyse(files,'focus','',env,fetcher);assert.equal(r.model.costUsd,null);assert.equal(r.model.usage.prompt_tokens,10);assert.equal(calls,1);
 const bad=mockAnalysis(files,'focus','');bad.questions[0].evidence[0].quote='false';
 await assert.rejects(()=>analyse(files,'focus','',env,async()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(bad)}}]}))),/quote/);
});
test('live GitHub transport pins branch once and reads only returned blob SHA',async()=>{
 const original=globalThis.fetch;const calls=[];const sha='a'.repeat(40),blob='b'.repeat(40);
 globalThis.fetch=async value=>{calls.push(value);let d;if(value.endsWith('/a/b'))d={private:false,default_branch:'main'};else if(value.includes('/commits/'))d={sha};else if(value.includes('/git/trees/'))d={truncated:false,tree:[{path:'a.ts',type:'blob',mode:'100644',size:5,sha:blob},{path:'link.ts',type:'blob',mode:'120000',size:5,sha:blob}]};else d={encoding:'base64',size:5,content:Buffer.from('hello').toString('base64')};return new Response(JSON.stringify(d));};
 try{const s=await resolveRepository('https://github.com/a/b');assert.equal(s.sha,sha);assert.equal(s.files.length,1);assert.equal((await readSelected(s,['a.ts']))[0].content,'hello');assert.ok(calls[2].includes(sha));assert.ok(calls[3].endsWith(blob));}finally{globalThis.fetch=original;}
});
test('HTTP flow handles snapshot selection, mock record, origin and input validation',async()=>{
 const app=createApp();await new Promise(r=>app.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.address().port;
 const post=(route,data,origin=base)=>fetch(base+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(data)});
 try{
 assert.equal((await post('/api/resolve',{url,demo:true},'https://evil.test')).status,403);
 const snap=await (await post('/api/resolve',{url,demo:true})).json();assert.ok(snap.id);
 const body={snapshotId:snap.id,paths:['src/intakeStart.ts'],focus:'Design and testing',history:''};
 const budget=await (await post('/api/estimate',body)).json();assert.equal(budget.estimatedMaxUsd,null);
 const r=await post('/api/analyse',body);assert.equal(r.status,200);const record=await r.json();assert.equal(record.commitSha,snap.sha);assert.equal(record.files.length,1);assert.ok(record.unread.includes('README.md'));assert.equal(record.model.mode,'mock');
 assert.equal((await post('/api/analyse',{...body,focus:''})).status,400);
 assert.equal((await post('/api/analyse',{...body,snapshotId:'forged'})).status,400);
 assert.equal((await post('/api/analyse',{...body,paths:['missing.ts']})).status,400);
 }finally{await new Promise(r=>app.close(r));}
});
