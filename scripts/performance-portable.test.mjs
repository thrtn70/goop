import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { constants, existsSync, linkSync, mkdtempSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createOwnedGroupStopper, directoryBytes, ownedLaunch, ownedRunPath, readOwnedRegularFile, runBoundedProcess } from './performance-shared.mjs';
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

test('portable bounded runner aborts and reaps its descendant tree', async () => {
  const root=mkdtempSync(join(tmpdir(),'goop-portable-abort-')),output=join(root,'output');mkdirSync(output);
  const pidPath=join(root,'descendant.pid'),runner=join(root,'runner.cjs');
  const descendant=`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidPath)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},10)`;
  writeFileSync(runner,`require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>{},10);`);
  const controller=new AbortController();let descendantPid=null;
  try {
    setTimeout(()=>controller.abort(),150);
    const result=await runBoundedProcess({command:process.execPath,args:[runner],outputDirectory:output,timeoutMs:5000,killGraceMs:100,logLimitBytes:1024,storageBudgetBytes:1024*1024,abortSignal:controller.signal});
    descendantPid=Number(readFileSync(pidPath,'utf8'));
    assert.equal(result.aborted,true);assert.equal(result.success,false);assert.equal(result.timed_out,false);
    if(process.platform==='win32')assert.throws(()=>process.kill(descendantPid,0),{code:'ESRCH'});
    else {let state='';try{state=execFileSync('ps',['-o','stat=','-p',String(descendantPid)],{encoding:'utf8'}).trim();}catch{/* Gone. */}assert.ok(state===''||/[ZE]/.test(state),`descendant remained runnable with state ${state}`);}
  } finally {if(descendantPid){try{process.kill(descendantPid,'SIGKILL');}catch{/* Gone. */}}rmSync(root,{recursive:true,force:true});}
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
  writeFileSync(runner, `const cp=require('node:child_process'),fs=require('node:fs');cp.spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore',detached:${windowsNativeChild}});while(!fs.existsSync(${JSON.stringify(pidPath)})){};process.exit(1);`);
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
  writeFileSync(runner, `const cp=require('node:child_process'),fs=require('node:fs');const child=cp.spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore',detached:${windowsNativeChild}});child.unref();while(!fs.existsSync(${JSON.stringify(pidPath)})){};`);
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
