import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createIdentityAwareProcessSeries,
  parseProcessIdentitySnapshot,
  processTreeRssFromIdentitySnapshot,
} from './performance-shared.mjs';
import {
  MAX_SAMPLE_BYTES,
  assembleSample,
  captureResponsivenessIdentity,
  canonicalizeJcs,
  classifyProcessAttribution,
  createAccessibilityDriver,
  createScheduledProcessSampler,
  loadPageComponent,
  publishSampleExclusive,
  runAccessibilitySequence,
  runNativePage,
  runNativeResponsivenessPlan,
  runDataStoreCleanup,
  summarizeProcessSeries,
  syncDirectoryPortable,
  validateSessionMemoryActions,
  validateHarnessPaths,
  validateFrontendComponents,
  validateScenarioManifest,
  validateProcessSeries,
  waitForRecorderReady,
  waitForActionReady,
  waitForAxPreflight,
  waitForRecorderOrFailedPage,
  waitForStartupReady,
} from './responsiveness-baseline.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const uuid = suffix => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
const digest = value => value.repeat(64);
const activationFields = (role = 'primary') => ({
  webviewDataStoreId: Array.from({ length: 16 }, (_, index) => index + 1),
  bootstrap: { initialPath: '/convert', draftStorage: null, failNextDraftWrite: false },
  completion: { kind: role === 'recovery' ? 'recovery' : 'actions_and_setups', timeoutMs: 40_000, expectedDraftSha256: null, expectedAxValue: null },
});
const evidenceIdentity = () => ({
  source: { head: 'a'.repeat(40), tree: 'b'.repeat(40), dirty_digest: digest('c'), dirty: false },
  binary: { sha256: digest('d'), bytes: 1 },
  runtime_sidecars: [{ id: 'runtime', sha256: digest('e'), bytes: 1 }],
  fixtures: [{ id: 'fixture', sha256: digest('f'), bytes: 1 }],
  configurations: [{ id: 'config', sha256: digest('a'), bytes: 1 }],
  manifests: [{ id: 'page-1', sha256: digest('b'), bytes: 1 }],
  bindings_sha256: digest('c'),
});
const identityInputs = (binary, manifestPaths) => ({
  repository: realpathSync(process.cwd()),
  bindings_path: manifestPaths[0],
  runtime_sidecars: { runtime: binary },
  fixtures: { fixture: binary },
  configurations: Object.fromEntries(manifestPaths.map((path, index) => [`config-${index + 1}`, path])),
});
const driverObservations = actions => actions.map(action => ({ ordinal: action.actionId, driver_duration_us: 1, observed_value: true, clock_domain: 'driver_monotonic' }));
const recordedActions = actions => actions.map((action, index) => ({ action_id: action.actionId, target_id: action.targetId, state: 'settled', armed_us: index * 3, active_us: index * 3 + 1, terminal_us: index * 3 + 2 }));
const inspectionPayload = () => ({
  fixture_ids: ['fixture-1'], queue_order: ['fixture-1'], start_order: ['fixture-1'], settle_order: ['fixture-1'], deliver_order: ['fixture-1'], cancel_order: [], maximum_concurrency: 1,
  first_ready_us: 1, last_nonretired_ready_us: 1, all_terminal_us: 1, selected_fixture_id: 'fixture-1', retired_fixture_id: null, external_selection_duration_us: 1, interaction_to_double_raf_us: 1,
});
const completeProcessSeries = () => ({
  identities: [{ process_index: 0, pid: 42, ppid: 1, process_start_time: 'time', canonical_executable: '/goop' }],
  snapshots: Array.from({ length: 30 }, (_, index) => ({ elapsed_us: index * 1_000_000, rss_by_process: [[0, 100 + index]] })),
  scheduled_reads: 30, missed_reads: 0, pid_reuse_count: 0, churn: { processes_started: 1, processes_exited: 0 }, attribution_complete: true, root_identity_drift: false,
});

const frontend = ({ role = 'primary', page = uuid('2'), lane = 'inspection' } = {}) => ({
  schema_version: 2,
  component_kind: 'frontend_trace',
  component_role: role,
  session_id: uuid('1'),
  sample_id: `${lane}:fixed:measured:0`,
  page_instance_id: page,
  lane,
  scenario: { id: 'fixed', manifest_sha256: digest('a') },
  workload: { id: 'fixed', facts: { source_count: 8 } },
  phase: 'measured',
  repetition: 0,
  clock_origin: { domain: 'webview_monotonic', unit: 'us' },
  setups: [], actions: [], events: [], spans: [],
  browser_timing: {
    event_timing: { supported: false, raw: [], aggregate: null, by_action: [] },
    long_tasks: { supported: false, raw: [], aggregate: null },
    raf_gaps: { count: 0, max_us: 0, buckets: { le_8_334_us: 0, le_16_667_us: 0, le_33_334_us: 0, le_50_000_us: 0, le_100_000_us: 0, le_250_000_us: 0, overflow: 0 } },
  },
  dropped_events: 0,
  late_events: 0,
  observer_entries_aggregated: 0,
  limitations: ['event_timing_unsupported', 'long_tasks_unsupported'],
  failure: null,
  settled: true,
});

const makeSessionActions = () => {
  const fixtures = Array.from({ length: 8 }, (_, index) => `fixture-${index + 1}.jpg`);
  const actions = [];
  let actionId = 1;
  for (let cycle = 0; cycle < 50; cycle += 1) {
    const add = (targetRole, accessibleName, dispatch, eventType = 'click', expectedPriorValue = 'false') => actions.push({
      actionId: actionId++, targetId: `cycle-${cycle + 1}-action-${actions.length % 35 + 1}`, eventType, targetRole, accessibleName, expectedPriorValue, dispatch,
    });
    const selectPress = { kind: 'press', ax_prior: { kind: 'attribute_equals', attribute: 'AXSelected', value: false }, completion: { kind: 'attribute_equals', attribute: 'AXSelected', value: true }, timeout_ms: 2000 };
    add('link', 'Convert', { kind: 'press', ax_prior: { kind: 'attribute_equals', attribute: 'AXSelected', value: true }, completion: { kind: 'attribute_equals', attribute: 'AXSelected', value: true }, timeout_ms: 2000 }, 'click', '/convert');
    add('button', 'Add files', { kind: 'open_dialog_select', ax_prior: { kind: 'attribute_equals', attribute: 'AXEnabled', value: true }, fixture_directory: '/tmp/goop-fixtures', fixture_names: fixtures, completion: { kind: 'attribute_equals', role: 'button', label: `Remove ${fixtures[7]}`, attribute: 'AXEnabled', value: true }, timeout_ms: 10_000 }, 'click', '0');
    add('button', `Select ${fixtures[0]}`, selectPress);
    const priorUrl = cycle === 0 ? '' : 'https://x.test/a.mp4';
    add('textbox', 'Paste URL to download', { kind: 'key_chord', ax_prior: { kind: 'attribute_equals', attribute: 'AXValue', value: priorUrl }, key: 'a', modifiers: ['command'], completion: { kind: 'attribute_equals', attribute: 'AXValue', value: priorUrl }, timeout_ms: 2000 }, 'keydown', priorUrl);
    add('textbox', 'Paste URL to download', { kind: 'key_code', ax_prior: { kind: 'attribute_equals', attribute: 'AXValue', value: priorUrl }, key_code: 51, completion: { kind: 'attribute_equals', attribute: 'AXValue', value: '' }, timeout_ms: 2000 }, 'keydown', priorUrl);
    let cumulative = '';
    for (const character of 'https://x.test/a.mp4') {
      const prior = cumulative; cumulative += character;
      add('textbox', 'Paste URL to download', { kind: 'keystroke', ax_prior: { kind: 'attribute_equals', attribute: 'AXValue', value: prior }, text: character, completion: { kind: 'attribute_equals', attribute: 'AXValue', value: cumulative }, timeout_ms: 2000 }, 'input', prior);
    }
    for (const fixture of fixtures) add('button', `Remove ${fixture}`, { kind: 'press', ax_prior: { kind: 'element_present' }, completion: { kind: 'element_absent', role: 'button', label: `Remove ${fixture}` }, timeout_ms: 2000 }, 'click', 'present');
    add('link', 'Extract', { kind: 'press', ax_prior: { kind: 'attribute_equals', attribute: 'AXSelected', value: false }, completion: { kind: 'attribute_equals', attribute: 'AXSelected', value: true }, timeout_ms: 2000 }, 'click', '/convert');
    add('link', 'Convert', { kind: 'press', ax_prior: { kind: 'attribute_equals', attribute: 'AXSelected', value: false }, completion: { kind: 'attribute_equals', attribute: 'AXSelected', value: true }, timeout_ms: 2000 }, 'click', '/extract');
  }
  return actions;
};

test('JCS fixture canonicalizes and hashes identically', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/responsiveness-jcs.json', import.meta.url), 'utf8'));
  for (const entry of fixture.cases) {
    const canonical = canonicalizeJcs(entry.input);
    assert.equal(canonical, entry.canonical, entry.id);
    assert.equal(hash(canonical), entry.sha256, entry.id);
  }
});

test('JCS rejects unsupported values and lone surrogates', () => {
  assert.throws(() => canonicalizeJcs({ value: Number.NaN }), /finite/i);
  assert.throws(() => canonicalizeJcs({ value: undefined }), /JSON value/i);
  assert.throws(() => canonicalizeJcs({ value: '\ud800' }), /surrogate/i);
});

test('macOS process snapshot parser records stable identity fields', () => {
  const rows = parseProcessIdentitySnapshot([
    '10\t1\t2026-09-20T10:00:00.000Z\t100\t/Applications/Goop.app/Contents/MacOS/goop',
    '11\t10\t2026-09-20T10:00:01.000Z\t200\t/System/Library/WebKit',
  ].join('\n'), 'darwin');
  assert.deepEqual(rows, [
    { pid: 10, ppid: 1, process_start_time: '2026-09-20T10:00:00.000Z', canonical_executable: '/Applications/Goop.app/Contents/MacOS/goop', rss_kib: 100 },
    { pid: 11, ppid: 10, process_start_time: '2026-09-20T10:00:01.000Z', canonical_executable: '/System/Library/WebKit', rss_kib: 200 },
  ]);
});

test('macOS process parser tolerates unrelated zero-RSS rows before descendant filtering', () => {
  const rows = parseProcessIdentitySnapshot('10\t1\t2026-09-20T10:00:00.000Z\t100\t/goop\n99\t1\t2026-09-20T10:00:00.000Z\t0\t/unrelated', 'darwin');
  assert.deepEqual(processTreeRssFromIdentitySnapshot(rows, 10), { rssKiB: 100, children: 0 });
  const series = createIdentityAwareProcessSeries({ rootPid: 10, platform: 'darwin' });
  assert.equal(series.observe(0, '10\t1\t2026-09-20T10:00:00.000Z\t100\t/goop\n99\t1\t2026-09-20T10:00:00.000Z\t0\t/unrelated'), true);
});

test('Windows process snapshot parser converts bytes to KiB without losing identity', () => {
  const rows = parseProcessIdentitySnapshot(JSON.stringify([
    { ProcessId: 40, ParentProcessId: 4, CreationDate: '2026-09-20T10:00:00.000Z', ExecutablePath: 'C:\\Goop\\goop.exe', WorkingSetSize: 2049 },
  ]), 'win32');
  assert.deepEqual(rows, [{ pid: 40, ppid: 4, process_start_time: '2026-09-20T10:00:00.000Z', canonical_executable: 'C:\\Goop\\goop.exe', rss_kib: 3 }]);
});

test('Windows sampling ignores incomplete unrelated rows but rejects incomplete selected descendants', () => {
  const validRoot = { ProcessId: 40, ParentProcessId: 4, CreationDate: '2026-09-20T10:00:00.000Z', ExecutablePath: 'C:\\Goop\\goop.exe', WorkingSetSize: 2048 };
  const unrelated = { ProcessId: 99, ParentProcessId: 4, CreationDate: null, ExecutablePath: null, WorkingSetSize: 0 };
  const accepted = createIdentityAwareProcessSeries({ rootPid: 40, platform: 'win32' });
  assert.equal(accepted.observe(0, JSON.stringify([validRoot, unrelated])), true);
  const rejected = createIdentityAwareProcessSeries({ rootPid: 40, platform: 'win32' });
  assert.equal(rejected.observe(0, JSON.stringify([validRoot, { ...unrelated, ProcessId: 41, ParentProcessId: 40 }])), false);
  assert.equal(rejected.finish().missed_reads, 1);
  const incompleteRoot = createIdentityAwareProcessSeries({ rootPid: 40, platform: 'win32' });
  assert.equal(incompleteRoot.observe(0, JSON.stringify([{ ...validRoot, ParentProcessId: null }])), false);
  assert.equal(incompleteRoot.finish().missed_reads, 1);
});

test('process parser rejects missing identity fields instead of inventing ownership', () => {
  assert.throws(() => parseProcessIdentitySnapshot('10\t1\t\t100\t/goop', 'darwin'), /start time/i);
  assert.throws(() => parseProcessIdentitySnapshot(JSON.stringify([{ ProcessId: 10, ParentProcessId: 1, CreationDate: null, ExecutablePath: 'C:\\goop.exe', WorkingSetSize: 1 }]), 'win32'), /start time/i);
});

test('identity-aware series preserves churn and treats PID reuse as a new process', () => {
  const series = createIdentityAwareProcessSeries({ rootPid: 10, platform: 'darwin' });
  series.observe(0, '10\t1\t2026-09-20T10:00:00.000Z\t100\t/goop\n11\t10\t2026-09-20T10:00:01.000Z\t20\t/helper');
  series.observe(1_000_000, '10\t1\t2026-09-20T10:00:00.000Z\t105\t/goop');
  series.observe(2_000_000, '10\t1\t2026-09-20T10:00:00.000Z\t110\t/goop\n11\t10\t2026-09-20T10:00:03.000Z\t30\t/helper');
  const value = series.finish();
  assert.equal(value.identities.length, 3);
  assert.deepEqual(value.snapshots.map(item => item.rss_by_process), [[[0, 100], [1, 20]], [[0, 105]], [[0, 110], [2, 30]]]);
  assert.equal(value.churn.processes_started, 3);
  assert.equal(value.churn.processes_exited, 1);
  assert.equal(value.pid_reuse_count, 1);
  assert.equal(value.missed_reads, 0);
});

test('identity-aware aggregate compatibility sums only current descendants', () => {
  const rows = parseProcessIdentitySnapshot('10\t1\t2026-09-20T10:00:00.000Z\t100\t/goop\n11\t10\t2026-09-20T10:00:01.000Z\t20\t/helper\n99\t1\t2026-09-20T10:00:00.000Z\t900\t/other', 'darwin');
  assert.deepEqual(processTreeRssFromIdentitySnapshot(rows, 10), { rssKiB: 120, children: 1 });
});

test('process-series bounds and ambiguous root identity fail closed', () => {
  const series = createIdentityAwareProcessSeries({ rootPid: 10, platform: 'darwin', maxSnapshots: 1 });
  series.observe(0, '10\t1\t2026-09-20T10:00:00.000Z\t100\t/goop');
  assert.throws(() => series.observe(1, '10\t1\t2026-09-20T10:00:00.000Z\t100\t/goop'), /snapshot cap/i);
  const missing = createIdentityAwareProcessSeries({ rootPid: 10, platform: 'darwin' });
  assert.equal(missing.observe(0, '99\t1\t2026-09-20T10:00:00.000Z\t100\t/other'), false);
  assert.equal(missing.finish().attribution_complete, false);
  const captureFailure = createIdentityAwareProcessSeries({ rootPid: 10, platform: 'darwin' });
  captureFailure.recordMiss(0);
  assert.equal(captureFailure.finish().scheduled_reads, 1);
  assert.equal(captureFailure.finish().missed_reads, 1);
  const zeroRoot = createIdentityAwareProcessSeries({ rootPid: 10, platform: 'darwin' });
  assert.equal(zeroRoot.observe(0, '10\t1\t2026-09-20T10:00:00.000Z\t0\t/goop'), false);
});

test('process-series summary computes OLS KiB per minute and enforces sampling completeness', () => {
  const series = createIdentityAwareProcessSeries({ rootPid: 10, platform: 'darwin' });
  for (let index = 0; index < 30; index += 1) series.observe(index * 1_000_000, `10\t1\t2026-09-20T10:00:00.000Z\t${100 + index}\t/goop`);
  const summary = summarizeProcessSeries(series.finish(), { relatedStable: false, relatedAmbiguous: true });
  assert.equal(summary.observation_count, 30);
  assert.equal(summary.start_rss_kib, 100);
  assert.equal(summary.end_rss_kib, 129);
  assert.equal(summary.peak_rss_kib, 129);
  assert.equal(summary.slope_kib_per_minute, 60);
  assert.equal(summary.sampling_complete, true);
  assert.equal(summary.attribution_conclusion, 'attributable_native_only');
  const tooShort = summarizeProcessSeries({ ...series.finish(), snapshots: series.finish().snapshots.slice(0, 29), scheduled_reads: 30, missed_reads: 1 }, {});
  assert.equal(tooShort.sampling_complete, false);
});

test('scheduled RSS sampler anchors at action one and turns delayed 1 Hz slots into misses', () => {
  let now = 0;
  const series = createIdentityAwareProcessSeries({ rootPid: 10, platform: 'darwin' });
  const sampler = createScheduledProcessSampler({ series, nowMs: () => now, capture: () => '10\t1\t2026-09-20T10:00:00.000Z\t100\t/goop' });
  sampler.start();
  now = 2500; sampler.pump();
  now = 2600; sampler.finish(2500);
  const result = series.finish();
  assert.equal(result.scheduled_reads, 4);
  assert.equal(result.missed_reads, 1);
  assert.deepEqual(result.snapshots.map(value => value.elapsed_us), [0, 2_000_000, 2_600_000]);
  assert.equal(result.attribution_complete, true);
  assert.throws(() => validateProcessSeries({ ...result, scheduled_reads: 99 }), /accounting/i);
});

test('attribution classification never claims ambiguous WebKit ownership', () => {
  assert.equal(classifyProcessAttribution({ rootStable: true, ownedDescendantsStable: true, relatedStable: false, relatedAmbiguous: true }), 'attributable_native_only');
  assert.equal(classifyProcessAttribution({ rootStable: true, ownedDescendantsStable: true, relatedStable: true, relatedAmbiguous: true }), 'partial_related_processes');
  assert.equal(classifyProcessAttribution({ rootStable: false, ownedDescendantsStable: true, relatedStable: false, relatedAmbiguous: false }), 'inconclusive');
});

test('frontend component validation enforces lane cardinality and shared identity', () => {
  assert.deepEqual(validateFrontendComponents([frontend()], 'inspection'), [frontend()]);
  const pre = frontend({ lane: 'draft', role: 'pre_quit', page: uuid('2') });
  const recovery = frontend({ lane: 'draft', role: 'recovery', page: uuid('3') });
  assert.deepEqual(validateFrontendComponents([pre, recovery], 'draft'), [pre, recovery]);
  assert.throws(() => validateFrontendComponents([pre], 'draft'), /cardinality/i);
  assert.throws(() => validateFrontendComponents([pre, { ...recovery, session_id: uuid('9') }], 'draft'), /identity/i);
  assert.throws(() => validateFrontendComponents([pre, { ...recovery, page_instance_id: pre.page_instance_id }], 'draft'), /page instance/i);
});

test('frontend trace validator rejects spoofed enums, ownership, timestamps, and failure records', () => {
  const action = { action_id: 1, target_id: 'target', state: 'settled', armed_us: 10, active_us: 20, terminal_us: 30 };
  const base = frontend(); base.actions = [action];
  assert.deepEqual(validateFrontendComponents([base], 'inspection'), [base]);
  assert.throws(() => validateFrontendComponents([{ ...base, actions: [{ ...action, state: 'invented' }] }], 'inspection'), /state/i);
  assert.throws(() => validateFrontendComponents([{ ...base, actions: [{ ...action, terminal_us: 19 }] }], 'inspection'), /timestamp/i);
  assert.throws(() => validateFrontendComponents([{ ...base, events: [{ event_seq: 1, owner: { kind: 'action', action_id: 2 }, span_id: null, kind: 'armed', at_us: 10, subject_id: null, correlation_id: null }] }], 'inspection'), /owner/i);
  assert.throws(() => validateFrontendComponents([{ ...base, failure: { code: 'invented', phase: 'action', count: 1 } }], 'inspection'), /failure/i);
  assert.throws(() => validateFrontendComponents([{ ...base, scenario: { ...base.scenario, spoofed: true } }], 'inspection'), /unknown/i);
  assert.throws(() => validateFrontendComponents([{ ...base, workload: { ...base.workload, spoofed: true } }], 'inspection'), /unknown/i);
  assert.throws(() => validateFrontendComponents([{ ...base, clock_origin: { ...base.clock_origin, spoofed: true } }], 'inspection'), /unknown/i);
});

test('frontend trace maximum action cardinality remains valid and bounded', () => {
  const maximum = frontend();
  maximum.actions = Array.from({ length: 2048 }, (_, index) => ({ action_id: index + 1, target_id: `a-${index + 1}`, state: 'settled', armed_us: index * 3, active_us: index * 3 + 1, terminal_us: index * 3 + 2 }));
  assert.equal(validateFrontendComponents([maximum], 'inspection')[0].actions.length, 2048);
  const sample = assembleSample({ lane: 'inspection', frontendComponents: [maximum], common: { identity: evidenceIdentity(), clock_origins: { driver_monotonic: { unit: 'us' }, native_monotonic: { unit: 'us' } }, limitations: [], cleanup: { complete: true, removed_paths: 0, error_code: null }, outcome: { kind: 'success' } }, payload: inspectionPayload() });
  assert.ok(Buffer.byteLength(canonicalizeJcs(sample)) < MAX_SAMPLE_BYTES);
  assert.throws(() => validateFrontendComponents([{ ...maximum, actions: [...maximum.actions, { ...maximum.actions[0], action_id: 2049 }] }], 'inspection'), /cap/i);
});

test('scenario manifests are strict, versioned, bounded, and paths are absolute/canonical', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'goop-responsiveness-manifest-')));
  try {
    const output = join(root, 'output'); mkdirSync(output);
    const appData = join(root, 'profile'); mkdirSync(appData);
    const binary = join(root, 'Goop');
    const nativeManifest = join(root, 'manifest.json');
    writeFileSync(binary, 'binary');
    const manifest = {
      schema_version: 2,
      token: 'token-1',
      ...activationFields(),
      descriptor: {
        componentRole: 'primary', sessionId: uuid('1'), sampleId: 'inspection:fixed:measured:0', pageInstanceId: uuid('2'), lane: 'inspection',
        scenario: { id: 'fixed', manifestSha256: digest('a') }, workload: { id: 'fixed', facts: { source_count: 1 } }, phase: 'measured', repetition: 0,
      },
      actions: [{ actionId: 1, targetId: 'select-fixture', eventType: 'click', targetRole: 'button', accessibleName: 'Select fixture.jpg', expectedPriorValue: 'false' }],
    };
    writeFileSync(nativeManifest, JSON.stringify(manifest));
    assert.equal(validateScenarioManifest(manifest).descriptor.sessionId, uuid('1'));
    assert.throws(() => validateScenarioManifest({ ...manifest, extra: true }), /unknown/i);
    assert.throws(() => validateScenarioManifest({ ...manifest, actions: [{ ...manifest.actions[0], actionId: 2 }] }), /ordinal/i);
    assert.throws(() => validateScenarioManifest({ ...manifest, completion: { ...manifest.completion, timeoutMs: 120_001 } }), /120,000/i);
    assert.deepEqual(validateHarnessPaths({ binary, manifest: nativeManifest, reportDirectory: output, appDataDirectory: appData }), { binary, manifest: nativeManifest, reportDirectory: output, appDataDirectory: appData });
    assert.throws(() => validateHarnessPaths({ binary: 'relative', manifest: nativeManifest, reportDirectory: output, appDataDirectory: appData }), /absolute/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('responsiveness identity binds source, binary, sidecars, fixtures, configuration, bindings, and manifests', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'goop-identity-')));
  try {
    const binary = join(root, 'Goop'); writeFileSync(binary, 'binary');
    const manifestPath = join(root, 'manifest.json'); writeFileSync(manifestPath, '{"version":1}');
    const plan = { binary, pages: [{ manifest_path: manifestPath }], identity_inputs: identityInputs(binary, [manifestPath]) };
    const before = captureResponsivenessIdentity(plan);
    assert.equal(before.binary.sha256, hash('binary'));
    assert.equal(before.runtime_sidecars.length, 1);
    assert.equal(before.fixtures.length, 1);
    assert.equal(before.configurations.length, 1);
    assert.equal(before.manifests.length, 1);
    writeFileSync(manifestPath, '{"version":2}');
    const after = captureResponsivenessIdentity(plan);
    assert.notEqual(canonicalizeJcs(after), canonicalizeJcs(before));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('2 MiB activation bound admits the fixed 1,750-action long-session plan', () => {
  const manifest = {
    schema_version: 2,
    token: 'session-token',
    ...activationFields(),
    descriptor: { componentRole: 'primary', sessionId: uuid('1'), sampleId: 'session_memory:fixed:measured:0', pageInstanceId: uuid('2'), lane: 'session_memory', scenario: { id: 'session-fixed', manifestSha256: digest('a') }, workload: { id: 'session-fixed', facts: { cycles: 50 } }, phase: 'measured', repetition: 0 },
    actions: Array.from({ length: 1750 }, (_, index) => ({ actionId: index + 1, targetId: `a-${index + 1}`, eventType: 'click', targetRole: 'button', accessibleName: `Action-${index + 1}`, expectedPriorValue: 'false' })),
  };
  assert.ok(Buffer.byteLength(JSON.stringify(manifest)) > 64 * 1024);
  assert.equal(validateScenarioManifest(manifest).actions.length, 1750);
});

test('AX driver preflights permission/frontmost process/labels and never uses coordinates', async () => {
  const scripts = [];
  const driver = createAccessibilityDriver({
    platform: 'darwin',
    appName: 'Goop',
    expectedPid: 42,
    runScript: async script => {
      scripts.push(script);
      return JSON.stringify({ trusted: true, frontmost_pid: 42, modal_count: 0, labels: ['Primary navigation', 'Add files', 'Select fixture.jpg', 'Remove fixture.jpg', 'Paste URL to download'] });
    },
  });
  const result = await driver.preflight(['Primary navigation', 'Add files', 'Select fixture.jpg', 'Remove fixture.jpg', 'Paste URL to download']);
  assert.equal(result.frontmost_pid, 42);
  assert.match(scripts.join('\n'), /unixId:42/);
  assert.doesNotMatch(scripts.join('\n'), /processes\.byName/);
  assert.doesNotMatch(scripts.join('\n'), /position|click at|mouse/i);
  assert.throws(() => createAccessibilityDriver({ platform: 'linux', appName: 'Goop', expectedPid: 1, runScript: async () => '{}' }), /macOS/i);
});

test('AX driver fails closed on permission, focus, modal, and missing labels', async () => {
  for (const [payload, pattern] of [
    [{ trusted: false, frontmost_pid: 42, modal_count: 0, labels: [] }, /permission/i],
    [{ trusted: true, frontmost_pid: 99, modal_count: 0, labels: [] }, /frontmost/i],
    [{ trusted: true, frontmost_pid: 42, modal_count: 1, labels: [] }, /modal/i],
    [{ trusted: true, frontmost_pid: 42, modal_count: 0, labels: [] }, /label/i],
  ]) {
    const driver = createAccessibilityDriver({ platform: 'darwin', appName: 'Goop', expectedPid: 42, runScript: async () => JSON.stringify(payload) });
    await assert.rejects(() => driver.preflight(['Primary navigation']), pattern);
  }
});

test('driver revalidates focus before every action and validates the focused target', async () => {
  const scripts = [];
  const replies = [
    { trusted: true, frontmost_pid: 42, modal_count: 0, target_count: 1, target_role: 'AXTextField', target_label: 'Paste URL to download', focused_role: 'AXTextField', focused_label: 'Paste URL to download' },
    { trusted: true, frontmost_pid: 42, modal_count: 0, target_count: 1, target_role: 'AXTextField', target_label: 'Paste URL to download', focused_role: 'AXTextField', focused_label: 'Paste URL to download', value: 'h', driver_duration_us: 100 },
  ];
  const driver = createAccessibilityDriver({ platform: 'darwin', appName: 'Goop', expectedPid: 42, runScript: async script => { scripts.push(script); return JSON.stringify(replies.shift()); } });
  const result = await driver.perform({ ordinal: 1, kind: 'keystroke', role: 'AXTextField', label: 'Paste URL to download', text: 'h', expected_prior_value: '', completion: { kind: 'attribute_equals', attribute: 'AXValue', value: 'h' }, timeout_ms: 2000 });
  assert.equal(result.ordinal, 1);
  assert.equal(scripts.length, 2);
});

test('AX press resolves one named button without requiring it to be pre-focused', async () => {
  const replies = [
    { trusted: true, frontmost_pid: 42, modal_count: 0, target_count: 1, target_role: 'AXButton', target_label: 'Add files', focused_role: 'AXTextField', focused_label: 'Paste URL to download' },
    { trusted: true, frontmost_pid: 42, modal_count: 0, target_count: 1, target_role: 'AXButton', target_label: 'Add files', focused_role: 'AXTextField', focused_label: 'Paste URL to download', value: true, driver_duration_us: 100 },
  ];
  const driver = createAccessibilityDriver({ platform: 'darwin', appName: 'Goop', expectedPid: 42, runScript: async () => JSON.stringify(replies.shift()) });
  const result = await driver.perform({ ordinal: 1, kind: 'press', role: 'AXButton', label: 'Add files', completion: { kind: 'attribute_equals', attribute: 'AXEnabled', value: true }, timeout_ms: 2000 });
  assert.equal(result.ordinal, 1);
});

test('AX driver reads one named target value and rejects focus loss', async () => {
  const driver = createAccessibilityDriver({ platform: 'darwin', appName: 'Goop', expectedPid: 42, runScript: async () => JSON.stringify({ frontmost_pid: 42, modal_count: 0, target_count: 1, target_role: 'AXTextField', target_label: 'Paste URL to download', value: 'https://x.test/a.mp4' }) });
  assert.equal(await driver.readValue({ role: 'textbox', label: 'Paste URL to download' }), 'https://x.test/a.mp4');
  const interrupted = createAccessibilityDriver({ platform: 'darwin', appName: 'Goop', expectedPid: 42, runScript: async () => JSON.stringify({ frontmost_pid: 99, modal_count: 0, target_count: 1, target_role: 'AXTextField', target_label: 'Paste URL to download', value: 'wrong' }) });
  await assert.rejects(() => interrupted.readValue({ role: 'textbox', label: 'Paste URL to download' }), /interruption|frontmost|focus/i);
});

test('AX action rejects duplicate named targets before dispatch', async () => {
  const driver = createAccessibilityDriver({ platform: 'darwin', appName: 'Goop', expectedPid: 42, runScript: async () => JSON.stringify({ trusted: true, frontmost_pid: 42, modal_count: 0, target_count: 2, target_role: 'AXButton', target_label: 'Remove fixture.jpg' }) });
  await assert.rejects(() => driver.perform({ ordinal: 1, kind: 'press', role: 'AXButton', label: 'Remove fixture.jpg', completion: { kind: 'attribute_equals', attribute: 'AXEnabled', value: true }, timeout_ms: 2000 }), /exactly one/i);
});

test('AX driver maps DOM roles and emits modifier-key operations without coordinates', async () => {
  const scripts = [];
  const replies = [
    { trusted: true, frontmost_pid: 42, modal_count: 0, target_count: 1, target_role: 'AXTextField', target_label: 'Paste URL to download', focused_role: 'AXTextField', focused_label: 'Paste URL to download', value: 'old' },
    { trusted: true, frontmost_pid: 42, modal_count: 0, target_count: 1, target_role: 'AXTextField', target_label: 'Paste URL to download', focused_role: 'AXTextField', focused_label: 'Paste URL to download', value: 'old', driver_duration_us: 50 },
  ];
  const driver = createAccessibilityDriver({ platform: 'darwin', appName: 'Goop', expectedPid: 42, runScript: async script => { scripts.push(script); return JSON.stringify(replies.shift()); } });
  await driver.perform({ ordinal: 1, kind: 'key_chord', key: 'a', modifiers: ['command'], role: 'textbox', label: 'Paste URL to download', expected_prior_value: 'old', completion: { kind: 'attribute_equals', attribute: 'AXValue', value: 'old' }, timeout_ms: 2000 });
  assert.match(scripts.join('\n'), /AXTextField/);
  assert.match(scripts.join('\n'), /command down/);
  assert.doesNotMatch(scripts.join('\n'), /position|click at|mouse/i);
});

test('AX driver maps semantic navigation links to AXLink', async () => {
  const scripts = [];
  const replies = [
    { trusted: true, frontmost_pid: 42, modal_count: 0, target_count: 1, target_role: 'AXLink', target_label: 'Convert', focused_role: null, focused_label: null, value: false },
    { trusted: true, frontmost_pid: 42, modal_count: 0, target_count: 1, target_role: 'AXLink', target_label: 'Convert', focused_role: null, focused_label: null, value: true, driver_duration_us: 50 },
  ];
  const driver = createAccessibilityDriver({ platform: 'darwin', appName: 'Goop', expectedPid: 42, runScript: async script => { scripts.push(script); return JSON.stringify(replies.shift()); } });
  await driver.perform({ ordinal: 1, kind: 'press', role: 'link', label: 'Convert', expected_prior_value: 'false', completion: { kind: 'attribute_equals', attribute: 'AXSelected', value: true }, timeout_ms: 2000 });
  assert.match(scripts.join('\n'), /AXLink/);
  assert.match(scripts[0], /AXSelected/);
});

test('AX Open-dialog action selects eight named fixtures without coordinates', async () => {
  const scripts = [];
  const fixtures = Array.from({ length: 8 }, (_, index) => `fixture-${index + 1}.jpg`);
  const replies = [
    { trusted: true, frontmost_pid: 42, modal_count: 0, target_count: 1, target_role: 'AXButton', target_label: 'Add files', focused_role: null, focused_label: null, value: true },
    { trusted: true, frontmost_pid: 42, modal_count: 0, target_count: 1, target_role: 'AXButton', target_label: 'Add files', focused_role: null, focused_label: null, value: true, driver_duration_us: 1000 },
  ];
  const driver = createAccessibilityDriver({ platform: 'darwin', appName: 'Goop', expectedPid: 42, runScript: async script => { scripts.push(script); return JSON.stringify(replies.shift()); } });
  await driver.perform({ ordinal: 1, kind: 'open_dialog_select', role: 'button', label: 'Add files', fixture_directory: '/tmp/goop-fixtures', fixture_names: fixtures, completion: { kind: 'attribute_equals', role: 'button', label: `Remove ${fixtures[7]}`, attribute: 'AXEnabled', value: true }, timeout_ms: 10_000 });
  const dispatch = scripts[1];
  for (const fixture of fixtures) assert.match(dispatch, new RegExp(fixture.replace('.', '\\.')));
  assert.match(dispatch, /AXModal|modal/i);
  assert.match(dispatch, /AXSelected/);
  assert.doesNotMatch(dispatch, /position|click at|mouse/i);
});

test('recorder readiness wait is bounded and requires matching identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'goop-recorder-ready-'));
  try {
    const path = join(root, 'recorder_ready.json');
    setTimeout(() => writeFileSync(path, JSON.stringify({ schema_version: 2, component_kind: 'recorder_ready', session_id: uuid('1'), sample_id: 'sample', page_instance_id: uuid('2'), action_id: 1, pid: 42, native_clock: { domain: 'native_monotonic', unit: 'us', elapsed_us: 10 } })), 20);
    const ready = await waitForRecorderReady(path, { schema_version: 2, component_kind: 'recorder_ready', session_id: uuid('1'), sample_id: 'sample', page_instance_id: uuid('2'), action_id: 1, pid: 42 }, { timeoutMs: 500, pollMs: 5 });
    assert.equal(ready.page_instance_id, uuid('2'));
    writeFileSync(path, JSON.stringify({ ...ready, pid: 99 }));
    await assert.rejects(() => waitForRecorderReady(path, { session_id: uuid('1'), sample_id: 'sample', pid: 42 }, { timeoutMs: 20, pollMs: 5 }), /identity/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('readiness wait aborts promptly instead of waiting for its polling timeout', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'goop-ready-abort-')));
  try {
    const controller = new AbortController();
    const waiting = waitForRecorderReady(join(root, 'missing.json'), { session_id: uuid('1') }, { timeoutMs: 30_000, pollMs: 5, abortSignal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(() => waiting, /aborted/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('page startup accepts a matching observer-init failure before recorder readiness', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'goop-pre-ready-failure-')));
  try {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/responsiveness-jcs.json', import.meta.url), 'utf8'));
    const page = structuredClone(fixture.cases.find(value => value.id === 'representative-frontend-page-component').input);
    page.frontend_trace.failure = { code: 'observer_init', phase: 'observer', count: 1 };
    page.frontend_trace.settled = false;
    writeFileSync(join(root, `frontend-primary-${page.page_instance_id}.json`), JSON.stringify(page));
    const result = await waitForRecorderOrFailedPage({
      recorderPath: join(root, `recorder-ready-${page.page_instance_id}.json`),
      reportDirectory: root,
      identity: { session_id: page.session_id, sample_id: page.sample_id, page_instance_id: page.page_instance_id, action_id: 1, pid: page.pid },
      descriptor: { sessionId: page.session_id, sampleId: page.sample_id, pageInstanceId: page.page_instance_id, componentRole: page.component_role },
      timeoutMs: 100,
      pollMs: 1,
    });
    assert.equal(result.kind, 'failed_component');
    assert.equal(result.page_component.frontend_trace.failure.code, 'observer_init');
    const progressed = structuredClone(page);
    progressed.frontend_trace.setups = [{ setup_id: 1, target_id: 'setup', state: 'cancelled', start_us: 0, terminal_us: 1 }];
    writeFileSync(join(root, `frontend-primary-${page.page_instance_id}.json`), JSON.stringify(progressed));
    await assert.rejects(() => waitForRecorderOrFailedPage({
      recorderPath: join(root, `recorder-ready-${page.page_instance_id}.json`), reportDirectory: root,
      identity: { session_id: page.session_id, sample_id: page.sample_id, page_instance_id: page.page_instance_id, action_id: 1, pid: page.pid },
      descriptor: { sessionId: page.session_id, sampleId: page.sample_id, pageInstanceId: page.page_instance_id, componentRole: page.component_role },
      timeoutMs: 100, pollMs: 1,
    }), /zero-progress/i);
    writeFileSync(join(root, `frontend-primary-${page.page_instance_id}.json`), JSON.stringify({ ...page, pid: 99 }));
    await assert.rejects(() => waitForRecorderOrFailedPage({
      recorderPath: join(root, `recorder-ready-${page.page_instance_id}.json`), reportDirectory: root,
      identity: { session_id: page.session_id, sample_id: page.sample_id, page_instance_id: page.page_instance_id, action_id: 1, pid: page.pid },
      descriptor: { sessionId: page.session_id, sampleId: page.sample_id, pageInstanceId: page.page_instance_id, componentRole: page.component_role },
      timeoutMs: 100, pollMs: 1,
    }), /identity mismatch/i);
    writeFileSync(join(root, `frontend-primary-${page.page_instance_id}.json`), '{not-json');
    await assert.rejects(() => waitForRecorderOrFailedPage({
      recorderPath: join(root, `recorder-ready-${page.page_instance_id}.json`), reportDirectory: root,
      identity: { session_id: page.session_id, sample_id: page.sample_id, page_instance_id: page.page_instance_id, action_id: 1, pid: page.pid },
      descriptor: { sessionId: page.session_id, sampleId: page.sample_id, pageInstanceId: page.page_instance_id, componentRole: page.component_role },
      timeoutMs: 100, pollMs: 1,
    }), /JSON/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('simultaneous recovery readiness wins over a settled zero-action component', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'goop-simultaneous-recovery-ready-')));
  try {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/responsiveness-jcs.json', import.meta.url), 'utf8'));
    const page = structuredClone(fixture.cases.find(value => value.id === 'representative-frontend-page-component').input);
    page.component_role = 'recovery'; page.frontend_trace.component_role = 'recovery'; page.pid = 42;
    const recorderPath = join(root, `recorder-ready-${page.page_instance_id}.json`);
    writeFileSync(join(root, `frontend-recovery-${page.page_instance_id}.json`), JSON.stringify(page));
    writeFileSync(recorderPath, JSON.stringify({ schema_version: 2, component_kind: 'recorder_ready', session_id: page.session_id, sample_id: page.sample_id, page_instance_id: page.page_instance_id, action_id: null, pid: 42, native_clock: { domain: 'native_monotonic', unit: 'us', elapsed_us: 1 } }));
    const result = await waitForRecorderOrFailedPage({
      recorderPath, reportDirectory: root,
      identity: { session_id: page.session_id, sample_id: page.sample_id, page_instance_id: page.page_instance_id, action_id: null, pid: 42 },
      descriptor: { sessionId: page.session_id, sampleId: page.sample_id, pageInstanceId: page.page_instance_id, componentRole: 'recovery' },
      timeoutMs: 100, pollMs: 1,
    });
    assert.equal(result.kind, 'recorder_ready');
    assert.equal(result.marker.action_id, null);
    writeFileSync(join(root, `frontend-recovery-${page.page_instance_id}.json`), '{malformed');
    const masked = await waitForRecorderOrFailedPage({
      recorderPath, reportDirectory: root,
      identity: { session_id: page.session_id, sample_id: page.sample_id, page_instance_id: page.page_instance_id, action_id: null, pid: 42 },
      descriptor: { sessionId: page.session_id, sampleId: page.sample_id, pageInstanceId: page.page_instance_id, componentRole: 'recovery' },
      timeoutMs: 100, pollMs: 1,
    });
    assert.equal(masked.kind, 'recorder_ready');
    assert.throws(() => loadPageComponent(join(root, `frontend-recovery-${page.page_instance_id}.json`)), /JSON/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('native page reaps a pre-ready recorder failure without AX dispatch and retains process evidence', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'goop-pre-ready-native-page-')));
  try {
    const report = join(root, 'report'); mkdirSync(report);
    const profile = join(root, 'profile'); mkdirSync(profile);
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/responsiveness-jcs.json', import.meta.url), 'utf8'));
    const component = structuredClone(fixture.cases.find(value => value.id === 'representative-frontend-page-component').input);
    component.frontend_trace.failure = { code: 'observer_init', phase: 'observer', count: 1 };
    component.frontend_trace.settled = false;
    const template = join(root, 'component.json'); writeFileSync(template, JSON.stringify(component));
    const binary = join(root, 'fake-app');
    writeFileSync(binary, `#!/usr/bin/env node\nconst fs=require('node:fs');const path=require('node:path');const value=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));value.pid=process.pid;fs.writeFileSync(path.join(process.env.GOOP_RESPONSIVENESS_REPORT_DIR,'frontend-'+value.component_role+'-'+value.page_instance_id+'.json'),JSON.stringify(value),{flag:'wx'});setInterval(()=>{},1000);\n`);
    chmodSync(binary, 0o700);
    const manifest = {
      schema_version: 2, token: 'pre-ready-token', ...activationFields(),
      descriptor: { componentRole: 'primary', sessionId: component.session_id, sampleId: component.sample_id, pageInstanceId: component.page_instance_id, lane: 'inspection', scenario: { id: component.scenario?.id ?? component.frontend_trace.scenario.id, manifestSha256: component.frontend_trace.scenario.manifest_sha256 }, workload: component.frontend_trace.workload, phase: 'measured', repetition: 0 },
      actions: [{ actionId: 1, targetId: 'never-dispatched', eventType: 'click', targetRole: 'button', accessibleName: 'Never dispatch', expectedPriorValue: 'false' }],
    };
    component.sample_id = manifest.descriptor.sampleId; component.session_id = manifest.descriptor.sessionId; component.page_instance_id = manifest.descriptor.pageInstanceId;
    const manifestPath = join(root, 'manifest.json'); writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = await runNativePage({
      plan: { binary, app_name: 'Goop', app_data_directory: profile, component_directory: report, limits: { log_limit_bytes: 4096, storage_budget_bytes: 1024 * 1024 } },
      page: { manifest_path: manifestPath, argv: [template], required_labels: ['Never dispatch'], actions: [{ ...manifest.actions[0], dispatch: { kind: 'press', completion: { kind: 'attribute_equals', attribute: 'AXSelected', value: true }, timeout_ms: 2000 } }], timeout_ms: 3000 },
      manifest, platform: 'darwin',
    });
    assert.equal(result.page_component.frontend_trace.failure.code, 'observer_init');
    assert.deepEqual(result.driver_observations, []);
    assert.ok(result.process_series.identities.length >= 1);
    assert.equal(result.cleanup.complete, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('readiness markers require the exact native clock envelope', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'goop-action-ready-')));
  try {
    const path = join(root, `action-ready-2-${uuid('2')}.json`);
    writeFileSync(path, JSON.stringify({ schema_version: 2, component_kind: 'action_ready', session_id: uuid('1'), sample_id: 'sample', page_instance_id: uuid('2'), action_id: 2, pid: 42 }));
    await assert.rejects(() => waitForActionReady(root, { session_id: uuid('1'), sample_id: 'sample', page_instance_id: uuid('2'), action_id: 2, pid: 42 }, { timeoutMs: 20, pollMs: 5 }), /native clock|fields/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('startup readiness wait binds the launched PID before AX preflight', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'goop-startup-ready-')));
  try {
    const path = join(root, 'startup.json');
    writeFileSync(path, JSON.stringify({ schema_version: 1, pid: 42, backend_ready_ms: 5 }));
    assert.equal((await waitForStartupReady(path, 42, { timeoutMs: 20, pollMs: 5 })).backend_ready_ms, 5);
    await assert.rejects(() => waitForStartupReady(path, 99, { timeoutMs: 20, pollMs: 5 }), /identity/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AX preflight retries only while a recorder-ready target is still mounting', async () => {
  let attempts = 0;
  const driver = {
    preflight: async labels => {
      attempts += 1;
      assert.deepEqual(labels, ['Convert']);
      if (attempts === 1) throw Error('Required accessibility label is missing: Convert');
      return { ok: true };
    },
  };
  assert.deepEqual(await waitForAxPreflight(driver, ['Convert'], { timeoutMs: 100, pollMs: 1 }), { ok: true });
  assert.equal(attempts, 2);
  await assert.rejects(() => waitForAxPreflight({ preflight: async () => { throw Error('Frontmost process changed'); } }, ['Convert'], { timeoutMs: 100, pollMs: 1 }), /Frontmost process changed/);
});

test('action sequence waits for initial readiness before setup and each next-action marker before dispatch', async () => {
  const order = [];
  const driver = { perform: async action => { order.push(`dispatch-${action.ordinal}`); return { ordinal: action.ordinal }; } };
  const plan = [
    { actionId: 1, targetRole: 'AXButton', accessibleName: 'Select fixture.jpg', dispatch: { kind: 'press', completion: { kind: 'attribute_equals', attribute: 'AXSelected', value: true }, timeout_ms: 2000 } },
    { actionId: 2, targetRole: 'AXButton', accessibleName: 'Remove fixture.jpg', dispatch: { kind: 'press', completion: { kind: 'attribute_equals', attribute: 'AXEnabled', value: true }, timeout_ms: 2000 } },
  ];
  const observations = await runAccessibilitySequence({
    driver, actions: plan, reportDirectory: '/tmp/reports',
    identity: { session_id: uuid('1'), sample_id: 'sample', page_instance_id: uuid('2'), pid: 42 },
    waitRecorder: async () => { order.push('recorder-ready-1'); return { action_id: 1 }; },
    waitAction: async (_directory, marker) => { order.push(`action-ready-${marker.action_id}`); return marker; },
    afterRecorderReady: async () => { order.push('setup'); },
  });
  assert.deepEqual(order, ['recorder-ready-1', 'setup', 'dispatch-1', 'action-ready-2', 'dispatch-2']);
  assert.deepEqual(observations.map(value => value.ordinal), [1, 2]);
});

test('Lane 3 sequence enforces a monotonic 40-second deadline per cycle', async () => {
  let now = 0;
  const actions = makeSessionActions();
  const driver = { perform: async action => { if (action.ordinal === 1) now = 40_001; return { ordinal: action.ordinal }; } };
  await assert.rejects(() => runAccessibilitySequence({
    driver, actions, reportDirectory: '/tmp/reports', nowMs: () => now,
    identity: { session_id: uuid('1'), sample_id: 'sample', page_instance_id: uuid('2'), pid: 42 },
    waitRecorder: async () => ({}), waitAction: async () => ({}),
  }), /cycle 1.*40 seconds/i);
});

test('sample assembly validates components and clock domains without inventing cross-clock duration', () => {
  const component = frontend();
  const common = {
    identity: evidenceIdentity(),
    clock_origins: { driver_monotonic: { unit: 'us' }, native_monotonic: { unit: 'us' } },
    limitations: ['event_timing_unsupported', 'long_tasks_unsupported'],
    cleanup: { complete: true, removed_paths: 1, error_code: null },
    outcome: { kind: 'success' },
  };
  const sample = assembleSample({
    lane: 'inspection',
    frontendComponents: [component],
    common,
    payload: { ...inspectionPayload(), external_selection_duration_us: 100, interaction_to_double_raf_us: 50 },
  });
  assert.equal(sample.schema_version, 2);
  assert.equal(sample.session_id, component.session_id);
  assert.equal(sample.lane, 'inspection');
  assert.throws(() => assembleSample({ lane: 'inspection', frontendComponents: [component], common: { ...common, clock_origins: { driver_monotonic: { unit: 'ms' }, native_monotonic: { unit: 'us' } } }, payload: sample.payload }), /clock/i);
});

test('successful draft assembly requires exact recovered hash and AX value', () => {
  const pre = frontend({ lane: 'draft', role: 'pre_quit', page: uuid('2') });
  const recovery = frontend({ lane: 'draft', role: 'recovery', page: uuid('3') });
  const common = { identity: evidenceIdentity(), clock_origins: { driver_monotonic: { unit: 'us' }, native_monotonic: { unit: 'us' } }, limitations: [], cleanup: { complete: true, removed_paths: 1, error_code: null }, outcome: { kind: 'success' } };
  const payload = { seed_entry_count: 500, seed_byte_count: 1000, action_summaries: Array.from({ length: 20 }, (_, action_id) => ({ action_id: action_id + 1 })), encode_span_ids: [], storage_span_ids: [], logical_persistence_acknowledged: true, expected_draft_sha256: digest('a'), recovered_draft_sha256: digest('a'), expected_ax_value: 'https://x.test/a.mp4', recovered_ax_value: 'https://x.test/a.mp4' };
  assert.equal(assembleSample({ lane: 'draft', frontendComponents: [pre, recovery], common, payload }).outcome.kind, 'success');
  assert.throws(() => assembleSample({ lane: 'draft', frontendComponents: [pre, recovery], common, payload: { ...payload, recovered_draft_sha256: digest('b') } }), /recovery mismatch/i);
});

test('session-memory assembly requires exactly 50 cycle summaries', () => {
  const component = frontend({ lane: 'session_memory' });
  const common = { identity: evidenceIdentity(), clock_origins: { driver_monotonic: { unit: 'us' }, native_monotonic: { unit: 'us' } }, limitations: [], cleanup: { complete: true, removed_paths: 0, error_code: null }, outcome: { kind: 'success' } };
  const series = completeProcessSeries(); const summary = summarizeProcessSeries(series);
  assert.throws(() => assembleSample({ lane: 'session_memory', frontendComponents: [component], common, payload: { cycle_summaries: [], driver_observations: [], process_series: [series], process_summaries: [summary] } }), /50 cycle/i);
  const payload = { cycle_summaries: Array.from({ length: 50 }, (_, cycle_index) => ({ cycle_index })), driver_observations: [], process_series: [series], process_summaries: [summary] };
  assert.equal(assembleSample({ lane: 'session_memory', frontendComponents: [component], common, payload }).payload.cycle_summaries.length, 50);
  assert.throws(() => assembleSample({ lane: 'session_memory', frontendComponents: [component], common, payload: { ...payload, process_summaries: [{ ...summary, peak_rss_kib: 999 }] } }), /summary does not match/i);
  assert.throws(() => assembleSample({ lane: 'session_memory', frontendComponents: [component], common, payload: { ...payload, cycle_summaries: payload.cycle_summaries.map((value, index) => index === 4 ? { cycle_index: 5 } : value) } }), /ordered/i);
});

test('sample outcomes and cleanup failures use only the closed schema codes', () => {
  const component = frontend();
  const common = {
    identity: evidenceIdentity(),
    clock_origins: { driver_monotonic: { unit: 'us' }, native_monotonic: { unit: 'us' } },
    limitations: [],
    cleanup: { complete: false, removed_paths: 0, error_code: 'process_cleanup_failed' },
    outcome: { kind: 'failed', code: 'driver_interrupted' },
  };
  const payload = inspectionPayload();
  assert.equal(assembleSample({ lane: 'inspection', frontendComponents: [component], common, payload }).outcome.code, 'driver_interrupted');
  assert.throws(() => assembleSample({ lane: 'inspection', frontendComponents: [component], common: { ...common, outcome: { kind: 'failed', code: 'made_up' } }, payload }), /outcome/i);
  assert.throws(() => assembleSample({ lane: 'inspection', frontendComponents: [component], common: { ...common, cleanup: { ...common.cleanup, error_code: 'made_up' } }, payload }), /cleanup/i);
  assert.throws(() => assembleSample({ lane: 'inspection', frontendComponents: [component], common: { ...common, outcome: { kind: 'success', code: 'driver_interrupted' } }, payload }), /outcome/i);
});

test('Lane 3 validator requires the exact 50 by 35 action pattern', () => {
  const actions = makeSessionActions();
  assert.equal(actions.length, 1750);
  assert.equal(validateSessionMemoryActions(actions, { cycles: 50, fixture_count: 8, actions_per_cycle: 35, cycle_timeout_ms: 40_000 }).length, 1750);
  assert.throws(() => validateSessionMemoryActions(actions.slice(0, -1), { cycles: 50, fixture_count: 8, actions_per_cycle: 35, cycle_timeout_ms: 40_000 }), /1,750|35/i);
  const wrong = structuredClone(actions); wrong[1].dispatch.timeout_ms = 2000;
  assert.throws(() => validateSessionMemoryActions(wrong, { cycles: 50, fixture_count: 8, actions_per_cycle: 35, cycle_timeout_ms: 40_000 }), /Lane 3 action 2|Open dialog|10,000/i);
  const spoofed = structuredClone(actions); spoofed[5].expectedPriorValue = 'spoofed';
  assert.throws(() => validateSessionMemoryActions(spoofed, { cycles: 50, fixture_count: 8, actions_per_cycle: 35, cycle_timeout_ms: 40_000 }), /prior value/i);
  const wrongPredicate = structuredClone(actions); wrongPredicate[25].dispatch.completion.kind = 'attribute_equals';
  assert.throws(() => validateSessionMemoryActions(wrongPredicate, { cycles: 50, fixture_count: 8, actions_per_cycle: 35, cycle_timeout_ms: 40_000 }), /completion predicate/i);
});

test('native page component loader preserves and validates native clock identity', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'goop-page-component-')));
  try {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/responsiveness-jcs.json', import.meta.url), 'utf8'));
    const page = fixture.cases.find(value => value.id === 'representative-frontend-page-component').input;
    const path = join(root, `frontend-primary-${page.page_instance_id}.json`);
    writeFileSync(path, JSON.stringify(page));
    assert.deepEqual(loadPageComponent(path), page);
    writeFileSync(path, JSON.stringify({ ...page, native_clock: { ...page.native_clock, spoofed: true } }));
    assert.throws(() => loadPageComponent(path), /unknown/i);
    writeFileSync(path, JSON.stringify({ ...page, sample_id: 'wrong' }));
    assert.throws(() => loadPageComponent(path), /identity/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('native draft plan runs pre-quit then recovery before exclusive publication', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'goop-native-plan-')));
  try {
    const binary = join(root, 'Goop'); writeFileSync(binary, 'release-binary');
    const reports = join(root, 'reports'); mkdirSync(reports);
    const profile = join(root, 'profile'); mkdirSync(profile);
    const makeManifest = (role, page, actionName) => ({
      schema_version: 2,
      token: `token-${role}`,
      ...activationFields(role),
      descriptor: { componentRole: role, sessionId: uuid('1'), sampleId: 'draft:500:measured:0', pageInstanceId: page, lane: 'draft', scenario: { id: 'draft-500', manifestSha256: digest('a') }, workload: { id: 'draft-500', facts: { seeded_entries: 500 } }, phase: 'measured', repetition: 0 },
      actions: role === 'recovery' ? [] : [{ actionId: 1, targetId: actionName, eventType: 'input', targetRole: 'textbox', accessibleName: 'Paste URL to download', expectedPriorValue: '' }],
    });
    const manifests = [makeManifest('pre_quit', uuid('2'), 'draft-key'), makeManifest('recovery', uuid('3'), 'recovery-check')];
    manifests[1].completion.expectedDraftSha256 = digest('b');
    manifests[1].completion.expectedAxValue = 'https://x.test/a.mp4';
    const pages = manifests.map((manifest, index) => {
      const manifestPath = join(root, `manifest-${index}.json`); writeFileSync(manifestPath, JSON.stringify(manifest));
      return { manifest_path: manifestPath, required_labels: ['Paste URL to download'], ...(manifest.descriptor.componentRole === 'recovery' ? { recovery_target: { role: 'textbox', label: 'Paste URL to download' } } : {}), actions: manifest.actions.map(action => ({ ...action, dispatch: { kind: 'keystroke', text: 'h', completion: { kind: 'attribute_equals', attribute: 'AXValue', value: 'h' }, timeout_ms: 2000 } })), timeout_ms: 10_000 };
    });
    const calls = [];
    const runPage = async ({ manifest }) => {
      calls.push(manifest.descriptor.componentRole);
      const trace = frontend({ lane: 'draft', role: manifest.descriptor.componentRole, page: manifest.descriptor.pageInstanceId });
      trace.sample_id = manifest.descriptor.sampleId;
      trace.scenario = { id: manifest.descriptor.scenario.id, manifest_sha256: manifest.descriptor.scenario.manifestSha256 };
      trace.workload = manifest.descriptor.workload;
      trace.actions = recordedActions(manifest.actions);
      if (manifest.descriptor.componentRole === 'recovery') {
        trace.setups = [{ setup_id: 1, target_id: 'recovery', state: 'settled', start_us: 0, terminal_us: 3 }];
        trace.events = [
          { event_seq: 1, owner: { kind: 'setup', setup_id: 1 }, span_id: 1, kind: 'persistence_settled', at_us: 1, subject_id: 'draft_sha256', correlation_id: digest('b') },
          { event_seq: 2, owner: { kind: 'setup', setup_id: 1 }, span_id: 1, kind: 'persistence_settled', at_us: 2, subject_id: 'recovered_value_sha256', correlation_id: hash('https://x.test/a.mp4') },
        ];
        trace.spans = [{ span_id: 1, owner: { kind: 'setup', setup_id: 1 }, parent_span_id: null, kind: 'recovery_verification', subject_id: 'workspace_drafts', start_us: 0, end_us: 3, terminal: 'ended', terminal_cause_action_id: null }];
      }
      return { page_component: { schema_version: 2, component_kind: 'frontend_page_component', session_id: trace.session_id, sample_id: trace.sample_id, page_instance_id: trace.page_instance_id, component_role: trace.component_role, pid: 42, native_clock: { domain: 'native_monotonic', unit: 'us', elapsed_us: 10 }, frontend_trace: trace }, driver_observations: driverObservations(manifest.actions), process_series: null, recovery_evidence: manifest.descriptor.componentRole === 'recovery' ? { ax_value: 'https://x.test/a.mp4' } : null, cleanup: { complete: true } };
    };
    const basePlan = {
      schema_version: 2, app_name: 'Goop', binary, report_directory: reports, app_data_directory: profile, pages,
      identity_inputs: identityInputs(binary, pages.map(page => page.manifest_path)),
      common: { identity: evidenceIdentity(), clock_origins: { driver_monotonic: { unit: 'us' }, native_monotonic: { unit: 'us' } }, limitations: [], cleanup: { complete: true, removed_paths: 0, error_code: null }, outcome: { kind: 'success' } },
      payload: { seed_entry_count: 500, seed_byte_count: 1000, action_summaries: Array.from({ length: 20 }, (_, action_id) => ({ action_id: action_id + 1 })), encode_span_ids: [], storage_span_ids: [], logical_persistence_acknowledged: true, expected_draft_sha256: digest('c'), recovered_draft_sha256: digest('c'), expected_ax_value: 'spoofed', recovered_ax_value: 'spoofed' },
      limits: { log_limit_bytes: 65_536, storage_budget_bytes: 16_777_216 }, cleanup_profile: false,
    };
    const cleanupReceipt = manifest => ({ schema_version: 2, component_kind: 'data_store_cleanup', session_id: manifest.descriptor.sessionId, webview_data_store_id: manifest.webviewDataStoreId, removed: true, error_code: null, pid: 43, native_clock: { domain: 'native_monotonic', unit: 'us', elapsed_us: 20 } });
    await assert.rejects(() => runNativeResponsivenessPlan({ ...basePlan, unexpected: true }, { platform: 'darwin', runPage, runCleanup: async ({ manifest }) => cleanupReceipt(manifest) }), /unknown fields: unexpected/);
    await assert.rejects(() => runNativeResponsivenessPlan({ ...basePlan, pages: [{ ...basePlan.pages[0], unexpected: true }, basePlan.pages[1]] }, { platform: 'darwin', runPage, runCleanup: async ({ manifest }) => cleanupReceipt(manifest) }), /unknown fields: unexpected/);
    await assert.rejects(() => runNativeResponsivenessPlan({ ...basePlan, pages: [{ ...basePlan.pages[0], actions: [{ ...basePlan.pages[0].actions[0], dispatch: { ...basePlan.pages[0].actions[0].dispatch, unexpected: true } }] }, basePlan.pages[1]] }, { platform: 'darwin', runPage, runCleanup: async ({ manifest }) => cleanupReceipt(manifest) }), /unknown fields: unexpected/);
    await assert.rejects(() => runNativeResponsivenessPlan({ ...basePlan, pages: [{ ...basePlan.pages[0], actions: [{ ...basePlan.pages[0].actions[0], dispatch: { ...basePlan.pages[0].actions[0].dispatch, text: {} } }] }, basePlan.pages[1]] }, { platform: 'darwin', runPage, runCleanup: async ({ manifest }) => cleanupReceipt(manifest) }), /keystroke text/);
    await assert.rejects(() => runNativeResponsivenessPlan({ ...basePlan, report_directory: join(process.cwd(), 'owned-responsiveness-output') }, { platform: 'darwin', runPage, runCleanup: async ({ manifest }) => cleanupReceipt(manifest) }), /outside the identity repository/);
    const result = await runNativeResponsivenessPlan(basePlan, { platform: 'darwin', runPage, runCleanup: async ({ manifest }) => cleanupReceipt(manifest) });
    assert.deepEqual(calls, ['pre_quit', 'recovery']);
    assert.equal(result.sample.frontend_components.length, 2);
    assert.equal(result.sample.payload.expected_draft_sha256, digest('b'));
    assert.equal(result.sample.payload.recovered_draft_sha256, digest('b'));
    assert.equal(result.sample.payload.expected_ax_value, 'https://x.test/a.mp4');
    assert.equal(result.sample.payload.recovered_ax_value, 'https://x.test/a.mp4');
    assert.equal(existsSync(join(reports, 'sample.json')), true);
    assert.equal(existsSync(join(reports, 'components')), true);
    assert.equal(existsSync(join(reports, '.incomplete')), false);
    for (const name of ['identity.json', 'driver.json', 'process-series.json', 'recovery.json']) assert.equal(existsSync(join(reports, 'components', name)), true, name);
    assert.equal(readdirSync(join(reports, 'components')).filter(name => name === 'driver.json').length, 1);
    const failedReports = join(root, 'failed-reports'); mkdirSync(failedReports);
    const failedProfile = join(root, 'failed-profile'); mkdirSync(failedProfile);
    const cleanupFailed = await runNativeResponsivenessPlan({ ...basePlan, report_directory: failedReports, app_data_directory: failedProfile }, { platform: 'darwin', runPage, runCleanup: async ({ manifest }) => ({ receipt: { ...cleanupReceipt(manifest), removed: false }, helper_success: false }) });
    assert.deepEqual(cleanupFailed.sample.outcome, { kind: 'failed', code: 'cleanup_failed' });
    assert.equal(existsSync(join(failedReports, 'sample.json')), true);
    const recorderReports = join(root, 'recorder-failed-reports'); mkdirSync(recorderReports);
    const recorderProfile = join(root, 'recorder-failed-profile'); mkdirSync(recorderProfile);
    const recorderFailed = await runNativeResponsivenessPlan({ ...basePlan, report_directory: recorderReports, app_data_directory: recorderProfile }, { platform: 'darwin', runPage: async context => {
      const value = await runPage(context);
      if (context.manifest.descriptor.componentRole === 'pre_quit') {
        value.page_component.frontend_trace.actions = [];
        value.page_component.frontend_trace.failure = { code: 'state_transition', phase: 'action', count: 1 };
        value.page_component.frontend_trace.settled = false;
        value.driver_observations = [];
      }
      return value;
    }, runCleanup: async ({ manifest }) => cleanupReceipt(manifest) });
    assert.deepEqual(recorderFailed.sample.outcome, { kind: 'failed', code: 'frontend_trace_failed' });
    assert.equal(existsSync(join(recorderReports, 'sample.json')), true);
    const recoveryFailedReports = join(root, 'recovery-recorder-failed-reports'); mkdirSync(recoveryFailedReports);
    const recoveryFailedProfile = join(root, 'recovery-recorder-failed-profile'); mkdirSync(recoveryFailedProfile);
    let recoveryFailureCleanup = false;
    const recoveryRecorderFailed = await runNativeResponsivenessPlan({ ...basePlan, report_directory: recoveryFailedReports, app_data_directory: recoveryFailedProfile }, { platform: 'darwin', runPage: async context => {
      const value = await runPage(context);
      if (context.manifest.descriptor.componentRole === 'recovery') {
        value.page_component.frontend_trace.setups = [];
        value.page_component.frontend_trace.events = [];
        value.page_component.frontend_trace.spans = [];
        value.page_component.frontend_trace.failure = { code: 'state_transition', phase: 'setup', count: 1 };
        value.page_component.frontend_trace.settled = false;
        value.recovery_evidence = null;
      }
      return value;
    }, runCleanup: async ({ manifest }) => { recoveryFailureCleanup = true; return cleanupReceipt(manifest); } });
    assert.deepEqual(recoveryRecorderFailed.sample.outcome, { kind: 'failed', code: 'frontend_trace_failed' });
    assert.equal(recoveryRecorderFailed.sample.payload.recovered_draft_sha256, null);
    assert.equal(recoveryRecorderFailed.sample.payload.recovered_ax_value, null);
    assert.equal(existsSync(join(recoveryFailedReports, 'sample.json')), true);
    assert.equal(recoveryFailureCleanup, true);
    const identityReports = join(root, 'identity-failed-reports'); mkdirSync(identityReports);
    const identityProfile = join(root, 'identity-failed-profile'); mkdirSync(identityProfile);
    const identityFailed = await runNativeResponsivenessPlan({ ...basePlan, report_directory: identityReports, app_data_directory: identityProfile }, { platform: 'darwin', runPage, runCleanup: async ({ manifest }) => { writeFileSync(binary, 'changed-release-binary'); return cleanupReceipt(manifest); } });
    assert.deepEqual(identityFailed.sample.outcome, { kind: 'failed', code: 'identity_mismatch' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('infrastructure failure retains bounded components under .incomplete and never publishes', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'goop-incomplete-plan-')));
  try {
    const binary = join(root, 'Goop'); writeFileSync(binary, 'release-binary');
    const reports = join(root, 'reports'); mkdirSync(reports);
    const profile = join(root, 'profile'); mkdirSync(profile);
    const manifest = {
      schema_version: 2, token: 'inspection-token', ...activationFields(),
      descriptor: { componentRole: 'primary', sessionId: uuid('1'), sampleId: 'inspection:fixed:measured:0', pageInstanceId: uuid('2'), lane: 'inspection', scenario: { id: 'inspection-fixed', manifestSha256: digest('a') }, workload: { id: 'inspection-fixed', facts: { source_count: 8 } }, phase: 'measured', repetition: 0 },
      actions: [{ actionId: 1, targetId: 'select-first', eventType: 'click', targetRole: 'button', accessibleName: 'Select fixture-1.jpg', expectedPriorValue: 'false' }],
    };
    const manifestPath = join(root, 'manifest.json'); writeFileSync(manifestPath, JSON.stringify(manifest));
    const plan = {
      schema_version: 2, app_name: 'Goop', binary, report_directory: reports, app_data_directory: profile,
      pages: [{ manifest_path: manifestPath, required_labels: ['Select fixture-1.jpg'], actions: [{ ...manifest.actions[0], dispatch: { kind: 'press', completion: { kind: 'attribute_equals', attribute: 'AXSelected', value: true }, timeout_ms: 2000 } }], timeout_ms: 10_000 }],
      identity_inputs: identityInputs(binary, [manifestPath]),
      common: { identity: evidenceIdentity(), clock_origins: { driver_monotonic: { unit: 'us' }, native_monotonic: { unit: 'us' } }, limitations: [], cleanup: { complete: true, removed_paths: 0, error_code: null }, outcome: { kind: 'success' } },
      payload: {}, limits: { log_limit_bytes: 65_536, storage_budget_bytes: 16_777_216 }, cleanup_profile: false,
    };
    const controller = new AbortController(); controller.abort();
    let cleanupCalled = false;
    await assert.rejects(() => runNativeResponsivenessPlan(plan, {
      platform: 'darwin', abortSignal: controller.signal,
      runPage: async ({ plan: activePlan, abortSignal }) => { assert.equal(abortSignal, controller.signal); writeFileSync(join(activePlan.component_directory, 'partial.json'), '{}', { flag: 'wx' }); throw Error('component missing'); },
      runCleanup: async ({ manifest, abortSignal }) => { cleanupCalled = true; assert.equal(abortSignal, null); return { schema_version: 2, component_kind: 'data_store_cleanup', session_id: manifest.descriptor.sessionId, webview_data_store_id: manifest.webviewDataStoreId, removed: true, error_code: null, pid: 43, native_clock: { domain: 'native_monotonic', unit: 'us', elapsed_us: 20 } }; },
    }), /component missing/);
    assert.equal(cleanupCalled, true);
    assert.equal(existsSync(join(reports, '.incomplete', 'partial.json')), true);
    assert.equal(existsSync(join(reports, 'sample.json')), false);
    assert.equal(existsSync(join(reports, 'components')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('cleanup reads a valid receipt even when the helper exits nonzero', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'goop-cleanup-receipt-')));
  try {
    const binary = join(root, 'Goop'); writeFileSync(binary, 'binary');
    const report = join(root, 'report'); mkdirSync(report);
    const profile = join(root, 'profile'); mkdirSync(profile); mkdirSync(join(profile, 'config')); mkdirSync(join(profile, 'data'));
    const manifestPath = join(root, 'manifest.json'); writeFileSync(manifestPath, '{}');
    const manifest = { ...activationFields(), descriptor: { sessionId: uuid('1') } };
    const receipt = { schema_version: 2, component_kind: 'data_store_cleanup', session_id: uuid('1'), webview_data_store_id: manifest.webviewDataStoreId, removed: false, error_code: null, pid: 43, native_clock: { domain: 'native_monotonic', unit: 'us', elapsed_us: 20 } };
    const result = await runDataStoreCleanup({
      plan: { binary, app_data_directory: profile, pages: [{ manifest_path: manifestPath }], limits: { log_limit_bytes: 1024, storage_budget_bytes: 1024 * 1024 } },
      manifest, componentDirectory: report,
      runProcess: async () => { writeFileSync(join(report, `data-store-cleanup-${uuid('1')}.json`), JSON.stringify(receipt)); return { success: false }; },
    });
    assert.deepEqual(result, { receipt, helper_success: false });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('native long-session plan marks incomplete sampling inconclusive before publication', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'goop-memory-plan-')));
  try {
    const binary = join(root, 'Goop'); writeFileSync(binary, 'release-binary');
    const reports = join(root, 'reports'); mkdirSync(reports);
    const profile = join(root, 'profile'); mkdirSync(profile);
    const manifest = {
      schema_version: 2, token: 'memory-token',
      ...activationFields(),
      descriptor: { componentRole: 'primary', sessionId: uuid('1'), sampleId: 'session_memory:fixed:measured:0', pageInstanceId: uuid('2'), lane: 'session_memory', scenario: { id: 'session-fixed', manifestSha256: digest('a') }, workload: { id: 'session-fixed', facts: { cycles: 50, fixture_count: 8, actions_per_cycle: 35, cycle_timeout_ms: 40_000 } }, phase: 'measured', repetition: 0 },
      actions: makeSessionActions().map(({ dispatch: _dispatch, ...action }) => action),
    };
    const manifestPath = join(root, 'manifest.json'); writeFileSync(manifestPath, JSON.stringify(manifest));
    const trace = frontend({ lane: 'session_memory', role: 'primary', page: manifest.descriptor.pageInstanceId });
    trace.sample_id = manifest.descriptor.sampleId; trace.scenario = { id: manifest.descriptor.scenario.id, manifest_sha256: manifest.descriptor.scenario.manifestSha256 }; trace.workload = manifest.descriptor.workload;
    trace.actions = recordedActions(manifest.actions);
    const processSeries = { identities: [{ process_index: 0, pid: 42, ppid: 1, process_start_time: 'time', canonical_executable: '/goop' }], snapshots: Array.from({ length: 29 }, (_, index) => ({ elapsed_us: index * 1_000_000, rss_by_process: [[0, 100 + index]] })), scheduled_reads: 30, missed_reads: 1, pid_reuse_count: 0, churn: { processes_started: 1, processes_exited: 0 }, attribution_complete: false, root_identity_drift: false };
    const pageComponent = { schema_version: 2, component_kind: 'frontend_page_component', session_id: trace.session_id, sample_id: trace.sample_id, page_instance_id: trace.page_instance_id, component_role: trace.component_role, pid: 42, native_clock: { domain: 'native_monotonic', unit: 'us', elapsed_us: 10 }, frontend_trace: trace };
    const result = await runNativeResponsivenessPlan({
      schema_version: 2, app_name: 'Goop', binary, report_directory: reports, app_data_directory: profile,
      pages: [{ manifest_path: manifestPath, required_labels: ['Convert'], actions: makeSessionActions(), timeout_ms: 2_000_000 }],
      identity_inputs: identityInputs(binary, [manifestPath]),
      common: { identity: evidenceIdentity(), clock_origins: { driver_monotonic: { unit: 'us' }, native_monotonic: { unit: 'us' } }, limitations: [], cleanup: { complete: true, removed_paths: 0, error_code: null }, outcome: { kind: 'success' } }, payload: { cycle_summaries: Array.from({ length: 50 }, (_, cycle_index) => ({ cycle_index })) }, limits: { log_limit_bytes: 65_536, storage_budget_bytes: 16_777_216 }, cleanup_profile: false,
    }, { platform: 'darwin', runPage: async () => ({ page_component: pageComponent, driver_observations: driverObservations(manifest.actions), process_series: processSeries, cleanup: { complete: true } }), runCleanup: async ({ manifest }) => ({ schema_version: 2, component_kind: 'data_store_cleanup', session_id: manifest.descriptor.sessionId, webview_data_store_id: manifest.webviewDataStoreId, removed: true, error_code: null, pid: 43, native_clock: { domain: 'native_monotonic', unit: 'us', elapsed_us: 20 } }) });
    assert.deepEqual(result.sample.outcome, { kind: 'inconclusive', code: 'sampling_incomplete' });
    assert.ok(result.sample.limitations.includes('sampling_missed'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('exclusive canonical publication syncs a bounded create-new sample without replacement', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'goop-sample-publish-')));
  try {
    const sample = { schema_version: 2, outcome: { kind: 'failed', code: 'driver_interrupted' }, value: 'é' };
    const result = publishSampleExclusive(root, sample);
    assert.equal(result.path, join(root, 'sample.json'));
    assert.equal(result.bytes, Buffer.byteLength(canonicalizeJcs(sample)));
    assert.equal(readFileSync(result.path, 'utf8'), canonicalizeJcs(sample));
    assert.equal(lstatSync(result.path).isFile(), true);
    assert.throws(() => publishSampleExclusive(root, sample), /exists|publish/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('directory sync helper is portable on Windows', () => {
  assert.equal(syncDirectoryPortable('C:\\not-opened-on-windows', 'win32'), false);
});

test('publication rejects symlink directories and final samples above 8 MiB', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'goop-sample-bounds-')));
  try {
    const real = join(root, 'real'); mkdirSync(real);
    const link = join(root, 'link'); symlinkSync(real, link);
    assert.throws(() => publishSampleExclusive(link, { schema_version: 2 }), /symbolic link/i);
    assert.throws(() => publishSampleExclusive(real, { value: 'x'.repeat(MAX_SAMPLE_BYTES) }), /8 MiB|size/i);
    assert.equal(existsSync(join(real, 'sample.json')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('publication never replaces an existing target even through a second hard link', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'goop-sample-existing-')));
  try {
    const source = join(root, 'source'); writeFileSync(source, 'keep');
    linkSync(source, join(root, 'sample.json'));
    assert.throws(() => publishSampleExclusive(root, { schema_version: 2 }), /exists|publish/i);
    assert.equal(readFileSync(join(root, 'sample.json'), 'utf8'), 'keep');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
