import {spawn,execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,statSync,lstatSync,existsSync,readdirSync,unlinkSync,rmSync} from 'node:fs';
import {resolve,join,basename,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {validateEffectiveExecution,validateMediaProbe} from './performance-manifest.mjs';
import {withTerminationSignals} from './performance-shared.mjs';
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
export function directoryBytes(directory) {
 return readdirSync(directory).reduce((sum,name)=>{const path=join(directory,name),stats=lstatSync(path);return sum+(stats.isDirectory()?directoryBytes(path):stats.size);},0);
}
export function ownedSymlinks(directory){const links=[];for(const name of readdirSync(directory)){const path=join(directory,name),stats=lstatSync(path);if(stats.isSymbolicLink())links.push(path);else if(stats.isDirectory())links.push(...ownedSymlinks(path));}return links;}
export function effectiveHardware(metrics,hardwareEnabled) {
 const summary=metrics.result?.video_execution;
 if(summary?.requested?.kind==='copy')return {effective_encoder:null,effective_hardware:'copy'};
 const effectiveEncoder=summary?.encoder??null;
 if(effectiveEncoder)return {effective_encoder:effectiveEncoder,effective_hardware:/(videotoolbox|nvenc|_qsv|_amf)$/.test(effectiveEncoder)?'hardware':'software'};
 return {effective_encoder:null,effective_hardware:hardwareEnabled?'unknown':'software_or_copy'};
}
export async function run(binary,sidecars,request,stem,options={}) {
 const {timeoutMs=120000,killGraceMs=2000,logLimitBytes=1024*1024,budgetBytes=512*1024*1024,hardwareEnabled=false,ffprobe=null,expectedOutput=null,abortSignal=null}=options;
 if(abortSignal?.aborted)throw Error('Conversion run aborted before launch');
 const directory=dirname(stem);
 const existingEntries=new Set(readdirSync(directory));
 const initialSymlinks=new Set(ownedSymlinks(directory));
 writeFileSync(`${stem}.request.json`,JSON.stringify(request,null,2));
 const child=spawn('/usr/bin/time',['-l',binary,sidecars,`${stem}.request.json`,`${stem}.metrics.json`,String(hardwareEnabled)],{stdio:['ignore','pipe','pipe'],detached:true});
 let stdout=Buffer.alloc(0),stderr=Buffer.alloc(0),retainedLogBytes=0,rssKiB=null,children=null,timedOut=false,budgetExceeded=false,aborted=false,killTimer,killEscalation=null,stopRequested=false;
 const retain=(current,chunk)=>{const kept=chunk.subarray(0,Math.max(0,logLimitBytes-retainedLogBytes));retainedLogBytes+=kept.length;return Buffer.concat([current,kept]);};
 child.stdout.on('data',chunk=>{stdout=retain(stdout,chunk);});
 child.stderr.on('data',chunk=>{stderr=retain(stderr,chunk);});
 const signal=name=>{try{process.kill(-child.pid,name);return true;}catch{return false;}};
 const stop=()=>{if(stopRequested)return;stopRequested=true;if(!signal('SIGTERM')){killEscalation=Promise.resolve();return;}killEscalation=new Promise(resolveKill=>{killTimer=setTimeout(()=>{signal('SIGKILL');resolveKill();},killGraceMs);});};
 const abort=()=>{aborted=true;stop();};abortSignal?.addEventListener('abort',abort,{once:true});
 const timer=setInterval(()=>{
  try {
   const sample=treeRss(execFileSync('ps',['-axo','pid=,ppid=,rss=,comm='],{encoding:'utf8',timeout:1000}),child.pid);
   if(sample.rssKiB>0){rssKiB=Math.max(rssKiB??0,sample.rssKiB);children=Math.max(children??0,sample.children);}
   if(directoryBytes(directory)+stdout.length+stderr.length>budgetBytes-Math.min(65536,budgetBytes/4)){budgetExceeded=true;stop();}
  } catch {/* A process or output can disappear between snapshots. */}
 },100);
 const timeout=setTimeout(()=>{timedOut=true;stop();},timeoutMs);
 const start=performance.now();let code;
 try{code=await new Promise((res,rej)=>{child.on('error',rej);child.on('close',res);});}
 finally{clearInterval(timer);clearTimeout(timeout);abortSignal?.removeEventListener('abort',abort);}
  const lifetimeMs=performance.now()-start;
  writeFileSync(`${stem}.stdout`,stdout);writeFileSync(`${stem}.stderr`,stderr);
 let metrics={success:false,error:'No metrics produced'};
 const metricsPath=`${stem}.metrics.json`;
 if(existsSync(metricsPath)&&statSync(metricsPath).size<Math.min(1024*1024,budgetBytes/4)) {
  try{metrics=JSON.parse(readFileSync(metricsPath));}catch{metrics.error='Invalid metrics JSON';}
 }
 budgetExceeded ||= directoryBytes(directory)>budgetBytes-Math.min(65536,budgetBytes/4);
 // A clean root exit is not a clean sample if owned descendants remain.
 stop();
 if(killEscalation)await killEscalation;else clearTimeout(killTimer);
 const verificationStart=performance.now();
 const createdSymlinks=ownedSymlinks(directory).filter(path=>!initialSymlinks.has(path));
 let outputError=createdSymlinks.length?`Owned conversion created symbolic-link output: ${createdSymlinks.map(path=>basename(path)).join(', ')}`:null;
 for(const path of createdSymlinks)try{rmSync(path,{force:true});}catch(error){outputError=`${outputError}; cleanup failed: ${error.message}`;}
 let verification={checked:false,...(outputError?{error:outputError}:{})};
 if(normalizeSuccess(metrics,code,timedOut||budgetExceeded||aborted) && expectedOutput) {
  if(outputError){metrics.success=false;}
  else if(!ffprobe){metrics.success=false;verification={checked:false,error:'Successful conversion did not receive the bound bundled ffprobe for independent verification'};}
  else try {
    const outputStats=lstatSync(request.output_path);
    if(!outputStats.isFile())throw Error('Conversion output must be a regular non-symlink file');
    const outputBytes=outputStats.size;
    const probe=JSON.parse(execFileSync(ffprobe,['-v','error','-show_streams','-show_format','-of','json',request.output_path],{encoding:'utf8',timeout:20000,maxBuffer:1024*1024}));
    validateMediaProbe(probe,expectedOutput);
    verification={checked:true,output_bytes:outputBytes,probe,target_met:request.compress_mode?.kind==='target_size_bytes'?outputBytes<=request.compress_mode.value:null};
    if(outputBytes!==Number(metrics.result?.bytes)||verification.target_met===false)metrics.success=false;
  } catch(error) {metrics.success=false;verification={checked:true,error:error.message};}
 }
  const effective=effectiveHardware(metrics,hardwareEnabled);
 if(normalizeSuccess(metrics,code,timedOut||budgetExceeded||aborted) && expectedOutput)try{validateEffectiveExecution(metrics.result?.video_execution,request);}catch(error){metrics.success=false;verification={...verification,execution_error:error.message};}
 const timePeak=stderr.toString().match(/(\d+)\s+maximum resident set size/);
 const sample={...metrics,...effective,verification,metrics_success:metrics.success,success:normalizeSuccess(metrics,code,timedOut||budgetExceeded||aborted)&&outputError===null,exit_code:code,timed_out:timedOut,budget_exceeded:budgetExceeded,aborted,output_error:outputError,removed_symlink_outputs:createdSymlinks.length,log_bytes_retained:retainedLogBytes,lifetime_ms:lifetimeMs,verification_ms:performance.now()-verificationStart,sampled_tree_peak_KiB:rssKiB,sampling_interval_ms:100,observed_children:children,time_peak_bytes:timePeak?Number(timePeak[1]):null};
 writeFileSync(`${stem}.sample.json`,JSON.stringify(sample,null,2));
 // The request output is created uniquely inside this suite. Preserve measurements
 // before dropping only that owned media when it caused the storage limit.
 if(budgetExceeded && dirname(request.output_path)===directory && existsSync(request.output_path))unlinkSync(request.output_path);
 sample.removed_staging_directories=0;
 if(timedOut||budgetExceeded||aborted)for(const entry of readdirSync(directory,{withFileTypes:true})){
  if(entry.isDirectory() && !existingEntries.has(entry.name) && /^\.goop-output-\d+-\d+$/.test(entry.name)){
   rmSync(join(directory,entry.name),{recursive:true});sample.removed_staging_directories++;
  }
 }
 writeFileSync(`${stem}.sample.json`,JSON.stringify(sample,null,2));
 return sample;
}
async function main(abortSignal){
 const options=Object.fromEntries(Array.from({length:(process.argv.length-2)/2},(_,i)=>[process.argv[2+i*2].replace(/^--/,''),process.argv[3+i*2]]));
 const binary=resolve(options.binary),sidecars=resolve(options.sidecars),fixtures=resolve(options.fixtures),out=resolve(options.output);if(existsSync(out))throw Error('Output directory must be new');
 const repeat=Number(options.repeat??5);if(!Number.isInteger(repeat)||repeat<1||repeat>20)throw Error('Invalid repeat');
 const inputs=['photo.png','photo.heic','sample.mp4','malformed.dng'].map(v=>join(fixtures,v));for(const path of inputs)statSync(path);
 mkdirSync(out,{recursive:true});
 const cases=[['png-jpeg',inputs[0],'jpeg',null],['heic-jpeg',inputs[1],'jpeg',null],['mp4-mp3',inputs[2],'mp3',null],['mp4-h264',inputs[2],'mp4',null,'balanced'],['mp4-quality',inputs[2],'mp4',{kind:'quality',value:50}],['mp4-compress',inputs[2],'mp4',{kind:'target_size_bytes',value:104858}],['malformed',inputs[3],'jpeg',null]];
 if(options.raw&&existsSync(options.raw))cases.push(['raw-jpeg',resolve(options.raw),'jpeg',null]);
 const sources=Object.fromEntries([...new Set(cases.map(c=>c[1]))].map(path=>[path,{sha256:hash(path),bytes:statSync(path).size}]));
 writeFileSync(join(out,'identity.json'),JSON.stringify({binary,binary_sha256:hash(binary),node:process.version,sources,repeat,warmup:1,label:'Fresh process with warm filesystem cache',head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()},null,2));
 const summary={};for(const [name,input,target,compress,quality] of cases){const samples=[];for(let i=-1;i<repeat;i++){const stem=join(out,`${name}-${i<0?'warmup':i}`);const request={input_path:input,output_path:join(out,outputName(name,i,target==='jpeg'?'jpg':target)),target,quality_preset:quality??null,resolution_cap:null,gif_options:null,compress_mode:compress,batch_id:null,metadata_policy:'preserve',subtitle:null};const sample=await run(binary,sidecars,request,stem,{abortSignal});if(sample.budget_exceeded)throw Error("Suite storage budget exceeded; owned oversized media removed after recording metrics");if(i>=0)samples.push(sample);}summary[name]=summarize(samples);writeFileSync(join(out,'summary.json'),JSON.stringify(summary,null,2));}
 for(const [path,identity] of Object.entries(sources))if(hash(path)!==identity.sha256)throw Error(`Source changed: ${basename(path)}`);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))withTerminationSignals(main).catch(error=>{console.error(error);process.exitCode=1;});
