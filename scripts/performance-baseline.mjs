import {spawn,execFileSync} from 'node:child_process';
import {readFileSync,mkdirSync,statSync,lstatSync,existsSync,readdirSync,unlinkSync,rmSync} from 'node:fs';
import {resolve,join,basename,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {validateEffectiveExecution,validateMediaProbe} from './performance-manifest.mjs';
import {createEvidenceFile,createOwnedGroupStopper,directoryBytes,ownedLaunch,readOwnedRegularFile,replaceEvidenceFile,runtimeSidecarEnvironment,withTerminationSignals} from './performance-shared.mjs';
export function treeRss(snapshot,root){
 const rows=snapshot.trim().split('\n').map(line=>line.trim().split(/\s+/).slice(0,3).map(Number));
 const ids=new Set([root]); let changed=true;
 while(changed){changed=false;for(const [pid,ppid] of rows)if(ids.has(ppid)&&!ids.has(pid)){ids.add(pid);changed=true;}}
 return {rssKiB:rows.filter(([pid])=>ids.has(pid)).reduce((sum,row)=>sum+row[2],0),children:ids.size-1};
}
export function summarize(samples){const times=samples.filter(s=>s.success).map(s=>s.process_ms).sort((a,b)=>a-b);const n=times.length;return {successes:n,failures:samples.length-n,median_ms:n?(times[Math.floor((n-1)/2)]+times[Math.floor(n/2)])/2:null,min_ms:n?times[0]:null,max_ms:n?times.at(-1):null};}
export function outputName(name,index,ext){return `${name}-${index<0?'warmup':index}.${ext}`;}
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
export function normalizeSuccess(metrics, code, timedOut) {
 return metrics.success === true && code === 0 && !timedOut && Number.isFinite(metrics.process_ms) && metrics.process_ms >= 0;
}
// One byte count for every storage monitor, so they agree on vanished entries.
export {directoryBytes};
export function ownedSymlinks(directory){const links=[];for(const name of readdirSync(directory)){const path=join(directory,name),stats=lstatSync(path);if(stats.isSymbolicLink())links.push(path);else if(stats.isDirectory())links.push(...ownedSymlinks(path));}return links;}
export function effectiveHardware(metrics,hardwareEnabled) {
 const summary=metrics.result?.video_execution;
 if(summary?.requested?.kind==='copy')return {effective_encoder:null,effective_hardware:'copy'};
 const effectiveEncoder=summary?.encoder??null;
 if(effectiveEncoder)return {effective_encoder:effectiveEncoder,effective_hardware:/(videotoolbox|nvenc|_qsv|_amf)$/.test(effectiveEncoder)?'hardware':'software'};
 return {effective_encoder:null,effective_hardware:hardwareEnabled?'unknown':'software_or_copy'};
}
export async function run(binary,sidecars,request,stem,options={}) {
 // The default sleep coerces its delay as setTimeout does, so a numeric-string
 // limit still fires instead of rejecting and leaving the run without a timer.
 const {timeoutMs=120000,killGraceMs=2000,logLimitBytes=1024*1024,budgetBytes=512*1024*1024,hardwareEnabled=false,ffprobe=null,expectedOutput=null,abortSignal=null,environment=process.env,nowMs=()=>performance.now(),sleepMs=(ms,wait)=>delay(Number(ms),undefined,wait)}=options;
 if(abortSignal?.aborted)throw Error('Conversion run aborted before launch');
 const {measureBytes=directoryBytes,readSnapshot=()=>execFileSync('ps',['-axo','pid=,ppid=,rss=,comm='],{encoding:'utf8',timeout:1000})}=options;
 const directory=dirname(stem);
 // Tests inject a failing symbolic-link scan here; no caller passes one.
 const {listSymlinks=ownedSymlinks}=options;
 const launch=ownedLaunch(binary,[sidecars,`${stem}.request.json`,`${stem}.metrics.json`,String(hardwareEnabled)]);
 const existingEntries=new Set(readdirSync(directory));
 const initialSymlinks=new Set(listSymlinks(directory));
 createEvidenceFile(`${stem}.request.json`,JSON.stringify(request,null,2));
 const child=spawn(launch.command,launch.args,{stdio:[launch.stdin,'pipe','pipe'],detached:process.platform!=='win32',env:environment});
 let stdout=Buffer.alloc(0),stderr=Buffer.alloc(0),retainedLogBytes=0,rssKiB=null,children=null,timedOut=false,budgetExceeded=false,aborted=false;
 const retain=(current,chunk)=>{const kept=chunk.subarray(0,Math.max(0,logLimitBytes-retainedLogBytes));retainedLogBytes+=kept.length;return Buffer.concat([current,kept]);};
 child.stdout.on('data',chunk=>{stdout=retain(stdout,chunk);});
 child.stderr.on('data',chunk=>{stderr=retain(stderr,chunk);});
 const {stop}=createOwnedGroupStopper(child,{killGraceMs,sleep:sleepMs});
 const abort=()=>{aborted=true;stop();};abortSignal?.addEventListener('abort',abort,{once:true});
 // Vanished entries count zero, so a throw from the count is a real read
 // failure that would leave the live budget blind for the rest of the run.
 const overBudget=()=>{try{return measureBytes(directory)+stdout.length+stderr.length>budgetBytes-Math.min(65536,budgetBytes/4);}catch{return true;}};
 const timer=setInterval(()=>{
  try {
   const sample=treeRss(readSnapshot(),child.pid);
   if(sample.rssKiB>0){rssKiB=Math.max(rssKiB??0,sample.rssKiB);children=Math.max(children??0,sample.children);}
  } catch {/* ps can time out under load or race an exiting process; a missed sample is not an overrun. */}
  if(overBudget()){budgetExceeded=true;stop();}
 },100);
 const start=nowMs();let code;
 // sleepMs(ms,{signal}) must reject once signal aborts, as the default does, so
 // a run that closes first cancels its timeout instead of stopping a dead group.
 const timeout=new AbortController();
 sleepMs(timeoutMs,{signal:timeout.signal}).then(()=>{timedOut=true;stop();},()=>{/* Cancelled: the root closed first. */});
 try{code=await new Promise((res,rej)=>{child.on('error',rej);child.on('close',res);});}
 finally{clearInterval(timer);timeout.abort();abortSignal?.removeEventListener('abort',abort);}
  const lifetimeMs=nowMs()-start;
 // A clean root exit is not a clean sample if owned descendants remain. Reap
 // before any post-exit file I/O, so no throw below can leave the group running
 // and every check below sees a tree the child can no longer change.
 await stop();
 // The child shared this directory, so whatever it left at an evidence path is
 // refused rather than followed or opened, and the refusal fails the sample.
 let evidenceError=null;
 for(const [path,data] of [[`${stem}.stdout`,stdout],[`${stem}.stderr`,stderr]])try{createEvidenceFile(path,data);}catch(error){evidenceError??=error.message;}
 let metrics={success:false,error:'No metrics produced'};
 // The child can neither redirect nor stall this read: a link (symbolic or hard)
 // is refused on every platform, Windows included, and a FIFO never blocks.
 let metricsBytes=null;
 try{metricsBytes=readOwnedRegularFile(`${stem}.metrics.json`,Math.min(1024*1024,budgetBytes/4));}catch{/* Missing or not openable: no metrics. */}
 if(metricsBytes!==null)try{const parsed=JSON.parse(metricsBytes);if(parsed===null||typeof parsed!=='object'||Array.isArray(parsed))throw Error('Metrics must be an object');metrics=parsed;}catch{metrics.error='Invalid metrics JSON';}
 // A failed count fails closed here too instead of rejecting the run.
 try{budgetExceeded ||= measureBytes(directory)>budgetBytes-Math.min(65536,budgetBytes/4);}catch{budgetExceeded=true;}
 const verificationStart=nowMs();
 // A scan that cannot read the tree fails the sample instead of rejecting the
 // run and skipping its cleanup.
 let createdSymlinks=[],outputError=null;
 try{createdSymlinks=listSymlinks(directory).filter(path=>!initialSymlinks.has(path));}catch(error){outputError=`Owned output could not be checked for symbolic links: ${error.message}`;}
 if(createdSymlinks.length)outputError=`Owned conversion created symbolic-link output: ${createdSymlinks.map(path=>basename(path)).join(', ')}`;
 for(const path of createdSymlinks)try{rmSync(path,{force:true});}catch(error){outputError=`${outputError}; cleanup failed: ${error.message}`;}
 let verification={checked:false,...(outputError?{error:outputError}:{})};
 if(normalizeSuccess(metrics,code,timedOut||budgetExceeded||aborted) && expectedOutput) {
  if(outputError){metrics.success=false;}
  else if(!ffprobe){metrics.success=false;verification={checked:false,error:'Successful conversion did not receive the bound bundled ffprobe for independent verification'};}
  else try {
    const outputStats=lstatSync(request.output_path);
    if(!outputStats.isFile())throw Error('Conversion output must be a regular non-symlink file');
    const outputBytes=outputStats.size;
    const probe=JSON.parse(execFileSync(ffprobe,['-v','error','-show_streams','-show_format','-of','json',request.output_path],{encoding:'utf8',timeout:20000,maxBuffer:1024*1024,env:environment}));
    validateMediaProbe(probe,expectedOutput);
    verification={checked:true,output_bytes:outputBytes,probe,target_met:request.compress_mode?.kind==='target_size_bytes'?outputBytes<=request.compress_mode.value:null};
    if(outputBytes!==Number(metrics.result?.bytes)||verification.target_met===false)metrics.success=false;
  } catch(error) {metrics.success=false;verification={checked:true,error:error.message};}
 }
  const effective=effectiveHardware(metrics,hardwareEnabled);
 if(normalizeSuccess(metrics,code,timedOut||budgetExceeded||aborted) && expectedOutput)try{validateEffectiveExecution(metrics.result?.video_execution,request);}catch(error){metrics.success=false;verification={...verification,execution_error:error.message};}
 const timePeak=stderr.toString().match(/(\d+)\s+maximum resident set size/);
 const sample={...metrics,...effective,verification,metrics_success:metrics.success,success:normalizeSuccess(metrics,code,timedOut||budgetExceeded||aborted)&&outputError===null,exit_code:code,timed_out:timedOut,budget_exceeded:budgetExceeded,aborted,output_error:outputError,removed_symlink_outputs:createdSymlinks.length,log_bytes_retained:retainedLogBytes,lifetime_ms:lifetimeMs,verification_ms:nowMs()-verificationStart,sampled_tree_peak_KiB:rssKiB,sampling_interval_ms:100,observed_children:children,time_peak_bytes:timePeak?Number(timePeak[1]):null};
 const evidenceFailed=message=>{sample.evidence_error??=message;sample.success=false;};
 sample.evidence_error=null;if(evidenceError!==null)evidenceFailed(evidenceError);
 const saveSample=write=>{try{write(`${stem}.sample.json`,JSON.stringify(sample,null,2));}catch(error){evidenceFailed(error.message);}};
 saveSample(createEvidenceFile);
 // The request output is created uniquely inside this suite. Preserve measurements
 // before dropping only that owned media when it caused the storage limit.
 // The group is already reaped, so a cleanup failure is an obstacle the child
 // left behind; record it with the sample instead of rejecting the run.
 sample.removed_staging_directories=0;sample.cleanup_error=null;
 const cleanupFailed=error=>{sample.cleanup_error??=error.message;};
 if(budgetExceeded && dirname(request.output_path)===directory && existsSync(request.output_path))try{unlinkSync(request.output_path);}catch(error){cleanupFailed(error);}
 if(timedOut||budgetExceeded||aborted)try{for(const entry of readdirSync(directory,{withFileTypes:true})){
  if(entry.isDirectory() && !existingEntries.has(entry.name) && /^\.goop-output-\d+-\d+$/.test(entry.name)){
   try{rmSync(join(directory,entry.name),{recursive:true});sample.removed_staging_directories++;}catch(error){cleanupFailed(error);}
  }
 }}catch(error){cleanupFailed(error);}
 saveSample(replaceEvidenceFile);
 return sample;
}
async function main(abortSignal){
 const options=Object.fromEntries(Array.from({length:(process.argv.length-2)/2},(_,i)=>[process.argv[2+i*2].replace(/^--/,''),process.argv[3+i*2]]));
 const binary=resolve(options.binary),sidecars=resolve(options['runtime-sidecars']),fixtures=resolve(options.fixtures),out=resolve(options.output);if(existsSync(out))throw Error('Output directory must be new');
 const repeat=Number(options.repeat??5);if(!Number.isInteger(repeat)||repeat<1||repeat>20)throw Error('Invalid repeat');
 const inputs=['photo.png','photo.heic','sample.mp4','malformed.dng'].map(v=>join(fixtures,v));for(const path of inputs)statSync(path);
 mkdirSync(out,{recursive:true});
 const cases=[['png-jpeg',inputs[0],'jpeg',null],['heic-jpeg',inputs[1],'jpeg',null],['mp4-mp3',inputs[2],'mp3',null],['mp4-h264',inputs[2],'mp4',null,'balanced'],['mp4-quality',inputs[2],'mp4',{kind:'quality',value:50}],['mp4-compress',inputs[2],'mp4',{kind:'target_size_bytes',value:104858}],['malformed',inputs[3],'jpeg',null]];
 if(options.raw&&existsSync(options.raw))cases.push(['raw-jpeg',resolve(options.raw),'jpeg',null]);
 const sources=Object.fromEntries([...new Set(cases.map(c=>c[1]))].map(path=>[path,{sha256:hash(path),bytes:statSync(path).size}]));
 createEvidenceFile(join(out,'identity.json'),JSON.stringify({binary,binary_sha256:hash(binary),node:process.version,sources,repeat,warmup:1,label:'Fresh process with warm filesystem cache',head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()},null,2));
 const summary={};for(const [name,input,target,compress,quality] of cases){const samples=[];for(let i=-1;i<repeat;i++){const stem=join(out,`${name}-${i<0?'warmup':i}`);const request={input_path:input,output_path:join(out,outputName(name,i,target==='jpeg'?'jpg':target)),target,quality_preset:quality??null,resolution_cap:null,gif_options:null,compress_mode:compress,batch_id:null,metadata_policy:'preserve',subtitle:null};const sample=await run(binary,sidecars,request,stem,{abortSignal,environment:runtimeSidecarEnvironment(sidecars)});if(sample.budget_exceeded)throw Error("Suite storage budget exceeded; owned oversized media removed after recording metrics");if(i>=0)samples.push(sample);}summary[name]=summarize(samples);replaceEvidenceFile(join(out,'summary.json'),JSON.stringify(summary,null,2));}
 for(const [path,identity] of Object.entries(sources))if(hash(path)!==identity.sha256)throw Error(`Source changed: ${basename(path)}`);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))withTerminationSignals(main).catch(error=>{console.error(error);process.exitCode=1;});
