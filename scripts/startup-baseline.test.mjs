import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
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

// The child is alive while runStartup polls ready.json, so it can change the
// entry between any two calls. This subprocess plays that child with perfect
// timing. A look is a synchronous fs call that names ready.json from inside
// runStartup while the child is alive; the storage monitor's timer and the
// checks after the reap are not looks. Right after the `after`-th look of a
// poll, the entry is swapped for a FIFO or for a valid marker padded to 1 MiB
// (and put back before the next poll), or the marker grows by 1 MiB. The
// subprocess also tracks the bytes read through ready.json, and writes `seen`
// once a poll has looked at a planted or grown entry, which tells the runner
// to exit.
const readinessHarness = `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
const { root, mode, after } = JSON.parse(process.argv[1]);
const report = join(root, 'run', 'ready.json'), stash = join(root, 'stash.json');
const sync = Object.fromEntries(Object.entries(fs).filter(([name, call]) => name.endsWith('Sync') && typeof call === 'function'));
const state = { swaps: 0, grown: false, signalled: false, maxReadBytes: 0 }, opened = new Map();
let poll = null;
Error.stackTraceLimit = 50;
const exists = () => { try { return sync.lstatSync(report); } catch { return null; } };
const childAlive = () => { try { process.kill(Number(sync.readFileSync(join(root, 'child.pid'), 'utf8')), 0); return true; } catch { return false; } };
const endPoll = () => {
  if (poll.stashed) { sync.unlinkSync(report); sync.renameSync(stash, report); }
  if (poll.bad && !state.signalled) { state.signalled = true; sync.writeFileSync(join(root, 'seen'), ''); }
  poll = null;
};
const act = () => {
  if (poll.stashed || !exists()?.isFile()) return;
  if (mode === 'grow') { if (!state.grown) { sync.appendFileSync(report, ' '.repeat(1 << 20)); state.grown = poll.bad = true; } return; }
  const marker = JSON.parse(sync.readFileSync(report, 'utf8'));
  sync.renameSync(report, stash);
  if (mode === 'swap-fifo') sync.linkSync(join(root, 'fifo'), report);
  else sync.writeFileSync(report, JSON.stringify({ ...marker, backend_ready_ms: 999 }) + ' '.repeat(1 << 20));
  poll.stashed = true; state.swaps++;
};
const count = (descriptor, bytes) => { const total = opened.get(descriptor) + bytes; opened.set(descriptor, total); state.maxReadBytes = Math.max(state.maxReadBytes, total); };
for (const [name, call] of Object.entries(sync)) fs[name] = function (...args) {
  const [target] = args, looked = target === report && /\\bat runStartup \\(/.test(new Error().stack) && childAlive();
  if (looked) {
    if (!poll) { poll = { looks: 0, bad: false, stashed: false }; queueMicrotask(endPoll); }
    poll.looks++;
    poll.bad ||= mode === 'plant' ? exists() !== null : state.grown;
  }
  try {
    const result = call.apply(this, args);
    if (name === 'openSync' && target === report) opened.set(result, 0);
    else if (name === 'readSync' && opened.has(target)) count(target, result);
    else if (name === 'readFileSync' && (target === report || opened.has(target))) { if (!opened.has(target)) opened.set(target, 0); count(target, result.length); }
    else if (name === 'closeSync') opened.delete(target);
    return result;
  } finally {
    if (looked && mode !== 'plant' && poll.looks === after) act();
  }
};
syncBuiltinESMExports();
const { runStartup } = await import(${JSON.stringify(new URL('./startup-baseline.mjs', import.meta.url).href)});
const result = await runStartup({ binary: process.execPath, args: [join(root, 'runner.cjs')], directory: join(root, 'run'), settings: {}, readinessTimeoutMs: 20000, idleMs: 30, killGraceMs: 30, environment: { ...process.env, GOOP_TEST_SEEN: join(root, 'seen') } });
process.stdout.write(JSON.stringify({ marker: result.marker, ...state }));`;
// What the runner leaves at ready.json, always whole: a valid marker of its own
// (padded with spaces to `size` bytes), or a FIFO already holding one with no
// writer left (its reader descriptor stays open until the runner exits), or a
// hard or symbolic link to one.
const readinessPlants = {
  marker: 'fs.writeFileSync(tmp,marker());fs.renameSync(tmp,report);',
  fifo: "require('node:child_process').execFileSync('/usr/bin/mkfifo',[tmp]);fs.openSync(tmp,fs.constants.O_RDONLY|fs.constants.O_NONBLOCK);const writer=fs.openSync(tmp,fs.constants.O_WRONLY);fs.writeSync(writer,marker());fs.closeSync(writer);fs.renameSync(tmp,report);",
  hardlink: 'fs.writeFileSync(kept,marker());fs.linkSync(kept,report);',
  symlink: 'fs.writeFileSync(kept,marker());fs.symlinkSync(kept,report);',
  oversized: 'fs.writeFileSync(tmp,marker(4096));fs.renameSync(tmp,report);',
  boundary: 'fs.writeFileSync(tmp,marker(4095));fs.renameSync(tmp,report);',
};
// A blocked open freezes the event loop, signal handlers included, so the
// subprocess's timeout is what turns a regression into a failure instead of a
// hung gate. Its child is killed here, since a hung harness never reaped it.
function guardedReadiness(mode, plant, after = 1) {
  const root = mkdtempSync(join(tmpdir(), 'goop-startup-ready-'));
  try {
    execFileSync('/usr/bin/mkfifo', [join(root, 'fifo')]);
    writeFileSync(join(root, 'runner.cjs'), `const fs=require('node:fs'),path=require('node:path'),report=process.env.GOOP_STARTUP_REPORT,tmp=report+'.tmp',kept=path.join(${JSON.stringify(root)},'kept.json');
const marker=(size=0)=>{const text=JSON.stringify({schema_version:1,backend_ready_ms:7,pid:process.pid});return text+' '.repeat(Math.max(0,size-text.length));};
fs.writeFileSync(kept+'.pid',String(process.pid));fs.renameSync(kept+'.pid',path.join(${JSON.stringify(root)},'child.pid'));
${readinessPlants[plant]}
setInterval(()=>{if(fs.existsSync(process.env.GOOP_TEST_SEEN))process.exit(0);},5);`);
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', readinessHarness, JSON.stringify({ root, mode, after })], { encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' }));
  } finally {
    // The runner publishes its pid whole; a missing one must never become kill(0).
    try { const pid = Number(readFileSync(join(root, 'child.pid'), 'utf8')); if (Number.isSafeInteger(pid) && pid > 1) process.kill(-pid, 'SIGKILL'); } catch { /* Reaped, or never started. */ }
    rmSync(root, { recursive: true, force: true });
  }
}
test('a readiness marker swapped after the harness looks at it is read as it was checked', () => {
  for (const [mode, after] of [['swap-fifo', 1], ['swap-fifo', 2], ['swap-large', 1], ['swap-large', 2]]) {
    const label = `${mode} after look ${after}`, result = guardedReadiness(mode, 'marker', after);
    assert.equal(result.marker?.backend_ready_ms, 7, label);
    assert.ok(result.maxReadBytes <= 4096, `${label}: read ${result.maxReadBytes} bytes`);
    // A poll that reads through one descriptor looks once, so only the first
    // look's swap reaches it. The second-look cases catch a poll that checks
    // the path and then reads it again.
    if (after === 1) assert.ok(result.swaps > 0, label);
  }
});
test('a readiness marker that grows once opened is refused without being read whole', () => {
  const result = guardedReadiness('grow', 'marker');
  assert.equal(result.grown, true);
  assert.equal(result.signalled, true);
  assert.equal(result.marker, null);
  assert.ok(result.maxReadBytes <= 4096, `read ${result.maxReadBytes} bytes`);
});
test('the readiness poll accepts only a regular file of its own under 4096 bytes', () => {
  for (const [plant, accepted] of [['fifo', false], ['hardlink', false], ['symlink', false], ['oversized', false], ['boundary', true]]) {
    const result = guardedReadiness('plant', plant);
    // A poll looked at the planted entry while the runner was alive.
    assert.equal(result.signalled, true, plant);
    assert.equal(result.marker?.backend_ready_ms ?? null, accepted ? 7 : null, plant);
    assert.ok(result.maxReadBytes <= 4096, `${plant}: read ${result.maxReadBytes} bytes`);
  }
});
