import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, constants, existsSync, linkSync, lstatSync, mkdtempSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createOwnedGroupStopper, directoryBytes, readOwnedRegularFile, runBoundedProcess } from './performance-shared.mjs';
import { directoryBytes as baselineDirectoryBytes } from './performance-baseline.mjs';
import { resolveRuntimeSidecars } from './performance-suite.mjs';
import { run } from './performance-baseline.mjs';

// On Windows, Node puts each child it spawns in a job that ends with its
// parent, so a plain node descendant dies with the root and never tests the
// reap. A converter's native children are in no such job; a detached spawn
// models them. On POSIX the descendant stays in the owned group, as they do.
const windowsNativeChild = process.platform === 'win32';

test('portable runtime-sidecar names are exact for Unix and Windows', () => {
  const root = mkdtempSync(join(tmpdir(), 'goop-portable-sidecars-'));
  try {
    const unix = join(root, 'unix'); mkdirSync(unix);
    writeFileSync(join(unix, 'ffmpeg'), 'runtime'); writeFileSync(join(unix, 'ffprobe'), 'runtime');
    assert.equal(resolveRuntimeSidecars(unix, 'darwin').ffmpeg, realpathSync(join(unix, 'ffmpeg')));
    const windows = join(root, 'windows'); mkdirSync(windows);
    writeFileSync(join(windows, 'ffmpeg.exe'), 'runtime'); writeFileSync(join(windows, 'ffprobe.exe'), 'runtime');
    assert.equal(resolveRuntimeSidecars(windows, 'win32').ffprobe, realpathSync(join(windows, 'ffprobe.exe')));
    writeFileSync(join(windows, 'ffmpeg-x86_64-pc-windows-msvc.exe'), 'source');
    assert.throws(() => resolveRuntimeSidecars(windows, 'win32'), /exactly one exact runtime sidecar/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Virtual time for runBoundedProcess's run timeout and kill grace. Time moves
// only when the test calls advance(): each sleep that falls due resolves in
// deadline order, and the run reacts to it (signals its group, starts its
// grace) before the next one falls due. A sleep whose signal aborts rejects, as
// the default does. `sleeps` lists every sleep requested, `fired` those that fell due.
function manualClock() {
  let now = 0;
  const due = [];
  const earliest = () => due.reduce((first, sleep) => (first === undefined || sleep.at < first.at ? sleep : first), undefined);
  const clock = {
    sleeps: [],
    fired: [],
    nowMs: () => now,
    sleepMs: (ms, { signal } = {}) => new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      const sleep = { ms, at: now + ms, resolve };
      clock.sleeps.push(ms);
      due.push(sleep);
      signal?.addEventListener('abort', () => {
        const index = due.indexOf(sleep);
        if (index === -1) return;
        due.splice(index, 1);
        reject(signal.reason);
      }, { once: true });
    }),
    async advance(ms) {
      const until = now + ms;
      for (let next = earliest(); next !== undefined && next.at <= until; next = earliest()) {
        due.splice(due.indexOf(next), 1);
        now = next.at;
        clock.fired.push(next.ms);
        next.resolve();
        await new Promise(resolve => setImmediate(resolve));
      }
      now = until;
    },
  };
  return clock;
}
// A run the test left waiting on its clock still holds live processes, so after
// the test let every pending sleep fall due: the run then stops its group.
function releaseClockAfter(t, clock) {
  t.after(() => clock.advance(Infinity));
}

// The test timeout is long because windows-latest runs this file, and its
// timeout path starts PowerShell before the forced taskkill.
test('portable bounded runner terminates its descendant tree', { timeout: 30_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'goop-portable-tree-')), output = join(root, 'output'); mkdirSync(output);
  const armed = join(root, 'armed'), runner = join(root, 'runner.cjs');
  const clock = manualClock();
  releaseClockAfter(t, clock);
  const guard = killArmedAfter(t, root, armed);
  const descendant = `${ignoreTermThenArm(armed)}setInterval(()=>{},10)`;
  // The runner exits with its descendant, so the guard's kill also ends the run.
  writeFileSync(runner, `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'}).on('exit',()=>process.exit(1));setInterval(()=>{},10);`);
  const running = runBoundedProcess({ command: process.execPath, args: [runner], outputDirectory: output, timeoutMs: 1500, killGraceMs: 100, logLimitBytes: 1024, storageBudgetBytes: 1024 * 1024, nowMs: clock.nowMs, sleepMs: clock.sleepMs });
  running.catch(() => { /* Rethrown by the await below. */ });
  // The timeout falls due only once TERM can no longer stop the descendant, so
  // only the forced kill after the grace can.
  const armedInTime = await waitForPath(armed);
  await clock.advance(1500);
  assert.equal(armedInTime, true, 'descendant never armed');
  assert.deepEqual(clock.sleeps, [1500, 100]);
  await clock.advance(100);
  const result = await running;
  const pid = Number(readFileSync(armed, 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 1, `invalid descendant pid ${pid}`);
  const state = await stateAfterKill(pid);
  assert.ok(state === '' || /[ZE]/.test(state), `descendant remained runnable with state ${state}`);
  guard.reaped = true;
  assert.equal(result.timed_out, true);
  assert.equal(result.aborted, false);
  assert.equal(result.lifetime_ms, 1600);
});

// Child code that ignores TERM and then renames its pid into `path`, so the
// file existing means TERM can no longer stop that process.
const ignoreTermThenArm = path => `process.on('SIGTERM',()=>{});const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(`${path}.tmp`)},String(process.pid));fs.renameSync(${JSON.stringify(`${path}.tmp`)},${JSON.stringify(path)});`;
// Child code that renames its pid into `path` and changes nothing else, so a
// guard can find a runner that holds the run's pipes.
const recordPid = path => `{const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(`${path}.tmp`)},String(process.pid));fs.renameSync(${JSON.stringify(`${path}.tmp`)},${JSON.stringify(path)});}`;
// A process the run fails to kill outlives the test, and one that holds the
// run's pipes keeps the run from returning. Unless the test saw it gone, kill
// the pid in `armed` after the test, so such a regression fails at the test's
// timeout instead of leaving that process behind or hanging the file. Once it
// is gone the OS may reuse its pid, so the test marks it reaped.
function killArmedAfter(t, dir, armed) {
  const guard = { reaped: false };
  t.after(() => {
    try {
      const pid = Number(readFileSync(armed, 'utf8'));
      if (!guard.reaped && Number.isSafeInteger(pid) && pid > 1) process.kill(pid, 'SIGKILL');
    } catch { /* Never armed, or already gone. */ }
    rmSync(dir, { recursive: true, force: true });
  });
  return guard;
}
// Polls for `path` at most `limit` times (5 ms or more each), so a process that
// never arms normally fails the caller's assertion well before the test's timeout.
async function waitForPath(path, limit = 1000) {
  for (let polls = 0; polls < limit && !existsSync(path); polls++) await new Promise(resolve => setTimeout(resolve, 5));
  return existsSync(path);
}
// SIGKILL and TerminateProcess cannot be ignored, but neither has finished when
// the run returns on a loaded machine. Polls up to 100 times, returning '' once
// the process is gone, its ps state while it exits on POSIX (Z or E), or the
// state still there. A probe that fails for another reason throws, so it never
// reads as gone.
async function stateAfterKill(pid) {
  let state = '';
  for (let polls = 0; polls < 100; polls++) {
    if (process.platform === 'win32') {
      try { process.kill(pid, 0); state = 'running'; } catch (error) { if (error.code === 'ESRCH') return ''; throw error; }
    } else {
      try { state = execFileSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 }).trim(); } catch (error) { if (error.status === 1) return ''; throw error; }
      if (state === '' || /[ZE]/.test(state)) return state;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return state;
}

// The timeout is long because windows-latest runs this file, and its abort
// path starts PowerShell before the forced taskkill.
test('portable bounded runner aborts and reaps its descendant tree', { timeout: 30_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'goop-portable-abort-')), output = join(root, 'output'); mkdirSync(output);
  const armed = join(root, 'armed'), runner = join(root, 'runner.cjs');
  const guard = killArmedAfter(t, root, armed);
  // The runner exits with its descendant, so the guard's kill also ends the run.
  const descendant = `${ignoreTermThenArm(armed)}setInterval(()=>{},10)`;
  writeFileSync(runner, `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'}).on('exit',()=>process.exit(1));setInterval(()=>{},10);`);
  const controller = new AbortController();
  // runBoundedProcess has no default timeout, and leaving it unset times the run
  // out at once. This one is far past the test's, so only the abort can end the
  // run. The abort is sent once TERM can no longer stop the descendant, so only
  // the forced kill after the grace can.
  const running = runBoundedProcess({ command: process.execPath, args: [runner], outputDirectory: output, timeoutMs: 120_000, killGraceMs: 100, logLimitBytes: 1024, storageBudgetBytes: 1024 * 1024, abortSignal: controller.signal });
  running.catch(() => { /* Rethrown by the await below. */ });
  const armedInTime = await waitForPath(armed);
  controller.abort();
  const result = await running;
  assert.equal(armedInTime, true, 'descendant never armed');
  const pid = Number(readFileSync(armed, 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 1, `invalid descendant pid ${pid}`);
  const state = await stateAfterKill(pid);
  assert.ok(state === '' || /[ZE]/.test(state), `descendant remained runnable with state ${state}`);
  guard.reaped = true;
  assert.equal(result.aborted, true);
  assert.equal(result.success, false);
  assert.equal(result.timed_out, false);
});

test('an abort remains the stop cause when the deadline passes during descendant cleanup', { skip: process.platform === 'win32', timeout: 30_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'goop-portable-abort-deadline-')), output = join(root, 'output'); mkdirSync(output);
  const armed = join(root, 'armed'), runner = join(root, 'runner.cjs');
  const clock = manualClock();
  releaseClockAfter(t, clock);
  const guard = killArmedAfter(t, root, armed);
  // The descendant inherits the runner's pipes, so the root does not close, and
  // its timeout stays armed, until the forced kill reaps the descendant. The
  // runner exits with its descendant, so the guard's kill also ends the run.
  const descendant = `${ignoreTermThenArm(armed)}setInterval(()=>{},10);`;
  writeFileSync(runner, `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'}).on('exit',()=>process.exit(1));setInterval(()=>{},10);`);
  const controller = new AbortController();
  const running = runBoundedProcess({ command: process.execPath, args: [runner], outputDirectory: output, timeoutMs: 1500, killGraceMs: 2000, logLimitBytes: 1024, storageBudgetBytes: 1024 * 1024, abortSignal: controller.signal, nowMs: clock.nowMs, sleepMs: clock.sleepMs });
  running.catch(() => { /* Rethrown by the await below. */ });
  const armedInTime = await waitForPath(armed);
  controller.abort();
  // The deadline falls due 1500 ms into the 2000 ms grace.
  await clock.advance(1500);
  assert.equal(armedInTime, true, 'descendant never armed');
  assert.deepEqual(clock.sleeps, [1500, 2000]);
  assert.deepEqual(clock.fired, [1500], 'the deadline did not fall due during the grace');
  await clock.advance(500);
  const result = await running;
  const pid = Number(readFileSync(armed, 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 1, `invalid descendant pid ${pid}`);
  const state = await stateAfterKill(pid);
  assert.ok(state === '' || /[ZE]/.test(state), `descendant remained runnable with state ${state}`);
  guard.reaped = true;
  assert.equal(result.aborted, true);
  assert.equal(result.timed_out, false);
  assert.equal(result.success, false);
  assert.equal(result.lifetime_ms, 2000);
});

test('termination signal wrapper waits for owned process cleanup', { skip: process.platform === 'win32', timeout: 30_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'goop-portable-signal-')), output = join(root, 'output'); mkdirSync(output);
  const armed = join(root, 'armed'), resultPath = join(root, 'result.json'), runner = join(root, 'runner.cjs'), harness = join(root, 'harness.mjs');
  const guard = killArmedAfter(t, root, armed);
  // The runner exits with its descendant, so the guard's kill also ends the run.
  const descendant = `${ignoreTermThenArm(armed)}setInterval(()=>{},10)`;
  writeFileSync(runner, `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'}).on('exit',()=>process.exit(1));setInterval(()=>{},10);`);
  // The run's timeout is far past the test's, so only the wrapper's abort can end it.
  writeFileSync(harness, `import{writeFileSync}from'node:fs';import{runBoundedProcess,withTerminationSignals}from${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'performance-shared.mjs')).href)};await withTerminationSignals(async signal=>{const result=await runBoundedProcess({command:process.execPath,args:[${JSON.stringify(runner)}],outputDirectory:${JSON.stringify(output)},timeoutMs:120000,killGraceMs:100,logLimitBytes:1024,storageBudgetBytes:1048576,abortSignal:signal});writeFileSync(${JSON.stringify(resultPath)},JSON.stringify(result));});`);
  const child = spawn(process.execPath, [harness], { stdio: 'ignore' });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  exited.catch(() => { /* Rethrown by the await below. */ });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  // The wrapper gets TERM once TERM can no longer stop the descendant, so only
  // the forced kill after the grace can. Three Node starts come before it arms.
  const armedInTime = await waitForPath(armed, 3000);
  child.kill('SIGTERM');
  const exit = await exited;
  assert.equal(armedInTime, true, 'descendant never armed');
  const pid = Number(readFileSync(armed, 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 1, `invalid descendant pid ${pid}`);
  const state = await stateAfterKill(pid);
  assert.ok(state === '' || /[ZE]/.test(state), `descendant remained runnable with state ${state}`);
  guard.reaped = true;
  assert.deepEqual(exit, { code: 143, signal: null });
  assert.equal(JSON.parse(readFileSync(resultPath, 'utf8')).aborted, true);
});

test('portable bounded runner removes only newly owned staging after timeout', { timeout: 30_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'goop-portable-staging-'));
  const clock = manualClock();
  releaseClockAfter(t, clock);
  const runnerPid = join(root, 'runner.pid');
  const guard = killArmedAfter(t, root, runnerPid);
  const output = join(root, 'output');
  mkdirSync(output);
  const preserved = join(output, '.goop-output-1-0');
  mkdirSync(preserved);
  const created = join(output, `.goop-output-${process.pid}-1`);
  const runner = join(root, 'runner.cjs');
  writeFileSync(runner, `${recordPid(runnerPid)}require('node:fs').mkdirSync(process.env.GOOP_TEST_STAGING);setInterval(()=>{},10);`);
  const running = runBoundedProcess({ command: process.execPath, args: [runner], env: { ...process.env, GOOP_TEST_STAGING: created }, outputDirectory: output, timeoutMs: 1500, killGraceMs: 100, logLimitBytes: 1024, storageBudgetBytes: 1024 * 1024, nowMs: clock.nowMs, sleepMs: clock.sleepMs });
  running.catch(() => { /* Rethrown by the await below. */ });
  // The timeout falls due only once the runner has created its staging.
  const createdInTime = await waitForPath(created);
  await clock.advance(1500);
  assert.equal(createdInTime, true, 'runner never created its staging');
  assert.deepEqual(clock.sleeps, [1500, 100]);
  await clock.advance(100);
  const result = await running;
  guard.reaped = true;
  assert.equal(result.timed_out, true);
  assert.equal(result.removed_staging_directories, 1);
  assert.equal(result.cleanup_error, null);
  assert.equal(existsSync(created), false);
  assert.equal(existsSync(preserved), true);
});

test('portable bounded runner reaps descendants after an ordinary parent failure', { timeout: 30_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'goop-portable-failure-tree-')), output = join(root, 'output'); mkdirSync(output);
  const armed = join(root, 'armed'), runner = join(root, 'runner.cjs');
  const guard = killArmedAfter(t, root, armed);
  const descendant = `${ignoreTermThenArm(armed)}setInterval(()=>{},10)`;
  // The parent exits only once TERM can no longer stop its descendant, so only
  // the forced kill after the grace can.
  writeFileSync(runner, `const cp=require('node:child_process'),fs=require('node:fs');cp.spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore',detached:${windowsNativeChild}});while(!fs.existsSync(${JSON.stringify(armed)})){};process.exit(1);`);
  // The parent ends the run itself. The timeout only bounds a parent that never
  // does, and sits under the test's own so the run still reaps the group.
  const result = await runBoundedProcess({ command: process.execPath, args: [runner], outputDirectory: output, timeoutMs: 20_000, killGraceMs: 100, logLimitBytes: 1024, storageBudgetBytes: 1024 * 1024 });
  const pid = Number(readFileSync(armed, 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 1, `invalid descendant pid ${pid}`);
  const state = await stateAfterKill(pid);
  assert.ok(state === '' || /[ZE]/.test(state), `descendant remained runnable with state ${state}`);
  guard.reaped = true;
  assert.equal(result.exit_code, 1);
  assert.equal(result.success, false);
});

test('portable bounded runner reaps descendants after a clean parent exit', { timeout: 30_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'goop-portable-clean-tree-')), output = join(root, 'output'); mkdirSync(output);
  const armed = join(root, 'armed'), runner = join(root, 'runner.cjs');
  const guard = killArmedAfter(t, root, armed);
  const descendant = `${ignoreTermThenArm(armed)}setInterval(()=>{},10)`;
  // The parent exits only once TERM can no longer stop its descendant, so only
  // the forced kill after the grace can.
  writeFileSync(runner, `const cp=require('node:child_process'),fs=require('node:fs');const child=cp.spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore',detached:${windowsNativeChild}});child.unref();while(!fs.existsSync(${JSON.stringify(armed)})){};`);
  // The parent ends the run itself. The timeout only bounds a parent that never
  // does, and sits under the test's own so the run still reaps the group.
  const result = await runBoundedProcess({ command: process.execPath, args: [runner], outputDirectory: output, timeoutMs: 20_000, killGraceMs: 100, logLimitBytes: 1024, storageBudgetBytes: 1024 * 1024 });
  const pid = Number(readFileSync(armed, 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 1, `invalid descendant pid ${pid}`);
  const state = await stateAfterKill(pid);
  assert.ok(state === '' || /[ZE]/.test(state), `descendant remained runnable with state ${state}`);
  guard.reaped = true;
  assert.equal(result.exit_code, 0);
  assert.equal(result.success, true);
});

test('portable bounded runner returns promptly after a clean Windows exit', { skip: process.platform !== 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'goop-portable-clean-prompt-'));
  const output = join(root, 'output');
  mkdirSync(output);
  try {
    const startedAt = performance.now();
    const result = await runBoundedProcess({ command: process.execPath, args: ['-e', ''], outputDirectory: output, timeoutMs: 5000, killGraceMs: 3000, logLimitBytes: 1024, storageBudgetBytes: 1024 * 1024 });
    assert.equal(result.success, true);
    assert.ok(performance.now() - startedAt < 1500, 'clean exit waited for forced-kill grace');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('portable bounded runner catches a fast successful storage overrun', async () => {
  const root = mkdtempSync(join(tmpdir(), 'goop-portable-fast-storage-'));
  const output = join(root, 'output');
  mkdirSync(output);
  const runner = join(root, 'runner.cjs');
  writeFileSync(runner, "require('node:fs').writeFileSync(require('node:path').join(process.env.GOOP_TEST_OUTPUT,'large.bin'),Buffer.alloc(10000));");
  try {
    // No live sample falls before the child exits, so only the check after it
    // exits can catch the overrun. The timeout only bounds a child that never exits.
    const result = await runBoundedProcess({ command: process.execPath, args: [runner], env: { ...process.env, GOOP_TEST_OUTPUT: output }, outputDirectory: output, timeoutMs: 20_000, killGraceMs: 50, logLimitBytes: 128, storageBudgetBytes: 1024, samplingIntervalMs: 60_000 });
    assert.equal(result.sampling_interval_ms, 60_000);
    assert.equal(result.exit_code, 0);
    assert.equal(result.budget_exceeded, true);
    assert.equal(result.success, false);
    assert.ok(directoryBytes(output) + result.log_bytes_retained <= 1024);
    assert.equal(existsSync(join(output, 'large.bin')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// timers/promises rejects a delay that is not a number, where setTimeout used to
// coerce it, so the run must stop at once rather than lose its timeout or leave
// its grace rejected. The abort after the test stops a run that never does.
test('portable bounded runner fails closed on a delay its timers reject', { timeout: 30_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'goop-portable-bad-delay-')), output = join(root, 'output'); mkdirSync(output);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const runnerPid = join(root, 'runner.pid');
  const guard = killArmedAfter(t, root, runnerPid);
  const runner = join(root, 'runner.cjs');
  writeFileSync(runner, `${recordPid(runnerPid)}setInterval(()=>{},10);`);
  const result = await runBoundedProcess({ command: process.execPath, args: [runner], outputDirectory: output, timeoutMs: null, killGraceMs: null, logLimitBytes: 1024, storageBudgetBytes: 1024 * 1024, abortSignal: controller.signal });
  guard.reaped = true;
  assert.equal(result.timed_out, true);
  assert.equal(result.aborted, false);
});

// A group kill sent while a member is being forked misses that member: the
// stop's TERM and KILL reached /usr/bin/time but not the runner it was forking.
// These tests model the miss by dropping every group signal until `armed`
// exists, recording each dropped one in `dropped`.
const dropUntilArmed = (armed, dropped) => (pid, name) => {
  if (!existsSync(armed)) { dropped.push(name); return; }
  process.kill(-pid, name);
};

test('portable bounded runner keeps killing its group until a member the stop missed is gone', { skip: process.platform === 'win32', timeout: 30_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'goop-portable-missed-kill-')), output = join(root, 'output'); mkdirSync(output);
  const armed = join(root, 'armed'), runner = join(root, 'runner.cjs');
  const guard = killArmedAfter(t, root, armed);
  const dropped = [];
  // The runner holds the run's pipes, so the root cannot close while it lives.
  writeFileSync(runner, `${recordPid(armed)}setInterval(()=>{},10);`);
  const result = await runBoundedProcess({ command: process.execPath, args: [runner], outputDirectory: output, timeoutMs: null, killGraceMs: null, logLimitBytes: 1024, storageBudgetBytes: 1024 * 1024, samplingIntervalMs: 10, killGroup: dropUntilArmed(armed, dropped) });
  assert.deepEqual(dropped.slice(0, 2), ['SIGTERM', 'SIGKILL'], "the stop's own signals did not miss the runner");
  const pid = Number(readFileSync(armed, 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 1, `invalid runner pid ${pid}`);
  const state = await stateAfterKill(pid);
  assert.ok(state === '' || /[ZE]/.test(state), `runner remained runnable with state ${state}`);
  guard.reaped = true;
  assert.equal(result.timed_out, true);
});

test('portable bounded runner kills a member the stop missed after the root closes', { skip: process.platform === 'win32', timeout: 30_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'goop-portable-missed-kill-closed-')), output = join(root, 'output'); mkdirSync(output);
  const armed = join(root, 'armed'), runner = join(root, 'runner.cjs');
  const guard = killArmedAfter(t, root, armed);
  const dropped = [];
  // The descendant ignores TERM and holds none of the run's pipes, and the
  // runner exits once it has armed, so the root closes with the descendant still
  // in the group. The monitor never ticks before that, so only a kill after the
  // close can reach it.
  const descendant = `${ignoreTermThenArm(armed)}setInterval(()=>{},10)`;
  writeFileSync(runner, `const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});const wait=setInterval(()=>{if(fs.existsSync(${JSON.stringify(armed)})){clearInterval(wait);process.exit(0);}},5);`);
  const result = await runBoundedProcess({ command: process.execPath, args: [runner], outputDirectory: output, timeoutMs: null, killGraceMs: null, logLimitBytes: 1024, storageBudgetBytes: 1024 * 1024, samplingIntervalMs: 2 ** 31 - 1, killGroup: dropUntilArmed(armed, dropped) });
  assert.deepEqual(dropped.slice(0, 2), ['SIGTERM', 'SIGKILL'], "the stop's own signals did not miss the descendant");
  const pid = Number(readFileSync(armed, 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 1, `invalid descendant pid ${pid}`);
  const state = await stateAfterKill(pid);
  assert.ok(state === '' || /[ZE]/.test(state), `descendant outlived the run with state ${state}`);
  guard.reaped = true;
  assert.equal(result.timed_out, true);
});

test('portable bounded runner stops killing its group once the group is gone', { skip: process.platform === 'win32', timeout: 30_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'goop-portable-group-gone-')), output = join(root, 'output'); mkdirSync(output);
  const armed = join(root, 'armed'), runner = join(root, 'runner.cjs');
  const guard = killArmedAfter(t, root, armed);
  const dropped = [], sent = [];
  const killGroup = (pid, name) => {
    if (!existsSync(armed)) { dropped.push(name); return; }
    try { process.kill(-pid, name); sent.push(`${name}:ok`); } catch (error) { sent.push(`${name}:${error.code}`); throw error; }
  };
  // The holder leaves the group in its own session but keeps the run's pipes for
  // 500 ms, so the root stays open after the group kill has emptied the group.
  const holder = `${recordPid(armed)}setTimeout(()=>process.exit(0),500)`;
  writeFileSync(runner, `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(holder)}],{stdio:'inherit',detached:true});setInterval(()=>{},10);`);
  const result = await runBoundedProcess({ command: process.execPath, args: [runner], outputDirectory: output, timeoutMs: null, killGraceMs: null, logLimitBytes: 1024, storageBudgetBytes: 1024 * 1024, samplingIntervalMs: 10, killGroup });
  const pid = Number(readFileSync(armed, 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 1, `invalid holder pid ${pid}`);
  const state = await stateAfterKill(pid);
  assert.ok(state === '' || /[ZE]/.test(state), `holder outlived the run with state ${state}`);
  guard.reaped = true;
  assert.deepEqual(dropped.slice(0, 2), ['SIGTERM', 'SIGKILL'], "the stop's own signals did not miss the group");
  assert.ok(sent.includes('SIGKILL:ok'), `the group was never killed: ${sent.join(', ')}`);
  // A group with only zombies left reports EPERM on macOS until they are reaped.
  assert.ok(sent.filter(entry => entry === 'SIGKILL:ESRCH').length <= 1, `kept killing a group that was gone: ${sent.join(', ')}`);
  assert.equal(result.timed_out, true);
});

test('portable bounded runner takes only a sampling interval Node can honor', async () => {
  const root = mkdtempSync(join(tmpdir(), 'goop-portable-interval-')), output = join(root, 'output'); mkdirSync(output);
  try {
    const run = samplingIntervalMs => runBoundedProcess({ command: process.execPath, args: ['-e', ''], outputDirectory: output, timeoutMs: 20_000, logLimitBytes: 1024, storageBudgetBytes: 1024 * 1024, samplingIntervalMs });
    for (const samplingIntervalMs of [0, 0.5, 2 ** 31, Number.NaN, '100']) await assert.rejects(run(samplingIntervalMs), /Sampling interval/, String(samplingIntervalMs));
    for (const samplingIntervalMs of [1, 2 ** 31 - 1]) assert.equal((await run(samplingIntervalMs)).sampling_interval_ms, samplingIntervalMs);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('portable bounded runner rejects and removes child-created symlinks without following them', async () => {
  const root=mkdtempSync(join(tmpdir(),'goop-portable-symlink-')),output=join(root,'output');mkdirSync(output);
  const external=join(root,'external');writeFileSync(external,Buffer.alloc(10000));const runner=join(root,'runner.cjs');
  writeFileSync(runner,"require('node:fs').symlinkSync(process.env.GOOP_TEST_EXTERNAL,require('node:path').join(process.env.GOOP_TEST_OUTPUT,'link'));");
  try {
    // The child ends the run itself. The timeout only bounds one that never does.
    const result=await runBoundedProcess({command:process.execPath,args:[runner],env:{...process.env,GOOP_TEST_EXTERNAL:external,GOOP_TEST_OUTPUT:output},outputDirectory:output,timeoutMs:20_000,killGraceMs:50,logLimitBytes:128,storageBudgetBytes:1024});
    assert.equal(result.success,false);assert.match(result.output_error,/symbolic-link/i);assert.equal(existsSync(join(output,'link')),false);assert.equal(existsSync(external),true);
  } finally {rmSync(root,{recursive:true,force:true});}
});

// Stands in for taskkill and the process table, given as [pid, parent pid,
// creation in ms]. A creation left out is a minute from now, so after any
// launch in the test; null is a process Windows reports no creation for.
// Console processes refuse a soft taskkill, as real ones do. A forced one ends
// that pid only: whatever /t adds is Windows' own walk, so only the pids the
// stopper picks are under test.
const windowsFileTime = ms => ms === null ? 0n : (BigInt(Math.round(ms)) + 11644473600000n) * 10000n;
function fakeWindows(table) {
  const later = Date.now() + 60000;
  const live = new Map(table.map(([pid, parent, created = later]) => [pid, { parent, created }])), calls = [];
  const execFile = (command, args) => {
    if (command === 'powershell.exe') { calls.push('process table'); return `${[...live].map(([pid, { parent, created }]) => `${pid} ${parent} ${windowsFileTime(created)}`).join('\r\n')}\r\n`; }
    const pid = Number(args[args.indexOf('/pid') + 1]), forced = args.includes('/f');
    calls.push(`taskkill ${pid}${forced ? ' /f' : ''}`);
    if (!forced || !live.has(pid)) throw Error('taskkill refused');
    live.delete(pid);
    return '';
  };
  return { live, calls, execFile };
}
// A grace the test ends by hand, so no wall clock decides the order. A wait
// nobody ends never settles, so these tests carry a timeout.
function heldGrace() { const waits = []; return { waits, sleep: ms => new Promise(resolve => { waits.push({ ms, resolve }); }) }; }
const fakeRoot = pid => Object.assign(new EventEmitter(), { pid });

test('owned group stopper reaps the orphans of an exited Windows root from the process table', { timeout: 10000 }, async () => {
  const windows = fakeWindows([[200, 100], [300, 200], [400, 1], [500, 999]]), grace = heldGrace(), root = fakeRoot(100);
  const group = createOwnedGroupStopper(root, { killGraceMs: 250, sleep: grace.sleep, platform: 'win32', execFile: windows.execFile });
  root.emit('close', 0);
  const stopped = group.stop();
  assert.equal(group.stop(), stopped, 'a second stop must not signal again');
  assert.deepEqual(grace.waits.map(wait => wait.ms), [250]);
  assert.ok(windows.calls.includes('process table'));
  assert.deepEqual([...windows.live.keys()], [200, 300, 400, 500], 'nothing is forced before the grace ends');
  grace.waits[0].resolve();
  await stopped;
  assert.deepEqual([...windows.live.keys()], [400, 500]);
  assert.ok(!windows.calls.some(call => /^taskkill (400|500)/.test(call)), `unowned process signalled: ${windows.calls}`);
});

test('owned group stopper leaves processes whose Windows parent id is stale', { timeout: 10000 }, async () => {
  const launch = Date.now(), hourBefore = launch - 3600000;
  // Windows never clears a parent id, so these only look owned: 250 and 215 were
  // made under earlier holders of the root's pid (215 just past the slack), 300,
  // 320 and 330 are older than the 200 and 310 they name, and 270 has no stamp.
  // 260 is reached only through 250. 210's stamp precedes the launch read, as a
  // coarse clock can stamp a child made right after the spawn.
  const windows = fakeWindows([[200, 100, launch + 50000], [210, 100, launch - 100], [310, 200, launch + 60000], [250, 100, hourBefore], [215, 100, launch - 1500], [260, 250, launch + 60000], [270, 100, null], [300, 200, hourBefore], [320, 310, launch + 30000], [330, 310, launch + 59990]]);
  const grace = heldGrace(), root = fakeRoot(100);
  const group = createOwnedGroupStopper(root, { killGraceMs: 250, sleep: grace.sleep, platform: 'win32', execFile: windows.execFile });
  root.emit('close', 0);
  const stopped = group.stop();
  grace.waits[0].resolve();
  await stopped;
  assert.deepEqual([...windows.live.keys()].sort((a, b) => a - b), [215, 250, 260, 270, 300, 320, 330]);
  assert.ok(!windows.calls.some(call => /^taskkill (215|250|260|270|300|320|330)\b/.test(call)), `unowned process signalled: ${windows.calls}`);
});

test('owned group stopper forces a live Windows root that refuses the soft stop', { timeout: 10000 }, async () => {
  const windows = fakeWindows([[100, 1]]), grace = heldGrace(), root = fakeRoot(100);
  const stopped = createOwnedGroupStopper(root, { killGraceMs: 250, sleep: grace.sleep, platform: 'win32', execFile: windows.execFile }).stop();
  assert.deepEqual(grace.waits.map(wait => wait.ms), [250], 'a refused soft stop must still lead to the forced one');
  assert.equal(windows.live.has(100), true);
  grace.waits[0].resolve();
  await stopped;
  assert.equal(windows.live.has(100), false);
});

test('owned group stopper forces at once when the grace wait fails', { timeout: 10000 }, async () => {
  const windows = fakeWindows([[100, 1]]), root = fakeRoot(100);
  await createOwnedGroupStopper(root, { killGraceMs: 250, sleep: () => Promise.reject(Error('no clock')), platform: 'win32', execFile: windows.execFile }).stop();
  assert.equal(windows.live.has(100), false);
});

test('owned group stopper returns at once for an exited Windows root with nothing left', { timeout: 10000 }, async () => {
  const windows = fakeWindows([[400, 1]]), grace = heldGrace(), root = fakeRoot(100);
  const group = createOwnedGroupStopper(root, { killGraceMs: 250, sleep: grace.sleep, platform: 'win32', execFile: windows.execFile });
  root.emit('close', 0);
  const stopped = group.stop();
  assert.deepEqual(grace.waits, [], 'nothing was left to force, yet the stop waits out the grace');
  await stopped;
  assert.ok(!windows.calls.some(call => call.endsWith('/f')), `forced kill sent: ${windows.calls}`);
});

// Windows has no O_NOFOLLOW. Stripping it makes every platform open the way
// Windows does, so only the checks around the open can refuse a link.
const openLikeWindows = (path, flags) => openSync(path, flags & ~(constants.O_NOFOLLOW ?? 0));

test('owned regular file reads never open a link and refuse a swapped or shared file', () => {
  const root = mkdtempSync(join(tmpdir(), 'goop-portable-owned-read-'));
  try {
    const outside = name => { const path = join(root, `outside-${name}`); writeFileSync(path, 'followed'); return path; };
    const opened = [];
    const recordOpen = (path, flags) => { opened.push(path); return openLikeWindows(path, flags); };
    const plain = join(root, 'plain'); writeFileSync(plain, 'owned');
    assert.equal(readOwnedRegularFile(plain, 6, recordOpen)?.toString(), 'owned');
    assert.equal(readOwnedRegularFile(plain, 5, recordOpen), null, 'a file at the size limit must be refused');
    const link = join(root, 'link'); symlinkSync(outside('link'), link);
    assert.equal(readOwnedRegularFile(link, 1024, recordOpen), null);
    assert.ok(!opened.includes(link), 'a symbolic link was opened');
    const hard = join(root, 'hard'); linkSync(outside('hard'), hard);
    assert.equal(readOwnedRegularFile(hard, 1024, recordOpen), null);
    // Replaced by a link after the check: the opened file is not the one checked.
    const swapped = join(root, 'swapped'); writeFileSync(swapped, 'owned');
    const target = outside('swapped');
    assert.equal(readOwnedRegularFile(swapped, 1024, (path, flags) => { unlinkSync(path); symlinkSync(target, path); return openLikeWindows(path, flags); }), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Running, as opposed to gone or a zombie the kernel has not retired yet. Only
// ps's own "no such process" counts as gone, so a failed ps cannot pass a test.
const running = pid => {
  if (process.platform === 'win32') { try { process.kill(pid, 0); return true; } catch { return false; } }
  let state = '';
  try { state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim(); } catch (error) { if (error.status !== 1) throw error; }
  return state !== '' && !/[ZE]/.test(state);
};
// A process nothing killed never leaves, so a bounded wait cannot turn a
// survivor into a pass.
async function outlives(pid) {
  for (let polls = 0; running(pid) && polls < 250; polls++) await new Promise(resolve => setTimeout(resolve, 20));
  return running(pid);
}
const recordedPid = path => { try { const pid = Number(readFileSync(path, 'utf8')); return Number.isInteger(pid) && pid > 1 ? pid : null; } catch { return null; } };
// Only a survivor is killed, so a pid reused after a clean reap is left alone.
const killRecorded = path => { const pid = recordedPid(path); if (pid && running(pid)) try { process.kill(pid, 'SIGKILL'); } catch { /* Already gone. */ } };
// A pid file published by rename, so a reader never sees a partial pid.
const publishPid = path => `require('node:fs').writeFileSync(${JSON.stringify(`${path}.tmp`)},String(process.pid));require('node:fs').renameSync(${JSON.stringify(`${path}.tmp`)},${JSON.stringify(path)});`;

// run() launches `binary sidecars request metrics hardware`, so with node as
// the binary the runner script rides in the sidecars slot on every platform.
async function portableConversion(t, runnerSource, options) {
  const root = mkdtempSync(join(tmpdir(), 'goop-portable-run-')), output = join(root, 'output'), runner = join(root, 'runner.cjs');
  mkdirSync(output); writeFileSync(runner, runnerSource);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return run(process.execPath, runner, { output_path: join(output, 'result') }, join(output, 'run'), options);
}
function pidDirectory(t, ...names) {
  const directory = mkdtempSync(join(tmpdir(), 'goop-portable-pids-')), paths = names.map(name => join(directory, name));
  t.after(() => { for (const path of paths) killRecorded(path); rmSync(directory, { recursive: true, force: true }); });
  return paths;
}

test('single conversion reaps a descendant that outlives a clean root exit', { timeout: 60000 }, async t => {
  const [armed] = pidDirectory(t, 'descendant.pid');
  const descendant = `process.on('SIGTERM',()=>{});${publishPid(armed)}setInterval(()=>{},10)`;
  const result = await portableConversion(t, `const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore',detached:${windowsNativeChild}}).unref();const wait=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(armed)}))return;clearInterval(wait);fs.writeFileSync(process.argv[3],JSON.stringify({success:true,process_ms:1}));},5);`, { timeoutMs: 30000, killGraceMs: 100 });
  assert.equal(result.error, undefined, 'the regular metrics file was not read');
  assert.equal(result.exit_code, 0);
  assert.equal(result.success, true);
  const pid = recordedPid(armed);
  assert.ok(pid, 'descendant never armed');
  assert.equal(await outlives(pid), false, 'descendant outlived the run');
});

test('single conversion stop forces a root that survives the soft stop', { timeout: 60000 }, async t => {
  const [armed] = pidDirectory(t, 'root.pid');
  const controller = new AbortController();
  const poll = setInterval(() => { if (existsSync(armed)) { clearInterval(poll); controller.abort(); } }, 10);
  t.after(() => clearInterval(poll));
  const result = await portableConversion(t, `process.on('SIGTERM',()=>{});${publishPid(armed)}setInterval(()=>{},10);`, { timeoutMs: 30000, killGraceMs: 100, abortSignal: controller.signal });
  assert.equal(result.aborted, true);
  assert.equal(result.timed_out, false);
  assert.equal(result.success, false);
  const pid = recordedPid(armed);
  assert.ok(pid, 'root never armed');
  assert.equal(await outlives(pid), false, 'root outlived the run');
});

test('single conversion never reads metrics through a child-made symbolic link', { timeout: 60000 }, async t => {
  const outside = mkdtempSync(join(tmpdir(), 'goop-portable-outside-')), target = join(outside, 'metrics.json');
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(target, JSON.stringify({ success: true, process_ms: 1, marker: 'followed' }));
  const result = await portableConversion(t, `require('node:fs').symlinkSync(${JSON.stringify(target)},process.argv[3]);`, { timeoutMs: 30000, killGraceMs: 100 });
  assert.equal(result.marker, undefined, 'metrics were read through the link');
  assert.equal(result.error, 'No metrics produced');
  assert.equal(result.removed_symlink_outputs, 1);
  assert.equal(result.success, false);
});

// Hooks reproduce the app removing a publication temp file or SQLite journal mid-scan.
const fsError = code => Object.assign(Error(`injected ${code}`), { code });

test('storage scan skips an entry removed between listing and lstat', () => {
  const root = mkdtempSync(join(tmpdir(), 'goop-scan-vanished-entry-'));
  try {
    const temporary = '.frontend.json.1.0.tmp';
    writeFileSync(join(root, 'kept'), '1234');
    writeFileSync(join(root, temporary), 'x'.repeat(100));
    let listed = [];
    const listThenRemove = (path, options) => {
      const entries = readdirSync(path, options);
      if (path === root) { listed = entries; unlinkSync(join(root, temporary)); }
      return entries;
    };
    assert.equal(directoryBytes(root, { readdirSync: listThenRemove, lstatSync }), 4);
    assert.ok(listed.includes(temporary), 'the removed entry was listed before its lstat');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const removeThenList = target => (path, options) => {
  if (path === target) rmSync(target, { recursive: true });
  return readdirSync(path, options);
};

test('storage scan counts a subdirectory removed just before it is listed as empty', () => {
  const root = mkdtempSync(join(tmpdir(), 'goop-scan-vanished-directory-'));
  try {
    const sub = join(root, 'sub');
    writeFileSync(join(root, 'kept'), '1234');
    mkdirSync(sub);
    writeFileSync(join(sub, 'inner'), 'x'.repeat(100));
    assert.equal(directoryBytes(root, { readdirSync: removeThenList(sub), lstatSync }), 4);
    assert.equal(existsSync(sub), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('storage scan counts a missing or just-removed root as empty', () => {
  const root = mkdtempSync(join(tmpdir(), 'goop-scan-missing-root-'));
  try {
    assert.equal(directoryBytes(join(root, 'absent')), 0);
    const owned = join(root, 'owned');
    mkdirSync(owned);
    writeFileSync(join(owned, 'large'), Buffer.alloc(10000));
    assert.equal(directoryBytes(owned, { readdirSync: removeThenList(owned), lstatSync }), 0);
    assert.equal(existsSync(owned), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('storage scan fails on a root it cannot reach instead of counting it empty', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'goop-scan-unreachable-root-'));
  const parent = join(root, 'parent'), owned = join(parent, 'owned');
  mkdirSync(owned, { recursive: true });
  writeFileSync(join(owned, 'large'), Buffer.alloc(10000));
  chmodSync(parent, 0o000);
  try {
    assert.throws(() => directoryBytes(owned), { code: 'EACCES' });
  } finally { chmodSync(parent, 0o700); rmSync(root, { recursive: true, force: true }); }
});

test('storage scan still fails on every error other than a vanished entry', () => {
  const root = mkdtempSync(join(tmpdir(), 'goop-scan-other-errors-'));
  try {
    const sub = join(root, 'sub');
    writeFileSync(join(root, 'kept'), '1234');
    mkdirSync(sub);
    for (const code of ['EACCES', 'EPERM', 'EIO', 'ENOTDIR', 'EMFILE', undefined]) {
      const failing = () => { throw code === undefined ? Error('uncoded failure') : fsError(code); };
      const lstatFails = path => path === join(root, 'kept') ? failing() : lstatSync(path);
      const listingFails = (path, options) => path === sub ? failing() : readdirSync(path, options);
      const expected = code === undefined ? /uncoded failure/ : { code };
      assert.throws(() => directoryBytes(root, { readdirSync, lstatSync: lstatFails }), expected, `lstat ${code}`);
      assert.throws(() => directoryBytes(root, { readdirSync: listingFails, lstatSync }), expected, `subdirectory listing ${code}`);
      assert.throws(() => directoryBytes(root, { readdirSync: failing, lstatSync }), expected, `root listing ${code}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('storage scan fails on a listed name that can never be stated', () => {
  // Bytes that are not valid UTF-8 list as U+FFFD and then miss on every lstat;
  // treating that ENOENT as a vanish would hide the file for the whole run.
  const root = mkdtempSync(join(tmpdir(), 'goop-scan-lossy-name-'));
  try {
    writeFileSync(join(root, 'kept'), '1234');
    const listLossy = path => path === root ? [...readdirSync(path), 'queue.db-journal\uFFFD'] : readdirSync(path);
    assert.throws(() => directoryBytes(root, { readdirSync: listLossy, lstatSync }), { code: 'ENOENT' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('storage scan fails when two listed names decode alike', () => {
  // A non-UTF-8 name and its U+FFFD twin both list as one string, so lstat would
  // measure the twin twice and never see the other file.
  const root = mkdtempSync(join(tmpdir(), 'goop-scan-name-collision-'));
  try {
    writeFileSync(join(root, 'a\uFFFD'), 'x');
    const listTwins = path => path === root ? [...readdirSync(path), 'a\uFFFD'] : readdirSync(path);
    assert.throws(() => directoryBytes(root, { readdirSync: listTwins, lstatSync }), /collide/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('storage scan trusts a vanish under a parent whose own name holds U+FFFD', () => {
  const root = mkdtempSync(join(tmpdir(), 'goop-scan-\uFFFD-parent-'));
  try {
    const temporary = '.frontend.json.1.0.tmp';
    writeFileSync(join(root, 'kept'), '1234');
    writeFileSync(join(root, temporary), 'x'.repeat(100));
    const listThenRemove = path => {
      const names = readdirSync(path);
      if (path === root) unlinkSync(join(root, temporary));
      return names;
    };
    assert.equal(directoryBytes(root, { readdirSync: listThenRemove, lstatSync }), 4);
    assert.equal(directoryBytes(join(root, 'absent')), 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('storage scan counts a symlink itself and never follows it', () => {
  const root = mkdtempSync(join(tmpdir(), 'goop-scan-symlink-'));
  try {
    const owned = join(root, 'owned'), target = join(root, 'target');
    mkdirSync(owned);
    writeFileSync(target, Buffer.alloc(10000));
    symlinkSync(target, join(owned, 'link'));
    const linkBytes = lstatSync(join(owned, 'link')).size;
    assert.ok(linkBytes < 10000);
    assert.equal(directoryBytes(owned), linkBytes);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('startup and conversion monitors share the one storage scan', () => {
  assert.equal(baselineDirectoryBytes, directoryBytes);
});

// The scan counts vanished entries as zero, so a throw that reaches the live
// monitor is a real read failure, such as an owned directory made unreadable.
test('bounded runner live storage check fails closed when the owned tree cannot be read', async () => {
  const root = mkdtempSync(join(tmpdir(), 'goop-portable-unreadable-'));
  const output = join(root, 'output');
  mkdirSync(output);
  try {
    // The post-exit check alone also reports an overrun, so only an early stop shows the live check acted.
    const result = await runBoundedProcess({ command: process.execPath, args: ['-e', 'setInterval(()=>{},10)'], outputDirectory: output, timeoutMs: 30000, killGraceMs: 100, logLimitBytes: 1024, storageBudgetBytes: 1024 * 1024, measureBytes: () => { throw fsError('EACCES'); }, readSnapshot: () => '' });
    assert.equal(result.budget_exceeded, true);
    assert.equal(result.timed_out, false);
    assert.equal(result.success, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Windows takes no process samples, so it has no sampler to fail.
test('bounded runner storage check still runs when the process sampler fails', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'goop-portable-sampler-'));
  const output = join(root, 'output');
  mkdirSync(output);
  let sampled = 0;
  try {
    const result = await runBoundedProcess({ command: process.execPath, args: ['-e', 'setInterval(()=>{},10)'], outputDirectory: output, timeoutMs: 30000, killGraceMs: 100, logLimitBytes: 1024, storageBudgetBytes: 1024 * 1024, measureBytes: () => 2 * 1024 * 1024, readSnapshot: () => { sampled += 1; throw fsError('ETIMEDOUT'); } });
    assert.ok(sampled > 0);
    assert.equal(result.budget_exceeded, true);
    assert.equal(result.timed_out, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('bounded runner treats a failed process sample as a missed sample, not an overrun', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'goop-portable-missed-sample-'));
  const output = join(root, 'output');
  const flag = join(root, 'sampled');
  mkdirSync(output);
  let sampled = 0;
  // The child exits only after the harness has tried and failed to sample it.
  const child = "const fs=require('node:fs');setInterval(()=>{if(fs.existsSync(process.env.GOOP_TEST_FLAG))process.exit(0);},5)";
  try {
    const result = await runBoundedProcess({ command: process.execPath, args: ['-e', child], env: { ...process.env, GOOP_TEST_FLAG: flag }, outputDirectory: output, timeoutMs: 30000, killGraceMs: 100, logLimitBytes: 1024, storageBudgetBytes: 1024 * 1024, readSnapshot: () => { sampled += 1; writeFileSync(flag, ''); throw fsError('ETIMEDOUT'); } });
    assert.ok(sampled > 0);
    assert.equal(result.success, true);
    assert.equal(result.budget_exceeded, false);
    assert.equal(result.timed_out, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
