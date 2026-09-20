import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readdirSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { run as runSingleConversion } from './performance-baseline.mjs';
import { runStartup } from './startup-baseline.mjs';
import {
  captureIdentity,
  createOwnedDirectory,
  directoryBytes,
  removeOwnedDirectory,
  runBoundedProcess,
  sha256File,
  stableStringify,
  validateCapturedIdentity,
  writeJsonAtomic,
} from './performance-shared.mjs';
import {
  PERFORMANCE_LIMITATIONS,
  parseManifest,
  revalidateBindings,
  validateEffectiveExecution,
  validateMediaProbe,
  validateBindings,
} from './performance-manifest.mjs';

const modulePath = fileURLToPath(import.meta.url);
const STATE_RESULT_LIMIT_BYTES = 256 * 1024;

const extensionFor = expected => expected.extension === 'jpeg' ? 'jpg' : expected.extension;

export function buildRunPlan(manifestInput) {
  const manifest = parseManifest(manifestInput);
  const plan = [];
  for (const workload of manifest.workloads) {
    const warmups = workload.warmups ?? manifest.defaults.warmups;
    const repetitions = workload.repetitions ?? manifest.defaults.repetitions;
    for (let index = -warmups; index < repetitions; index++) {
      const phase = index < 0 ? 'warmup' : 'measured';
      const sample = index < 0 ? `warmup-${index + warmups}` : String(index);
      plan.push({
        id: `${workload.id}/${sample}`,
        workload_id: workload.id,
        workload,
        phase,
        repetition: index < 0 ? null : index,
        destination: join(workload.id, sample),
        limits: {
          timeout_ms: workload.timeout_ms ?? manifest.defaults.timeout_ms,
          log_limit_bytes: workload.log_limit_bytes ?? manifest.defaults.log_limit_bytes,
          storage_budget_bytes: workload.storage_budget_bytes ?? manifest.defaults.storage_budget_bytes,
        },
      });
    }
  }
  return plan;
}

function numericMetric(result) {
  for (const field of ['process_ms', 'aggregate_ms', 'launch_to_ready_ms', 'lifetime_ms']) {
    if (Number.isFinite(result?.[field]) && result[field] >= 0) return result[field];
  }
  return null;
}

function metricSummary(values, total) {
  const measured = values.filter(Number.isFinite).sort((a, b) => a - b);
  return {
    median: measured.length ? (measured[Math.floor((measured.length - 1) / 2)] + measured[Math.floor(measured.length / 2)]) / 2 : null,
    min: measured.length ? measured[0] : null,
    max: measured.length ? measured.at(-1) : null,
    measured: measured.length,
    not_measured: total - measured.length,
  };
}

const PHASE_FIELDS = ['process_ms', 'aggregate_ms', 'wall_ms', 'encoder_detection_ms', 'launch_to_ready_ms', 'lifetime_ms', 'verification_ms'];
const ITEM_PHASE_FIELDS = ['elapsed_ms', 'source_fingerprint_before_ms', 'source_fingerprint_after_ms', 'admission_ms', 'process_ms', 'probe_ms'];

function outputBytes(result) {
  if (Number.isSafeInteger(result?.verification?.output_bytes) && result.verification.output_bytes >= 0) return result.verification.output_bytes;
  if (Array.isArray(result?.items) && result.items.length > 0 && result.items.every(item => Number.isSafeInteger(item.output_bytes) && item.output_bytes >= 0)) return result.items.reduce((sum, item) => sum + item.output_bytes, 0);
  return null;
}

function persistFullResult(result, absoluteEvidenceDirectory, evidenceDirectory) {
  if (Buffer.byteLength(JSON.stringify(result)) <= STATE_RESULT_LIMIT_BYTES) return null;
  mkdirSync(absoluteEvidenceDirectory, { recursive: true });
  const absolutePath = join(absoluteEvidenceDirectory, 'full-result.json');
  writeJsonAtomic(absolutePath, result);
  return { evidence_directory: evidenceDirectory, full_result_path: join(evidenceDirectory, 'full-result.json'), full_result_bytes: statSync(absolutePath).size, full_result_sha256: sha256File(absolutePath), full_result_retained: true };
}

function ledgerResult(result, fullResult) {
  if (fullResult === null) return result;
  const fields = ['success', 'error', 'process_ms', 'aggregate_ms', 'wall_ms', 'encoder_detection_ms', 'launch_to_ready_ms', 'lifetime_ms', 'verification_ms', 'timed_out', 'budget_exceeded', 'time_budget_exceeded', 'log_budget_exceeded'];
  return {
    ...Object.fromEntries(fields.filter(field => result[field] !== undefined).map(field => [field, result[field]])),
    evidence_compacted: true,
    ...fullResult,
  };
}

function markOwnedPayloadRemoved(result) {
  const { evidence_directory: _evidenceDirectory, full_result_path: _fullResultPath, ...retained } = result;
  return { ...retained, owned_payload_removed: true, ...(result.full_result_path ? { full_result_retained: false } : {}) };
}

export function summarizeSuite(samples, manifest) {
  const workloads = {};
  for (const workload of manifest.workloads) {
    const relevant = samples.filter(sample => sample.workload_id === workload.id && sample.phase === 'measured');
    const successful = relevant.filter(sample => sample.status === 'success');
    const values = successful.map(sample => numericMetric(sample.result));
    const memory = successful.map(sample => sample.result?.sampled_tree_peak_KiB ?? sample.result?.process?.sampled_tree_peak_KiB ?? null);
    const timePeak = successful.map(sample => sample.result?.time_peak_bytes ?? sample.result?.process?.time_peak_bytes ?? null);
    const outputs = successful.map(sample => outputBytes(sample.result));
    const phaseTimings = Object.fromEntries(PHASE_FIELDS.map(field => [field, metricSummary(successful.map(sample => sample.result?.[field]), successful.length)]));
    const items = successful.flatMap(sample => Array.isArray(sample.result?.items) ? sample.result.items : []);
    workloads[workload.id] = {
      success: relevant.length > 0 && relevant.every(sample => sample.status === 'success'),
      successes: successful.length,
      failed: relevant.filter(sample => sample.status === 'failed').length,
      excluded: samples.filter(sample => sample.workload_id === workload.id && sample.status === 'excluded').length,
      not_measured: relevant.filter(sample => numericMetric(sample.result) === null).length,
      duration_ms: metricSummary(values, successful.length),
      sampled_tree_peak_KiB: metricSummary(memory, successful.length),
      time_peak_bytes: metricSummary(timePeak, successful.length),
      output_bytes: metricSummary(outputs, successful.length),
      phase_timings_ms: phaseTimings,
      item_phase_timings_ms: items.length === 0 ? null : Object.fromEntries(ITEM_PHASE_FIELDS.map(field => [field, metricSummary(items.map(item => item?.[field]), items.length)])),
    };
  }
  return { success: Object.values(workloads).every(workload => workload.success), workloads };
}

export async function runPerformanceSuite({
  manifest: manifestInput,
  bindings: bindingInput,
  outputDirectory,
  execute,
  prevalidatedBindings = false,
  identity = null,
}) {
  const manifest = parseManifest(manifestInput);
  const bindings = prevalidatedBindings ? bindingInput : validateBindings(manifest, bindingInput);
  const plan = buildRunPlan(manifest);
  const statePath = join(outputDirectory, 'suite-state.json');
  const state = {
    schema_version: 1,
    suite_id: manifest.suite_id,
    status: 'running',
    limitations: manifest.limitations,
    identity,
    samples: [],
    summary: null,
  };
  const requiredLedgerBytes = Buffer.byteLength(JSON.stringify(state)) + plan.length * (STATE_RESULT_LIMIT_BYTES + 2048) + 65536;
  if (manifest.defaults.suite_storage_budget_bytes < requiredLedgerBytes) throw Error(`Suite storage budget is too small for the bounded evidence ledger; require at least ${requiredLedgerBytes} bytes`);
  createOwnedDirectory(outputDirectory);
  writeJsonAtomic(statePath, state);
  let fatal = null;
  const suiteStarted = performance.now();
  let retainedLogBytes = 0;
  const summarySamples = [];
  for (const run of plan) {
    if (directoryBytes(outputDirectory) > manifest.defaults.suite_storage_budget_bytes) {
      const result = { success: false, not_run: true, budget_exceeded: true, error: 'Suite storage budget exceeded before launch' };
      const sample = { id: run.id, workload_id: run.workload_id, phase: run.phase, repetition: run.repetition, status: 'failed', result };
      summarySamples.push(sample);state.samples.push(sample);
      fatal = 'Suite storage budget exceeded before launch';
      state.summary = summarizeSuite(summarySamples, manifest);
      writeJsonAtomic(statePath, state);
      break;
    }
    const rawRemainingMs = manifest.defaults.suite_timeout_ms - (performance.now() - suiteStarted);
    if (rawRemainingMs <= 0) {
      const result = { success: false, not_run: true, time_budget_exceeded: true, error: 'Suite time budget exceeded before launch' };
      const sample = { id: run.id, workload_id: run.workload_id, phase: run.phase, repetition: run.repetition, status: 'failed', result };
      summarySamples.push(sample);state.samples.push(sample);
      fatal = 'Suite time budget exceeded before launch';
      state.summary = summarizeSuite(summarySamples, manifest);
      writeJsonAtomic(statePath, state);
      break;
    }
    const remainingMs = Math.max(1, Math.floor(rawRemainingMs));
    run.limits.timeout_ms = Math.min(run.limits.timeout_ms, remainingMs);
    let result;
    try {
      result = await execute({ ...run, output_directory: join(outputDirectory, run.destination), bindings, manifest });
      if (result === null || typeof result !== 'object') throw Error('Adapter returned no result');
    } catch (error) {
      result = { success: false, error: error.message };
    }
    const fullResult = persistFullResult(result, join(outputDirectory, run.destination), run.destination);
    let status = result.success === true ? (run.phase === 'warmup' ? 'excluded' : 'success') : 'failed';
    const runBudgetExceeded = directoryBytes(join(outputDirectory, run.destination)) > run.limits.storage_budget_bytes;
    const totalBudgetExceeded = directoryBytes(outputDirectory) > manifest.defaults.suite_storage_budget_bytes;
    retainedLogBytes += result?.log_bytes_retained ?? result?.process?.log_bytes_retained ?? 0;
    const logBudgetExceeded = retainedLogBytes > manifest.defaults.suite_log_limit_bytes;
    const timeBudgetExceeded = performance.now() - suiteStarted > manifest.defaults.suite_timeout_ms;
    if (runBudgetExceeded) {
      status = 'failed';
      result = { ...result, success: false, budget_exceeded: true, error: 'Workload storage budget exceeded while retaining full evidence' };
      fatal ??= `Workload storage budget exceeded: ${run.id}`;
    } else if (totalBudgetExceeded) {
      status = 'failed';
      result = { ...result, success: false, budget_exceeded: true, error: 'Suite storage budget exceeded' };
      fatal ??= 'Suite storage budget exceeded';
    }
    if (timeBudgetExceeded) {
      status = 'failed';
      result = { ...result, success: false, time_budget_exceeded: true, error: 'Suite time budget exceeded' };
      fatal ??= 'Suite time budget exceeded';
    }
    if (logBudgetExceeded) {
      status = 'failed';
      result = { ...result, success: false, log_budget_exceeded: true, error: 'Suite retained-log budget exceeded' };
      fatal ??= 'Suite retained-log budget exceeded';
    }
    const summarySample = {
      id: run.id,
      workload_id: run.workload_id,
      phase: run.phase,
      repetition: run.repetition,
      status,
      result,
    };
    summarySamples.push(summarySample);
    state.samples.push({ ...summarySample, result: ledgerResult(result, fullResult) });
    if (status === 'failed') fatal ??= `Workload failed: ${run.id}`;
    let sourceIntegrityFailed = false;
    try { revalidateBindings(manifest, bindings); }
    catch (error) {
      fatal ??= error.message;
      sourceIntegrityFailed = true;
      state.samples.at(-1).status = 'failed';
      state.samples.at(-1).result = { ...state.samples.at(-1).result, success: false, source_integrity_error: error.message };
      summarySamples.at(-1).status = 'failed';
      summarySamples.at(-1).result = { ...summarySamples.at(-1).result, success: false, source_integrity_error: error.message };
    }
    state.summary = summarizeSuite(summarySamples, manifest);
    writeJsonAtomic(statePath, state);
    if (runBudgetExceeded) {
      removeOwnedDirectory(join(outputDirectory, run.destination));
      state.samples.at(-1).result = markOwnedPayloadRemoved(state.samples.at(-1).result);
      summarySamples.at(-1).result = { ...summarySamples.at(-1).result, owned_payload_removed: true };
      writeJsonAtomic(statePath, state);
      break;
    }
    if (directoryBytes(outputDirectory) > manifest.defaults.suite_storage_budget_bytes && !totalBudgetExceeded) {
      state.samples.at(-1).status = 'failed';
      removeOwnedDirectory(join(outputDirectory, run.destination));
      state.samples.at(-1).result = { ...markOwnedPayloadRemoved(state.samples.at(-1).result), success: false, budget_exceeded: true, error: 'Suite storage budget exceeded while retaining evidence' };
      summarySamples.at(-1).status = 'failed';
      summarySamples.at(-1).result = { ...summarySamples.at(-1).result, success: false, budget_exceeded: true, owned_payload_removed: true, error: 'Suite storage budget exceeded while retaining evidence' };
      fatal ??= 'Suite storage budget exceeded while retaining evidence';
      state.summary = summarizeSuite(summarySamples, manifest);
      writeJsonAtomic(statePath, state);
      break;
    }
    if (totalBudgetExceeded) {
      removeOwnedDirectory(join(outputDirectory, run.destination));
      state.samples.at(-1).result = markOwnedPayloadRemoved(state.samples.at(-1).result);
      summarySamples.at(-1).result = { ...summarySamples.at(-1).result, owned_payload_removed: true };
      writeJsonAtomic(statePath, state);
    }
    if (sourceIntegrityFailed || runBudgetExceeded || totalBudgetExceeded || timeBudgetExceeded || logBudgetExceeded) break;
  }
  state.status = fatal ? 'failed' : 'complete';
  state.summary = summarizeSuite(summarySamples, manifest);
  writeJsonAtomic(statePath, state);
  if (fatal) throw Error(fatal);
  return state;
}

function expectedWorkloadIds(request) {
  return request.mode === 'inspection_burst'
    ? request.sources.map(source => source.id)
    : request.items.map(item => item.id);
}

export function validateWorkloadMetrics(metrics, request, processResult, expectedSources) {
  const rootFields = new Set(['schema_version', 'mode', 'success', 'aggregate_ms', 'wall_ms', 'encoder_detection_ms', 'max_observed_concurrency', 'items', 'error', 'memory_evidence', 'path_safety_limitation']);
  if (metrics === null || typeof metrics !== 'object' || Array.isArray(metrics) || Object.keys(metrics).some(field => !rootFields.has(field))) return false;
  if (metrics?.schema_version !== 1 || metrics.mode !== request.mode || typeof metrics.success !== 'boolean' || !Number.isFinite(metrics.aggregate_ms) || metrics.aggregate_ms < 0 || !Number.isFinite(metrics.wall_ms) || metrics.wall_ms < 0 || !Number.isFinite(metrics.encoder_detection_ms) || metrics.encoder_detection_ms < 0 || !Array.isArray(metrics.items)) return false;
  if (typeof metrics.memory_evidence !== 'string' || metrics.memory_evidence === '' || typeof metrics.path_safety_limitation !== 'string' || metrics.path_safety_limitation === '') return false;
  if (request.mode === 'inspection_burst' && metrics.max_observed_concurrency !== null) return false;
  if (request.mode === 'conversion_batch' && (!Number.isSafeInteger(metrics.max_observed_concurrency) || metrics.max_observed_concurrency < 0 || metrics.max_observed_concurrency > request.concurrency)) return false;
  const expected = expectedWorkloadIds(request);
  const actual = metrics.items.map(item => item?.id);
  if (actual.length !== expected.length || new Set(actual).size !== actual.length || actual.some((id, index) => id !== expected[index])) return false;
  const itemFields = request.mode === 'inspection_burst'
    ? new Set(['id', 'success', 'elapsed_ms', 'error', 'input_path', 'source_sha256', 'inspection', 'cache_reuse', 'cancelled', 'start_offset_ms', 'end_offset_ms', 'source_fingerprint_before_ms', 'source_fingerprint_after_ms', 'admission_ms', 'process_ms', 'probe_ms'])
    : new Set(['id', 'success', 'elapsed_ms', 'error', 'request', 'output_path', 'source_sha256', 'result', 'output_bytes', 'effective_execution', 'cancelled', 'start_offset_ms', 'end_offset_ms', 'source_fingerprint_before_ms', 'source_fingerprint_after_ms', 'admission_ms', 'process_ms', 'probe_ms']);
  const itemsValid = metrics.items.every(item => {
    if (item === null || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(field => !itemFields.has(field))) return false;
    if (item.success !== true || !Number.isFinite(item.elapsed_ms) || item.elapsed_ms < 0) return false;
    for (const field of ['start_offset_ms', 'end_offset_ms', 'source_fingerprint_before_ms', 'source_fingerprint_after_ms']) if (!Number.isFinite(item[field]) || item[field] < 0) return false;
    if (item.cancelled !== false || item.end_offset_ms < item.start_offset_ms) return false;
    if (!/^[0-9a-f]{64}$/.test(item.source_sha256)) return false;
    const expectedSource = expectedSources?.[item.id];
    if (!expectedSource || item.source_sha256 !== expectedSource.source_sha256) return false;
    if (request.mode === 'inspection_burst') return item.input_path === expectedSource.input_path && item.inspection !== undefined && item.cache_reuse === 'not_exposed' && item.admission_ms === null && item.process_ms === null && Number.isFinite(item.probe_ms) && item.probe_ms >= 0;
    try { validateEffectiveExecution(item.effective_execution?.video, expectedSource.request); } catch { return false; }
    return item.output_path === expectedSource.output_path && stableStringify(item.request) === stableStringify(expectedSource.request) && item.result !== undefined && Number.isSafeInteger(item.output_bytes) && item.output_bytes >= 0 && item.effective_execution !== undefined && Number.isFinite(item.admission_ms) && item.admission_ms >= 0 && Number.isFinite(item.process_ms) && item.process_ms >= 0 && item.probe_ms === null;
  });
  return metrics.success === true && processResult.success === true && itemsValid;
}

export function resolveBundledSidecar(directory, name) {
  const named = readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.name === name || entry.name === `${name}.exe` || entry.name.startsWith(`${name}-`))
    .map(entry => join(directory, entry.name));
  if (named.some(path => !lstatSync(path).isFile())) throw Error(`Bundled ${name} sidecar must be a regular non-symlink file`);
  const candidates = named;
  if (candidates.length !== 1) throw Error(`Expected exactly one bundled ${name} sidecar, found ${candidates.length}`);
  return candidates[0];
}

function sidecarFiles(directory) {
  const entries = readdirSync(directory, { withFileTypes: true });
  const unsupported = entries.find(entry => entry.isSymbolicLink());
  if (unsupported) throw Error(`Bundled sidecar entries must not be symlinks: ${unsupported.name}`);
  return Object.fromEntries(entries.filter(entry => entry.isFile()).map(entry => [entry.name, join(directory, entry.name)]));
}

export function verifyBatchOutputs(metrics, request, ffprobe, expectedItems = request.items) {
  const checks = [];
  try {
    if (!statSync(ffprobe).isFile()) throw Error('Bundled ffprobe is missing');
    for (const requested of request.items) {
      const measured = metrics.items.find(item => item.id === requested.id);
      const expected = expectedItems.find(item => item.id === requested.id);
      if (!expected) throw Error(`Missing output expectation for ${requested.id}`);
      const outputPath = requested.request.output_path;
      const bytes = statSync(outputPath).size;
      if (bytes !== measured.output_bytes) throw Error(`Output byte count differs for ${requested.id}`);
      const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', outputPath], { encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 }));
      validateMediaProbe(probe, expected.expected_output);
      checks.push({ id: requested.id, output_bytes: bytes, probe });
    }
    return { success: true, checks };
  } catch (error) {
    return { success: false, checks, error: error.message };
  }
}

export async function executeWorkloadAdapter(run, drivers) {
  mkdirSync(run.output_directory, { recursive: true });
  const workload = run.workload;
  let request, expectedSources;
  if (workload.mode === 'inspection_burst') {
    const sources = Array.from({ length: workload.source_count }, (_, index) => {
      const role = workload.fixture_roles[index % workload.fixture_roles.length];
      return { id: `source-${String(index).padStart(4, '0')}`, input_path: run.bindings[role].path };
    });
    request = { schema_version: 1, mode: 'inspection_burst', suite_dir: run.output_directory, sources };
    expectedSources = Object.fromEntries(sources.map((source, index) => {
      const role = workload.fixture_roles[index % workload.fixture_roles.length];
      return [source.id, { input_path: source.input_path, source_sha256: run.bindings[role].sha256 }];
    }));
  } else {
    const items = workload.items.map(item => ({
      id: item.id,
      request: {
        ...item.request,
        input_path: run.bindings[item.fixture_role].path,
        output_path: join(run.output_directory, `${item.id}.${extensionFor(item.expected_output)}`),
      },
    }));
    request = { schema_version: 1, mode: 'conversion_batch', suite_dir: run.output_directory, concurrency: workload.concurrency, items };
    expectedSources = Object.fromEntries(items.map((item, index) => [item.id, {
      request: item.request,
      output_path: item.request.output_path,
      source_sha256: run.bindings[workload.items[index].fixture_role].sha256,
    }]));
  }
  const requestPath = join(run.output_directory, 'request.json');
  const metricsPath = join(run.output_directory, 'metrics.json');
  writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`);
  const processResult = await runBoundedProcess({
    command: drivers.workloadDriver,
    args: [drivers.sidecars, requestPath, metricsPath],
    outputDirectory: run.output_directory,
    timeoutMs: run.limits.timeout_ms,
    logLimitBytes: run.limits.log_limit_bytes,
    storageBudgetBytes: run.limits.storage_budget_bytes,
  });
  writeFileSync(join(run.output_directory, 'stdout.log'), processResult.stdout);
  writeFileSync(join(run.output_directory, 'stderr.log'), processResult.stderr);
  let metrics = null;
  try {
    if (statSync(metricsPath).size > Math.min(run.limits.log_limit_bytes, 1024 * 1024)) throw Error('Metrics exceed bound');
    metrics = JSON.parse(readFileSync(metricsPath, 'utf8'));
  } catch (error) {
    return { ...processResult, stdout: undefined, stderr: undefined, success: false, error: `Invalid workload metrics: ${error.message}` };
  }
  const metricsValid = validateWorkloadMetrics(metrics, request, processResult, expectedSources);
  const verification = request.mode === 'conversion_batch' && metricsValid
    ? verifyBatchOutputs(metrics, request, drivers.ffprobe, workload.items)
    : { success: request.mode !== 'conversion_batch' };
  return {
    ...metrics,
    process: { ...processResult, stdout: undefined, stderr: undefined },
    verification,
    success: metricsValid && verification.success,
  };
}

async function executeRealAdapter(run, drivers) {
  if (run.workload.adapter === 'single_conversion') {
    mkdirSync(run.output_directory, { recursive: true });
    const request = {
      ...run.workload.request,
      input_path: run.bindings[run.workload.fixture_role].path,
      output_path: join(run.output_directory, `output.${extensionFor(run.workload.expected_output)}`),
    };
    return runSingleConversion(drivers.singleDriver, drivers.sidecars, request, join(run.output_directory, 'driver'), {
      timeoutMs: run.limits.timeout_ms,
      logLimitBytes: run.limits.log_limit_bytes,
      budgetBytes: run.limits.storage_budget_bytes,
      hardwareEnabled: drivers.hardwareEnabled,
      ffprobe: drivers.ffprobe,
      expectedOutput: run.workload.expected_output,
    });
  }
  if (run.workload.adapter === 'workload') return executeWorkloadAdapter(run, drivers);
  return runStartup({
    binary: drivers.startupBinary,
    args: drivers.startupArgs,
    directory: run.output_directory,
    settings: drivers.startupSettings,
    jobs: run.workload.jobs,
    readinessTimeoutMs: run.limits.timeout_ms,
    logLimitBytes: run.limits.log_limit_bytes,
    budgetBytes: run.limits.storage_budget_bytes,
  });
}

async function executeSyntheticAdapter(run) {
  mkdirSync(run.output_directory, { recursive: true });
  const requestPath = join(run.output_directory, 'synthetic-request.json');
  const resultPath = join(run.output_directory, 'synthetic-result.json');
  writeFileSync(requestPath, `${JSON.stringify({ id: run.id, adapter: run.workload.adapter })}\n`);
  const processResult = await runBoundedProcess({
    command: process.execPath,
    args: [modulePath, '--synthetic-adapter', requestPath, resultPath],
    outputDirectory: run.output_directory,
    timeoutMs: run.limits.timeout_ms,
    logLimitBytes: run.limits.log_limit_bytes,
    storageBudgetBytes: run.limits.storage_budget_bytes,
  });
  const result = JSON.parse(readFileSync(resultPath, 'utf8'));
  return { ...result, success: processResult.success && result.success === true, process: { ...processResult, stdout: undefined, stderr: undefined } };
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined) throw Error('Every option requires a value');
    const name = flag.slice(2);
    if (options[name] !== undefined) throw Error(`Duplicate option: ${flag}`);
    options[name] = value;
  }
  return options;
}

async function syntheticSmoke(outputDirectory) {
  const manifestPath = new URL('./performance-suite.synthetic.json', import.meta.url);
  const manifestText = readFileSync(manifestPath, 'utf8');
  const manifest = parseManifest(manifestText);
  const fixtureRoot = join(tmpdir(), `goop-perf-smoke-${process.pid}-${Date.now()}`);
  createOwnedDirectory(fixtureRoot, 'Synthetic fixture directory');
  const fixturePath = join(fixtureRoot, 'source.txt');
  writeFileSync(fixturePath, 'goop synthetic performance fixture\n');
  const fixture = { path: fixturePath, sha256: sha256File(fixturePath), bytes: statSync(fixturePath).size };
  const binding = { schema_version: 1, fixtures: Object.fromEntries(manifest.fixture_roles.map(role => [role, fixture])) };
  try {
    return await runPerformanceSuite({ manifest, bindings: binding, outputDirectory, execute: executeSyntheticAdapter });
  } finally {
    const { rmSync } = await import('node:fs');
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

async function rustContractSmoke(options) {
  const required = ['workload-driver', 'sidecars', 'fixture', 'output'];
  for (const name of Object.keys(options)) if (!required.includes(name)) throw Error(`Unknown Rust contract option: --${name}`);
  for (const name of required) if (!options[name]) throw Error(`Missing --${name}`);
  const workloadDriver = resolve(options['workload-driver']);
  const sidecars = resolve(options.sidecars);
  const fixturePath = resolve(options.fixture);
  const outputDirectory = resolve(options.output);
  if (!statSync(workloadDriver).isFile()) throw Error('--workload-driver must be a file');
  if (!statSync(sidecars).isDirectory()) throw Error('--sidecars must be a directory');
  if (!statSync(fixturePath).isFile()) throw Error('--fixture must be a file');
  const manifest = parseManifest({
    schema_version: 1,
    suite_id: 'perf-01a-rust-contract',
    limitations: [...PERFORMANCE_LIMITATIONS],
    defaults: { warmups: 1, repetitions: 1, timeout_ms: 120000, suite_timeout_ms: 300000, log_limit_bytes: 1048576, suite_log_limit_bytes: 4194304, storage_budget_bytes: 67108864, suite_storage_budget_bytes: 134217728 },
    fixture_roles: ['contract_fixture'],
    workloads: [{ id: 'inspection-contract', adapter: 'workload', mode: 'inspection_burst', fixture_roles: ['contract_fixture'], source_count: 1, expected_output: { kind: 'metrics_only' } }],
  });
  const bindings = validateBindings(manifest, { schema_version: 1, fixtures: { contract_fixture: { path: fixturePath, sha256: sha256File(fixturePath), bytes: statSync(fixturePath).size } } });
  return runPerformanceSuite({
    manifest,
    bindings,
    prevalidatedBindings: true,
    outputDirectory,
    execute: run => executeWorkloadAdapter(run, { workloadDriver, sidecars }),
  });
}

export async function normalSuite(options) {
  const required = ['manifest', 'bindings', 'output', 'single-driver', 'workload-driver', 'sidecars', 'startup-binary', 'startup-config', 'build-command'];
  const allowed = new Set([...required, 'hardware-enabled']);
  for (const name of Object.keys(options)) if (!allowed.has(name)) throw Error(`Unknown option: --${name}`);
  for (const name of required) if (!options[name]) throw Error(`Missing --${name}`);
  const manifestPath = resolve(options.manifest), bindingPath = resolve(options.bindings), outputDirectory = resolve(options.output);
  if (existsSync(outputDirectory)) throw Error('Output directory must be new');
  const startupConfigPath = resolve(options['startup-config']);
  const manifestText = readFileSync(manifestPath, 'utf8'), bindingsText = readFileSync(bindingPath, 'utf8');
  const startupConfigText = readFileSync(startupConfigPath, 'utf8');
  const manifest = parseManifest(manifestText), bindings = validateBindings(manifest, bindingsText);
  const drivers = {
    singleDriver: resolve(options['single-driver']),
    workloadDriver: resolve(options['workload-driver']),
    sidecars: resolve(options.sidecars),
    ffprobe: null,
    startupBinary: resolve(options['startup-binary']),
    startupArgs: [],
    startupSettings: JSON.parse(startupConfigText),
    hardwareEnabled: options['hardware-enabled'] === 'true',
  };
  if (options['hardware-enabled'] !== undefined && !['true', 'false'].includes(options['hardware-enabled'])) throw Error('--hardware-enabled must be true or false');
  for (const [name, path] of Object.entries({ singleDriver: drivers.singleDriver, workloadDriver: drivers.workloadDriver, startupBinary: drivers.startupBinary })) if (!lstatSync(path).isFile()) throw Error(`${name} must be a regular non-symlink file`);
  if (!statSync(drivers.sidecars).isDirectory()) throw Error('--sidecars must be a directory');
  const initialSidecarFiles = sidecarFiles(drivers.sidecars);
  drivers.ffprobe = resolveBundledSidecar(drivers.sidecars, 'ffprobe');
  const identityParameters = {
    build_command: options['build-command'],
    hardware_enabled: drivers.hardwareEnabled,
    startup_config_sha256: sha256File(startupConfigPath),
    startup_settings: drivers.startupSettings,
    fixture_bindings: bindings,
    run_defaults: manifest.defaults,
  };
  const identity = captureIdentity({
    manifestText,
    bindingsText,
    executables: { single_driver: drivers.singleDriver, workload_driver: drivers.workloadDriver, startup_binary: drivers.startupBinary },
    sidecars: initialSidecarFiles,
    parameters: identityParameters,
  });
  validateCapturedIdentity(identity, 'pre-run identity');
  let result = null, runError = null, integrityError = null;
  try {
    result = await runPerformanceSuite({ manifest, bindings, prevalidatedBindings: true, outputDirectory, identity, execute: run => executeRealAdapter(run, drivers) });
  } catch (error) {
    runError = error;
  }
  let post = null;
  try {
    revalidateBindings(manifest, bindings);
    const postManifestText = readFileSync(manifestPath, 'utf8');
    const postBindingsText = readFileSync(bindingPath, 'utf8');
    const postStartupConfigText = readFileSync(startupConfigPath, 'utf8');
    const postIdentityParameters = {
      ...identityParameters,
      startup_config_sha256: sha256File(startupConfigPath),
      startup_settings: JSON.parse(postStartupConfigText),
    };
    post = captureIdentity({ manifestText: postManifestText, bindingsText: postBindingsText, executables: { single_driver: drivers.singleDriver, workload_driver: drivers.workloadDriver, startup_binary: drivers.startupBinary }, sidecars: sidecarFiles(drivers.sidecars), parameters: postIdentityParameters });
    validateCapturedIdentity(post, 'post-run identity');
    const stableFields = ['source', 'manifest_sha256', 'bindings_sha256', 'executables', 'sidecars', 'parameters', 'toolchain'];
    const stableMachine = value => ({ platform: value.platform, arch: value.arch, os: value.os, hardware_model: value.hardware_model });
    if (stableFields.some(field => stableStringify(identity[field]) !== stableStringify(post[field])) || stableStringify(stableMachine(identity.machine)) !== stableStringify(stableMachine(post.machine))) integrityError = 'Source, configuration, executable, sidecar, manifest, binding, toolchain, or machine identity changed during suite';
  } catch (error) {
    integrityError = error.message;
  }
  writeJsonAtomic(join(outputDirectory, 'integrity.json'), { success: integrityError === null, error: integrityError, pre: identity, post });
  if (integrityError) {
    const statePath = join(outputDirectory, 'suite-state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.status = 'failed';
    state.integrity_error = integrityError;
    writeJsonAtomic(statePath, state);
  }
  if (runError) throw runError;
  if (integrityError) throw Error(integrityError);
  return result;
}

async function main() {
  if (process.argv[2] === '--synthetic-adapter') {
    const request = JSON.parse(readFileSync(process.argv[3], 'utf8'));
    writeFileSync(process.argv[4], `${JSON.stringify({ success: true, process_ms: 1, request_id: request.id })}\n`);
    return;
  }
  if (process.argv[2] === '--synthetic-smoke') {
    const options = parseOptions(process.argv.slice(3));
    if (!options.output || Object.keys(options).length !== 1) throw Error('Usage: --synthetic-smoke --output NEW_DIRECTORY');
    await syntheticSmoke(resolve(options.output));
    return;
  }
  if (process.argv[2] === '--rust-contract-smoke') {
    await rustContractSmoke(parseOptions(process.argv.slice(3)));
    return;
  }
  await normalSuite(parseOptions(process.argv.slice(2)));
}

if (process.argv[1] && resolve(process.argv[1]) === modulePath) main().catch(error => { console.error(error); process.exitCode = 1; });
