import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
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
// Time stands still until a clock read finds `startPath`, which the child
// creates once it reaches the state under test. Until then the run's sleeps
// really wait, so a child slowed by machine load starts on its own schedule
// without spending the budget being checked. After that, time moves only when
// the run sleeps, and those sleeps never yield. Caps keep a regression from
// hanging the gate: a start never seen stops being waited for after 3000 real
// sleeps (`missed`), and sleep 1000 throws once; later sleeps return at once so
// the run can still reap its processes.
function clockStartingAt(startPath) {
  const sleeps = [];
  let now = 0, started = false, realSleeps = 0, failed = false;
  const clock = {
    sleeps,
    missed: false,
    nowMs: () => { started ||= existsSync(startPath); return now; },
    sleepMs: async ms => {
      if (!started) {
        if (++realSleeps < 3000) return new Promise(resolve => setTimeout(resolve, ms));
        started = true; clock.missed = true;
      }
      if (failed) return;
      if (sleeps.length >= 1000) { failed = true; throw Error('Virtual clock: wait loop never reached its deadline'); }
      sleeps.push(ms); now += ms;
    },
  };
  return clock;
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
test('timeout also reaps a TERM-resistant descendant after its parent exits', { timeout: 5000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'goop-startup-orphan-'));
  const armed = join(root, 'armed'), guard = join(root, 'descendant.pid');
  let passed = false;
  t.after(() => {
    // A run that never kills the descendant waits on its pipes forever. Kill it
    // here so the test fails at its timeout instead of hanging the gate.
    try {
      const pid = Number(readFileSync(guard, 'utf8'));
      if (!passed && Number.isSafeInteger(pid) && pid > 1) process.kill(pid, 'SIGKILL');
    } catch { /* Never spawned, or already gone. */ }
    rmSync(root, { recursive: true, force: true });
  });
  // The descendant ignores TERM and signals only once its parent has exited on
  // its own, so the parent is gone before the timeout starts.
  const descendant = `process.on('SIGTERM',()=>{});const fs=require('node:fs');const parent=Number(process.argv[1]);const orphaned=setInterval(()=>{if(process.ppid!==parent){clearInterval(orphaned);fs.writeFileSync(${JSON.stringify(`${armed}.tmp`)},'');fs.renameSync(${JSON.stringify(`${armed}.tmp`)},${JSON.stringify(armed)});}},5);setInterval(()=>{},10)`;
  const clock = clockStartingAt(armed);
  const result = await fake(`const descendant=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)},String(process.pid)],{stdio:'inherit'});require('node:fs').writeFileSync(${JSON.stringify(guard)},String(descendant.pid));process.exit(0)`, { readinessTimeoutMs: 1500, killGraceMs: 30, nowMs: clock.nowMs, sleepMs: clock.sleepMs });
  assert.equal(clock.missed, false);
  assert.equal(result.success, false);
  assert.equal(result.timed_out, true);
  // The parent's own clean exit, not the timeout's TERM, ended it.
  assert.equal(result.exit_code, 0);
  assert.equal(result.exit_signal, null);
  // 1470 ms of readiness polling, then the 30 ms grace: exactly the total timeout.
  assert.deepEqual(clock.sleeps, [...Array(147).fill(10), 30]);
  assert.equal(result.lifetime_ms, 1500);
  const pid = readFileSync(guard, 'utf8');
  let state = '';
  try { state = execFileSync('/bin/ps', ['-o', 'stat=', '-p', pid], { encoding: 'utf8' }).trim(); } catch { /* Gone. */ }
  assert.ok(state === '' || /[ZE]/.test(state), `descendant remained runnable with state ${state}`);
  passed = true;
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
  const root = mkdtempSync(join(tmpdir(), 'goop-startup-total-'));
  try {
    const directory = join(root, 'run');
    // Time starts when the ready marker appears. It is renamed into place, so
    // a marker that exists is already complete.
    const clock = clockStartingAt(join(directory, 'ready.json'));
    const result = await fake("const fs=require('node:fs'),report=process.env.GOOP_STARTUP_REPORT;fs.writeFileSync(report+'.tmp',JSON.stringify({schema_version:1,backend_ready_ms:1,pid:process.pid}));fs.renameSync(report+'.tmp',report);setInterval(()=>{},10)", { directory, readinessTimeoutMs: 130, idleMs: 1000, killGraceMs: 30, nowMs: clock.nowMs, sleepMs: clock.sleepMs });
    assert.equal(clock.missed, false);
    assert.equal(result.success, false);
    assert.equal(result.timed_out, true);
    assert.equal(result.marker?.pid, result.pid);
    assert.equal(result.launch_to_ready_ms, 0);
    assert.equal(result.idle_tree_rss_KiB, null);
    // A 130 ms total with a 30 ms grace leaves 100 ms active, so the 1000 ms
    // idle observation stops after two 50 ms polls and the grace ends the run
    // exactly at its total.
    assert.deepEqual(clock.sleeps, [50, 50, 30]);
    assert.equal(result.lifetime_ms, 130);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
