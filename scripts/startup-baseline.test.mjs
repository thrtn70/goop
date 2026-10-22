import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStartup, summarizeStartup } from './startup-baseline.mjs';
import { runtimeSidecarEnvironment } from './performance-shared.mjs';

async function fake(code, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'goop-startup-test-'));
  try {
    const file = join(root, 'runner.cjs');
    writeFileSync(file, code);
    return await runStartup({ binary: process.execPath, args: [file], directory: join(root, 'run'), settings: {}, readinessTimeoutMs: 1500, idleMs: 30, killGraceMs: 30, ...options });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
test('timeout kills a TERM-resistant child before returning', async () => {
  const result = await fake("process.on('SIGTERM',()=>{});setInterval(()=>{},10)");
  assert.equal(result.success, false);
  assert.equal(result.timed_out, true);
  assert.equal(result.exit_signal, 'SIGKILL');
  assert.throws(() => process.kill(result.pid, 0), { code: 'ESRCH' });
});
test('abort kills a TERM-resistant startup process before returning', async () => {
  const controller=new AbortController();setTimeout(()=>controller.abort(),100);
  const result=await fake("process.on('SIGTERM',()=>{});setInterval(()=>{},10)",{readinessTimeoutMs:5000,abortSignal:controller.signal});
  assert.equal(result.success,false);assert.equal(result.aborted,true);assert.equal(result.timed_out,false);
  assert.throws(()=>process.kill(result.pid,0),{code:'ESRCH'});
});
import { readFileSync } from 'node:fs';
const readyApp = "fs.writeFileSync(process.env.GOOP_STARTUP_REPORT,JSON.stringify({schema_version:1,backend_ready_ms:1,pid:process.pid}));setInterval(()=>{},10);";
for (const [label, after, abort] of [['root exited', '', false], ['ready', readyApp, false], ['aborted', "process.on('SIGTERM',()=>{});setInterval(()=>{},10);", true]]) {
  test(`startup stops waiting for output pipes held outside the owned group (${label})`, () => {
    const root = mkdtempSync(join(tmpdir(), 'goop-startup-held-')), armed = join(root, 'holder.pid');
    // The holder leaves the owned group (detached is setsid) and keeps stdout and
    // stderr open. It writes one marker before it publishes its pid, never writes
    // again, and outlives the guard, so only the finally below ends it.
    const holder = `const fs=require('node:fs');fs.writeSync(1,'escaped-marker\\n');fs.writeFileSync(${JSON.stringify(`${armed}.tmp`)},String(process.pid));fs.renameSync(${JSON.stringify(`${armed}.tmp`)},${JSON.stringify(armed)});setTimeout(()=>{},120000)`;
    const app = `const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(holder)}],{detached:true,stdio:['ignore','inherit','inherit']}).unref();const t=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(armed)}))return;clearInterval(t);${after}},5);`;
    try {
      writeFileSync(join(root, 'app.cjs'), app);
      // Waiting for the holder's EOF would hang, so the run happens in a
      // subprocess whose timeout turns that into a failure. The holder's state is
      // read the moment runStartup resolves.
      const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `import {runStartup} from ${JSON.stringify(new URL('./startup-baseline.mjs', import.meta.url).href)};import fs from 'node:fs';import {join} from 'node:path';import {execFileSync} from 'node:child_process';
const [root,armed,abort]=process.argv.slice(1),controller=new AbortController();
if(abort==='abort'){const t=setInterval(()=>{if(fs.existsSync(armed)){clearInterval(t);controller.abort();}},5);}
const result=await runStartup({binary:process.execPath,args:[join(root,'app.cjs')],directory:join(root,'run'),settings:{},readinessTimeoutMs:30000,idleMs:30,killGraceMs:200,abortSignal:controller.signal});
let state='';try{state=execFileSync('/bin/ps',['-o','stat=','-p',fs.readFileSync(armed,'utf8')],{encoding:'utf8'}).trim();}catch{/* Gone. */}
process.stdout.write(JSON.stringify({success:result.success,stdio_error:result.stdio_error,exit_code:result.exit_code,timed_out:result.timed_out,aborted:result.aborted,ready:result.marker!==null&&result.idle_tree_rss_KiB!==null,log:fs.readFileSync(join(root,'run','stdout.log'),'utf8'),holder_state:state}));`, root, armed, abort ? 'abort' : 'exit'], { encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' }));
      // The holder is still alive, so runStartup resolved without its EOF.
      assert.ok(result.holder_state !== '' && !/[ZE]/.test(result.holder_state), `holder state '${result.holder_state}'`);
      assert.equal(result.success, false);
      assert.match(result.stdio_error ?? '', /output pipes/i);
      assert.match(result.log, /escaped-marker/);
      if (abort) assert.equal(result.aborted, true);
      else assert.equal(result.timed_out, false);
      // A ready app's sample fails only because of the held pipes.
      if (label === 'ready') assert.equal(result.ready, true);
      if (label === 'root exited') assert.equal(result.exit_code, 0);
    } finally {
      try { process.kill(Number(readFileSync(armed, 'utf8')), 'SIGKILL'); } catch { /* Never armed or already gone. */ }
      rmSync(root, { recursive: true, force: true });
    }
  });
}
test('clean startup records no held pipes', async () => {
  const result = await fake("require('node:fs').writeFileSync(process.env.GOOP_STARTUP_REPORT,JSON.stringify({schema_version:1,backend_ready_ms:1,pid:process.pid}));setInterval(()=>{},10)");
  assert.equal(result.success, true);
  assert.equal(result.stdio_error, null);
});
test('a startup binary that cannot launch returns without waiting for readiness', { timeout: 20000 }, async () => {
  // A failed spawn emits error and close but never exit.
  const root = mkdtempSync(join(tmpdir(), 'goop-startup-missing-'));
  try {
    const result = await runStartup({ binary: join(root, 'missing'), directory: join(root, 'run'), settings: {}, readinessTimeoutMs: 30000, idleMs: 30, killGraceMs: 30 });
    assert.equal(result.success, false);
    assert.match(result.spawn_error, /ENOENT/);
    assert.equal(result.timed_out, false);
    assert.equal(result.stdio_error, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('invalid and failed readiness excluded from medians', async () => {
  const result = await fake("require('node:fs').writeFileSync(process.env.GOOP_STARTUP_REPORT,JSON.stringify({schema_version:1,backend_ready_ms:-1,pid:process.pid}));setInterval(()=>{},10)");
  assert.equal(result.success, false);
  assert.equal(summarizeStartup([result]).launch_to_ready_ms.median_ms, null);
});
test('valid marker must belong to the launched PID', async () => {
  const result = await fake("require('node:fs').writeFileSync(process.env.GOOP_STARTUP_REPORT,JSON.stringify({schema_version:1,backend_ready_ms:1,pid:1}));setInterval(()=>{},10)");
  assert.equal(result.success, false);
});
test('records marker and idle RSS then waits for child exit', async () => {
  const result = await fake("require('node:fs').writeFileSync(process.env.GOOP_STARTUP_REPORT,JSON.stringify({schema_version:1,backend_ready_ms:1,pid:process.pid}));setInterval(()=>{},10)");
  assert.equal(result.success, true);
  assert.ok(result.launch_to_ready_ms >= 0);
  assert.ok(result.idle_tree_rss_KiB > 0);
  assert.throws(() => process.kill(result.pid, 0), { code: 'ESRCH' });
});
test('timeout also reaps a TERM-resistant descendant after its parent exits', { timeout: 5000 }, async () => {
  const start = performance.now();
  const result = await fake("require('node:child_process').spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},10)\"],{stdio:'inherit'});setInterval(()=>{},10)");
  assert.equal(result.success, false);
  assert.equal(result.timed_out, true);
  assert.ok(performance.now() - start < 3000);
});
import { seedQueue } from './startup-baseline.mjs';
import { execFileSync } from 'node:child_process';
test('empty and populated fixtures have identical schema and no runnable rows', () => {
  const root = mkdtempSync(join(tmpdir(), 'goop-startup-db-'));
  try {
    const schemas = [];
    for (const count of [0, 200, 1000]) {
      const path = join(root, `${count}.db`);
      seedQueue(path, count);
      schemas.push(execFileSync('/usr/bin/sqlite3', [path, '.schema'], { encoding: 'utf8' }));
      assert.equal(execFileSync('/usr/bin/sqlite3', [path, 'SELECT COUNT(*) FROM jobs'], { encoding: 'utf8' }).trim(), String(count));
      assert.equal(execFileSync('/usr/bin/sqlite3', [path, "SELECT COUNT(*) FROM jobs WHERE state != 'done' OR kind != 'convert'"], { encoding: 'utf8' }).trim(), '0');
    }
    assert.equal(schemas[0], schemas[1]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('launch settings remain valid with update and notification switches disabled', async () => {
  const result = await fake("const fs=require('node:fs'),path=require('node:path');const s=JSON.parse(fs.readFileSync(path.join(process.env.GOOP_CONFIG_DIR,'settings.json')));if(s.auto_check_updates!==false||s.yt_dlp_auto_update!==false||s.notifications_enabled!==false||s.theme!=='dark'||s.extract_concurrency!==2||s.convert_concurrency!==1)process.exit(2);fs.writeFileSync(process.env.GOOP_STARTUP_REPORT,JSON.stringify({schema_version:1,backend_ready_ms:1,pid:process.pid}));setInterval(()=>{},10)", { settings: { auto_check_updates: true, yt_dlp_auto_update: true, notifications_enabled: true, history_view_mode: 'invalid' } });
  assert.equal(result.success, true);
});
test('startup app receives only the canonical runtime sidecar PATH despite poisoned aliases', async () => {
  const root=mkdtempSync(join(tmpdir(),'goop-startup-sidecars-'));
  try {
    const runtime=join(root,'runtime'),poison=join(root,'poison');mkdirSync(runtime);mkdirSync(poison);
    writeFileSync(join(runtime,'ffmpeg'),'#!/bin/sh\nprintf runtime > "$1"\n');chmodSync(join(runtime,'ffmpeg'),0o700);
    writeFileSync(join(poison,'ffmpeg'),'#!/bin/sh\nprintf poison > "$1"\n');chmodSync(join(poison,'ffmpeg'),0o700);
    const environment=runtimeSidecarEnvironment(runtime,{...process.env,PATH:poison,Path:join(root,'other-poison')});
    const code="const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');const marker=path.join(process.env.GOOP_DATA_DIR,'ffmpeg-marker');const launched=cp.spawnSync('ffmpeg',[marker]);fs.writeFileSync(process.env.GOOP_STARTUP_REPORT,JSON.stringify({schema_version:1,backend_ready_ms:1,pid:process.pid,path_entries:Object.entries(process.env).filter(([name])=>name.toLowerCase()==='path'),ffmpeg_marker:launched.status===0?fs.readFileSync(marker,'utf8'):'failed'}));setInterval(()=>{},10)";
    const result=await fake(code,{environment});
    assert.equal(result.success,true);
    assert.deepEqual(result.marker.path_entries,[['PATH',realpathSync(runtime)]]);
    assert.equal(result.marker.ffmpeg_marker,'runtime');
  } finally {rmSync(root,{recursive:true,force:true});}
});
test('startup app cannot rescue a late removed runtime sidecar from poisoned PATH', async () => {
  const root=mkdtempSync(join(tmpdir(),'goop-startup-sidecar-race-'));
  try {
    const runtime=join(root,'runtime'),poison=join(root,'poison');mkdirSync(runtime);mkdirSync(poison);
    const runtimeFfmpeg=join(runtime,'ffmpeg');writeFileSync(runtimeFfmpeg,'#!/bin/sh\nexit 0\n');chmodSync(runtimeFfmpeg,0o700);
    writeFileSync(join(poison,'ffmpeg'),'#!/bin/sh\nexit 0\n');chmodSync(join(poison,'ffmpeg'),0o700);
    const environment=runtimeSidecarEnvironment(runtime,{...process.env,PATH:poison,GOOP_TEST_RUNTIME_FFMPEG:runtimeFfmpeg});
    const code="const fs=require('node:fs'),cp=require('node:child_process');fs.rmSync(process.env.GOOP_TEST_RUNTIME_FFMPEG);const launched=cp.spawnSync('ffmpeg');fs.writeFileSync(process.env.GOOP_STARTUP_REPORT,JSON.stringify({schema_version:1,backend_ready_ms:1,pid:process.pid,fallback_rescued:launched.status===0}));setInterval(()=>{},10)";
    const result=await fake(code,{environment});
    assert.equal(result.success,true);
    assert.equal(result.marker.fallback_rescued,false);
  } finally {rmSync(root,{recursive:true,force:true});}
});
test('a ready marker cannot turn an absent process into a successful idle sample', async () => {
  const result = await fake("require('node:fs').writeFileSync(process.env.GOOP_STARTUP_REPORT,JSON.stringify({schema_version:1,backend_ready_ms:1,pid:process.pid}));setInterval(()=>{},10)", { readSnapshot: () => '1 0 123 init\n' });
  assert.ok(result.marker);
  assert.equal(result.success, false);
  assert.equal(result.idle_tree_rss_KiB, null);
  assert.equal(result.sampled_tree_peak_KiB, null);
});
test('startup rejects and removes child-created symlink output', async () => {
  const result=await fake("const fs=require('node:fs'),path=require('node:path');fs.symlinkSync(path.join(process.env.GOOP_CONFIG_DIR,'settings.json'),path.join(process.env.GOOP_DATA_DIR,'link'));fs.writeFileSync(process.env.GOOP_STARTUP_REPORT,JSON.stringify({schema_version:1,backend_ready_ms:1,pid:process.pid}));setInterval(()=>{},10)");
  assert.equal(result.success,false);assert.match(result.output_error,/symbolic-link/i);assert.equal(result.removed_symlink_outputs,1);
});
test('startup logs and owned storage are bounded', async () => {
  const result = await fake("const fs=require('node:fs'),path=require('node:path');fs.writeFileSync(path.join(process.env.GOOP_DATA_DIR,'large'),Buffer.alloc(10000));process.stdout.write('y'.repeat(10000));process.stderr.write('x'.repeat(10000));setInterval(()=>{},10)", { budgetBytes: 4096, logLimitBytes: 100 });
  assert.equal(result.success, false);
  assert.equal(result.budget_exceeded, true);
  assert.ok(result.log_bytes_retained <= 100);
});
test('startup catches a fast storage overrun before returning', async () => {
  const result = await fake("const fs=require('node:fs'),path=require('node:path');fs.writeFileSync(path.join(process.env.GOOP_DATA_DIR,'large'),Buffer.alloc(10000));");
  assert.equal(result.success, false);
  assert.equal(result.budget_exceeded, false);
  const bounded = await fake("const fs=require('node:fs'),path=require('node:path');fs.writeFileSync(path.join(process.env.GOOP_DATA_DIR,'large'),Buffer.alloc(10000));", { budgetBytes: 4096 });
  assert.equal(bounded.budget_exceeded, true);
});
test('total timeout includes idle observation and cleanup grace', async () => {
  const start = performance.now();
  const result = await fake("require('node:fs').writeFileSync(process.env.GOOP_STARTUP_REPORT,JSON.stringify({schema_version:1,backend_ready_ms:1,pid:process.pid}));setInterval(()=>{},10)", { readinessTimeoutMs: 120, idleMs: 1000, killGraceMs: 30 });
  assert.equal(result.success, false);
  assert.equal(result.timed_out, true);
  assert.ok(performance.now() - start < 600);
});
