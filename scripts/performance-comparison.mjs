import { lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOwnedDirectory, directoryBytes, removeOwnedDirectory, runBoundedProcess, sha256File, sha256Text, stableStringify, validateCapturedIdentity, writeJsonAtomic } from './performance-shared.mjs';
import { validateEffectiveExecution, validateMediaProbe } from './performance-manifest.mjs';

const modulePath = fileURLToPath(import.meta.url);
const PAIRED_RESULT_LIMIT_BYTES = 64 * 1024;

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
};

export async function collectPairedSamples({ workloadIds, repetitions, outputDirectory, execute, metadata = null, totalLimits = null }) {
  if (typeof execute !== 'function') throw Error('Paired comparison requires an execute function');
  if (typeof outputDirectory !== 'string' || outputDirectory === '') throw Error('Paired comparison requires a new output directory');
  const plan = pairedExecutionOrder(workloadIds, repetitions);
  const statePath = join(outputDirectory, 'paired-state.json');
  const state = { schema_version: 1, status: 'running', repetitions, workload_ids: [...workloadIds], plan, samples: [], ...(metadata === null ? {} : { metadata }) };
  if (totalLimits) {
    const requiredLedgerBytes = Buffer.byteLength(JSON.stringify(state)) + plan.length * (PAIRED_RESULT_LIMIT_BYTES + 2048) + 65536;
    if (totalLimits.suite_storage_budget_bytes < requiredLedgerBytes) throw Error(`Paired suite storage budget is too small for the bounded evidence ledger; require at least ${requiredLedgerBytes} bytes`);
  }
  createOwnedDirectory(outputDirectory, 'Paired output directory');
  writeJsonAtomic(statePath, state);
  const started = performance.now();
  let retainedLogBytes = 0;
  for (const step of plan) {
    if (totalLimits && directoryBytes(outputDirectory) > totalLimits.suite_storage_budget_bytes) {
      state.samples.push({ ...step, status: 'failed', result: { success: false, not_run: true, storage_budget_exceeded: true, error: 'Paired total storage budget exceeded before launch' } });
      writeJsonAtomic(statePath, state);
      break;
    }
    const rawRemainingMs = totalLimits ? totalLimits.suite_timeout_ms - (performance.now() - started) : null;
    if (rawRemainingMs !== null && rawRemainingMs <= 0) {
      state.samples.push({ ...step, status: 'failed', result: { success: false, not_run: true, time_budget_exceeded: true, error: 'Paired total time budget exceeded before launch' } });
      writeJsonAtomic(statePath, state);
      break;
    }
    let result;
    try {
      const suiteRemainingMs = rawRemainingMs === null ? null : Math.max(1, Math.floor(rawRemainingMs));
      result = await execute({ ...step, suite_remaining_ms: suiteRemainingMs });
      if (result === null || typeof result !== 'object') throw Error('Adapter returned no result');
    } catch (error) {
      result = { success: false, error: error.message };
    }
    retainedLogBytes += result?.log_bytes_retained ?? result?.process?.log_bytes_retained ?? 0;
    const exceeded = totalLimits ? {
      time: performance.now() - started > totalLimits.suite_timeout_ms,
      storage: directoryBytes(outputDirectory) > totalLimits.suite_storage_budget_bytes,
      log: retainedLogBytes > totalLimits.suite_log_limit_bytes,
    } : { time: false, storage: false, log: false };
    if (exceeded.time || exceeded.storage || exceeded.log) result = {
      ...result,
      success: false,
      ...(exceeded.time ? { time_budget_exceeded: true } : {}),
      ...(exceeded.storage ? { storage_budget_exceeded: true } : {}),
      ...(exceeded.log ? { log_budget_exceeded: true } : {}),
      error: `Paired total ${exceeded.time ? 'time' : exceeded.storage ? 'storage' : 'retained-log'} budget exceeded`,
    };
    state.samples.push({ ...step, status: result.success === true ? 'success' : 'failed', result });
    writeJsonAtomic(statePath, state);
    if (totalLimits && directoryBytes(outputDirectory) > totalLimits.suite_storage_budget_bytes && !exceeded.storage) {
      removeOwnedDirectory(join(outputDirectory, 'runs', step.workload_id, `${step.repetition}-${step.revision}`));
      state.samples.at(-1).status = 'failed';
      state.samples.at(-1).result = { ...result, success: false, storage_budget_exceeded: true, owned_payload_removed: true, error: 'Paired total storage budget exceeded while retaining evidence' };
      writeJsonAtomic(statePath, state);
      break;
    }
    if (exceeded.storage) {
      removeOwnedDirectory(join(outputDirectory, 'runs', step.workload_id, `${step.repetition}-${step.revision}`));
      state.samples.at(-1).result = { ...state.samples.at(-1).result, owned_payload_removed: true };
      writeJsonAtomic(statePath, state);
    }
    if (exceeded.time || exceeded.storage || exceeded.log) break;
  }
  state.success = state.samples.every(sample => sample.status === 'success');
  state.status = state.success ? 'complete' : 'failed';
  writeJsonAtomic(statePath, state);
  return state;
}

export function pairedExecutionOrder(workloadIds, repetitions) {
  if (!Array.isArray(workloadIds) || workloadIds.length === 0) throw Error('At least one workload is required');
  if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 20) throw Error('Invalid repetitions');
  const order = [];
  for (const workloadId of workloadIds) {
    for (let repetition = 0; repetition < repetitions; repetition++) {
      const revisions = repetition % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
      for (const revision of revisions) order.push({ workload_id: workloadId, repetition, revision });
    }
  }
  return order;
}

function assertEquivalentIdentity(baseline, candidate) {
  validateCapturedIdentity(baseline, 'baseline identity');
  validateCapturedIdentity(candidate, 'candidate identity');
  const fields = ['manifest_sha256', 'bindings_sha256', 'toolchain', 'sidecars', 'parameters'];
  for (const field of fields) {
    if (stableStringify(baseline[field]) !== stableStringify(candidate[field])) throw Error(`Identity mismatch: ${field}`);
  }
  const machine = value => ({ platform: value?.platform, arch: value?.arch, os: value?.os, hardware_model: value?.hardware_model, power_source: value?.power_source, low_power_mode: value?.low_power_mode, thermal: value?.thermal });
  if (stableStringify(machine(baseline.machine)) !== stableStringify(machine(candidate.machine))) throw Error('Identity mismatch: machine');
}

function finiteSamples(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some(sample => !Number.isFinite(sample) || sample < 0)) throw Error(`Invalid ${label} samples`);
  return value;
}

export function comparePairedSummaries(baseline, candidate) {
  if (typeof baseline.workload_id !== 'string' || baseline.workload_id !== candidate.workload_id) throw Error('Paired workload identity mismatch');
  if (!Number.isSafeInteger(baseline.repetitions) || baseline.repetitions < 1 || baseline.repetitions !== candidate.repetitions) throw Error('Paired repetitions mismatch');
  assertEquivalentIdentity(baseline.identity, candidate.identity);
  const baselineSamples = finiteSamples(baseline.samples, 'baseline');
  const candidateSamples = finiteSamples(candidate.samples, 'candidate');
  if (baselineSamples.length !== baseline.repetitions || candidateSamples.length !== candidate.repetitions) throw Error('Paired sample count does not match repetitions');
  const baselineMedian = median(baselineSamples);
  const candidateMedian = median(candidateSamples);
  const percentChange = baselineMedian === 0 ? null : ((candidateMedian - baselineMedian) / baselineMedian) * 100;
  return {
    success: true,
    workload_id: baseline.workload_id,
    repetitions: baseline.repetitions,
    baseline_median: baselineMedian,
    candidate_median: candidateMedian,
    percent_change: percentChange,
    investigation_required: percentChange === null || Math.abs(percentChange) > 10,
    raw_samples: { baseline: [...baselineSamples], candidate: [...candidateSamples] },
    verdict: 'Timing differences are investigative evidence, not a CI or release threshold.',
  };
}

function validatePairedPlan(input) {
  const plan = typeof input === 'string' ? JSON.parse(input) : structuredClone(input);
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) throw Error('Paired plan must be an object');
  const allowed = new Set(['schema_version', 'repetitions', 'workload_ids', 'workload_contracts', 'limits', 'revisions']);
  for (const key of Object.keys(plan)) if (!allowed.has(key)) throw Error(`Paired plan has unknown field: ${key}`);
  if (plan.schema_version !== 1) throw Error('Unsupported paired plan schema_version');
  if (!Array.isArray(plan.workload_ids) || plan.workload_ids.length === 0) throw Error('At least one workload identifier is required');
  const ids = new Set();
  for (const id of plan.workload_ids) {
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(id)) throw Error('Invalid paired workload identifier');
    if (ids.has(id)) throw Error(`Duplicate workload identifier: ${id}`);
    ids.add(id);
  }
  if (plan.workload_contracts === null || typeof plan.workload_contracts !== 'object' || Array.isArray(plan.workload_contracts) || Object.keys(plan.workload_contracts).sort().join(',') !== [...plan.workload_ids].sort().join(',')) throw Error('Paired workload contracts must exactly match workload identifiers');
  for (const [id, contract] of Object.entries(plan.workload_contracts)) {
    if (contract === null || typeof contract !== 'object' || Array.isArray(contract) || Object.keys(contract).sort().join(',') !== 'contract_sha256,evidence_kind,expected_facts') throw Error(`Invalid paired workload contract: ${id}`);
    if (!/^[0-9a-f]{64}$/.test(contract.contract_sha256) || !['media', 'inspection', 'startup'].includes(contract.evidence_kind)) throw Error(`Invalid paired workload contract: ${id}`);
    const facts = contract.expected_facts;
    if (facts === null || typeof facts !== 'object' || Array.isArray(facts) || contract.contract_sha256 !== sha256Text(stableStringify(facts))) throw Error(`Invalid paired workload contract facts: ${id}`);
    if (contract.evidence_kind === 'media') {
      if (Object.keys(facts).sort().join(',') !== 'expected_output,request' || facts.expected_output === null || typeof facts.expected_output !== 'object' || facts.request === null || typeof facts.request !== 'object') throw Error(`Invalid paired media contract facts: ${id}`);
      const expected = facts.expected_output;
      if (typeof expected.extension !== 'string' || !Array.isArray(expected.format_names) || expected.format_names.length === 0 || !Array.isArray(expected.required_streams) || expected.required_streams.length === 0) throw Error(`Invalid paired media contract facts: ${id}`);
    } else if (contract.evidence_kind === 'inspection') {
      if (Object.keys(facts).sort().join(',') !== 'source_count,source_sha256' || !Number.isSafeInteger(facts.source_count) || facts.source_count < 1 || !Array.isArray(facts.source_sha256) || facts.source_sha256.length !== facts.source_count || facts.source_sha256.some(value => !/^[0-9a-f]{64}$/.test(value))) throw Error(`Invalid paired inspection contract facts: ${id}`);
    } else if (Object.keys(facts).sort().join(',') !== 'jobs,marker_schema_version' || !Number.isSafeInteger(facts.jobs) || facts.jobs < 0 || facts.marker_schema_version !== 1) throw Error(`Invalid paired startup contract facts: ${id}`);
  }
  pairedExecutionOrder(plan.workload_ids, plan.repetitions);
  const limitFields = ['timeout_ms', 'suite_timeout_ms', 'log_limit_bytes', 'suite_log_limit_bytes', 'storage_budget_bytes', 'suite_storage_budget_bytes'];
  if (plan.limits === null || typeof plan.limits !== 'object' || Array.isArray(plan.limits) || Object.keys(plan.limits).some(key => !limitFields.includes(key))) throw Error('Invalid paired limits');
  for (const field of limitFields) if (!Number.isSafeInteger(plan.limits[field]) || plan.limits[field] < 1) throw Error(`Invalid paired ${field}`);
  if (plan.revisions === null || typeof plan.revisions !== 'object' || Array.isArray(plan.revisions) || Object.keys(plan.revisions).sort().join(',') !== 'baseline,candidate') throw Error('Paired plan requires baseline and candidate revisions');
  for (const name of ['baseline', 'candidate']) {
    const revision = plan.revisions[name];
    if (revision === null || typeof revision !== 'object' || Array.isArray(revision) || Object.keys(revision).some(key => !['command', 'command_sha256', 'args', 'identity'].includes(key))) throw Error(`Invalid ${name} revision`);
    if (typeof revision.command !== 'string' || revision.command === '' || !Array.isArray(revision.args) || revision.args.some(value => typeof value !== 'string')) throw Error(`Invalid ${name} command`);
    if (resolve(revision.command) !== revision.command || !/^[0-9a-f]{64}$/.test(revision.command_sha256)) throw Error(`Invalid ${name} command SHA-256 identity`);
    validateCapturedIdentity(revision.identity, `${name} identity`);
  }
  return plan;
}

export function validatePairedVerification(result, step, contract) {
  const verification = result?.verification;
  if (result?.success !== true || !Number.isFinite(result.process_ms) || result.process_ms < 0 || result.workload_id !== step.workload_id || result.revision !== step.revision) return false;
  if (verification?.success !== true || verification.contract_sha256 !== contract.contract_sha256 || verification.kind !== contract.evidence_kind || stableStringify(verification.contract_facts) !== stableStringify(contract.expected_facts)) return false;
  const evidence = verification.evidence;
  if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) return false;
  if (contract.evidence_kind === 'media') {
    try {
      validateMediaProbe(evidence.probe, contract.expected_facts.expected_output);
      validateEffectiveExecution(evidence.effective_execution, contract.expected_facts.request);
    } catch { return false; }
    return Number.isSafeInteger(evidence.output_bytes) && evidence.output_bytes > 0;
  }
  if (contract.evidence_kind === 'inspection') return Array.isArray(evidence.items) && evidence.items.length === contract.expected_facts.source_count && evidence.items.every((item, index) => item?.source_sha256 === contract.expected_facts.source_sha256[index] && Number.isFinite(item?.probe_ms) && item.probe_ms >= 0);
  return evidence.marker?.schema_version === contract.expected_facts.marker_schema_version && Number.isFinite(evidence.marker.backend_ready_ms) && evidence.marker.backend_ready_ms >= 0 && evidence.jobs === contract.expected_facts.jobs;
}

export async function runPairedPlan({ plan: planInput, outputDirectory }) {
  const plan = validatePairedPlan(planInput);
  for (const [name, revision] of Object.entries(plan.revisions)) {
    let actual;
    try { actual = lstatSync(revision.command).isFile() ? sha256File(revision.command) : null; } catch { actual = null; }
    if (actual !== revision.command_sha256) throw Error(`${name} command SHA-256 does not match the paired plan`);
  }
  const state = await collectPairedSamples({
    workloadIds: plan.workload_ids,
    repetitions: plan.repetitions,
    outputDirectory,
    metadata: { revisions: plan.revisions },
    totalLimits: plan.limits,
    execute: async step => {
      const revision = plan.revisions[step.revision];
      const runDirectory = join(outputDirectory, 'runs', step.workload_id, `${step.repetition}-${step.revision}`);
      mkdirSync(runDirectory, { recursive: true });
      const resultPath = join(runDirectory, 'result.json');
      const processResult = await runBoundedProcess({
        command: revision.command,
        args: revision.args,
        env: {
          ...process.env,
          GOOP_PERF_WORKLOAD_ID: step.workload_id,
          GOOP_PERF_REPETITION: String(step.repetition),
          GOOP_PERF_REVISION: step.revision,
          GOOP_PERF_OUTPUT_DIR: runDirectory,
          GOOP_PERF_RESULT_PATH: resultPath,
        },
        outputDirectory: runDirectory,
        timeoutMs: Math.min(plan.limits.timeout_ms, step.suite_remaining_ms),
        logLimitBytes: plan.limits.log_limit_bytes,
        storageBudgetBytes: plan.limits.storage_budget_bytes,
      });
      writeFileSync(join(runDirectory, 'stdout.log'), processResult.stdout);
      writeFileSync(join(runDirectory, 'stderr.log'), processResult.stderr);
      const sanitizedProcess = { ...processResult, stdout: undefined, stderr: undefined };
      try {
        if (sha256File(revision.command) !== revision.command_sha256) return { success: false, process: sanitizedProcess, error: 'Paired command changed during execution' };
        if (!processResult.success || statSync(resultPath).size > PAIRED_RESULT_LIMIT_BYTES) return { success: false, process: sanitizedProcess, error: 'Paired workload process failed or produced oversized evidence' };
        const result = JSON.parse(readFileSync(resultPath, 'utf8'));
        const valid = validatePairedVerification(result, step, plan.workload_contracts[step.workload_id]);
        return { ...result, success: valid, process: sanitizedProcess, error: valid ? result.error : (result?.error ?? 'Invalid paired workload result') };
      } catch (error) {
        return { success: false, process: sanitizedProcess, error: `Invalid paired workload evidence: ${error.message}` };
      }
    },
  });
  const comparisons = {};
  try {
    for (const workloadId of plan.workload_ids) {
      const samples = state.samples.filter(sample => sample.workload_id === workloadId);
      if (samples.some(sample => sample.status !== 'success')) {
        comparisons[workloadId] = { success: false, error: 'At least one paired sample failed; no timing comparison produced' };
        continue;
      }
      const contractFacts = samples.map(sample => stableStringify(sample.result.verification.contract_facts));
      if (new Set(contractFacts).size !== 1) throw Error(`Paired output contract facts differ for ${workloadId}`);
      const summary = revision => ({
        workload_id: workloadId,
        repetitions: plan.repetitions,
        identity: plan.revisions[revision].identity,
        samples: samples.filter(sample => sample.revision === revision).sort((a, b) => a.repetition - b.repetition).map(sample => sample.result.process_ms),
      });
      comparisons[workloadId] = comparePairedSummaries(summary('baseline'), summary('candidate'));
    }
  } catch (error) {
    state.success = false;
    state.status = 'failed';
    state.comparison_error = error.message;
    writeJsonAtomic(join(outputDirectory, 'paired-state.json'), state);
    writeJsonAtomic(join(outputDirectory, 'comparison.json'), comparisons);
    throw error;
  }
  writeJsonAtomic(join(outputDirectory, 'comparison.json'), comparisons);
  if (!state.success) throw Error('Paired execution failed; retained incremental evidence');
  return { state, comparisons };
}

async function main() {
  if (process.argv.length !== 6 || process.argv[2] !== '--paired-plan' || process.argv[4] !== '--output') throw Error('Usage: --paired-plan PLAN_JSON --output NEW_DIRECTORY');
  const plan = readFileSync(resolve(process.argv[3]), 'utf8');
  await runPairedPlan({ plan, outputDirectory: resolve(process.argv[5]) });
}

if (process.argv[1] && resolve(process.argv[1]) === modulePath) main().catch(error => { console.error(error); process.exitCode = 1; });
