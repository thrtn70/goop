import test from 'node:test';
import assert from 'node:assert/strict';
import { treeRss, summarize, outputName } from './performance-baseline.mjs';
test('aggregates only descendants in KiB',()=>assert.deepEqual(treeRss('10 1 100 parent\n11 10 200 ffmpeg\n12 11 50 child\n99 1 900 other',10),{rssKiB:350,children:2}));
test('failed operations excluded from throughput',()=>assert.deepEqual(summarize([{success:true,process_ms:20},{success:false,process_ms:1},{success:true,process_ms:40}]),{successes:2,failures:1,median_ms:30,min_ms:20,max_ms:40}));
test('output names differ for warmup and every repetition',()=>assert.equal(new Set([-1,0,1,2,3,4].map(i=>outputName('video',i,'mp4'))).size,6));
import {run, normalizeSuccess, directoryBytes} from './performance-baseline.mjs';
import {mkdtempSync,writeFileSync,chmodSync,rmSync,symlinkSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import { execFileSync } from 'node:child_process';
import { captureIdentity, runBoundedProcess, sha256Text, stableStringify, validateCapturedIdentity, writeJsonAtomic } from './performance-shared.mjs';
test('success requires clean exit and finite nonnegative duration',()=>{
 assert.equal(normalizeSuccess({success:true,process_ms:1},1,false),false);
 assert.equal(normalizeSuccess({success:true},0,false),false);
 assert.equal(normalizeSuccess({success:true,process_ms:-1},0,false),false);
 assert.equal(normalizeSuccess({success:true,process_ms:1},0,true),false);
});
async function fakeRunner(code,options={}){const dir=mkdtempSync(join(tmpdir(),'goop-bench-'));try{const file=join(dir,'runner');writeFileSync(file,`#!/usr/bin/env node\n${code}`);chmodSync(file,0o700);const runOptions={...options};if(options.probeJson){const probe=join(dir,'bound-ffprobe');writeFileSync(probe,`#!/bin/sh\n${options.probeDelay?'sleep '+options.probeDelay+'\n':''}printf '%s' '${JSON.stringify(options.probeJson)}'\n`);chmodSync(probe,0o700);runOptions.ffprobe=probe;delete runOptions.probeJson;delete runOptions.probeDelay;}return await run(file,dir,{output_path:join(dir,'result')},join(dir,'run'),runOptions);}finally{rmSync(dir,{recursive:true,force:true});}}
test('timeout escalates for a process ignoring TERM',async()=>{const start=performance.now();const result=await fakeRunner("process.on('SIGTERM',()=>{});setInterval(()=>{},10)",{timeoutMs:200,killGraceMs:30});assert.equal(result.success,false);assert.equal(result.timed_out,true);assert.ok(performance.now()-start<3000);});
test('single conversion abort reaps the owned process group',async()=>{const controller=new AbortController();setTimeout(()=>controller.abort(),100);const result=await fakeRunner("process.on('SIGTERM',()=>{});setInterval(()=>{},10)",{timeoutMs:5000,killGraceMs:30,abortSignal:controller.signal});assert.equal(result.success,false);assert.equal(result.aborted,true);assert.equal(result.timed_out,false);});
test('single conversion timeout kills a TERM-resistant descendant before returning',async()=>{
 const result=await fakeRunner("const fs=require('node:fs'),cp=require('node:child_process');const c=cp.spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},10)\"],{stdio:'ignore'});fs.writeFileSync(process.argv[4],JSON.stringify({success:true,process_ms:1,descendant_pid:c.pid}));setInterval(()=>{},10)",{timeoutMs:200,killGraceMs:50});
 let state='';try{state=execFileSync('/bin/ps',['-o','stat=','-p',String(result.descendant_pid)],{encoding:'utf8'}).trim();}catch{/* Gone. */}
 try{assert.ok(state===''||/[ZE]/.test(state),`descendant remained runnable with state ${state}`);}finally{try{process.kill(result.descendant_pid,'SIGKILL');}catch{/* Already gone. */}}
});
test('single conversion failure kills a TERM-resistant descendant before returning',async()=>{
 const result=await fakeRunner("const fs=require('node:fs'),cp=require('node:child_process');const c=cp.spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},10)\"],{stdio:'ignore'});fs.writeFileSync(process.argv[4],JSON.stringify({success:false,process_ms:1,descendant_pid:c.pid}));process.exitCode=1;",{timeoutMs:2000,killGraceMs:50});
 let state='';try{state=execFileSync('/bin/ps',['-o','stat=','-p',String(result.descendant_pid)],{encoding:'utf8'}).trim();}catch{/* Gone. */}
 try{assert.ok(state===''||/[ZE]/.test(state),`descendant remained runnable with state ${state}`);}finally{try{process.kill(result.descendant_pid,'SIGKILL');}catch{/* Already gone. */}}
});
test('single conversion clean exit kills a TERM-resistant descendant before returning',async()=>{
 const result=await fakeRunner("const fs=require('node:fs'),cp=require('node:child_process');const c=cp.spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},10)\"],{stdio:'ignore'});c.unref();fs.writeFileSync(process.argv[4],JSON.stringify({success:true,process_ms:1,descendant_pid:c.pid}));",{timeoutMs:2000,killGraceMs:50});
 let state='';try{state=execFileSync('/bin/ps',['-o','stat=','-p',String(result.descendant_pid)],{encoding:'utf8'}).trim();}catch{/* Gone. */}
 try{assert.equal(result.success,true);assert.ok(state===''||/[ZE]/.test(state),`descendant remained runnable with state ${state}`);}finally{try{process.kill(result.descendant_pid,'SIGKILL');}catch{/* Already gone. */}}
});
test('contradictory metrics cannot count as success',async()=>{const result=await fakeRunner("require('node:fs').writeFileSync(process.argv[4],JSON.stringify({success:true,process_ms:1}));process.exitCode=1;");assert.equal(result.success,false);});
test('single conversion cannot succeed without an independent probe',async()=>{const result=await fakeRunner("const fs=require('node:fs');const r=JSON.parse(fs.readFileSync(process.argv[3]));fs.writeFileSync(r.output_path,'x');fs.writeFileSync(process.argv[4],JSON.stringify({success:true,process_ms:1,result:{bytes:1}}));",{expectedOutput:{extension:'jpg',probe:'media',format_names:['image2'],required_streams:[{codec_type:'video',codec_name:'mjpeg'}]}});assert.equal(result.success,false);assert.equal(result.verification.checked,false);assert.match(result.verification.error,/ffprobe/i);});
test('single conversion rejects and removes a child-created symlink output',async()=>{const result=await fakeRunner("const fs=require('node:fs'),p=require('node:path');const r=JSON.parse(fs.readFileSync(process.argv[3]));fs.symlinkSync(p.join(process.argv[2],'runner'),r.output_path);fs.writeFileSync(process.argv[4],JSON.stringify({success:true,process_ms:1,result:{bytes:1}}));",{expectedOutput:{extension:'jpg',probe:'media',format_names:['image2'],required_streams:[{codec_type:'video',codec_name:'mjpeg'}]}});assert.equal(result.success,false);assert.match(result.output_error,/symbolic-link/i);assert.equal(result.removed_symlink_outputs,1);});
test('missed memory samples remain unresolved instead of becoming zero',async()=>{const result=await fakeRunner("require('node:fs').writeFileSync(process.argv[4],JSON.stringify({success:true,process_ms:1}));");assert.notEqual(result.sampled_tree_peak_KiB,0);assert.notEqual(result.time_peak_bytes,0);});
test('hardware intent reaches the driver and effective hardware stays evidence based',async()=>{
 const result=await fakeRunner("const fs=require('node:fs');fs.writeFileSync(process.argv[4],JSON.stringify({success:true,process_ms:1,hardware_intent:process.argv[5],encoder_observations:[]}));",{hardwareEnabled:true});
 assert.equal(result.success,true);
 assert.equal(result.hardware_intent,'true');
 assert.equal(result.effective_hardware,'unknown');
});
test('legacy hardware progress is retained but cannot prove completed hardware execution',async()=>{
 const result=await fakeRunner("const fs=require('node:fs');fs.writeFileSync(process.argv[4],JSON.stringify({success:true,process_ms:1,encoder_observations:[{encoder:'h264_videotoolbox'}]}));",{hardwareEnabled:true});
 assert.equal(result.effective_hardware,'unknown');
 assert.equal(result.effective_encoder,null);
 assert.deepEqual(result.encoder_observations,[{encoder:'h264_videotoolbox'}]);
});
test('final fallback observation cannot retain stale hardware evidence',async()=>{
 const result=await fakeRunner("const fs=require('node:fs');fs.writeFileSync(process.argv[4],JSON.stringify({success:true,process_ms:1,encoder_observations:[{encoder:'h264_videotoolbox'},{encoder:null}]}));",{hardwareEnabled:true});
 assert.equal(result.effective_hardware,'unknown');
 assert.equal(result.effective_encoder,null);
});
test('over-cap observation tail still classifies the final fallback',async()=>{
 const observations=Array.from({length:65},(_,percent)=>({encoder:'h264_videotoolbox',percent}));
 observations.push({encoder:null,percent:0});
 const retained=observations.slice(-64);
 const result=await fakeRunner(`const fs=require('node:fs');fs.writeFileSync(process.argv[4],JSON.stringify({success:true,process_ms:1,encoder_observations:${JSON.stringify(retained)}}));`,{hardwareEnabled:true});
 assert.equal(retained.length,64);
 assert.equal(result.effective_hardware,'unknown');
 assert.equal(result.effective_encoder,null);
});
test('effective execution summary proves explicit software and copy',async()=>{
 const software=await fakeRunner("const fs=require('node:fs');fs.writeFileSync(process.argv[4],JSON.stringify({success:true,process_ms:1,result:{video_execution:{requested:{kind:'encode'},encoder:'libx264'}}}));",{hardwareEnabled:true});
 assert.equal(software.effective_hardware,'software');
 const copy=await fakeRunner("const fs=require('node:fs');fs.writeFileSync(process.argv[4],JSON.stringify({success:true,process_ms:1,result:{video_execution:{requested:{kind:'copy'},encoder:null}}}));",{hardwareEnabled:true});
 assert.equal(copy.effective_hardware,'copy');
});
test('storage budget stops oversized output and logs are bounded',async()=>{const result=await fakeRunner("const fs=require('node:fs');const r=JSON.parse(fs.readFileSync(process.argv[3]));fs.writeFileSync(r.output_path,Buffer.alloc(10000));process.stdout.write('y'.repeat(10000));process.stderr.write('x'.repeat(10000));setInterval(()=>{},10)",{budgetBytes:4096,logLimitBytes:100,killGraceMs:30});assert.equal(result.budget_exceeded,true);assert.equal(result.success,false);assert.ok(result.log_bytes_retained<=100);});
test('storage budget catches an oversized output written immediately before exit',async()=>{const result=await fakeRunner("const fs=require('node:fs');const r=JSON.parse(fs.readFileSync(process.argv[3]));fs.writeFileSync(r.output_path,Buffer.alloc(10000));fs.writeFileSync(process.argv[4],JSON.stringify({success:true,process_ms:1,result:{bytes:10000}}));",{budgetBytes:4096,logLimitBytes:100,killGraceMs:30});assert.equal(result.budget_exceeded,true);assert.equal(result.success,false);});
test('directory byte count includes only files in suite',()=>{const dir=mkdtempSync(join(tmpdir(),'goop-bench-'));try{writeFileSync(join(dir,'one'),'1234');assert.equal(directoryBytes(dir),4);}finally{rmSync(dir,{recursive:true,force:true});}});
test('bounded atomic JSON refuses the temporary replacement high-water peak',()=>{const dir=mkdtempSync(join(tmpdir(),'goop-atomic-budget-'));try{const path=join(dir,'state.json');writeFileSync(path,'{"old":true}\n');const value={next:'x'.repeat(1000)};const nextBytes=Buffer.byteLength(`${JSON.stringify(value)}\n`);const budget=directoryBytes(dir)+nextBytes-1;assert.throws(()=>writeJsonAtomic(path,value,{budgetDirectory:dir,budgetBytes:budget}),/atomic.*budget/i);assert.equal(readFileSync(path,'utf8'),'{"old":true}\n');assert.deepEqual(readdirSync(dir),['state.json']);}finally{rmSync(dir,{recursive:true,force:true});}});
test('child lifetime excludes subsequent output verification',async()=>{
 const result=await fakeRunner("const fs=require('node:fs');const r=JSON.parse(fs.readFileSync(process.argv[3]));fs.writeFileSync(r.output_path,'x');fs.writeFileSync(process.argv[4],JSON.stringify({success:true,process_ms:1,result:{bytes:1}}));",{probeJson:{streams:[{codec_type:'video',codec_name:'mjpeg'}],format:{format_name:'image2'}},probeDelay:0.5,expectedOutput:{extension:'jpg',probe:'media',format_names:['image2'],required_streams:[{codec_type:'video',codec_name:'mjpeg'}]}});
 assert.equal(result.success,true);
 assert.ok(result.verification_ms >= 400);
 assert.ok(result.lifetime_ms < result.verification_ms);
});
test('single conversion rejects an independent probe with no usable stream',async()=>{
 const result=await fakeRunner("const fs=require('node:fs');const r=JSON.parse(fs.readFileSync(process.argv[3]));fs.writeFileSync(r.output_path,'x');fs.writeFileSync(process.argv[4],JSON.stringify({success:true,process_ms:1,result:{bytes:1}}));",{probeJson:{streams:[],format:{}},expectedOutput:{extension:'jpg',probe:'media',format_names:['image2'],required_streams:[{codec_type:'video',codec_name:'mjpeg'}]}});
 assert.equal(result.success,false);
 assert.match(result.verification.error,/usable media/i);
});
test('budget failure also removes new owned staging artifacts after metrics',async()=>{const result=await fakeRunner("const fs=require('node:fs'),p=require('node:path');const r=JSON.parse(fs.readFileSync(process.argv[3]));const d=p.join(p.dirname(r.output_path),'.goop-output-'+process.pid+'-0');fs.mkdirSync(d);fs.writeFileSync(p.join(d,'partial'),Buffer.alloc(10000));setInterval(()=>{},10)",{budgetBytes:4096,logLimitBytes:100,killGraceMs:30});assert.equal(result.budget_exceeded,true);assert.equal(result.removed_staging_directories,1);});

test('dirty source identity changes when already-dirty file content changes', () => {
 const root=mkdtempSync(join(tmpdir(),'goop-identity-'));
 try {
  execFileSync('git',['init','-q'],{cwd:root});
  execFileSync('git',['config','user.email','test@example.invalid'],{cwd:root});
  execFileSync('git',['config','user.name','Test'],{cwd:root});
  const tracked=join(root,'tracked.txt'),untracked=join(root,'untracked.txt');
  writeFileSync(tracked,'base');execFileSync('git',['add','tracked.txt'],{cwd:root});execFileSync('git',['commit','-qm','base'],{cwd:root});
  writeFileSync(tracked,'first');writeFileSync(untracked,'one');
  const firstIdentity=captureIdentity({cwd:root,manifestText:'{}',bindingsText:'{}',sidecars:{fixture:tracked}});const first=firstIdentity.source.dirty_digest;
  assert.equal(firstIdentity.sidecars.fixture.sha256,execFileSync('shasum',['-a','256',tracked],{encoding:'utf8'}).split(' ')[0]);
  writeFileSync(tracked,'second');writeFileSync(untracked,'two');
  const second=captureIdentity({cwd:root,manifestText:'{}',bindingsText:'{}'}).source.dirty_digest;
  assert.notEqual(first,second);
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('captured identity fails closed on unavailable toolchain or sidecar facts', () => {
 const identity={source:{head:'a'.repeat(40),tree:'b'.repeat(40),dirty_digest:'c'.repeat(64),dirty:false},manifest_sha256:'d'.repeat(64),bindings_sha256:'e'.repeat(64),executables:{engine:{path:'/engine',sha256:'f'.repeat(64)}},sidecars:{ffprobe:{path:'/ffprobe',sha256:'1'.repeat(64),version:'test'}},parameters:{test:true},toolchain:{node:'test',rustc:'test',cargo:'test'},machine:{platform:'darwin',arch:'arm64',os:'test',hardware_model:'test',power_source:'test',low_power_mode:'test',thermal:'test',disk_available_bytes:'test'}};
 assert.equal(validateCapturedIdentity(identity),identity);
 assert.equal(validateCapturedIdentity({...identity,machine:{...identity.machine,power_source:'unavailable',low_power_mode:'unavailable',thermal:'unavailable'}}).machine.thermal,'unavailable');
 assert.throws(()=>validateCapturedIdentity({...identity,toolchain:{...identity.toolchain,rustc:'unavailable'}}),/toolchain\.rustc/i);
 assert.throws(()=>validateCapturedIdentity({...identity,sidecars:{ffprobe:{...identity.sidecars.ffprobe,version:'unavailable'}}}),/sidecar version/i);
});

test('bounded process cleanup reaps a TERM-resistant descendant before returning', { skip: process.platform === 'win32' }, async () => {
 const root = mkdtempSync(join(tmpdir(), 'goop-process-tree-'));
 const output = join(root, 'output'); mkdirSync(output);
 const pidPath = join(root, 'descendant.pid');
 const runner = join(root, 'runner.cjs');
 const descendant = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidPath)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},10)`;
 writeFileSync(runner, `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>{},10);`);
 let descendantPid = null;
 try {
  const result = await runBoundedProcess({ command: process.execPath, args: [runner], outputDirectory: output, timeoutMs: 1000, killGraceMs: 50, logLimitBytes: 1024, storageBudgetBytes: 1024 * 1024 });
  descendantPid = Number(readFileSync(pidPath, 'utf8'));
  assert.equal(result.timed_out, true);
  let state = '';
  try { state = execFileSync('/bin/ps', ['-o', 'stat=', '-p', String(descendantPid)], { encoding: 'utf8' }).trim(); } catch { /* Gone. */ }
  assert.ok(state === '' || /[ZE]/.test(state), `descendant remained runnable with state ${state}`);
 } finally {
  if (descendantPid) { try { process.kill(descendantPid, 'SIGKILL'); } catch { /* Already reaped. */ } }
  rmSync(root, { recursive: true, force: true });
 }
});

import { existsSync, readFileSync, mkdirSync, statSync } from 'node:fs';
import {
 parseManifest,
 validateBindings,
 validateEffectiveExecution,
 PERFORMANCE_LIMITATIONS,
} from './performance-manifest.mjs';
import {
 buildRunPlan,
 executeWorkloadAdapter,
 resolveBundledSidecar,
 runPerformanceSuite,
 summarizeSuite,
 normalSuite,
 validateWorkloadMetrics,
 verifyBatchOutputs,
} from './performance-suite.mjs';
import {
 pairedExecutionOrder,
 comparePairedSummaries,
 collectPairedSamples,
 runPairedPlan,
 validatePairedVerification,
} from './performance-comparison.mjs';

const validManifest = () => ({
 schema_version: 1,
 suite_id: 'synthetic-perf-01a',
 limitations: [...PERFORMANCE_LIMITATIONS],
 defaults: {
  warmups: 1,
  repetitions: 5,
  timeout_ms: 2000,
  suite_timeout_ms: 60000,
  log_limit_bytes: 65536,
  suite_log_limit_bytes: 1048576,
  storage_budget_bytes: 1048576,
  suite_storage_budget_bytes: 16777216,
 },
 fixture_roles: ['raw_48mp', 'inspect_mixed'],
 workloads: [
  {
   id: 'raw-single',
   adapter: 'single_conversion',
   fixture_role: 'raw_48mp',
   request: { target: 'jpeg', quality_preset: null, resolution_cap: null, gif_options: null, compress_mode: null, batch_id: null, metadata_policy: 'preserve', subtitle: null },
   expected_output: { extension: 'jpg', probe: 'media', format_names: ['image2'], required_streams: [{ codec_type: 'video', codec_name: 'mjpeg' }] },
  },
  {
   id: 'inspect-burst',
   adapter: 'workload',
   mode: 'inspection_burst',
   fixture_roles: ['inspect_mixed'],
   source_count: 32,
   expected_output: { kind: 'metrics_only' },
  },
  {
   id: 'queue-1000',
   adapter: 'startup',
   jobs: 1000,
   expected_output: { kind: 'startup_marker' },
  },
 ],
});

test('strict manifest round-trips and rejects unknown fields', () => {
 const manifest = validManifest();
 assert.deepEqual(parseManifest(JSON.stringify(manifest)), manifest);
 assert.throws(() => parseManifest(JSON.stringify({ ...manifest, surprise: true })), /unknown field.*surprise/i);
 assert.throws(() => parseManifest(JSON.stringify({ ...manifest, schema_version: 2 })), /schema_version/i);
});

test('tracked real-suite manifest covers the approved PERF-01A matrix', () => {
 const manifest = parseManifest(readFileSync(new URL('./performance-suite.example.json', import.meta.url), 'utf8'));
 assert.deepEqual(manifest.fixture_roles, ['raw_48mp', 'inspect_image', 'inspect_video', 'video_1080_encode', 'video_4k_encode', 'video_h264_copy', 'video_hevc_copy']);
 assert.deepEqual(manifest.workloads.map(workload => workload.id), [
  'raw-single', 'raw-batch-4', 'inspection-single', 'inspection-burst-32',
  'video-1080-software-encode', 'video-4k-software-encode', 'video-h264-copy', 'video-hevc-copy',
  'queue-0', 'queue-200', 'queue-1000',
 ]);
 assert.equal(manifest.workloads.find(workload => workload.id === 'raw-batch-4').items.length, 4);
 const burst=manifest.workloads.find(workload => workload.id === 'inspection-burst-32');
 assert.equal(burst.source_count, 32);
 assert.deepEqual(burst.fixture_roles, Array.from({length:32},(_,index)=>index%2===0?'inspect_image':'inspect_video'));
});

test('manifest rejects duplicate IDs, unsupported modes, unsafe limits, and missing checks', () => {
 const duplicate = validManifest();
 duplicate.workloads.push({ ...duplicate.workloads[0] });
 assert.throws(() => parseManifest(JSON.stringify(duplicate)), /duplicate workload id/i);
 const mode = validManifest();
 mode.workloads[1].mode = 'mystery';
 assert.throws(() => parseManifest(JSON.stringify(mode)), /mode/i);
 const count = validManifest();
 count.workloads[1].source_count = 0;
 assert.throws(() => parseManifest(JSON.stringify(count)), /source_count/i);
 const concurrency = validManifest();
 concurrency.workloads[1].concurrency = 1;
 assert.throws(() => parseManifest(JSON.stringify(concurrency)), /unknown field.*concurrency/i);
 const repeat = validManifest();
 repeat.defaults.repetitions = 0;
 assert.throws(() => parseManifest(JSON.stringify(repeat)), /repetitions/i);
 const timeout = validManifest();
 timeout.defaults.timeout_ms = -1;
 assert.throws(() => parseManifest(JSON.stringify(timeout)), /timeout_ms/i);
 const budget = validManifest();
 budget.defaults.storage_budget_bytes = 0;
 assert.throws(() => parseManifest(JSON.stringify(budget)), /storage_budget_bytes/i);
 const output = validManifest();
 delete output.workloads[0].expected_output;
 assert.throws(() => parseManifest(JSON.stringify(output)), /expected_output/i);
 const escaped = validManifest();
 escaped.workloads[0].id = '../escape';
 assert.throws(() => parseManifest(JSON.stringify(escaped)), /id/i);
 const unknownRequest = validManifest();
 unknownRequest.workloads[0].request.future_control = true;
 assert.throws(() => parseManifest(JSON.stringify(unknownRequest)), /unknown field.*future_control/i);
 const escapingExtension = validManifest();
 escapingExtension.workloads[0].expected_output.extension = '../../../../escape';
 assert.throws(() => parseManifest(JSON.stringify(escapingExtension)), /extension/i);
 const wrongShape = validManifest();
 wrongShape.workloads[2].expected_output = { kind: 'metrics_only' };
 assert.throws(() => parseManifest(JSON.stringify(wrongShape)), /kind/i);
 const mismatchedTarget = validManifest();
 mismatchedTarget.workloads[0].expected_output.extension = 'mp4';
 assert.throws(() => parseManifest(JSON.stringify(mismatchedTarget)), /target.*extension/i);
 const missingCodec = validManifest();
 missingCodec.workloads[0].expected_output.required_streams = [];
 assert.throws(() => parseManifest(JSON.stringify(missingCodec)), /required_streams/i);
});

test('effective execution must prove copy or the requested software encoder', () => {
 assert.equal(validateEffectiveExecution({requested:{kind:'copy'},encoder:null},{video_options:{kind:'copy'}}),true);
 assert.equal(validateEffectiveExecution({requested:{kind:'encode',codec:'h264',processor:'software'},encoder:'libx264'},{video_options:{kind:'encode',codec:'h264',processor:'software'}}),true);
 assert.throws(()=>validateEffectiveExecution({requested:{kind:'encode',codec:'h264',processor:'software'},encoder:'h264_videotoolbox'},{video_options:{kind:'encode',codec:'h264',processor:'software'}}),/hardware encoder/i);
 assert.throws(()=>validateEffectiveExecution(null,{video_options:{kind:'copy'}}),/requested mode/i);
});

test('bindings require every role, absolute immutable sources, bytes, and sha256', async () => {
 const root = mkdtempSync(join(tmpdir(), 'goop-manifest-'));
 try {
  const raw = join(root, 'raw.bin'), inspect = join(root, 'inspect.bin');
  writeFileSync(raw, 'raw'); writeFileSync(inspect, 'inspect');
  const crypto = await import('node:crypto');
  const sha = path => crypto.createHash('sha256').update(readFileSync(path)).digest('hex');
  const binding = { schema_version: 1, fixtures: {
   raw_48mp: { path: raw, sha256: sha(raw), bytes: 3 },
   inspect_mixed: { path: inspect, sha256: sha(inspect), bytes: 7 },
  } };
  assert.deepEqual(Object.keys(validateBindings(validManifest(), binding)).sort(), ['inspect_mixed', 'raw_48mp']);
  assert.throws(() => validateBindings(validManifest(), { ...binding, extra: true }), /unknown field.*extra/i);
  const missing = structuredClone(binding); delete missing.fixtures.inspect_mixed;
  assert.throws(() => validateBindings(validManifest(), missing), /inspect_mixed/i);
  const relative = structuredClone(binding); relative.fixtures.raw_48mp.path = 'raw.bin';
  assert.throws(() => validateBindings(validManifest(), relative), /absolute/i);
  const changed = structuredClone(binding); changed.fixtures.raw_48mp.sha256 = '0'.repeat(64);
  assert.throws(() => validateBindings(validManifest(), changed), /sha-256 mismatch/i);
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test('run plan is deterministic, unique, and excludes one warmup from summaries', () => {
 const plan = buildRunPlan(validManifest());
 assert.equal(plan.length, 18);
 assert.equal(plan.filter(run => run.phase === 'warmup').length, 3);
 assert.equal(plan.filter(run => run.phase === 'measured').length, 15);
 assert.equal(new Set(plan.map(run => run.destination)).size, plan.length);
 assert.deepEqual(plan, buildRunPlan(validManifest()));
});

test('suite summary retains available duration, memory, and output evidence without fabricating zeros', () => {
 const manifest = { workloads: [{ id: 'one' }] };
 const samples = [
  { workload_id: 'one', phase: 'measured', status: 'success', result: { process_ms: 10, sampled_tree_peak_KiB: null, time_peak_bytes: null, verification: { output_bytes: 5 } } },
  { workload_id: 'one', phase: 'measured', status: 'success', result: { process_ms: 20, process: { sampled_tree_peak_KiB: 100, time_peak_bytes: 200 }, verification: { output_bytes: 7 } } },
 ];
 const summary = summarizeSuite(samples, manifest).workloads.one;
 assert.equal(summary.duration_ms.median, 15);
 assert.deepEqual(summary.sampled_tree_peak_KiB, { median: 100, min: 100, max: 100, measured: 1, not_measured: 1 });
 assert.deepEqual(summary.time_peak_bytes, { median: 200, min: 200, max: 200, measured: 1, not_measured: 1 });
 assert.deepEqual(summary.output_bytes, { median: 6, min: 5, max: 7, measured: 2, not_measured: 0 });
 assert.deepEqual(summary.phase_timings_ms.process_ms, { median: 15, min: 10, max: 20, measured: 2, not_measured: 0 });
 assert.deepEqual(summary.phase_timings_ms.wall_ms, { median: null, min: null, max: null, measured: 0, not_measured: 2 });
 assert.equal(summary.item_phase_timings_ms, null);
});

test('suite summary reports workload adapter phases without inventing missing values', () => {
 const manifest = { workloads: [{ id: 'batch' }] };
 const samples = [{ workload_id: 'batch', phase: 'measured', status: 'success', result: { aggregate_ms: 9, wall_ms: 12, encoder_detection_ms: 2, items: [
  { elapsed_ms: 4, source_fingerprint_before_ms: 0.5, source_fingerprint_after_ms: 0.6, admission_ms: 1, process_ms: 3, probe_ms: null },
  { elapsed_ms: 6, source_fingerprint_before_ms: 0.7, source_fingerprint_after_ms: 0.8, admission_ms: 2, process_ms: 4, probe_ms: null },
 ] } }];
 const summary = summarizeSuite(samples, manifest).workloads.batch;
 assert.equal(summary.phase_timings_ms.aggregate_ms.median, 9);
 assert.equal(summary.phase_timings_ms.wall_ms.median, 12);
 assert.deepEqual(summary.item_phase_timings_ms.process_ms, { median: 3.5, min: 3, max: 4, measured: 2, not_measured: 0 });
 assert.deepEqual(summary.item_phase_timings_ms.probe_ms, { median: null, min: null, max: null, measured: 0, not_measured: 2 });
});

test('ledger compaction preserves truthful summaries for oversized valid results', async () => {
 const root=mkdtempSync(join(tmpdir(),'goop-suite-compaction-'));
 try {
  const raw=join(root,'raw.bin'),inspect=join(root,'inspect.bin');writeFileSync(raw,'raw');writeFileSync(inspect,'inspect');
  const crypto=await import('node:crypto');const sha=path=>crypto.createHash('sha256').update(readFileSync(path)).digest('hex');
  const manifest=validManifest();manifest.defaults.repetitions=1;manifest.workloads=[manifest.workloads[1]];
  const bindings=validateBindings(manifest,{schema_version:1,fixtures:{raw_48mp:{path:raw,sha256:sha(raw),bytes:3},inspect_mixed:{path:inspect,sha256:sha(inspect),bytes:7}}});
  const state=await runPerformanceSuite({manifest,bindings,prevalidatedBindings:true,outputDirectory:join(root,'output'),execute:async()=>({success:true,process_ms:10,process:{sampled_tree_peak_KiB:123,time_peak_bytes:456},verification:{output_bytes:7},items:[{probe_ms:2,elapsed_ms:3,source_fingerprint_before_ms:0.1,source_fingerprint_after_ms:0.2,admission_ms:null,process_ms:null}],padding:'x'.repeat(300000)})});
  assert.equal(state.samples.every(sample=>sample.result.evidence_compacted===true),true);
  for(const sample of state.samples){const full=join(root,'output',sample.result.full_result_path);assert.equal(existsSync(full),true);assert.equal(sha(full),sample.result.full_result_sha256);assert.equal(statSync(full).size,sample.result.full_result_bytes);assert.equal(sample.result.full_result_retained,true);}
  const summary=state.summary.workloads['inspect-burst'];assert.equal(summary.duration_ms.median,10);assert.equal(summary.sampled_tree_peak_KiB.median,123);assert.equal(summary.time_peak_bytes.median,456);assert.equal(summary.output_bytes.median,7);assert.equal(summary.item_phase_timings_ms.probe_ms.median,2);
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('compact ledger serialization keeps adversarial nested arrays within the declared suite bound', async () => {
 const root=mkdtempSync(join(tmpdir(),'goop-suite-ledger-bound-'));
 try {
  const raw=join(root,'raw.bin'),inspect=join(root,'inspect.bin');writeFileSync(raw,'raw');writeFileSync(inspect,'inspect');
  const crypto=await import('node:crypto');const sha=path=>crypto.createHash('sha256').update(readFileSync(path)).digest('hex');
  const manifest=validManifest();manifest.defaults.repetitions=1;manifest.defaults.suite_storage_budget_bytes=1300000;manifest.workloads=[manifest.workloads[0]];
  const bindings=validateBindings(manifest,{schema_version:1,fixtures:{raw_48mp:{path:raw,sha256:sha(raw),bytes:3},inspect_mixed:{path:inspect,sha256:sha(inspect),bytes:7}}});
  const output=join(root,'output');await runPerformanceSuite({manifest,bindings,prevalidatedBindings:true,outputDirectory:output,execute:async()=>({success:true,process_ms:1,padding:Array(80000).fill(0)})});
  assert.ok(directoryBytes(output)<=manifest.defaults.suite_storage_budget_bytes);
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('compact paired ledger serialization keeps nested arrays within its declared bound', async () => {
 const root=mkdtempSync(join(tmpdir(),'goop-paired-ledger-bound-')),output=join(root,'output'),budget=1048576;
 try {
  const state=await collectPairedSamples({workloadIds:['copy'],repetitions:2,outputDirectory:output,totalLimits:{suite_timeout_ms:10000,suite_log_limit_bytes:1048576,suite_storage_budget_bytes:budget},execute:async()=>({success:true,process_ms:1,padding:Array(20000).fill(0)})});
  assert.equal(state.status,'complete');assert.ok(directoryBytes(output)<=budget);
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('persisted full results remain inside the per-run storage bound', async () => {
 const root=mkdtempSync(join(tmpdir(),'goop-full-result-run-bound-'));
 try {
  const raw=join(root,'raw.bin'),inspect=join(root,'inspect.bin');writeFileSync(raw,'raw');writeFileSync(inspect,'inspect');const crypto=await import('node:crypto');const sha=path=>crypto.createHash('sha256').update(readFileSync(path)).digest('hex');
  const manifest=validManifest();manifest.defaults.repetitions=1;manifest.defaults.storage_budget_bytes=1024;manifest.workloads=[manifest.workloads[0]];
  const bindings=validateBindings(manifest,{schema_version:1,fixtures:{raw_48mp:{path:raw,sha256:sha(raw),bytes:3},inspect_mixed:{path:inspect,sha256:sha(inspect),bytes:7}}});const output=join(root,'output');
  await assert.rejects(runPerformanceSuite({manifest,bindings,prevalidatedBindings:true,outputDirectory:output,execute:async()=>({success:true,process_ms:1,padding:'x'.repeat(300000)})}),/workload storage budget/i);
  const state=JSON.parse(readFileSync(join(output,'suite-state.json'),'utf8'));assert.equal(state.samples.length,1);assert.equal(state.samples[0].result.budget_exceeded,true);assert.equal(state.samples[0].result.full_result_retained,false);assert.equal(existsSync(join(output,'raw-single','warmup-0')),false);
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('paired order warms both revisions before alternating measured repetitions', () => {
 const order=pairedExecutionOrder(['raw-single'],4);
 assert.deepEqual(order.map(v=>`${v.phase}:${v.revision}`),['warmup:baseline','warmup:candidate','measured:baseline','measured:candidate','measured:candidate','measured:baseline','measured:baseline','measured:candidate','measured:candidate','measured:baseline']);
 assert.deepEqual(order.slice(0,2).map(v=>v.repetition),[null,null]);
});

test('paired comparison requires equivalent identity and flags over ten percent without failing', () => {
 const identity = { source:{head:'a'.repeat(40),tree:'b'.repeat(40),dirty_digest:'c'.repeat(64),dirty:false},manifest_sha256: 'a'.repeat(64), bindings_sha256: 'b'.repeat(64), executables:{engine:{path:'/engine',sha256:'d'.repeat(64)}},toolchain: { node:'test',rustc: 'test',cargo:'test' }, sidecars: { ffprobe:{path:'/ffprobe',sha256:'e'.repeat(64),version:'test'} }, parameters: { hardware_enabled: false }, machine: { platform: 'darwin', arch: 'arm64', os:'test',hardware_model: 'Mac',power_source:'test',low_power_mode:'test',thermal:'test',disk_available_bytes:'test' } };
 const result = comparePairedSummaries({ workload_id: 'copy', repetitions: 5, identity, samples: [10, 10, 10, 10, 10] }, { workload_id: 'copy', repetitions: 5, identity, samples: [12, 12, 12, 12, 12] });
 assert.equal(result.percent_change, 20);
 assert.equal(result.investigation_required, true);
 assert.equal(result.success, true);
 assert.throws(() => comparePairedSummaries({ workload_id: 'copy', repetitions: 1, identity, samples: [10] }, { workload_id: 'copy', repetitions: 1, identity: { ...identity, machine: { ...identity.machine, hardware_model: 'other' } }, samples: [10] }), /identity mismatch/i);
 assert.throws(() => comparePairedSummaries({ workload_id: 'copy', repetitions: 1, identity, samples: [10] }, { workload_id: 'encode', repetitions: 1, identity, samples: [10] }), /workload/i);
 assert.throws(() => comparePairedSummaries({ workload_id: 'copy', repetitions: 2, identity, samples: [10, 11] }, { workload_id: 'copy', repetitions: 1, identity, samples: [10] }), /repetitions|count/i);
});

test('paired collector executes the frozen alternating order and retains failures', async () => {
 const root = mkdtempSync(join(tmpdir(), 'goop-paired-'));
 const visited = [];
 try {
  const result = await collectPairedSamples({ workloadIds: ['copy'], repetitions: 2, outputDirectory: join(root, 'output'), execute: async step => {
   visited.push(`${step.phase}:${step.repetition}:${step.revision}`);
   return { success: step.revision === 'baseline', process_ms: 1 };
  } });
  assert.deepEqual(visited, ['warmup:null:baseline','warmup:null:candidate','measured:0:baseline','measured:0:candidate','measured:1:candidate','measured:1:baseline']);
  assert.equal(result.samples.length, 6);
  assert.equal(result.samples.filter(sample => sample.status === 'excluded').length, 1);
  assert.equal(result.samples.filter(sample => sample.status === 'failed').length, 3);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'output', 'paired-state.json'), 'utf8')), result);
  await assert.rejects(collectPairedSamples({ workloadIds: ['copy'], repetitions: 1, outputDirectory: join(root, 'output'), execute: async () => ({ success: true }) }), /must be new/i);
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test('paired plan is runnable and writes bound comparisons', async () => {
 const root = mkdtempSync(join(tmpdir(), 'goop-paired-plan-'));
 try {
  const contractFacts={expected_output:{extension:'mp4',probe:'media',format_names:['mov','mp4'],required_streams:[{codec_type:'video',codec_name:'h264'}]},request:{video_options:{kind:'copy'}}};
  const contractSha256=sha256Text(stableStringify(contractFacts));
  const runner = join(root, 'runner.cjs');
  writeFileSync(runner, `const fs=require('node:fs');const value=process.env.GOOP_PERF_REVISION==='baseline'?10:12;fs.writeFileSync(process.env.GOOP_PERF_RESULT_PATH,JSON.stringify({success:true,process_ms:value,workload_id:process.env.GOOP_PERF_WORKLOAD_ID,revision:process.env.GOOP_PERF_REVISION,verification:{success:true,contract_sha256:${JSON.stringify(contractSha256)},kind:'media',contract_facts:${JSON.stringify(contractFacts)},evidence:{output_bytes:1,probe:{streams:[{codec_type:'video',codec_name:'h264'}],format:{format_name:'mov,mp4'}},effective_execution:{requested:{kind:'copy'},encoder:null}}}}));`);
  const crypto = await import('node:crypto');
  const commandSha256 = crypto.createHash('sha256').update(readFileSync(process.execPath)).digest('hex');
  const identity = { source:{head:'a'.repeat(40),tree:'b'.repeat(40),dirty_digest:'c'.repeat(64),dirty:false},manifest_sha256: 'a'.repeat(64), bindings_sha256: 'b'.repeat(64), executables:{engine:{path:process.execPath,sha256:commandSha256}},toolchain: { node: process.version,rustc:'test',cargo:'test' }, sidecars: {ffprobe:{path:'/ffprobe',sha256:'d'.repeat(64),version:'test'}}, parameters: { test: true }, machine: { platform: process.platform, arch: process.arch, os:'test',hardware_model:'test',power_source:'test',low_power_mode:'test',thermal:'test',disk_available_bytes:'test' } };
  const plan = { schema_version: 1, repetitions: 2, workload_ids: ['copy'], workload_contracts:{copy:{contract_sha256:contractSha256,evidence_kind:'media',expected_facts:contractFacts}}, limits: { timeout_ms: 2000, suite_timeout_ms:10000, log_limit_bytes:65536, suite_log_limit_bytes:1048576, storage_budget_bytes:1048576, suite_storage_budget_bytes:4194304 }, revisions: {
   baseline: { command: process.execPath, command_sha256: commandSha256, args: [runner], identity },
   candidate: { command: process.execPath, command_sha256: commandSha256, args: [runner], identity },
  } };
  const result = await runPairedPlan({ plan, outputDirectory: join(root, 'output') });
  assert.equal(result.state.status, 'complete');
  assert.deepEqual(result.state.samples.map(sample => `${sample.phase}:${sample.repetition}:${sample.revision}`), ['warmup:null:baseline','warmup:null:candidate','measured:0:baseline','measured:0:candidate','measured:1:candidate','measured:1:baseline']);
  assert.deepEqual(result.state.samples.slice(0,2).map(sample=>sample.status),['excluded','excluded']);
  assert.equal(result.comparisons.copy.percent_change, 20);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'output', 'comparison.json'), 'utf8')), result.comparisons);
  await assert.rejects(runPairedPlan({ plan: { ...plan, workload_ids: ['../escape'] }, outputDirectory: join(root, 'escape') }), /workload.*identifier/i);
  await assert.rejects(runPairedPlan({ plan: { ...plan, workload_ids: ['copy', 'copy'] }, outputDirectory: join(root, 'duplicate') }), /duplicate workload/i);
  await assert.rejects(runPairedPlan({ plan: { ...plan, revisions: { ...plan.revisions, baseline: { ...plan.revisions.baseline, command_sha256: '0'.repeat(64) } } }, outputDirectory: join(root, 'wrong-command') }), /command sha-256/i);
  await assert.rejects(runPairedPlan({ plan: { ...plan, revisions: { ...plan.revisions, baseline: { ...plan.revisions.baseline, identity: {} } } }, outputDirectory: join(root, 'empty-identity') }), /identity/i);
  const linkedCommand=join(root,'node-link');symlinkSync(process.execPath,linkedCommand);
  await assert.rejects(runPairedPlan({plan:{...plan,revisions:{...plan.revisions,baseline:{...plan.revisions.baseline,command:linkedCommand},candidate:{...plan.revisions.candidate,command:linkedCommand}}},outputDirectory:join(root,'linked-command')}),/command sha-256/i);
  const noEvidenceRunner=join(root,'no-evidence.cjs');writeFileSync(noEvidenceRunner,"require('node:fs').writeFileSync(process.env.GOOP_PERF_RESULT_PATH,JSON.stringify({success:true,process_ms:1}))");
  await assert.rejects(runPairedPlan({plan:{...plan,repetitions:1,revisions:{...plan.revisions,baseline:{...plan.revisions.baseline,args:[noEvidenceRunner]},candidate:{...plan.revisions.candidate,args:[noEvidenceRunner]}}},outputDirectory:join(root,'no-evidence')}),/paired execution failed/i);
  const noisyNoResult=join(root,'noisy-no-result.cjs');writeFileSync(noisyNoResult,"process.stdout.write('x'.repeat(5000));");
  const noisyPlan={...plan,repetitions:2,limits:{...plan.limits,log_limit_bytes:1024,suite_log_limit_bytes:1024},revisions:{...plan.revisions,baseline:{...plan.revisions.baseline,args:[noisyNoResult]},candidate:{...plan.revisions.candidate,args:[noisyNoResult]}}};
  const noisyOutput=join(root,'noisy-no-result');
  await assert.rejects(runPairedPlan({plan:noisyPlan,outputDirectory:noisyOutput}),/paired execution failed/i);
  const noisyState=JSON.parse(readFileSync(join(noisyOutput,'paired-state.json'),'utf8'));
  assert.equal(noisyState.samples.length,2);assert.equal(noisyState.samples[1].result.log_budget_exceeded,true);
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test('paired verification binds media codecs, inspection source order, and startup jobs', () => {
 const step={workload_id:'work',revision:'baseline'};
 const makeContract=(evidenceKind,expectedFacts)=>({evidence_kind:evidenceKind,expected_facts:expectedFacts,contract_sha256:sha256Text(stableStringify(expectedFacts))});
 const makeResult=(contract,evidence)=>({success:true,process_ms:1,workload_id:'work',revision:'baseline',verification:{success:true,contract_sha256:contract.contract_sha256,kind:contract.evidence_kind,contract_facts:contract.expected_facts,evidence}});
 const mediaFacts={expected_output:{extension:'mp4',probe:'media',format_names:['mov','mp4'],required_streams:[{codec_type:'video',codec_name:'h264'}]},request:{video_options:{kind:'copy'}}};
 const media=makeContract('media',mediaFacts);
 assert.equal(validatePairedVerification(makeResult(media,{output_bytes:1,probe:{streams:[{codec_type:'video',codec_name:'h264'}],format:{format_name:'mov,mp4'}},effective_execution:{requested:{kind:'copy'},encoder:null}}),step,media),true);
 assert.equal(validatePairedVerification(makeResult(media,{output_bytes:1,probe:{streams:[{codec_type:'video',codec_name:'hevc'}],format:{format_name:'mov,mp4'}},effective_execution:{requested:{kind:'copy'},encoder:null}}),step,media),false);
 const inspectionFacts={source_count:2,source_sha256:['a'.repeat(64),'b'.repeat(64)]};const inspection=makeContract('inspection',inspectionFacts);
 assert.equal(validatePairedVerification(makeResult(inspection,{items:[{source_sha256:'b'.repeat(64),probe_ms:1},{source_sha256:'a'.repeat(64),probe_ms:1}]}),step,inspection),false);
 const startupFacts={jobs:200,marker_schema_version:1};const startup=makeContract('startup',startupFacts);
 assert.equal(validatePairedVerification(makeResult(startup,{jobs:1000,marker:{schema_version:1,backend_ready_ms:1}}),step,startup),false);
});

test('paired collection stops on the first total-budget overrun', async () => {
 const root=mkdtempSync(join(tmpdir(),'goop-paired-budget-'));
 try {
  let runs=0;
  const state=await collectPairedSamples({workloadIds:['copy'],repetitions:2,outputDirectory:join(root,'output'),totalLimits:{suite_timeout_ms:10000,suite_log_limit_bytes:1024,suite_storage_budget_bytes:1048576},execute:async()=>{runs+=1;return {success:true,process_ms:1,process:{log_bytes_retained:1025}};}});
  assert.equal(runs,1);assert.equal(state.status,'failed');assert.equal(state.samples[0].result.log_budget_exceeded,true);
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('paired collector exposes decreasing suite allowances to every launch', async () => {
 const root=mkdtempSync(join(tmpdir(),'goop-paired-allowances-'));
 try {
  const seen=[];
  const state=await collectPairedSamples({workloadIds:['copy'],repetitions:1,outputDirectory:join(root,'output'),totalLimits:{suite_timeout_ms:10000,suite_log_limit_bytes:450,suite_storage_budget_bytes:1048576},execute:async step=>{seen.push({log:step.suite_remaining_log_bytes,storage:step.suite_remaining_storage_bytes});return {success:true,process_ms:1,process:{log_bytes_retained:100}};}});
  assert.equal(state.status,'complete');
  assert.deepEqual(seen.map(value=>value.log),[450,350,250,150]);
  assert.equal(seen.every(value=>Number.isSafeInteger(value.storage)&&value.storage>0&&value.storage<1048576),true);
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('paired collector compacts oversized direct adapter results before ledger writes', async () => {
 const root=mkdtempSync(join(tmpdir(),'goop-paired-result-bound-')),output=join(root,'output');
 try {
  const state=await collectPairedSamples({workloadIds:['copy'],repetitions:1,outputDirectory:output,totalLimits:{suite_timeout_ms:10000,suite_log_limit_bytes:1048576,suite_storage_budget_bytes:1048576},execute:async()=>({success:true,process_ms:1,padding:'x'.repeat(100000)})});
  assert.equal(state.status,'failed');assert.equal(state.samples.every(sample=>sample.result.result_too_large===true),true);assert.equal(state.samples.every(sample=>sample.result.padding===undefined),true);assert.ok(directoryBytes(output)<=1048576);
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('workload metrics accept phase-separated Rust evidence and reject partial failure or contradictory process status', () => {
 const request = { mode: 'conversion_batch', concurrency: 2, items: [{ id: 'one' }, { id: 'two' }] };
 const evidence = { memory_evidence: 'external process tree required', path_safety_limitation: 'path namespace can change after validation' };
 const timing={cancelled:false,start_offset_ms:0,end_offset_ms:1,source_fingerprint_before_ms:0.1,source_fingerprint_after_ms:0.1,admission_ms:0.2,process_ms:0.8,probe_ms:null};
  const complete = { schema_version: 1, mode: 'conversion_batch', success: true, aggregate_ms: 2, wall_ms: 3, encoder_detection_ms: 0.5, max_observed_concurrency: 2, ...evidence, items: [{ id: 'one', success: true, elapsed_ms: 1, ...timing, request: {}, result: {}, output_path: '/suite/one.jpg', source_sha256: 'a'.repeat(64), output_bytes: 1, effective_execution: {} }, { id: 'two', success: true, elapsed_ms: 1, ...timing, request: {}, result: {}, output_path: '/suite/two.jpg', source_sha256: 'b'.repeat(64), output_bytes: 1, effective_execution: {} }] };
 const expected={one:{request:{},output_path:'/suite/one.jpg',source_sha256:'a'.repeat(64)},two:{request:{},output_path:'/suite/two.jpg',source_sha256:'b'.repeat(64)}};
 assert.equal(validateWorkloadMetrics(complete, request, { success: true }, expected), true);
 assert.equal(validateWorkloadMetrics({ ...complete, items: [...complete.items].reverse() }, request, { success: true }, expected), false);
 assert.equal(validateWorkloadMetrics({ ...complete, success: false, items: [{ id: 'one', success: true, elapsed_ms: 1 }, { id: 'two', success: false, elapsed_ms: 1 }] }, request, { success: false }, expected), false);
 assert.equal(validateWorkloadMetrics(complete, request, { success: false }, expected), false);
 assert.equal(validateWorkloadMetrics({ ...complete, unexpected: true }, request, { success: true }, expected), false);
 assert.equal(validateWorkloadMetrics({ ...complete, items: [{ ...complete.items[0], output_path: '/suite/wrong.jpg' }, complete.items[1]] }, request, { success: true }, expected), false);
 assert.equal(validateWorkloadMetrics({ ...complete, items: [{ ...complete.items[0], source_sha256: 'f'.repeat(64) }, complete.items[1]] }, request, { success: true }, expected), false);
 const inspectionRequest = { mode: 'inspection_burst', sources: [{ id: 'one' }] };
 const inspectionTiming={...timing,admission_ms:null,process_ms:null,probe_ms:1};
 assert.equal(validateWorkloadMetrics({ schema_version: 1, mode: 'inspection_burst', success: true, aggregate_ms: 1, wall_ms: 2, encoder_detection_ms: 0.5, max_observed_concurrency: null, ...evidence, items: [{ id: 'one', success: true, elapsed_ms: 1, ...inspectionTiming, input_path: '/fixtures/one.jpg', source_sha256: 'c'.repeat(64), inspection: {}, cache_reuse: 'not_exposed' }] }, inspectionRequest, { success: true }, {one:{input_path:'/fixtures/one.jpg',source_sha256:'c'.repeat(64)}}), true);
 assert.equal(validateWorkloadMetrics({ schema_version: 1, mode: 'inspection_burst', success: true, aggregate_ms: 1, max_observed_concurrency: null, ...evidence, items: [{ id: 'one', success: true, elapsed_ms: 1, inspection: {} }] }, inspectionRequest, { success: true }), false);
});

test('batch outputs require matching bytes and an independent media probe', () => {
 const root = mkdtempSync(join(tmpdir(), 'goop-batch-probe-'));
 try {
  const sidecars = join(root, 'sidecars'); mkdirSync(sidecars);
  const probe = join(sidecars, 'ffprobe-aarch64-apple-darwin');
  writeFileSync(probe, '#!/bin/sh\nprintf \'{"streams":[{"codec_type":"video","codec_name":"mjpeg"}],"format":{"format_name":"image2"}}\'\n'); chmodSync(probe, 0o700);
  const output = join(root, 'one.jpg'); writeFileSync(output, 'media');
  const request = { mode: 'conversion_batch', items: [{ id: 'one', request: { output_path: output, target: 'jpeg' }, expected_output: { extension:'jpg', probe:'media', format_names:['image2'], required_streams:[{codec_type:'video',codec_name:'mjpeg'}] } }] };
  const metrics = { items: [{ id: 'one', output_bytes: 5 }] };
  assert.equal(resolveBundledSidecar(sidecars, 'ffprobe'), probe);
  assert.equal(verifyBatchOutputs(metrics, request, probe).success, true);
  assert.equal(verifyBatchOutputs({ items: [{ id: 'one', output_bytes: 4 }] }, request, probe).success, false);
  writeFileSync(probe, '#!/bin/sh\nprintf \'{"streams":[{"codec_type":"video","codec_name":"h264"}],"format":{"format_name":"matroska,webm"}}\'\n');
  assert.equal(verifyBatchOutputs(metrics, request, probe).success, false);
  writeFileSync(join(sidecars, 'ffprobe-x86_64-pc-windows-msvc.exe'), 'duplicate');
  assert.throws(() => resolveBundledSidecar(sidecars, 'ffprobe'), /exactly one/i);
  rmSync(join(sidecars, 'ffprobe-x86_64-pc-windows-msvc.exe'));
  const linked=join(sidecars,'ffprobe-link');symlinkSync(probe,linked);
  assert.throws(()=>resolveBundledSidecar(sidecars,'ffprobe'),/non-symlink/i);
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test('conversion-batch adapter verifies runtime outputs against manifest expectations', async () => {
 const root=mkdtempSync(join(tmpdir(),'goop-batch-integration-'));
 try {
  const input=join(root,'source.jpg');writeFileSync(input,'source');
  const driver=join(root,'driver');
  writeFileSync(driver,`#!/usr/bin/env node
const fs=require('node:fs'),crypto=require('node:crypto');const request=JSON.parse(fs.readFileSync(process.argv[3]));
const items=request.items.map(item=>{fs.writeFileSync(item.request.output_path,'media');return {id:item.id,success:true,elapsed_ms:1,cancelled:false,start_offset_ms:0,end_offset_ms:1,source_fingerprint_before_ms:0.1,source_fingerprint_after_ms:0.1,admission_ms:0.2,process_ms:0.8,probe_ms:null,error:null,request:item.request,output_path:item.request.output_path,source_sha256:crypto.createHash('sha256').update(fs.readFileSync(item.request.input_path)).digest('hex'),result:{},output_bytes:5,effective_execution:{}}});
fs.writeFileSync(process.argv[4],JSON.stringify({schema_version:1,mode:'conversion_batch',success:true,aggregate_ms:1,wall_ms:2,encoder_detection_ms:0.1,max_observed_concurrency:1,items,error:null,memory_evidence:'external process tree required',path_safety_limitation:'path namespace can change after validation'}));
`);chmodSync(driver,0o700);
  const probe=join(root,'ffprobe');writeFileSync(probe,'#!/bin/sh\nprintf \'{"streams":[{"codec_type":"video","codec_name":"mjpeg"}],"format":{"format_name":"image2"}}\'\n');chmodSync(probe,0o700);
  const item={id:'one',fixture_role:'image',request:{target:'jpeg'},expected_output:{extension:'jpg',probe:'media',format_names:['image2'],required_streams:[{codec_type:'video',codec_name:'mjpeg'}]}};
  const inputSha=(await import('node:crypto')).createHash('sha256').update(readFileSync(input)).digest('hex');
  const result=await executeWorkloadAdapter({output_directory:join(root,'output'),bindings:{image:{path:input,sha256:inputSha}},limits:{timeout_ms:2000,log_limit_bytes:65536,storage_budget_bytes:1048576},workload:{adapter:'workload',mode:'conversion_batch',concurrency:1,items:[item]}},{workloadDriver:driver,sidecars:root,ffprobe:probe});
  assert.equal(result.success,true);
  assert.equal(result.verification.success,true);
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('prevalidated fixture bindings are still rechecked after every run', async () => {
 const root = mkdtempSync(join(tmpdir(), 'goop-suite-integrity-'));
 try {
  const raw = join(root, 'raw.bin'), inspect = join(root, 'inspect.bin');
  writeFileSync(raw, 'raw'); writeFileSync(inspect, 'inspect');
  const crypto = await import('node:crypto');
  const sha = path => crypto.createHash('sha256').update(readFileSync(path)).digest('hex');
  const manifest = validManifest();
  const bindings = validateBindings(manifest, { schema_version: 1, fixtures: {
   raw_48mp: { path: raw, sha256: sha(raw), bytes: 3 },
   inspect_mixed: { path: inspect, sha256: sha(inspect), bytes: 7 },
  } });
  let first = true;
  await assert.rejects(runPerformanceSuite({
   manifest,
   bindings,
   prevalidatedBindings: true,
   outputDirectory: join(root, 'output'),
   execute: async () => {
    if (first) { first = false; writeFileSync(raw, 'changed'); }
    return { success: true, process_ms: 1 };
   },
  }), /byte-size mismatch|sha-256 mismatch/i);
  const state = JSON.parse(readFileSync(join(root, 'output', 'suite-state.json'), 'utf8'));
  assert.equal(state.samples[0].status, 'failed');
  assert.match(state.samples[0].result.source_integrity_error, /mismatch/i);
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test('suite refuses an existing output and retains raw failures incrementally', async () => {
 const root = mkdtempSync(join(tmpdir(), 'goop-suite-'));
 try {
  const output = join(root, 'new-output');
  const raw = join(root, 'raw.bin'), inspect = join(root, 'inspect.bin');
  writeFileSync(raw, 'raw'); writeFileSync(inspect, 'inspect');
  const crypto = await import('node:crypto');
  const sha = path => crypto.createHash('sha256').update(readFileSync(path)).digest('hex');
  const bindings = validateBindings(validManifest(), { schema_version: 1, fixtures: {
   raw_48mp: { path: raw, sha256: sha(raw), bytes: 3 },
   inspect_mixed: { path: inspect, sha256: sha(inspect), bytes: 7 },
  } });
  const runs = [];
  await assert.rejects(runPerformanceSuite({
   manifest: validManifest(),
   bindings,
   outputDirectory: output,
   prevalidatedBindings: true,
   execute: async run => {
    runs.push(run.id);
    return { success: !run.id.endsWith('/2'), process_ms: 1, error: run.id.endsWith('/2') ? 'synthetic failure' : null };
   },
  }), /workload failed/i);
  const state = JSON.parse(readFileSync(join(output, 'suite-state.json'), 'utf8'));
  assert.equal(state.samples.length, 18);
  assert.equal(state.samples.filter(sample => sample.status === 'failed').length, 3);
  assert.equal(state.samples.filter(sample => sample.status === 'excluded').length, 3);
  assert.equal(runs.length, 18);
  assert.throws(() => mkdirSync(output), /EEXIST/);
  await assert.rejects(runPerformanceSuite({ manifest: validManifest(), bindings, outputDirectory: output, prevalidatedBindings: true, execute: async () => ({ success: true, process_ms: 1 }) }), /must be new/i);
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test('suite stops immediately after the total storage budget is exceeded', async () => {
 const root = mkdtempSync(join(tmpdir(), 'goop-suite-budget-'));
 try {
  const raw = join(root, 'raw.bin'), inspect = join(root, 'inspect.bin');
  writeFileSync(raw, 'raw'); writeFileSync(inspect, 'inspect');
  const crypto = await import('node:crypto');
  const sha = path => crypto.createHash('sha256').update(readFileSync(path)).digest('hex');
  const manifest = validManifest();
  const bindings = validateBindings(manifest, { schema_version: 1, fixtures: { raw_48mp: { path: raw, sha256: sha(raw), bytes: 3 }, inspect_mixed: { path: inspect, sha256: sha(inspect), bytes: 7 } } });
  let runs = 0;
  const output = join(root, 'output');
  await assert.rejects(runPerformanceSuite({ manifest, bindings, prevalidatedBindings: true, outputDirectory: output, execute: async run => {
   runs += 1;
   mkdirSync(run.output_directory, { recursive: true });
   writeFileSync(join(run.output_directory, 'oversized.bin'), Buffer.alloc(manifest.defaults.suite_storage_budget_bytes + 1));
   return { success: true, process_ms: 1 };
  } }), /storage budget/i);
  const state = JSON.parse(readFileSync(join(output, 'suite-state.json'), 'utf8'));
  assert.equal(runs, 1);
  assert.equal(state.samples.length, 1);
  assert.equal(state.samples[0].result.budget_exceeded, true);
  assert.ok(directoryBytes(output) <= manifest.defaults.suite_storage_budget_bytes);
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test('suite storage cleanup removes only the current over-budget run', async () => {
 const root=mkdtempSync(join(tmpdir(),'goop-suite-storage-retention-'));
 try {
  const raw=join(root,'raw.bin'),inspect=join(root,'inspect.bin');writeFileSync(raw,'raw');writeFileSync(inspect,'inspect');
  const crypto=await import('node:crypto');const sha=path=>crypto.createHash('sha256').update(readFileSync(path)).digest('hex');
  const manifest=validManifest();manifest.defaults.warmups=1;manifest.defaults.repetitions=1;manifest.defaults.suite_storage_budget_bytes=1300000;manifest.workloads=[manifest.workloads[0]];
  const bindings=validateBindings(manifest,{schema_version:1,fixtures:{raw_48mp:{path:raw,sha256:sha(raw),bytes:3},inspect_mixed:{path:inspect,sha256:sha(inspect),bytes:7}}});
  const undersized={...manifest,defaults:{...manifest.defaults,suite_storage_budget_bytes:1024}};const undersizedOutput=join(root,'undersized');
  await assert.rejects(runPerformanceSuite({manifest:undersized,bindings,prevalidatedBindings:true,outputDirectory:undersizedOutput,execute:async()=>({success:true,process_ms:1})}),/evidence ledger/i);assert.equal(existsSync(undersizedOutput),false);
  const output=join(root,'output');let runs=0;
  await assert.rejects(runPerformanceSuite({manifest,bindings,prevalidatedBindings:true,outputDirectory:output,execute:async run=>{runs+=1;mkdirSync(run.output_directory,{recursive:true});writeFileSync(join(run.output_directory,runs===1?'first.raw':'oversized.raw'),Buffer.alloc(runs===1?100:2*1024*1024));return {success:true,process_ms:1};}}),/storage budget/i);
  assert.equal(runs,2);assert.equal(existsSync(join(output,'raw-single','warmup-0','first.raw')),true);assert.equal(existsSync(join(output,'raw-single','0')),false);assert.ok(directoryBytes(output)<=manifest.defaults.suite_storage_budget_bytes);
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('paired storage cleanup preserves prior completed run evidence', async () => {
 const root=mkdtempSync(join(tmpdir(),'goop-paired-storage-retention-')),output=join(root,'output');
 try {
 let runs=0;const budget=1048576;
  const undersized=join(root,'undersized');await assert.rejects(collectPairedSamples({workloadIds:['copy'],repetitions:2,outputDirectory:undersized,totalLimits:{suite_timeout_ms:10000,suite_log_limit_bytes:1024,suite_storage_budget_bytes:1024},execute:async()=>({success:true,process_ms:1})}),/evidence ledger/i);assert.equal(existsSync(undersized),false);
  const state=await collectPairedSamples({workloadIds:['copy'],repetitions:2,outputDirectory:output,totalLimits:{suite_timeout_ms:10000,suite_log_limit_bytes:1048576,suite_storage_budget_bytes:budget},execute:async step=>{runs+=1;const sample=step.phase==='warmup'?`warmup-${step.revision}`:`${step.repetition}-${step.revision}`;const directory=join(output,'runs',step.workload_id,sample);mkdirSync(directory,{recursive:true});writeFileSync(join(directory,runs===1?'first.raw':'oversized.raw'),Buffer.alloc(runs===1?100:2*1024*1024));return {success:true,process_ms:1};}});
  assert.equal(state.status,'failed');assert.equal(runs,2);assert.equal(existsSync(join(output,'runs','copy','warmup-baseline','first.raw')),true);assert.equal(existsSync(join(output,'runs','copy','warmup-candidate')),false);assert.ok(directoryBytes(output)<=budget);
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('suite clamps every run to remaining storage and retained-log budgets', async () => {
 const root=mkdtempSync(join(tmpdir(),'goop-suite-allowances-'));
 try {
  const raw=join(root,'raw.bin'),inspect=join(root,'inspect.bin');writeFileSync(raw,'raw');writeFileSync(inspect,'inspect');
  const crypto=await import('node:crypto');const sha=path=>crypto.createHash('sha256').update(readFileSync(path)).digest('hex');
  const manifest=validManifest();manifest.defaults.warmups=1;manifest.defaults.repetitions=1;manifest.defaults.log_limit_bytes=1500;manifest.defaults.suite_log_limit_bytes=2000;manifest.defaults.suite_storage_budget_bytes=1400000;manifest.workloads=[manifest.workloads[0]];
  const bindings=validateBindings(manifest,{schema_version:1,fixtures:{raw_48mp:{path:raw,sha256:sha(raw),bytes:3},inspect_mixed:{path:inspect,sha256:sha(inspect),bytes:7}}});
  const seen=[];const output=join(root,'output');
  const state=await runPerformanceSuite({manifest,bindings,prevalidatedBindings:true,outputDirectory:output,execute:async run=>{seen.push({...run.limits});mkdirSync(run.output_directory,{recursive:true});writeFileSync(join(run.output_directory,'payload'),Buffer.alloc(1024));return {success:true,process_ms:1,process:{log_bytes_retained:run.limits.log_limit_bytes}};}});
  assert.equal(state.status,'complete');
  assert.deepEqual(seen.map(value=>value.log_limit_bytes),[1500,500]);
  assert.equal(seen.every(value=>value.storage_budget_bytes>0&&value.storage_budget_bytes<manifest.defaults.storage_budget_bytes),true);
  assert.ok(directoryBytes(output)<=manifest.defaults.suite_storage_budget_bytes);
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('suite stops immediately after the total time budget is exceeded', async () => {
 const root = mkdtempSync(join(tmpdir(), 'goop-suite-time-'));
 try {
  const raw=join(root,'raw.bin'),inspect=join(root,'inspect.bin');writeFileSync(raw,'raw');writeFileSync(inspect,'inspect');
  const crypto=await import('node:crypto');const sha=path=>crypto.createHash('sha256').update(readFileSync(path)).digest('hex');
  const manifest=validManifest();manifest.defaults.suite_timeout_ms=15;
  const bindings=validateBindings(manifest,{schema_version:1,fixtures:{raw_48mp:{path:raw,sha256:sha(raw),bytes:3},inspect_mixed:{path:inspect,sha256:sha(inspect),bytes:7}}});
  let runs=0;const output=join(root,'output');
  await assert.rejects(runPerformanceSuite({manifest,bindings,prevalidatedBindings:true,outputDirectory:output,execute:async()=>{runs+=1;await new Promise(resolve=>setTimeout(resolve,25));return {success:true,process_ms:1};}}),/time budget/i);
  const state=JSON.parse(readFileSync(join(output,'suite-state.json'),'utf8'));assert.equal(runs,1);assert.equal(state.samples.length,1);assert.equal(state.samples[0].result.time_budget_exceeded,true);
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('suite stops immediately after the total retained-log budget is exceeded', async () => {
 const root=mkdtempSync(join(tmpdir(),'goop-suite-logs-'));
 try {
  const raw=join(root,'raw.bin'),inspect=join(root,'inspect.bin');writeFileSync(raw,'raw');writeFileSync(inspect,'inspect');
  const crypto=await import('node:crypto');const sha=path=>crypto.createHash('sha256').update(readFileSync(path)).digest('hex');
  const manifest=validManifest();manifest.defaults.suite_log_limit_bytes=1024;
  const bindings=validateBindings(manifest,{schema_version:1,fixtures:{raw_48mp:{path:raw,sha256:sha(raw),bytes:3},inspect_mixed:{path:inspect,sha256:sha(inspect),bytes:7}}});
  let runs=0;const output=join(root,'output');
  await assert.rejects(runPerformanceSuite({manifest,bindings,prevalidatedBindings:true,outputDirectory:output,execute:async()=>{runs+=1;return {success:true,process_ms:1,process:{log_bytes_retained:1025}};}}),/log budget/i);
  const state=JSON.parse(readFileSync(join(output,'suite-state.json'),'utf8'));assert.equal(runs,1);assert.equal(state.samples[0].result.log_budget_exceeded,true);
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('normal suite refuses an existing output without writing into it', async () => {
 const root = mkdtempSync(join(tmpdir(), 'goop-normal-existing-'));
 try {
  const manifestPath = join(root, 'manifest.json'), bindingsPath = join(root, 'bindings.json');
  const raw = join(root, 'raw.bin'), inspect = join(root, 'inspect.bin');
  writeFileSync(raw, 'raw'); writeFileSync(inspect, 'inspect');
  const crypto = await import('node:crypto');
  const sha = path => crypto.createHash('sha256').update(readFileSync(path)).digest('hex');
  writeFileSync(manifestPath, JSON.stringify(validManifest()));
  writeFileSync(bindingsPath, JSON.stringify({ schema_version: 1, fixtures: { raw_48mp: { path: raw, sha256: sha(raw), bytes: 3 }, inspect_mixed: { path: inspect, sha256: sha(inspect), bytes: 7 } } }));
  const driver = join(root, 'driver'), startup = join(root, 'startup'), sidecars = join(root, 'sidecars');
  writeFileSync(driver, '#!/bin/sh\nexit 0\n'); chmodSync(driver, 0o700);
  writeFileSync(startup, '#!/bin/sh\nexit 0\n'); chmodSync(startup, 0o700);
  mkdirSync(sidecars);
  const probe = join(sidecars, 'ffprobe-test'); writeFileSync(probe, '#!/bin/sh\nprintf "ffprobe test"\n'); chmodSync(probe, 0o700);
  const startupConfig = join(root, 'startup.json'); writeFileSync(startupConfig, '{}');
  const output = join(root, 'existing'); mkdirSync(output);
  const sentinel = join(output, 'integrity.json'); writeFileSync(sentinel, 'sentinel');
  const stateSentinel = join(output, 'suite-state.json'); writeFileSync(stateSentinel, 'planted-state');
  await assert.rejects(normalSuite({ manifest: manifestPath, bindings: bindingsPath, output, 'single-driver': driver, 'workload-driver': driver, sidecars, 'startup-binary': startup, 'startup-config': startupConfig, 'build-command': 'test build', 'hardware-enabled': 'false' }), /must be new/i);
  assert.equal(readFileSync(sentinel, 'utf8'), 'sentinel');
  assert.equal(readFileSync(stateSentinel, 'utf8'), 'planted-state');
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test('normal suite records a failed state when post-run identity capture fails', async () => {
 const root=mkdtempSync(join(tmpdir(),'goop-normal-post-'));const prior=process.env.GOOP_TEST_STARTUP_CONFIG;
 try {
  const fixture=join(root,'source.jpg');writeFileSync(fixture,'source');
  const manifest=validManifest();manifest.defaults.repetitions=1;manifest.workloads=[manifest.workloads[0]];
  const manifestPath=join(root,'manifest.json'),bindingsPath=join(root,'bindings.json'),startupConfig=join(root,'startup.json');
  const crypto=await import('node:crypto');const sha=path=>crypto.createHash('sha256').update(readFileSync(path)).digest('hex');
  writeFileSync(manifestPath,JSON.stringify(manifest));writeFileSync(bindingsPath,JSON.stringify({schema_version:1,fixtures:{raw_48mp:{path:fixture,sha256:sha(fixture),bytes:6},inspect_mixed:{path:fixture,sha256:sha(fixture),bytes:6}}}));writeFileSync(startupConfig,'{}');
  const driver=join(root,'driver');writeFileSync(driver,`#!/usr/bin/env node
const fs=require('node:fs');const request=JSON.parse(fs.readFileSync(process.argv[3]));fs.writeFileSync(request.output_path,'media');fs.writeFileSync(process.argv[4],JSON.stringify({success:true,process_ms:1,result:{bytes:5}}));fs.rmSync(process.env.GOOP_TEST_STARTUP_CONFIG,{force:true});
`);chmodSync(driver,0o700);
  const sidecars=join(root,'sidecars');mkdirSync(sidecars);const probe=join(sidecars,'ffprobe-test');writeFileSync(probe,'#!/bin/sh\nprintf \'{"streams":[{"codec_type":"video","codec_name":"mjpeg"}],"format":{"format_name":"image2"}}\'\n');chmodSync(probe,0o700);
  const startup=join(root,'startup');writeFileSync(startup,'#!/bin/sh\nexit 0\n');chmodSync(startup,0o700);process.env.GOOP_TEST_STARTUP_CONFIG=startupConfig;
  const output=join(root,'output');
  await assert.rejects(normalSuite({manifest:manifestPath,bindings:bindingsPath,output,'single-driver':driver,'workload-driver':driver,sidecars,'startup-binary':startup,'startup-config':startupConfig,'build-command':'test build','hardware-enabled':'false'}),/ENOENT|no such file/i);
  const state=JSON.parse(readFileSync(join(output,'suite-state.json'),'utf8'));const integrity=JSON.parse(readFileSync(join(output,'integrity.json'),'utf8'));
  assert.equal(state.status,'failed');assert.equal(integrity.success,false);assert.equal(integrity.post,null);
 } finally {if(prior===undefined)delete process.env.GOOP_TEST_STARTUP_CONFIG;else process.env.GOOP_TEST_STARTUP_CONFIG=prior;rmSync(root,{recursive:true,force:true});}
});
