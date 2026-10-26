import test from 'node:test';
import assert from 'node:assert/strict';
import { treeRss, summarize, outputName } from './performance-baseline.mjs';
test('aggregates only descendants in KiB',()=>assert.deepEqual(treeRss('10 1 100 parent\n11 10 200 ffmpeg\n12 11 50 child\n99 1 900 other',10),{rssKiB:350,children:2}));
test('failed operations excluded from throughput',()=>assert.deepEqual(summarize([{success:true,process_ms:20},{success:false,process_ms:1},{success:true,process_ms:40}]),{successes:2,failures:1,median_ms:30,min_ms:20,max_ms:40}));
test('output names differ for warmup and every repetition',()=>assert.equal(new Set([-1,0,1,2,3,4].map(i=>outputName('video',i,'mp4'))).size,6));
import {run, normalizeSuccess, directoryBytes, ownedSymlinks} from './performance-baseline.mjs';
import {mkdtempSync,writeFileSync,chmodSync,rmSync,symlinkSync,readdirSync,realpathSync,lstatSync,linkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import { execFileSync } from 'node:child_process';
import { captureIdentity, createEvidenceFile, replaceEvidenceFile, runBoundedProcess, sha256Text, stableStringify, validateCapturedIdentity, withoutGitRepositoryEnvironment, writeJsonAtomic } from './performance-shared.mjs';
test('success requires clean exit and finite nonnegative duration',()=>{
 assert.equal(normalizeSuccess({success:true,process_ms:1},1,false),false);
 assert.equal(normalizeSuccess({success:true},0,false),false);
 assert.equal(normalizeSuccess({success:true,process_ms:-1},0,false),false);
 assert.equal(normalizeSuccess({success:true,process_ms:1},0,true),false);
});
async function fakeRunner(code,options={}){const dir=mkdtempSync(join(tmpdir(),'goop-bench-'));try{const file=join(dir,'runner');writeFileSync(file,`#!/usr/bin/env node\n${code}`);chmodSync(file,0o700);const runOptions={...options};if(options.probeJson){const probe=join(dir,'bound-ffprobe');writeFileSync(probe,`#!/bin/sh\n${options.probeMarker?": > '"+options.probeMarker+"'\n":''}printf '%s' '${JSON.stringify(options.probeJson)}'\n`);chmodSync(probe,0o700);runOptions.ffprobe=probe;delete runOptions.probeJson;delete runOptions.probeMarker;}return await run(file,dir,{output_path:join(dir,'result')},join(dir,'run'),runOptions);}finally{rmSync(dir,{recursive:true,force:true});}}
// Each sleep first really waits until the runner has created `readyPath`, then
// advances virtual time by its duration without yielding. The caps only keep
// the clock itself finite: a runner that never gets ready stops being waited
// for after 3000 polls (`missed`), and sleep 1000 throws. The test's own
// timeout and after hook are what keep a run that never escalates from
// hanging the gate.
function clockAfter(readyPath){
 const sleeps=[];let now=0,polls=0;
 const clock={sleeps,missed:false,nowMs:()=>now,sleepMs:async(ms,{signal}={})=>{
  while(!existsSync(readyPath)&&!clock.missed){
   if(signal?.aborted)throw signal.reason;
   if(++polls>=3000)clock.missed=true;else await new Promise(resolve=>setTimeout(resolve,5));
  }
  if(signal?.aborted)throw signal.reason;
  if(sleeps.length>=1000)throw Error('Virtual clock: run never stopped sleeping');
  sleeps.push(ms);now+=ms;
 }};
 return clock;
}
// Child code that ignores TERM and then renames its pid into `path`, so the
// file existing means TERM can no longer stop that process.
const ignoreTermThenArm=path=>`process.on('SIGTERM',()=>{});const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(`${path}.tmp`)},String(process.pid));fs.renameSync(${JSON.stringify(`${path}.tmp`)},${JSON.stringify(path)});`;
// A TERM-resistant process the run fails to kill can hold its pipes open
// forever. Unless the test passed, kill the pid in each `armed` file after it,
// so such a regression fails at the test's timeout instead of hanging the gate.
function killArmedAfter(t,dir,...armed){
 const guard={passed:false};
 t.after(()=>{for(const path of armed){try{const pid=Number(readFileSync(path,'utf8'));if(!guard.passed&&Number.isSafeInteger(pid)&&pid>1)process.kill(pid,'SIGKILL');}catch{/* Never armed, or already gone. */}}rmSync(dir,{recursive:true,force:true});});
 return guard;
}
// Polls for `path`, giving up after 3000 polls so a process that never arms
// cannot keep the test runner alive.
async function waitForPath(path){for(let polls=0;polls<3000&&!existsSync(path);polls++)await new Promise(resolve=>setTimeout(resolve,5));return existsSync(path);}
test('timeout escalates for a process ignoring TERM',{timeout:5000},async t=>{
 const clockDir=mkdtempSync(join(tmpdir(),'goop-term-clock-'));
 const armed=join(clockDir,'armed');
 const guard=killArmedAfter(t,clockDir,armed);
 // The timeout starts only once TERM can no longer stop the runner, so the run
 // can return only by escalating to SIGKILL.
 const clock=clockAfter(armed);
 const result=await fakeRunner(`${ignoreTermThenArm(armed)}setInterval(()=>{},10)`,{timeoutMs:200,killGraceMs:30,nowMs:clock.nowMs,sleepMs:clock.sleepMs});
 assert.equal(clock.missed,false);
 assert.equal(result.success,false);
 assert.equal(result.timed_out,true);
 assert.deepEqual(clock.sleeps,[200,30]);
 assert.equal(result.lifetime_ms,230);
 guard.passed=true;
});
test('run coerces its limits the way setTimeout does',{timeout:5000},async t=>{
 const clockDir=mkdtempSync(join(tmpdir(),'goop-coerced-limits-'));
 const armed=join(clockDir,'armed');
 let passed=false;
 t.after(()=>{try{const pid=Number(readFileSync(armed,'utf8'));if(!passed&&Number.isSafeInteger(pid)&&pid>1)process.kill(pid,'SIGKILL');}catch{/* Never armed, or already gone. */}rmSync(clockDir,{recursive:true,force:true});});
 // Both limits once went to setTimeout, which coerces its delay. A run given
 // numeric strings must still time out and escalate rather than lose a timer.
 const result=await fakeRunner(`process.on('SIGTERM',()=>{});const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(`${armed}.tmp`)},String(process.pid));fs.renameSync(${JSON.stringify(`${armed}.tmp`)},${JSON.stringify(armed)});setInterval(()=>{},10)`,{timeoutMs:'200',killGraceMs:'30'});
 assert.equal(result.success,false);
 assert.equal(result.timed_out,true);
 passed=true;
});
test('single conversion abort reaps the owned process group',{timeout:5000},async t=>{
 const dir=mkdtempSync(join(tmpdir(),'goop-abort-'));
 const armed=join(dir,'armed');
 const guard=killArmedAfter(t,dir,armed);
 const controller=new AbortController();
 // The run's own timeout stays at its 120 s default, far past this test's, so
 // only the abort can end it. The abort is sent once TERM can no longer stop
 // the runner, so the run can return only by escalating to SIGKILL.
 const running=fakeRunner(`${ignoreTermThenArm(armed)}setInterval(()=>{},10)`,{killGraceMs:30,abortSignal:controller.signal});
 running.catch(()=>{/* Rethrown by the await below. */});
 const armedInTime=await waitForPath(armed);
 controller.abort();
 const result=await running;
 assert.equal(armedInTime,true);
 assert.equal(result.success,false);
 assert.equal(result.aborted,true);
 assert.equal(result.timed_out,false);
 guard.passed=true;
});
test('single conversion timeout kills a TERM-resistant descendant before returning',{timeout:5000},async t=>{
 const dir=mkdtempSync(join(tmpdir(),'goop-descendant-clock-'));
 const armed=join(dir,'armed'),runnerPid=join(dir,'runner.pid');
 // The runner holds the run's pipes, so the guard kills it too: if the group
 // signal regressed, the runner would never see TERM and would keep them open.
 const guard=killArmedAfter(t,dir,armed,runnerPid);
 // The timeout starts only once the descendant ignores TERM, so only the group
 // SIGKILL after the grace can stop it. The runner itself dies of TERM.
 const clock=clockAfter(armed);
 const descendant=`${ignoreTermThenArm(armed)}setInterval(()=>{},10)`;
 const result=await fakeRunner(`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(`${runnerPid}.tmp`)},String(process.pid));fs.renameSync(${JSON.stringify(`${runnerPid}.tmp`)},${JSON.stringify(runnerPid)});require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>{},10)`,{timeoutMs:200,killGraceMs:50,nowMs:clock.nowMs,sleepMs:clock.sleepMs});
 assert.equal(clock.missed,false);
 assert.equal(result.timed_out,true);
 assert.deepEqual(clock.sleeps,[200,50]);
 assert.equal(result.lifetime_ms,250);
 const pid=Number(readFileSync(armed,'utf8'));
 assert.ok(Number.isSafeInteger(pid)&&pid>1,`invalid descendant pid ${pid}`);
 assert.equal(await runnableAfterKill(pid),null,'descendant outlived the run');
 guard.passed=true;
});
// The root exits on its own only once its descendant ignores TERM, so only the
// post-exit SIGKILL can end the descendant. The timeout is a liveness limit:
// the root's exit, not the timeout, must end the run, however slow the machine.
// The lifetime test below pins that run() waits out the kill before returning.
test('single conversion failure kills a TERM-resistant descendant before returning',async()=>{
 const pidDir=mkdtempSync(join(tmpdir(),'goop-bench-reap-')),armed=join(pidDir,'descendant.pid');
 try{
  const result=await fakeRunner(armedRunner(armed,"fs.writeFileSync(process.argv[4],JSON.stringify({success:false,process_ms:1}));process.exitCode=1;"),{timeoutMs:30000,killGraceMs:50});
  const pid=armedPid(armed);assert.ok(pid,'descendant never armed');
  // time(1) reports 1 for a crash as well, so the read metrics prove the failing exit.
  assert.equal(result.timed_out,false);assert.equal(result.exit_code,1);assert.equal(result.process_ms,1);assert.equal(result.success,false);
  assert.equal(await runnableAfterKill(pid),null,'descendant outlived the failed run');
 }finally{
  try{const pid=armedPid(armed);if(pid)process.kill(pid,'SIGKILL');}catch{/* Already gone. */}
  rmSync(pidDir,{recursive:true,force:true});
 }
});
test('single conversion clean exit kills a TERM-resistant descendant before returning',async()=>{
 const pidDir=mkdtempSync(join(tmpdir(),'goop-bench-reap-')),armed=join(pidDir,'descendant.pid');
 try{
  const result=await fakeRunner(armedRunner(armed,"fs.writeFileSync(process.argv[4],JSON.stringify({success:true,process_ms:1}));"),{timeoutMs:30000,killGraceMs:50});
  const pid=armedPid(armed);assert.ok(pid,'descendant never armed');
  assert.equal(result.timed_out,false);assert.equal(result.exit_code,0);assert.equal(result.success,true);
  assert.equal(await runnableAfterKill(pid),null,'descendant outlived the clean run');
 }finally{
  try{const pid=armedPid(armed);if(pid)process.kill(pid,'SIGKILL');}catch{/* Already gone. */}
  rmSync(pidDir,{recursive:true,force:true});
 }
});
// SIGKILL is sent before run() settles, but the kernel may take a moment to
// retire the process. A descendant nothing killed ignores TERM and never exits.
// ps exits 1 for a pid it cannot find; any other failure proves nothing.
const runnableAfterKill=async pid=>{const state=()=>{let stat='';try{stat=execFileSync('/bin/ps',['-o','stat=','-p',String(pid)],{encoding:'utf8'}).trim();}catch(error){if(error.status!==1)throw error;}return stat===''||/[ZE]/.test(stat)?null:stat;};let stat=state();for(let polls=0;stat!==null&&polls<250;polls++){await new Promise(resolve=>setTimeout(resolve,20));stat=state();}return stat;};
// The descendant publishes its pid only after installing its TERM handler, so
// only SIGKILL can end it. The runner runs `after` and exits once it is armed.
// With `watch`, the descendant also records whether that run file ever appears.
const armedRunner=(armed,after='',watch=null)=>{const descendant=`const fs=require('node:fs');process.on('SIGTERM',()=>{});${watch?`setInterval(()=>{if(fs.existsSync(require('node:path').join(process.argv[1],${JSON.stringify(watch)})))fs.writeFileSync(${JSON.stringify(`${armed}.saw`)},'1');},2);`:''}fs.writeFileSync(${JSON.stringify(`${armed}.tmp`)},String(process.pid));fs.renameSync(${JSON.stringify(`${armed}.tmp`)},${JSON.stringify(armed)});setInterval(()=>{},10)`;return `const fs=require('node:fs'),cp=require('node:child_process'),p=require('node:path');cp.spawn(process.execPath,['-e',${JSON.stringify(descendant)},process.argv[2]],{stdio:'ignore'}).unref();const t=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(armed)}))return;clearInterval(t);${after}},5);`;};
const armedPid=armed=>{try{const pid=Number(readFileSync(armed,'utf8'));return Number.isInteger(pid)&&pid>1?pid:null;}catch{return null;}};
test('single conversion reaps the owned group before post-exit evidence writes',async()=>{
 const pidDir=mkdtempSync(join(tmpdir(),'goop-bench-reap-')),armed=join(pidDir,'descendant.pid');
 try{
  // The runner leaves a directory where run() writes its stdout log, and the
  // descendant watches for the stderr log. SIGKILL lands before either write, so
  // the descendant can never see one. The runner reports success, so only the
  // blocked log can fail the sample.
  const result=await fakeRunner(armedRunner(armed,"fs.mkdirSync(p.join(process.argv[2],'run.stdout'));fs.writeFileSync(process.argv[4],JSON.stringify({success:true,process_ms:1}));",'run.stderr'),{timeoutMs:30000,killGraceMs:1000});
  assert.equal(result.success,false);assert.match(result.evidence_error,/run\.stdout/);
  const pid=armedPid(armed);assert.ok(pid,'descendant never armed');
  assert.equal(existsSync(`${armed}.saw`),false,'descendant was alive for an evidence write');
  assert.equal(await runnableAfterKill(pid),null,'descendant outlived the run');
 }finally{
  try{const pid=armedPid(armed);if(pid)process.kill(pid,'SIGKILL');}catch{/* Already gone. */}
  rmSync(pidDir,{recursive:true,force:true});
 }
});
test('single conversion lifetime ends when the root exits, not when the reap ends',async()=>{
 const pidDir=mkdtempSync(join(tmpdir(),'goop-bench-reap-')),armed=join(pidDir,'descendant.pid');
 try{
  const started=performance.now();
  const result=await fakeRunner(armedRunner(armed),{timeoutMs:30000,killGraceMs:1000});
  const wall=performance.now()-started;
  // The reap waits out the whole grace after the root exits, so the call
  // outlasts the measured lifetime by at least that much; load only widens it.
  assert.ok(wall-result.lifetime_ms>=900,`lifetime ${result.lifetime_ms} ms of ${wall} ms wall`);
  const pid=armedPid(armed);assert.ok(pid,'descendant never armed');
  assert.equal(await runnableAfterKill(pid),null,'descendant outlived the run');
 }finally{
  try{const pid=armedPid(armed);if(pid)process.kill(pid,'SIGKILL');}catch{/* Already gone. */}
  rmSync(pidDir,{recursive:true,force:true});
 }
});
test('single conversion metrics read cannot block on a child-made FIFO',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'goop-bench-fifo-'));
 // A blocked FIFO read freezes the whole event loop, so the run goes in a
 // subprocess whose timeout turns a regression into a failure, not a hung gate.
 const script=`import {run} from ${JSON.stringify(new URL('./performance-baseline.mjs',import.meta.url).href)};import {writeFileSync,chmodSync,lstatSync} from 'node:fs';import {join} from 'node:path';
const dir=process.argv[1],runner=join(dir,'runner');writeFileSync(runner,'#!/usr/bin/env node\\nrequire("node:child_process").execFileSync("/usr/bin/mkfifo",[process.argv[4]]);');chmodSync(runner,0o700);
const result=await run(runner,dir,{output_path:join(dir,'result')},join(dir,'run'),{killGraceMs:30});
process.stdout.write(JSON.stringify({error:result.error,success:result.success,exit_code:result.exit_code,fifo:lstatSync(join(dir,'run.metrics.json')).isFIFO()}));`;
 try{
  const result=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',script,dir],{encoding:'utf8',timeout:60000}));
  assert.deepEqual(result,{error:'No metrics produced',success:false,exit_code:0,fifo:true});
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('single conversion never reads metrics through a child-made link',async()=>{
 const outside=mkdtempSync(join(tmpdir(),'goop-bench-outside-')),target=join(outside,'metrics.json');
 writeFileSync(target,JSON.stringify({success:true,process_ms:1,marker:'followed'}));
 try{
  const result=await fakeRunner(`require('node:fs').symlinkSync(${JSON.stringify(target)},process.argv[4]);`);
  assert.equal(result.removed_symlink_outputs,1);assert.equal(result.marker,undefined);assert.equal(result.error,'No metrics produced');assert.equal(result.success,false);
 }finally{rmSync(outside,{recursive:true,force:true});}
});
test('single conversion never reads metrics through a child-made hard link',async()=>{
 const outside=mkdtempSync(join(tmpdir(),'goop-bench-outside-')),target=join(outside,'metrics.json'),linked=join(outside,'linked');
 writeFileSync(target,JSON.stringify({success:true,process_ms:1,marker:'followed'}));
 try{
  // The runner records the link count it made, so a failed link cannot pass.
  const result=await fakeRunner(`const fs=require('node:fs');fs.linkSync(${JSON.stringify(target)},process.argv[4]);fs.writeFileSync(${JSON.stringify(linked)},String(fs.statSync(process.argv[4]).nlink));`);
  assert.equal(readFileSync(linked,'utf8'),'2');assert.equal(result.marker,undefined);assert.equal(result.error,'No metrics produced');assert.equal(result.success,false);
 }finally{rmSync(outside,{recursive:true,force:true});}
});
test('single conversion records a staging cleanup failure instead of rejecting',{skip:process.getuid?.()===0},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'goop-bench-')),locked=join(dir,'.goop-output-1-0','locked');
 try{
  // An unwritable directory inside one staging tree blocks its removal; the
  // other staging tree must still go, and the run must still return a sample.
  // The oversized file comes last, so the budget stop cannot cut the setup short.
  const runner=join(dir,'runner');
  writeFileSync(runner,`#!/usr/bin/env node\nconst fs=require('node:fs'),p=require('node:path');fs.mkdirSync(${JSON.stringify(locked)},{recursive:true});fs.writeFileSync(p.join(${JSON.stringify(locked)},'partial'),'x');fs.chmodSync(${JSON.stringify(locked)},0o555);fs.mkdirSync(p.join(process.argv[2],'.goop-output-2-0'));fs.writeFileSync(p.join(process.argv[2],'oversized'),Buffer.alloc(10000));`);chmodSync(runner,0o700);
  const result=await run(runner,dir,{output_path:join(dir,'result')},join(dir,'run'),{budgetBytes:4096,logLimitBytes:100,killGraceMs:30});
  assert.equal(result.budget_exceeded,true);assert.equal(result.success,false);
  // Node words this failure differently across versions, so match the tree it names.
  assert.match(result.cleanup_error,/\.goop-output-1-0/);assert.equal(result.removed_staging_directories,1);
  assert.equal(existsSync(join(dir,'.goop-output-2-0')),false);
 }finally{try{chmodSync(locked,0o755);}catch{/* Never created. */}rmSync(dir,{recursive:true,force:true});}
});
test('single conversion records an owned output removal failure instead of rejecting',async()=>{
 const result=await fakeRunner("const fs=require('node:fs'),p=require('node:path');const r=JSON.parse(fs.readFileSync(process.argv[3]));fs.mkdirSync(r.output_path);fs.writeFileSync(p.join(r.output_path,'partial'),Buffer.alloc(10000));",{budgetBytes:4096,logLimitBytes:100,killGraceMs:30});
 assert.equal(result.budget_exceeded,true);assert.equal(result.success,false);assert.match(result.cleanup_error,/EPERM|EISDIR/);
});
test('single conversion records no cleanup or evidence error for a clean run',async()=>{const result=await fakeRunner("require('node:fs').writeFileSync(process.argv[4],JSON.stringify({success:true,process_ms:1}));");assert.equal(result.success,true);assert.equal(result.cleanup_error,null);assert.equal(result.evidence_error,null);});
// A blocked open freezes the whole event loop, so a run that might block goes in
// a subprocess whose timeout turns a regression into a failure, not a hung gate.
const guardedRun=(dir,body,name)=>JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',`import {run} from ${JSON.stringify(new URL('./performance-baseline.mjs',import.meta.url).href)};import fs from 'node:fs';import {join} from 'node:path';
const [dir,body,name]=process.argv.slice(1),runner=join(dir,'runner');fs.writeFileSync(runner,'#!/usr/bin/env node\\n'+body);fs.chmodSync(runner,0o700);
const result=await run(runner,dir,{output_path:join(dir,'result')},join(dir,'run'),{killGraceMs:30});
const sample=join(dir,'run.sample.json');
process.stdout.write(JSON.stringify({success:result.success,evidence_error:result.evidence_error,fifo:fs.lstatSync(join(dir,name)).isFIFO(),saved:fs.lstatSync(sample).isFile()?JSON.parse(fs.readFileSync(sample,'utf8')).evidence_error:null}));`,dir,body,name],{encoding:'utf8',timeout:60000,killSignal:'SIGKILL'}));
test('single conversion evidence writes cannot block on a child-made FIFO',()=>{
 for(const name of ['run.stdout','run.stderr','run.sample.json']){
  const dir=mkdtempSync(join(tmpdir(),'goop-bench-fifo-'));
  try{
   const result=guardedRun(dir,`require('node:child_process').execFileSync('/usr/bin/mkfifo',[require('node:path').join(process.argv[2],${JSON.stringify(name)})]);require('node:fs').writeFileSync(process.argv[4],JSON.stringify({success:true,process_ms:1}));`,name);
   assert.equal(result.success,false,name);assert.ok(result.evidence_error?.includes(name),`${name}: ${result.evidence_error}`);
   // A log is never written through the FIFO. The sample, rewritten after
   // cleanup, replaces it unopened and keeps the evidence error on disk.
   if(name==='run.sample.json'){assert.equal(result.fifo,false);assert.equal(result.saved,result.evidence_error);}
   else assert.equal(result.fifo,true,name);
  }finally{rmSync(dir,{recursive:true,force:true});}
 }
});
test('single conversion never writes evidence through a child-made link',async()=>{
 for(const [name,link] of [['run.stdout','symlinkSync'],['run.stdout','linkSync'],['run.stderr','linkSync'],['run.sample.json','linkSync']]){
  const outside=mkdtempSync(join(tmpdir(),'goop-bench-outside-')),target=join(outside,'evidence');
  writeFileSync(target,'outside');
  try{
   const result=await fakeRunner(`const fs=require('node:fs');fs.${link}(${JSON.stringify(target)},require('node:path').join(process.argv[2],${JSON.stringify(name)}));process.stdout.write('child');process.stderr.write('child');fs.writeFileSync(process.argv[4],JSON.stringify({success:true,process_ms:1}));`);
   assert.equal(readFileSync(target,'utf8'),'outside',`${link} at ${name} was written through`);
   // The evidence error also proves the runner made its link.
   assert.equal(result.success,false,`${link} at ${name}`);assert.ok(result.evidence_error?.includes(name),`${link} at ${name}: ${result.evidence_error}`);
  }finally{rmSync(outside,{recursive:true,force:true});}
 }
});
test('single conversion refuses a planted request path before launch',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'goop-bench-')),outside=mkdtempSync(join(tmpdir(),'goop-bench-outside-')),target=join(outside,'request.json'),launched=join(outside,'launched');
 try{
  // In the standalone harness's shared directory an earlier child can plant the next run's request path.
  writeFileSync(target,'outside');symlinkSync(target,join(dir,'run.request.json'));
  const runner=join(dir,'runner');writeFileSync(runner,`#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(launched)},'1');`);chmodSync(runner,0o700);
  await assert.rejects(run(runner,dir,{output_path:join(dir,'result')},join(dir,'run'),{killGraceMs:30}),/EEXIST/);
  assert.equal(readFileSync(target,'utf8'),'outside');assert.equal(existsSync(launched),false);
 }finally{rmSync(dir,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});
import { drainChildOutput } from './performance-shared.mjs';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
// A holder that leaves the owned group (detached is setsid) keeps the run's
// stdout and stderr open. It writes one marker before it publishes its pid, never
// writes again, and outlives any guard, so only the test's finally ends it. The
// runner runs `after` once the holder is armed.
const escapedHolder=(armed,after)=>{const holder=`const fs=require('node:fs');fs.writeSync(1,'escaped-marker\\n');fs.writeFileSync(${JSON.stringify(`${armed}.tmp`)},String(process.pid));fs.renameSync(${JSON.stringify(`${armed}.tmp`)},${JSON.stringify(armed)});setTimeout(()=>{},120000)`;return `const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(holder)}],{detached:true,stdio:['ignore','inherit','inherit']}).unref();const t=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(armed)}))return;clearInterval(t);${after}},5);`;};
// Waiting for the holder's EOF would hang, so the harness runs in a subprocess
// whose timeout turns that into a failure. With `abortWhen`, the run is aborted
// once that file exists. The holder's state is read the moment the harness resolves.
const heldPipesRun=(harness,dir,body,armed,abortWhen)=>JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',`import {run} from ${JSON.stringify(new URL('./performance-baseline.mjs',import.meta.url).href)};import {runBoundedProcess} from ${JSON.stringify(new URL('./performance-shared.mjs',import.meta.url).href)};import fs from 'node:fs';import {join} from 'node:path';import {execFileSync} from 'node:child_process';
const [harness,dir,body,armed,abortWhen]=process.argv.slice(1),runner=join(dir,'runner');fs.writeFileSync(runner,'#!/usr/bin/env node\\n'+body);fs.chmodSync(runner,0o700);
const controller=new AbortController();if(abortWhen){const t=setInterval(()=>{if(fs.existsSync(abortWhen)){clearInterval(t);controller.abort();}},5);}
let result,log;
if(harness==='run'){result=await run(runner,dir,{output_path:join(dir,'result')},join(dir,'run'),{timeoutMs:30000,killGraceMs:200,abortSignal:controller.signal});log=fs.readFileSync(join(dir,'run.stdout'),'utf8');}
else{const output=join(dir,'output');fs.mkdirSync(output);result=await runBoundedProcess({command:runner,outputDirectory:output,timeoutMs:30000,killGraceMs:200,logLimitBytes:4096,storageBudgetBytes:1048576,abortSignal:controller.signal});log=result.stdout.toString();}
let state='';try{state=execFileSync('/bin/ps',['-o','stat=','-p',fs.readFileSync(armed,'utf8')],{encoding:'utf8'}).trim();}catch{/* Gone. */}
process.stdout.write(JSON.stringify({success:result.success,stdio_error:result.stdio_error,exit_code:result.exit_code,timed_out:result.timed_out,aborted:result.aborted,log,holder_state:state}));`,harness,dir,body,armed,abortWhen],{encoding:'utf8',timeout:60000,killSignal:'SIGKILL'}));
// The runner survives TERM and says so, so the abort lands only once the reap's
// SIGKILL is the one thing that can end it.
const resistTerm=resisting=>`process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(resisting)},'1');setInterval(()=>{},10);`;
for(const [harness,name,abort] of [['run','single conversion',false],['run','single conversion',true],['bounded','bounded process',false],['bounded','bounded process',true]]){
 const label=abort?'aborted':'root exited';
 test(`${name} stops waiting for output pipes held outside the owned group (${label})`,{skip:harness==='bounded'&&process.platform==='win32'},()=>{
  const dir=mkdtempSync(join(tmpdir(),'goop-bench-held-')),pidDir=mkdtempSync(join(tmpdir(),'goop-bench-held-pid-')),armed=join(pidDir,'holder.pid'),resisting=join(pidDir,'resisting');
  const after=abort?resistTerm(resisting):harness==='run'?"fs.writeFileSync(process.argv[4],JSON.stringify({success:true,process_ms:1}));":'';
  try{
   const result=heldPipesRun(harness,dir,escapedHolder(armed,after),armed,abort?resisting:'');
   // The holder is still alive, so the harness resolved without its EOF.
   assert.ok(result.holder_state!==''&&!/[ZE]/.test(result.holder_state),`holder state '${result.holder_state}'`);
   assert.equal(result.success,false);assert.match(result.stdio_error??'',/output pipes/i);assert.match(result.log,/escaped-marker/);
   if(abort)assert.equal(result.aborted,true);else{assert.equal(result.exit_code,0);assert.equal(result.timed_out,false);}
  }finally{
   const pid=armedPid(armed);if(pid)try{process.kill(pid,'SIGKILL');}catch{/* Already gone. */}
   rmSync(dir,{recursive:true,force:true});rmSync(pidDir,{recursive:true,force:true});
  }
 });
}
test('a pipe holder inside the owned group is reaped, not reported as held',async()=>{
 // The runner holds the pipes and survives TERM, so only the reap's SIGKILL ends
 // it. The drain starts after that reap and sees its EOF.
 for(const harness of ['run','bounded']){
  const dir=mkdtempSync(join(tmpdir(),'goop-bench-group-held-')),resisting=join(dir,'resisting'),runner=join(dir,'runner'),controller=new AbortController();
  const poll=setInterval(()=>{if(existsSync(resisting)){clearInterval(poll);controller.abort();}},5);
  try{
   writeFileSync(runner,`#!/usr/bin/env node\nprocess.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(resisting)},'1');setInterval(()=>{},10);`);chmodSync(runner,0o700);
   let result;
   if(harness==='run')result=await run(runner,dir,{output_path:join(dir,'result')},join(dir,'run'),{timeoutMs:30000,killGraceMs:1000,abortSignal:controller.signal});
   else{const output=join(dir,'output');mkdirSync(output);result=await runBoundedProcess({command:runner,outputDirectory:output,timeoutMs:30000,killGraceMs:1000,logLimitBytes:1024,storageBudgetBytes:1024*1024,abortSignal:controller.signal});}
   assert.equal(result.aborted,true,harness);assert.equal(result.stdio_error,null,harness);
  }finally{clearInterval(poll);rmSync(dir,{recursive:true,force:true});}
 }
});
test('bounded process counts what the group writes during the reap grace',{skip:process.platform==='win32'},async()=>{
 // The descendant writes past the budget only when TERM arrives, after the root
 // has exited, and the monitor never ticks, so only a count after the reap sees it.
 const root=mkdtempSync(join(tmpdir(),'goop-process-grace-')),output=join(root,'output'),armed=join(root,'armed'),runner=join(root,'runner.cjs');
 mkdirSync(output);
 const descendant=`const fs=require('node:fs');process.on('SIGTERM',()=>{fs.writeFileSync(require('node:path').join(process.env.GOOP_TEST_OUTPUT,'late'),Buffer.alloc(2*1024*1024));});fs.writeFileSync(${JSON.stringify(armed)},'1');setInterval(()=>{},10)`;
 writeFileSync(runner,`const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'}).unref();const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(armed)}))clearInterval(t);},5);`);
 try{
  const result=await runBoundedProcess({command:process.execPath,args:[runner],env:{...process.env,GOOP_TEST_OUTPUT:output},outputDirectory:output,timeoutMs:30000,killGraceMs:2000,logLimitBytes:1024,storageBudgetBytes:1024*1024,samplingIntervalMs:2**31-1});
  assert.equal(result.exit_code,0);assert.equal(result.budget_exceeded,true);assert.equal(result.success,false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('standalone baseline stops once a run leaves its output pipes held',()=>{
 const root=mkdtempSync(join(tmpdir(),'goop-bench-main-held-')),fixtures=join(root,'fixtures'),sidecars=join(root,'sidecars'),out=join(root,'out'),runner=join(root,'runner'),script=join(root,'runner.js'),armed=join(root,'holder.pid');
 try{
  mkdirSync(fixtures);mkdirSync(sidecars);
  for(const name of ['photo.png','photo.heic','sample.mp4','malformed.dng'])writeFileSync(join(fixtures,name),name);
  writeFileSync(runner,`#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);chmodSync(runner,0o700);
  // Only the first run leaves a holder behind; every later run would share the
  // directory with a process the harness cannot reap.
  writeFileSync(script,`require('node:fs').writeFileSync(process.argv[4],JSON.stringify({success:true,process_ms:1}));if(require('node:path').basename(process.argv[3])==='png-jpeg-warmup.request.json'){${escapedHolder(armed,'')}}`);
  assert.throws(()=>execFileSync(process.execPath,[fileURLToPath(new URL('./performance-baseline.mjs',import.meta.url)),'--binary',runner,'--runtime-sidecars',sidecars,'--fixtures',fixtures,'--output',out,'--repeat','1'],{stdio:'pipe',encoding:'utf8',timeout:60000,killSignal:'SIGKILL'}),error=>error.signal===null&&/later runs/.test(error.stderr));
  assert.equal(existsSync(join(out,'png-jpeg-0.request.json')),false);
 }finally{
  const pid=armedPid(armed);if(pid)try{process.kill(pid,'SIGKILL');}catch{/* Already gone. */}
  rmSync(root,{recursive:true,force:true});
 }
});
test('clean single conversion and bounded runs record no held pipes and keep trailing output',async()=>{
 // /usr/bin/time writes its report just before the root exits, so the report is
 // still in the pipe when the exit arrives and survives only a drain to EOF.
 const result=await fakeRunner("require('node:fs').writeFileSync(process.argv[4],JSON.stringify({success:true,process_ms:1}));",{killGraceMs:200});
 assert.equal(result.success,true);assert.equal(result.stdio_error,null);assert.ok(process.platform!=='darwin'||result.time_peak_bytes>0);
 const output=mkdtempSync(join(tmpdir(),'goop-process-clean-'));
 try{
  const bounded=await runBoundedProcess({command:process.execPath,args:['-e',''],outputDirectory:output,timeoutMs:30000,killGraceMs:200,logLimitBytes:1024*1024,storageBudgetBytes:1024*1024});
  assert.equal(bounded.success,true);assert.equal(bounded.stdio_error,null);assert.ok(process.platform!=='darwin'||bounded.time_peak_bytes>0);
 }finally{rmSync(output,{recursive:true,force:true});}
});
test('output drain reads an EOF already pending at its deadline and destroys pipes still held',async()=>{
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','pipe','pipe']});
 child.stdout.resume();child.stderr.resume();
 await new Promise(resolve=>child.once('spawn',resolve));
 const drained=drainChildOutput([child.stdout,child.stderr],1);
 // The loop stays blocked past the deadline until the killed child is a zombie,
 // so its EOF is already pending, and still unread, when the deadline fires.
 process.kill(child.pid,'SIGKILL');
 execFileSync('/bin/sh',['-c',`i=0;while [ $i -lt 1000 ];do case "$(/bin/ps -o stat= -p ${child.pid})" in *Z*) exit 0;;esac;sleep 0.01;i=$((i+1));done;exit 1`]);
 assert.equal(await drained,null);
 const held=[new PassThrough(),new PassThrough()];
 assert.match(await drainChildOutput(held,5),/output pipes/i);assert.ok(held.every(stream=>stream.destroyed));
 const ended=new PassThrough();ended.resume();ended.end();await new Promise(resolve=>ended.once('end',resolve));
 assert.equal(await drainChildOutput([ended,null],60000),null);
});
test('single conversion treats metrics that are not an object as invalid',async()=>{
 for(const text of ['null','5','"done"','[1,2]']){
  const result=await fakeRunner(`require('node:fs').writeFileSync(process.argv[4],${JSON.stringify(text)});`);
  assert.equal(result.error,'Invalid metrics JSON',text);assert.equal(result.success,false,text);assert.equal(result['0'],undefined,text);
 }
});
test('single conversion records a failed post-exit symlink scan instead of rejecting',async()=>{
 // A real unreadable tree fails the post-exit byte count before the scan, so
 // the scan failure is injected alone, once the run's logs exist.
 const scanFails=dir=>directory=>{if(existsSync(join(dir,'run.stdout')))throw Error(`EACCES: permission denied, scandir '${directory}'`);return ownedSymlinks(directory);};
 const clean=mkdtempSync(join(tmpdir(),'goop-bench-')),over=mkdtempSync(join(tmpdir(),'goop-bench-'));
 try{
  writeFileSync(join(clean,'runner'),"#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.argv[4],JSON.stringify({success:true,process_ms:1}));");chmodSync(join(clean,'runner'),0o700);
  const result=await run(join(clean,'runner'),clean,{output_path:join(clean,'result')},join(clean,'run'),{killGraceMs:30,listSymlinks:scanFails(clean)});
  assert.equal(result.success,false);assert.match(result.output_error,/symbolic links.*EACCES/);
  assert.equal(JSON.parse(readFileSync(join(clean,'run.sample.json'),'utf8')).output_error,result.output_error);
  // Over budget, the cleanup that a rejection would skip still runs.
  writeFileSync(join(over,'runner'),"#!/usr/bin/env node\nconst fs=require('node:fs'),p=require('node:path');const d=p.join(process.argv[2],'.goop-output-1-0');fs.mkdirSync(d);fs.writeFileSync(p.join(d,'partial'),Buffer.alloc(10000));setInterval(()=>{},10);");chmodSync(join(over,'runner'),0o700);
  const overBudget=await run(join(over,'runner'),over,{output_path:join(over,'result')},join(over,'run'),{budgetBytes:4096,logLimitBytes:100,killGraceMs:30,listSymlinks:scanFails(over)});
  assert.equal(overBudget.budget_exceeded,true);assert.match(overBudget.output_error,/symbolic links.*EACCES/);assert.equal(overBudget.removed_staging_directories,1);
 }finally{rmSync(clean,{recursive:true,force:true});rmSync(over,{recursive:true,force:true});}
});
test('single conversion records a refused sample rewrite and still cleans up',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'goop-bench-'));
 try{
  // A directory at the sample path refuses both the first write and the
  // rewrite after cleanup; the over-budget cleanup must still run.
  writeFileSync(join(dir,'runner'),"#!/usr/bin/env node\nconst fs=require('node:fs'),p=require('node:path');fs.mkdirSync(p.join(process.argv[2],'run.sample.json'));const d=p.join(process.argv[2],'.goop-output-1-0');fs.mkdirSync(d);fs.writeFileSync(p.join(d,'partial'),Buffer.alloc(10000));setInterval(()=>{},10);");chmodSync(join(dir,'runner'),0o700);
  const result=await run(join(dir,'runner'),dir,{output_path:join(dir,'result')},join(dir,'run'),{budgetBytes:4096,logLimitBytes:100,killGraceMs:30});
  assert.equal(result.budget_exceeded,true);assert.equal(result.success,false);assert.match(result.evidence_error,/run\.sample\.json/);
  assert.equal(result.removed_staging_directories,1);assert.ok(lstatSync(join(dir,'run.sample.json')).isDirectory());
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('evidence files refuse every child-made entry and are replaced only unopened',()=>{
 const dir=mkdtempSync(join(tmpdir(),'goop-evidence-')),outside=join(dir,'outside');
 try{
  writeFileSync(outside,'outside');symlinkSync(outside,join(dir,'symlink'));symlinkSync(join(dir,'missing'),join(dir,'dangling'));linkSync(outside,join(dir,'hard'));mkdirSync(join(dir,'directory'));writeFileSync(join(dir,'file'),'child');
  execFileSync('/usr/bin/mkfifo',[join(dir,'fifo')]);
  for(const name of ['symlink','dangling','hard','directory','file','fifo'])assert.throws(()=>createEvidenceFile(join(dir,name),'evidence'),{code:'EEXIST'},name);
  for(const name of ['symlink','dangling','hard','fifo']){replaceEvidenceFile(join(dir,name),'evidence');assert.ok(lstatSync(join(dir,name)).isFile(),name);assert.equal(readFileSync(join(dir,name),'utf8'),'evidence',name);}
  assert.throws(()=>replaceEvidenceFile(join(dir,'directory'),'evidence'),{code:'ERR_FS_EISDIR'});
  assert.equal(readFileSync(outside,'utf8'),'outside');assert.equal(lstatSync(outside).nlink,1);assert.equal(existsSync(join(dir,'missing')),false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('standalone baseline never follows or blocks on a child-planted summary path',()=>{
 const root=mkdtempSync(join(tmpdir(),'goop-bench-main-')),outside=join(root,'outside'),fixtures=join(root,'fixtures'),sidecars=join(root,'sidecars'),out=join(root,'out'),runner=join(root,'runner'),script=join(root,'runner.js');
 try{
  mkdirSync(fixtures);mkdirSync(sidecars);writeFileSync(outside,'outside');
  for(const name of ['photo.png','photo.heic','sample.mp4','malformed.dng'])writeFileSync(join(fixtures,name),name);
  // The first child leaves a FIFO where the harness writes its summary; a later
  // one swaps the written summary for a hard link to a file outside the run.
  // Children get only the sidecar directory on PATH, so a shell wrapper names
  // node by its absolute path, which a shebang could not hold if it had spaces.
  writeFileSync(runner,`#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);chmodSync(runner,0o700);
  writeFileSync(script,`const fs=require('node:fs'),p=require('node:path');const summary=p.join(p.dirname(process.argv[3]),'summary.json'),run=p.basename(process.argv[3]);
if(run==='png-jpeg-warmup.request.json')require('node:child_process').execFileSync('/usr/bin/mkfifo',[summary]);
if(run==='mp4-mp3-warmup.request.json'){fs.rmSync(summary);fs.linkSync(${JSON.stringify(outside)},summary);}
fs.writeFileSync(process.argv[4],JSON.stringify({success:true,process_ms:1}));`);
  // The harness traps SIGTERM, which a blocked open would never service.
  execFileSync(process.execPath,[fileURLToPath(new URL('./performance-baseline.mjs',import.meta.url)),'--binary',runner,'--runtime-sidecars',sidecars,'--fixtures',fixtures,'--output',out,'--repeat','1'],{stdio:'pipe',timeout:60000,killSignal:'SIGKILL'});
  assert.equal(readFileSync(outside,'utf8'),'outside');assert.ok(lstatSync(join(out,'summary.json')).isFile());
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(out,'summary.json'),'utf8'))),['png-jpeg','heic-jpeg','mp4-mp3','mp4-h264','mp4-quality','mp4-compress','malformed']);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('contradictory metrics cannot count as success',async()=>{const result=await fakeRunner("require('node:fs').writeFileSync(process.argv[4],JSON.stringify({success:true,process_ms:1}));process.exitCode=1;");assert.equal(result.success,false);});
test('single conversion cannot succeed without an independent probe',async()=>{const result=await fakeRunner("const fs=require('node:fs');const r=JSON.parse(fs.readFileSync(process.argv[3]));fs.writeFileSync(r.output_path,'x');fs.writeFileSync(process.argv[4],JSON.stringify({success:true,process_ms:1,result:{bytes:1}}));",{expectedOutput:{extension:'jpg',probe:'media',format_names:['image2'],required_streams:[{codec_type:'video',codec_name:'mjpeg'}]}});assert.equal(result.success,false);assert.equal(result.verification.checked,false);assert.match(result.verification.error,/ffprobe/i);});
test('single conversion rejects and removes a child-created symlink output',async()=>{const result=await fakeRunner("const fs=require('node:fs'),p=require('node:path');const r=JSON.parse(fs.readFileSync(process.argv[3]));fs.symlinkSync(p.join(process.argv[2],'runner'),r.output_path);fs.writeFileSync(process.argv[4],JSON.stringify({success:true,process_ms:1,result:{bytes:1}}));",{expectedOutput:{extension:'jpg',probe:'media',format_names:['image2'],required_streams:[{codec_type:'video',codec_name:'mjpeg'}]}});assert.equal(result.success,false);assert.match(result.output_error,/symbolic-link/i);assert.equal(result.removed_symlink_outputs,1);});
test('missed memory samples remain unresolved instead of becoming zero',async()=>{const result=await fakeRunner("require('node:fs').writeFileSync(process.argv[4],JSON.stringify({success:true,process_ms:1}));");assert.notEqual(result.sampled_tree_peak_KiB,0);assert.notEqual(result.time_peak_bytes,0);});
test('hardware intent reaches the driver and effective hardware stays evidence based',async()=>{
 const result=await fakeRunner("const fs=require('node:fs');fs.writeFileSync(process.argv[4],JSON.stringify({success:true,process_ms:1,hardware_intent:process.argv[5],encoder_observations:[]}));",{hardwareEnabled:true});
 assert.equal(result.success,true);
 assert.equal(result.hardware_intent,'true');
 assert.equal(result.effective_hardware,'unknown');
});
test('legacy hardware progress is retained but cannot prove completed hardware execution',async()=>{
 const result=await fakeRunner("const fs=require('node:fs');fs.writeFileSync(process.argv[4],JSON.stringify({success:true,process_ms:1,encoder_observations:[{encoder:'h264_videotoolbox'}]}));",{hardwareEnabled:true});
 assert.equal(result.effective_hardware,'unknown');
 assert.equal(result.effective_encoder,null);
 assert.deepEqual(result.encoder_observations,[{encoder:'h264_videotoolbox'}]);
});
test('final fallback observation cannot retain stale hardware evidence',async()=>{
 const result=await fakeRunner("const fs=require('node:fs');fs.writeFileSync(process.argv[4],JSON.stringify({success:true,process_ms:1,encoder_observations:[{encoder:'h264_videotoolbox'},{encoder:null}]}));",{hardwareEnabled:true});
 assert.equal(result.effective_hardware,'unknown');
 assert.equal(result.effective_encoder,null);
});
test('over-cap observation tail still classifies the final fallback',async()=>{
 const observations=Array.from({length:65},(_,percent)=>({encoder:'h264_videotoolbox',percent}));
 observations.push({encoder:null,percent:0});
 const retained=observations.slice(-64);
 const result=await fakeRunner(`const fs=require('node:fs');fs.writeFileSync(process.argv[4],JSON.stringify({success:true,process_ms:1,encoder_observations:${JSON.stringify(retained)}}));`,{hardwareEnabled:true});
 assert.equal(retained.length,64);
 assert.equal(result.effective_hardware,'unknown');
 assert.equal(result.effective_encoder,null);
});
test('effective execution summary proves explicit software and copy',async()=>{
 const software=await fakeRunner("const fs=require('node:fs');fs.writeFileSync(process.argv[4],JSON.stringify({success:true,process_ms:1,result:{video_execution:{requested:{kind:'encode'},encoder:'libx264'}}}));",{hardwareEnabled:true});
 assert.equal(software.effective_hardware,'software');
 const copy=await fakeRunner("const fs=require('node:fs');fs.writeFileSync(process.argv[4],JSON.stringify({success:true,process_ms:1,result:{video_execution:{requested:{kind:'copy'},encoder:null}}}));",{hardwareEnabled:true});
 assert.equal(copy.effective_hardware,'copy');
});
test('storage budget stops oversized output and logs are bounded',async()=>{const result=await fakeRunner("const fs=require('node:fs');const r=JSON.parse(fs.readFileSync(process.argv[3]));fs.writeFileSync(r.output_path,Buffer.alloc(10000));process.stdout.write('y'.repeat(10000));process.stderr.write('x'.repeat(10000));setInterval(()=>{},10)",{budgetBytes:4096,logLimitBytes:100,killGraceMs:30});assert.equal(result.budget_exceeded,true);assert.equal(result.success,false);assert.ok(result.log_bytes_retained<=100);});
test('storage budget catches an oversized output written immediately before exit',async()=>{const result=await fakeRunner("const fs=require('node:fs');const r=JSON.parse(fs.readFileSync(process.argv[3]));fs.writeFileSync(r.output_path,Buffer.alloc(10000));fs.writeFileSync(process.argv[4],JSON.stringify({success:true,process_ms:1,result:{bytes:10000}}));",{budgetBytes:4096,logLimitBytes:100,killGraceMs:30});assert.equal(result.budget_exceeded,true);assert.equal(result.success,false);});
test('directory byte count includes only files in suite',()=>{const dir=mkdtempSync(join(tmpdir(),'goop-bench-'));try{writeFileSync(join(dir,'one'),'1234');assert.equal(directoryBytes(dir),4);}finally{rmSync(dir,{recursive:true,force:true});}});
test('bounded atomic JSON refuses the temporary replacement high-water peak',()=>{const dir=mkdtempSync(join(tmpdir(),'goop-atomic-budget-'));try{const path=join(dir,'state.json');writeFileSync(path,'{"old":true}\n');const value={next:'x'.repeat(1000)};const nextBytes=Buffer.byteLength(`${JSON.stringify(value)}\n`);const budget=directoryBytes(dir)+nextBytes-1;assert.throws(()=>writeJsonAtomic(path,value,{budgetDirectory:dir,budgetBytes:budget}),/atomic.*budget/i);assert.equal(readFileSync(path,'utf8'),'{"old":true}\n');assert.deepEqual(readdirSync(dir),['state.json']);}finally{rmSync(dir,{recursive:true,force:true});}});
test('child lifetime excludes subsequent output verification',async()=>{
 const clockDir=mkdtempSync(join(tmpdir(),'goop-probe-clock-'));
 try{
  // The clock moves only when the independent probe runs, so the child's own
  // runtime (however slow under load) cannot reorder the two windows.
  const probed=join(clockDir,'probed');
  const nowMs=()=>existsSync(probed)?500:0;
  const result=await fakeRunner("const fs=require('node:fs');const r=JSON.parse(fs.readFileSync(process.argv[3]));fs.writeFileSync(r.output_path,'x');fs.writeFileSync(process.argv[4],JSON.stringify({success:true,process_ms:1,result:{bytes:1}}));",{probeJson:{streams:[{codec_type:'video',codec_name:'mjpeg'}],format:{format_name:'image2'}},probeMarker:probed,nowMs,expectedOutput:{extension:'jpg',probe:'media',format_names:['image2'],required_streams:[{codec_type:'video',codec_name:'mjpeg'}]}});
  assert.equal(result.success,true);
  assert.equal(result.lifetime_ms,0);
  assert.equal(result.verification_ms,500);
 }finally{rmSync(clockDir,{recursive:true,force:true});}
});
test('single conversion rejects an independent probe with no usable stream',async()=>{
 const result=await fakeRunner("const fs=require('node:fs');const r=JSON.parse(fs.readFileSync(process.argv[3]));fs.writeFileSync(r.output_path,'x');fs.writeFileSync(process.argv[4],JSON.stringify({success:true,process_ms:1,result:{bytes:1}}));",{probeJson:{streams:[],format:{}},expectedOutput:{extension:'jpg',probe:'media',format_names:['image2'],required_streams:[{codec_type:'video',codec_name:'mjpeg'}]}});
 assert.equal(result.success,false);
 assert.match(result.verification.error,/usable media/i);
});
test('budget failure also removes new owned staging artifacts after metrics',async()=>{const result=await fakeRunner("const fs=require('node:fs'),p=require('node:path');const r=JSON.parse(fs.readFileSync(process.argv[3]));const d=p.join(p.dirname(r.output_path),'.goop-output-'+process.pid+'-0');fs.mkdirSync(d);fs.writeFileSync(p.join(d,'partial'),Buffer.alloc(10000));setInterval(()=>{},10)",{budgetBytes:4096,logLimitBytes:100,killGraceMs:30});assert.equal(result.budget_exceeded,true);assert.equal(result.removed_staging_directories,1);});
// The storage scan counts vanished entries as zero, so a throw that reaches a
// monitor is a real read failure, such as an owned directory made unreadable.
const unreadableTree=()=>{throw Object.assign(Error('owned tree unreadable'),{code:'EACCES'});};
const sampleTimeout=()=>{throw Object.assign(Error('ps timed out'),{code:'ETIMEDOUT'});};
test('single conversion live storage check fails closed when the owned tree cannot be read',async()=>{
 // The post-exit check alone also reports an overrun, so only an early stop shows the live check acted.
 const result=await fakeRunner("setInterval(()=>{},10)",{timeoutMs:30000,killGraceMs:30,measureBytes:unreadableTree,readSnapshot:()=>''});
 assert.equal(result.budget_exceeded,true);assert.equal(result.timed_out,false);assert.equal(result.success,false);
});
test('single conversion storage check still runs when the process sampler fails',async()=>{
 let sampled=0;
 const result=await fakeRunner("setInterval(()=>{},10)",{timeoutMs:30000,killGraceMs:30,budgetBytes:4096,measureBytes:()=>4096,readSnapshot:()=>{sampled++;sampleTimeout();}});
 assert.ok(sampled>0);assert.equal(result.budget_exceeded,true);assert.equal(result.timed_out,false);
});
test('single conversion treats a failed process sample as a missed sample, not an overrun',async()=>{
 const flagDir=mkdtempSync(join(tmpdir(),'goop-bench-sampled-')),flag=join(flagDir,'sampled');let sampled=0;
 try{
  // The runner finishes only after the harness has tried and failed to sample it.
  const result=await fakeRunner(`const fs=require('node:fs');const t=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(flag)}))return;clearInterval(t);fs.writeFileSync(process.argv[4],JSON.stringify({success:true,process_ms:1}));},5)`,{timeoutMs:30000,killGraceMs:30,readSnapshot:()=>{sampled++;writeFileSync(flag,'');sampleTimeout();}});
  assert.ok(sampled>0);assert.equal(result.success,true);assert.equal(result.budget_exceeded,false);assert.equal(result.timed_out,false);
 }finally{rmSync(flagDir,{recursive:true,force:true});}
});
test('single conversion post-exit storage read failure fails closed and still reaps the owned group',async()=>{
 const pidDir=mkdtempSync(join(tmpdir(),'goop-bench-reap-')),pidPath=join(pidDir,'descendant.pid');
 // A live failure would already set the overrun and short-circuit the post-exit
 // count, so only the post-exit call may fail. `run` stops the live monitor
 // before it writes run.stdout, so a count that sees that file is post-exit.
 let failedAfterExit=0;
 const failAfterExit=directory=>{if(!existsSync(join(directory,'run.stdout')))return 0;failedAfterExit++;return unreadableTree();};
 try{
  const result=await fakeRunner(`const fs=require('node:fs'),cp=require('node:child_process');const c=cp.spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},10)"],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidPath)},String(c.pid));c.unref();fs.writeFileSync(process.argv[4],JSON.stringify({success:true,process_ms:1}));`,{timeoutMs:30000,killGraceMs:50,measureBytes:failAfterExit,readSnapshot:()=>''});
  assert.equal(failedAfterExit,1);assert.equal(result.budget_exceeded,true);assert.equal(result.success,false);
  // The reap sends SIGKILL without waiting for the exit, so allow the kernel a
  // bounded moment. A descendant nothing killed ignores TERM and never exits.
  const runnableState=()=>{let state='';try{state=execFileSync('/bin/ps',['-o','stat=','-p',readFileSync(pidPath,'utf8')],{encoding:'utf8'}).trim();}catch{/* Gone. */}return state===''||/[ZE]/.test(state)?null:state;};
  let state=runnableState();
  for(let polls=0;state!==null&&polls<250;polls++){await new Promise(resolve=>setTimeout(resolve,20));state=runnableState();}
  assert.equal(state,null,`descendant remained runnable with state ${state}`);
 }finally{
  try{process.kill(Number(readFileSync(pidPath,'utf8')),'SIGKILL');}catch{/* Already gone, or never started. */}
  rmSync(pidDir,{recursive:true,force:true});
 }
});

test('dirty source identity changes when already-dirty file content changes', () => {
 const root=mkdtempSync(join(tmpdir(),'goop-identity-'));
 try {
  const gitEnv={
   ...withoutGitRepositoryEnvironment(process.env),
   GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',
   GIT_CONFIG_COUNT:'2',GIT_CONFIG_KEY_0:'core.hooksPath',GIT_CONFIG_VALUE_0:'/dev/null',GIT_CONFIG_KEY_1:'commit.gpgSign',GIT_CONFIG_VALUE_1:'false',
  };
  execFileSync('git',['init','-q'],{cwd:root,env:gitEnv});
  execFileSync('git',['config','user.email','test@example.invalid'],{cwd:root,env:gitEnv});
  execFileSync('git',['config','user.name','Test'],{cwd:root,env:gitEnv});
  const tracked=join(root,'tracked.txt'),untracked=join(root,'untracked.txt');
  writeFileSync(tracked,'base');execFileSync('git',['add','tracked.txt'],{cwd:root,env:gitEnv});execFileSync('git',['commit','-qm','base'],{cwd:root,env:gitEnv});
  writeFileSync(tracked,'first');writeFileSync(untracked,'one');
  const firstIdentity=captureIdentity({cwd:root,manifestText:'{}',bindingsText:'{}',sidecars:{fixture:tracked},environment:{...process.env,GIT_DIR:'/invalid/inherited/git-dir',GIT_WORK_TREE:'/invalid/inherited/work-tree'}});const first=firstIdentity.source.dirty_digest;
  assert.notEqual(firstIdentity.source.head,'unavailable');
  assert.equal(firstIdentity.sidecars.fixture.sha256,execFileSync('shasum',['-a','256',tracked],{encoding:'utf8'}).split(' ')[0]);
  assert.equal(firstIdentity.sidecars.fixture.path, realpathSync(tracked));
  assert.equal(firstIdentity.sidecars.fixture.bytes, 5);
  writeFileSync(tracked,'second');writeFileSync(untracked,'two');
  const second=captureIdentity({cwd:root,manifestText:'{}',bindingsText:'{}'}).source.dirty_digest;
  assert.notEqual(first,second);
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('captured identity fails closed on unavailable toolchain or sidecar facts', () => {
 const identity={source:{head:'a'.repeat(40),tree:'b'.repeat(40),dirty_digest:'c'.repeat(64),dirty:false},manifest_sha256:'d'.repeat(64),bindings_sha256:'e'.repeat(64),executables:{engine:{path:'/engine',sha256:'f'.repeat(64)}},sidecars:{ffprobe:{path:'/ffprobe',sha256:'1'.repeat(64),bytes:1,version:'test'}},parameters:{test:true},toolchain:{node:'test',rustc:'test',cargo:'test'},machine:{platform:'darwin',arch:'arm64',os:'test',hardware_model:'test',power_source:'test',low_power_mode:'test',thermal:'test',disk_available_bytes:'test'}};
 assert.equal(validateCapturedIdentity(identity),identity);
 assert.equal(validateCapturedIdentity({...identity,machine:{...identity.machine,power_source:'unavailable',low_power_mode:'unavailable',thermal:'unavailable'}}).machine.thermal,'unavailable');
 assert.throws(()=>validateCapturedIdentity({...identity,toolchain:{...identity.toolchain,rustc:'unavailable'}}),/toolchain\.rustc/i);
 assert.throws(()=>validateCapturedIdentity({...identity,sidecars:{ffprobe:{...identity.sidecars.ffprobe,version:'unavailable'}}}),/sidecar version/i);
});

test('bounded process cleanup reaps a TERM-resistant descendant before returning', { skip: process.platform === 'win32' }, async () => {
 const root = mkdtempSync(join(tmpdir(), 'goop-process-tree-'));
 const output = join(root, 'output'); mkdirSync(output);
 const pidPath = join(root, 'descendant.pid');
 const runner = join(root, 'runner.cjs');
 const descendant = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidPath)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},10)`;
 writeFileSync(runner, `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>{},10);`);
 let descendantPid = null;
 try {
  const result = await runBoundedProcess({ command: process.execPath, args: [runner], outputDirectory: output, timeoutMs: 1000, killGraceMs: 50, logLimitBytes: 1024, storageBudgetBytes: 1024 * 1024 });
  descendantPid = Number(readFileSync(pidPath, 'utf8'));
  assert.equal(result.timed_out, true);
  let state = '';
  try { state = execFileSync('/bin/ps', ['-o', 'stat=', '-p', String(descendantPid)], { encoding: 'utf8' }).trim(); } catch { /* Gone. */ }
  assert.ok(state === '' || /[ZE]/.test(state), `descendant remained runnable with state ${state}`);
 } finally {
  if (descendantPid) { try { process.kill(descendantPid, 'SIGKILL'); } catch { /* Already reaped. */ } }
  rmSync(root, { recursive: true, force: true });
 }
});

import { existsSync, readFileSync, mkdirSync, statSync } from 'node:fs';
import {
 parseManifest,
 validateBindings,
 validateEffectiveExecution,
 PERFORMANCE_LIMITATIONS,
} from './performance-manifest.mjs';
import {
 buildRunPlan,
 executeWorkloadAdapter,
 resolveRuntimeSidecars,
 runPerformanceSuite,
 summarizeSuite,
 normalSuite,
 normalizeCanonicalPathForComparison,
 validateDriverSidecars,
 validateWorkloadMetrics,
 verifyBatchOutputs,
} from './performance-suite.mjs';
import { runtimeSidecarEnvironment } from './performance-shared.mjs';
import {
 pairedExecutionOrder,
 comparePairedSummaries,
 collectPairedSamples,
 runPairedPlan,
 validatePairedVerification,
} from './performance-comparison.mjs';

const validManifest = () => ({
 schema_version: 1,
 suite_id: 'synthetic-perf-01a',
 limitations: [...PERFORMANCE_LIMITATIONS],
 defaults: {
  warmups: 1,
  repetitions: 5,
  timeout_ms: 2000,
  suite_timeout_ms: 60000,
  log_limit_bytes: 65536,
  suite_log_limit_bytes: 1048576,
  storage_budget_bytes: 1048576,
  suite_storage_budget_bytes: 16777216,
 },
 fixture_roles: ['raw_48mp', 'inspect_mixed'],
 workloads: [
  {
   id: 'raw-single',
   adapter: 'single_conversion',
   fixture_role: 'raw_48mp',
   request: { target: 'jpeg', quality_preset: null, resolution_cap: null, gif_options: null, compress_mode: null, batch_id: null, metadata_policy: 'preserve', subtitle: null },
   expected_output: { extension: 'jpg', probe: 'media', format_names: ['image2'], required_streams: [{ codec_type: 'video', codec_name: 'mjpeg' }] },
  },
  {
   id: 'inspect-burst',
   adapter: 'workload',
   mode: 'inspection_burst',
   fixture_roles: ['inspect_mixed'],
   source_count: 32,
   expected_output: { kind: 'metrics_only' },
  },
  {
   id: 'queue-1000',
   adapter: 'startup',
   jobs: 1000,
   expected_output: { kind: 'startup_marker' },
  },
 ],
});

test('strict manifest round-trips and rejects unknown fields', () => {
 const manifest = validManifest();
 assert.deepEqual(parseManifest(JSON.stringify(manifest)), manifest);
 assert.throws(() => parseManifest(JSON.stringify({ ...manifest, surprise: true })), /unknown field.*surprise/i);
 assert.throws(() => parseManifest(JSON.stringify({ ...manifest, schema_version: 2 })), /schema_version/i);
});

test('tracked real-suite manifest covers the approved PERF-01A matrix', () => {
 const manifest = parseManifest(readFileSync(new URL('./performance-suite.example.json', import.meta.url), 'utf8'));
 assert.deepEqual(manifest.fixture_roles, ['raw_48mp', 'inspect_image', 'inspect_video', 'video_1080_encode', 'video_4k_encode', 'video_h264_copy', 'video_hevc_copy']);
 assert.deepEqual(manifest.workloads.map(workload => workload.id), [
  'raw-single', 'raw-batch-4', 'inspection-single', 'inspection-burst-32',
  'video-1080-software-encode', 'video-4k-software-encode', 'video-h264-copy', 'video-hevc-copy',
  'queue-0', 'queue-200', 'queue-1000',
 ]);
 assert.equal(manifest.workloads.find(workload => workload.id === 'raw-batch-4').items.length, 4);
 const burst=manifest.workloads.find(workload => workload.id === 'inspection-burst-32');
 assert.equal(burst.source_count, 32);
 assert.deepEqual(burst.fixture_roles, Array.from({length:32},(_,index)=>index%2===0?'inspect_image':'inspect_video'));
});

test('manifest rejects duplicate IDs, unsupported modes, unsafe limits, and missing checks', () => {
 const duplicate = validManifest();
 duplicate.workloads.push({ ...duplicate.workloads[0] });
 assert.throws(() => parseManifest(JSON.stringify(duplicate)), /duplicate workload id/i);
 const mode = validManifest();
 mode.workloads[1].mode = 'mystery';
 assert.throws(() => parseManifest(JSON.stringify(mode)), /mode/i);
 const count = validManifest();
 count.workloads[1].source_count = 0;
 assert.throws(() => parseManifest(JSON.stringify(count)), /source_count/i);
 const concurrency = validManifest();
 concurrency.workloads[1].concurrency = 1;
 assert.throws(() => parseManifest(JSON.stringify(concurrency)), /unknown field.*concurrency/i);
 const repeat = validManifest();
 repeat.defaults.repetitions = 0;
 assert.throws(() => parseManifest(JSON.stringify(repeat)), /repetitions/i);
 const timeout = validManifest();
 timeout.defaults.timeout_ms = -1;
 assert.throws(() => parseManifest(JSON.stringify(timeout)), /timeout_ms/i);
 const budget = validManifest();
 budget.defaults.storage_budget_bytes = 0;
 assert.throws(() => parseManifest(JSON.stringify(budget)), /storage_budget_bytes/i);
 const output = validManifest();
 delete output.workloads[0].expected_output;
 assert.throws(() => parseManifest(JSON.stringify(output)), /expected_output/i);
 const escaped = validManifest();
 escaped.workloads[0].id = '../escape';
 assert.throws(() => parseManifest(JSON.stringify(escaped)), /id/i);
 const unknownRequest = validManifest();
 unknownRequest.workloads[0].request.future_control = true;
 assert.throws(() => parseManifest(JSON.stringify(unknownRequest)), /unknown field.*future_control/i);
 const escapingExtension = validManifest();
 escapingExtension.workloads[0].expected_output.extension = '../../../../escape';
 assert.throws(() => parseManifest(JSON.stringify(escapingExtension)), /extension/i);
 const wrongShape = validManifest();
 wrongShape.workloads[2].expected_output = { kind: 'metrics_only' };
 assert.throws(() => parseManifest(JSON.stringify(wrongShape)), /kind/i);
 const mismatchedTarget = validManifest();
 mismatchedTarget.workloads[0].expected_output.extension = 'mp4';
 assert.throws(() => parseManifest(JSON.stringify(mismatchedTarget)), /target.*extension/i);
 const missingCodec = validManifest();
 missingCodec.workloads[0].expected_output.required_streams = [];
 assert.throws(() => parseManifest(JSON.stringify(missingCodec)), /required_streams/i);
});

test('effective execution must prove copy or the requested software encoder', () => {
 assert.equal(validateEffectiveExecution({requested:{kind:'copy'},encoder:null},{video_options:{kind:'copy'}}),true);
 assert.equal(validateEffectiveExecution({requested:{kind:'encode',codec:'h264',processor:'software'},encoder:'libx264'},{video_options:{kind:'encode',codec:'h264',processor:'software'}}),true);
 assert.throws(()=>validateEffectiveExecution({requested:{kind:'encode',codec:'h264',processor:'software'},encoder:'h264_videotoolbox'},{video_options:{kind:'encode',codec:'h264',processor:'software'}}),/hardware encoder/i);
 assert.throws(()=>validateEffectiveExecution(null,{video_options:{kind:'copy'}}),/requested mode/i);
});

test('bindings require every role, absolute immutable sources, bytes, and sha256', async () => {
 const root = mkdtempSync(join(tmpdir(), 'goop-manifest-'));
 try {
  const raw = join(root, 'raw.bin'), inspect = join(root, 'inspect.bin');
  writeFileSync(raw, 'raw'); writeFileSync(inspect, 'inspect');
  const crypto = await import('node:crypto');
  const sha = path => crypto.createHash('sha256').update(readFileSync(path)).digest('hex');
  const binding = { schema_version: 1, fixtures: {
   raw_48mp: { path: raw, sha256: sha(raw), bytes: 3 },
   inspect_mixed: { path: inspect, sha256: sha(inspect), bytes: 7 },
  } };
  assert.deepEqual(Object.keys(validateBindings(validManifest(), binding)).sort(), ['inspect_mixed', 'raw_48mp']);
  assert.throws(() => validateBindings(validManifest(), { ...binding, extra: true }), /unknown field.*extra/i);
  const missing = structuredClone(binding); delete missing.fixtures.inspect_mixed;
  assert.throws(() => validateBindings(validManifest(), missing), /inspect_mixed/i);
  const relative = structuredClone(binding); relative.fixtures.raw_48mp.path = 'raw.bin';
  assert.throws(() => validateBindings(validManifest(), relative), /absolute/i);
  const changed = structuredClone(binding); changed.fixtures.raw_48mp.sha256 = '0'.repeat(64);
  assert.throws(() => validateBindings(validManifest(), changed), /sha-256 mismatch/i);
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test('run plan is deterministic, unique, and excludes one warmup from summaries', () => {
 const plan = buildRunPlan(validManifest());
 assert.equal(plan.length, 18);
 assert.equal(plan.filter(run => run.phase === 'warmup').length, 3);
 assert.equal(plan.filter(run => run.phase === 'measured').length, 15);
 assert.equal(new Set(plan.map(run => run.destination)).size, plan.length);
 assert.deepEqual(plan, buildRunPlan(validManifest()));
});

test('suite summary retains available duration, memory, and output evidence without fabricating zeros', () => {
 const manifest = { workloads: [{ id: 'one' }] };
 const samples = [
  { workload_id: 'one', phase: 'measured', status: 'success', result: { process_ms: 10, sampled_tree_peak_KiB: null, time_peak_bytes: null, verification: { output_bytes: 5 } } },
  { workload_id: 'one', phase: 'measured', status: 'success', result: { process_ms: 20, process: { sampled_tree_peak_KiB: 100, time_peak_bytes: 200 }, verification: { output_bytes: 7 } } },
 ];
 const summary = summarizeSuite(samples, manifest).workloads.one;
 assert.equal(summary.duration_ms.median, 15);
 assert.deepEqual(summary.sampled_tree_peak_KiB, { median: 100, min: 100, max: 100, measured: 1, not_measured: 1 });
 assert.deepEqual(summary.time_peak_bytes, { median: 200, min: 200, max: 200, measured: 1, not_measured: 1 });
 assert.deepEqual(summary.output_bytes, { median: 6, min: 5, max: 7, measured: 2, not_measured: 0 });
 assert.deepEqual(summary.phase_timings_ms.process_ms, { median: 15, min: 10, max: 20, measured: 2, not_measured: 0 });
 assert.deepEqual(summary.phase_timings_ms.wall_ms, { median: null, min: null, max: null, measured: 0, not_measured: 2 });
 assert.equal(summary.item_phase_timings_ms, null);
});

test('suite summary reports workload adapter phases without inventing missing values', () => {
 const manifest = { workloads: [{ id: 'batch' }] };
 const samples = [{ workload_id: 'batch', phase: 'measured', status: 'success', result: { aggregate_ms: 9, wall_ms: 12, encoder_detection_ms: 2, items: [
  { elapsed_ms: 4, source_fingerprint_before_ms: 0.5, source_fingerprint_after_ms: 0.6, admission_ms: 1, process_ms: 3, probe_ms: null },
  { elapsed_ms: 6, source_fingerprint_before_ms: 0.7, source_fingerprint_after_ms: 0.8, admission_ms: 2, process_ms: 4, probe_ms: null },
 ] } }];
 const summary = summarizeSuite(samples, manifest).workloads.batch;
 assert.equal(summary.phase_timings_ms.aggregate_ms.median, 9);
 assert.equal(summary.phase_timings_ms.wall_ms.median, 12);
 assert.deepEqual(summary.item_phase_timings_ms.process_ms, { median: 3.5, min: 3, max: 4, measured: 2, not_measured: 0 });
 assert.deepEqual(summary.item_phase_timings_ms.probe_ms, { median: null, min: null, max: null, measured: 0, not_measured: 2 });
});

test('ledger compaction preserves truthful summaries for oversized valid results', async () => {
 const root=mkdtempSync(join(tmpdir(),'goop-suite-compaction-'));
 try {
  const raw=join(root,'raw.bin'),inspect=join(root,'inspect.bin');writeFileSync(raw,'raw');writeFileSync(inspect,'inspect');
  const crypto=await import('node:crypto');const sha=path=>crypto.createHash('sha256').update(readFileSync(path)).digest('hex');
  const manifest=validManifest();manifest.defaults.repetitions=1;manifest.workloads=[manifest.workloads[1]];
  const bindings=validateBindings(manifest,{schema_version:1,fixtures:{raw_48mp:{path:raw,sha256:sha(raw),bytes:3},inspect_mixed:{path:inspect,sha256:sha(inspect),bytes:7}}});
  const sidecars={ffmpeg:{canonical_path:'/runtime/ffmpeg',source_is_path:false},ffprobe:{canonical_path:'/runtime/ffprobe',source_is_path:false}};
  const state=await runPerformanceSuite({manifest,bindings,prevalidatedBindings:true,outputDirectory:join(root,'output'),execute:async()=>({success:true,process_ms:10,process:{sampled_tree_peak_KiB:123,time_peak_bytes:456},verification:{output_bytes:7},items:[{probe_ms:2,elapsed_ms:3,source_fingerprint_before_ms:0.1,source_fingerprint_after_ms:0.2,admission_ms:null,process_ms:null}],sidecars,padding:'x'.repeat(300000)})});
  assert.equal(state.samples.every(sample=>sample.result.evidence_compacted===true),true);
  assert.equal(state.samples.every(sample=>stableStringify(sample.result.sidecars)===stableStringify(sidecars)),true);
  for(const sample of state.samples){const full=join(root,'output',sample.result.full_result_path);assert.equal(existsSync(full),true);assert.equal(sha(full),sample.result.full_result_sha256);assert.equal(statSync(full).size,sample.result.full_result_bytes);assert.equal(sample.result.full_result_retained,true);}
  const summary=state.summary.workloads['inspect-burst'];assert.equal(summary.duration_ms.median,10);assert.equal(summary.sampled_tree_peak_KiB.median,123);assert.equal(summary.time_peak_bytes.median,456);assert.equal(summary.output_bytes.median,7);assert.equal(summary.item_phase_timings_ms.probe_ms.median,2);
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('compact ledger serialization keeps adversarial nested arrays within the declared suite bound', async () => {
 const root=mkdtempSync(join(tmpdir(),'goop-suite-ledger-bound-'));
 try {
  const raw=join(root,'raw.bin'),inspect=join(root,'inspect.bin');writeFileSync(raw,'raw');writeFileSync(inspect,'inspect');
  const crypto=await import('node:crypto');const sha=path=>crypto.createHash('sha256').update(readFileSync(path)).digest('hex');
  const manifest=validManifest();manifest.defaults.repetitions=1;manifest.defaults.suite_storage_budget_bytes=1300000;manifest.workloads=[manifest.workloads[0]];
  const bindings=validateBindings(manifest,{schema_version:1,fixtures:{raw_48mp:{path:raw,sha256:sha(raw),bytes:3},inspect_mixed:{path:inspect,sha256:sha(inspect),bytes:7}}});
  const output=join(root,'output');await runPerformanceSuite({manifest,bindings,prevalidatedBindings:true,outputDirectory:output,execute:async()=>({success:true,process_ms:1,padding:Array(80000).fill(0)})});
  assert.ok(directoryBytes(output)<=manifest.defaults.suite_storage_budget_bytes);
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('compact paired ledger serialization keeps nested arrays within its declared bound', async () => {
 const root=mkdtempSync(join(tmpdir(),'goop-paired-ledger-bound-')),output=join(root,'output'),budget=1048576;
 try {
  const state=await collectPairedSamples({workloadIds:['copy'],repetitions:2,outputDirectory:output,totalLimits:{suite_timeout_ms:10000,suite_log_limit_bytes:1048576,suite_storage_budget_bytes:budget},execute:async()=>({success:true,process_ms:1,padding:Array(20000).fill(0)})});
  assert.equal(state.status,'complete');assert.ok(directoryBytes(output)<=budget);
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('persisted full results remain inside the per-run storage bound', async () => {
 const root=mkdtempSync(join(tmpdir(),'goop-full-result-run-bound-'));
 try {
  const raw=join(root,'raw.bin'),inspect=join(root,'inspect.bin');writeFileSync(raw,'raw');writeFileSync(inspect,'inspect');const crypto=await import('node:crypto');const sha=path=>crypto.createHash('sha256').update(readFileSync(path)).digest('hex');
  const manifest=validManifest();manifest.defaults.repetitions=1;manifest.defaults.storage_budget_bytes=1024;manifest.workloads=[manifest.workloads[0]];
  const bindings=validateBindings(manifest,{schema_version:1,fixtures:{raw_48mp:{path:raw,sha256:sha(raw),bytes:3},inspect_mixed:{path:inspect,sha256:sha(inspect),bytes:7}}});const output=join(root,'output');
  await assert.rejects(runPerformanceSuite({manifest,bindings,prevalidatedBindings:true,outputDirectory:output,execute:async()=>({success:true,process_ms:1,padding:'x'.repeat(300000)})}),/workload storage budget/i);
  const state=JSON.parse(readFileSync(join(output,'suite-state.json'),'utf8'));assert.equal(state.samples.length,1);assert.equal(state.samples[0].result.budget_exceeded,true);assert.equal(state.samples[0].result.full_result_retained,false);assert.equal(existsSync(join(output,'raw-single','warmup-0')),false);
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('paired order warms both revisions before alternating measured repetitions', () => {
 const order=pairedExecutionOrder(['raw-single'],4);
 assert.deepEqual(order.map(v=>`${v.phase}:${v.revision}`),['warmup:baseline','warmup:candidate','measured:baseline','measured:candidate','measured:candidate','measured:baseline','measured:baseline','measured:candidate','measured:candidate','measured:baseline']);
 assert.deepEqual(order.slice(0,2).map(v=>v.repetition),[null,null]);
});

test('paired comparison requires equivalent identity and flags over ten percent without failing', () => {
 const identity = { source:{head:'a'.repeat(40),tree:'b'.repeat(40),dirty_digest:'c'.repeat(64),dirty:false},manifest_sha256: 'a'.repeat(64), bindings_sha256: 'b'.repeat(64), executables:{engine:{path:'/engine',sha256:'d'.repeat(64)}},toolchain: { node:'test',rustc: 'test',cargo:'test' }, sidecars: { ffprobe:{path:'/ffprobe',sha256:'e'.repeat(64),bytes:1,version:'test'} }, parameters: { hardware_enabled: false }, machine: { platform: 'darwin', arch: 'arm64', os:'test',hardware_model: 'Mac',power_source:'test',low_power_mode:'test',thermal:'test',disk_available_bytes:'test' } };
 const result = comparePairedSummaries({ workload_id: 'copy', repetitions: 5, identity, samples: [10, 10, 10, 10, 10] }, { workload_id: 'copy', repetitions: 5, identity, samples: [12, 12, 12, 12, 12] });
 assert.equal(result.percent_change, 20);
 assert.equal(result.investigation_required, true);
 assert.equal(result.success, true);
 assert.throws(() => comparePairedSummaries({ workload_id: 'copy', repetitions: 1, identity, samples: [10] }, { workload_id: 'copy', repetitions: 1, identity: { ...identity, machine: { ...identity.machine, hardware_model: 'other' } }, samples: [10] }), /identity mismatch/i);
 assert.throws(() => comparePairedSummaries({ workload_id: 'copy', repetitions: 1, identity, samples: [10] }, { workload_id: 'encode', repetitions: 1, identity, samples: [10] }), /workload/i);
 assert.throws(() => comparePairedSummaries({ workload_id: 'copy', repetitions: 2, identity, samples: [10, 11] }, { workload_id: 'copy', repetitions: 1, identity, samples: [10] }), /repetitions|count/i);
});

test('paired collector executes the frozen alternating order and retains failures', async () => {
 const root = mkdtempSync(join(tmpdir(), 'goop-paired-'));
 const visited = [];
 try {
  const result = await collectPairedSamples({ workloadIds: ['copy'], repetitions: 2, outputDirectory: join(root, 'output'), execute: async step => {
   visited.push(`${step.phase}:${step.repetition}:${step.revision}`);
   return { success: step.revision === 'baseline', process_ms: 1 };
  } });
  assert.deepEqual(visited, ['warmup:null:baseline','warmup:null:candidate','measured:0:baseline','measured:0:candidate','measured:1:candidate','measured:1:baseline']);
  assert.equal(result.samples.length, 6);
  assert.equal(result.samples.filter(sample => sample.status === 'excluded').length, 1);
  assert.equal(result.samples.filter(sample => sample.status === 'failed').length, 3);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'output', 'paired-state.json'), 'utf8')), result);
  await assert.rejects(collectPairedSamples({ workloadIds: ['copy'], repetitions: 1, outputDirectory: join(root, 'output'), execute: async () => ({ success: true }) }), /must be new/i);
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test('paired plan is runnable and writes bound comparisons', async () => {
 const root = mkdtempSync(join(tmpdir(), 'goop-paired-plan-'));
 try {
  const contractFacts={expected_output:{extension:'mp4',probe:'media',format_names:['mov','mp4'],required_streams:[{codec_type:'video',codec_name:'h264'}]},request:{video_options:{kind:'copy'}}};
  const contractSha256=sha256Text(stableStringify(contractFacts));
  const runner = join(root, 'runner.cjs');
  writeFileSync(runner, `const fs=require('node:fs');const value=process.env.GOOP_PERF_REVISION==='baseline'?10:12;fs.writeFileSync(process.env.GOOP_PERF_RESULT_PATH,JSON.stringify({success:true,process_ms:value,workload_id:process.env.GOOP_PERF_WORKLOAD_ID,revision:process.env.GOOP_PERF_REVISION,verification:{success:true,contract_sha256:${JSON.stringify(contractSha256)},kind:'media',contract_facts:${JSON.stringify(contractFacts)},evidence:{output_bytes:1,probe:{streams:[{codec_type:'video',codec_name:'h264'}],format:{format_name:'mov,mp4'}},effective_execution:{requested:{kind:'copy'},encoder:null}}}}));`);
  const crypto = await import('node:crypto');
  const commandSha256 = crypto.createHash('sha256').update(readFileSync(process.execPath)).digest('hex');
  const identity = { source:{head:'a'.repeat(40),tree:'b'.repeat(40),dirty_digest:'c'.repeat(64),dirty:false},manifest_sha256: 'a'.repeat(64), bindings_sha256: 'b'.repeat(64), executables:{engine:{path:process.execPath,sha256:commandSha256}},toolchain: { node: process.version,rustc:'test',cargo:'test' }, sidecars: {ffprobe:{path:'/ffprobe',sha256:'d'.repeat(64),bytes:1,version:'test'}}, parameters: { test: true }, machine: { platform: process.platform, arch: process.arch, os:'test',hardware_model:'test',power_source:'test',low_power_mode:'test',thermal:'test',disk_available_bytes:'test' } };
  const plan = { schema_version: 1, repetitions: 2, workload_ids: ['copy'], workload_contracts:{copy:{contract_sha256:contractSha256,evidence_kind:'media',expected_facts:contractFacts}}, limits: { timeout_ms: 2000, suite_timeout_ms:10000, log_limit_bytes:65536, suite_log_limit_bytes:1048576, storage_budget_bytes:1048576, suite_storage_budget_bytes:4194304 }, revisions: {
   baseline: { command: process.execPath, command_sha256: commandSha256, args: [runner], identity },
   candidate: { command: process.execPath, command_sha256: commandSha256, args: [runner], identity },
  } };
  const result = await runPairedPlan({ plan, outputDirectory: join(root, 'output') });
  assert.equal(result.state.status, 'complete');
  assert.deepEqual(result.state.samples.map(sample => `${sample.phase}:${sample.repetition}:${sample.revision}`), ['warmup:null:baseline','warmup:null:candidate','measured:0:baseline','measured:0:candidate','measured:1:candidate','measured:1:baseline']);
  assert.deepEqual(result.state.samples.slice(0,2).map(sample=>sample.status),['excluded','excluded']);
  assert.equal(result.comparisons.copy.percent_change, 20);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'output', 'comparison.json'), 'utf8')), result.comparisons);
  await assert.rejects(runPairedPlan({ plan: { ...plan, workload_ids: ['../escape'] }, outputDirectory: join(root, 'escape') }), /workload.*identifier/i);
  await assert.rejects(runPairedPlan({ plan: { ...plan, workload_ids: ['copy', 'copy'] }, outputDirectory: join(root, 'duplicate') }), /duplicate workload/i);
  await assert.rejects(runPairedPlan({ plan: { ...plan, revisions: { ...plan.revisions, baseline: { ...plan.revisions.baseline, command_sha256: '0'.repeat(64) } } }, outputDirectory: join(root, 'wrong-command') }), /command sha-256/i);
  await assert.rejects(runPairedPlan({ plan: { ...plan, revisions: { ...plan.revisions, baseline: { ...plan.revisions.baseline, identity: {} } } }, outputDirectory: join(root, 'empty-identity') }), /identity/i);
  const linkedCommand=join(root,'node-link');symlinkSync(process.execPath,linkedCommand);
  await assert.rejects(runPairedPlan({plan:{...plan,revisions:{...plan.revisions,baseline:{...plan.revisions.baseline,command:linkedCommand},candidate:{...plan.revisions.candidate,command:linkedCommand}}},outputDirectory:join(root,'linked-command')}),/command sha-256/i);
  const noEvidenceRunner=join(root,'no-evidence.cjs');writeFileSync(noEvidenceRunner,"require('node:fs').writeFileSync(process.env.GOOP_PERF_RESULT_PATH,JSON.stringify({success:true,process_ms:1}))");
  await assert.rejects(runPairedPlan({plan:{...plan,repetitions:1,revisions:{...plan.revisions,baseline:{...plan.revisions.baseline,args:[noEvidenceRunner]},candidate:{...plan.revisions.candidate,args:[noEvidenceRunner]}}},outputDirectory:join(root,'no-evidence')}),/paired execution failed/i);
  const noisyNoResult=join(root,'noisy-no-result.cjs');writeFileSync(noisyNoResult,"process.stdout.write('x'.repeat(5000));");
  const noisyPlan={...plan,repetitions:2,limits:{...plan.limits,log_limit_bytes:1024,suite_log_limit_bytes:1024},revisions:{...plan.revisions,baseline:{...plan.revisions.baseline,args:[noisyNoResult]},candidate:{...plan.revisions.candidate,args:[noisyNoResult]}}};
  const noisyOutput=join(root,'noisy-no-result');
  await assert.rejects(runPairedPlan({plan:noisyPlan,outputDirectory:noisyOutput}),/paired execution failed/i);
  const noisyState=JSON.parse(readFileSync(join(noisyOutput,'paired-state.json'),'utf8'));
  assert.equal(noisyState.samples.length,2);assert.equal(noisyState.samples[1].result.log_budget_exceeded,true);
 } finally { rmSync(root, { recursive: true, force: true }); }
});

// A run directory the symlink scan cannot list hides every link in it, so the
// paired log writes must refuse a link rather than follow it out. The suite's
// own checks may then fail on the same directory, so only the outside file and
// the surviving link are checked.
test('a paired run whose directory the symlink scan cannot list never follows a link left at a log path',{skip:process.platform==='win32'||process.getuid?.()===0,timeout:60000},async t=>{
 const root=mkdtempSync(join(tmpdir(),'goop-paired-scan-link-')),outside=join(root,'outside.txt'),runner=join(root,'runner.cjs'),runs=join(root,'run-directories');
 t.after(()=>{try{for(const path of readFileSync(runs,'utf8').split('\n').filter(Boolean))chmodSync(path,0o700);}catch{/* Never ran. */}rmSync(root,{recursive:true,force:true});});
 writeFileSync(outside,'outside');
 writeFileSync(runner,`const fs=require('node:fs'),path=require('node:path'),dir=process.env.GOOP_PERF_OUTPUT_DIR;fs.appendFileSync(${JSON.stringify(runs)},dir+'\\n');for(const name of ['stdout.log','stderr.log'])fs.symlinkSync(${JSON.stringify(outside)},path.join(dir,name));fs.chmodSync(dir,0o300);`);
 const crypto=await import('node:crypto');
 const commandSha256=crypto.createHash('sha256').update(readFileSync(process.execPath)).digest('hex');
 const contractFacts={jobs:0,marker_schema_version:1},contract={contract_sha256:sha256Text(stableStringify(contractFacts)),evidence_kind:'startup',expected_facts:contractFacts};
 const identity={source:{head:'a'.repeat(40),tree:'b'.repeat(40),dirty_digest:'c'.repeat(64),dirty:false},manifest_sha256:'a'.repeat(64),bindings_sha256:'b'.repeat(64),executables:{engine:{path:process.execPath,sha256:commandSha256}},toolchain:{node:process.version,rustc:'test',cargo:'test'},sidecars:{ffprobe:{path:'/ffprobe',sha256:'d'.repeat(64),bytes:1,version:'test'}},parameters:{test:true},machine:{platform:process.platform,arch:process.arch,os:'test',hardware_model:'test',power_source:'test',low_power_mode:'test',thermal:'test',disk_available_bytes:'test'}};
 const revision={command:process.execPath,command_sha256:commandSha256,args:[runner],identity};
 const plan={schema_version:1,repetitions:1,workload_ids:['copy'],workload_contracts:{copy:contract},limits:{timeout_ms:20000,suite_timeout_ms:40000,log_limit_bytes:65536,suite_log_limit_bytes:1048576,storage_budget_bytes:1048576,suite_storage_budget_bytes:4194304},revisions:{baseline:revision,candidate:revision}};
 await runPairedPlan({plan,outputDirectory:join(root,'output')}).catch(()=>{/* The suite's own checks fail on the same directory. */});
 const [first]=readFileSync(runs,'utf8').split('\n');chmodSync(first,0o700);
 assert.equal(readFileSync(outside,'utf8'),'outside');
 assert.equal(lstatSync(join(first,'stdout.log')).isSymbolicLink(),true);
});

test('paired verification binds media codecs, inspection source order, and startup jobs', () => {
 const step={workload_id:'work',revision:'baseline'};
 const makeContract=(evidenceKind,expectedFacts)=>({evidence_kind:evidenceKind,expected_facts:expectedFacts,contract_sha256:sha256Text(stableStringify(expectedFacts))});
 const makeResult=(contract,evidence)=>({success:true,process_ms:1,workload_id:'work',revision:'baseline',verification:{success:true,contract_sha256:contract.contract_sha256,kind:contract.evidence_kind,contract_facts:contract.expected_facts,evidence}});
 const mediaFacts={expected_output:{extension:'mp4',probe:'media',format_names:['mov','mp4'],required_streams:[{codec_type:'video',codec_name:'h264'}]},request:{video_options:{kind:'copy'}}};
 const media=makeContract('media',mediaFacts);
 assert.equal(validatePairedVerification(makeResult(media,{output_bytes:1,probe:{streams:[{codec_type:'video',codec_name:'h264'}],format:{format_name:'mov,mp4'}},effective_execution:{requested:{kind:'copy'},encoder:null}}),step,media),true);
 assert.equal(validatePairedVerification(makeResult(media,{output_bytes:1,probe:{streams:[{codec_type:'video',codec_name:'hevc'}],format:{format_name:'mov,mp4'}},effective_execution:{requested:{kind:'copy'},encoder:null}}),step,media),false);
 const inspectionFacts={source_count:2,source_sha256:['a'.repeat(64),'b'.repeat(64)]};const inspection=makeContract('inspection',inspectionFacts);
 assert.equal(validatePairedVerification(makeResult(inspection,{items:[{source_sha256:'b'.repeat(64),probe_ms:1},{source_sha256:'a'.repeat(64),probe_ms:1}]}),step,inspection),false);
 const startupFacts={jobs:200,marker_schema_version:1};const startup=makeContract('startup',startupFacts);
 assert.equal(validatePairedVerification(makeResult(startup,{jobs:1000,marker:{schema_version:1,backend_ready_ms:1}}),step,startup),false);
});

test('paired collection stops on the first total-budget overrun', async () => {
 const root=mkdtempSync(join(tmpdir(),'goop-paired-budget-'));
 try {
  let runs=0;
  const state=await collectPairedSamples({workloadIds:['copy'],repetitions:2,outputDirectory:join(root,'output'),totalLimits:{suite_timeout_ms:10000,suite_log_limit_bytes:1024,suite_storage_budget_bytes:1048576},execute:async()=>{runs+=1;return {success:true,process_ms:1,process:{log_bytes_retained:1025}};}});
  assert.equal(runs,1);assert.equal(state.status,'failed');assert.equal(state.samples[0].result.log_budget_exceeded,true);
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('paired collector exposes decreasing suite allowances to every launch', async () => {
 const root=mkdtempSync(join(tmpdir(),'goop-paired-allowances-'));
 try {
  const seen=[];
  const state=await collectPairedSamples({workloadIds:['copy'],repetitions:1,outputDirectory:join(root,'output'),totalLimits:{suite_timeout_ms:10000,suite_log_limit_bytes:450,suite_storage_budget_bytes:1048576},execute:async step=>{seen.push({log:step.suite_remaining_log_bytes,storage:step.suite_remaining_storage_bytes});return {success:true,process_ms:1,process:{log_bytes_retained:100}};}});
  assert.equal(state.status,'complete');
  assert.deepEqual(seen.map(value=>value.log),[450,350,250,150]);
  assert.equal(seen.every(value=>Number.isSafeInteger(value.storage)&&value.storage>0&&value.storage<1048576),true);
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('paired collector compacts oversized direct adapter results before ledger writes', async () => {
 const root=mkdtempSync(join(tmpdir(),'goop-paired-result-bound-')),output=join(root,'output');
 try {
  const state=await collectPairedSamples({workloadIds:['copy'],repetitions:1,outputDirectory:output,totalLimits:{suite_timeout_ms:10000,suite_log_limit_bytes:1048576,suite_storage_budget_bytes:1048576},execute:async()=>({success:true,process_ms:1,padding:'x'.repeat(100000)})});
  assert.equal(state.status,'failed');assert.equal(state.samples.every(sample=>sample.result.result_too_large===true),true);assert.equal(state.samples.every(sample=>sample.result.padding===undefined),true);assert.ok(directoryBytes(output)<=1048576);
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('paired collection stops once a sample reports its output pipes held after the reap', async () => {
 // runPairedPlan nests the bounded runner's result under `process`, a direct
 // adapter can report it at the top, and an oversized result is compacted away.
 const held='The output pipes were still held one kill grace after the reap, most likely by a process outside the owned group';
 for(const [shape,heldResult] of [['nested',{success:true,process_ms:1,process:{stdio_error:held}}],['top-level',{success:true,process_ms:1,stdio_error:held}],['oversized',{success:true,process_ms:1,padding:'x'.repeat(100000),process:{stdio_error:held}}]]){
  const root=mkdtempSync(join(tmpdir(),'goop-paired-held-')),output=join(root,'output');
  try {
   const visited=[];
   const state=await collectPairedSamples({workloadIds:['copy','encode'],repetitions:1,outputDirectory:output,execute:async step=>{visited.push(`${step.workload_id}:${step.phase}:${step.revision}`);return visited.length===2?heldResult:{success:true,process_ms:1,process:{stdio_error:null}};}});
   assert.deepEqual(visited,['copy:warmup:baseline','copy:warmup:candidate'],shape);
   assert.equal(state.status,'failed',shape);assert.deepEqual(state.samples.map(sample=>sample.status),['excluded','failed'],shape);assert.equal(state.samples[1].result.stdio_error,held,shape);
   assert.deepEqual(JSON.parse(readFileSync(join(output,'paired-state.json'),'utf8')),state,shape);
  } finally {rmSync(root,{recursive:true,force:true});}
 }
});

// A directory where the adapter writes the run's stdout log makes that write
// fail after the runner has already reported the held pipes.
for(const [label,leftover] of [['',''],[' and blocks its log',"fs.mkdirSync(require('node:path').join(process.env.GOOP_PERF_OUTPUT_DIR,'stdout.log'));"]]){
 test(`a paired plan launches nothing after a sample whose output pipes a process outside the owned group still holds${label}`,{skip:process.platform==='win32',timeout:60000},async t=>{
  const root=mkdtempSync(join(tmpdir(),'goop-paired-held-plan-')),armed=join(root,'holder.pid'),launches=join(root,'launches'),runner=join(root,'runner.cjs'),output=join(root,'output');
  // The holder outlives the suite, so only this ends it, on a timeout too.
  t.after(()=>{const pid=armedPid(armed);if(pid)try{process.kill(pid,'SIGKILL');}catch{/* Already gone. */}rmSync(root,{recursive:true,force:true});});
  // Only the first launch leaves a holder, so a suite that kept going would launch every later sample.
  writeFileSync(runner,`require('node:fs').appendFileSync(${JSON.stringify(launches)},'launch\\n');if(!require('node:fs').existsSync(${JSON.stringify(armed)})){${escapedHolder(armed,leftover)}}`);
  const crypto=await import('node:crypto');
  const commandSha256=crypto.createHash('sha256').update(readFileSync(process.execPath)).digest('hex');
  const contractFacts={jobs:0,marker_schema_version:1},contract={contract_sha256:sha256Text(stableStringify(contractFacts)),evidence_kind:'startup',expected_facts:contractFacts};
  const identity={source:{head:'a'.repeat(40),tree:'b'.repeat(40),dirty_digest:'c'.repeat(64),dirty:false},manifest_sha256:'a'.repeat(64),bindings_sha256:'b'.repeat(64),executables:{engine:{path:process.execPath,sha256:commandSha256}},toolchain:{node:process.version,rustc:'test',cargo:'test'},sidecars:{ffprobe:{path:'/ffprobe',sha256:'d'.repeat(64),bytes:1,version:'test'}},parameters:{test:true},machine:{platform:process.platform,arch:process.arch,os:'test',hardware_model:process.platform==='darwin'?'test':null,power_source:'test',low_power_mode:'test',thermal:'test',disk_available_bytes:'test'}};
  const revision={command:process.execPath,command_sha256:commandSha256,args:[runner],identity};
  const plan={schema_version:1,repetitions:1,workload_ids:['copy','encode'],workload_contracts:{copy:contract,encode:contract},limits:{timeout_ms:20000,suite_timeout_ms:40000,log_limit_bytes:65536,suite_log_limit_bytes:1048576,storage_budget_bytes:1048576,suite_storage_budget_bytes:4194304},revisions:{baseline:revision,candidate:revision}};
  await assert.rejects(runPairedPlan({plan,outputDirectory:output}),/paired execution failed/i);
  assert.ok(armedPid(armed),'the holder never armed');
  assert.equal(readFileSync(launches,'utf8'),'launch\n');
  const state=JSON.parse(readFileSync(join(output,'paired-state.json'),'utf8'));
  assert.equal(state.status,'failed');assert.equal(state.samples.length,1);assert.match(state.samples[0].result.process.stdio_error??'',/output pipes/i);assert.equal(state.comparison_error,undefined);
  // The workload the stop never reached says so instead of failing a comparison it never had.
  const comparisons=JSON.parse(readFileSync(join(output,'comparison.json'),'utf8'));
  assert.equal(comparisons.copy.success,false);assert.equal(comparisons.encode.success,false);assert.equal(comparisons.encode.not_run,true);
 });
}

test('workload metrics accept phase-separated Rust evidence and reject partial failure or contradictory process status', () => {
 const request = { mode: 'conversion_batch', concurrency: 2, items: [{ id: 'one' }, { id: 'two' }] };
 const evidence = { memory_evidence: 'external process tree required', path_safety_limitation: 'path namespace can change after validation' };
 const timing={cancelled:false,start_offset_ms:0,end_offset_ms:1,source_fingerprint_before_ms:0.1,source_fingerprint_after_ms:0.1,admission_ms:0.2,process_ms:0.8,probe_ms:null};
 const expectedSidecars={ffmpeg:{path:'/runtime/ffmpeg'},ffprobe:{path:'/runtime/ffprobe'}};
 const sidecars={ffmpeg:{canonical_path:'/runtime/ffmpeg',source_is_path:false},ffprobe:{canonical_path:'/runtime/ffprobe',source_is_path:false}};
  const complete = { schema_version: 1, mode: 'conversion_batch', success: true, aggregate_ms: 2, wall_ms: 3, encoder_detection_ms: 0.5, max_observed_concurrency: 2, ...evidence, sidecars, items: [{ id: 'one', success: true, elapsed_ms: 1, ...timing, request: {}, result: {}, output_path: '/suite/one.jpg', source_sha256: 'a'.repeat(64), output_bytes: 1, effective_execution: {} }, { id: 'two', success: true, elapsed_ms: 1, ...timing, request: {}, result: {}, output_path: '/suite/two.jpg', source_sha256: 'b'.repeat(64), output_bytes: 1, effective_execution: {} }] };
 const expected={one:{request:{},output_path:'/suite/one.jpg',source_sha256:'a'.repeat(64)},two:{request:{},output_path:'/suite/two.jpg',source_sha256:'b'.repeat(64)}};
 assert.equal(validateWorkloadMetrics(complete, request, { success: true }, expected, expectedSidecars), true);
 assert.equal(validateWorkloadMetrics({ ...complete, items: [...complete.items].reverse() }, request, { success: true }, expected, expectedSidecars), false);
 assert.equal(validateWorkloadMetrics({ ...complete, success: false, items: [{ id: 'one', success: true, elapsed_ms: 1 }, { id: 'two', success: false, elapsed_ms: 1 }] }, request, { success: false }, expected, expectedSidecars), false);
 assert.equal(validateWorkloadMetrics(complete, request, { success: false }, expected, expectedSidecars), false);
 assert.equal(validateWorkloadMetrics({ ...complete, unexpected: true }, request, { success: true }, expected, expectedSidecars), false);
 assert.equal(validateWorkloadMetrics({ ...complete, sidecars:{...sidecars,ffmpeg:{...sidecars.ffmpeg,source_is_path:true}} }, request, { success: true }, expected, expectedSidecars), false);
 assert.equal(validateWorkloadMetrics({ ...complete, items: [{ ...complete.items[0], output_path: '/suite/wrong.jpg' }, complete.items[1]] }, request, { success: true }, expected, expectedSidecars), false);
 assert.equal(validateWorkloadMetrics({ ...complete, items: [{ ...complete.items[0], source_sha256: 'f'.repeat(64) }, complete.items[1]] }, request, { success: true }, expected, expectedSidecars), false);
 const inspectionRequest = { mode: 'inspection_burst', sources: [{ id: 'one' }] };
 const inspectionTiming={...timing,admission_ms:null,process_ms:null,probe_ms:1};
 assert.equal(validateWorkloadMetrics({ schema_version: 1, mode: 'inspection_burst', success: true, aggregate_ms: 1, wall_ms: 2, encoder_detection_ms: 0.5, max_observed_concurrency: null, ...evidence, sidecars, items: [{ id: 'one', success: true, elapsed_ms: 1, ...inspectionTiming, input_path: '/fixtures/one.jpg', source_sha256: 'c'.repeat(64), inspection: {}, cache_reuse: 'not_exposed' }] }, inspectionRequest, { success: true }, {one:{input_path:'/fixtures/one.jpg',source_sha256:'c'.repeat(64)}}, expectedSidecars), true);
 assert.equal(validateWorkloadMetrics({ schema_version: 1, mode: 'inspection_burst', success: true, aggregate_ms: 1, max_observed_concurrency: null, ...evidence, items: [{ id: 'one', success: true, elapsed_ms: 1, inspection: {} }] }, inspectionRequest, { success: true }), false);
});

test('runtime sidecars require exact platform names and reject source artifacts and aliases', () => {
 const root = mkdtempSync(join(tmpdir(), 'goop-batch-probe-'));
 try {
  const sidecars = join(root, 'sidecars'); mkdirSync(sidecars);
  const sourceProbe = join(sidecars, 'ffprobe-aarch64-apple-darwin');
  const sourceFfmpeg = join(sidecars, 'ffmpeg-aarch64-apple-darwin');
  writeFileSync(sourceProbe, 'source'); writeFileSync(sourceFfmpeg, 'source');
  assert.throws(() => resolveRuntimeSidecars(sidecars, 'darwin'), /exact runtime sidecar.*ffmpeg/i);
  const ffmpeg = join(sidecars, 'ffmpeg');
  const probe = join(sidecars, 'ffprobe');
  writeFileSync(ffmpeg, '#!/bin/sh\nprintf "ffmpeg version test"\n'); chmodSync(ffmpeg, 0o700);
  writeFileSync(probe, '#!/bin/sh\nprintf \'{"streams":[{"codec_type":"video","codec_name":"mjpeg"}],"format":{"format_name":"image2"}}\'\n'); chmodSync(probe, 0o700);
  assert.throws(() => resolveRuntimeSidecars(sidecars, 'darwin'), /exactly one exact runtime sidecar/i);
  rmSync(sourceProbe); rmSync(sourceFfmpeg);
  const resolved = resolveRuntimeSidecars(sidecars, 'darwin');
  assert.deepEqual(Object.keys(resolved), ['ffmpeg', 'ffprobe']);
  assert.equal(resolved.ffmpeg, realpathSync(ffmpeg));
  assert.equal(resolved.ffprobe, realpathSync(probe));
  const linked = join(root, 'linked'); mkdirSync(linked);
  symlinkSync(ffmpeg, join(linked, 'ffmpeg')); symlinkSync(probe, join(linked, 'ffprobe'));
  assert.throws(() => resolveRuntimeSidecars(linked, 'darwin'), /non-symlink/i);
  const windows = join(root, 'windows'); mkdirSync(windows);
  writeFileSync(join(windows, 'ffmpeg.exe'), 'runtime'); writeFileSync(join(windows, 'ffprobe.exe'), 'runtime');
  assert.equal(resolveRuntimeSidecars(windows, 'win32').ffmpeg, realpathSync(join(windows, 'ffmpeg.exe')));
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test('driver sidecar reports must be complete, direct, and match preflight canonical paths', () => {
 const expected={ffmpeg:{path:'/runtime/ffmpeg'},ffprobe:{path:'/runtime/ffprobe'}};
 const valid={ffmpeg:{canonical_path:'/runtime/ffmpeg',source_is_path:false},ffprobe:{canonical_path:'/runtime/ffprobe',source_is_path:false}};
 assert.equal(validateDriverSidecars(valid,expected),null);
 assert.match(validateDriverSidecars({...valid,ffmpeg:{...valid.ffmpeg,source_is_path:true}},expected),/PATH fallback/i);
 assert.match(validateDriverSidecars({...valid,ffprobe:{...valid.ffprobe,canonical_path:'/usr/bin/ffprobe'}},expected),/canonical path/i);
 assert.match(validateDriverSidecars({ffmpeg:valid.ffmpeg},expected),/exactly ffmpeg and ffprobe/i);
 assert.match(validateDriverSidecars({...valid,extra:{}},expected),/exactly ffmpeg and ffprobe/i);
});

test('runtime-only PATH removes case-insensitive aliases and keeps the native Windows key', () => {
 const windows=runtimeSidecarEnvironment('C:\\Goop\\runtime',{PATH:'C:\\poison-one',Path:'C:\\poison-two',OTHER:'kept'},'win32');
 assert.deepEqual(Object.entries(windows).filter(([name])=>name.toLowerCase()==='path'),[['Path','C:\\Goop\\runtime']]);
 assert.equal(windows.OTHER,'kept');
 const unix=runtimeSidecarEnvironment('/goop/runtime',{PATH:'/poison',Path:'/also-poison',OTHER:'kept'},'darwin');
 assert.deepEqual(Object.entries(unix).filter(([name])=>name.toLowerCase()==='path'),[['PATH','/goop/runtime']]);
});

test('Windows canonical sidecar comparison accepts namespace and UNC forms without rewriting evidence', () => {
 const reported=JSON.parse('{"ffmpeg":{"canonical_path":"\\\\\\\\?\\\\C:\\\\Goop\\\\FFMPEG.EXE","source_is_path":false},"ffprobe":{"canonical_path":"\\\\\\\\?\\\\UNC\\\\Server\\\\Share\\\\ffprobe.exe","source_is_path":false}}');
 const raw=structuredClone(reported);
 const expected={ffmpeg:{path:'c:\\goop\\ffmpeg.exe'},ffprobe:{path:'\\\\server\\share\\ffprobe.exe'}};
 assert.equal(normalizeCanonicalPathForComparison(reported.ffmpeg.canonical_path,'win32'),'c:\\goop\\ffmpeg.exe');
 assert.equal(normalizeCanonicalPathForComparison(reported.ffprobe.canonical_path,'win32'),'\\\\server\\share\\ffprobe.exe');
 assert.equal(validateDriverSidecars(reported,expected,'win32'),null);
 assert.deepEqual(reported,raw);
});

test('batch outputs require matching bytes and an independent media probe', () => {
 const root = mkdtempSync(join(tmpdir(), 'goop-batch-probe-'));
 try {
  const sidecars = join(root, 'sidecars'); mkdirSync(sidecars);
  const probe = join(sidecars, 'ffprobe');
  writeFileSync(probe, '#!/bin/sh\nprintf \'{"streams":[{"codec_type":"video","codec_name":"mjpeg"}],"format":{"format_name":"image2"}}\'\n'); chmodSync(probe, 0o700);
  const output = join(root, 'one.jpg'); writeFileSync(output, 'media');
  const request = { mode: 'conversion_batch', items: [{ id: 'one', request: { output_path: output, target: 'jpeg' }, expected_output: { extension:'jpg', probe:'media', format_names:['image2'], required_streams:[{codec_type:'video',codec_name:'mjpeg'}] } }] };
  const metrics = { items: [{ id: 'one', output_bytes: 5 }] };
  assert.equal(verifyBatchOutputs(metrics, request, probe).success, true);
  assert.equal(verifyBatchOutputs({ items: [{ id: 'one', output_bytes: 4 }] }, request, probe).success, false);
  writeFileSync(probe, '#!/bin/sh\nprintf \'{"streams":[{"codec_type":"video","codec_name":"h264"}],"format":{"format_name":"matroska,webm"}}\'\n');
  assert.equal(verifyBatchOutputs(metrics, request, probe).success, false);
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test('conversion-batch adapter uses only exact runtime sidecars despite a poisoned parent PATH', async () => {
 const root=mkdtempSync(join(tmpdir(),'goop-batch-integration-'));
 const priorPath=process.env.PATH,priorMixedPath=process.env.Path;
 try {
  const input=join(root,'source.jpg');writeFileSync(input,'source');
  const driver=join(root,'driver');
  writeFileSync(driver,`#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');const request=JSON.parse(fs.readFileSync(process.argv[3]));
fs.writeFileSync(path.join(request.suite_dir,'driver-path.txt'),process.env.PATH??process.env.Path??'missing');
const sidecars=Object.fromEntries(['ffmpeg','ffprobe'].map(name=>[name,{canonical_path:fs.realpathSync(path.join(process.argv[2],name)),source_is_path:false}]));
if(process.env.GOOP_TEST_REMOVE_RUNTIME==='true')fs.rmSync(path.join(process.argv[2],'ffmpeg'));
const marker=path.join(request.suite_dir,'ffmpeg-marker.txt');const launched=cp.spawnSync('ffmpeg',['--identity-marker',marker]);
const items=request.items.map(item=>{fs.writeFileSync(item.request.output_path,'media');return {id:item.id,success:true,elapsed_ms:1,cancelled:false,start_offset_ms:0,end_offset_ms:1,source_fingerprint_before_ms:0.1,source_fingerprint_after_ms:0.1,admission_ms:0.2,process_ms:0.8,probe_ms:null,error:null,request:item.request,output_path:item.request.output_path,source_sha256:crypto.createHash('sha256').update(fs.readFileSync(item.request.input_path)).digest('hex'),result:{},output_bytes:5,effective_execution:{}}});
const success=launched.status===0;fs.writeFileSync(process.argv[4],JSON.stringify({schema_version:1,mode:'conversion_batch',success,aggregate_ms:1,wall_ms:2,encoder_detection_ms:0.1,max_observed_concurrency:1,items,error:success?null:'ffmpeg launch failed',memory_evidence:'external process tree required',path_safety_limitation:'path namespace can change after validation',sidecars}));
`);chmodSync(driver,0o700);
  const ffmpeg=join(root,'ffmpeg');writeFileSync(ffmpeg,'#!/bin/sh\nif [ "$1" = "--identity-marker" ]; then printf runtime > "$2"; else printf "ffmpeg version test"; fi\n');chmodSync(ffmpeg,0o700);
  const probe=join(root,'ffprobe');writeFileSync(probe,'#!/bin/sh\nprintf \'{"streams":[{"codec_type":"video","codec_name":"mjpeg"}],"format":{"format_name":"image2"}}\'\n');chmodSync(probe,0o700);
  const item={id:'one',fixture_role:'image',request:{target:'jpeg'},expected_output:{extension:'jpg',probe:'media',format_names:['image2'],required_streams:[{codec_type:'video',codec_name:'mjpeg'}]}};
  const inputSha=(await import('node:crypto')).createHash('sha256').update(readFileSync(input)).digest('hex');
  const runtimeSidecars=resolveRuntimeSidecars(root);
  const poison=join(root,'poison');mkdirSync(poison);writeFileSync(join(poison,'ffmpeg'),'#!/bin/sh\nprintf poison > "$2"\n');chmodSync(join(poison,'ffmpeg'),0o700);process.env.PATH=poison;process.env.Path=join(root,'other-poison');
  const result=await executeWorkloadAdapter({output_directory:join(root,'output'),bindings:{image:{path:input,sha256:inputSha}},limits:{timeout_ms:2000,log_limit_bytes:65536,storage_budget_bytes:1048576},workload:{adapter:'workload',mode:'conversion_batch',concurrency:1,items:[item]}},{workloadDriver:driver,runtimeSidecarsDirectory:root,runtimeSidecars,ffprobe:probe});
  assert.equal(result.success,true);
  assert.equal(result.verification.success,true);
  assert.equal(readFileSync(join(root,'output','driver-path.txt'),'utf8'),realpathSync(root));
  assert.equal(readFileSync(join(root,'output','ffmpeg-marker.txt'),'utf8'),'runtime');
  process.env.GOOP_TEST_REMOVE_RUNTIME='true';
  const fallbackResult=await executeWorkloadAdapter({output_directory:join(root,'late-output'),bindings:{image:{path:input,sha256:inputSha}},limits:{timeout_ms:2000,log_limit_bytes:65536,storage_budget_bytes:1048576},workload:{adapter:'workload',mode:'conversion_batch',concurrency:1,items:[item]}},{workloadDriver:driver,runtimeSidecarsDirectory:root,runtimeSidecars,ffprobe:probe});
  assert.equal(fallbackResult.success,false);
  assert.equal(existsSync(join(root,'late-output','ffmpeg-marker.txt')),false);
 } finally {delete process.env.GOOP_TEST_REMOVE_RUNTIME;if(priorPath===undefined)delete process.env.PATH;else process.env.PATH=priorPath;if(priorMixedPath===undefined)delete process.env.Path;else process.env.Path=priorMixedPath;rmSync(root,{recursive:true,force:true});}
});

test('prevalidated fixture bindings are still rechecked after every run', async () => {
 const root = mkdtempSync(join(tmpdir(), 'goop-suite-integrity-'));
 try {
  const raw = join(root, 'raw.bin'), inspect = join(root, 'inspect.bin');
  writeFileSync(raw, 'raw'); writeFileSync(inspect, 'inspect');
  const crypto = await import('node:crypto');
  const sha = path => crypto.createHash('sha256').update(readFileSync(path)).digest('hex');
  const manifest = validManifest();
  const bindings = validateBindings(manifest, { schema_version: 1, fixtures: {
   raw_48mp: { path: raw, sha256: sha(raw), bytes: 3 },
   inspect_mixed: { path: inspect, sha256: sha(inspect), bytes: 7 },
  } });
  let first = true;
  await assert.rejects(runPerformanceSuite({
   manifest,
   bindings,
   prevalidatedBindings: true,
   outputDirectory: join(root, 'output'),
   execute: async () => {
    if (first) { first = false; writeFileSync(raw, 'changed'); }
    return { success: true, process_ms: 1 };
   },
  }), /byte-size mismatch|sha-256 mismatch/i);
  const state = JSON.parse(readFileSync(join(root, 'output', 'suite-state.json'), 'utf8'));
  assert.equal(state.samples[0].status, 'failed');
  assert.match(state.samples[0].result.source_integrity_error, /mismatch/i);
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test('suite refuses an existing output and retains raw failures incrementally', async () => {
 const root = mkdtempSync(join(tmpdir(), 'goop-suite-'));
 try {
  const output = join(root, 'new-output');
  const raw = join(root, 'raw.bin'), inspect = join(root, 'inspect.bin');
  writeFileSync(raw, 'raw'); writeFileSync(inspect, 'inspect');
  const crypto = await import('node:crypto');
  const sha = path => crypto.createHash('sha256').update(readFileSync(path)).digest('hex');
  const bindings = validateBindings(validManifest(), { schema_version: 1, fixtures: {
   raw_48mp: { path: raw, sha256: sha(raw), bytes: 3 },
   inspect_mixed: { path: inspect, sha256: sha(inspect), bytes: 7 },
  } });
  const runs = [];
  await assert.rejects(runPerformanceSuite({
   manifest: validManifest(),
   bindings,
   outputDirectory: output,
   prevalidatedBindings: true,
   execute: async run => {
    runs.push(run.id);
    return { success: !run.id.endsWith('/2'), process_ms: 1, error: run.id.endsWith('/2') ? 'synthetic failure' : null };
   },
  }), /workload failed/i);
  const state = JSON.parse(readFileSync(join(output, 'suite-state.json'), 'utf8'));
  assert.equal(state.samples.length, 18);
  assert.equal(state.samples.filter(sample => sample.status === 'failed').length, 3);
  assert.equal(state.samples.filter(sample => sample.status === 'excluded').length, 3);
  assert.equal(runs.length, 18);
  assert.throws(() => mkdirSync(output), /EEXIST/);
  await assert.rejects(runPerformanceSuite({ manifest: validManifest(), bindings, outputDirectory: output, prevalidatedBindings: true, execute: async () => ({ success: true, process_ms: 1 }) }), /must be new/i);
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test('suite stops immediately after the total storage budget is exceeded', async () => {
 const root = mkdtempSync(join(tmpdir(), 'goop-suite-budget-'));
 try {
  const raw = join(root, 'raw.bin'), inspect = join(root, 'inspect.bin');
  writeFileSync(raw, 'raw'); writeFileSync(inspect, 'inspect');
  const crypto = await import('node:crypto');
  const sha = path => crypto.createHash('sha256').update(readFileSync(path)).digest('hex');
  const manifest = validManifest();
  const bindings = validateBindings(manifest, { schema_version: 1, fixtures: { raw_48mp: { path: raw, sha256: sha(raw), bytes: 3 }, inspect_mixed: { path: inspect, sha256: sha(inspect), bytes: 7 } } });
  let runs = 0;
  const output = join(root, 'output');
  await assert.rejects(runPerformanceSuite({ manifest, bindings, prevalidatedBindings: true, outputDirectory: output, execute: async run => {
   runs += 1;
   mkdirSync(run.output_directory, { recursive: true });
   writeFileSync(join(run.output_directory, 'oversized.bin'), Buffer.alloc(manifest.defaults.suite_storage_budget_bytes + 1));
   return { success: true, process_ms: 1 };
  } }), /storage budget/i);
  const state = JSON.parse(readFileSync(join(output, 'suite-state.json'), 'utf8'));
  assert.equal(runs, 1);
  assert.equal(state.samples.length, 1);
  assert.equal(state.samples[0].result.budget_exceeded, true);
  assert.ok(directoryBytes(output) <= manifest.defaults.suite_storage_budget_bytes);
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test('suite storage cleanup removes only the current over-budget run', async () => {
 const root=mkdtempSync(join(tmpdir(),'goop-suite-storage-retention-'));
 try {
  const raw=join(root,'raw.bin'),inspect=join(root,'inspect.bin');writeFileSync(raw,'raw');writeFileSync(inspect,'inspect');
  const crypto=await import('node:crypto');const sha=path=>crypto.createHash('sha256').update(readFileSync(path)).digest('hex');
  const manifest=validManifest();manifest.defaults.warmups=1;manifest.defaults.repetitions=1;manifest.defaults.suite_storage_budget_bytes=1300000;manifest.workloads=[manifest.workloads[0]];
  const bindings=validateBindings(manifest,{schema_version:1,fixtures:{raw_48mp:{path:raw,sha256:sha(raw),bytes:3},inspect_mixed:{path:inspect,sha256:sha(inspect),bytes:7}}});
  const undersized={...manifest,defaults:{...manifest.defaults,suite_storage_budget_bytes:1024}};const undersizedOutput=join(root,'undersized');
  await assert.rejects(runPerformanceSuite({manifest:undersized,bindings,prevalidatedBindings:true,outputDirectory:undersizedOutput,execute:async()=>({success:true,process_ms:1})}),/evidence ledger/i);assert.equal(existsSync(undersizedOutput),false);
  const output=join(root,'output');let runs=0;
  await assert.rejects(runPerformanceSuite({manifest,bindings,prevalidatedBindings:true,outputDirectory:output,execute:async run=>{runs+=1;mkdirSync(run.output_directory,{recursive:true});writeFileSync(join(run.output_directory,runs===1?'first.raw':'oversized.raw'),Buffer.alloc(runs===1?100:2*1024*1024));return {success:true,process_ms:1};}}),/storage budget/i);
  assert.equal(runs,2);assert.equal(existsSync(join(output,'raw-single','warmup-0','first.raw')),true);assert.equal(existsSync(join(output,'raw-single','0')),false);assert.ok(directoryBytes(output)<=manifest.defaults.suite_storage_budget_bytes);
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('paired storage cleanup preserves prior completed run evidence', async () => {
 const root=mkdtempSync(join(tmpdir(),'goop-paired-storage-retention-')),output=join(root,'output');
 try {
 let runs=0;const budget=1048576;
  const undersized=join(root,'undersized');await assert.rejects(collectPairedSamples({workloadIds:['copy'],repetitions:2,outputDirectory:undersized,totalLimits:{suite_timeout_ms:10000,suite_log_limit_bytes:1024,suite_storage_budget_bytes:1024},execute:async()=>({success:true,process_ms:1})}),/evidence ledger/i);assert.equal(existsSync(undersized),false);
  const state=await collectPairedSamples({workloadIds:['copy'],repetitions:2,outputDirectory:output,totalLimits:{suite_timeout_ms:10000,suite_log_limit_bytes:1048576,suite_storage_budget_bytes:budget},execute:async step=>{runs+=1;const sample=step.phase==='warmup'?`warmup-${step.revision}`:`${step.repetition}-${step.revision}`;const directory=join(output,'runs',step.workload_id,sample);mkdirSync(directory,{recursive:true});writeFileSync(join(directory,runs===1?'first.raw':'oversized.raw'),Buffer.alloc(runs===1?100:2*1024*1024));return {success:true,process_ms:1};}});
  assert.equal(state.status,'failed');assert.equal(runs,2);assert.equal(existsSync(join(output,'runs','copy','warmup-baseline','first.raw')),true);assert.equal(existsSync(join(output,'runs','copy','warmup-candidate')),false);assert.ok(directoryBytes(output)<=budget);
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('suite clamps every run to remaining storage and retained-log budgets', async () => {
 const root=mkdtempSync(join(tmpdir(),'goop-suite-allowances-'));
 try {
  const raw=join(root,'raw.bin'),inspect=join(root,'inspect.bin');writeFileSync(raw,'raw');writeFileSync(inspect,'inspect');
  const crypto=await import('node:crypto');const sha=path=>crypto.createHash('sha256').update(readFileSync(path)).digest('hex');
  const manifest=validManifest();manifest.defaults.warmups=1;manifest.defaults.repetitions=1;manifest.defaults.log_limit_bytes=1500;manifest.defaults.suite_log_limit_bytes=2000;manifest.defaults.suite_storage_budget_bytes=1400000;manifest.workloads=[manifest.workloads[0]];
  const bindings=validateBindings(manifest,{schema_version:1,fixtures:{raw_48mp:{path:raw,sha256:sha(raw),bytes:3},inspect_mixed:{path:inspect,sha256:sha(inspect),bytes:7}}});
  const seen=[];const output=join(root,'output');
  const state=await runPerformanceSuite({manifest,bindings,prevalidatedBindings:true,outputDirectory:output,execute:async run=>{seen.push({...run.limits});mkdirSync(run.output_directory,{recursive:true});writeFileSync(join(run.output_directory,'payload'),Buffer.alloc(1024));return {success:true,process_ms:1,process:{log_bytes_retained:run.limits.log_limit_bytes}};}});
  assert.equal(state.status,'complete');
  assert.deepEqual(seen.map(value=>value.log_limit_bytes),[1500,500]);
  assert.equal(seen.every(value=>value.storage_budget_bytes>0&&value.storage_budget_bytes<manifest.defaults.storage_budget_bytes),true);
  assert.ok(directoryBytes(output)<=manifest.defaults.suite_storage_budget_bytes);
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('suite stops immediately after the total time budget is exceeded', async () => {
 const root = mkdtempSync(join(tmpdir(), 'goop-suite-time-'));
 try {
  const raw=join(root,'raw.bin'),inspect=join(root,'inspect.bin');writeFileSync(raw,'raw');writeFileSync(inspect,'inspect');
  const crypto=await import('node:crypto');const sha=path=>crypto.createHash('sha256').update(readFileSync(path)).digest('hex');
  const manifest=validManifest();manifest.defaults.suite_timeout_ms=15;
  const bindings=validateBindings(manifest,{schema_version:1,fixtures:{raw_48mp:{path:raw,sha256:sha(raw),bytes:3},inspect_mixed:{path:inspect,sha256:sha(inspect),bytes:7}}});
  let runs=0;const output=join(root,'output');
  await assert.rejects(runPerformanceSuite({manifest,bindings,prevalidatedBindings:true,outputDirectory:output,execute:async()=>{runs+=1;await new Promise(resolve=>setTimeout(resolve,25));return {success:true,process_ms:1};}}),/time budget/i);
  const state=JSON.parse(readFileSync(join(output,'suite-state.json'),'utf8'));assert.equal(runs,1);assert.equal(state.samples.length,1);assert.equal(state.samples[0].result.time_budget_exceeded,true);
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('suite stops immediately after the total retained-log budget is exceeded', async () => {
 const root=mkdtempSync(join(tmpdir(),'goop-suite-logs-'));
 try {
  const raw=join(root,'raw.bin'),inspect=join(root,'inspect.bin');writeFileSync(raw,'raw');writeFileSync(inspect,'inspect');
  const crypto=await import('node:crypto');const sha=path=>crypto.createHash('sha256').update(readFileSync(path)).digest('hex');
  const manifest=validManifest();manifest.defaults.suite_log_limit_bytes=1024;
  const bindings=validateBindings(manifest,{schema_version:1,fixtures:{raw_48mp:{path:raw,sha256:sha(raw),bytes:3},inspect_mixed:{path:inspect,sha256:sha(inspect),bytes:7}}});
  let runs=0;const output=join(root,'output');
  await assert.rejects(runPerformanceSuite({manifest,bindings,prevalidatedBindings:true,outputDirectory:output,execute:async()=>{runs+=1;return {success:true,process_ms:1,process:{log_bytes_retained:1025}};}}),/log budget/i);
  const state=JSON.parse(readFileSync(join(output,'suite-state.json'),'utf8'));assert.equal(runs,1);assert.equal(state.samples[0].result.log_budget_exceeded,true);
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('suite stops once a sample reports its output pipes held after the reap', async () => {
 // The workload adapter nests the bounded runner's result under `process`, the
 // single-conversion and startup harnesses report it at the top, and an
 // oversized result or a budget override rebuilds what the ledger keeps. The
 // budget cases stop on their own; they pin that the ledger keeps the held pipes
 // and that the suite names them as the cause.
 const held='The output pipes were still held one kill grace after the reap, most likely by a process outside the owned group';
 for(const [shape,heldResult,rebuiltBy] of [
  ['nested',{success:true,process_ms:1,process:{stdio_error:held}},null],
  ['top-level',{success:true,process_ms:1,stdio_error:held},null],
  ['oversized',{success:true,process_ms:1,padding:'x'.repeat(300000),process:{stdio_error:held}},'evidence_compacted'],
  ['past the evidence budget',{success:true,process_ms:1,padding:'x'.repeat(2*1024*1024),process:{stdio_error:held}},'budget_exceeded'],
  ['past the log budget',{success:true,process_ms:1,process:{stdio_error:held,log_bytes_retained:2*1048576}},'log_budget_exceeded'],
 ]){
  const root=mkdtempSync(join(tmpdir(),'goop-suite-held-'));
  try {
   const raw=join(root,'raw.bin'),inspect=join(root,'inspect.bin');writeFileSync(raw,'raw');writeFileSync(inspect,'inspect');
   const crypto=await import('node:crypto');const sha=path=>crypto.createHash('sha256').update(readFileSync(path)).digest('hex');
   const manifest=validManifest();manifest.defaults.repetitions=1;manifest.workloads=manifest.workloads.slice(0,2);
   const bindings=validateBindings(manifest,{schema_version:1,fixtures:{raw_48mp:{path:raw,sha256:sha(raw),bytes:3},inspect_mixed:{path:inspect,sha256:sha(inspect),bytes:7}}});
   const visited=[],output=join(root,'output');
   await assert.rejects(runPerformanceSuite({manifest,bindings,prevalidatedBindings:true,outputDirectory:output,execute:async run=>{visited.push(run.id);return visited.length===2?heldResult:{success:true,process_ms:1,process:{stdio_error:null}};}}),/output pipes/i,shape);
   assert.deepEqual(visited,['raw-single/warmup-0','raw-single/0'],shape);
   const state=JSON.parse(readFileSync(join(output,'suite-state.json'),'utf8'));
   assert.equal(state.status,'failed',shape);assert.deepEqual(state.samples.map(sample=>sample.status),['excluded','failed'],shape);
   assert.equal(state.samples[1].result.success,false,shape);assert.equal(state.samples[1].result.stdio_error,held,shape);
   if(rebuiltBy)assert.equal(state.samples[1].result[rebuiltBy],true,shape);
  } finally {rmSync(root,{recursive:true,force:true});}
 }
});

// A directory where the adapter writes the run's stdout log makes that write
// fail, and null metrics are no object; both come after the runner has already
// reported the held pipes.
for(const [label,leftover,metrics] of [['','','{}'],[' and blocks its log',"fs.mkdirSync(require('node:path').join(require('node:path').dirname(process.argv[3]),'stdout.log'));",'{}'],[' and reports null metrics','','null']]){
 test(`a suite launches nothing after a sample whose output pipes a process outside the owned group still holds${label}`,{skip:process.platform==='win32',timeout:60000},async t=>{
  const root=mkdtempSync(join(tmpdir(),'goop-suite-held-run-')),armed=join(root,'holder.pid'),launches=join(root,'launches'),driver=join(root,'driver'),sidecars=join(root,'sidecars'),output=join(root,'output');
  // The holder outlives the suite, so only this ends it, on a timeout too.
  t.after(()=>{const pid=armedPid(armed);if(pid)try{process.kill(pid,'SIGKILL');}catch{/* Already gone. */}rmSync(root,{recursive:true,force:true});});
  // Only the first launch leaves a holder, so a suite that kept going would launch every later sample.
  writeFileSync(driver,`#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(launches)},'launch\\n');require('node:fs').writeFileSync(process.argv[4],${JSON.stringify(metrics)});if(!require('node:fs').existsSync(${JSON.stringify(armed)})){${escapedHolder(armed,leftover)}}`);chmodSync(driver,0o700);mkdirSync(sidecars);
  const raw=join(root,'raw.bin'),inspect=join(root,'inspect.bin');writeFileSync(raw,'raw');writeFileSync(inspect,'inspect');
  const crypto=await import('node:crypto');const sha=path=>crypto.createHash('sha256').update(readFileSync(path)).digest('hex');
  const manifest=validManifest();manifest.defaults.timeout_ms=20000;manifest.defaults.repetitions=2;manifest.workloads=[manifest.workloads[1]];
  const bindings=validateBindings(manifest,{schema_version:1,fixtures:{raw_48mp:{path:raw,sha256:sha(raw),bytes:3},inspect_mixed:{path:inspect,sha256:sha(inspect),bytes:7}}});
  await assert.rejects(runPerformanceSuite({manifest,bindings,prevalidatedBindings:true,outputDirectory:output,execute:run=>executeWorkloadAdapter(run,{workloadDriver:driver,runtimeSidecarsDirectory:sidecars,runtimeSidecars:{}})}),/output pipes/i);
  assert.ok(armedPid(armed),'the holder never armed');
  assert.equal(readFileSync(launches,'utf8'),'launch\n');
  const state=JSON.parse(readFileSync(join(output,'suite-state.json'),'utf8'));
  assert.equal(state.status,'failed');assert.deepEqual(state.samples.map(sample=>sample.status),['failed']);assert.match(state.samples[0].result.stdio_error??'',/output pipes/i);
 });
}

// Root reads an unreadable directory, so its scan would not fail.
test('bounded process returns its held-pipe evidence when the run leaves an entry its symlink scan cannot read',{skip:process.platform==='win32'||process.getuid?.()===0,timeout:60000},async t=>{
 const root=mkdtempSync(join(tmpdir(),'goop-process-held-scan-')),armed=join(root,'holder.pid'),output=join(root,'output'),runner=join(root,'runner.cjs'),blocked=join(output,'blocked');
 // The holder outlives the run, so only this ends it, on a timeout too.
 t.after(()=>{const pid=armedPid(armed);if(pid)try{process.kill(pid,'SIGKILL');}catch{/* Already gone. */}try{chmodSync(blocked,0o700);}catch{/* Never made. */}rmSync(root,{recursive:true,force:true});});
 mkdirSync(output);
 // An unreadable directory stands in for an entry the live holder removes
 // between the scan's listing and its stat.
 writeFileSync(runner,escapedHolder(armed,`fs.mkdirSync(${JSON.stringify(blocked)},{mode:0});`));
 const result=await runBoundedProcess({command:process.execPath,args:[runner],outputDirectory:output,timeoutMs:20000,killGraceMs:200,logLimitBytes:4096,storageBudgetBytes:1048576});
 assert.ok(armedPid(armed),'the holder never armed');
 assert.match(result.stdio_error??'',/output pipes/i);assert.match(result.output_error??'',/could not be checked for symbolic links/);assert.equal(result.success,false);
});

// A scan that fails part-way must still remove the links it reached, and one
// that cannot list the run directory at all leaves the log writes and the
// metrics read to refuse a link rather than follow it out of the run directory.
// Links come first: once the tree is unreadable, the live storage check can stop the group.
for(const [label,links,lock,check] of [
 ['fails part-way',['stdout.log','stderr.log','metrics.json'],"fs.mkdirSync(path.join(dir,'aaa-blocked'),{mode:0});",(result,output)=>{assert.equal(lstatSync(join(output,'stdout.log')).isFile(),true);assert.equal(lstatSync(join(output,'stderr.log')).isFile(),true);assert.equal(existsSync(join(output,'metrics.json')),false);}],
 ['cannot list the run directory, logs linked',['stdout.log','stderr.log'],'fs.chmodSync(dir,0o300);',result=>assert.match(result.evidence_error??'',/stdout\.log/)],
 ['cannot list the run directory, metrics linked',['metrics.json'],'fs.chmodSync(dir,0o300);',result=>assert.match(result.error??'',/Invalid workload metrics/)],
]){
 // Root reads an unreadable directory, so its scan would not fail.
 test(`a workload sample whose symlink scan ${label} never follows a link its driver left`,{skip:process.platform==='win32'||process.getuid?.()===0,timeout:60000},async t=>{
  const root=mkdtempSync(join(tmpdir(),'goop-workload-scan-link-')),output=join(root,'output'),outside=join(root,'outside.json'),driver=join(root,'driver'),sidecars=join(root,'sidecars');
  t.after(()=>{for(const path of [output,join(output,'aaa-blocked')])try{chmodSync(path,0o700);}catch{/* Never made. */}rmSync(root,{recursive:true,force:true});});
  writeFileSync(outside,'{"leaked":true}');mkdirSync(sidecars);
  writeFileSync(driver,`#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path'),dir=path.dirname(process.argv[3]);for(const name of ${JSON.stringify(links)})fs.symlinkSync(${JSON.stringify(outside)},path.join(dir,name));${lock}`);chmodSync(driver,0o700);
  const result=await executeWorkloadAdapter({output_directory:output,bindings:{inspect_mixed:{path:outside,sha256:'0'.repeat(64)}},limits:{timeout_ms:20000,log_limit_bytes:65536,storage_budget_bytes:1048576},workload:{adapter:'workload',mode:'inspection_burst',fixture_roles:['inspect_mixed'],source_count:1}},{workloadDriver:driver,runtimeSidecarsDirectory:sidecars,runtimeSidecars:{}});
  chmodSync(output,0o700);
  assert.equal(readFileSync(outside,'utf8'),'{"leaked":true}');assert.equal(result.leaked,undefined);
  assert.match(result.output_error??result.process?.output_error??'',/could not be checked for symbolic links/);assert.equal(result.success,false);
  check(result,output);
 });
}

test('normal suite refuses an existing output without writing into it', async () => {
 const root = mkdtempSync(join(tmpdir(), 'goop-normal-existing-'));
 try {
  const manifestPath = join(root, 'manifest.json'), bindingsPath = join(root, 'bindings.json');
  const raw = join(root, 'raw.bin'), inspect = join(root, 'inspect.bin');
  writeFileSync(raw, 'raw'); writeFileSync(inspect, 'inspect');
  const crypto = await import('node:crypto');
  const sha = path => crypto.createHash('sha256').update(readFileSync(path)).digest('hex');
  writeFileSync(manifestPath, JSON.stringify(validManifest()));
  writeFileSync(bindingsPath, JSON.stringify({ schema_version: 1, fixtures: { raw_48mp: { path: raw, sha256: sha(raw), bytes: 3 }, inspect_mixed: { path: inspect, sha256: sha(inspect), bytes: 7 } } }));
  const driver = join(root, 'driver'), startup = join(root, 'startup');
  writeFileSync(driver, '#!/bin/sh\nexit 0\n'); chmodSync(driver, 0o700);
  writeFileSync(startup, '#!/bin/sh\nexit 0\n'); chmodSync(startup, 0o700);
  const ffmpeg = join(root, 'ffmpeg'); writeFileSync(ffmpeg, '#!/bin/sh\nprintf "ffmpeg version test"\n'); chmodSync(ffmpeg, 0o700);
  const probe = join(root, 'ffprobe'); writeFileSync(probe, '#!/bin/sh\nprintf "ffprobe version test"\n'); chmodSync(probe, 0o700);
  const startupConfig = join(root, 'startup.json'); writeFileSync(startupConfig, '{}');
  const output = join(root, 'existing'); mkdirSync(output);
  const sentinel = join(output, 'integrity.json'); writeFileSync(sentinel, 'sentinel');
  const stateSentinel = join(output, 'suite-state.json'); writeFileSync(stateSentinel, 'planted-state');
  await assert.rejects(normalSuite({ manifest: manifestPath, bindings: bindingsPath, output, 'single-driver': driver, 'workload-driver': driver, 'runtime-sidecars': root, 'startup-binary': startup, 'startup-config': startupConfig, 'build-command': 'test build', 'hardware-enabled': 'false' }), /must be new/i);
  assert.equal(readFileSync(sentinel, 'utf8'), 'sentinel');
  assert.equal(readFileSync(stateSentinel, 'utf8'), 'planted-state');
  const appDirectory=join(root,'app');mkdirSync(appDirectory);const detachedStartup=join(appDirectory,'startup');writeFileSync(detachedStartup,'#!/bin/sh\nexit 0\n');chmodSync(detachedStartup,0o700);
  await assert.rejects(normalSuite({ manifest: manifestPath, bindings: bindingsPath, output:join(root,'new-output'), 'single-driver': driver, 'workload-driver': driver, 'runtime-sidecars': root, 'startup-binary': detachedStartup, 'startup-config': startupConfig, 'build-command': 'test build', 'hardware-enabled': 'false' }), /exact runtime sidecar/i);
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test('normal suite records a failed state when runtime sidecar bytes change', async () => {
 const root=mkdtempSync(join(tmpdir(),'goop-normal-post-'));const prior=process.env.GOOP_TEST_RUNTIME_FFMPEG;
 try {
  const fixture=join(root,'source.jpg');writeFileSync(fixture,'source');
  const manifest=validManifest();manifest.defaults.repetitions=1;manifest.workloads=[manifest.workloads[0]];
  const manifestPath=join(root,'manifest.json'),bindingsPath=join(root,'bindings.json'),startupConfig=join(root,'startup.json');
  const crypto=await import('node:crypto');const sha=path=>crypto.createHash('sha256').update(readFileSync(path)).digest('hex');
  writeFileSync(manifestPath,JSON.stringify(manifest));writeFileSync(bindingsPath,JSON.stringify({schema_version:1,fixtures:{raw_48mp:{path:fixture,sha256:sha(fixture),bytes:6},inspect_mixed:{path:fixture,sha256:sha(fixture),bytes:6}}}));writeFileSync(startupConfig,'{}');
  const driver=join(root,'driver');writeFileSync(driver,`#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');const request=JSON.parse(fs.readFileSync(process.argv[3]));fs.writeFileSync(request.output_path,'media');const sidecars=Object.fromEntries(['ffmpeg','ffprobe'].map(name=>[name,{canonical_path:fs.realpathSync(path.join(process.argv[2],name)),source_is_path:false}]));fs.writeFileSync(process.argv[4],JSON.stringify({success:true,process_ms:1,result:{bytes:5},sidecars}));fs.appendFileSync(process.env.GOOP_TEST_RUNTIME_FFMPEG,'\\n# mutated');
`);chmodSync(driver,0o700);
  const ffmpeg=join(root,'ffmpeg');writeFileSync(ffmpeg,'#!/bin/sh\nprintf "ffmpeg version test"\n');chmodSync(ffmpeg,0o700);const probe=join(root,'ffprobe');writeFileSync(probe,'#!/bin/sh\nif [ "$1" = "-version" ]; then printf "ffprobe version test"; else printf \'{"streams":[{"codec_type":"video","codec_name":"mjpeg"}],"format":{"format_name":"image2"}}\'; fi\n');chmodSync(probe,0o700);
  const startup=join(root,'startup');writeFileSync(startup,'#!/bin/sh\nexit 0\n');chmodSync(startup,0o700);process.env.GOOP_TEST_RUNTIME_FFMPEG=ffmpeg;
  const output=join(root,'output');
  await assert.rejects(normalSuite({manifest:manifestPath,bindings:bindingsPath,output,'single-driver':driver,'workload-driver':driver,'runtime-sidecars':root,'startup-binary':startup,'startup-config':startupConfig,'build-command':'test build','hardware-enabled':'false'}),/identity changed/i);
  const state=JSON.parse(readFileSync(join(output,'suite-state.json'),'utf8'));const integrity=JSON.parse(readFileSync(join(output,'integrity.json'),'utf8'));
  assert.equal(state.status,'failed');assert.equal(integrity.success,false);assert.notEqual(integrity.post,null);assert.notEqual(integrity.pre.sidecars.ffmpeg.sha256,integrity.post.sidecars.ffmpeg.sha256);
 } finally {if(prior===undefined)delete process.env.GOOP_TEST_RUNTIME_FFMPEG;else process.env.GOOP_TEST_RUNTIME_FFMPEG=prior;rmSync(root,{recursive:true,force:true});}
});
