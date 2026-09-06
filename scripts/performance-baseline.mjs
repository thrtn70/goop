import {spawn,execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,statSync,existsSync,readdirSync,unlinkSync,rmSync} from 'node:fs';
import {resolve,join,basename,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
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
 return readdirSync(directory,{withFileTypes:true}).reduce((sum,entry)=>sum+(entry.isDirectory()?directoryBytes(join(directory,entry.name)):statSync(join(directory,entry.name)).size),0);
}
export async function run(binary,sidecars,request,stem,options={}) {
 const {timeoutMs=120000,killGraceMs=2000,logLimitBytes=1024*1024,budgetBytes=512*1024*1024}=options;
 const directory=dirname(stem);
 const existingEntries=new Set(readdirSync(directory));
 writeFileSync(`${stem}.request.json`,JSON.stringify(request,null,2));
 const child=spawn('/usr/bin/time',['-l',binary,sidecars,`${stem}.request.json`,`${stem}.metrics.json`],{stdio:['ignore','pipe','pipe'],detached:true});
 let stdout=Buffer.alloc(0),stderr=Buffer.alloc(0),rssKiB=0,children=0,timedOut=false,budgetExceeded=false,killTimer;
 const retain=(current,chunk)=>Buffer.concat([current,chunk.subarray(0,Math.max(0,logLimitBytes-current.length))]);
 child.stdout.on('data',chunk=>{stdout=retain(stdout,chunk);});
 child.stderr.on('data',chunk=>{stderr=retain(stderr,chunk);});
 const signal=name=>{try{process.kill(-child.pid,name);}catch{/* The process group has already exited. */}};
 const stop=()=>{signal('SIGTERM');killTimer??=setTimeout(()=>signal('SIGKILL'),killGraceMs);};
 const timer=setInterval(()=>{
  try {
   const sample=treeRss(execFileSync('ps',['-axo','pid=,ppid=,rss=,comm='],{encoding:'utf8',timeout:1000}),child.pid);
   rssKiB=Math.max(rssKiB,sample.rssKiB);children=Math.max(children,sample.children);
   if(directoryBytes(directory)+stdout.length+stderr.length>budgetBytes-Math.min(65536,budgetBytes/4)){budgetExceeded=true;stop();}
  } catch {/* A process or output can disappear between snapshots. */}
 },100);
 const timeout=setTimeout(()=>{timedOut=true;stop();},timeoutMs);
 const start=performance.now();let code;
 try{code=await new Promise((res,rej)=>{child.on('error',rej);child.on('close',res);});}
 finally{clearInterval(timer);clearTimeout(timeout);clearTimeout(killTimer);}
 const lifetimeMs=performance.now()-start;
 writeFileSync(`${stem}.stdout`,stdout);writeFileSync(`${stem}.stderr`,stderr);
 let metrics={success:false,error:'No metrics produced'};
 const metricsPath=`${stem}.metrics.json`;
 if(existsSync(metricsPath)&&statSync(metricsPath).size<Math.min(1024*1024,budgetBytes/4)) {
  try{metrics=JSON.parse(readFileSync(metricsPath));}catch{metrics.error='Invalid metrics JSON';}
 }
 budgetExceeded ||= directoryBytes(directory)>budgetBytes-Math.min(65536,budgetBytes/4);
 const verificationStart=performance.now();
 let verification={checked:false};
 if(normalizeSuccess(metrics,code,timedOut||budgetExceeded)&&metrics.sidecars?.ffprobe) {
  try {
   const outputBytes=statSync(request.output_path).size;
   const probe=JSON.parse(execFileSync(metrics.sidecars.ffprobe,['-v','error','-show_streams','-show_format','-of','json',request.output_path],{encoding:'utf8',timeout:20000,maxBuffer:1024*1024}));
   verification={checked:true,output_bytes:outputBytes,probe,target_met:request.compress_mode?.kind==='target_size_bytes'?outputBytes<=request.compress_mode.value:null};
   if(outputBytes!==Number(metrics.result?.bytes)||verification.target_met===false)metrics.success=false;
  } catch(error) {metrics.success=false;verification={checked:true,error:error.message};}
 }
 const sample={...metrics,verification,metrics_success:metrics.success,success:normalizeSuccess(metrics,code,timedOut||budgetExceeded),exit_code:code,timed_out:timedOut,budget_exceeded:budgetExceeded,log_bytes_retained:stdout.length+stderr.length,lifetime_ms:lifetimeMs,verification_ms:performance.now()-verificationStart,sampled_tree_peak_KiB:rssKiB,sampling_interval_ms:100,observed_children:children,time_peak_bytes:Number(stderr.toString().match(/(\d+)\s+maximum resident set size/)?.[1]??0)};
 writeFileSync(`${stem}.sample.json`,JSON.stringify(sample,null,2));
 // The request output is created uniquely inside this suite. Preserve measurements
 // before dropping only that owned media when it caused the storage limit.
 if(budgetExceeded && dirname(request.output_path)===directory && existsSync(request.output_path))unlinkSync(request.output_path);
 sample.removed_staging_directories=0;
 if(budgetExceeded)for(const entry of readdirSync(directory,{withFileTypes:true})){
  if(entry.isDirectory() && !existingEntries.has(entry.name) && /^\.goop-output-\d+-\d+$/.test(entry.name)){
   rmSync(join(directory,entry.name),{recursive:true});sample.removed_staging_directories++;
  }
 }
 writeFileSync(`${stem}.sample.json`,JSON.stringify(sample,null,2));
 return sample;
}
async function main(){
 const options=Object.fromEntries(Array.from({length:(process.argv.length-2)/2},(_,i)=>[process.argv[2+i*2].replace(/^--/,''),process.argv[3+i*2]]));
 const binary=resolve(options.binary),sidecars=resolve(options.sidecars),fixtures=resolve(options.fixtures),out=resolve(options.output);if(existsSync(out))throw Error('Output directory must be new');
 const repeat=Number(options.repeat??5);if(!Number.isInteger(repeat)||repeat<1||repeat>20)throw Error('Invalid repeat');
 const inputs=['photo.png','photo.heic','sample.mp4','malformed.dng'].map(v=>join(fixtures,v));for(const path of inputs)statSync(path);
 mkdirSync(out,{recursive:true});
 const cases=[['png-jpeg',inputs[0],'jpeg',null],['heic-jpeg',inputs[1],'jpeg',null],['mp4-mp3',inputs[2],'mp3',null],['mp4-h264',inputs[2],'mp4',null,'balanced'],['mp4-quality',inputs[2],'mp4',{kind:'quality',value:50}],['mp4-compress',inputs[2],'mp4',{kind:'target_size_bytes',value:104858}],['malformed',inputs[3],'jpeg',null]];
 if(options.raw&&existsSync(options.raw))cases.push(['raw-jpeg',resolve(options.raw),'jpeg',null]);
 const sources=Object.fromEntries([...new Set(cases.map(c=>c[1]))].map(path=>[path,{sha256:hash(path),bytes:statSync(path).size}]));
 writeFileSync(join(out,'identity.json'),JSON.stringify({binary,binary_sha256:hash(binary),node:process.version,sources,repeat,warmup:1,label:'Fresh process with warm filesystem cache',head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()},null,2));
 const summary={};for(const [name,input,target,compress,quality] of cases){const samples=[];for(let i=-1;i<repeat;i++){const stem=join(out,`${name}-${i<0?'warmup':i}`);const request={input_path:input,output_path:join(out,outputName(name,i,target==='jpeg'?'jpg':target)),target,quality_preset:quality??null,resolution_cap:null,gif_options:null,compress_mode:compress,batch_id:null,metadata_policy:'preserve',subtitle:null};const sample=await run(binary,sidecars,request,stem);if(sample.budget_exceeded)throw Error("Suite storage budget exceeded; owned oversized media removed after recording metrics");if(i>=0)samples.push(sample);}summary[name]=summarize(samples);writeFileSync(join(out,'summary.json'),JSON.stringify(summary,null,2));}
 for(const [path,identity] of Object.entries(sources))if(hash(path)!==identity.sha256)throw Error(`Source changed: ${basename(path)}`);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error);process.exitCode=1;});
