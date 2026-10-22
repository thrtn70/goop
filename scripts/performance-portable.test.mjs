import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { constants, existsSync, linkSync, mkdtempSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createOwnedGroupStopper, directoryBytes, readOwnedRegularFile, runBoundedProcess } from './performance-shared.mjs';
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

// Stands in for taskkill and the process table, given as [pid, parent pid].
// Console processes refuse a soft taskkill, as real ones do; a forced one with
// /t ends the pid and everything below it.
function fakeWindows(table) {
  const live = new Map(table), calls = [];
  const below = pid => { const ids = new Set([pid]); let changed = true; while (changed) { changed = false; for (const [id, parent] of live) if (ids.has(parent) && !ids.has(id)) { ids.add(id); changed = true; } } return ids; };
  const execFile = (command, args) => {
    if (command === 'powershell.exe') { calls.push('process table'); return `${[...live].map(([pid, parent]) => `${pid} ${parent}`).join('\r\n')}\r\n`; }
    const pid = Number(args[args.indexOf('/pid') + 1]), forced = args.includes('/f');
    calls.push(`taskkill ${pid}${forced ? ' /f' : ''}`);
    if (!forced || !live.has(pid)) throw Error('taskkill refused');
    for (const id of below(pid)) live.delete(id);
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
