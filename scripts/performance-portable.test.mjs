import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { chmodSync, constants, existsSync, linkSync, lstatSync, mkdtempSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createOwnedGroupStopper, directoryBytes, ownedLaunch, ownedRunPath, readOwnedRegularFile, runBoundedProcess } from './performance-shared.mjs';
import { directoryBytes as baselineDirectoryBytes } from './performance-baseline.mjs';
import { resolveRuntimeSidecars } from './performance-suite.mjs';
import { run } from './performance-baseline.mjs';

const require = createRequire(import.meta.url);

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

test('portable bounded runner keeps killing its group while the drain waits after the root exits', { skip: process.platform === 'win32', timeout: 30_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'goop-portable-drain-kill-')), output = join(root, 'output'); mkdirSync(output);
  const armed = join(root, 'armed'), runner = join(root, 'runner.cjs');
  const guard = killArmedAfter(t, root, armed);
  const dropped = [];
  let missedAfterReap = 0;
  // Every group signal is dropped until the root has been reaped, and the first
  // three after it too. Node reaps the root as it reports the exit, so only kills
  // that keep coming while the drain waits can reach the member holding the pipes.
  const killGroup = (pid, name) => {
    let reaped = false;
    try { process.kill(pid, 0); } catch (error) { reaped = error.code === 'ESRCH'; }
    if (!reaped || missedAfterReap++ < 3) { dropped.push(name); return; }
    process.kill(-pid, name);
  };
  // The member holds the run's pipes, and the runner exits once it has armed.
  writeFileSync(runner, `const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(`${recordPid(armed)}setInterval(()=>{},10)`)}],{stdio:'inherit'});const wait=setInterval(()=>{if(fs.existsSync(${JSON.stringify(armed)})){clearInterval(wait);process.exit(0);}},5);`);
  // The limit and the escalation grace end at once. Only the drain's grace is
  // real, and long enough that only a missing re-kill can run it out.
  const result = await runBoundedProcess({ command: process.execPath, args: [runner], outputDirectory: output, timeoutMs: 0, killGraceMs: 20_000, logLimitBytes: 1024, storageBudgetBytes: 1024 * 1024, samplingIntervalMs: 10, sleepMs: () => Promise.resolve(), killGroup });
  assert.deepEqual(dropped.slice(0, 2), ['SIGTERM', 'SIGKILL'], "the stop's own signals did not miss the member");
  assert.equal(result.stdio_error, null, 'the drain ran out its grace instead of the member being killed');
  const pid = Number(readFileSync(armed, 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 1, `invalid member pid ${pid}`);
  const state = await stateAfterKill(pid);
  assert.ok(state === '' || /[ZE]/.test(state), `member outlived the run with state ${state}`);
  guard.reaped = true;
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

// A grace the test ends by hand, so no wall clock decides the order. A wait
// nobody ends never settles, so these tests carry a timeout.
function heldGrace() { const waits = []; return { waits, sleep: ms => new Promise(resolve => { waits.push({ ms, resolve }); }) }; }
const turn = () => new Promise(resolve => setImmediate(resolve));
// Records each call a stop could name a pid with: process.kill, and every
// child_process function a taskkill or a process-table query would go through.
// syncBuiltinESMExports carries the stand-ins into the module's own imports.
const childProcess = require('node:child_process'), runnerNames = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync'];
const realPidCallers = { kill: process.kill, ...Object.fromEntries(runnerNames.map(name => [name, childProcess[name]])) };
function recordPidCalls(t) {
  const calls = [];
  process.kill = (...args) => { calls.push(['kill', ...args]); return true; };
  for (const name of runnerNames) childProcess[name] = (...args) => { calls.push([name, ...args]); throw Error(`a stop ran ${name}`); };
  syncBuiltinESMExports();
  t.after(() => { process.kill = realPidCallers.kill; for (const name of runnerNames) childProcess[name] = realPidCallers[name]; syncBuiltinESMExports(); });
  return calls;
}

// The launcher as a Windows stop sees it. Closing its stdin asks it to end its
// job, kill() is TerminateProcess on Node's own handle, and exit() is the
// launcher reporting, which it does only once its job is empty or closed.
function fakeLauncher(pid) {
  const launcher = Object.assign(new EventEmitter(), { pid, exitCode: null, signalCode: null, kills: 0, stopRequested: false });
  launcher.stdin = { end() { launcher.stopRequested = true; }, destroy() { launcher.stopRequested = true; } };
  launcher.kill = () => { launcher.kills += 1; return true; };
  launcher.exit = (code, signal = null) => { Object.assign(launcher, { exitCode: code, signalCode: signal }); launcher.emit('exit', code, signal); launcher.emit('close', code, signal); };
  return launcher;
}

test('a Windows stop ends the launcher job and never names a pid', { timeout: 10000 }, async t => {
  const pidCalls = recordPidCalls(t), grace = heldGrace(), launcher = fakeLauncher(100);
  const group = createOwnedGroupStopper(launcher, { killGraceMs: 250, sleep: grace.sleep, platform: 'win32' });
  const stopped = group.stop();
  assert.equal(group.stop(), stopped, 'a second stop must not signal again');
  grace.waits[0].resolve();
  await turn();
  assert.deepEqual(pidCalls, [], 'a Windows stop named a pid');
  assert.equal(launcher.stopRequested, true, 'the launcher was not asked to end its job');
  assert.equal(launcher.kills, 1, 'a launcher still running after the grace must be killed through Node');
  let settled = false;
  stopped.then(() => { settled = true; });
  await turn();
  assert.equal(settled, false, 'a forced stop settled before the launcher exited');
  launcher.exit(null, 'SIGKILL');
  await stopped;
  assert.deepEqual(pidCalls, []);
});

test('a forced Windows stop settles after a second grace even if the launcher never exits', { timeout: 10000 }, async t => {
  const pidCalls = recordPidCalls(t), grace = heldGrace(), launcher = fakeLauncher(100);
  const stopped = createOwnedGroupStopper(launcher, { killGraceMs: 250, sleep: grace.sleep, platform: 'win32' }).stop();
  grace.waits[0].resolve();
  await turn();
  assert.deepEqual(pidCalls, [], 'a Windows stop named a pid');
  assert.deepEqual(grace.waits.map(wait => wait.ms), [250, 250]);
  grace.waits[1].resolve();
  await stopped;
  assert.equal(launcher.kills, 1);
  assert.deepEqual(pidCalls, []);
});

test('a launcher that empties its job within the grace is left to exit', { timeout: 10000 }, async t => {
  const pidCalls = recordPidCalls(t), grace = heldGrace(), launcher = fakeLauncher(100);
  const stopped = createOwnedGroupStopper(launcher, { killGraceMs: 250, sleep: grace.sleep, platform: 'win32' }).stop();
  assert.deepEqual(pidCalls, [], 'a Windows stop named a pid');
  assert.equal(launcher.stopRequested, true, 'the launcher was not asked to end its job');
  launcher.exit(3);
  await stopped;
  // The grace can still end after the exit, when Node no longer holds the launcher.
  for (const wait of grace.waits) wait.resolve();
  await turn();
  assert.equal(launcher.kills, 0, 'a launcher Node no longer holds was killed');
  assert.equal(grace.waits.length, 1, 'a launcher that exited by itself was given a second grace');
  assert.deepEqual(pidCalls, []);
});

test('a Windows stop after the launcher exits does nothing, whoever holds its pid now', { timeout: 10000 }, async t => {
  // The launcher emptied its job before it exited, by itself or killed; its pid
  // may since belong to anyone.
  const pidCalls = recordPidCalls(t);
  for (const [code, signal] of [[0, null], [null, 'SIGKILL']]) {
    const grace = heldGrace(), launcher = fakeLauncher(100);
    const group = createOwnedGroupStopper(launcher, { killGraceMs: 250, sleep: grace.sleep, platform: 'win32' });
    launcher.exit(code, signal);
    const stopped = group.stop();
    assert.deepEqual(pidCalls, [], `the exited launcher's pid was named after ${signal ?? `exit ${code}`}`);
    assert.deepEqual(grace.waits, [], `nothing was left to stop after ${signal ?? `exit ${code}`}, yet the stop waits out the grace`);
    await stopped;
    assert.equal(launcher.stopRequested, false);
    assert.equal(launcher.kills, 0);
    assert.deepEqual(pidCalls, []);
  }
});

test('a Windows stop kills the launcher at once when the grace wait fails', { timeout: 10000 }, async t => {
  const pidCalls = recordPidCalls(t), launcher = fakeLauncher(100);
  await createOwnedGroupStopper(launcher, { killGraceMs: 250, sleep: () => Promise.reject(Error('no clock')), platform: 'win32' }).stop();
  assert.deepEqual(pidCalls, [], 'a Windows stop named a pid');
  assert.equal(launcher.kills, 1);
});

test('a Windows stop settles even when killing the launcher fails', { timeout: 10000 }, async t => {
  const pidCalls = recordPidCalls(t), launcher = fakeLauncher(100);
  launcher.kill = () => { launcher.kills += 1; throw Error('kill EINVAL'); };
  await createOwnedGroupStopper(launcher, { killGraceMs: 250, sleep: () => Promise.reject(Error('no clock')), platform: 'win32' }).stop();
  assert.deepEqual(pidCalls, [], 'a Windows stop named a pid');
  assert.equal(launcher.kills, 1);
});

test('owned launches run under time on macOS, in the launcher on Windows, and as given elsewhere', t => {
  const root = mkdtempSync(join(tmpdir(), 'goop-portable-launch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const launcher = join(root, 'goop-owned-run.exe'); writeFileSync(launcher, '');
  assert.deepEqual(ownedLaunch('/bin/x', ['a', 'b'], { platform: 'darwin' }), { command: '/usr/bin/time', args: ['-l', '/bin/x', 'a', 'b'], stdin: 'ignore' });
  assert.deepEqual(ownedLaunch('/bin/x', ['a'], { platform: 'linux' }), { command: '/bin/x', args: ['a'], stdin: 'ignore' });
  assert.deepEqual(ownedLaunch('C:\\x.exe', ['a'], { platform: 'win32', environment: { GOOP_OWNED_RUN: launcher } }), { command: launcher, args: ['C:\\x.exe', 'a'], stdin: 'pipe' });
  assert.throws(() => ownedLaunch('x', [], { platform: 'win32', environment: { GOOP_OWNED_RUN: join(root, 'missing.exe') } }), /owned-process launcher/);
  assert.throws(() => ownedLaunch('x', [], { platform: 'win32', environment: { GOOP_OWNED_RUN: root } }), /owned-process launcher/, 'a directory is not the launcher');
  const linked = join(root, 'linked.exe'); symlinkSync(launcher, linked);
  assert.throws(() => ownedLaunch('x', [], { platform: 'win32', environment: { GOOP_OWNED_RUN: linked } }), /owned-process launcher/, 'a link is not the launcher');
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
const recordedPid = path => { try { const pid = Number(readFileSync(path, 'utf8')); return Number.isInteger(pid) && pid > 1 ? pid : null; } catch { return null; } };
// Whether the process a pid file names is still running. A process nothing
// killed never leaves, so a bounded wait cannot turn a survivor into a pass.
// Once the process is seen gone its pid file goes too, so no cleanup can
// signal whoever reuses that pid.
async function outlives(path) {
  const pid = recordedPid(path);
  for (let polls = 0; running(pid) && polls < 250; polls++) await new Promise(resolve => setTimeout(resolve, 20));
  const alive = running(pid);
  if (!alive) rmSync(path, { force: true });
  return alive;
}
// Only a survivor still on record is killed, so a pid reused after a test saw
// its process gone is left alone.
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
  assert.equal(await outlives(armed), false, 'descendant outlived the run');
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
  assert.equal(await outlives(armed), false, 'root outlived the run');
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

// A grandchild that arms only once its own parent has exited, so no living
// process between it and the root is left to walk from. The middle process
// exits as soon as it has started it.
function orphanedGrandchildRunner(armed, middleDetached) {
  // The middle passes its own pid: by the time the grandchild runs, POSIX may
  // already have reparented it.
  const grandchild = `const parent=Number(process.argv[1]);process.on('SIGTERM',()=>{});const wait=setInterval(()=>{try{process.kill(parent,0);return;}catch(error){if(error.code!=='ESRCH')return;}clearInterval(wait);${publishPid(armed)}},5);setInterval(()=>{},1000);`;
  const middle = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)},String(process.pid)],{stdio:'ignore',detached:${windowsNativeChild}}).unref();`;
  return `const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(middle)}],{stdio:'ignore',detached:${middleDetached}}).unref();const wait=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(armed)}))return;clearInterval(wait);fs.writeFileSync(process.argv[3],JSON.stringify({success:true,process_ms:1}));},5);`;
}

test('single conversion reaps a grandchild whose detached parent exited first', { timeout: 60000 }, async t => {
  const [armed] = pidDirectory(t, 'grandchild.pid');
  const result = await portableConversion(t, orphanedGrandchildRunner(armed, windowsNativeChild), { timeoutMs: 30000, killGraceMs: 100 });
  assert.equal(result.success, true);
  const pid = recordedPid(armed);
  assert.ok(pid, 'grandchild never armed');
  assert.equal(await outlives(armed), false, 'grandchild outlived the run');
});

// On Windows the middle process sits in the root's own Node job, which lets
// its children leave it; they must still stay in the launcher's job.
test('single conversion reaps a grandchild whose parent in the root\'s Node job exited first', { timeout: 60000 }, async t => {
  const [armed] = pidDirectory(t, 'grandchild.pid');
  const result = await portableConversion(t, orphanedGrandchildRunner(armed, false), { timeoutMs: 30000, killGraceMs: 100 });
  assert.equal(result.success, true);
  const pid = recordedPid(armed);
  assert.ok(pid, 'grandchild never armed');
  assert.equal(await outlives(armed), false, 'grandchild outlived the run');
});

const windowsOnly = process.platform !== 'win32' && 'only Windows runs owned processes through the launcher';
async function armedWithin(path) {
  for (let polls = 0; !existsSync(path) && polls < 500; polls++) await new Promise(resolve => setTimeout(resolve, 20));
  return existsSync(path);
}

// POSIX has no group the kernel ends with the harness; withTerminationSignals
// covers a TERM there, and nothing can cover a KILL.
test('a Windows harness that dies mid-run takes its owned tree with it', { skip: windowsOnly, timeout: 60000 }, async t => {
  const [armed] = pidDirectory(t, 'descendant.pid');
  const root = mkdtempSync(join(tmpdir(), 'goop-portable-harness-death-')), output = join(root, 'output');
  mkdirSync(output); t.after(() => rmSync(root, { recursive: true, force: true }));
  const runner = join(root, 'runner.cjs'), harness = join(root, 'harness.mjs');
  writeFileSync(runner, `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(`${publishPid(armed)}setInterval(()=>{},1000);`)}],{stdio:'ignore',detached:true}).unref();setInterval(()=>{},1000);`);
  writeFileSync(harness, `import{runBoundedProcess}from${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'performance-shared.mjs')).href)};await runBoundedProcess({command:process.execPath,args:[${JSON.stringify(runner)}],outputDirectory:${JSON.stringify(output)},timeoutMs:30000,killGraceMs:100,logLimitBytes:1024,storageBudgetBytes:1048576});`);
  const child = spawn(process.execPath, [harness], { stdio: 'ignore' });
  const closed = new Promise(resolve => child.once('close', resolve));
  t.after(() => { child.kill(); });
  assert.ok(await armedWithin(armed), 'descendant never armed');
  child.kill();
  await closed;
  assert.equal(await outlives(armed), false, 'descendant outlived its harness');
});

test('a Windows run refuses to start without the owned-process launcher', { skip: windowsOnly, timeout: 60000 }, async t => {
  const saved = process.env.GOOP_OWNED_RUN, scratch = mkdtempSync(join(tmpdir(), 'goop-portable-no-launcher-'));
  t.after(() => { if (saved === undefined) delete process.env.GOOP_OWNED_RUN; else process.env.GOOP_OWNED_RUN = saved; rmSync(scratch, { recursive: true, force: true }); });
  process.env.GOOP_OWNED_RUN = join(scratch, 'missing.exe');
  const marker = join(scratch, 'ran'), output = join(scratch, 'output'), mark = `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran');`;
  mkdirSync(output);
  await assert.rejects(portableConversion(t, mark, { timeoutMs: 30000, killGraceMs: 100 }), /owned-process launcher/);
  await assert.rejects(runBoundedProcess({ command: process.execPath, args: ['-e', mark], outputDirectory: output, timeoutMs: 30000, killGraceMs: 100, logLimitBytes: 1024, storageBudgetBytes: 1024 * 1024 }), /owned-process launcher/);
  assert.equal(existsSync(marker), false, 'a command ran without the launcher');
});

// The launcher run directly. Its stdin stays open, as the harness keeps it,
// until a test closes it.
function launched(args) {
  const launcher = spawn(ownedRunPath(), args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  launcher.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise((resolve, reject) => { launcher.once('error', reject); launcher.once('close', code => resolve({ code, stderr })); });
  return { launcher, done };
}

test('the owned-process launcher passes the command exit code through', { skip: windowsOnly, timeout: 60000 }, async () => {
  assert.equal((await launched([process.execPath, '-e', 'process.exit(7)']).done).code, 7);
});

test('the owned-process launcher refuses to run without a command', { skip: windowsOnly, timeout: 60000 }, async () => {
  const { code, stderr } = await launched([]).done;
  assert.equal(code, 2);
  assert.match(stderr, /usage/);
});

test('the owned-process launcher ends what its command left running', { skip: windowsOnly, timeout: 60000 }, async t => {
  const [armed] = pidDirectory(t, 'descendant.pid');
  const command = `const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(`${publishPid(armed)}setInterval(()=>{},1000);`)}],{stdio:'ignore',detached:true}).unref();const wait=setInterval(()=>{if(fs.existsSync(${JSON.stringify(armed)}))clearInterval(wait);},5);`;
  assert.equal((await launched([process.execPath, '-e', command]).done).code, 0);
  const pid = recordedPid(armed);
  assert.ok(pid, 'descendant never armed');
  assert.equal(await outlives(armed), false, 'descendant outlived the launcher');
});

test('closing the owned-process launcher stdin ends its command and everything it started', { skip: windowsOnly, timeout: 60000 }, async t => {
  const [rootArmed, armed] = pidDirectory(t, 'root.pid', 'descendant.pid');
  const command = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(`${publishPid(armed)}setInterval(()=>{},1000);`)}],{stdio:'ignore',detached:true}).unref();${publishPid(rootArmed)}setInterval(()=>{},1000);`;
  const { launcher, done } = launched([process.execPath, '-e', command]);
  t.after(() => { launcher.kill(); });
  assert.ok(await armedWithin(rootArmed) && await armedWithin(armed), 'command or descendant never armed');
  launcher.stdin.destroy();
  assert.notEqual((await done).code, 0);
  assert.equal(await outlives(rootArmed), false, 'command outlived the stop');
  assert.equal(await outlives(armed), false, 'descendant outlived the stop');
});

// The harness's last resort: the launcher killed while its stdin stays open,
// so nothing but the job closing with it can end the command.
test('killing the owned-process launcher ends its command and everything it started', { skip: windowsOnly, timeout: 60000 }, async t => {
  const [rootArmed, armed] = pidDirectory(t, 'root.pid', 'descendant.pid');
  const command = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(`${publishPid(armed)}setInterval(()=>{},1000);`)}],{stdio:'ignore',detached:true}).unref();${publishPid(rootArmed)}setInterval(()=>{},1000);`;
  const { launcher, done } = launched([process.execPath, '-e', command]);
  // A command that survives keeps the launcher's stderr open, so wait for the
  // exit, not the close; `done` still reports a launcher that failed to start.
  const exited = new Promise(resolve => launcher.once('exit', resolve));
  t.after(() => { launcher.kill(); });
  assert.ok(await armedWithin(rootArmed) && await armedWithin(armed), 'command or descendant never armed');
  launcher.kill();
  await Promise.race([exited, done]);
  assert.equal(await outlives(rootArmed), false, 'command outlived the killed launcher');
  assert.equal(await outlives(armed), false, 'descendant outlived the killed launcher');
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
