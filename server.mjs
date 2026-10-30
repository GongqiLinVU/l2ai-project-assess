import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {resolveRepository,readSelected} from './lib/github.mjs';
import {analyse,estimate} from './lib/model.mjs';
import {LIMITS} from './lib/evidence.mjs';
const snapshots=new Map();
export function createApp(){return http.createServer(async(req,res)=>{
 const reply=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
 try{
 const host=req.headers.host;if(!/^127\.0\.0\.1:\d+$/.test(host||''))return reply(403,{error:'Local access only'});
 if(req.method==='GET'){
 const routes={'/':'index.html','/app.js':'app.js','/style.css':'style.css'};const file=routes[req.url];if(!file)return reply(404,{error:'Not found'});
 res.writeHead(200,{'Content-Type':file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.js')?'text/javascript':'text/css','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",'Cache-Control':'no-store'});res.end(await readFile(new URL('./public/'+file,import.meta.url)));return;
 }
 if(req.method!=='POST'||req.headers.origin!==`http://${host}`||!req.headers['content-type']?.startsWith('application/json'))return reply(403,{error:'Same-origin JSON requests only'});
 let raw='';for await(const c of req){raw+=c;if(Buffer.byteLength(raw)>25000)return reply(413,{error:'Request too large'});}const body=JSON.parse(raw);
 if(req.url==='/api/resolve'){
 for(const [id,s]of snapshots)if(s.expires<Date.now())snapshots.delete(id);if(snapshots.size>=20)throw Error('Snapshot limit reached; restart or wait 30 minutes');
 const snapshot=await resolveRepository(body.url,body.demo===true);const id=randomUUID();snapshots.set(id,{...snapshot,expires:Date.now()+1800000});return reply(200,{id,...snapshot});
 }
 const snapshot=snapshots.get(body.snapshotId);if(!snapshot||snapshot.expires<Date.now())throw Error('Snapshot expired; load the repository again');
 if(typeof body.focus!=='string'||!body.focus.trim()||body.focus.length>LIMITS.textChars||typeof body.history!=='string'||body.history.length>LIMITS.textChars)throw Error('Focus required; focus and history each limited to 6,000 characters');
 const files=await readSelected(snapshot,body.paths);
 if(req.url==='/api/estimate')return reply(200,{...estimate(files,body.focus,body.history),mode:process.env.MODEL_MODE||'mock',model:process.env.MODEL_NAME||null});
 if(req.url!=='/api/analyse')return reply(404,{error:'Not found'});
 if(process.env.MODEL_MODE==='deepseek'&&body.paidConfirmed!==true)throw Error('Review estimate and confirm paid request first');
 const result=await analyse(files,body.focus,body.history);
 reply(200,{schemaVersion:'l2ai-assess.v1',repository:snapshot.repository,commitSha:snapshot.sha,source:snapshot.source,retrievedAt:snapshot.retrievedAt,focus:body.focus,history:body.history,files,unread:snapshot.files.filter(f=>!body.paths.includes(f.path)).map(f=>f.path),excludedEntries:snapshot.excludedEntries,...result});
 }catch(e){reply(400,{error:e.message||'Request failed'});}
 });}
if(process.argv[1]===new URL(import.meta.url).pathname){const port=Number(process.env.PORT||3400);createApp().listen(port,'127.0.0.1',()=>console.log(`L2AI Project Assess: http://127.0.0.1:${port} (mode ${process.env.MODEL_MODE||'mock'})`));}
