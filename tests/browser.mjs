// Executes this app only. Never executes fetched repository code.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createApp} from '../server.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const app=createApp();await new Promise(r=>app.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.address().port;
let browser;
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);await page.getByRole('button',{name:'Use offline demo',exact:true}).click();await page.getByText(/3\/5 selected/).waitFor();
 await page.locator('#history').fill('S1 rehearsal: student planned to separate prior context from current progress. Synthetic history, not a real student record.');
 await page.getByRole('button',{name:'Estimate model usage'}).click();await page.locator('#budget').waitFor();assert.match(await page.locator('#budget').innerText(),/estimatedMaxUsd/);
 await page.getByRole('button',{name:'Prepare interview',exact:true}).click();await page.locator('#interview').waitFor();assert.match(await page.locator('#model').innerText(),/MOCK/);assert.equal(await page.locator('#questions article').count(),4);
 const refs=await page.locator('#observations a').evaluateAll(es=>es.map(e=>e.href));assert.ok(refs.every(v=>v.includes('/b098b353492c273004ca496cdbf7c0f1e1855dd7/')));
 await page.locator('#q0').fill('Explain why previous context is kept separate, using intakePriorContext.');
 await page.locator('#a0').fill('Synthetic student response: I used the helper to keep the previous role and next action separate. This is a rehearsal answer.');
 await page.locator('#v0').fill('Teacher rehearsal: selected source defines the helper. Runtime integration and personal contribution remain unverified.');
 await page.locator('#review').fill('Request a demonstration and additional integration evidence at the next interview.');
 await mkdir(new URL('../exports/',import.meta.url),{recursive:true});
 const jsonPromise=page.waitForEvent('download');await page.getByRole('button',{name:'Export JSON + source text'}).click();const json=await jsonPromise;await json.saveAs(new URL('../exports/demo-interview.json',import.meta.url).pathname);
 const {readFile}=await import('node:fs/promises');const record=JSON.parse(await readFile(new URL('../exports/demo-interview.json',import.meta.url),'utf8'));
 assert.equal(record.interview[0].edited,true);assert.match(record.interview[0].studentSelfReport,/Synthetic/);assert.match(record.interview[0].teacherVerification,/unverified/);assert.equal(record.files.length,3);assert.equal(record.commitSha,'b098b353492c273004ca496cdbf7c0f1e1855dd7');assert.equal(record.model.costUsd,0);assert.ok(record.analysis.questions[0].text!==record.interview[0].question);
 const mdPromise=page.waitForEvent('download');await page.getByRole('button',{name:'Export Markdown record'}).click();await (await mdPromise).saveAs(new URL('../exports/demo-interview.md',import.meta.url).pathname);
 const md=await readFile(new URL('../exports/demo-interview.md',import.meta.url),'utf8');assert.match(md,/Student self-report/);assert.match(md,/Teacher verification/);assert.match(md,/b098b353492c273004ca496cdbf7c0f1e1855dd7/);
 await page.screenshot({path:new URL('../exports/interview-desktop.png',import.meta.url).pathname,fullPage:true});
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:new URL('../exports/interview-mobile.png',import.meta.url).pathname,fullPage:true});
 // Untrusted material is displayed as text, not HTML; stale records cannot survive changed inputs.
 await page.locator('#focus').fill('<img src=x onerror=alert(1)> new focus');assert.equal(await page.locator('#interview').isVisible(),false);assert.equal(await page.locator('img').count(),0);
 await page.getByRole('button',{name:'Prepare interview',exact:true}).click();await page.locator('#interview').waitFor();assert.match(await page.locator('#understanding').textContent(),/<img/);assert.equal(await page.locator('img').count(),0);
 if(process.env.LIVE_GITHUB==='1'){
  await page.locator('#focus').fill('Explain session openings, handling of prior context and test coverage.');
  await page.getByRole('button',{name:'Load live repository',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('snapshot').textContent.includes('live public GitHub API'),{},{timeout:60000});
  for(const path of ['README.md','src/intakeStart.ts','tests/ai-session-intake/adaptive/intake-start.test.mjs'])await page.locator('#files input').filter({visible:true}).evaluateAll((es,path)=>{const e=es.find(e=>e.value===path);e.click();},path);
  await page.getByRole('button',{name:'Prepare interview',exact:true}).click();
  await page.locator('#interview').waitFor({timeout:60000});
  assert.match(await page.locator('#model').innerText(),/MOCK/);
  assert.equal(await page.locator('#observations .card').count(),3);
  console.log('PASS live public GitHub UI: resolve SHA, select 3 actual files, fetch blobs, produce validated mock interview.');
 }
 assert.deepEqual(errors,[]);console.log('PASS desktop/mobile: real pinned fixture → mock analysis → edit → synthetic answer → teacher review → JSON/Markdown exports; no overflow, no page errors, safe text rendering, stale analysis invalidated.');
}finally{await browser?.close();await new Promise(r=>app.close(r));}
