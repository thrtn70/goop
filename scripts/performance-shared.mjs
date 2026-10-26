import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  lstatSync,
  openSync,
  realpathSync,
  readFileSync,
  readSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { release as osRelease, version as osVersion } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

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

const processIdentityKey = row => [row.pid, row.ppid, row.process_start_time, row.canonical_executable].join('\u0000');

function validProcessRow(row, label) {
  if (!Number.isSafeInteger(row.pid) || row.pid < 1) throw Error(`${label} has an invalid PID`);
  if (!Number.isSafeInteger(row.ppid) || row.ppid < 0) throw Error(`${label} has an invalid parent PID`);
  if (typeof row.process_start_time !== 'string' || row.process_start_time.length === 0) throw Error(`${label} is missing process start time`);
  if (typeof row.canonical_executable !== 'string' || row.canonical_executable.length === 0) throw Error(`${label} is missing canonical executable`);
  if (!Number.isSafeInteger(row.rss_kib) || row.rss_kib < 0) throw Error(`${label} has invalid RSS`);
  return row;
}

function canonicalExecutable(path) {
  if (typeof path !== 'string' || path.length === 0) return path;
  try { return existsSync(path) ? realpathSync(path) : path; } catch { return path; }
}

/**
 * Parse one bounded process-table observation into stable process identities.
 *
 * Darwin accepts either tab-delimited normalized rows or the native
 * `ps -axo pid=,ppid=,lstart=,rss=,comm=` representation. Windows accepts the
 * compact JSON emitted by the PowerShell query in captureProcessIdentitySnapshot.
 */
export function parseProcessIdentitySnapshot(snapshot, platform = process.platform, { rootPid = null } = {}) {
  if (typeof snapshot !== 'string' || Buffer.byteLength(snapshot) > 4 * 1024 * 1024) throw Error('Process snapshot must be bounded text');
  if (platform === 'win32') {
    let parsed;
    try { parsed = JSON.parse(snapshot); } catch { throw Error('Invalid Windows process snapshot JSON'); }
    const records = Array.isArray(parsed) ? parsed : parsed === null ? [] : [parsed];
    if (records.length > 65_536) throw Error('Windows process snapshot row cap exceeded');
    let selected = records;
    if (rootPid !== null) {
      const basic = records.map(record => ({ record, pid: Number(record.ProcessId), ppid: Number(record.ParentProcessId) }));
      const included = new Set([rootPid]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const row of basic) if (Number.isSafeInteger(row.pid) && Number.isSafeInteger(row.ppid) && included.has(row.ppid) && !included.has(row.pid)) { included.add(row.pid); changed = true; }
      }
      selected = basic.filter(row => included.has(row.pid)).map(row => row.record);
    }
    return selected.map((record, index) => {
      if (!Number.isSafeInteger(record.ProcessId) || !Number.isSafeInteger(record.ParentProcessId) || !Number.isFinite(record.WorkingSetSize)) throw Error(`Windows process row ${index} is incomplete`);
      return validProcessRow({
      pid: record.ProcessId,
      ppid: record.ParentProcessId,
      process_start_time: typeof record.CreationDate === 'string' ? record.CreationDate : '',
      canonical_executable: canonicalExecutable(record.ExecutablePath),
      rss_kib: Math.ceil(record.WorkingSetSize / 1024),
    }, `Windows process row ${index}`);
    });
  }
  if (platform !== 'darwin') throw Error(`Identity-aware process sampling does not support platform ${platform}`);
  const lines = snapshot.split('\n').filter(line => line.trim() !== '');
  if (lines.length > 65_536) throw Error('macOS process snapshot row cap exceeded');
  return lines.map((line, index) => {
    let pid, ppid, started, rss, executable;
    if (line.includes('\t')) {
      [pid, ppid, started, rss, ...executable] = line.split('\t');
      executable = executable.join('\t');
    } else {
      const matched = line.match(/^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\d+)\s+(.+)$/);
      if (!matched) throw Error(`Invalid macOS process row ${index}`);
      [, pid, ppid, started, rss, executable] = matched;
      const time = Date.parse(started);
      if (!Number.isFinite(time)) throw Error(`macOS process row ${index} has invalid start time`);
      started = new Date(time).toISOString();
    }
    return validProcessRow({
      pid: Number(pid),
      ppid: Number(ppid),
      process_start_time: started,
      canonical_executable: canonicalExecutable(executable),
      rss_kib: Number(rss),
    }, `macOS process row ${index}`);
  });
}

export function processTreeRssFromIdentitySnapshot(rows, rootPid) {
  const ids = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) if (ids.has(row.ppid) && !ids.has(row.pid)) { ids.add(row.pid); changed = true; }
  }
  const matched = rows.filter(row => ids.has(row.pid));
  if (!matched.some(row => row.pid === rootPid)) return null;
  return { rssKiB: matched.reduce((sum, row) => sum + row.rss_kib, 0), children: Math.max(0, matched.length - 1) };
}

export function captureProcessIdentitySnapshot(platform = process.platform) {
  if (platform === 'darwin') {
    return execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,rss=,comm='], { encoding: 'utf8', timeout: 1000, maxBuffer: 4 * 1024 * 1024 });
  }
  if (platform === 'win32') {
    const query = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,ExecutablePath,WorkingSetSize | ConvertTo-Json -Compress';
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], { encoding: 'utf8', timeout: 2000, maxBuffer: 4 * 1024 * 1024 });
  }
  throw Error(`Identity-aware process sampling does not support platform ${platform}`);
}

/** Preserve PID reuse and process churn instead of folding observations by PID. */
export function createIdentityAwareProcessSeries({ rootPid, platform = process.platform, maxIdentities = 16, maxSnapshots = 2002 } = {}) {
  if (!Number.isSafeInteger(rootPid) || rootPid < 1) throw Error('Process-series root PID must be positive');
  if (!Number.isSafeInteger(maxIdentities) || maxIdentities < 1 || maxIdentities > 16) throw Error('Invalid process identity cap');
  if (!Number.isSafeInteger(maxSnapshots) || maxSnapshots < 1 || maxSnapshots > 2002) throw Error('Invalid process snapshot cap');
  const identities = [];
  const identityIndexes = new Map();
  const snapshots = [];
  const pidKeys = new Map();
  let previousKeys = new Set();
  let missedReads = 0;
  let scheduledReads = 0;
  let processesExited = 0;
  let pidReuseCount = 0;
  let firstRootKey = null;
  let rootIdentityDrift = false;
  let lastElapsedUs = -1;
  let finished = false;

  const reserveObservation = elapsedUs => {
    if (finished) throw Error('Process series is already finalized');
    if (!Number.isSafeInteger(elapsedUs) || elapsedUs < 0 || elapsedUs <= lastElapsedUs) throw Error('Process snapshot time must be a strictly increasing nonnegative integer');
    if (scheduledReads >= maxSnapshots) throw Error('Process snapshot cap exceeded');
    scheduledReads += 1;
    lastElapsedUs = elapsedUs;
  };

  const observe = (elapsedUs, snapshot) => {
    reserveObservation(elapsedUs);
    let rows;
    try { rows = parseProcessIdentitySnapshot(snapshot, platform, { rootPid }); } catch {
      missedReads += 1;
      return false;
    }
    const byPid = new Map(rows.map(row => [row.pid, row]));
    if (byPid.size !== rows.length || !byPid.has(rootPid)) { missedReads += 1; return false; }
    const includedPids = new Set([rootPid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) if (includedPids.has(row.ppid) && !includedPids.has(row.pid)) { includedPids.add(row.pid); changed = true; }
    }
    const selected = rows.filter(row => includedPids.has(row.pid)).sort((a, b) => a.pid - b.pid);
    if (selected.some(row => row.rss_kib < 1)) { missedReads += 1; return false; }
    const currentKeys = new Set();
    const rssByProcess = [];
    for (const row of selected) {
      const key = processIdentityKey(row);
      currentKeys.add(key);
      const priorKey = pidKeys.get(row.pid);
      if (priorKey !== undefined && priorKey !== key) pidReuseCount += 1;
      pidKeys.set(row.pid, key);
      let index = identityIndexes.get(key);
      if (index === undefined) {
        if (identities.length >= maxIdentities) throw Error('Process identity cap exceeded');
        index = identities.length;
        identityIndexes.set(key, index);
        identities.push({ process_index: index, pid: row.pid, ppid: row.ppid, process_start_time: row.process_start_time, canonical_executable: row.canonical_executable });
      }
      rssByProcess.push([index, row.rss_kib]);
      if (row.pid === rootPid) {
        if (firstRootKey === null) firstRootKey = key;
        else if (firstRootKey !== key) rootIdentityDrift = true;
      }
    }
    for (const key of previousKeys) if (!currentKeys.has(key)) processesExited += 1;
    previousKeys = currentKeys;
    snapshots.push({ elapsed_us: elapsedUs, rss_by_process: rssByProcess });
    return true;
  };

  const recordMiss = elapsedUs => {
    reserveObservation(elapsedUs);
    missedReads += 1;
    return false;
  };

  const finish = () => {
    finished = true;
    return {
      identities: identities.map(value => ({ ...value })),
      snapshots: snapshots.map(value => ({ elapsed_us: value.elapsed_us, rss_by_process: value.rss_by_process.map(pair => [...pair]) })),
      scheduled_reads: scheduledReads,
      missed_reads: missedReads,
      pid_reuse_count: pidReuseCount,
      churn: { processes_started: identities.length, processes_exited: processesExited },
      attribution_complete: snapshots.length > 0 && !rootIdentityDrift,
      root_identity_drift: rootIdentityDrift,
    };
  };
  return Object.freeze({ observe, recordMiss, finish });
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
  for (const field of ['platform', 'arch', 'os', 'disk_available_bytes']) if (!available(identity.machine[field])) throw Error(`Invalid ${label} machine.${field}`);
  if (identity.machine.platform === 'darwin' ? !available(identity.machine.hardware_model) : identity.machine.hardware_model !== null) throw Error(`Invalid ${label} machine.hardware_model`);
  for (const field of ['power_source', 'low_power_mode', 'thermal']) if (typeof identity.machine[field] !== 'string' || identity.machine[field] === '') throw Error(`Invalid ${label} machine.${field}`);
  return identity;
}

// Live storage checks race removals: the app publishes reports through a temp
// file it then removes, and SQLite deletes its rollback journal after each
// write. A vanished entry holds no bytes, so ENOENT counts zero and every other
// error reaches the caller. Names that are not valid UTF-8 list as U+FFFD: such
// a name never stats, and it can shadow a twin, so neither case is a vanish.
const vanished = error => error?.code === 'ENOENT';

export function directoryBytes(directory, filesystem = { readdirSync, lstatSync }) {
  let names;
  try {
    names = filesystem.readdirSync(directory);
  } catch (error) {
    if (vanished(error)) return 0;
    throw error;
  }
  if (new Set(names).size !== names.length) throw Error(`Entry names collide after decoding in ${directory}`);
  return names.reduce((sum, name) => {
    const path = join(directory, name);
    let stats;
    try {
      stats = filesystem.lstatSync(path);
    } catch (error) {
      if (vanished(error) && !name.includes('\uFFFD')) return sum;
      throw error;
    }
    return sum + (stats.isDirectory() ? directoryBytes(path, filesystem) : stats.size);
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

// The code on a refused budgeted write, so a caller can tell the refusal from a
// failure to measure the budget directory.
export const STORAGE_BUDGET_REFUSED = 'ERR_STORAGE_BUDGET_REFUSED';

/**
 * Write a caller's closing evidence after a collector's ledger, the way the
 * collector writes its ledger. Writes are measured against the budget until
 * one fails for any reason other than a refusal, which is how a tree that can
 * no longer be walked shows. After that they skip the walk.
 *
 * A failure is not thrown. The first one is kept for the caller to throw when
 * the run failed for no reason of its own, so a closing write never replaces
 * that reason. A refused write still throws.
 *
 * A collector that already wrote its ledger unmeasured starts this unmeasured.
 * Skipped walks leave these files outside the ceiling.
 */
export function closingEvidenceWriter(budgetDirectory, budgetBytes, measurable) {
  let measured = measurable;
  const writer = {
    error: null,
    write(path, value) {
      if (measured) {
        try {
          writeJsonAtomic(path, value, { budgetDirectory, budgetBytes });
          return;
        } catch (error) {
          if (error.code === STORAGE_BUDGET_REFUSED) throw error;
          measured = false;
          writer.error ??= error;
        }
      }
      try {
        writeJsonAtomic(path, value);
      } catch (error) {
        writer.error ??= error;
      }
    },
  };
  return writer;
}

export function writeJsonAtomic(path, value, { budgetDirectory = null, budgetBytes = null } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  const serialized = `${JSON.stringify(value)}\n`;
  if (budgetDirectory !== null) {
    if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 1) throw Error('Atomic JSON budget must be a positive safe integer');
    if (directoryBytes(budgetDirectory) + Buffer.byteLength(serialized) > budgetBytes) throw Object.assign(Error('Atomic JSON replacement would exceed the storage budget'), { code: STORAGE_BUDGET_REFUSED });
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

/**
 * Write one harness evidence file in a directory the measured child shares.
 * Exclusive creation never follows a link, never opens a FIFO, and refuses
 * anything already at the path, so a child can neither stall nor redirect it.
 */
export function createEvidenceFile(path, data) {
  writeFileSync(path, data, { flag: 'wx' });
}

/** Rewrite an evidence file the harness owns: drop the entry unopened (a directory is refused), then create it anew. */
export function replaceEvidenceFile(path, data) {
  rmSync(path, { force: true });
  createEvidenceFile(path, data);
}

/**
 * Read a small file the measured child left in a directory it shares. Only a
 * regular file with one link under maxBytes is read; anything else returns null.
 * Windows has no O_NOFOLLOW, so the entry is checked unopened first: a link
 * already there is never opened. The descriptor must then be that same file,
 * so an entry swapped in after the check is opened but refused. A FIFO never
 * blocks. Throws when the entry is missing or cannot be opened; `open` is for
 * tests.
 */
export function readOwnedRegularFile(path, maxBytes, open = openSync) {
  const entry = lstatSync(path, { bigint: true });
  if (!entry.isFile()) return null;
  const fd = open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (opened.dev !== entry.dev || opened.ino !== entry.ino || !opened.isFile() || opened.nlink !== 1n || Number(opened.size) >= maxBytes) return null;
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Give a reaped child's output pipes `graceMs` to reach EOF. A process that left
 * the owned group can hold them open for as long as it lives, so after the grace
 * and one more event-loop turn (which reads an EOF that is already pending) both
 * are destroyed. Resolves null once both ended, or a message recording them as
 * held.
 */
export function drainChildOutput(streams, graceMs) {
  const open = streams.filter(stream => stream && !stream.readableEnded && !stream.closed);
  const ended = () => open.every(stream => stream.readableEnded || stream.closed);
  if (ended()) return Promise.resolve(null);
  return new Promise(resolveDrain => {
    let settled = false, deadline = null;
    const settle = drained => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (!drained) for (const stream of open) stream.destroy();
      resolveDrain(drained ? null : 'The output pipes were still held one kill grace after the reap, most likely by a process outside the owned group');
    };
    const settleIfEnded = () => { if (ended()) settle(true); };
    for (const stream of open) { stream.once('end', settleIfEnded); stream.once('close', settleIfEnded); }
    deadline = setTimeout(() => setImmediate(() => settle(ended())), graceMs);
  });
}

/**
 * Read a file the measured child left, through one descriptor so the child can
 * neither redirect nor stall the read: a FIFO opens without blocking, and only a
 * regular file of at most `maxBytes` that no other path links to is read. A
 * symbolic link is refused wherever the platform has O_NOFOLLOW (Windows does
 * not). The check and the read share the descriptor, so a swap after the open
 * changes nothing; a file unlinked since then has no links and is still its own.
 */
export function readChildFile(path, maxBytes) {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.nlink > 1) throw Error('Not a regular file of its own');
    // A live child can still append, so the read itself is bounded too.
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    for (let read; length < buffer.length && (read = readSync(descriptor, buffer, length, buffer.length - length, length)) > 0;) length += read;
    if (length > maxBytes) throw Error(`Larger than ${maxBytes} bytes`);
    return buffer.subarray(0, length);
  } finally {
    closeSync(descriptor);
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

function diskAvailableBytes(directory) {
  try {
    const facts = statfsSync(directory);
    const bytes = facts.bavail * facts.bsize;
    return Number.isSafeInteger(bytes) && bytes >= 0 ? String(bytes) : 'unavailable';
  } catch { return 'unavailable'; }
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
      os: `${osVersion()} (${osRelease()})`,
      hardware_model: process.platform === 'darwin' ? commandValue('/usr/sbin/sysctl', ['-n', 'hw.model']) : null,
      power_source: process.platform === 'darwin' ? commandValue('/usr/bin/pmset', ['-g', 'batt']) : 'unavailable',
      low_power_mode: process.platform === 'darwin' ? commandValue('/usr/bin/pmset', ['-g', 'custom']) : 'unavailable',
      thermal: process.platform === 'darwin' ? commandValue('/usr/bin/pmset', ['-g', 'therm']) : 'unavailable',
      disk_available_bytes: diskAvailableBytes(cwd),
    },
  };
}

/**
 * The Windows launcher (crates/goop-owned-run) that runs each owned process in
 * a job ending with it, from GOOP_OWNED_RUN or this checkout's debug build.
 * Without it a Windows stop could only name pids, so its absence is refused,
 * and so is a link, as for the suite's other executables.
 */
export function ownedRunPath(environment = process.env) {
  const path = resolve(environment.GOOP_OWNED_RUN || join(dirname(fileURLToPath(import.meta.url)), '..', 'target', 'debug', 'goop-owned-run.exe'));
  let found = false;
  try { found = lstatSync(path).isFile(); } catch { /* Missing: refused below. */ }
  if (!found) throw Error(`Windows runs need the owned-process launcher, a regular file, at ${path}: build it with \`cargo build -p goop-owned-run\` or set GOOP_OWNED_RUN`);
  return path;
}

/**
 * How to launch one owned process: under /usr/bin/time -l on macOS (for its
 * peak memory), inside the launcher's job on Windows, and as given elsewhere.
 * The launcher's stdin is its stop request, so it is a pipe the stop closes.
 * Spawned without `detached`, the launcher also sits in Node's own job, so a
 * harness that dies takes it, and with it the whole job, along.
 */
export function ownedLaunch(command, args, { platform = process.platform, environment = process.env } = {}) {
  if (platform === 'darwin') return { command: '/usr/bin/time', args: ['-l', command, ...args], stdin: 'ignore' };
  if (platform === 'win32') return { command: ownedRunPath(environment), args: [command, ...args], stdin: 'pipe' };
  return { command, args, stdin: 'ignore' };
}

/**
 * Stop one owned process group, once. POSIX signals the whole group: SIGTERM,
 * then SIGKILL after the grace. On Windows the child is the launcher from
 * ownedLaunch, which holds the group in a job: closing its stdin asks it to
 * end the job, and it exits only once the job is empty. A launcher still
 * running after the grace is killed through Node's own handle, which closes
 * the job and so ends the rest. No pid is ever named, and nothing is done once
 * Node has seen the launcher exit, since its pid may by then be anyone's.
 * stop() returns one promise for every caller: on POSIX it settles once the
 * forced signal is sent, on Windows once the launcher exits (at most a second
 * grace after the kill). A POSIX group kill misses a member being forked at
 * that instant, so once the forced kill is sent, killAgain() sends another
 * until a group kill reports the group gone. `sleep`, `platform` and
 * `killGroup` are for tests.
 */
export function createOwnedGroupStopper(child, {
  killGraceMs,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  platform = process.platform,
  killGroup = (pid, name) => process.kill(-pid, name),
}) {
  let stopping = null, killSent = false, groupGone = false;
  // Node keeps the child's handle, and with it the pid, until it reports the exit.
  const held = () => child.pid !== undefined && child.exitCode === null && child.signalCode === null;
  const signal = name => {
    try {
      killGroup(child.pid, name);
      return true;
    } catch (error) {
      // An empty group's id is free for reuse, so never signal it again. A
      // group of zombies reports EPERM on macOS until they are reaped.
      if (error?.code === 'ESRCH') groupGone = true;
      return false;
    }
  };
  const stop = () => {
    if (stopping) return stopping;
    if (platform === 'win32') {
      if (!held()) return (stopping = Promise.resolve());
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.stdin?.destroy();
      // A grace the sleep rejects ends at once, and never fails the stop.
      const grace = () => sleep(killGraceMs).then(() => {}, () => {});
      const kill = () => { try { if (held()) child.kill('SIGKILL'); } catch { /* Its job closes when it goes. */ } };
      // The killed launcher's exit means its job is closed; a second grace bounds that wait.
      stopping = Promise.race([exited, grace().then(kill).then(() => held() ? Promise.race([exited, grace()]) : undefined)]);
      return stopping;
    }
    // A grace the sleep rejects (a delay that is not a number) escalates at once.
    const kill = () => { killSent = true; signal('SIGKILL'); };
    stopping = signal('SIGTERM') ? sleep(killGraceMs).then(kill, kill) : Promise.resolve();
    return stopping;
  };
  // No SIGKILL is sent before the grace ends. Windows ends the whole job instead.
  const killAgain = () => { if (killSent && !groupGone && platform !== 'win32') signal('SIGKILL'); };
  return { stop, killAgain };
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
  samplingIntervalMs = 100,
  nowMs = () => performance.now(),
  sleepMs = (ms, wait) => delay(ms, undefined, wait),
  killGroup = (pid, name) => process.kill(-pid, name),
  readSnapshot = () => execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8', timeout: 1000 }),
  measureBytes = directoryBytes,
}) {
  if (abortSignal?.aborted) throw Error('Process run aborted before launch');
  // Node turns an interval below 1 ms or above 2^31-1 ms into 1 ms, so a bad
  // value would sample nonstop.
  if (!Number.isSafeInteger(samplingIntervalMs) || samplingIntervalMs < 1 || samplingIntervalMs > 2 ** 31 - 1) throw Error('Sampling interval must be a whole number of milliseconds from 1 to 2147483647');
  const launch = ownedLaunch(command, args);
  const initialEntries = new Set(existsSync(outputDirectory) ? readdirSync(outputDirectory) : []);
  if (symlinksBelow(outputDirectory).length > 0) throw Error('Owned output directory must not contain symbolic links');
  const child = spawn(launch.command, launch.args, { cwd, env, detached: process.platform !== 'win32', stdio: [launch.stdin, 'pipe', 'pipe'] });
  let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), retainedLogBytes = 0, timedOut = false, budgetExceeded = false, aborted = false, spawnError = null;
  let stopRequested = false, sampledTreePeakKiB = null, observedChildren = null;
  const group = createOwnedGroupStopper(child, { killGraceMs, sleep: sleepMs, killGroup });
  const retain = (current, chunk) => { const kept=chunk.subarray(0,Math.max(0,logLimitBytes-retainedLogBytes));retainedLogBytes+=kept.length;return Buffer.concat([current,kept]); };
  child.stdout.on('data', chunk => { stdout = retain(stdout, chunk); });
  child.stderr.on('data', chunk => { stderr = retain(stderr, chunk); });
  // The first stop names the cause; every later call waits on the same stop.
  const stop = reason => {
    if (!stopRequested) {
      stopRequested = true;
      aborted = reason === 'abort';
      timedOut = reason === 'timeout';
    }
    return group.stop();
  };
  const abort = () => stop('abort');
  abortSignal?.addEventListener('abort', abort, { once: true });
  // Vanished entries count zero, so a throw from the count is a real read
  // failure that would leave the live budget blind for the rest of the run.
  const overBudget = () => {
    try { return measureBytes(outputDirectory) + stdout.length + stderr.length > storageBudgetBytes; } catch { return true; }
  };
  const monitor = setInterval(() => {
    // A group kill misses a member that is being forked at that instant, and
    // such a member can hold the pipes and keep the drain waiting. Once the
    // group has been killed, kill it again every interval until the drain ends
    // or the group is gone.
    group.killAgain();
    if (process.platform !== 'win32') {
      try {
        const sample = processTreeRss(readSnapshot(), child.pid);
        if (sample) {
          sampledTreePeakKiB = Math.max(sampledTreePeakKiB ?? 0, sample.rssKiB);
          observedChildren = Math.max(observedChildren ?? 0, sample.children);
        }
      } catch { /* ps can time out under load; a missed sample is not an overrun. */ }
    }
    if (overBudget()) {
      budgetExceeded = true;
      stop('budget');
    }
  }, samplingIntervalMs);
  // sleepMs(ms, { signal }) must reject once signal aborts, as the default does,
  // so a run that exits first cancels its timeout instead of stopping a dead group.
  // Any other rejection (a delay that is not a number) times the run out at once.
  const timeout = new AbortController();
  sleepMs(timeoutMs, { signal: timeout.signal }).then(() => stop('timeout'), () => { if (!timeout.signal.aborted) stop('timeout'); });
  const start = nowMs();
  // The root's exit, not its pipes' EOF: a process that left the group can hold
  // the pipes open for as long as it lives.
  const code = await new Promise(resolve => {
    child.once('error', error => { spawnError = error.message; resolve(null); });
    child.once('exit', value => resolve(value));
  });
  timeout.abort();
  abortSignal?.removeEventListener('abort', abort);
  // Confirm the entire owned group is gone even when the root exits cleanly;
  // adapters may otherwise leave ignored-stdio descendants behind.
  await stop();
  // The monitor runs until the drain ends, so a member the group kill missed is
  // killed again while it holds the pipes.
  const stdioError = await drainChildOutput([child.stdout, child.stderr], killGraceMs);
  clearInterval(monitor);
  // A missed member that holds none of the pipes can outlive the drain, so kill
  // the group once more after it.
  group.killAgain();
  // Counted after the reap and the drain, so whatever the group wrote during its
  // kill grace, and the output read since the exit, are included.
  try {
    budgetExceeded ||= measureBytes(outputDirectory) + retainedLogBytes > storageBudgetBytes;
  } catch {
    budgetExceeded = true;
  }
  let removedStagingDirectories = 0, cleanupError = null, outputError = null;
  // A scan that cannot read the tree fails the run instead of rejecting it and
  // losing what the run reported, held pipes included.
  let createdSymlinks = [];
  try { createdSymlinks = symlinksBelow(outputDirectory); } catch (error) { outputError = `Owned output could not be checked for symbolic links: ${error.message}`; }
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
    success: code === 0 && !timedOut && !budgetExceeded && !aborted && spawnError === null && cleanupError === null && outputError === null && stdioError === null,
    exit_code: code,
    timed_out: timedOut,
    budget_exceeded: budgetExceeded,
    aborted,
    spawn_error: spawnError,
    cleanup_error: cleanupError,
    output_error: outputError,
    stdio_error: stdioError,
    removed_staging_directories: removedStagingDirectories,
    lifetime_ms: nowMs() - start,
    sampled_tree_peak_KiB: sampledTreePeakKiB,
    sampling_interval_ms: samplingIntervalMs,
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
