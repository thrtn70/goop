import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { directoryBytes, runBoundedProcess } from './performance-shared.mjs';
import { directoryBytes as baselineDirectoryBytes } from './performance-baseline.mjs';
import { resolveRuntimeSidecars } from './performance-suite.mjs';

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
  writeFileSync(runner, `const cp=require('node:child_process'),fs=require('node:fs');cp.spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});while(!fs.existsSync(${JSON.stringify(armed)})){};process.exit(1);`);
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
  writeFileSync(runner, `const cp=require('node:child_process'),fs=require('node:fs');const child=cp.spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});child.unref();while(!fs.existsSync(${JSON.stringify(armed)})){};`);
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
