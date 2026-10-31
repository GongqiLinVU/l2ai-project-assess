// Browser walkthrough for the persistence UI. Executes THIS app only.
// Requires: local Supabase stack running and DATABASE_URL set (loaded from
// .env.test by the npm script, or inherited from the environment).
//
//   node --env-file-if-exists=.env.test tests/browser-persistence.mjs
//
// Uses Playwright via PLAYWRIGHT_MODULE / CHROMIUM_EXECUTABLE overrides (the app
// itself has no Playwright dependency). Covers: save, saved-list, reopen after a
// simulated restart (fresh page load), continue editing + re-save, run selection,
// unsaved-change protection, New interview, and unsaved-edit export labelling.
import assert from 'node:assert/strict';
import {createApp} from '../server.mjs';
import {closePool,getPool} from '../lib/db.mjs';
import {assertDisposableTestDb} from './helpers/test-db-guard.mjs';

assert.ok(process.env.DATABASE_URL,'DATABASE_URL required for the persistence walkthrough.');
// Finding 3: refuse to truncate anything but the disposable test database.
assertDisposableTestDb();
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');

// Start from a clean slate in the disposable test database.
await getPool().query('truncate interview, analysis_draft cascade');

const app=createApp();await new Promise(r=>app.listen(0,'127.0.0.1',r));
const base='http://127.0.0.1:'+app.address().port;
let browser;
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
 const ctx=await browser.newContext({viewport:{width:1440,height:1000}});
 const page=await ctx.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 page.on('dialog',d=>d.accept()); // auto-accept unsaved-change confirm dialogs

 await page.goto(base);
 await page.waitForFunction(()=>document.getElementById('db-state').textContent.includes('connected'),{},{timeout:10000});

 // Prepare a mock interview from the offline demo.
 await page.getByRole('button',{name:'Use offline demo',exact:true}).click();
 await page.getByText(/3\/5 selected/).waitFor();
 await page.getByRole('button',{name:'Prepare interview',exact:true}).click();
 await page.locator('#interview').waitFor();
 assert.equal(await page.locator('#save-state').textContent(),'Unsaved');

 // Fill title, an answer, and save.
 await page.locator('#title').fill('Playwright save test');
 await page.locator('#a0').fill('Synthetic answer for q1 — rehearsal only.');
 await page.locator('#v0').fill('Teacher: source defines the helper; runtime unverified.');
 await page.getByRole('button',{name:'Save interview',exact:true}).click();
 await page.waitForFunction(()=>document.getElementById('save-state').textContent==='Saved',{},{timeout:10000});
 // Appears in the saved list.
 await page.waitForFunction(()=>[...document.querySelectorAll('#interviews .ilist-item')].some(e=>e.textContent.includes('Playwright save test')),{},{timeout:10000});

 // Finding 2: a DELAYED save response must not let a mid-request edit be
 // overwritten. While the save is in flight, editing and navigation are locked.
 // Delay the next /api/save response and assert the fields are disabled during it.
 await page.locator('#a0').fill('Edit before the delayed save begins.');
 await page.waitForFunction(()=>document.getElementById('save-state').textContent==='Unsaved');
 await page.route('**/api/save',async route=>{await new Promise(r=>setTimeout(r,1200));await route.continue();});
 const saveClick=page.getByRole('button',{name:'Save interview',exact:true}).click();
 // During the in-flight save the answer field, title, run selector and New
 // interview are all disabled, so no edit can be made that the response discards.
 await page.waitForFunction(()=>document.getElementById('save-state').textContent==='Saving…',{},{timeout:5000});
 assert.equal(await page.locator('#a0').isDisabled(),true,'answer field locked during save');
 assert.equal(await page.locator('#title').isDisabled(),true,'title locked during save');
 assert.equal(await page.locator('#new-interview').isDisabled(),true,'navigation locked during save');
 await saveClick;
 await page.unroute('**/api/save');
 await page.waitForFunction(()=>document.getElementById('save-state').textContent==='Saved',{},{timeout:10000});
 assert.equal(await page.locator('#a0').isDisabled(),false,'fields re-enabled after save');
 assert.equal(await page.locator('#a0').inputValue(),'Edit before the delayed save begins.','the saved edit is preserved');

 // Simulate a RESTART: reload the page (clears in-memory snapshot + record).
 await page.reload();
 await page.waitForFunction(()=>document.getElementById('db-state').textContent.includes('connected'),{},{timeout:10000});
 assert.equal(await page.locator('#interview').isVisible(),false,'interview hidden after reload');

 // Reopen from the saved list.
 await page.locator('#interviews .ilist-item',{hasText:'Playwright save test'}).click();
 await page.locator('#interview').waitFor();
 await page.waitForFunction(()=>document.getElementById('save-state').textContent==='Saved',{},{timeout:10000});
 assert.equal(await page.locator('#title').inputValue(),'Playwright save test');
 assert.equal(await page.locator('#a0').inputValue(),'Edit before the delayed save begins.','answer survived restart+reopen');
 assert.match(await page.locator('#v0').inputValue(),/runtime unverified/);

 // Continue editing -> state becomes Unsaved; re-save -> Saved.
 await page.locator('#a0').fill('Synthetic answer for q1 — EDITED after reopen.');
 await page.waitForFunction(()=>document.getElementById('save-state').textContent==='Unsaved');
 await page.getByRole('button',{name:'Save interview',exact:true}).click();
 await page.waitForFunction(()=>document.getElementById('save-state').textContent==='Saved',{},{timeout:10000});

 // Add a SECOND analysis run to the SAME saved interview via the server-
 // authoritative API (re-analysis preserves run 1 and its answers). This mirrors
 // what a reopen + reload + re-prepare would persist, without a one-click UI step.
 const current=await (await fetch(base+'/api/open',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({interviewId:(await (await fetch(base+'/api/interviews',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:'{}'})).json()).interviews.find(i=>i.title==='Playwright save test').id})})).json();
 const snap2=await (await fetch(base+'/api/resolve',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({url:'https://github.com/GongqiLinVU/milestoneproject',demo:true})})).json();
 const prep2=await (await fetch(base+'/api/analyse',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({snapshotId:snap2.id,paths:['README.md','src/intakeStart.ts'],focus:'Second run focus',history:''})})).json();
 await fetch(base+'/api/save',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({interviewId:current.interview.id,expectedVersion:current.interview.version,draftId:prep2.draftId,title:current.interview.title,focus:current.interview.focus,history:current.interview.history})});

 // Reopen in the browser and exercise run selection: 2 runs now, older run keeps
 // its edited answer, newer run starts with empty responses.
 await page.getByRole('button',{name:'Refresh list',exact:true}).click();
 await page.locator('#interviews .ilist-item',{hasText:'Playwright save test'}).click();
 await page.locator('#interview').waitFor();
 await page.waitForFunction(()=>!document.getElementById('runbar').hidden&&document.querySelectorAll('#run-select option').length===2,{},{timeout:10000});
 await page.locator('#run-select').selectOption({index:0});
 await page.locator('#interview').waitFor();
 await page.waitForFunction(()=>document.getElementById('a0')&&document.getElementById('a0').value.includes('EDITED after reopen'),{},{timeout:10000});
 await page.locator('#run-select').selectOption({index:1});
 await page.locator('#interview').waitFor();
 await page.waitForFunction(()=>document.getElementById('a0')&&document.getElementById('a0').value==='',{},{timeout:10000});

 // Unsaved-edit export labelling: make an edit, export JSON, confirm label.
 await page.locator('#review').fill('Follow-up evidence requested.');
 await page.waitForFunction(()=>document.getElementById('save-state').textContent==='Unsaved');
 const dl=page.waitForEvent('download');
 await page.getByRole('button',{name:'Export JSON + source text'}).click();
 const file=await dl;const {readFile}=await import('node:fs/promises');
 const rec=JSON.parse(await readFile(await file.path(),'utf8'));
 assert.equal(rec.unsavedEdits,true,'export flags unsaved edits');
 assert.ok(rec.interviewId,'export includes interview id');
 assert.ok(rec.analysisRunId,'export includes analysis run id');

 // New interview with unsaved edits -> dialog accepted -> UI resets.
 await page.getByRole('button',{name:'New interview',exact:true}).click();
 assert.equal(await page.locator('#interview').isVisible(),false,'interview reset on New interview');

 // Narrow-screen usability: no horizontal overflow.
 await page.setViewportSize({width:390,height:844});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no mobile horizontal overflow');

 assert.deepEqual(errors,[],'no page errors');
 console.log('PASS persistence UI: save, saved-list, restart+reopen, continue editing, re-save, two runs + run selection, unsaved export label, New interview reset, no mobile overflow, no page errors.');
}finally{
 await browser?.close();
 await new Promise(r=>app.close(r));
 await closePool();
}
