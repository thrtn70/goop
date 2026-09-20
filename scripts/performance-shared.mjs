import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  lstatSync,
  realpathSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export const sha256File = path => createHash('sha256').update(readFileSync(path)).digest('hex');
export const sha256Text = text => createHash('sha256').update(text).digest('hex');

function processTreeRss(snapshot, rootPid) {
  const rows = snapshot.trim().split('\n').map(line => line.trim().split(/\s+/).slice(0, 3).map(Number));
  const ids = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parentPid] of rows) {
      if (ids.has(parentPid) && !ids.has(pid)) { ids.add(pid); changed = true; }
    }
  }
  const matched = rows.filter(([pid, , rss]) => ids.has(pid) && Number.isFinite(rss) && rss > 0);
  if (!matched.some(([pid]) => pid === rootPid)) return null;
  return { rssKiB: matched.reduce((sum, [, , rss]) => sum + rss, 0), children: Math.max(0, matched.length - 1) };
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const gitObject = value => typeof value === 'string' && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(value);
const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const available = value => typeof value === 'string' && value !== '' && value !== 'unavailable';

export function validateCapturedIdentity(identity, label = 'identity') {
  if (identity === null || typeof identity !== 'object' || Array.isArray(identity)) throw Error(`Invalid ${label}`);
  const fields = ['source', 'manifest_sha256', 'bindings_sha256', 'executables', 'sidecars', 'parameters', 'toolchain', 'machine'];
  if (Object.keys(identity).some(field => !fields.includes(field)) || fields.some(field => identity[field] === undefined)) throw Error(`Invalid ${label} fields`);
  if (!gitObject(identity.source?.head) || !gitObject(identity.source?.tree) || !digest(identity.source?.dirty_digest) || typeof identity.source?.dirty !== 'boolean') throw Error(`Invalid ${label} source`);
  if (!digest(identity.manifest_sha256) || !digest(identity.bindings_sha256)) throw Error(`Invalid ${label} manifest or bindings digest`);
  for (const field of ['executables', 'sidecars', 'parameters', 'toolchain', 'machine']) if (identity[field] === null || typeof identity[field] !== 'object' || Array.isArray(identity[field])) throw Error(`Invalid ${label} ${field}`);
  for (const field of ['executables', 'sidecars', 'parameters']) if (Object.keys(identity[field]).length === 0) throw Error(`Invalid ${label} ${field}`);
  for (const [field, descriptors] of [['executables', identity.executables], ['sidecars', identity.sidecars]]) for (const descriptor of Object.values(descriptors)) {
    if (descriptor === null || typeof descriptor !== 'object' || !available(descriptor.path) || !digest(descriptor.sha256)) throw Error(`Invalid ${label} ${field}`);
    if (field === 'sidecars' && (!Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 1)) throw Error(`Invalid ${label} sidecar bytes`);
    if (field === 'sidecars' && (!available(descriptor.version) || descriptor.version === 'unavailable')) throw Error(`Invalid ${label} sidecar version`);
  }
  for (const field of ['node', 'rustc', 'cargo']) if (!available(identity.toolchain[field])) throw Error(`Invalid ${label} toolchain.${field}`);
  for (const field of ['platform', 'arch', 'os', 'hardware_model', 'disk_available_bytes']) if (!available(identity.machine[field])) throw Error(`Invalid ${label} machine.${field}`);
  for (const field of ['power_source', 'low_power_mode', 'thermal']) if (typeof identity.machine[field] !== 'string' || identity.machine[field] === '') throw Error(`Invalid ${label} machine.${field}`);
  return identity;
}

export function directoryBytes(directory) {
  if (!existsSync(directory)) return 0;
  return readdirSync(directory, { withFileTypes: true }).reduce((sum, entry) => {
    const path = join(directory, entry.name);
    const stats = lstatSync(path);
    return sum + (stats.isDirectory() ? directoryBytes(path) : stats.size);
  }, 0);
}

function symlinksBelow(directory) {
  if (!existsSync(directory)) return [];
  const links = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) links.push(path);
    else if (stats.isDirectory()) links.push(...symlinksBelow(path));
  }
  return links;
}

export function pruneOwnedEntriesToBudget(directory, budgetBytes, preserveNames = new Set(), additionalBytes = 0) {
  if (!existsSync(directory)) return true;
  const candidates = readdirSync(directory).filter(name => !preserveNames.has(name)).map(name => {
    const path = join(directory, name);
    return { path, bytes: lstatSync(path).isDirectory() ? directoryBytes(path) : lstatSync(path).size };
  }).sort((a, b) => b.bytes - a.bytes);
  for (const candidate of candidates) {
    if (directoryBytes(directory) + additionalBytes <= budgetBytes) break;
    rmSync(candidate.path, { recursive: true, force: true });
  }
  return directoryBytes(directory) + additionalBytes <= budgetBytes;
}

export function createOwnedDirectory(directory, label = 'Output directory') {
  if (existsSync(directory)) throw Error(`${label} must be new`);
  mkdirSync(directory, { recursive: true });
}

export function writeJsonAtomic(path, value, { budgetDirectory = null, budgetBytes = null } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  const serialized = `${JSON.stringify(value)}\n`;
  if (budgetDirectory !== null) {
    if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 1) throw Error('Atomic JSON budget must be a positive safe integer');
    if (directoryBytes(budgetDirectory) + Buffer.byteLength(serialized) > budgetBytes) throw Error('Atomic JSON replacement would exceed the storage budget');
  }
  // Budget calculations use the exact compact representation retained here.
  // Pretty printing can multiply nested-array evidence well beyond its measured
  // JSON byte count and violate the declared hard storage ceiling.
  writeFileSync(temporary, serialized, { flag: 'wx' });
  try {
    renameSync(temporary, path);
  } catch (error) {
    if (process.platform !== 'win32' || !existsSync(path)) throw error;
    rmSync(path, { force: true });
    renameSync(temporary, path);
  }
}

export async function withTerminationSignals(operation) {
  const controller = new AbortController();
  let receivedSignal = null;
  const handlers = Object.fromEntries(['SIGINT', 'SIGTERM'].map(name => [name, () => {
    receivedSignal ??= name;
    controller.abort(name);
  }]));
  for (const [name, handler] of Object.entries(handlers)) process.on(name, handler);
  try {
    await operation(controller.signal);
  } catch (error) {
    if (receivedSignal === null) throw error;
  } finally {
    for (const [name, handler] of Object.entries(handlers)) process.removeListener(name, handler);
  }
  if (receivedSignal !== null) process.exitCode = receivedSignal === 'SIGINT' ? 130 : 143;
}

const gitRepositoryEnvironment = new Set([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE', 'GIT_NO_REPLACE_OBJECTS', 'GIT_REPLACE_REF_BASE', 'GIT_PREFIX',
  'GIT_INTERNAL_SUPER_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_COMMON_DIR',
]);

export const withoutGitRepositoryEnvironment = environment => Object.fromEntries(
  Object.entries(environment).filter(([name]) => !gitRepositoryEnvironment.has(name)),
);

export function runtimeSidecarEnvironment(runtimeSidecarsDirectory, environment = process.env, platform = process.platform) {
  const pathValue = existsSync(runtimeSidecarsDirectory) ? realpathSync(runtimeSidecarsDirectory) : runtimeSidecarsDirectory;
  const entries = Object.entries(environment).filter(([name]) => name.toLowerCase() !== 'path');
  const existingPathKeys = Object.keys(environment).filter(name => name.toLowerCase() === 'path');
  const pathKey = platform === 'win32'
    ? (existingPathKeys.find(name => name === 'Path') ?? existingPathKeys[0] ?? 'Path')
    : 'PATH';
  return { ...Object.fromEntries(entries), [pathKey]: pathValue };
}

function commandValue(command, args, options = {}) {
  try {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, ...options });
    if (result.status !== 0 || result.error) throw result.error ?? Error(`Command exited ${result.status}`);
    return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  } catch {
    return 'unavailable';
  }
}

function commandBuffer(command, args, options = {}) {
  try {
    return execFileSync(command, args, { timeout: 5000, maxBuffer: 64 * 1024 * 1024, ...options });
  } catch {
    return null;
  }
}

export function captureIdentity({ cwd = process.cwd(), manifestText, bindingsText, executables = {}, sidecars = {}, parameters = {}, environment = process.env }) {
  const gitOptions = { env: withoutGitRepositoryEnvironment(environment) };
  const head = commandValue('git', ['-C', cwd, 'rev-parse', 'HEAD'], gitOptions);
  const tree = commandValue('git', ['-C', cwd, 'rev-parse', 'HEAD^{tree}'], gitOptions);
  const status = commandValue('git', ['-C', cwd, 'status', '--porcelain=v1', '--untracked-files=all'], gitOptions);
  const binaryDiff = commandBuffer('git', ['-C', cwd, 'diff', '--binary', '--no-ext-diff', 'HEAD', '--'], gitOptions);
  const untrackedOutput = commandBuffer('git', ['-C', cwd, 'ls-files', '--others', '--exclude-standard', '-z'], gitOptions);
  const untracked = untrackedOutput === null ? 'unavailable' : untrackedOutput.toString().split('\0').filter(Boolean).sort().map(path => {
    const absolute = join(cwd, path);
    const stats = lstatSync(absolute);
    return { path, kind: stats.isSymbolicLink() ? 'symlink' : 'file', sha256: stats.isSymbolicLink() ? sha256Text(readlinkSync(absolute)) : sha256File(absolute) };
  });
  const dirtyDigest = binaryDiff === null || untracked === 'unavailable'
    ? 'unavailable'
    : sha256Text(stableStringify({ tracked_diff_sha256: createHash('sha256').update(binaryDiff).digest('hex'), untracked }));
  const describe = collection => Object.fromEntries(Object.entries(collection).map(([name, path]) => [name, {
    path,
    sha256: existsSync(path) ? sha256File(path) : 'unavailable',
  }]));
  const describeSidecars = collection => Object.fromEntries(Object.entries(collection).map(([name, path]) => {
    const versionFlag = /^(ffmpeg|ffprobe)(-|\.|$)/.test(name) ? '-version'
      : /^mutool(-|\.|$)/.test(name) ? '-v'
        : /^(yt-dlp|gallery-dl|gs|tesseract)(-|\.|$)/.test(name) ? '--version'
        : null;
    const canonicalPath = existsSync(path) ? realpathSync(path) : path;
    return [name, {
      path: canonicalPath,
      sha256: existsSync(canonicalPath) ? sha256File(canonicalPath) : 'unavailable',
      bytes: existsSync(canonicalPath) ? lstatSync(canonicalPath).size : 'unavailable',
      version: versionFlag && existsSync(canonicalPath) ? commandValue(canonicalPath, [versionFlag]).split('\n')[0] : 'not_applicable',
    }];
  }));
  return {
    source: { head, tree, dirty_digest: dirtyDigest, dirty: status !== '' && status !== 'unavailable' },
    manifest_sha256: sha256Text(manifestText),
    bindings_sha256: sha256Text(bindingsText),
    executables: describe(executables),
    sidecars: describeSidecars(sidecars),
    parameters,
    toolchain: {
      node: process.version,
      rustc: commandValue('rustc', ['--version']),
      cargo: commandValue('cargo', ['--version']),
    },
    machine: {
      platform: process.platform,
      arch: process.arch,
      os: commandValue('uname', ['-srv']),
      hardware_model: process.platform === 'darwin' ? commandValue('/usr/sbin/sysctl', ['-n', 'hw.model']) : 'unavailable',
      power_source: process.platform === 'darwin' ? commandValue('/usr/bin/pmset', ['-g', 'batt']) : 'unavailable',
      low_power_mode: process.platform === 'darwin' ? commandValue('/usr/bin/pmset', ['-g', 'custom']) : 'unavailable',
      thermal: process.platform === 'darwin' ? commandValue('/usr/bin/pmset', ['-g', 'therm']) : 'unavailable',
      disk_available_bytes: commandValue('/bin/df', ['-k', cwd]),
    },
  };
}

/** Run one owned process group with bounded retained logs, lifetime, and suite storage. */
export async function runBoundedProcess({
  command,
  args = [],
  cwd,
  env = process.env,
  outputDirectory,
  timeoutMs,
  killGraceMs = 2000,
  logLimitBytes,
  storageBudgetBytes,
  abortSignal = null,
}) {
  if (abortSignal?.aborted) throw Error('Process run aborted before launch');
  const initialEntries = new Set(existsSync(outputDirectory) ? readdirSync(outputDirectory) : []);
  if (symlinksBelow(outputDirectory).length > 0) throw Error('Owned output directory must not contain symbolic links');
  const timedCommand = process.platform === 'darwin' ? '/usr/bin/time' : command;
  const timedArgs = process.platform === 'darwin' ? ['-l', command, ...args] : args;
  const child = spawn(timedCommand, timedArgs, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), retainedLogBytes = 0, timedOut = false, budgetExceeded = false, aborted = false, spawnError = null, killTimer;
  let stopRequested = false, childSettled = false, killEscalation = null, sampledTreePeakKiB = null, observedChildren = null;
  const windowsCleanupPids = new Set();
  const retain = (current, chunk) => { const kept=chunk.subarray(0,Math.max(0,logLimitBytes-retainedLogBytes));retainedLogBytes+=kept.length;return Buffer.concat([current,kept]); };
  child.stdout.on('data', chunk => { stdout = retain(stdout, chunk); });
  child.stderr.on('data', chunk => { stderr = retain(stderr, chunk); });
  const signal = name => {
    try {
      if (process.platform === 'win32') {
        const force = name === 'SIGKILL' ? ['/f'] : [];
        try {
          execFileSync('taskkill', ['/pid', String(child.pid), '/t', ...force], { stdio: 'ignore', timeout: Math.max(1000, killGraceMs) });
          windowsCleanupPids.add(child.pid);
          return true;
        } catch {
          if (windowsCleanupPids.size === 0) {
            const rows = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process | ForEach-Object { Write-Output (('{0} {1}' -f $_.ProcessId,$_.ParentProcessId)) }"], { encoding: 'utf8', timeout: 5000 }).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
            const ids = new Set([child.pid]); let changed = true;
            while (changed) { changed = false; for (const [pid, parentPid] of rows) if (ids.has(parentPid) && !ids.has(pid)) { ids.add(pid); changed = true; } }
            ids.delete(child.pid); for (const pid of ids) windowsCleanupPids.add(pid);
          }
          let sent = false;
          for (const pid of windowsCleanupPids) try { execFileSync('taskkill', ['/pid', String(pid), '/t', ...force], { stdio: 'ignore', timeout: Math.max(1000, killGraceMs) }); sent = true; } catch { /* Already gone. */ }
          return sent;
        }
      }
      process.kill(-child.pid, name);
      return true;
    } catch { return false; }
  };
  const stop = () => {
    if (stopRequested) return;
    stopRequested = true;
    const softSignalSent = signal('SIGTERM');
    const windowsNeedsForcedCleanup = process.platform === 'win32' && (!childSettled || windowsCleanupPids.size > 0);
    if (!softSignalSent && !windowsNeedsForcedCleanup) { killEscalation = Promise.resolve(); return; }
    killEscalation = new Promise(resolveKill => {
      killTimer = setTimeout(() => { signal('SIGKILL'); resolveKill(); }, killGraceMs);
    });
  };
  const abort = () => { aborted = true; stop(); };
  abortSignal?.addEventListener('abort', abort, { once: true });
  const monitor = setInterval(() => {
    try {
      if (process.platform !== 'win32') {
        const sample = processTreeRss(execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8', timeout: 1000 }), child.pid);
        if (sample) {
          sampledTreePeakKiB = Math.max(sampledTreePeakKiB ?? 0, sample.rssKiB);
          observedChildren = Math.max(observedChildren ?? 0, sample.children);
        }
      }
      if (directoryBytes(outputDirectory) + stdout.length + stderr.length > storageBudgetBytes) {
        budgetExceeded = true;
        stop();
      }
    } catch { /* A just-exited child can race a directory snapshot. */ }
  }, 100);
  const timeout = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  const start = performance.now();
  const code = await new Promise(resolve => {
    child.once('error', error => { childSettled = true; spawnError = error.message; resolve(null); });
    child.once('close', value => { childSettled = true; resolve(value); });
  });
  clearInterval(monitor);
  clearTimeout(timeout);
  abortSignal?.removeEventListener('abort', abort);
  try {
    budgetExceeded ||= directoryBytes(outputDirectory) + retainedLogBytes > storageBudgetBytes;
  } catch {
    budgetExceeded = true;
  }
  // Confirm the entire owned group is gone even when the root exits cleanly;
  // adapters may otherwise leave ignored-stdio descendants behind.
  stop();
  if (killEscalation) await killEscalation;
  else clearTimeout(killTimer);
  let removedStagingDirectories = 0, cleanupError = null, outputError = null;
  const createdSymlinks = symlinksBelow(outputDirectory);
  if (createdSymlinks.length > 0) {
    outputError = 'Owned process created symbolic-link output';
    for (const path of createdSymlinks) try { rmSync(path, { force: true }); } catch (error) { cleanupError ??= error.message; }
  }
  if (timedOut || budgetExceeded || aborted || outputError !== null) {
    try {
      for (const entry of readdirSync(outputDirectory, { withFileTypes: true })) {
        if (entry.isDirectory() && !initialEntries.has(entry.name) && /^\.goop-output-\d+-\d+$/.test(entry.name)) {
          rmSync(join(outputDirectory, entry.name), { recursive: true });
          removedStagingDirectories += 1;
        }
      }
      if (budgetExceeded && !pruneOwnedEntriesToBudget(outputDirectory, storageBudgetBytes, initialEntries, retainedLogBytes)) cleanupError ??= 'Owned output could not be reduced to the storage budget';
    } catch (error) {
      cleanupError = error.message;
    }
  }
  const timePeakMatch = process.platform === 'darwin' ? stderr.toString().match(/(\d+)\s+maximum resident set size/) : null;
  return {
    success: code === 0 && !timedOut && !budgetExceeded && !aborted && spawnError === null && cleanupError === null && outputError === null,
    exit_code: code,
    timed_out: timedOut,
    budget_exceeded: budgetExceeded,
    aborted,
    spawn_error: spawnError,
    cleanup_error: cleanupError,
    output_error: outputError,
    removed_staging_directories: removedStagingDirectories,
    lifetime_ms: performance.now() - start,
    sampled_tree_peak_KiB: sampledTreePeakKiB,
    sampling_interval_ms: 100,
    observed_children: observedChildren,
    time_peak_bytes: timePeakMatch ? Number(timePeakMatch[1]) : null,
    log_bytes_retained: retainedLogBytes,
    stdout,
    stderr,
  };
}

export function removeOwnedDirectory(directory) {
  rmSync(directory, { recursive: true, force: true });
}
