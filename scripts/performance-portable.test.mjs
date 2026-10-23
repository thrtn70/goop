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

test('portable bounded runner terminates its descendant tree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'goop-portable-tree-'));
  const output = join(root, 'output');
  mkdirSync(output);
  const pidPath = join(root, 'descendant.pid');
  const runner = join(root, 'runner.cjs');
  const descendant = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidPath)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},10)`;
  writeFileSync(runner, `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>{},10);`);
  let descendantPid = null;
  try {
    const result = await runBoundedProcess({ command: process.execPath, args: [runner], outputDirectory: output, timeoutMs: 1500, killGraceMs: 100, logLimitBytes: 1024, storageBudgetBytes: 1024 * 1024 });
    descendantPid = Number(readFileSync(pidPath, 'utf8'));
    assert.equal(result.timed_out, true);
    assert.equal(result.aborted, false);
    if (process.platform === 'win32') {
      assert.throws(() => process.kill(descendantPid, 0), { code: 'ESRCH' });
    } else {
      let state = '';
      try { state = execFileSync('ps', ['-o', 'stat=', '-p', String(descendantPid)], { encoding: 'utf8' }).trim(); } catch { /* Gone. */ }
      assert.ok(state === '' || /[ZE]/.test(state), `descendant remained runnable with state ${state}`);
    }
  } finally {
    if (descendantPid) { try { process.kill(descendantPid, 'SIGKILL'); } catch { /* Already gone. */ } }
    rmSync(root, { recursive: true, force: true });
  }
});

// Child code that ignores TERM and then renames its pid into `path`, so the
// file existing means TERM can no longer stop that process.
const ignoreTermThenArm = path => `process.on('SIGTERM',()=>{});const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(`${path}.tmp`)},String(process.pid));fs.renameSync(${JSON.stringify(`${path}.tmp`)},${JSON.stringify(path)});`;
// A TERM-resistant process the run fails to kill outlives the test. Unless the
// test saw it gone, kill the pid in `armed` after the test, so such a regression
// fails at the test's timeout instead of leaving that process behind. Once it is
// gone the OS may reuse its pid, so the test marks it reaped.
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
// Polls for `path` at most 1000 times (5 s or more), so a process that never
// arms normally fails the caller's assertion well before the test's timeout.
async function waitForPath(path) {
  for (let polls = 0; polls < 1000 && !existsSync(path); polls++) await new Promise(resolve => setTimeout(resolve, 5));
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

test('an abort remains the stop cause when the deadline passes during descendant cleanup', { skip: process.platform === 'win32', timeout: 6000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'goop-portable-abort-deadline-'));
  const output = join(root, 'output'); mkdirSync(output);
  const runner = join(root, 'runner.cjs');
  const pidPath = join(root, 'descendant.pid');
  const descendant = `require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},10);`;
  writeFileSync(runner, `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'});setInterval(()=>{},10);`);
  const controller = new AbortController();
  let descendantPid = null, run;
  try {
    const launched = new Promise((resolve, reject) => {
      const deadline = setTimeout(() => { clearInterval(poll); reject(Error('descendant did not start')); }, 1000);
      const poll = setInterval(() => {
        if (!existsSync(pidPath)) return;
        clearInterval(poll); clearTimeout(deadline); resolve();
      }, 10);
    });
    run = runBoundedProcess({ command: process.execPath, args: [runner], outputDirectory: output, timeoutMs: 1500, killGraceMs: 2000, logLimitBytes: 1024, storageBudgetBytes: 1024 * 1024, abortSignal: controller.signal });
    await launched;
    descendantPid = Number(readFileSync(pidPath, 'utf8'));
    controller.abort();
    const result = await run;
    assert.equal(result.aborted, true);
    assert.equal(result.timed_out, false);
    assert.equal(result.success, false);
    let state = '';
    try { state = execFileSync('ps', ['-o', 'stat=', '-p', String(descendantPid)], { encoding: 'utf8' }).trim(); } catch { /* Gone. */ }
    assert.ok(state === '' || /[ZE]/.test(state), `descendant remained runnable with state ${state}`);
  } finally {
    controller.abort();
    if (run) await run.catch(() => {});
    if (descendantPid) { try { process.kill(descendantPid, 'SIGKILL'); } catch { /* Gone. */ } }
    rmSync(root, { recursive: true, force: true });
  }
});

test('termination signal wrapper waits for owned process cleanup', { skip: process.platform === 'win32', timeout: 5000 }, async () => {
  const root=mkdtempSync(join(tmpdir(),'goop-portable-signal-')),output=join(root,'output');mkdirSync(output);
  const pidPath=join(root,'descendant.pid'),resultPath=join(root,'result.json'),runner=join(root,'runner.cjs'),harness=join(root,'harness.mjs');
  const descendant=`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidPath)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},10)`;
  writeFileSync(runner,`require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>{},10);`);
  writeFileSync(harness,`import{writeFileSync}from'node:fs';import{runBoundedProcess,withTerminationSignals}from${JSON.stringify(pathToFileURL(join(import.meta.dirname,'performance-shared.mjs')).href)};await withTerminationSignals(async signal=>{const result=await runBoundedProcess({command:process.execPath,args:[${JSON.stringify(runner)}],outputDirectory:${JSON.stringify(output)},timeoutMs:5000,killGraceMs:100,logLimitBytes:1024,storageBudgetBytes:1048576,abortSignal:signal});writeFileSync(${JSON.stringify(resultPath)},JSON.stringify(result));});`);
  let descendantPid=null,child=null;
  try {
    child=spawn(process.execPath,[harness],{stdio:'ignore'});
    const deadline=Date.now()+2000;while(!existsSync(pidPath)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
    descendantPid=Number(readFileSync(pidPath,'utf8'));child.kill('SIGTERM');
    const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
    assert.deepEqual(exit,{code:143,signal:null});assert.equal(JSON.parse(readFileSync(resultPath,'utf8')).aborted,true);
    let state='';try{state=execFileSync('ps',['-o','stat=','-p',String(descendantPid)],{encoding:'utf8'}).trim();}catch{/* Gone. */}assert.ok(state===''||/[ZE]/.test(state),`descendant remained runnable with state ${state}`);
  } finally {if(child&&!child.killed){try{child.kill('SIGKILL');}catch{/* Gone. */}}if(descendantPid){try{process.kill(descendantPid,'SIGKILL');}catch{/* Gone. */}}rmSync(root,{recursive:true,force:true});}
});

test('portable bounded runner removes only newly owned staging after timeout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'goop-portable-staging-'));
  const output = join(root, 'output');
  mkdirSync(output);
  const preserved = join(output, '.goop-output-1-0');
  mkdirSync(preserved);
  const created = join(output, `.goop-output-${process.pid}-1`);
  const runner = join(root, 'runner.cjs');
  writeFileSync(runner, "require('node:fs').mkdirSync(process.env.GOOP_TEST_STAGING);setInterval(()=>{},10);");
  try {
    const result = await runBoundedProcess({ command: process.execPath, args: [runner], env: { ...process.env, GOOP_TEST_STAGING: created }, outputDirectory: output, timeoutMs: 1500, killGraceMs: 100, logLimitBytes: 1024, storageBudgetBytes: 1024 * 1024 });
    assert.equal(result.timed_out, true);
    assert.equal(result.removed_staging_directories, 1);
    assert.equal(result.cleanup_error, null);
    assert.equal(existsSync(created), false);
    assert.equal(existsSync(preserved), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('portable bounded runner reaps descendants after an ordinary parent failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'goop-portable-failure-tree-'));
  const output = join(root, 'output');
  mkdirSync(output);
  const pidPath = join(root, 'descendant.pid');
  const runner = join(root, 'runner.cjs');
  const descendant = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidPath)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},10)`;
  writeFileSync(runner, `const cp=require('node:child_process'),fs=require('node:fs');cp.spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});while(!fs.existsSync(${JSON.stringify(pidPath)})){};process.exit(1);`);
  let descendantPid = null;
  try {
    const result = await runBoundedProcess({ command: process.execPath, args: [runner], outputDirectory: output, timeoutMs: 3000, killGraceMs: 100, logLimitBytes: 1024, storageBudgetBytes: 1024 * 1024 });
    descendantPid = Number(readFileSync(pidPath, 'utf8'));
    assert.equal(result.exit_code, 1);
    assert.equal(result.success, false);
    if (process.platform === 'win32') assert.throws(() => process.kill(descendantPid, 0), { code: 'ESRCH' });
    else {
      let state = '';
      try { state = execFileSync('ps', ['-o', 'stat=', '-p', String(descendantPid)], { encoding: 'utf8' }).trim(); } catch { /* Gone. */ }
      assert.ok(state === '' || /[ZE]/.test(state), `descendant remained runnable with state ${state}`);
    }
  } finally {
    if (descendantPid) { try { process.kill(descendantPid, 'SIGKILL'); } catch { /* Already gone. */ } }
    rmSync(root, { recursive: true, force: true });
  }
});

test('portable bounded runner reaps descendants after a clean parent exit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'goop-portable-clean-tree-'));
  const output = join(root, 'output');mkdirSync(output);
  const pidPath = join(root, 'descendant.pid'), runner = join(root, 'runner.cjs');
  const descendant = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidPath)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},10)`;
  writeFileSync(runner, `const cp=require('node:child_process'),fs=require('node:fs');const child=cp.spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});child.unref();while(!fs.existsSync(${JSON.stringify(pidPath)})){};`);
  let descendantPid = null;
  try {
    const result = await runBoundedProcess({ command: process.execPath, args: [runner], outputDirectory: output, timeoutMs: 3000, killGraceMs: 100, logLimitBytes: 1024, storageBudgetBytes: 1024 * 1024 });
    descendantPid = Number(readFileSync(pidPath, 'utf8'));
    assert.equal(result.exit_code, 0);assert.equal(result.success, true);
    if (process.platform === 'win32') assert.throws(() => process.kill(descendantPid, 0), { code: 'ESRCH' });
    else { let state='';try{state=execFileSync('ps',['-o','stat=','-p',String(descendantPid)],{encoding:'utf8'}).trim();}catch{/* Gone. */}assert.ok(state===''||/[ZE]/.test(state),`descendant remained runnable with state ${state}`); }
  } finally { if(descendantPid){try{process.kill(descendantPid,'SIGKILL');}catch{/* Gone. */}}rmSync(root,{recursive:true,force:true}); }
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
    const result = await runBoundedProcess({ command: process.execPath, args: [runner], env: { ...process.env, GOOP_TEST_OUTPUT: output }, outputDirectory: output, timeoutMs: 3000, killGraceMs: 50, logLimitBytes: 128, storageBudgetBytes: 1024 });
    assert.equal(result.exit_code, 0);
    assert.equal(result.budget_exceeded, true);
    assert.equal(result.success, false);
    assert.ok(directoryBytes(output) + result.log_bytes_retained <= 1024);
    assert.equal(existsSync(join(output, 'large.bin')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('portable bounded runner rejects and removes child-created symlinks without following them', async () => {
  const root=mkdtempSync(join(tmpdir(),'goop-portable-symlink-')),output=join(root,'output');mkdirSync(output);
  const external=join(root,'external');writeFileSync(external,Buffer.alloc(10000));const runner=join(root,'runner.cjs');
  writeFileSync(runner,"require('node:fs').symlinkSync(process.env.GOOP_TEST_EXTERNAL,require('node:path').join(process.env.GOOP_TEST_OUTPUT,'link'));");
  try {
    const result=await runBoundedProcess({command:process.execPath,args:[runner],env:{...process.env,GOOP_TEST_EXTERNAL:external,GOOP_TEST_OUTPUT:output},outputDirectory:output,timeoutMs:3000,killGraceMs:50,logLimitBytes:128,storageBudgetBytes:1024});
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
