import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { directoryBytes, runBoundedProcess } from './performance-shared.mjs';
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
