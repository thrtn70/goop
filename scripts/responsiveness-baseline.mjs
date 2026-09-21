import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  captureProcessIdentitySnapshot,
  captureIdentity,
  createIdentityAwareProcessSeries,
  directoryBytes,
  runBoundedProcess,
  sha256File,
  validateCapturedIdentity,
  withTerminationSignals,
} from './performance-shared.mjs';

export const MAX_SAMPLE_BYTES = 8 * 1024 * 1024;
export const MAX_FRONTEND_BYTES = 6 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_COMPONENT_BYTES = 6 * 1024 * 1024;
const OPAQUE = /^[A-Za-z0-9._:-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const LANES = new Set(['inspection', 'draft', 'session_memory']);
const PHASES = new Set(['warmup', 'measured', 'exploratory_soak']);
const ROLES = new Set(['primary', 'pre_quit', 'recovery']);
const EVENT_TYPES = new Set(['click', 'keydown', 'input', 'change']);
const CLEANUP_FAILURE_CODES = new Set(['artifact_remove_failed', 'directory_sync_failed', 'process_cleanup_failed']);
const SAMPLE_FAILURE_CODES = new Set(['frontend_trace_failed', 'identity_mismatch', 'driver_interrupted', 'recovery_mismatch', 'storage_failure_expected', 'cleanup_failed']);
const SAMPLE_INCONCLUSIVE_CODES = new Set(['instrumentation_overhead_exceeded', 'process_attribution_incomplete', 'sampling_incomplete']);
const SESSION_CYCLES = 50;
const SESSION_ACTIONS_PER_CYCLE = 35;

const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
const byteLength = value => Buffer.byteLength(value, 'utf8');
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exactKeys = (value, allowed, label) => {
  if (!plainObject(value)) throw Error(`${label} must be an object`);
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  const missing = allowed.filter(key => value[key] === undefined);
  if (unknown.length > 0) throw Error(`${label} has unknown fields: ${unknown.join(', ')}`);
  if (missing.length > 0) throw Error(`${label} is missing fields: ${missing.join(', ')}`);
};
const exactRequiredAndOptionalKeys = (value, required, optional, label) => {
  if (!plainObject(value)) throw Error(`${label} must be an object`);
  const allowed = [...required, ...optional];
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  const missing = required.filter(key => value[key] === undefined);
  if (unknown.length > 0) throw Error(`${label} has unknown fields: ${unknown.join(', ')}`);
  if (missing.length > 0) throw Error(`${label} is missing fields: ${missing.join(', ')}`);
};
const safeInteger = (value, label, minimum = 0) => {
  if (!Number.isSafeInteger(value) || value < minimum) throw Error(`${label} must be a safe integer >= ${minimum}`);
  return value;
};
const boundedString = (value, label, { pattern = null, maximum = 64, allowEmpty = false } = {}) => {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || byteLength(value) > maximum || (pattern && !pattern.test(value))) throw Error(`Invalid ${label}`);
  return value;
};

export function syncDirectoryPortable(directory, platform = process.platform) {
  if (platform === 'win32') return false;
  const descriptor = openSync(directory, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  return true;
}

function rejectLoneSurrogates(value, label) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw Error(`${label} contains a lone surrogate`);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) throw Error(`${label} contains a lone surrogate`);
  }
}

/** RFC 8785 JSON Canonicalization Scheme using ECMAScript number serialization. */
export function canonicalizeJcs(value) {
  const encode = (item, label) => {
    if (item === null || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw Error(`${label} must be a finite JSON number`);
      return JSON.stringify(item);
    }
    if (typeof item === 'string') { rejectLoneSurrogates(item, label); return JSON.stringify(item); }
    if (Array.isArray(item)) {
      const encoded = [];
      for (let index = 0; index < item.length; index += 1) {
        if (!Object.hasOwn(item, index)) throw Error(`${label} contains a non-JSON array hole`);
        encoded.push(encode(item[index], `${label}[${index}]`));
      }
      return `[${encoded.join(',')}]`;
    }
    if (!plainObject(item)) throw Error(`${label} is not a JSON value`);
    const fields = [];
    for (const key of Object.keys(item).sort()) {
      rejectLoneSurrogates(key, `${label} key`);
      if (item[key] === undefined || typeof item[key] === 'bigint' || typeof item[key] === 'function' || typeof item[key] === 'symbol') throw Error(`${label}.${key} is not a JSON value`);
      fields.push(`${JSON.stringify(key)}:${encode(item[key], `${label}.${key}`)}`);
    }
    return `{${fields.join(',')}}`;
  };
  return encode(value, 'value');
}

export const hashCanonicalJcs = value => {
  const canonical = canonicalizeJcs(value);
  return { canonical, sha256: createHash('sha256').update(canonical).digest('hex'), bytes: byteLength(canonical) };
};

function validateFacts(facts) {
  if (!plainObject(facts) || Object.keys(facts).length > 32) throw Error('Invalid workload facts');
  for (const [key, value] of Object.entries(facts)) {
    boundedString(key, 'workload fact key');
    if (typeof value === 'string') boundedString(value, 'workload fact value', { allowEmpty: true });
    else if (typeof value === 'number') safeInteger(value, 'workload fact value');
    else if (typeof value !== 'boolean') throw Error('Invalid workload fact value');
  }
}

function validateDescriptor(descriptor) {
  exactKeys(descriptor, ['componentRole', 'sessionId', 'sampleId', 'pageInstanceId', 'lane', 'scenario', 'workload', 'phase', 'repetition'], 'responsiveness descriptor');
  if (!ROLES.has(descriptor.componentRole) || !UUID.test(descriptor.sessionId) || !UUID.test(descriptor.pageInstanceId) || !LANES.has(descriptor.lane) || !PHASES.has(descriptor.phase)) throw Error('Invalid responsiveness descriptor identity');
  boundedString(descriptor.sampleId, 'sample ID');
  exactKeys(descriptor.scenario, ['id', 'manifestSha256'], 'scenario identity');
  boundedString(descriptor.scenario.id, 'scenario ID', { pattern: OPAQUE });
  boundedString(descriptor.scenario.manifestSha256, 'manifest digest', { pattern: SHA256 });
  exactKeys(descriptor.workload, ['id', 'facts'], 'workload');
  boundedString(descriptor.workload.id, 'workload ID', { pattern: OPAQUE });
  validateFacts(descriptor.workload.facts);
  safeInteger(descriptor.repetition, 'repetition');
  return descriptor;
}

function validateBootstrap(bootstrap) {
  exactKeys(bootstrap, ['initialPath', 'draftStorage', 'failNextDraftWrite'], 'responsiveness bootstrap');
  if (!['/extract', '/convert'].includes(bootstrap.initialPath) || typeof bootstrap.failNextDraftWrite !== 'boolean') throw Error('Invalid responsiveness bootstrap');
  if (bootstrap.draftStorage !== null) {
    exactKeys(bootstrap.draftStorage, ['raw', 'sha256'], 'draft bootstrap storage');
    if (typeof bootstrap.draftStorage.raw !== 'string' || byteLength(bootstrap.draftStorage.raw) > 512 * 1024 || !SHA256.test(bootstrap.draftStorage.sha256)) throw Error('Invalid draft bootstrap storage');
    const actual = createHash('sha256').update(bootstrap.draftStorage.raw).digest('hex');
    if (actual !== bootstrap.draftStorage.sha256) throw Error('Draft bootstrap hash mismatch');
  }
}

function validateCompletion(completion) {
  exactKeys(completion, ['kind', 'timeoutMs', 'expectedDraftSha256', 'expectedAxValue'], 'responsiveness completion');
  if (!['actions_and_setups', 'recovery'].includes(completion.kind)) throw Error('Invalid responsiveness completion kind');
  safeInteger(completion.timeoutMs, 'completion timeout', 1);
  if (completion.timeoutMs > 120_000) throw Error('Completion timeout exceeds 120,000 ms');
  if (completion.expectedDraftSha256 !== null && !SHA256.test(completion.expectedDraftSha256)) throw Error('Invalid expected draft digest');
  if (completion.expectedAxValue !== null) boundedString(completion.expectedAxValue, 'expected AX value', { allowEmpty: true });
}

function validateArmAction(action, expectedId) {
  exactKeys(action, ['actionId', 'targetId', 'eventType', 'targetRole', 'accessibleName', 'expectedPriorValue'], `action ${expectedId}`);
  if (action.actionId !== expectedId) throw Error(`Action ordinal must be contiguous at ${expectedId}`);
  boundedString(action.targetId, 'target ID', { pattern: OPAQUE });
  if (!EVENT_TYPES.has(action.eventType)) throw Error('Invalid action event type');
  boundedString(action.targetRole, 'target role');
  boundedString(action.accessibleName, 'accessible name');
  boundedString(action.expectedPriorValue, 'expected prior value', { allowEmpty: true });
  return action;
}

/** Validate the exact <=2 MiB launch document consumed by the native activation query. */
export function validateScenarioManifest(manifest) {
  exactKeys(manifest, ['schema_version', 'token', 'webviewDataStoreId', 'bootstrap', 'completion', 'descriptor', 'actions'], 'responsiveness manifest');
  if (manifest.schema_version !== 2) throw Error('Unsupported responsiveness manifest schema version');
  boundedString(manifest.token, 'responsiveness token', { pattern: OPAQUE });
  if (!Array.isArray(manifest.webviewDataStoreId) || manifest.webviewDataStoreId.length !== 16 || manifest.webviewDataStoreId.every(value => value === 0) || manifest.webviewDataStoreId.some(value => !Number.isSafeInteger(value) || value < 0 || value > 255)) throw Error('Invalid WebView data-store ID');
  validateBootstrap(manifest.bootstrap);
  validateCompletion(manifest.completion);
  validateDescriptor(manifest.descriptor);
  if (!Array.isArray(manifest.actions) || manifest.actions.length > 2048) throw Error('Responsiveness actions exceed 2,048 entries');
  const zeroActionRecovery = manifest.actions.length === 0 && manifest.descriptor.componentRole === 'recovery' && manifest.completion.kind === 'recovery';
  if (manifest.actions.length === 0 && !zeroActionRecovery) throw Error('Zero actions are valid only for recovery completion');
  if (manifest.completion.kind === 'recovery' && manifest.descriptor.componentRole !== 'recovery') throw Error('Recovery completion requires the recovery role');
  manifest.actions.forEach((action, index) => validateArmAction(action, index + 1));
  if (byteLength(JSON.stringify(manifest)) > MAX_MANIFEST_BYTES) throw Error('Responsiveness manifest exceeds 2 MiB');
  return manifest;
}

const requireAction = (action, { role, label, kind, timeoutMs }, ordinal) => {
  if (action.targetRole !== role || action.accessibleName !== label || action.dispatch?.kind !== kind || action.dispatch?.timeout_ms !== timeoutMs) throw Error(`Invalid Lane 3 action ${ordinal}`);
};
const requireLaneAction = (action, expected, ordinal) => {
  requireAction(action, expected, ordinal);
  if (action.eventType !== expected.eventType || action.expectedPriorValue !== expected.prior) throw Error(`Invalid Lane 3 event/prior value at action ${ordinal}`);
  if (canonicalizeJcs(action.dispatch.ax_prior) !== canonicalizeJcs(expected.axPrior)) throw Error(`Invalid Lane 3 AX prior predicate at action ${ordinal}`);
  const completion = action.dispatch.completion;
  if (!plainObject(completion) || completion.kind !== expected.completion.kind || (completion.role ?? action.targetRole) !== expected.completion.role || (completion.label ?? action.accessibleName) !== expected.completion.label || completion.attribute !== expected.completion.attribute || (expected.completion.value === undefined ? completion.value !== undefined : canonicalizeJcs(completion.value) !== canonicalizeJcs(expected.completion.value))) throw Error(`Invalid Lane 3 completion predicate at action ${ordinal}`);
};

/** Validate the fixed 50 x 35 measured long-session workload before launch. */
export function validateSessionMemoryActions(actions, facts) {
  if (!plainObject(facts) || facts.cycles !== SESSION_CYCLES || facts.fixture_count !== 8 || facts.actions_per_cycle !== SESSION_ACTIONS_PER_CYCLE || facts.cycle_timeout_ms !== 40_000) throw Error('Lane 3 workload facts must declare 50 cycles of 35 actions, eight fixtures, and a 40,000 ms cycle timeout');
  if (!Array.isArray(actions) || actions.length !== SESSION_CYCLES * SESSION_ACTIONS_PER_CYCLE) throw Error('Lane 3 requires exactly 1,750 actions (50 x 35)');
  let frozenFixtures = null;
  const typed = [...'https://x.test/a.mp4'];
  for (let cycle = 0; cycle < SESSION_CYCLES; cycle += 1) {
    const offset = cycle * SESSION_ACTIONS_PER_CYCLE;
    const cycleActions = actions.slice(offset, offset + SESSION_ACTIONS_PER_CYCLE);
    requireLaneAction(cycleActions[0], { role: 'link', label: 'Convert', kind: 'press', timeoutMs: 2000, eventType: 'click', prior: '/convert', axPrior: { kind: 'attribute_equals', attribute: 'AXSelected', value: true }, completion: { kind: 'attribute_equals', role: 'link', label: 'Convert', attribute: 'AXSelected', value: true } }, offset + 1);
    requireAction(cycleActions[1], { role: 'button', label: 'Add files', kind: 'open_dialog_select', timeoutMs: 10_000 }, offset + 2);
    if (cycleActions[1].eventType !== 'click' || cycleActions[1].expectedPriorValue !== '0' || canonicalizeJcs(cycleActions[1].dispatch.ax_prior) !== canonicalizeJcs({ kind: 'attribute_equals', attribute: 'AXEnabled', value: true })) throw Error(`Invalid Lane 3 event/prior value at action ${offset + 2}`);
    const fixtures = cycleActions[1].dispatch.fixture_names;
    if (!Array.isArray(fixtures) || fixtures.length !== 8 || new Set(fixtures).size !== 8) throw Error('Lane 3 Open dialog action requires eight unique fixture names');
    if (!isAbsolute(cycleActions[1].dispatch.fixture_directory ?? '')) throw Error('Lane 3 Open dialog action requires an absolute fixture directory');
    fixtures.forEach(value => boundedString(value, 'Lane 3 fixture basename'));
    if (frozenFixtures === null) frozenFixtures = fixtures;
    else if (canonicalizeJcs(fixtures) !== canonicalizeJcs(frozenFixtures)) throw Error('Lane 3 must reuse the same eight fixtures in every cycle');
    const addCompletion = cycleActions[1].dispatch.completion;
    if (!plainObject(addCompletion) || addCompletion.kind !== 'attribute_equals' || (addCompletion.role ?? cycleActions[1].targetRole) !== 'button' || (addCompletion.label ?? cycleActions[1].accessibleName) !== `Remove ${fixtures[7]}` || addCompletion.attribute !== 'AXEnabled' || addCompletion.value !== true) throw Error(`Invalid Lane 3 completion predicate at action ${offset + 2}`);
    requireLaneAction(cycleActions[2], { role: 'button', label: `Select ${fixtures[0]}`, kind: 'press', timeoutMs: 2000, eventType: 'click', prior: 'false', axPrior: { kind: 'attribute_equals', attribute: 'AXSelected', value: false }, completion: { kind: 'attribute_equals', role: 'button', label: `Select ${fixtures[0]}`, attribute: 'AXSelected', value: true } }, offset + 3);
    const priorUrl = cycle === 0 ? '' : typed.join('');
    requireLaneAction(cycleActions[3], { role: 'textbox', label: 'Paste URL to download', kind: 'key_chord', timeoutMs: 2000, eventType: 'keydown', prior: priorUrl, axPrior: { kind: 'attribute_equals', attribute: 'AXValue', value: priorUrl }, completion: { kind: 'attribute_equals', role: 'textbox', label: 'Paste URL to download', attribute: 'AXValue', value: priorUrl } }, offset + 4);
    if (cycleActions[3].dispatch.key !== 'a' || canonicalizeJcs(cycleActions[3].dispatch.modifiers) !== canonicalizeJcs(['command'])) throw Error('Lane 3 action 4 must be Command-A');
    requireLaneAction(cycleActions[4], { role: 'textbox', label: 'Paste URL to download', kind: 'key_code', timeoutMs: 2000, eventType: 'keydown', prior: priorUrl, axPrior: { kind: 'attribute_equals', attribute: 'AXValue', value: priorUrl }, completion: { kind: 'attribute_equals', role: 'textbox', label: 'Paste URL to download', attribute: 'AXValue', value: '' } }, offset + 5);
    if (cycleActions[4].dispatch.key_code !== 51) throw Error('Lane 3 action 5 must be Delete');
    let cumulative = '';
    typed.forEach((character, index) => {
      const action = cycleActions[index + 5];
      const prior = cumulative; cumulative += character;
      requireLaneAction(action, { role: 'textbox', label: 'Paste URL to download', kind: 'keystroke', timeoutMs: 2000, eventType: 'input', prior, axPrior: { kind: 'attribute_equals', attribute: 'AXValue', value: prior }, completion: { kind: 'attribute_equals', role: 'textbox', label: 'Paste URL to download', attribute: 'AXValue', value: cumulative } }, offset + index + 6);
      if (action.dispatch.text !== character) throw Error(`Lane 3 typed URL differs at action ${offset + index + 6}`);
    });
    fixtures.forEach((fixture, index) => requireLaneAction(cycleActions[index + 25], { role: 'button', label: `Remove ${fixture}`, kind: 'press', timeoutMs: 2000, eventType: 'click', prior: 'present', axPrior: { kind: 'element_present' }, completion: { kind: 'element_absent', role: 'button', label: `Remove ${fixture}`, attribute: undefined, value: undefined } }, offset + index + 26));
    requireLaneAction(cycleActions[33], { role: 'link', label: 'Extract', kind: 'press', timeoutMs: 2000, eventType: 'click', prior: '/convert', axPrior: { kind: 'attribute_equals', attribute: 'AXSelected', value: false }, completion: { kind: 'attribute_equals', role: 'link', label: 'Extract', attribute: 'AXSelected', value: true } }, offset + 34);
    requireLaneAction(cycleActions[34], { role: 'link', label: 'Convert', kind: 'press', timeoutMs: 2000, eventType: 'click', prior: '/extract', axPrior: { kind: 'attribute_equals', attribute: 'AXSelected', value: false }, completion: { kind: 'attribute_equals', role: 'link', label: 'Convert', attribute: 'AXSelected', value: true } }, offset + 35);
  }
  return actions;
}

export function validateHarnessPaths({ binary, manifest, reportDirectory, appDataDirectory }) {
  for (const [label, path] of Object.entries({ binary, manifest, reportDirectory, appDataDirectory })) {
    if (!isAbsolute(path)) throw Error(`${label} path must be absolute`);
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) throw Error(`${label} path must not be a symbolic link`);
    if ((label === 'binary' || label === 'manifest') && !stats.isFile()) throw Error(`${label} must be a regular file`);
    if ((label === 'reportDirectory' || label === 'appDataDirectory') && !stats.isDirectory()) throw Error(`${label} must be a directory`);
    if (realpathSync(path) !== path) throw Error(`${label} path must be canonical`);
  }
  if (statSync(manifest).size > MAX_MANIFEST_BYTES) throw Error('Responsiveness manifest exceeds 2 MiB');
  return { binary, manifest, reportDirectory, appDataDirectory };
}

function validateIdentityFileMap(value, label) {
  if (!plainObject(value) || Object.keys(value).length === 0 || Object.keys(value).length > 64) throw Error(`${label} identity inputs must be a nonempty object`);
  for (const [id, path] of Object.entries(value)) {
    boundedString(id, `${label} identity ID`, { pattern: OPAQUE });
    if (!isAbsolute(path)) throw Error(`${label} identity path must be absolute`);
    const stats = lstatSync(path);
    if (stats.isSymbolicLink() || !stats.isFile() || realpathSync(path) !== path || stats.size < 1) throw Error(`${label} identity path must be a canonical nonempty regular file`);
  }
  return value;
}

export function captureResponsivenessIdentity(plan) {
  exactKeys(plan.identity_inputs, ['repository', 'bindings_path', 'runtime_sidecars', 'fixtures', 'configurations'], 'responsiveness identity inputs');
  const { repository, bindings_path: bindingsPath } = plan.identity_inputs;
  if (!isAbsolute(repository) || lstatSync(repository).isSymbolicLink() || !lstatSync(repository).isDirectory() || realpathSync(repository) !== repository) throw Error('Identity repository must be an absolute canonical directory');
  validateIdentityFileMap({ bindings: bindingsPath }, 'bindings');
  const sidecars = validateIdentityFileMap(plan.identity_inputs.runtime_sidecars, 'runtime sidecar');
  const fixtures = validateIdentityFileMap(plan.identity_inputs.fixtures, 'fixture');
  const configurations = validateIdentityFileMap(plan.identity_inputs.configurations, 'configuration');
  const manifests = Object.fromEntries(plan.pages.map((page, index) => [`page-${index + 1}`, page.manifest_path]));
  validateIdentityFileMap(manifests, 'manifest');
  const manifestText = plan.pages.map(page => {
    const text = readFileSync(page.manifest_path, 'utf8');
    return `${byteLength(text)}:${text}`;
  }).join('');
  const captured = captureIdentity({ cwd: repository, manifestText, bindingsText: readFileSync(bindingsPath, 'utf8'), executables: { app: plan.binary }, sidecars, parameters: { fixtures: Object.keys(fixtures), configurations: Object.keys(configurations) } });
  validateCapturedIdentity(captured, 'responsiveness identity');
  const describe = values => Object.entries(values).sort(([left], [right]) => left.localeCompare(right)).map(([id, path]) => ({ id, sha256: sha256File(path), bytes: statSync(path).size }));
  return validateEvidenceIdentity({
    source: captured.source,
    binary: { sha256: sha256File(plan.binary), bytes: statSync(plan.binary).size },
    runtime_sidecars: describe(sidecars), fixtures: describe(fixtures), configurations: describe(configurations), manifests: describe(manifests),
    bindings_sha256: createHash('sha256').update(readFileSync(bindingsPath)).digest('hex'),
  });
}

function readRegularJson(path, maximumBytes, label) {
  if (!isAbsolute(path)) throw Error(`${label} path must be absolute`);
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isFile()) throw Error(`${label} must be a regular no-symlink file`);
  if (stats.size > maximumBytes) throw Error(`${label} exceeds byte limit`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function validateFrontendScalars(value, label = 'frontend component', rejectPaths = true) {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') { safeInteger(value, label); return; }
  if (typeof value === 'string') {
    boundedString(value, label, { allowEmpty: true });
    if (rejectPaths && (value.includes('/') || value.includes('\\'))) throw Error(`${label} contains path-like text`);
    return;
  }
  if (Array.isArray(value)) { value.forEach((entry, index) => validateFrontendScalars(entry, `${label}[${index}]`, rejectPaths)); return; }
  if (!plainObject(value)) throw Error(`${label} contains a non-JSON value`);
  for (const [key, entry] of Object.entries(value)) {
    boundedString(key, 'frontend field');
    validateFrontendScalars(entry, `${label}.${key}`, rejectPaths);
  }
}

const ACTION_STATES = new Set(['armed', 'active', 'settled', 'cancelled']);
const SETUP_STATES = new Set(['active', 'settled', 'cancelled']);
const EVENT_KINDS = new Set(['armed', 'event_received', 'handler_start', 'handler_end', 'state_visible', 'double_raf', 'scenario_settled', 'inspection_queued', 'inspection_started', 'inspection_settled', 'inspection_delivered', 'inspection_cancelled', 'persistence_settled']);
const SPAN_KINDS = new Set(['inspection_queue', 'inspection_native', 'inspection_delivery', 'ipc_round_trip', 'draft_encode', 'storage_write', 'recovery_verification']);
const FAILURE_CODES = new Set(['observer_init', 'observer_delivery', 'frame_schedule', 'frame_callback', 'state_transition', 'capacity_accounting', 'serialization']);
const FAILURE_PHASES = new Set(['create', 'install', 'action', 'setup', 'span', 'observer', 'frame', 'teardown', 'serialize']);
const BROWSER_LIMITATIONS = new Set(['event_timing_unsupported', 'long_tasks_unsupported']);
const TIMING_NAMES = new Set(['click', 'keydown', 'input', 'change']);
const TIMING_BUCKET_KEYS = ['le_8_334_us', 'le_16_667_us', 'le_33_334_us', 'le_50_000_us', 'le_100_000_us', 'le_250_000_us', 'overflow'];

function validateEvidenceDescriptors(values, label) {
  if (!Array.isArray(values) || values.length === 0 || values.length > 64) throw Error(`Invalid ${label} identities`);
  const ids = new Set();
  values.forEach((value, index) => {
    exactKeys(value, ['id', 'sha256', 'bytes'], `${label} identity ${index}`);
    boundedString(value.id, `${label} identity ID`, { pattern: OPAQUE });
    if (ids.has(value.id) || !SHA256.test(value.sha256)) throw Error(`Invalid ${label} identity`);
    ids.add(value.id); safeInteger(value.bytes, `${label} identity bytes`, 1);
  });
}

function validateEvidenceIdentity(identity) {
  exactKeys(identity, ['source', 'binary', 'runtime_sidecars', 'fixtures', 'configurations', 'manifests', 'bindings_sha256'], 'sample identity');
  exactKeys(identity.source, ['head', 'tree', 'dirty_digest', 'dirty'], 'source identity');
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(identity.source.head) || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(identity.source.tree) || !SHA256.test(identity.source.dirty_digest) || typeof identity.source.dirty !== 'boolean') throw Error('Invalid source identity');
  exactKeys(identity.binary, ['sha256', 'bytes'], 'binary identity');
  if (!SHA256.test(identity.binary.sha256)) throw Error('Invalid binary identity'); safeInteger(identity.binary.bytes, 'binary bytes', 1);
  validateEvidenceDescriptors(identity.runtime_sidecars, 'runtime sidecar'); validateEvidenceDescriptors(identity.fixtures, 'fixture'); validateEvidenceDescriptors(identity.configurations, 'configuration'); validateEvidenceDescriptors(identity.manifests, 'manifest');
  if (!SHA256.test(identity.bindings_sha256)) throw Error('Invalid bindings identity');
  return identity;
}

function nullableInteger(value, label, minimum = 0) {
  if (value !== null) safeInteger(value, label, minimum);
}

function nullableOpaque(value, label) {
  if (value !== null) boundedString(value, label, { pattern: OPAQUE });
}

function validateOwner(owner, actionIds, setupIds, label) {
  if (!plainObject(owner) || !['action', 'setup'].includes(owner.kind)) throw Error(`Invalid ${label} owner`);
  exactKeys(owner, owner.kind === 'action' ? ['kind', 'action_id'] : ['kind', 'setup_id'], `${label} owner`);
  const id = owner.kind === 'action' ? owner.action_id : owner.setup_id;
  safeInteger(id, `${label} owner ID`, 1);
  if (!(owner.kind === 'action' ? actionIds : setupIds).has(id)) throw Error(`${label} refers to an unknown owner`);
}

function validateBuckets(buckets, label) {
  exactKeys(buckets, TIMING_BUCKET_KEYS, `${label} buckets`);
  TIMING_BUCKET_KEYS.forEach(key => safeInteger(buckets[key], `${label}.${key}`));
}

function validateAggregate(aggregate, label) {
  exactKeys(aggregate, ['count', 'total_us', 'max_us', 'buckets'], label);
  safeInteger(aggregate.count, `${label} count`); safeInteger(aggregate.total_us, `${label} total`); safeInteger(aggregate.max_us, `${label} maximum`);
  validateBuckets(aggregate.buckets, label);
  if (Object.values(aggregate.buckets).reduce((sum, value) => sum + value, 0) !== aggregate.count) throw Error(`${label} bucket count mismatch`);
}

function validateTimingEntry(entry, label, actionIds) {
  exactKeys(entry, ['name', 'start_us', 'duration_us', 'interaction_id', 'action_id', 'cycle_index'], label);
  if (!TIMING_NAMES.has(entry.name)) throw Error(`Invalid ${label} name`);
  safeInteger(entry.start_us, `${label} start`); safeInteger(entry.duration_us, `${label} duration`);
  nullableInteger(entry.interaction_id, `${label} interaction ID`); nullableInteger(entry.action_id, `${label} action ID`, 1); nullableInteger(entry.cycle_index, `${label} cycle index`);
  if (entry.action_id !== null && !actionIds.has(entry.action_id)) throw Error(`${label} refers to an unknown action`);
  if (entry.cycle_index !== null && entry.cycle_index >= SESSION_CYCLES) throw Error(`${label} cycle index exceeds Lane 3`);
}

function validateBrowserTiming(browser, actionIds) {
  exactKeys(browser, ['event_timing', 'long_tasks', 'raf_gaps'], 'browser timing');
  exactKeys(browser.event_timing, ['supported', 'raw', 'aggregate', 'by_action'], 'Event Timing evidence');
  if (typeof browser.event_timing.supported !== 'boolean' || !Array.isArray(browser.event_timing.raw) || browser.event_timing.raw.length > 512 || !Array.isArray(browser.event_timing.by_action) || browser.event_timing.by_action.length > 8192) throw Error('Invalid Event Timing evidence');
  browser.event_timing.raw.forEach((entry, index) => validateTimingEntry(entry, `Event Timing entry ${index}`, actionIds));
  if (browser.event_timing.aggregate !== null) validateAggregate(browser.event_timing.aggregate, 'Event Timing aggregate');
  browser.event_timing.by_action.forEach((entry, index) => {
    exactKeys(entry, ['name', 'action_id', 'cycle_index', 'aggregate'], `Event Timing action aggregate ${index}`);
    if (!TIMING_NAMES.has(entry.name) || !actionIds.has(entry.action_id)) throw Error('Invalid Event Timing action aggregate identity');
    nullableInteger(entry.cycle_index, 'Event Timing action cycle index');
    validateAggregate(entry.aggregate, `Event Timing action aggregate ${index}`);
  });
  exactKeys(browser.long_tasks, ['supported', 'raw', 'aggregate'], 'Long Tasks evidence');
  if (typeof browser.long_tasks.supported !== 'boolean' || !Array.isArray(browser.long_tasks.raw) || browser.long_tasks.raw.length > 512) throw Error('Invalid Long Tasks evidence');
  browser.long_tasks.raw.forEach((entry, index) => {
    exactKeys(entry, ['start_us', 'duration_us'], `Long Task ${index}`); safeInteger(entry.start_us, 'Long Task start'); safeInteger(entry.duration_us, 'Long Task duration');
  });
  if (browser.long_tasks.aggregate !== null) validateAggregate(browser.long_tasks.aggregate, 'Long Tasks aggregate');
  exactKeys(browser.raf_gaps, ['count', 'max_us', 'buckets'], 'rAF gap evidence');
  safeInteger(browser.raf_gaps.count, 'rAF gap count'); safeInteger(browser.raf_gaps.max_us, 'rAF gap maximum'); validateBuckets(browser.raf_gaps.buckets, 'rAF gaps');
  if (browser.raf_gaps.count > 180_000 || Object.values(browser.raf_gaps.buckets).reduce((sum, value) => sum + value, 0) !== browser.raf_gaps.count) throw Error('Invalid rAF gap evidence');
}

function validateFrontendComponent(component) {
  if (!plainObject(component) || component.schema_version !== 2 || component.component_kind !== 'frontend_trace') throw Error('Invalid frontend component schema');
  exactKeys(component, ['schema_version', 'component_kind', 'component_role', 'session_id', 'sample_id', 'page_instance_id', 'lane', 'scenario', 'workload', 'phase', 'repetition', 'clock_origin', 'setups', 'actions', 'events', 'spans', 'browser_timing', 'dropped_events', 'late_events', 'observer_entries_aggregated', 'limitations', 'failure', 'settled'], 'frontend component');
  if (!ROLES.has(component.component_role) || !UUID.test(component.session_id) || !UUID.test(component.page_instance_id) || !LANES.has(component.lane) || !PHASES.has(component.phase)) throw Error('Invalid frontend component identity');
  boundedString(component.sample_id, 'frontend sample ID');
  exactKeys(component.scenario, ['id', 'manifest_sha256'], 'frontend scenario');
  if (!plainObject(component.scenario) || !OPAQUE.test(component.scenario.id) || !SHA256.test(component.scenario.manifest_sha256)) throw Error('Invalid frontend scenario identity');
  exactKeys(component.workload, ['id', 'facts'], 'frontend workload');
  if (!plainObject(component.workload) || !OPAQUE.test(component.workload.id)) throw Error('Invalid frontend workload');
  validateFacts(component.workload.facts);
  safeInteger(component.repetition, 'frontend repetition');
  exactKeys(component.clock_origin, ['domain', 'unit'], 'frontend clock origin');
  if (component.clock_origin.domain !== 'webview_monotonic' || component.clock_origin.unit !== 'us') throw Error('Invalid frontend clock origin');
  for (const [field, maximum] of [['setups', 256], ['actions', 2048], ['spans', 8192], ['events', 16384]]) if (!Array.isArray(component[field]) || component[field].length > maximum) throw Error(`Frontend ${field} cap exceeded`);
  const actionIds = new Set();
  component.actions.forEach((action, index) => {
    exactKeys(action, ['action_id', 'target_id', 'state', 'armed_us', 'active_us', 'terminal_us'], `frontend action ${index}`);
    if (action.action_id !== index + 1 || !ACTION_STATES.has(action.state)) throw Error('Invalid frontend action identity or state');
    boundedString(action.target_id, 'frontend action target', { pattern: OPAQUE }); safeInteger(action.armed_us, 'frontend action arm time'); nullableInteger(action.active_us, 'frontend action active time'); nullableInteger(action.terminal_us, 'frontend action terminal time');
    if (action.active_us !== null && action.active_us < action.armed_us || action.terminal_us !== null && action.terminal_us < (action.active_us ?? action.armed_us)) throw Error('Frontend action timestamps are not monotonic');
    if (action.state === 'armed' && (action.active_us !== null || action.terminal_us !== null) || action.state === 'active' && (action.active_us === null || action.terminal_us !== null) || ['settled', 'cancelled'].includes(action.state) && action.terminal_us === null) throw Error('Frontend action state/timestamps mismatch');
    actionIds.add(action.action_id);
  });
  const setupIds = new Set();
  component.setups.forEach((setup, index) => {
    exactKeys(setup, ['setup_id', 'target_id', 'state', 'start_us', 'terminal_us'], `frontend setup ${index}`);
    if (setup.setup_id !== index + 1 || !SETUP_STATES.has(setup.state)) throw Error('Invalid frontend setup identity or state');
    boundedString(setup.target_id, 'frontend setup target', { pattern: OPAQUE }); safeInteger(setup.start_us, 'frontend setup start'); nullableInteger(setup.terminal_us, 'frontend setup terminal');
    if (setup.terminal_us !== null && setup.terminal_us < setup.start_us || setup.state === 'active' && setup.terminal_us !== null || setup.state !== 'active' && setup.terminal_us === null) throw Error('Frontend setup state/timestamps mismatch');
    setupIds.add(setup.setup_id);
  });
  const spanIds = new Set(component.spans.map(span => span.span_id));
  if (spanIds.size !== component.spans.length) throw Error('Duplicate frontend span ID');
  component.spans.forEach((span, index) => {
    exactKeys(span, ['span_id', 'owner', 'parent_span_id', 'kind', 'subject_id', 'start_us', 'end_us', 'terminal', 'terminal_cause_action_id'], `frontend span ${index}`);
    safeInteger(span.span_id, 'frontend span ID', 1); validateOwner(span.owner, actionIds, setupIds, `frontend span ${index}`); nullableInteger(span.parent_span_id, 'frontend parent span ID', 1); if (span.parent_span_id !== null && (!spanIds.has(span.parent_span_id) || span.parent_span_id >= span.span_id)) throw Error('Invalid frontend parent span');
    if (!SPAN_KINDS.has(span.kind) || !['ended', 'cancelled'].includes(span.terminal)) throw Error('Invalid frontend span kind or terminal');
    nullableOpaque(span.subject_id, 'frontend span subject'); safeInteger(span.start_us, 'frontend span start'); safeInteger(span.end_us, 'frontend span end'); if (span.end_us < span.start_us) throw Error('Frontend span timestamps are not monotonic');
    nullableInteger(span.terminal_cause_action_id, 'frontend span terminal cause', 1); if (span.terminal_cause_action_id !== null && !actionIds.has(span.terminal_cause_action_id)) throw Error('Frontend span terminal cause is unknown');
  });
  component.events.forEach((event, index) => {
    exactKeys(event, ['event_seq', 'owner', 'span_id', 'kind', 'at_us', 'subject_id', 'correlation_id'], `frontend event ${index}`);
    if (event.event_seq !== index + 1 || !EVENT_KINDS.has(event.kind)) throw Error('Invalid frontend event sequence or kind');
    validateOwner(event.owner, actionIds, setupIds, `frontend event ${index}`); nullableInteger(event.span_id, 'frontend event span ID', 1); if (event.span_id !== null && !spanIds.has(event.span_id)) throw Error('Frontend event span is unknown');
    safeInteger(event.at_us, 'frontend event time'); nullableOpaque(event.subject_id, 'frontend event subject'); nullableOpaque(event.correlation_id, 'frontend event correlation');
  });
  validateBrowserTiming(component.browser_timing, actionIds);
  for (const field of ['dropped_events', 'late_events', 'observer_entries_aggregated']) safeInteger(component[field], field);
  if (!Array.isArray(component.limitations) || component.limitations.some(value => !BROWSER_LIMITATIONS.has(value)) || new Set(component.limitations).size !== component.limitations.length || typeof component.settled !== 'boolean') throw Error('Invalid frontend status');
  if (component.failure !== null) {
    exactKeys(component.failure, ['code', 'phase', 'count'], 'frontend failure');
    if (!FAILURE_CODES.has(component.failure.code) || !FAILURE_PHASES.has(component.failure.phase)) throw Error('Invalid frontend failure');
    safeInteger(component.failure.count, 'frontend failure count', 1);
  }
  validateFrontendScalars(component);
  if (byteLength(JSON.stringify(component)) > MAX_COMPONENT_BYTES) throw Error('Frontend component exceeds 6 MiB');
  return component;
}

export function validateFrontendComponents(components, lane) {
  if (!LANES.has(lane) || !Array.isArray(components)) throw Error('Invalid frontend component collection');
  const validated = components.map(validateFrontendComponent);
  const expectedRoles = lane === 'draft' ? ['pre_quit', 'recovery'] : ['primary'];
  if (validated.length !== expectedRoles.length || expectedRoles.some(role => validated.filter(component => component.component_role === role).length !== 1)) throw Error(`Invalid ${lane} frontend component cardinality`);
  const first = validated[0];
  const identity = component => canonicalizeJcs({
    session_id: component.session_id, sample_id: component.sample_id, lane: component.lane,
    scenario: component.scenario, workload: component.workload, phase: component.phase, repetition: component.repetition,
  });
  if (validated.some(component => component.lane !== lane || identity(component) !== identity(first))) throw Error('Frontend component identity mismatch');
  if (new Set(validated.map(component => component.page_instance_id)).size !== validated.length) throw Error('Frontend components must use distinct page instance IDs');
  if (validated.reduce((sum, component) => sum + byteLength(JSON.stringify(component)), 0) > MAX_FRONTEND_BYTES) throw Error('Summed frontend component budget exceeds 6 MiB');
  return validated;
}

const LIMITATIONS = new Set(['event_timing_unsupported', 'long_tasks_unsupported', 'webkit_process_unattributed', 'related_process_partial', 'accessibility_interrupted', 'focus_lost', 'sampling_missed', 'instrumentation_overhead_exceeded', 'exploratory_soak_only']);

function validateCleanupReceipt(receipt, expected = null) {
  exactKeys(receipt, ['schema_version', 'component_kind', 'session_id', 'webview_data_store_id', 'removed', 'error_code', 'pid', 'native_clock'], 'data-store cleanup receipt');
  if (receipt.schema_version !== 2 || receipt.component_kind !== 'data_store_cleanup' || !UUID.test(receipt.session_id) || typeof receipt.removed !== 'boolean' || receipt.error_code !== null || !Number.isSafeInteger(receipt.pid) || receipt.pid < 1) throw Error('Invalid data-store cleanup receipt');
  if (!Array.isArray(receipt.webview_data_store_id) || receipt.webview_data_store_id.length !== 16 || receipt.webview_data_store_id.some(value => !Number.isSafeInteger(value) || value < 0 || value > 255)) throw Error('Invalid data-store cleanup ID');
  exactKeys(receipt.native_clock, ['domain', 'unit', 'elapsed_us'], 'cleanup native clock');
  if (receipt.native_clock.domain !== 'native_monotonic' || receipt.native_clock.unit !== 'us' || !Number.isSafeInteger(receipt.native_clock.elapsed_us) || receipt.native_clock.elapsed_us < 0) throw Error('Invalid cleanup native clock');
  if (expected && (receipt.session_id !== expected.sessionId || canonicalizeJcs(receipt.webview_data_store_id) !== canonicalizeJcs(expected.webviewDataStoreId))) throw Error('Data-store cleanup receipt identity mismatch');
  return receipt;
}

function validateLanePayload(lane, payload, outcome) {
  if (lane === 'inspection') {
    const required = ['fixture_ids', 'queue_order', 'start_order', 'settle_order', 'deliver_order', 'cancel_order', 'maximum_concurrency', 'first_ready_us', 'last_nonretired_ready_us', 'all_terminal_us', 'selected_fixture_id', 'retired_fixture_id', 'external_selection_duration_us', 'interaction_to_double_raf_us'];
    exactRequiredAndOptionalKeys(payload, required, ['driver_observations', 'process_series', 'process_summaries'], 'inspection payload');
    if (!Array.isArray(payload.fixture_ids) || payload.fixture_ids.length < 1 || payload.fixture_ids.length > 2048 || new Set(payload.fixture_ids).size !== payload.fixture_ids.length) throw Error('Invalid inspection fixture IDs');
    payload.fixture_ids.forEach(value => boundedString(value, 'inspection fixture ID', { pattern: OPAQUE }));
    for (const field of ['queue_order', 'start_order', 'settle_order', 'deliver_order', 'cancel_order']) {
      if (!Array.isArray(payload[field]) || payload[field].some(id => !payload.fixture_ids.includes(id))) throw Error(`Invalid inspection ${field}`);
    }
    safeInteger(payload.maximum_concurrency, 'inspection maximum concurrency', 1);
    for (const field of ['first_ready_us', 'last_nonretired_ready_us', 'all_terminal_us', 'external_selection_duration_us', 'interaction_to_double_raf_us']) safeInteger(payload[field], `inspection ${field}`);
    if (!payload.fixture_ids.includes(payload.selected_fixture_id) || payload.retired_fixture_id !== null && !payload.fixture_ids.includes(payload.retired_fixture_id)) throw Error('Invalid inspection selected/retired fixture');
  } else if (lane === 'draft') {
    const required = ['seed_entry_count', 'seed_byte_count', 'action_summaries', 'encode_span_ids', 'storage_span_ids', 'logical_persistence_acknowledged', 'expected_draft_sha256', 'recovered_draft_sha256', 'expected_ax_value', 'recovered_ax_value'];
    exactRequiredAndOptionalKeys(payload, required, ['driver_observations', 'process_series', 'process_summaries'], 'draft payload');
    safeInteger(payload.seed_entry_count, 'draft seed entry count'); safeInteger(payload.seed_byte_count, 'draft seed byte count');
    if (!Array.isArray(payload.action_summaries) || payload.action_summaries.length !== 20) throw Error('Draft action summaries must contain 20 actions');
    payload.action_summaries.forEach((summary, index) => {
      exactKeys(summary, ['action_id'], `draft action summary ${index}`);
      if (summary.action_id !== index + 1) throw Error('Draft action summaries must be ordered from 1 through 20');
    });
    for (const field of ['encode_span_ids', 'storage_span_ids']) if (!Array.isArray(payload[field]) || payload[field].some(value => !Number.isSafeInteger(value) || value < 1)) throw Error(`Invalid draft ${field}`);
    if (typeof payload.logical_persistence_acknowledged !== 'boolean') throw Error('Invalid draft persistence acknowledgement');
    if (!SHA256.test(payload.expected_draft_sha256 ?? '') || payload.recovered_draft_sha256 !== null && !SHA256.test(payload.recovered_draft_sha256 ?? '')) throw Error('Invalid draft payload digest');
    boundedString(payload.expected_ax_value, 'draft expected_ax_value', { allowEmpty: true });
    if (payload.recovered_ax_value !== null) boundedString(payload.recovered_ax_value, 'draft recovered_ax_value', { allowEmpty: true });
    if (outcome.kind === 'success' && (payload.recovered_draft_sha256 === null || payload.recovered_ax_value === null)) throw Error('Successful draft payload requires complete recovery evidence');
  } else {
    exactKeys(payload, ['cycle_summaries', 'driver_observations', 'process_series', 'process_summaries'], 'session-memory payload');
    if (!Array.isArray(payload.cycle_summaries) || payload.cycle_summaries.length !== SESSION_CYCLES) throw Error('Session-memory payload requires exactly 50 cycle summaries');
    payload.cycle_summaries.forEach((summary, index) => {
      exactKeys(summary, ['cycle_index'], `session-memory cycle summary ${index}`);
      if (summary.cycle_index !== index) throw Error('Session-memory cycle summaries must be ordered from 0 through 49');
    });
    if (!Array.isArray(payload.process_series) || payload.process_series.length !== 1 || !Array.isArray(payload.process_summaries) || payload.process_summaries.length !== 1) throw Error('Session-memory payload requires exactly one process series and summary');
    validateProcessSeries(payload.process_series[0]);
    if (canonicalizeJcs(payload.process_summaries[0]) !== canonicalizeJcs(summarizeProcessSeries(payload.process_series[0]))) throw Error('Session-memory process summary does not match its series');
  }
  if (payload.driver_observations !== undefined) {
    if (!Array.isArray(payload.driver_observations) || payload.driver_observations.length > 4096) throw Error('Invalid flattened driver observations');
    payload.driver_observations.forEach((observation, index) => {
      exactKeys(observation, ['ordinal', 'driver_duration_us', 'observed_value', 'clock_domain'], `flattened driver observation ${index}`);
      safeInteger(observation.ordinal, 'flattened driver ordinal', 1); safeInteger(observation.driver_duration_us, 'flattened driver duration');
      if (observation.clock_domain !== 'driver_monotonic' || !['string', 'number', 'boolean'].includes(typeof observation.observed_value) && observation.observed_value !== null) throw Error('Invalid flattened driver observation');
      if (typeof observation.observed_value === 'string' && byteLength(observation.observed_value) > 4096) throw Error('Flattened driver observed value exceeds bound');
      if (typeof observation.observed_value === 'number') safeInteger(observation.observed_value, 'flattened driver observed number');
    });
  }
  if (lane !== 'session_memory' && (payload.process_series !== undefined || payload.process_summaries !== undefined)) {
    if (!Array.isArray(payload.process_series) || !Array.isArray(payload.process_summaries) || payload.process_series.length !== payload.process_summaries.length || payload.process_series.length > 2) throw Error('Invalid optional process evidence');
    payload.process_series.forEach((series, index) => {
      validateProcessSeries(series);
      if (canonicalizeJcs(payload.process_summaries[index]) !== canonicalizeJcs(summarizeProcessSeries(series))) throw Error('Process summary does not match its series');
    });
  }
}

export function assembleSample({ lane, frontendComponents, nativePageComponents = [], common, payload }) {
  const components = validateFrontendComponents(frontendComponents, lane);
  if (!plainObject(common) || !plainObject(payload)) throw Error('Sample components must be objects');
  const first = components[0];
  const commonAllowed = ['identity', 'clock_origins', 'limitations', 'cleanup', 'outcome', 'data_store_cleanup'];
  if (Object.keys(common).some(key => !commonAllowed.includes(key)) || ['identity', 'clock_origins', 'limitations', 'cleanup', 'outcome'].some(key => common[key] === undefined)) throw Error('Invalid common sample fields');
  validateEvidenceIdentity(common.identity);
  exactKeys(common.clock_origins, ['driver_monotonic', 'native_monotonic'], 'sample clock origins');
  for (const name of ['driver_monotonic', 'native_monotonic']) {
    exactKeys(common.clock_origins[name], ['unit'], `${name} clock origin`);
    if (common.clock_origins[name].unit !== 'us') throw Error('Invalid sample clock origins');
  }
  if (!Array.isArray(common.limitations) || common.limitations.some(value => !LIMITATIONS.has(value)) || new Set(common.limitations).size !== common.limitations.length) throw Error('Invalid sample limitation');
  exactKeys(common.cleanup, ['complete', 'removed_paths', 'error_code'], 'sample cleanup');
  if (typeof common.cleanup.complete !== 'boolean' || !Number.isSafeInteger(common.cleanup.removed_paths) || common.cleanup.removed_paths < 0 || ![null, ...CLEANUP_FAILURE_CODES].includes(common.cleanup.error_code)) throw Error('Invalid cleanup record');
  if (common.cleanup.complete !== (common.cleanup.error_code === null)) throw Error('Cleanup completeness and error code disagree');
  if (!plainObject(common.outcome)) throw Error('Invalid sample outcome');
  if (common.outcome.kind === 'success' ? Object.keys(common.outcome).length !== 1
    : common.outcome.kind === 'failed' ? Object.keys(common.outcome).length !== 2 || !SAMPLE_FAILURE_CODES.has(common.outcome.code)
      : common.outcome.kind === 'inconclusive' ? Object.keys(common.outcome).length !== 2 || !SAMPLE_INCONCLUSIVE_CODES.has(common.outcome.code)
        : true) throw Error('Invalid sample outcome');
  if (common.outcome.kind === 'success' && components.some(component => !component.settled || component.failure !== null || component.dropped_events !== 0 || component.late_events !== 0)) throw Error('Successful sample contains an invalid frontend component');
  if (common.data_store_cleanup !== undefined && common.data_store_cleanup !== null) validateCleanupReceipt(common.data_store_cleanup);
  if (lane === 'draft' && common.outcome.kind === 'success') {
    if (!SHA256.test(payload.expected_draft_sha256 ?? '') || payload.recovered_draft_sha256 !== payload.expected_draft_sha256 || payload.recovered_ax_value !== payload.expected_ax_value) throw Error('Draft recovery mismatch');
  }
  validateLanePayload(lane, payload, common.outcome);
  if (!Array.isArray(nativePageComponents) || nativePageComponents.length !== 0 && nativePageComponents.length !== components.length) throw Error('Native page component cardinality mismatch');
  const nativeFacts = nativePageComponents.map((page, index) => {
    const expected = components[index];
    if (page.frontend_trace !== expected && canonicalizeJcs(page.frontend_trace) !== canonicalizeJcs(expected)) throw Error('Native page component trace mismatch');
    if (page.session_id !== expected.session_id || page.sample_id !== expected.sample_id || page.page_instance_id !== expected.page_instance_id || page.component_role !== expected.component_role) throw Error('Native page component identity mismatch');
    return {
      schema_version: page.schema_version,
      component_kind: page.component_kind,
      session_id: page.session_id,
      sample_id: page.sample_id,
      page_instance_id: page.page_instance_id,
      component_role: page.component_role,
      pid: page.pid,
      native_clock: page.native_clock,
    };
  });
  const sample = {
    schema_version: 2,
    session_id: first.session_id,
    sample_id: first.sample_id,
    lane,
    scenario: first.scenario,
    workload: first.workload,
    phase: first.phase,
    repetition: first.repetition,
    identity: common.identity,
    frontend_components: components,
    native_page_components: nativeFacts,
    clock_origins: common.clock_origins,
    limitations: common.limitations,
    cleanup: common.cleanup,
    data_store_cleanup: common.data_store_cleanup ?? null,
    outcome: common.outcome,
    payload,
  };
  const encoded = canonicalizeJcs(sample);
  if (byteLength(encoded) > MAX_SAMPLE_BYTES) throw Error('Assembled sample exceeds 8 MiB');
  return sample;
}

export function publishSampleExclusive(directory, sample) {
  if (!isAbsolute(directory)) throw Error('Publication directory must be absolute');
  const directoryStats = lstatSync(directory);
  if (directoryStats.isSymbolicLink()) throw Error('Publication directory must not be a symbolic link');
  if (!directoryStats.isDirectory()) throw Error('Publication target must be a directory');
  if (realpathSync(directory) !== directory) throw Error('Publication directory must be canonical');
  const canonical = canonicalizeJcs(sample);
  const bytes = byteLength(canonical);
  if (bytes > MAX_SAMPLE_BYTES) throw Error('Final sample size exceeds 8 MiB');
  const target = join(directory, 'sample.json');
  const temporary = join(directory, `.sample-${process.pid}-${randomUUID()}.tmp`);
  let temporaryCreated = false;
  try {
    const descriptor = openSync(temporary, 'wx', 0o600);
    temporaryCreated = true;
    try { writeFileSync(descriptor, canonical); fsyncSync(descriptor); } finally { closeSync(descriptor); }
    linkSync(temporary, target);
    unlinkSync(temporary);
    temporaryCreated = false;
    syncDirectoryPortable(directory);
  } catch (error) {
    if (temporaryCreated) { try { unlinkSync(temporary); } catch { /* Best-effort removal of an unpublished temp name. */ } }
    throw Error(`Exclusive sample publish failed: ${error.code ?? error.message}`);
  }
  return { path: target, bytes, sha256: createHash('sha256').update(canonical).digest('hex') };
}

export function writeComponentExclusive(directory, name, value, maximumBytes = 2 * 1024 * 1024) {
  if (!isAbsolute(directory) || lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory() || realpathSync(directory) !== directory) throw Error('Component directory must be absolute, canonical, and not a symbolic link');
  if (typeof name !== 'string' || !/^[a-z][a-z0-9-]*\.json$/.test(name)) throw Error('Invalid component filename');
  safeInteger(maximumBytes, 'component byte limit', 1);
  const encoded = canonicalizeJcs(value);
  if (byteLength(encoded) > maximumBytes) throw Error(`${name} exceeds its component byte limit`);
  const path = join(directory, name);
  const descriptor = openSync(path, 'wx', 0o600);
  try { writeFileSync(descriptor, encoded); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  syncDirectoryPortable(directory);
  return path;
}

export function classifyProcessAttribution({ rootStable, ownedDescendantsStable, relatedStable, relatedAmbiguous }) {
  if (!rootStable || !ownedDescendantsStable) return 'inconclusive';
  if (relatedStable && relatedAmbiguous) return 'partial_related_processes';
  return 'attributable_native_only';
}

export function summarizeProcessSeries(series, { relatedStable = false, relatedAmbiguous = true, minimumObservations = 30, minimumReadRatio = 0.95 } = {}) {
  validateProcessSeries(series);
  const observations = series.snapshots.map(snapshot => ({
    elapsed_us: snapshot.elapsed_us,
    rss_kib: snapshot.rss_by_process.reduce((sum, pair) => sum + pair[1], 0),
  }));
  const count = observations.length;
  const meanX = count === 0 ? 0 : observations.reduce((sum, value) => sum + value.elapsed_us, 0) / count;
  const meanY = count === 0 ? 0 : observations.reduce((sum, value) => sum + value.rss_kib, 0) / count;
  let numerator = 0, denominator = 0;
  for (const value of observations) {
    numerator += (value.elapsed_us - meanX) * (value.rss_kib - meanY);
    denominator += (value.elapsed_us - meanX) ** 2;
  }
  const slopePerMinute = denominator === 0 ? 0 : (numerator / denominator) * 60_000_000;
  const readRatio = series.scheduled_reads > 0 ? count / series.scheduled_reads : 0;
  const samplingComplete = count >= minimumObservations && readRatio >= minimumReadRatio;
  return {
    observation_count: count,
    scheduled_reads: series.scheduled_reads,
    missed_read_count: series.missed_reads,
    sampling_read_ratio: Number(readRatio.toFixed(6)),
    start_rss_kib: count > 0 ? observations[0].rss_kib : null,
    end_rss_kib: count > 0 ? observations.at(-1).rss_kib : null,
    peak_rss_kib: count > 0 ? Math.max(...observations.map(value => value.rss_kib)) : null,
    slope_kib_per_minute: Number(slopePerMinute.toFixed(3)),
    sampling_complete: samplingComplete,
    attribution_conclusion: samplingComplete ? classifyProcessAttribution({ rootStable: series.attribution_complete && !series.root_identity_drift, ownedDescendantsStable: series.attribution_complete, relatedStable, relatedAmbiguous }) : 'inconclusive',
  };
}

export function validateProcessSeries(series) {
  exactKeys(series, ['identities', 'snapshots', 'scheduled_reads', 'missed_reads', 'pid_reuse_count', 'churn', 'attribution_complete', 'root_identity_drift'], 'process series');
  if (!Array.isArray(series.identities) || series.identities.length < 1 || series.identities.length > 16 || !Array.isArray(series.snapshots) || series.snapshots.length > 2002) throw Error('Invalid identity-aware process series');
  const indexes = new Set();
  series.identities.forEach((identity, index) => {
    exactKeys(identity, ['process_index', 'pid', 'ppid', 'process_start_time', 'canonical_executable'], `process identity ${index}`);
    if (identity.process_index !== index) throw Error('Process identity indexes must be dense');
    safeInteger(identity.pid, 'process PID', 1); safeInteger(identity.ppid, 'process parent PID'); boundedString(identity.process_start_time, 'process start time', { maximum: 128 });
    if (typeof identity.canonical_executable !== 'string' || identity.canonical_executable.length === 0 || byteLength(identity.canonical_executable) > 4096) throw Error('Invalid canonical executable');
    indexes.add(index);
  });
  let previous = -1;
  series.snapshots.forEach((snapshot, index) => {
    exactKeys(snapshot, ['elapsed_us', 'rss_by_process'], `process snapshot ${index}`);
    safeInteger(snapshot.elapsed_us, 'process snapshot time'); if (snapshot.elapsed_us <= previous) throw Error('Process snapshot times must increase'); previous = snapshot.elapsed_us;
    if (!Array.isArray(snapshot.rss_by_process) || snapshot.rss_by_process.length < 1 || snapshot.rss_by_process.length > 16) throw Error('Invalid process snapshot RSS rows');
    const seen = new Set();
    snapshot.rss_by_process.forEach(pair => {
      if (!Array.isArray(pair) || pair.length !== 2 || !indexes.has(pair[0]) || seen.has(pair[0])) throw Error('Invalid process snapshot identity reference');
      safeInteger(pair[1], 'process RSS', 1); seen.add(pair[0]);
    });
  });
  for (const field of ['scheduled_reads', 'missed_reads', 'pid_reuse_count']) safeInteger(series[field], `process ${field}`);
  if (series.scheduled_reads !== series.snapshots.length + series.missed_reads || series.scheduled_reads > 2002) throw Error('Process scheduled/missed read accounting mismatch');
  exactKeys(series.churn, ['processes_started', 'processes_exited'], 'process churn'); safeInteger(series.churn.processes_started, 'processes started'); safeInteger(series.churn.processes_exited, 'processes exited');
  if (series.churn.processes_started !== series.identities.length || typeof series.attribution_complete !== 'boolean' || typeof series.root_identity_drift !== 'boolean') throw Error('Invalid process attribution evidence');
  return series;
}

export function createScheduledProcessSampler({ series, capture, nowMs = () => performance.now() }) {
  if (!series || typeof series.observe !== 'function' || typeof series.recordMiss !== 'function' || typeof capture !== 'function') throw Error('Invalid scheduled process sampler');
  let anchor = null, nextSlot = 0, lastElapsedUs = -1, stopped = false;
  const record = (elapsedUs, missed) => {
    if (elapsedUs <= lastElapsedUs) elapsedUs = lastElapsedUs + 1;
    lastElapsedUs = elapsedUs;
    if (missed) return series.recordMiss(elapsedUs);
    let snapshot;
    try { snapshot = capture(); } catch { return series.recordMiss(elapsedUs); }
    return series.observe(elapsedUs, snapshot);
  };
  const start = () => {
    if (anchor !== null) throw Error('Process sampler already started');
    anchor = nowMs(); nextSlot = 1; return record(0, false);
  };
  const pump = () => {
    if (anchor === null || stopped) return;
    const elapsed = nowMs() - anchor;
    if (!Number.isFinite(elapsed) || elapsed < 0) throw Error('Process sampler clock is invalid');
    const currentSlot = Math.floor(elapsed / 1000);
    while (nextSlot <= currentSlot) {
      record(nextSlot * 1_000_000, nextSlot < currentSlot);
      nextSlot += 1;
    }
  };
  const finish = settledAtMs => {
    if (anchor === null || stopped) throw Error('Process sampler is not active');
    pump();
    const now = nowMs();
    if (!Number.isFinite(settledAtMs) || now < settledAtMs || now - settledAtMs > 1000) throw Error('Terminal RSS sample missed the one-second settlement window');
    record(Math.round((now - anchor) * 1000), false);
    stopped = true;
  };
  return Object.freeze({ start, pump, finish });
}

function validateDriverObservations(observations, actions, allowPrefix = false) {
  if (!Array.isArray(observations) || (allowPrefix ? observations.length > actions.length : observations.length !== actions.length)) throw Error('Driver observation/action cardinality mismatch');
  observations.forEach((observation, index) => {
    exactKeys(observation, ['ordinal', 'driver_duration_us', 'observed_value', 'clock_domain'], `driver observation ${index}`);
    if (observation.ordinal !== actions[index].actionId || observation.clock_domain !== 'driver_monotonic') throw Error('Invalid driver observation identity');
    safeInteger(observation.driver_duration_us, 'driver duration');
    if (!['string', 'number', 'boolean'].includes(typeof observation.observed_value) && observation.observed_value !== null) throw Error('Invalid driver observed value');
    if (typeof observation.observed_value === 'string' && byteLength(observation.observed_value) > 4096) throw Error('Driver observed value exceeds bound');
    if (typeof observation.observed_value === 'number') safeInteger(observation.observed_value, 'driver observed number');
  });
  return observations;
}

const parseDriverReply = reply => {
  let value;
  try { value = JSON.parse(reply); } catch { throw Error('Accessibility driver returned invalid JSON'); }
  if (!plainObject(value)) throw Error('Accessibility driver returned an invalid record');
  return value;
};

const DOM_TO_AX_ROLE = Object.freeze({ button: 'AXButton', link: 'AXLink', textbox: 'AXTextField', navigation: 'AXGroup', dialog: 'AXWindow' });
const jxaPidProcess = expectedPid => `const matches=se.processes.whose({unixId:${expectedPid}})();const app=matches.length===1?matches[0]:null;`;
const normalizeAxRole = role => DOM_TO_AX_ROLE[role] ?? role;
const normalizeAxValue = (attribute, value) => {
  if (attribute === 'AXSelected' || attribute === 'AXEnabled') return value === true || value === 1 || value === '1' || value === 'true';
  if (attribute === 'AXValue') return value === null || value === undefined ? '' : String(value);
  return value;
};

function defaultRunScript(script, timeoutMs) {
  return new Promise((resolveRun, rejectRun) => execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: timeoutMs, maxBuffer: 64 * 1024, encoding: 'utf8' }, (error, stdout) => error ? rejectRun(Error(`Accessibility command failed: ${error.code ?? 'unknown'}`)) : resolveRun(stdout.trim())));
}

const jxaLiteral = value => JSON.stringify(value);

/** System Events AX driver. It intentionally has no coordinate-based operation. */
export function createAccessibilityDriver({ platform = process.platform, appName, expectedPid, runScript = defaultRunScript }) {
  if (platform !== 'darwin') throw Error('The responsiveness accessibility driver is macOS-only');
  boundedString(appName, 'application name');
  safeInteger(expectedPid, 'expected application PID', 1);

  const preflight = async requiredLabels => {
    if (!Array.isArray(requiredLabels) || requiredLabels.length > 128) throw Error('Invalid AX preflight labels');
    requiredLabels.forEach(label => boundedString(label, 'AX label'));
    const script = `ObjC.import('ApplicationServices');\nconst se=Application('System Events');\nconst trusted=$.AXIsProcessTrusted();\n${jxaPidProcess(expectedPid)}\nconst front=se.processes.whose({frontmost:true})();\nconst frontPid=front.length?front[0].unixId():null;\nconst windows=app?app.windows():[];\nconst labels=[];\nif(app){for(const item of app.entireContents()){try{const n=item.name();if(typeof n==='string'&&n.length)labels.push(n)}catch{}}}\nJSON.stringify({trusted:Boolean(trusted),frontmost_pid:frontPid,modal_count:windows.filter(w=>{try{return w.attributes.byName('AXModal').value()===true}catch{return false}}).length,labels});`;
    const value = parseDriverReply(await runScript(script, 5000));
    if (value.trusted !== true) throw Error('Accessibility permission is not granted');
    if (value.frontmost_pid !== expectedPid) throw Error('Goop is not the expected frontmost process');
    if (value.modal_count !== 0) throw Error('A modal dialog prevents AX preflight');
    for (const label of requiredLabels) if (!value.labels?.includes(label)) throw Error(`Required accessibility label is missing: ${label}`);
    return value;
  };

  const perform = async action => {
    safeInteger(action.ordinal, 'action ordinal', 1);
    boundedString(action.role, 'action role');
    boundedString(action.label, 'action label');
    safeInteger(action.timeout_ms, 'action timeout', 1);
    const axRole = normalizeAxRole(action.role);
    const expectedModalBefore = action.expected_modal_before ?? 0;
    const expectedModalAfter = action.expected_modal_after ?? 0;
    safeInteger(expectedModalBefore, 'expected modal count'); safeInteger(expectedModalAfter, 'expected modal count');
    const completion = action.completion;
    if (!plainObject(completion) || !['attribute_equals', 'element_absent'].includes(completion.kind)) throw Error('Unsupported accessibility completion predicate');
    const fallbackPriorAttribute = completion.kind === 'attribute_equals'
      && (completion.role === undefined || normalizeAxRole(completion.role) === axRole)
      && (completion.label === undefined || completion.label === action.label)
      ? completion.attribute
      : 'AXValue';
    const axPrior = action.ax_prior ?? (action.expected_prior_value === undefined
      ? { kind: 'element_present' }
      : { kind: 'attribute_equals', attribute: fallbackPriorAttribute, value: action.expected_prior_value });
    if (!plainObject(axPrior) || !['attribute_equals', 'element_present'].includes(axPrior.kind)) throw Error('Unsupported accessibility prior predicate');
    if (axPrior.kind === 'attribute_equals') exactKeys(axPrior, ['kind', 'attribute', 'value'], 'accessibility prior predicate');
    else exactKeys(axPrior, ['kind'], 'accessibility prior predicate');
    const priorAttribute = axPrior.kind === 'attribute_equals' ? axPrior.attribute : 'AXValue';
    boundedString(priorAttribute, 'accessibility prior-value attribute');
    const targetLookup = `const all=app.entireContents();const matches=all.filter(x=>{try{return x.role()===${jxaLiteral(axRole)}&&x.name()===${jxaLiteral(action.label)}}catch{return false}});const target=matches.length===1?matches[0]:null;`;
    const checkScript = `const se=Application('System Events');${jxaPidProcess(expectedPid)}if(!app)throw new Error('process missing');const front=se.processes.whose({frontmost:true})();const windows=app.windows();${targetLookup}const f=app.attributes.byName('AXFocusedUIElement').value();let current=null;if(target){try{current=target.attributes.byName(${jxaLiteral(priorAttribute)}).value()}catch{}}JSON.stringify({trusted:true,frontmost_pid:front.length?front[0].unixId():null,modal_count:windows.filter(w=>{try{return w.attributes.byName('AXModal').value()===true}catch{return false}}).length,target_count:matches.length,target_role:target?target.role():null,target_label:target?target.name():null,focused_role:f?f.role():null,focused_label:f?f.name():null,value:current});`;
    const before = parseDriverReply(await runScript(checkScript, Math.min(5000, action.timeout_ms)));
    if (before.frontmost_pid !== expectedPid) throw Error('Accessibility focus was lost before action dispatch');
    if (before.modal_count !== expectedModalBefore) throw Error('Unexpected modal state before accessibility dispatch');
    if (before.target_count !== 1 || before.target_role !== axRole || before.target_label !== action.label) throw Error('Accessibility action must resolve exactly one manifest target');
    if (axPrior.kind === 'attribute_equals' && JSON.stringify(normalizeAxValue(priorAttribute, before.value)) !== JSON.stringify(normalizeAxValue(priorAttribute, axPrior.value))) throw Error('Accessibility target prior value does not match the driver plan');
    if (['keystroke', 'key_chord', 'key_code'].includes(action.kind) && (before.focused_role !== axRole || before.focused_label !== action.label)) throw Error('Focused accessibility target does not match the manifest');
    const modifiers = action.modifiers ?? [];
    if (!Array.isArray(modifiers) || modifiers.some(value => !['command', 'shift', 'option', 'control'].includes(value))) throw Error('Invalid accessibility modifier keys');
    const using = modifiers.map(value => `${value} down`);
    let operation = null;
    if (action.kind === 'keystroke') operation = `se.keystroke(${jxaLiteral(action.text)});`;
    else if (action.kind === 'key_chord') operation = `se.keystroke(${jxaLiteral(action.key)},{using:${jxaLiteral(using)}});`;
    else if (action.kind === 'key_code' && Number.isSafeInteger(action.key_code)) operation = `se.keyCode(${action.key_code},{using:${jxaLiteral(using)}});`;
    else if (action.kind === 'press') operation = `target.actions.byName('AXPress').perform();`;
    else if (action.kind === 'open_dialog_select') {
      if (!isAbsolute(action.fixture_directory ?? '') || byteLength(action.fixture_directory) > 4096 || action.fixture_directory.includes('\0')) throw Error('Open dialog fixture directory must be an absolute bounded path');
      if (!Array.isArray(action.fixture_names) || action.fixture_names.length !== 8 || new Set(action.fixture_names).size !== 8) throw Error('Open dialog requires eight unique fixtures');
      action.fixture_names.forEach(name => {
        boundedString(name, 'Open dialog fixture basename');
        if (name.includes('/') || name.includes('\\')) throw Error('Open dialog fixture names must be basenames');
      });
      operation = `target.actions.byName('AXPress').perform();const modalDeadline=Date.now()+5000;let modal=[];while(Date.now()<modalDeadline){const ws=app.windows();modal=ws.filter(w=>{try{return w.attributes.byName('AXModal').value()===true}catch{return false}});if(modal.length===1)break;delay(0.01)}if(modal.length!==1)throw new Error('open dialog missing');se.keystroke('g',{using:['command down','shift down']});delay(0.05);se.keystroke(${jxaLiteral(action.fixture_directory)});se.keyCode(36);delay(0.1);const fixtureNames=${jxaLiteral(action.fixture_names)};const dialogItems=app.entireContents();for(const fixtureName of fixtureNames){const rows=dialogItems.filter(x=>{try{return x.name()===fixtureName&&(x.role()==='AXRow'||x.role()==='AXStaticText')}catch{return false}});if(rows.length!==1)throw new Error('fixture identity');rows[0].attributes.byName('AXSelected').value=true}const openButtons=app.entireContents().filter(x=>{try{return x.role()==='AXButton'&&x.name()==='Open'}catch{return false}});if(openButtons.length!==1)throw new Error('open action identity');openButtons[0].actions.byName('AXPress').perform();`;
    }
    if (operation === null) throw Error('Unsupported accessibility action kind');
    const completionRole = normalizeAxRole(completion.role ?? action.role);
    const completionLabel = completion.label ?? action.label;
    const normalizedExpected = normalizeAxValue(completion.attribute, completion.value);
    const completionLoop = completion.kind === 'attribute_equals'
      ? `const current=allNow.filter(x=>{try{return x.role()===${jxaLiteral(completionRole)}&&x.name()===${jxaLiteral(completionLabel)}}catch{return false}});if(current.length===1){try{value=current[0].attributes.byName(${jxaLiteral(completion.attribute)}).value()}catch{}const normalized=(${jxaLiteral(completion.attribute)}==='AXSelected'||${jxaLiteral(completion.attribute)}==='AXEnabled')?(value===true||value===1||value==='1'||value==='true'):(${jxaLiteral(completion.attribute)}==='AXValue'?(value==null?'':String(value)):value);if(JSON.stringify(normalized)===${jxaLiteral(JSON.stringify(normalizedExpected))}){done=true;break}}`
      : `const current=allNow.filter(x=>{try{return x.role()===${jxaLiteral(completionRole)}&&x.name()===${jxaLiteral(completionLabel)}}catch{return false}});value=current.length;if(current.length===0){done=true;break}`;
    const dispatchScript = `ObjC.import('QuartzCore');const se=Application('System Events');${jxaPidProcess(expectedPid)}if(!app)throw new Error('process missing');const front=se.processes.whose({frontmost:true})();const windows=app.windows();${targetLookup}const modalBefore=windows.filter(w=>{try{return w.attributes.byName('AXModal').value()===true}catch{return false}}).length;if(front.length!==1||front[0].unixId()!==${expectedPid}||modalBefore!==${expectedModalBefore}||matches.length!==1)throw new Error('interrupted');const targetRole=target.role();const targetLabel=target.name();const dispatchStart=$.CACurrentMediaTime();${operation}const deadline=Date.now()+${action.timeout_ms};let value=null;let done=false;while(Date.now()<deadline){const allNow=app.entireContents();${completionLoop}delay(0.01)}const observedAt=$.CACurrentMediaTime();const frontAfter=se.processes.whose({frontmost:true})();const windowsAfter=app.windows();const modalAfter=windowsAfter.filter(w=>{try{return w.attributes.byName('AXModal').value()===true}catch{return false}}).length;const f=app.attributes.byName('AXFocusedUIElement').value();JSON.stringify({trusted:true,frontmost_pid:frontAfter.length?frontAfter[0].unixId():null,modal_count:modalAfter,target_count:matches.length,target_role:targetRole,target_label:targetLabel,focused_role:f?f.role():null,focused_label:f?f.name():null,value,done,driver_duration_us:Math.round((observedAt-dispatchStart)*1000000)});`;
    const after = parseDriverReply(await runScript(dispatchScript, action.timeout_ms + 1000));
    if (after.frontmost_pid !== expectedPid || after.modal_count !== expectedModalAfter || after.target_count !== 1 || after.target_role !== axRole || after.target_label !== action.label) throw Error('Accessibility interruption invalidated the action');
    if (['keystroke', 'key_chord', 'key_code'].includes(action.kind) && (after.focused_role !== axRole || after.focused_label !== action.label)) throw Error('Accessibility focus changed during the action');
    if (!Number.isSafeInteger(after.driver_duration_us) || after.driver_duration_us < 0) throw Error('Accessibility driver duration is invalid');
    const observed = normalizeAxValue(completion.attribute, after.value);
    if (after.done === false || (completion.kind === 'attribute_equals' && JSON.stringify(observed) !== JSON.stringify(normalizedExpected)) || (completion.kind === 'element_absent' && after.value !== 0)) throw Error('Accessibility completion predicate timed out');
    return { ordinal: action.ordinal, driver_duration_us: after.driver_duration_us, observed_value: observed, clock_domain: 'driver_monotonic' };
  };
  const readValue = async ({ role, label, expectedModalCount = 0 }) => {
    boundedString(role, 'AX read role'); boundedString(label, 'AX read label'); safeInteger(expectedModalCount, 'expected modal count');
    const axRole = normalizeAxRole(role);
    const script = `const se=Application('System Events');${jxaPidProcess(expectedPid)}const front=se.processes.whose({frontmost:true})();const windows=app?app.windows():[];const all=app?app.entireContents():[];const matches=all.filter(x=>{try{return x.role()===${jxaLiteral(axRole)}&&x.name()===${jxaLiteral(label)}}catch{return false}});let value=null;if(matches.length===1){try{value=matches[0].attributes.byName('AXValue').value()}catch{}}JSON.stringify({frontmost_pid:front.length?front[0].unixId():null,modal_count:windows.filter(w=>{try{return w.attributes.byName('AXModal').value()===true}catch{return false}}).length,target_count:matches.length,target_role:matches.length===1?matches[0].role():null,target_label:matches.length===1?matches[0].name():null,value});`;
    const result = parseDriverReply(await runScript(script, 5000));
    if (result.frontmost_pid !== expectedPid || result.modal_count !== expectedModalCount || result.target_count !== 1 || result.target_role !== axRole || result.target_label !== label) throw Error('Accessibility interruption invalidated the value read');
    return String(normalizeAxValue('AXValue', result.value));
  };
  const quit = async () => {
    const script = `const se=Application('System Events');const front=se.processes.whose({frontmost:true})();if(front.length!==1||front[0].unixId()!==${expectedPid})throw new Error('focus lost');se.keystroke('q',{using:['command down']});JSON.stringify({frontmost_pid:${expectedPid},quit_requested:true});`;
    const value = parseDriverReply(await runScript(script, 5000));
    if (value.frontmost_pid !== expectedPid || value.quit_requested !== true) throw Error('Normal Command-Q request failed');
    return value;
  };
  return Object.freeze({ preflight, perform, readValue, quit });
}

const throwIfAborted = abortSignal => { if (abortSignal?.aborted) throw Error('Responsiveness operation aborted'); };

async function waitForJson(path, expected, { timeoutMs, pollMs, label, validate = null, abortSignal = null }) {
  if (!isAbsolute(path)) throw Error(`${label} path must be absolute`);
  const deadline = performance.now() + timeoutMs;
  let mismatch = false;
  while (performance.now() < deadline) {
    throwIfAborted(abortSignal);
    if (existsSync(path)) {
      try {
        const value = readRegularJson(path, 64 * 1024, label);
        if (validate) validate(value);
        mismatch = Object.entries(expected).some(([key, expectedValue]) => value[key] !== expectedValue);
        if (!mismatch) return value;
      } catch (error) {
        if (!/JSON|byte limit/.test(error.message)) throw error;
      }
    }
    await sleep(pollMs);
  }
  throwIfAborted(abortSignal);
  if (mismatch) throw Error(`${label} identity mismatch`);
  throw Error(`${label} timed out`);
}

function validateReadinessMarker(value, kind) {
  exactKeys(value, ['schema_version', 'component_kind', 'session_id', 'sample_id', 'page_instance_id', 'action_id', 'pid', 'native_clock'], 'readiness marker');
  if (value.schema_version !== 2 || value.component_kind !== kind || !UUID.test(value.session_id) || !UUID.test(value.page_instance_id) || typeof value.sample_id !== 'string' || !Number.isSafeInteger(value.pid) || value.pid < 1) throw Error('Invalid readiness marker identity');
  if (kind === 'recorder_ready' ? value.action_id !== null && (!Number.isSafeInteger(value.action_id) || value.action_id < 1) : !Number.isSafeInteger(value.action_id) || value.action_id < 1) throw Error('Invalid readiness marker action ID');
  exactKeys(value.native_clock, ['domain', 'unit', 'elapsed_us'], 'readiness native clock');
  if (value.native_clock.domain !== 'native_monotonic' || value.native_clock.unit !== 'us' || !Number.isSafeInteger(value.native_clock.elapsed_us) || value.native_clock.elapsed_us < 0) throw Error('Invalid readiness native clock');
}

export function waitForRecorderReady(path, identity, { timeoutMs = 30_000, pollMs = 10, abortSignal = null } = {}) {
  return waitForJson(path, identity, { timeoutMs, pollMs, abortSignal, label: 'Recorder readiness marker', validate: value => validateReadinessMarker(value, 'recorder_ready') });
}

export function waitForActionReady(reportDirectory, { session_id, sample_id, page_instance_id, action_id, pid }, options = {}) {
  const path = join(reportDirectory, `action-ready-${action_id}-${page_instance_id}.json`);
  return waitForJson(path, { schema_version: 2, component_kind: 'action_ready', session_id, sample_id, page_instance_id, action_id, pid }, { timeoutMs: options.timeoutMs ?? 2_000, pollMs: options.pollMs ?? 10, abortSignal: options.abortSignal ?? null, label: 'Action readiness marker', validate: value => validateReadinessMarker(value, 'action_ready') });
}

export function waitForStartupReady(path, pid, { timeoutMs = 30_000, pollMs = 10, abortSignal = null } = {}) {
  return waitForJson(path, { schema_version: 1, pid }, { timeoutMs, pollMs, abortSignal, label: 'Startup readiness marker' });
}

export async function waitForRecorderOrFailedPage({ recorderPath, reportDirectory, identity, descriptor, timeoutMs = 30_000, pollMs = 10, abortSignal = null }) {
  if (!isAbsolute(recorderPath) || !isAbsolute(reportDirectory)) throw Error('Page startup paths must be absolute');
  const componentPath = join(reportDirectory, `frontend-${descriptor.componentRole}-${descriptor.pageInstanceId}.json`);
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    throwIfAborted(abortSignal);
    if (existsSync(recorderPath)) {
      const marker = readRegularJson(recorderPath, 64 * 1024, 'Recorder readiness marker');
      validateReadinessMarker(marker, 'recorder_ready');
      const expected = { schema_version: 2, component_kind: 'recorder_ready', ...identity };
      if (Object.entries(expected).some(([key, value]) => marker[key] !== value)) throw Error('Recorder readiness marker identity mismatch');
      return { kind: 'recorder_ready', marker };
    }
    if (existsSync(componentPath)) {
      const page = loadPageComponent(componentPath);
      if (page.session_id !== descriptor.sessionId || page.sample_id !== descriptor.sampleId || page.page_instance_id !== descriptor.pageInstanceId || page.component_role !== descriptor.componentRole || page.pid !== identity.pid) throw Error('Pre-ready page component identity mismatch');
      const trace = page.frontend_trace;
      const zeroProgress = trace.actions.length === 0 && trace.setups.length === 0 && trace.events.length === 0 && trace.spans.length === 0 && trace.dropped_events === 0 && trace.late_events === 0 && trace.observer_entries_aggregated === 0;
      if (trace.failure === null || trace.settled || !zeroProgress) throw Error('Pre-ready page component is not a zero-progress failed prefix');
      return { kind: 'failed_component', page_component: page };
    }
    await sleep(pollMs);
  }
  throwIfAborted(abortSignal);
  throw Error('Page startup timed out before recorder readiness or a failed component');
}

export async function waitForAxPreflight(driver, labels, { timeoutMs = 5000, pollMs = 25, abortSignal = null } = {}) {
  const deadline = performance.now() + timeoutMs;
  let lastError = null;
  while (performance.now() < deadline) {
    throwIfAborted(abortSignal);
    try { return await driver.preflight(labels); }
    catch (error) {
      if (!/accessibility label is missing/i.test(error.message)) throw error;
      lastError = error; await sleep(pollMs);
    }
  }
  throwIfAborted(abortSignal);
  throw lastError ?? Error('Accessibility targets did not mount before timeout');
}

export async function runAccessibilitySequence({
  driver,
  actions,
  reportDirectory,
  identity,
  waitRecorder = waitForRecorderReady,
  waitAction = waitForActionReady,
  afterRecorderReady = async () => {},
  beforeFirstAction = async () => {},
  readinessTimeoutMs = 30_000,
  nowMs = () => performance.now(),
  abortSignal = null,
}) {
  if (!driver || typeof driver.perform !== 'function' || !Array.isArray(actions) || actions.length > 2048) throw Error('Invalid accessibility sequence');
  const first = actions[0] ?? null;
  if (first !== null && first.actionId !== 1) throw Error('Accessibility action IDs must begin at one');
  const recorderPath = join(reportDirectory, `recorder-ready-${identity.page_instance_id}.json`);
  await waitRecorder(recorderPath, { schema_version: 2, component_kind: 'recorder_ready', ...identity, action_id: first?.actionId ?? null }, { timeoutMs: readinessTimeoutMs, pollMs: 10, abortSignal });
  await afterRecorderReady();
  const observations = [];
  const laneThree = actions.length === SESSION_CYCLES * SESSION_ACTIONS_PER_CYCLE;
  let cycleDeadline = null, previousNow = nowMs();
  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index];
    if (action.actionId !== index + 1) throw Error('Accessibility action IDs must be contiguous');
    if (index === 0) await beforeFirstAction();
    const before = nowMs();
    if (before < previousNow) throw Error('Accessibility driver clock moved backwards');
    previousNow = before;
    if (laneThree && index % SESSION_ACTIONS_PER_CYCLE === 0) cycleDeadline = before + 40_000;
    if (cycleDeadline !== null && before > cycleDeadline) throw Error(`Lane 3 cycle ${Math.floor(index / SESSION_ACTIONS_PER_CYCLE) + 1} exceeded 40 seconds`);
    throwIfAborted(abortSignal);
    if (index > 0) await waitAction(reportDirectory, { ...identity, action_id: action.actionId }, { timeoutMs: action.dispatch.timeout_ms, pollMs: 10, abortSignal });
    observations.push(await driver.perform({
      ordinal: action.actionId,
      role: action.targetRole,
      label: action.accessibleName,
      expected_prior_value: action.expectedPriorValue,
      ...action.dispatch,
    }));
    const after = nowMs();
    if (after < previousNow) throw Error('Accessibility driver clock moved backwards');
    previousNow = after;
    if (cycleDeadline !== null && after > cycleDeadline) throw Error(`Lane 3 cycle ${Math.floor(index / SESSION_ACTIONS_PER_CYCLE) + 1} exceeded 40 seconds`);
  }
  return observations;
}

function validatePageComponent(page) {
  if (!plainObject(page) || page.schema_version !== 2 || page.component_kind !== 'frontend_page_component') throw Error('Invalid frontend page component schema');
  exactKeys(page, ['schema_version', 'component_kind', 'session_id', 'sample_id', 'page_instance_id', 'component_role', 'pid', 'native_clock', 'frontend_trace'], 'frontend page component');
  if (!UUID.test(page.session_id) || !UUID.test(page.page_instance_id) || !ROLES.has(page.component_role) || !Number.isSafeInteger(page.pid) || page.pid < 1) throw Error('Invalid frontend page component identity');
  boundedString(page.sample_id, 'page component sample ID');
  exactKeys(page.native_clock, ['domain', 'unit', 'elapsed_us'], 'native page clock');
  if (page.native_clock.domain !== 'native_monotonic' || page.native_clock.unit !== 'us' || !Number.isSafeInteger(page.native_clock.elapsed_us) || page.native_clock.elapsed_us < 0) throw Error('Invalid native page clock');
  const trace = validateFrontendComponent(page.frontend_trace);
  if (page.session_id !== trace.session_id || page.sample_id !== trace.sample_id || page.page_instance_id !== trace.page_instance_id || page.component_role !== trace.component_role) throw Error('Frontend page envelope identity mismatch');
  return page;
}

export function loadPageComponent(path) {
  return validatePageComponent(readRegularJson(path, MAX_COMPONENT_BYTES + 4096, 'Frontend page component'));
}

export function loadFrontendComponent(path) {
  return loadPageComponent(path).frontend_trace;
}

export function discoverComponentFiles(reportDirectory) {
  if (!isAbsolute(reportDirectory) || lstatSync(reportDirectory).isSymbolicLink()) throw Error('Report directory must be absolute and must not be a symbolic link');
  return readdirSync(reportDirectory).filter(name => /^frontend-(primary|pre_quit|recovery)-[0-9a-f-]{36}\.json$/.test(name)).sort().map(name => join(reportDirectory, name));
}

export function createIsolatedAppData(directory, sessionId) {
  if (!isAbsolute(directory) || !UUID.test(sessionId)) throw Error('Isolated profile requires an absolute path and session UUID');
  if (existsSync(directory)) throw Error('Isolated profile path must be new');
  const parent = resolve(directory, '..');
  if (realpathSync(parent) !== parent || lstatSync(parent).isSymbolicLink()) throw Error('Isolated profile parent must be canonical and not a symbolic link');
  mkdirSync(directory, { mode: 0o700 });
  mkdirSync(join(directory, 'config'), { mode: 0o700 });
  mkdirSync(join(directory, 'data'), { mode: 0o700 });
  writeFileSync(join(directory, '.goop-responsiveness-owned'), `${sessionId}\n`, { flag: 'wx', mode: 0o600 });
  return directory;
}

function validateDriverDispatch(dispatch, index) {
  if (!plainObject(dispatch) || !['press', 'open_dialog_select', 'keystroke', 'key_chord', 'key_code'].includes(dispatch.kind)) throw Error(`Invalid driver dispatch at ${index}`);
  const requiredByKind = {
    press: ['kind', 'completion', 'timeout_ms'],
    open_dialog_select: ['kind', 'fixture_directory', 'fixture_names', 'completion', 'timeout_ms'],
    keystroke: ['kind', 'text', 'completion', 'timeout_ms'],
    key_chord: ['kind', 'key', 'modifiers', 'completion', 'timeout_ms'],
    key_code: ['kind', 'key_code', 'completion', 'timeout_ms'],
  };
  const optionalByKind = {
    press: ['ax_prior', 'expected_modal_before', 'expected_modal_after'],
    open_dialog_select: ['ax_prior', 'expected_modal_before', 'expected_modal_after'],
    keystroke: ['ax_prior', 'expected_modal_before', 'expected_modal_after'],
    key_chord: ['ax_prior', 'expected_modal_before', 'expected_modal_after'],
    key_code: ['ax_prior', 'modifiers', 'expected_modal_before', 'expected_modal_after'],
  };
  exactRequiredAndOptionalKeys(dispatch, requiredByKind[dispatch.kind], optionalByKind[dispatch.kind], `driver dispatch ${index}`);
  safeInteger(dispatch.timeout_ms, `driver dispatch ${index} timeout`, 1);
  for (const field of ['expected_modal_before', 'expected_modal_after']) if (dispatch[field] !== undefined) safeInteger(dispatch[field], `driver dispatch ${index} ${field}`);
  const validateAxValue = (value, label) => {
    if (typeof value === 'string') boundedString(value, label, { maximum: 4096, allowEmpty: true });
    else if (typeof value === 'number') safeInteger(value, label);
    else if (typeof value !== 'boolean' && value !== null) throw Error(`Invalid ${label}`);
  };
  const validateAttribute = (value, label) => { if (!['AXValue', 'AXSelected', 'AXEnabled'].includes(value)) throw Error(`Invalid ${label}`); };
  if (dispatch.ax_prior !== undefined) {
    if (!plainObject(dispatch.ax_prior) || !['attribute_equals', 'element_present'].includes(dispatch.ax_prior.kind)) throw Error(`Invalid AX prior predicate at ${index}`);
    if (dispatch.ax_prior.kind === 'attribute_equals') {
      exactKeys(dispatch.ax_prior, ['kind', 'attribute', 'value'], `AX prior predicate ${index}`);
      validateAttribute(dispatch.ax_prior.attribute, `AX prior attribute at ${index}`); validateAxValue(dispatch.ax_prior.value, `AX prior value at ${index}`);
    }
    else exactKeys(dispatch.ax_prior, ['kind'], `AX prior predicate ${index}`);
  }
  const completion = dispatch.completion;
  if (!plainObject(completion) || !['attribute_equals', 'element_absent'].includes(completion.kind)) throw Error(`Invalid completion predicate at ${index}`);
  if (completion.kind === 'attribute_equals') {
    exactRequiredAndOptionalKeys(completion, ['kind', 'attribute', 'value'], ['role', 'label'], `completion predicate ${index}`);
    validateAttribute(completion.attribute, `completion attribute at ${index}`); validateAxValue(completion.value, `completion value at ${index}`);
  }
  else exactRequiredAndOptionalKeys(completion, ['kind'], ['role', 'label'], `completion predicate ${index}`);
  if (completion.role !== undefined) boundedString(completion.role, `completion role at ${index}`);
  if (completion.label !== undefined) boundedString(completion.label, `completion label at ${index}`);
  if (dispatch.kind === 'open_dialog_select') {
    if (!isAbsolute(dispatch.fixture_directory) || byteLength(dispatch.fixture_directory) > 4096 || dispatch.fixture_directory.includes('\0')) throw Error(`Invalid fixture directory at ${index}`);
    if (!Array.isArray(dispatch.fixture_names) || dispatch.fixture_names.length !== 8 || new Set(dispatch.fixture_names).size !== 8) throw Error(`Invalid fixture names at ${index}`);
    dispatch.fixture_names.forEach(value => { boundedString(value, `fixture name at ${index}`); if (value.includes('/') || value.includes('\\')) throw Error(`Invalid fixture basename at ${index}`); });
  }
  if (dispatch.kind === 'keystroke') boundedString(dispatch.text, `keystroke text at ${index}`, { allowEmpty: true });
  if (dispatch.kind === 'key_chord') boundedString(dispatch.key, `key chord at ${index}`);
  if (dispatch.kind === 'key_code') safeInteger(dispatch.key_code, `key code at ${index}`);
  if (dispatch.modifiers !== undefined && (!Array.isArray(dispatch.modifiers) || new Set(dispatch.modifiers).size !== dispatch.modifiers.length || dispatch.modifiers.some(value => !['command', 'shift', 'option', 'control'].includes(value)))) throw Error(`Invalid modifier keys at ${index}`);
}

function validatePagePlan(page, expectedIndex) {
  if (!plainObject(page) || !isAbsolute(page.manifest_path)) throw Error(`Page ${expectedIndex} requires an absolute manifest path`);
  exactRequiredAndOptionalKeys(page, ['manifest_path', 'required_labels', 'actions', 'timeout_ms'], ['argv', 'recovery_target'], `page ${expectedIndex}`);
  const manifest = validateScenarioManifest(readRegularJson(page.manifest_path, MAX_MANIFEST_BYTES, 'Scenario manifest'));
  if (!Array.isArray(page.required_labels) || page.required_labels.length > 128) throw Error('Invalid required AX labels');
  page.required_labels.forEach(label => boundedString(label, 'required AX label'));
  if (!Array.isArray(page.actions) || page.actions.length !== manifest.actions.length) throw Error('Driver/native action cardinality mismatch');
  page.actions.forEach((action, index) => {
    const expected = manifest.actions[index];
    for (const field of ['actionId', 'targetId', 'eventType', 'targetRole', 'accessibleName', 'expectedPriorValue']) if (action[field] !== expected[field]) throw Error(`Driver/native action identity mismatch at ${index + 1}`);
    exactKeys(action, ['actionId', 'targetId', 'eventType', 'targetRole', 'accessibleName', 'expectedPriorValue', 'dispatch'], `driver action ${index + 1}`);
    validateDriverDispatch(action.dispatch, index + 1);
  });
  if (manifest.descriptor.componentRole === 'recovery') {
    exactKeys(page.recovery_target, ['role', 'label'], 'recovery AX target');
    boundedString(page.recovery_target.role, 'recovery AX role');
    boundedString(page.recovery_target.label, 'recovery AX label');
  } else if (page.recovery_target !== undefined) throw Error('Recovery AX target is valid only for the recovery page');
  if (page.argv !== undefined && (!Array.isArray(page.argv) || page.argv.length > 32 || page.argv.some(value => typeof value !== 'string' || byteLength(value) > 1024))) throw Error('Invalid native page arguments');
  if (manifest.descriptor.lane === 'session_memory') validateSessionMemoryActions(page.actions, manifest.descriptor.workload.facts);
  safeInteger(page.timeout_ms, 'page timeout', 1);
  return { ...page, manifest };
}

async function waitForPageComponent(reportDirectory, descriptor, { timeoutMs = 30_000, pollMs = 10, abortSignal = null, expectedPid = null } = {}) {
  const path = join(reportDirectory, `frontend-${descriptor.componentRole}-${descriptor.pageInstanceId}.json`);
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    throwIfAborted(abortSignal);
    if (existsSync(path)) {
      const page = loadPageComponent(path);
      if (page.session_id !== descriptor.sessionId || page.sample_id !== descriptor.sampleId || page.page_instance_id !== descriptor.pageInstanceId || page.component_role !== descriptor.componentRole || expectedPid !== null && page.pid !== expectedPid) throw Error('Native page component identity mismatch');
      return page;
    }
    await sleep(pollMs);
  }
  throwIfAborted(abortSignal);
  throw Error('Native page component timed out');
}

const waitForClose = (closed, timeoutMs) => new Promise(resolveClose => {
  let resolved = false;
  const timer = setTimeout(() => { if (!resolved) { resolved = true; resolveClose(false); } }, timeoutMs);
  closed.then(() => {
    if (resolved) return;
    resolved = true; clearTimeout(timer); resolveClose(true);
  });
});

export async function runNativePage({ plan, page, manifest, platform = process.platform, abortSignal = null }) {
  if (platform !== 'darwin') throw Error('Native responsiveness pages are macOS-only');
  const componentDirectory = plan.component_directory ?? plan.report_directory;
  validateHarnessPaths({ binary: plan.binary, manifest: page.manifest_path, reportDirectory: componentDirectory, appDataDirectory: plan.app_data_directory });
  for (const name of ['config', 'data']) {
    const path = join(plan.app_data_directory, name);
    if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
    const stats = lstatSync(path);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw Error(`Isolated ${name} path must be a regular directory`);
  }
  const environment = {
    ...process.env,
    GOOP_CONFIG_DIR: join(plan.app_data_directory, 'config'),
    GOOP_DATA_DIR: join(plan.app_data_directory, 'data'),
    GOOP_RESPONSIVENESS_MANIFEST: page.manifest_path,
    GOOP_RESPONSIVENESS_REPORT_DIR: componentDirectory,
    GOOP_STARTUP_REPORT: join(componentDirectory, `startup-ready-${manifest.descriptor.pageInstanceId}.json`),
  };
  const child = spawn(plan.binary, page.argv ?? [], { env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  if (!child.pid) throw Error('Native application did not provide a PID');
  let exitCode = null, exitSignal = null, spawnError = null, timedOut = false, aborted = false, budgetExceeded = false, processSamplingError = false, logBytes = 0;
  let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0);
  const retain = (current, chunk) => {
    const remaining = Math.max(0, plan.limits.log_limit_bytes - logBytes);
    const kept = chunk.subarray(0, remaining); logBytes += kept.length;
    return Buffer.concat([current, kept]);
  };
  child.stdout.on('data', chunk => { stdout = retain(stdout, chunk); });
  child.stderr.on('data', chunk => { stderr = retain(stderr, chunk); });
  const closed = new Promise(resolveClose => {
    child.once('error', error => { spawnError = error.code ?? 'spawn_failed'; resolveClose(); });
    child.once('close', (code, signal) => { exitCode = code; exitSignal = signal; resolveClose(); });
  });
  const signal = name => {
    try {
      process.kill(process.platform === 'win32' ? child.pid : -child.pid, name);
      return true;
    } catch { return false; }
  };
  const abort = () => { aborted = true; signal('SIGTERM'); };
  abortSignal?.addEventListener('abort', abort, { once: true });
  if (abortSignal?.aborted) abort();
  const samplingPlatform = process.platform === 'win32' ? 'win32' : 'darwin';
  const series = createIdentityAwareProcessSeries({ rootPid: child.pid, platform: samplingPlatform });
  const started = performance.now();
  const sampler = createScheduledProcessSampler({ series, capture: () => captureProcessIdentitySnapshot(samplingPlatform) });
  let sampling = null, samplingStarted = false;
  const deadlineTimer = setTimeout(() => { timedOut = true; signal('SIGTERM'); }, page.timeout_ms);
  const budgetMonitor = setInterval(() => {
    try {
      if (directoryBytes(componentDirectory) + directoryBytes(plan.app_data_directory) + logBytes > plan.limits.storage_budget_bytes) { budgetExceeded = true; signal('SIGTERM'); }
    } catch { budgetExceeded = true; signal('SIGTERM'); }
  }, 100);
  let pageComponent = null, observations = [], recoveryEvidence = null, quitRequested = false, cleanupComplete = false, runError = null, driver = null, preReadyFailedComponent = null, preReadyFailure = false;
  try {
    driver = createAccessibilityDriver({ platform, appName: plan.app_name, expectedPid: child.pid });
    observations = await runAccessibilitySequence({
      driver,
      actions: page.actions,
      reportDirectory: componentDirectory,
      identity: { session_id: manifest.descriptor.sessionId, sample_id: manifest.descriptor.sampleId, page_instance_id: manifest.descriptor.pageInstanceId, pid: child.pid },
      readinessTimeoutMs: Math.min(30_000, page.timeout_ms),
      abortSignal,
      waitRecorder: async (recorderPath, expected, options) => {
        const startup = await waitForRecorderOrFailedPage({ recorderPath, reportDirectory: componentDirectory, identity: expected, descriptor: manifest.descriptor, ...options });
        if (startup.kind === 'failed_component') {
          preReadyFailedComponent = startup.page_component;
          throw Error('Frontend recorder failed before readiness');
        }
        return startup.marker;
      },
      afterRecorderReady: async () => {
        await waitForStartupReady(environment.GOOP_STARTUP_REPORT, child.pid, { timeoutMs: Math.min(30_000, page.timeout_ms), pollMs: 10, abortSignal });
        await waitForAxPreflight(driver, page.required_labels, { timeoutMs: Math.min(5000, page.timeout_ms), pollMs: 25, abortSignal });
        if (page.recovery_target) recoveryEvidence = { ax_value: await driver.readValue(page.recovery_target) };
      },
      beforeFirstAction: async () => {
        try { sampler.start(); samplingStarted = true; sampling = setInterval(() => { try { sampler.pump(); } catch { processSamplingError = true; signal('SIGTERM'); } }, 100); }
        catch { processSamplingError = true; signal('SIGTERM'); throw Error('Initial process sampling failed'); }
      },
    });
    const remaining = Math.max(1, page.timeout_ms - (performance.now() - started));
    pageComponent = await waitForPageComponent(componentDirectory, manifest.descriptor, { timeoutMs: remaining, pollMs: 10, abortSignal, expectedPid: child.pid });
    if (samplingStarted) sampler.finish(performance.now());
    await driver.quit();
    quitRequested = true;
    cleanupComplete = await waitForClose(closed, 5000);
  } catch (error) {
    runError = error;
    if (!aborted && preReadyFailedComponent !== null) {
      pageComponent = preReadyFailedComponent;
      try {
        sampler.start(); samplingStarted = true; sampler.finish(performance.now());
        preReadyFailure = true; signal('SIGTERM'); cleanupComplete = await waitForClose(closed, 5000); runError = null;
      } catch (samplingError) { runError = samplingError; }
    } else if (!aborted && driver) {
      try {
        const failedComponent = await waitForPageComponent(componentDirectory, manifest.descriptor, { timeoutMs: 250, pollMs: 10, expectedPid: child.pid });
        if (failedComponent.frontend_trace.failure !== null) {
          pageComponent = failedComponent;
          if (!samplingStarted && manifest.descriptor.lane === 'session_memory') { sampler.start(); samplingStarted = true; }
          if (samplingStarted) sampler.finish(performance.now());
          await driver.quit(); quitRequested = true; cleanupComplete = await waitForClose(closed, 5000); runError = null;
        }
      } catch { /* The original infrastructure error remains authoritative. */ }
    }
  } finally {
    if (sampling !== null) clearInterval(sampling); clearInterval(budgetMonitor); clearTimeout(deadlineTimer);
    abortSignal?.removeEventListener('abort', abort);
    if (!cleanupComplete) {
      signal('SIGTERM');
      cleanupComplete = await waitForClose(closed, 2000);
      if (!cleanupComplete) { signal('SIGKILL'); cleanupComplete = await waitForClose(closed, 2000); }
    }
  }
  const processSeries = samplingStarted ? series.finish() : null;
  const suffix = manifest.descriptor.pageInstanceId;
  writeFileSync(join(componentDirectory, `stdout-${suffix}.log`), stdout, { flag: 'wx', mode: 0o600 });
  writeFileSync(join(componentDirectory, `stderr-${suffix}.log`), stderr, { flag: 'wx', mode: 0o600 });
  if (runError) throw runError;
  if (spawnError !== null) throw Error(`Native application spawn failed: ${spawnError}`);
  if (timedOut) throw Error('Native page timed out');
  if (aborted) throw Error('Native page aborted');
  if (budgetExceeded) throw Error('Native page exceeded storage budget');
  if (processSamplingError) throw Error('Native process sampling exceeded its fixed bounds');
  if (preReadyFailure ? !cleanupComplete : !quitRequested || !cleanupComplete || exitCode !== 0 || exitSignal !== null) throw Error('Native page did not terminate and reap as required');
  if (directoryBytes(componentDirectory) + directoryBytes(plan.app_data_directory) > plan.limits.storage_budget_bytes) throw Error('Native page exceeded storage budget');
  return { page_component: pageComponent, driver_observations: observations, process_series: processSeries, recovery_evidence: recoveryEvidence, cleanup: { complete: true } };
}

export async function runDataStoreCleanup({ plan, manifest, componentDirectory, abortSignal = null, runProcess = runBoundedProcess }) {
  const environment = {
    ...process.env,
    GOOP_CONFIG_DIR: join(plan.app_data_directory, 'config'),
    GOOP_DATA_DIR: join(plan.app_data_directory, 'data'),
    GOOP_RESPONSIVENESS_MANIFEST: plan.pages.at(-1).manifest_path,
    GOOP_RESPONSIVENESS_REPORT_DIR: componentDirectory,
    GOOP_RESPONSIVENESS_CLEANUP: '1',
  };
  const result = await runProcess({
    command: plan.binary,
    args: [],
    env: environment,
    outputDirectory: componentDirectory,
    timeoutMs: Math.min(manifest.completion.timeoutMs, 30_000),
    killGraceMs: 2000,
    logLimitBytes: plan.limits.log_limit_bytes,
    storageBudgetBytes: plan.limits.storage_budget_bytes,
    abortSignal,
  });
  const receiptPath = join(componentDirectory, `data-store-cleanup-${manifest.descriptor.sessionId}.json`);
  const receipt = readRegularJson(receiptPath, 4096, 'Data-store cleanup receipt');
  validateCleanupReceipt(receipt, { sessionId: manifest.descriptor.sessionId, webviewDataStoreId: manifest.webviewDataStoreId });
  return { receipt, helper_success: result.success };
}

function validateRunPlan(plan) {
  if (!plainObject(plan) || plan.schema_version !== 2 || typeof plan.app_name !== 'string' || !Array.isArray(plan.pages) || plan.pages.length < 1 || plan.pages.length > 2) throw Error('Invalid native responsiveness plan');
  exactKeys(plan, ['schema_version', 'app_name', 'binary', 'report_directory', 'app_data_directory', 'pages', 'identity_inputs', 'common', 'payload', 'limits', 'cleanup_profile'], 'native responsiveness plan');
  boundedString(plan.app_name, 'native application name');
  for (const [value, label] of [[plan.binary, 'native binary'], [plan.report_directory, 'report directory'], [plan.app_data_directory, 'app-data directory']]) if (typeof value !== 'string' || !isAbsolute(value)) throw Error(`${label} must be absolute`);
  if (!plainObject(plan.identity_inputs)) throw Error('Missing responsiveness identity inputs');
  exactKeys(plan.identity_inputs, ['repository', 'bindings_path', 'runtime_sidecars', 'fixtures', 'configurations'], 'responsiveness identity inputs');
  if (typeof plan.identity_inputs.repository !== 'string' || !isAbsolute(plan.identity_inputs.repository)) throw Error('Identity repository must be absolute');
  const withinRepository = path => {
    const pathFromRepository = relative(plan.identity_inputs.repository, path);
    return pathFromRepository === '' || pathFromRepository !== '..' && !pathFromRepository.startsWith(`..${sep}`) && !isAbsolute(pathFromRepository);
  };
  if (withinRepository(plan.report_directory) || withinRepository(plan.app_data_directory)) throw Error('Owned report and app-data directories must be outside the identity repository');
  if (!plainObject(plan.common) || !plainObject(plan.payload) || typeof plan.cleanup_profile !== 'boolean') throw Error('Invalid native responsiveness plan components');
  if (!plainObject(plan.limits)) throw Error('Missing native responsiveness limits');
  exactKeys(plan.limits, ['log_limit_bytes', 'storage_budget_bytes'], 'native responsiveness limits');
  safeInteger(plan.limits.log_limit_bytes, 'log byte limit', 1);
  safeInteger(plan.limits.storage_budget_bytes, 'storage byte limit', 1);
  const pages = plan.pages.map(validatePagePlan);
  const first = pages[0].manifest.descriptor;
  if (pages.some(page => {
    const value = page.manifest.descriptor;
    return value.sessionId !== first.sessionId || value.sampleId !== first.sampleId || value.lane !== first.lane || canonicalizeJcs(value.scenario) !== canonicalizeJcs(first.scenario) || canonicalizeJcs(value.workload) !== canonicalizeJcs(first.workload) || value.phase !== first.phase || value.repetition !== first.repetition;
  })) throw Error('Native page manifest identity mismatch');
  if (pages.some(page => canonicalizeJcs(page.manifest.webviewDataStoreId) !== canonicalizeJcs(pages[0].manifest.webviewDataStoreId))) throw Error('Native pages must reuse one WebView data-store ID');
  const roles = pages.map(page => page.manifest.descriptor.componentRole);
  if (first.lane === 'draft' ? canonicalizeJcs(roles) !== canonicalizeJcs(['pre_quit', 'recovery']) : canonicalizeJcs(roles) !== canonicalizeJcs(['primary'])) throw Error('Native page role/cardinality mismatch');
  return { ...plan, pages };
}

function extractDraftRecoveryEvidence(plan, pageResults) {
  const recoveryIndex = plan.pages.findIndex(page => page.manifest.descriptor.componentRole === 'recovery');
  if (recoveryIndex < 0) throw Error('Draft recovery page is missing');
  const completion = plan.pages[recoveryIndex].manifest.completion;
  if (!SHA256.test(completion.expectedDraftSha256 ?? '') || typeof completion.expectedAxValue !== 'string') throw Error('Draft recovery expectations are incomplete');
  const trace = pageResults[recoveryIndex].page_component.frontend_trace;
  const evidence = subject => trace.events.filter(event => event.kind === 'persistence_settled' && event.subject_id === subject);
  const draftEvents = evidence('draft_sha256');
  const valueEvents = evidence('recovered_value_sha256');
  if (draftEvents.length !== 1 || valueEvents.length !== 1 || !SHA256.test(draftEvents[0].correlation_id ?? '') || !SHA256.test(valueEvents[0].correlation_id ?? '')) throw Error('Draft recovery trace evidence is missing or ambiguous');
  if (draftEvents[0].span_id === null || draftEvents[0].span_id !== valueEvents[0].span_id || canonicalizeJcs(draftEvents[0].owner) !== canonicalizeJcs(valueEvents[0].owner)) throw Error('Draft recovery evidence is not bound to one recovery span');
  const span = trace.spans.find(value => value.span_id === draftEvents[0].span_id);
  if (!span || span.kind !== 'recovery_verification' || canonicalizeJcs(span.owner) !== canonicalizeJcs(draftEvents[0].owner)) throw Error('Draft recovery verification span is invalid');
  const recoveredAxValue = pageResults[recoveryIndex].recovery_evidence?.ax_value;
  if (typeof recoveredAxValue !== 'string') throw Error('Recovered AX value evidence is missing');
  const axHashMatches = createHash('sha256').update(recoveredAxValue).digest('hex') === valueEvents[0].correlation_id;
  return {
    expected_draft_sha256: completion.expectedDraftSha256,
    recovered_draft_sha256: draftEvents[0].correlation_id,
    expected_ax_value: completion.expectedAxValue,
    recovered_ax_value: recoveredAxValue,
    matches: span.terminal === 'ended' && draftEvents[0].correlation_id === completion.expectedDraftSha256 && recoveredAxValue === completion.expectedAxValue && axHashMatches,
  };
}

export async function runNativeResponsivenessPlan(planValue, { platform = process.platform, runPage = runNativePage, runCleanup = runDataStoreCleanup, abortSignal = null } = {}) {
  if (platform !== 'darwin') throw Error('Native responsiveness plan supports macOS only');
  const plan = validateRunPlan(planValue);
  const firstManifest = plan.pages[0].manifest;
  validateHarnessPaths({ binary: plan.binary, manifest: plan.pages[0].manifest_path, reportDirectory: plan.report_directory, appDataDirectory: plan.app_data_directory });
  const incompleteDirectory = join(plan.report_directory, '.incomplete');
  if (existsSync(incompleteDirectory)) throw Error('Incomplete component directory must be new');
  mkdirSync(incompleteDirectory, { mode: 0o700 });
  plan.component_directory = incompleteDirectory;
  const identityBefore = captureResponsivenessIdentity(plan);
  const pageResults = [];
  let pageInfrastructureError = null;
  try {
    for (const page of plan.pages) pageResults.push(await runPage({ plan, page, manifest: page.manifest, platform, abortSignal }));
    pageResults.forEach((result, index) => {
      if (!plainObject(result) || !plainObject(result.cleanup) || typeof result.cleanup.complete !== 'boolean') throw Error('Invalid native page result');
      const nativePage = validatePageComponent(result.page_component);
      const trace = nativePage.frontend_trace;
      const descriptor = plan.pages[index].manifest.descriptor;
      const matches = trace.component_role === descriptor.componentRole
        && trace.session_id === descriptor.sessionId
        && trace.sample_id === descriptor.sampleId
        && trace.page_instance_id === descriptor.pageInstanceId
        && trace.lane === descriptor.lane
        && canonicalizeJcs(trace.scenario) === canonicalizeJcs({ id: descriptor.scenario.id, manifest_sha256: descriptor.scenario.manifestSha256 })
        && canonicalizeJcs(trace.workload) === canonicalizeJcs(descriptor.workload)
        && trace.phase === descriptor.phase
        && trace.repetition === descriptor.repetition;
      if (!matches) throw Error('Native page trace does not match its activation descriptor');
      const completeTrace = trace.failure === null && trace.settled;
      if ((completeTrace ? trace.actions.length !== plan.pages[index].manifest.actions.length : trace.actions.length > plan.pages[index].manifest.actions.length) || trace.actions.some((action, actionIndex) => action.action_id !== plan.pages[index].manifest.actions[actionIndex].actionId || action.target_id !== plan.pages[index].manifest.actions[actionIndex].targetId)) throw Error('Frontend trace action plan mismatch');
      validateDriverObservations(result.driver_observations, plan.pages[index].actions, !completeTrace);
      if (descriptor.lane === 'session_memory') validateProcessSeries(result.process_series);
      else if (result.process_series !== null) validateProcessSeries(result.process_series);
    });
  } catch (error) { pageInfrastructureError = error; }
  let cleanupRaw = null, cleanupInfrastructureError = null;
  try { cleanupRaw = await runCleanup({ plan, manifest: plan.pages.at(-1).manifest, componentDirectory: incompleteDirectory, abortSignal: abortSignal?.aborted ? null : abortSignal }); }
  catch (error) { cleanupInfrastructureError = error; }
  if (pageInfrastructureError !== null) throw pageInfrastructureError;
  if (cleanupInfrastructureError !== null) throw cleanupInfrastructureError;
  const cleanupReceipt = cleanupRaw?.receipt ?? cleanupRaw;
  const cleanupHelperSuccess = cleanupRaw?.receipt ? cleanupRaw.helper_success === true : true;
  validateCleanupReceipt(cleanupReceipt, { sessionId: firstManifest.descriptor.sessionId, webviewDataStoreId: firstManifest.webviewDataStoreId });
  let common = { ...plan.common, identity: identityBefore };
  const traceInvalid = pageResults.some(result => {
    const trace = result.page_component.frontend_trace;
    return trace.failure !== null || !trace.settled || trace.dropped_events !== 0 || trace.late_events !== 0;
  });
  if (traceInvalid) common = { ...common, outcome: { kind: 'failed', code: 'frontend_trace_failed' } };
  if (plan.pages.some(page => page.manifest.bootstrap.failNextDraftWrite)) common = { ...common, outcome: { kind: 'failed', code: 'storage_failure_expected' } };
  if (pageResults.some(result => result.cleanup?.complete !== true)) common = { ...common, cleanup: { ...common.cleanup, complete: false, error_code: 'process_cleanup_failed' }, outcome: { kind: 'failed', code: 'cleanup_failed' } };
  const frontendComponents = pageResults.map(result => result.page_component.frontend_trace);
  common = { ...common, data_store_cleanup: cleanupReceipt };
  if (!cleanupHelperSuccess) common = { ...common, cleanup: { ...common.cleanup, complete: false, error_code: 'artifact_remove_failed' }, outcome: { kind: 'failed', code: 'cleanup_failed' } };
  const payload = {
    ...plan.payload,
    driver_observations: pageResults.flatMap(result => result.driver_observations),
    process_series: pageResults.map(result => result.process_series).filter(value => value !== null),
  };
  if (firstManifest.descriptor.lane === 'draft') {
    const recoveryIndex = plan.pages.findIndex(page => page.manifest.descriptor.componentRole === 'recovery');
    const recoveryTrace = pageResults[recoveryIndex]?.page_component.frontend_trace;
    if (recoveryTrace?.failure !== null || recoveryTrace.settled !== true) {
      const completion = plan.pages[recoveryIndex].manifest.completion;
      if (!SHA256.test(completion.expectedDraftSha256 ?? '') || typeof completion.expectedAxValue !== 'string') throw Error('Draft recovery expectations are incomplete');
      Object.assign(payload, { expected_draft_sha256: completion.expectedDraftSha256, recovered_draft_sha256: null, expected_ax_value: completion.expectedAxValue, recovered_ax_value: null });
    } else {
      const recovery = extractDraftRecoveryEvidence(plan, pageResults);
      const { matches, ...evidence } = recovery;
      Object.assign(payload, evidence);
      if (!matches && common.outcome?.code !== 'storage_failure_expected') common = { ...common, outcome: { kind: 'failed', code: 'recovery_mismatch' } };
    }
  }
  payload.process_summaries = payload.process_series.map(value => summarizeProcessSeries(value));
  if (firstManifest.descriptor.lane === 'session_memory' && common.outcome?.kind === 'success') {
    if (payload.process_summaries.some(value => !value.sampling_complete)) {
      common = { ...common, limitations: [...new Set([...(common.limitations ?? []), 'sampling_missed'])], outcome: { kind: 'inconclusive', code: 'sampling_incomplete' } };
    } else if (payload.process_summaries.some(value => value.attribution_conclusion === 'inconclusive')) {
      common = { ...common, outcome: { kind: 'inconclusive', code: 'process_attribution_incomplete' } };
    }
  }
  if (plan.cleanup_profile === true) {
    const marker = join(plan.app_data_directory, '.goop-responsiveness-owned');
    if (!existsSync(marker) || readFileSync(marker, 'utf8') !== `${firstManifest.descriptor.sessionId}\n`) throw Error('Refusing to remove an unowned app-data directory');
    rmSync(plan.app_data_directory, { recursive: true });
    common = { ...common, cleanup: { ...common.cleanup, removed_paths: (common.cleanup?.removed_paths ?? 0) + 1 } };
  }
  const identityAfter = captureResponsivenessIdentity(plan);
  if (canonicalizeJcs(identityAfter) !== canonicalizeJcs(identityBefore)) common = { ...common, outcome: { kind: 'failed', code: 'identity_mismatch' } };
  const sessionIdentity = { session_id: firstManifest.descriptor.sessionId, sample_id: firstManifest.descriptor.sampleId };
  writeComponentExclusive(incompleteDirectory, 'identity.json', { schema_version: 2, component_kind: 'identity', ...sessionIdentity, before: identityBefore, after: identityAfter });
  writeComponentExclusive(incompleteDirectory, 'driver.json', { schema_version: 2, component_kind: 'driver_observations', ...sessionIdentity, pages: pageResults.map((result, index) => ({ page_instance_id: plan.pages[index].manifest.descriptor.pageInstanceId, observations: result.driver_observations })) });
  writeComponentExclusive(incompleteDirectory, 'process-series.json', { schema_version: 2, component_kind: 'process_series', ...sessionIdentity, pages: pageResults.map((result, index) => ({ page_instance_id: plan.pages[index].manifest.descriptor.pageInstanceId, series: result.process_series })) });
  writeComponentExclusive(incompleteDirectory, 'recovery.json', { schema_version: 2, component_kind: 'recovery', ...sessionIdentity, evidence: firstManifest.descriptor.lane === 'draft' ? { expected_draft_sha256: payload.expected_draft_sha256, recovered_draft_sha256: payload.recovered_draft_sha256, expected_ax_value_sha256: createHash('sha256').update(payload.expected_ax_value).digest('hex'), recovered_ax_value_sha256: payload.recovered_ax_value === null ? null : createHash('sha256').update(payload.recovered_ax_value).digest('hex') } : null });
  if (directoryBytes(incompleteDirectory) > plan.limits.storage_budget_bytes) throw Error('Responsiveness components exceeded the storage budget');
  const sample = assembleSample({ lane: firstManifest.descriptor.lane, frontendComponents, nativePageComponents: pageResults.map(result => result.page_component), common, payload });
  const componentsDirectory = join(plan.report_directory, 'components');
  if (existsSync(componentsDirectory)) throw Error('Completed component directory already exists');
  renameSync(incompleteDirectory, componentsDirectory);
  syncDirectoryPortable(plan.report_directory, platform);
  let publication;
  try { publication = publishSampleExclusive(plan.report_directory, sample); }
  catch (error) {
    renameSync(componentsDirectory, incompleteDirectory);
    throw error;
  }
  return { sample, publication, page_results: pageResults };
}

function parseArguments(argv) {
  if (argv.length === 2 && argv[0] === '--plan') return { mode: 'run', plan: resolve(argv[1]) };
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!['--manifest', '--components', '--common', '--payload', '--output'].includes(argv[index]) || !argv[index + 1]) throw Error('Usage: --manifest FILE --components DIRECTORY --common FILE --payload FILE --output NEW_DIRECTORY');
    options[argv[index].slice(2)] = resolve(argv[index + 1]);
  }
  for (const name of ['manifest', 'components', 'common', 'payload', 'output']) if (!options[name]) throw Error(`Missing --${name}`);
  return { mode: 'assemble', ...options };
}

async function main(abortSignal = null) {
  if (process.platform !== 'darwin') throw Error('Responsiveness native harness supports macOS only');
  const options = parseArguments(process.argv.slice(2));
  if (options.mode === 'run') {
    const plan = readRegularJson(options.plan, MAX_SAMPLE_BYTES, 'Native responsiveness plan');
    await runNativeResponsivenessPlan(plan, { abortSignal });
    return;
  }
  if (existsSync(options.output)) throw Error('Output directory must be new');
  const manifest = validateScenarioManifest(readRegularJson(options.manifest, MAX_MANIFEST_BYTES, 'Scenario manifest'));
  const nativeComponents = discoverComponentFiles(options.components).map(loadPageComponent);
  const components = nativeComponents.map(page => page.frontend_trace);
  const common = readRegularJson(options.common, 1024 * 1024, 'Common sample component');
  const payload = readRegularJson(options.payload, 1024 * 1024, 'Lane payload component');
  const sample = assembleSample({ lane: manifest.descriptor.lane, frontendComponents: components, nativePageComponents: nativeComponents, common, payload });
  const parent = resolve(options.output, '..');
  if (realpathSync(parent) !== parent || lstatSync(parent).isSymbolicLink()) throw Error('Output parent must be canonical and must not be a symbolic link');
  // The assembly-only CLI deliberately publishes after native driving has left
  // complete components. Incomplete native attempts remain in their component
  // directory and never reach this boundary.
  mkdirSync(options.output, { mode: 0o700 });
  const receipt = publishSampleExclusive(options.output, sample);
  writeFileSync(join(options.output, 'sample.sha256'), `${receipt.sha256}\n`, { flag: 'wx', mode: 0o600 });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) withTerminationSignals(main).catch(error => { console.error(error.message); process.exitCode = 1; });
