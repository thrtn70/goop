import test from 'node:test';
import assert from 'node:assert/strict';
import { treeRss, summarize, outputName } from './performance-baseline.mjs';
test('aggregates only descendants in KiB',()=>assert.deepEqual(treeRss('10 1 100 parent\n11 10 200 ffmpeg\n12 11 50 child\n99 1 900 other',10),{rssKiB:350,children:2}));
test('failed operations excluded from throughput',()=>assert.deepEqual(summarize([{success:true,process_ms:20},{success:false,process_ms:1},{success:true,process_ms:40}]),{successes:2,failures:1,median_ms:30,min_ms:20,max_ms:40}));
test('output names differ for warmup and every repetition',()=>assert.equal(new Set([-1,0,1,2,3,4].map(i=>outputName('video',i,'mp4'))).size,6));
import {run, normalizeSuccess, directoryBytes} from './performance-baseline.mjs';
import {mkdtempSync,writeFileSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('success requires clean exit and finite nonnegative duration',()=>{
 assert.equal(normalizeSuccess({success:true,process_ms:1},1,false),false);
 assert.equal(normalizeSuccess({success:true},0,false),false);
 assert.equal(normalizeSuccess({success:true,process_ms:-1},0,false),false);
 assert.equal(normalizeSuccess({success:true,process_ms:1},0,true),false);
});
async function fakeRunner(code,options={}){const dir=mkdtempSync(join(tmpdir(),'goop-bench-'));try{const file=join(dir,'runner');writeFileSync(file,`#!/usr/bin/env node\n${code}`);chmodSync(file,0o700);return await run(file,dir,{output_path:join(dir,'result')},join(dir,'run'),options);}finally{rmSync(dir,{recursive:true,force:true});}}
test('timeout escalates for a process ignoring TERM',async()=>{const start=performance.now();const result=await fakeRunner("process.on('SIGTERM',()=>{});setInterval(()=>{},10)",{timeoutMs:200,killGraceMs:30});assert.equal(result.success,false);assert.equal(result.timed_out,true);assert.ok(performance.now()-start<3000);});
test('contradictory metrics cannot count as success',async()=>{const result=await fakeRunner("require('node:fs').writeFileSync(process.argv[4],JSON.stringify({success:true,process_ms:1}));process.exitCode=1;");assert.equal(result.success,false);});
test('storage budget stops oversized output and logs are bounded',async()=>{const result=await fakeRunner("const fs=require('node:fs');const r=JSON.parse(fs.readFileSync(process.argv[3]));fs.writeFileSync(r.output_path,Buffer.alloc(10000));process.stderr.write('x'.repeat(10000));setInterval(()=>{},10)",{budgetBytes:4096,logLimitBytes:100,killGraceMs:30});assert.equal(result.budget_exceeded,true);assert.equal(result.success,false);assert.ok(result.log_bytes_retained<=200);});
test('directory byte count includes only files in suite',()=>{const dir=mkdtempSync(join(tmpdir(),'goop-bench-'));try{writeFileSync(join(dir,'one'),'1234');assert.equal(directoryBytes(dir),4);}finally{rmSync(dir,{recursive:true,force:true});}});
test('child lifetime excludes subsequent output verification',async()=>{
 const result=await fakeRunner("const fs=require('node:fs'),path=require('node:path');const r=JSON.parse(fs.readFileSync(process.argv[3]));const probe=path.join(path.dirname(r.output_path),'probe');fs.writeFileSync(probe,'#!/bin/sh\\nsleep 0.5\\nprintf \\'{}\\'\\n');fs.chmodSync(probe,0o700);fs.writeFileSync(r.output_path,'x');fs.writeFileSync(process.argv[4],JSON.stringify({success:true,process_ms:1,result:{bytes:1},sidecars:{ffprobe:probe}}));");
 assert.equal(result.success,true);
 assert.ok(result.verification_ms >= 400);
 assert.ok(result.lifetime_ms < result.verification_ms);
});
test('budget failure also removes new owned staging artifacts after metrics',async()=>{const result=await fakeRunner("const fs=require('node:fs'),p=require('node:path');const r=JSON.parse(fs.readFileSync(process.argv[3]));const d=p.join(p.dirname(r.output_path),'.goop-output-'+process.pid+'-0');fs.mkdirSync(d);fs.writeFileSync(p.join(d,'partial'),Buffer.alloc(10000));setInterval(()=>{},10)",{budgetBytes:4096,logLimitBytes:100,killGraceMs:30});assert.equal(result.budget_exceeded,true);assert.equal(result.removed_staging_directories,1);});
