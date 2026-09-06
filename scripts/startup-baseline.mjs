import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { treeRss, summarize } from './performance-baseline.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const schema = readFileSync(new URL('../crates/goop-queue/migrations/0001_init.sql', import.meta.url), 'utf8');
const quote = value => `'${String(value).replaceAll("'", "''")}'`;

export function seedQueue(path, count) {
  if (![0, 200].includes(count)) throw Error('Queue scenario must contain zero or 200 finished jobs');
  const statements = [schema,
    'ALTER TABLE jobs ADD COLUMN hidden_from_queue INTEGER NOT NULL DEFAULT 0;',
    'ALTER TABLE jobs ADD COLUMN not_before INTEGER;',
    'ALTER TABLE jobs ADD COLUMN error_detail TEXT;', 'BEGIN;'];
  for (let i = 0; i < count; i++) {
    const payload = JSON.stringify({ input_path: join(dirname(path), 'fixtures', `finished-${i}.png`), target: 'jpeg' });
    statements.push(`INSERT INTO jobs(id,kind,state,payload,created_at,started_at,finished_at) VALUES(${quote(randomUUID())},'convert','done',${quote(payload)},1,2,3);`);
  }
  statements.push('COMMIT;');
  execFileSync('/usr/bin/sqlite3', [path], { input: statements.join('\n'), timeout: 5000 });
}

/** Fresh local runtime; no user settings/data are read or changed. */
export async function runStartup({ binary, args = [], directory, settings, jobs = 0, readinessTimeoutMs = 30000, idleMs = 10000, killGraceMs = 2000, readSnapshot = () => execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,rss=,comm='], { encoding: 'utf8', timeout: 1000 }) }) {
  if (existsSync(directory)) throw Error('Run output directory must be new');
  mkdirSync(directory, { recursive: true });
  for (const name of ['config', 'data', 'outputs']) mkdirSync(join(directory, name));
  const reportPath = join(directory, 'ready.json');
  // A malformed Settings file makes the application fall back to defaults,
  // including updates. Construct only validated measurement settings instead.
  const theme = settings.theme ?? 'dark';
  const extractConcurrency = settings.extract_concurrency ?? 2;
  const convertConcurrency = settings.convert_concurrency ?? 1;
  if (!['dark', 'light', 'system'].includes(theme) || ![extractConcurrency, convertConcurrency].every(value => Number.isSafeInteger(value) && value > 0 && value <= 16)) throw Error('Invalid measurement settings');
  writeFileSync(join(directory, 'config', 'settings.json'), JSON.stringify({ theme, extract_concurrency: extractConcurrency, convert_concurrency: convertConcurrency, yt_dlp_last_update_ms: null, output_dir: join(directory, 'outputs'), auto_check_updates: false, yt_dlp_auto_update: false, notifications_enabled: false, has_seen_onboarding: true }, null, 2));
  seedQueue(join(directory, 'data', 'queue.db'), jobs);
  const start = performance.now();
  const child = spawn(binary, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GOOP_CONFIG_DIR: join(directory, 'config'), GOOP_DATA_DIR: join(directory, 'data'), GOOP_STARTUP_REPORT: reportPath } });
  let exited = false, exitCode = null, exitSignal = null, spawnError = null;
  const closed = new Promise(resolve => {
    child.once('error', error => { spawnError = error.message; });
    child.once('close', (code, signal) => { exited = true; exitCode = code; exitSignal = signal; resolve(); });
  });
  let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0);
  const retain = (buffer, chunk) => Buffer.concat([buffer, chunk.subarray(0, Math.max(0, 1024 * 1024 - buffer.length))]);
  child.stdout.on('data', chunk => { stdout = retain(stdout, chunk); });
  child.stderr.on('data', chunk => { stderr = retain(stderr, chunk); });
  const samples = [];
  const sample = () => {
    try {
      const snapshot = readSnapshot();
      // close events cannot run while ps blocks. Validate liveness in this
      // very snapshot instead of accepting a missing root as zero idle RSS.
      const root = snapshot.trim().split('\n').map(line => line.trim().split(/\s+/)).find(row => Number(row[0]) === child.pid);
      if (!root || !Number.isFinite(Number(root[2])) || Number(root[2]) <= 0) return null;
      const tree = { ...treeRss(snapshot, child.pid), root_pid: child.pid, root_rss_KiB: Number(root[2]) };
      samples.push({ elapsed_ms: performance.now() - start, ...tree });
      return tree;
    } catch { return null; }
  };
  const sampling = setInterval(sample, 100);
  let marker = null, launchMs = null, idleRss = null, timedOut = false;
  try {
    while (!exited && performance.now() - start < readinessTimeoutMs) {
      try {
        if (statSync(reportPath).size < 4096) {
          const value = JSON.parse(readFileSync(reportPath, 'utf8'));
          if (value.schema_version === 1 && value.pid === child.pid && Number.isFinite(value.backend_ready_ms) && value.backend_ready_ms >= 0) {
            marker = value; launchMs = performance.now() - start; break;
          }
        }
      } catch { /* Writer may still be writing the newly-created marker. */ }
      await sleep(10);
    }
    timedOut = !marker && !exited;
    if (marker) {
      const idleStart = performance.now();
      while (!exited && performance.now() - idleStart < idleMs) await sleep(Math.min(50, idleMs));
      if (!exited) idleRss = sample()?.rssKiB ?? null;
    }
  } finally {
    clearInterval(sampling);
    const signal = name => { if (child.pid) { try { process.kill(-child.pid, name); } catch { /* Already gone. */ } } };
    signal('SIGTERM');
    // Always finish the grace period before returning: descendants may outlive
    // a parent that handles TERM. Each run owns its detached process group.
    await sleep(killGraceMs);
    signal('SIGKILL');
    await closed;
  }
  const result = { success: marker !== null && idleRss !== null && spawnError === null, pid: child.pid ?? null, binary, argv: args, marker, launch_to_ready_ms: launchMs, idle_tree_rss_KiB: idleRss, idle_delay_ms: idleMs, sampled_tree_peak_KiB: Math.max(0, ...samples.map(v => v.rssKiB)), sampling_interval_ms: 100, samples, timed_out: timedOut, exit_code: exitCode, exit_signal: exitSignal, spawn_error: spawnError, lifetime_ms: performance.now() - start };
  writeFileSync(join(directory, 'stdout.log'), stdout);
  writeFileSync(join(directory, 'stderr.log'), stderr);
  writeFileSync(join(directory, 'sample.json'), JSON.stringify(result, null, 2));
  return result;
}

export function summarizeStartup(samples) {
  const field = read => summarize(samples.map(sample => ({ success: sample.success, process_ms: read(sample) })));
  return {
    launch_to_ready_ms: field(sample => sample.launch_to_ready_ms),
    backend_ready_ms: field(sample => sample.marker?.backend_ready_ms),
    idle_tree_rss_KiB: field(sample => sample.idle_tree_rss_KiB),
  };
}

async function main() {
  if (process.platform !== 'darwin') throw Error('Startup harness supports macOS only');
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    if (!['--binary', '--config', '--output'].includes(process.argv[i]) || !process.argv[i + 1]) throw Error('Usage: --binary PATH --config SETTINGS_JSON --output NEW_DIRECTORY');
    options[process.argv[i].slice(2)] = process.argv[i + 1];
  }
  for (const key of ['binary', 'config', 'output']) if (!options[key]) throw Error(`Missing --${key}`);
  const binary = resolve(options.binary), output = resolve(options.output), config = resolve(options.config);
  if (existsSync(output)) throw Error('Output directory must be new');
  const settings = JSON.parse(readFileSync(config, 'utf8'));
  const binaryHash = hash(binary);
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'identity.json'), JSON.stringify({ binary, binary_sha256: binaryHash, argv: [], config_sha256: hash(config), warmups: 1, repetitions: 5, scenarios: [0, 200], sampling_interval_ms: 100, node: process.version, platform: process.platform, arch: process.arch, limitation: 'Fresh process with warm filesystem cache. RSS sums app descendants; shared and XPC-hosted WebKit processes may be excluded or shared. Frame marker does not prove display presentation.' }, null, 2));
  const summary = {};
  for (const jobs of [0, 200]) {
    const samples = [];
    for (let i = -1; i < 5; i++) {
      const result = await runStartup({ binary, directory: join(output, `${jobs}-${i < 0 ? 'warmup' : i}`), settings, jobs });
      if (i >= 0) samples.push(result);
      if (!result.success) {
        summary[jobs] = summarizeStartup(samples);
        writeFileSync(join(output, 'summary.json'), JSON.stringify(summary, null, 2));
        throw Error(`Startup failed for ${jobs} jobs, run ${i}; retained sample excludes it from medians`);
      }
    }
    summary[jobs] = summarizeStartup(samples);
    writeFileSync(join(output, 'summary.json'), JSON.stringify(summary, null, 2));
  }
  if (hash(binary) !== binaryHash) throw Error('Executable changed during startup suite');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
