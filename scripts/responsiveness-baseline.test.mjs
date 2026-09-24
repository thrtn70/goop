import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
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
  validateCapturedIdentity,
} from './performance-shared.mjs';
import {
  MAX_SAMPLE_BYTES,
  assembleSample,
  captureResponsivenessIdentity,
  canonicalizeJcs,
  classifyProcessAttribution,
  createAccessibilityDriver,
  createScheduledProcessSampler,
  deriveMeasuredLanePayload,
  analyzeInstrumentationOverhead,
  externalAxWorkloadDurationUs,
  formatAccessibilityCommandFailure,
  loadPageComponent,
  publishSampleExclusive,
  runAccessibilitySequence,
  runNativePage,
  runNativeResponsivenessPlan,
  runDataStoreCleanup,
  summarizeProcessSeries,
  selectResponsivenessSuiteDecision,
  syncDirectoryPortable,
  validateDraftActions,
  validateSessionMemoryActions,
  validateHarnessPaths,
  validateFrontendComponents,
  validateScenarioManifest,
  validateProcessSeries,
  waitForRecorderReady,
  waitForActionReady,
  waitForAxActivation,
  waitForAxPreflight,
  waitForRecorderOrFailedPage,
  waitForStartupReady,
} from './responsiveness-baseline.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const uuid = suffix => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
const digest = value => value.repeat(64);
const mountedDraftEntries = () => ({
  [JSON.stringify(['extract', 'TopBar.url'])]: { value: '' },
  [JSON.stringify(['convert', 'ConvertPage.files'])]: { value: [] },
  [JSON.stringify(['convert', 'ConvertPage.pdfs'])]: { value: [] },
  [JSON.stringify(['convert', 'ConvertPage.selectedId'])]: { value: null },
  [JSON.stringify(['convert', 'ConvertActionBar.overrideDir'])]: { value: null },
});
const seededDraftRaw = count => JSON.stringify({
  version: 1,
  entries: {
    ...Object.fromEntries(Array.from({ length: count === 500 ? 495 : count }, (_, index) => [JSON.stringify(['convert', `seed-${index}`, 'TopBar.url']), { value: `seed-value-${index}` }])),
    ...(count === 500 ? mountedDraftEntries() : {}),
  },
});
const finalDraftRaw = raw => {
  const seed = JSON.parse(raw);
  seed.entries[JSON.stringify(['extract', 'TopBar.url'])] = { value: 'https://x.test/a.mp4' };
  return JSON.stringify(seed);
};
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
    add('link', 'Convert', { kind: 'press', ax_prior: { kind: 'element_present' }, completion: { kind: 'attribute_equals', role: 'AXGroup', label: 'Convert', attribute: 'AXEnabled', value: true }, timeout_ms: 2000 }, 'click', '/convert');
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
    add('link', 'Extract', { kind: 'press', ax_prior: { kind: 'element_present' }, completion: { kind: 'attribute_equals', role: 'AXGroup', label: 'Extract', attribute: 'AXEnabled', value: true }, timeout_ms: 2000 }, 'click', '/convert');
    add('link', 'Convert', { kind: 'press', ax_prior: { kind: 'element_present' }, completion: { kind: 'attribute_equals', role: 'AXGroup', label: 'Convert', attribute: 'AXEnabled', value: true }, timeout_ms: 2000 }, 'click', '/extract');
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

test('captured machine identity permits honest Windows hardware unavailability', () => {
  const identity = {
    source: { head: 'a'.repeat(40), tree: 'b'.repeat(40), dirty_digest: digest('c'), dirty: false }, manifest_sha256: digest('d'), bindings_sha256: digest('e'),
    executables: { app: { path: 'C:\\Goop\\goop.exe', sha256: digest('f') } }, sidecars: { runtime: { path: 'C:\\Goop\\ffmpeg.exe', sha256: digest('a'), bytes: 1, version: 'test' } }, parameters: { test: true },
    toolchain: { node: 'test', rustc: 'test', cargo: 'test' }, machine: { platform: 'win32', arch: 'x64', os: 'Windows test', hardware_model: null, power_source: 'unavailable', low_power_mode: 'unavailable', thermal: 'unavailable', disk_available_bytes: '1024' },
  };
  assert.equal(validateCapturedIdentity(identity), identity);
  assert.throws(() => validateCapturedIdentity({ ...identity, machine: { ...identity.machine, hardware_model: 'invented-model' } }), /hardware_model/i);
  assert.throws(() => validateCapturedIdentity({ ...identity, machine: { ...identity.machine, platform: 'darwin' } }), /hardware_model/i);
  assert.throws(() => validateCapturedIdentity({ ...identity, machine: { ...identity.machine, disk_available_bytes: 'unavailable' } }), /disk_available_bytes/i);
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

test('terminal RSS sampling skips a due cadence read before the settlement deadline', () => {
  let now = 0;
  let captures = 0;
  const series = createIdentityAwareProcessSeries({ rootPid: 10, platform: 'darwin' });
  const sampler = createScheduledProcessSampler({
    series,
    nowMs: () => now,
    capture: () => {
      captures += 1;
      if (captures === 2) now += 100;
      return '10\t1\t2026-09-20T10:00:00.000Z\t100\t/goop';
    },
  });
  sampler.start();
  now = 1000;
  sampler.finish(1000);

  const result = series.finish();
  assert.equal(captures, 2);
  assert.equal(result.scheduled_reads, 3);
  assert.equal(result.missed_reads, 1);
  assert.deepEqual(result.snapshots.map(value => value.elapsed_us), [0, 1_100_000]);
});

test('terminal RSS sampling rejects a snapshot completed after the settlement deadline', () => {
  let now = 0;
  let captures = 0;
  const series = createIdentityAwareProcessSeries({ rootPid: 10, platform: 'darwin' });
  const sampler = createScheduledProcessSampler({
    series,
    nowMs: () => now,
    capture: () => {
      captures += 1;
      if (captures === 2) now += 1100;
      return '10\t1\t2026-09-20T10:00:00.000Z\t100\t/goop';
    },
  });
  sampler.start();
  now = 1000;
  assert.throws(() => sampler.finish(1000), /one-second settlement window/i);
  assert.equal(captures, 2);
  assert.throws(() => sampler.finish(now), /not active/i);
  assert.equal(captures, 2);
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
    assert.equal(validateScenarioManifest(manifest).recorderMode, 'enabled');
    assert.equal(validateScenarioManifest({ ...manifest, recorderMode: 'control' }).recorderMode, 'control');
    assert.throws(() => validateScenarioManifest({ ...manifest, recorderMode: 'unknown' }), /recorder mode/i);
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
      return JSON.stringify({ trusted: true, enhanced_user_interface: true, frontmost_pid: 42, modal_count: 0, labels: ['Primary navigation', 'Add files', 'Select fixture.jpg', 'Remove fixture.jpg', 'Paste URL to download'] });
    },
  });
  const result = await driver.preflight(['Primary navigation', 'Add files', 'Select fixture.jpg', 'Remove fixture.jpg', 'Paste URL to download']);
  assert.equal(result.frontmost_pid, 42);
  assert.match(scripts.join('\n'), /unixId:42/);
  assert.match(scripts.join('\n'), /AXEnhancedUserInterface/);
  assert.match(scripts.join('\n'), /NSRunningApplication/);
  assert.match(scripts.join('\n'), /NSApplicationActivateIgnoringOtherApps/);
  assert.match(scripts.join('\n'), /activationDeadline/);
  assert.match(scripts.join('\n'), /while\(Date\.now\(\)<activationDeadline\)/);
  assert.match(scripts.join('\n'), /windows\[0\]\.entireContents\(\)/);
  assert.doesNotMatch(scripts.join('\n'), /app\.entireContents\(\)/);
  assert.doesNotMatch(scripts.join('\n'), /processes\.byName/);
  assert.doesNotMatch(scripts.join('\n'), /position|click at|mouse/i);
  assert.throws(() => createAccessibilityDriver({ platform: 'linux', appName: 'Goop', expectedPid: 1, runScript: async () => '{}' }), /macOS/i);
});

test('AX command failure reports a fixed phase and bounded redacted stderr', () => {
  const failure = formatAccessibilityCommandFailure(
    { code: 1 },
    '/Users/person/private.js: execution error: Error: interrupted before keyboard dispatch for "secret" at https://private.test/item (-2700)\n',
    'action_14_dispatch',
  );
  assert.match(failure.message, /Accessibility action_14_dispatch failed \(exit 1\)/);
  assert.match(failure.message, /interrupted_before_keyboard_dispatch/);
  assert.match(failure.message, /-2700/);
  assert.doesNotMatch(failure.message, /person|private|secret|https:/);
  assert.ok(failure.message.length <= 320);
  assert.equal(formatAccessibilityCommandFailure({ code: 'ETIMEDOUT' }, '', 'preflight').message,
    'Accessibility preflight failed (error ETIMEDOUT)');
  assert.equal(formatAccessibilityCommandFailure({ code: null, signal: 'SIGTERM', killed: true }, '', 'activate').message,
    'Accessibility activate failed (timed out; signal SIGTERM)');
  const unclassified = formatAccessibilityCommandFailure({ code: 1 },
    'execution error: Error: AXValue token abc123 (-2700)', 'read_value');
  assert.match(unclassified.message, /stderr_unclassified/);
  assert.doesNotMatch(unclassified.message, /AXValue|token|abc123/);
  assert.throws(() => formatAccessibilityCommandFailure({ code: 1 }, 'error', 'user supplied phase'), /phase/i);
});

test('AX driver passes fixed phases through every command without changing dispatch', async () => {
  const phases = [];
  const replies = [
    { trusted: true, enhanced_user_interface: true, process_count: 1, frontmost_pid: 42, window_count: 1, main_window: true, minimized: false, raise_supported: true },
    { trusted: true, enhanced_user_interface: true, frontmost_pid: 42, modal_count: 0, labels: [] },
    { frontmost_pid: 42, modal_count: 0, target_count: 1, target_role: 'AXTextField', target_label: 'Paste URL to download', focused_role: 'AXTextField', focused_label: 'Paste URL to download', value: '', value_read: true },
    { frontmost_pid: 42, modal_count: 0, target_count: 1, target_role: 'AXTextField', target_label: 'Paste URL to download', focused_role: 'AXTextField', focused_label: 'Paste URL to download', value: '' },
    { frontmost_pid: 42, modal_count: 0, target_count: 1, target_role: 'AXTextField', target_label: 'Paste URL to download', focused_role: 'AXTextField', focused_label: 'Paste URL to download', value: 'h', done: true, driver_duration_us: 100 },
    { frontmost_pid: 42, modal_count: 0, target_count: 1, target_role: 'AXTextField', target_label: 'Paste URL to download', value: 'h' },
    { frontmost_pid: 42, quit_requested: true },
  ];
  const driver = createAccessibilityDriver({ platform: 'darwin', appName: 'Goop', expectedPid: 42,
    runScript: async (_script, _timeout, phase) => { phases.push(phase); return JSON.stringify(replies.shift()); } });
  await driver.activate();
  await driver.preflight([]);
  await driver.focus({ role: 'textbox', label: 'Paste URL to download', expected_value: '' });
  await driver.perform({ ordinal: 14, kind: 'keystroke', role: 'textbox', label: 'Paste URL to download', text: 'h', expected_prior_value: '', completion: { kind: 'attribute_equals', attribute: 'AXValue', value: 'h' }, timeout_ms: 2000 });
  await driver.readValue({ role: 'textbox', label: 'Paste URL to download' });
  await driver.quit();
  assert.deepEqual(phases, ['activate', 'preflight', 'focus', 'action_14_check', 'action_14_dispatch', 'read_value', 'quit']);
});

test('AX completion timeout reports the action and redacted observed value without changing dispatch', async () => {
  const observed = 'https://private.test/item';
  const expected = 'https://private.test/item-next';
  const scripts = [];
  const replies = [
    { frontmost_pid: 42, modal_count: 0, target_count: 1, target_role: 'AXTextField', target_label: 'Paste URL to download', focused_role: 'AXTextField', focused_label: 'Paste URL to download', value: '' },
    { frontmost_pid: 42, modal_count: 0, target_count: 1, target_role: 'AXTextField', target_label: 'Paste URL to download', focused_role: 'AXTextField', focused_label: 'Paste URL to download', value: observed, done: false, driver_duration_us: 2000 },
  ];
  const driver = createAccessibilityDriver({ platform: 'darwin', appName: 'Goop', expectedPid: 42,
    runScript: async (script, _timeout, phase) => { scripts.push({ script, phase }); return JSON.stringify(replies.shift()); } });
  const action = { ordinal: 14, kind: 'keystroke', role: 'textbox', label: 'Paste URL to download', text: 'x', expected_prior_value: '', completion: { kind: 'attribute_equals', attribute: 'AXValue', value: expected }, timeout_ms: 2000 };
  await assert.rejects(() => driver.perform(action), error => {
    assert.match(error.message, /Accessibility completion predicate timed out \(action 14; attribute_equals/);
    assert.match(error.message, new RegExp(`observed_json_bytes=${Buffer.byteLength(JSON.stringify(observed))}`));
    assert.match(error.message, new RegExp(`observed_sha256=${hash(JSON.stringify(observed))}`));
    assert.match(error.message, new RegExp(`expected_json_bytes=${Buffer.byteLength(JSON.stringify(expected))}`));
    assert.match(error.message, new RegExp(`expected_sha256=${hash(JSON.stringify(expected))}`));
    assert.doesNotMatch(error.message, /private|https:|item-next/);
    assert.ok(error.message.length <= 320);
    return true;
  });
  assert.deepEqual(scripts.map(({ phase }) => phase), ['action_14_check', 'action_14_dispatch']);
  assert.match(scripts[1].script, /se\.keystroke\("x"\)/);
});

test('AX element-absence timeout reports only its action and observed count', async () => {
  const replies = [
    { frontmost_pid: 42, modal_count: 0, target_count: 1, target_role: 'AXButton', target_label: 'Remove fixture.jpg', focused_role: null, focused_label: null, value: true },
    { frontmost_pid: 42, modal_count: 0, target_count: 1, target_role: 'AXButton', target_label: 'Remove fixture.jpg', focused_role: null, focused_label: null, value: 2, done: false, driver_duration_us: 2000 },
  ];
  const driver = createAccessibilityDriver({ platform: 'darwin', appName: 'Goop', expectedPid: 42, runScript: async () => JSON.stringify(replies.shift()) });
  await assert.rejects(() => driver.perform({ ordinal: 17, kind: 'press', role: 'button', label: 'Remove fixture.jpg', completion: { kind: 'element_absent', role: 'button', label: 'Remove fixture.jpg' }, timeout_ms: 2000 }), error => {
    assert.equal(error.message, 'Accessibility completion predicate timed out (action 17; element_absent; observed_count=2)');
    return true;
  });
});

test('AX driver activates, raises, and verifies the exact launched main window without coordinates', async () => {
  const scripts = [];
  const driver = createAccessibilityDriver({
    platform: 'darwin',
    appName: 'Goop',
    expectedPid: 42,
    runScript: async script => {
      scripts.push(script);
      return JSON.stringify({
        trusted: true, enhanced_user_interface: true, process_count: 1,
        frontmost_pid: 42, window_count: 1, main_window: true,
        minimized: false, raise_supported: true,
      });
    },
  });

  const result = await driver.activate();

  assert.equal(result.frontmost_pid, 42);
  assert.match(scripts[0], /frontmost=true/);
  assert.match(scripts[0], /AXMinimized/);
  assert.match(scripts[0], /AXRaise/);
  assert.match(scripts[0], /AXMain/);
  assert.doesNotMatch(scripts[0], /position|click at|mouse/i);
});

test('AX activation fails closed unless the exact launched process owns one raised unminimized main window', async () => {
  const valid = { trusted: true, enhanced_user_interface: true, process_count: 1, frontmost_pid: 42, window_count: 1, main_window: true, minimized: false, raise_supported: true };
  for (const [override, pattern] of [
    [{ process_count: 0 }, /process.*not ready/i],
    [{ frontmost_pid: 99 }, /frontmost/i],
    [{ window_count: 2 }, /main window.*not ready/i],
    [{ main_window: false }, /main window.*not ready/i],
    [{ minimized: true }, /minimized/i],
    [{ raise_supported: false }, /AXRaise/i],
  ]) {
    const driver = createAccessibilityDriver({ platform: 'darwin', appName: 'Goop', expectedPid: 42, runScript: async () => JSON.stringify({ ...valid, ...override }) });
    await assert.rejects(() => driver.activate(), pattern);
  }
});

test('AX driver focuses one exact launched-process text field and verifies its prior value without coordinates', async () => {
  const scripts = [];
  const driver = createAccessibilityDriver({
    platform: 'darwin', appName: 'Goop', expectedPid: 42,
    runScript: async script => {
      scripts.push(script);
      return JSON.stringify({ frontmost_pid: 42, modal_count: 0, target_count: 1, target_role: 'AXTextField', target_label: 'Paste URL to download', focused_role: 'AXTextField', focused_label: 'Paste URL to download', value: '', value_read: true });
    },
  });
  const result = await driver.focus({ role: 'textbox', label: 'Paste URL to download', expected_value: '' });
  assert.equal(result.focused_label, 'Paste URL to download');
  assert.match(scripts[0], /unixId:42/);
  assert.doesNotMatch(scripts[0], /target\.click\(\)|AXPress/);
  assert.match(scripts[0], /frontmost=true/);
  assert.match(scripts[0], /AXRaise/);
  assert.match(scripts[0], /NSRunningApplication/);
  assert.match(scripts[0], /NSApplicationActivateIgnoringOtherApps/);
  assert.match(scripts[0], /AXFocused/);
  assert.match(scripts[0], /focusDeadline=Date\.now\(\)\+500/);
  assert.doesNotMatch(scripts[0], /position|click at|mouse/i);

  const valid = { frontmost_pid: 42, modal_count: 0, target_count: 1, target_role: 'AXTextField', target_label: 'Paste URL to download', focused_role: 'AXTextField', focused_label: 'Paste URL to download', value: '', value_read: true };
  for (const [override, pattern] of [
    [{ frontmost_pid: 99 }, /focus was lost/i],
    [{ modal_count: 1 }, /modal dialog/i],
    [{ target_count: 0, target_role: null, target_label: null }, /exactly one/i],
    [{ target_count: 2 }, /exactly one/i],
    [{ focused_role: null, focused_label: null }, /did not focus/i],
    [{ value_read: false }, /could not read/i],
    [{ value: 'unexpected' }, /unexpected prior value/i],
  ]) {
    const invalid = createAccessibilityDriver({ platform: 'darwin', appName: 'Goop', expectedPid: 42, runScript: async () => JSON.stringify({ ...valid, ...override }) });
    await assert.rejects(() => invalid.focus({ role: 'textbox', label: 'Paste URL to download', expected_value: '' }), pattern);
  }
});

test('AX activation retries only while the exact process or main window is still mounting', async () => {
  let attempts = 0;
  const driver = {
    activate: async () => {
      attempts += 1;
      if (attempts === 1) throw Error('Accessibility main window is not ready');
      return { frontmost_pid: 42, window_count: 1 };
    },
  };
  assert.deepEqual(await waitForAxActivation(driver, { timeoutMs: 100, pollMs: 1 }), { frontmost_pid: 42, window_count: 1 });
  assert.equal(attempts, 2);
  await assert.rejects(() => waitForAxActivation({ activate: async () => { throw Error('Accessibility permission is not granted'); } }, { timeoutMs: 100, pollMs: 1 }), /permission/i);
});

test('AX driver fails closed on permission, focus, modal, and missing labels', async () => {
  for (const [payload, pattern] of [
    [{ trusted: false, enhanced_user_interface: true, frontmost_pid: 42, modal_count: 0, labels: [] }, /permission/i],
    [{ trusted: true, enhanced_user_interface: false, frontmost_pid: 42, modal_count: 0, labels: [] }, /enhanced user interface/i],
    [{ trusted: true, enhanced_user_interface: true, frontmost_pid: 99, modal_count: 0, labels: [] }, /frontmost/i],
    [{ trusted: true, enhanced_user_interface: true, frontmost_pid: 42, modal_count: 1, labels: [] }, /modal/i],
    [{ trusted: true, enhanced_user_interface: true, frontmost_pid: 42, modal_count: 0, labels: [] }, /label/i],
  ]) {
    const driver = createAccessibilityDriver({ platform: 'darwin', appName: 'Goop', expectedPid: 42, runScript: async () => JSON.stringify(payload) });
    await assert.rejects(() => driver.preflight(['Primary navigation']), pattern);
  }
});

test('driver revalidates focus before every action and validates the focused target', async () => {
  const scripts = [];
  const timeouts = [];
  const replies = [
    { trusted: true, frontmost_pid: 42, modal_count: 0, target_count: 1, target_role: 'AXTextField', target_label: 'Paste URL to download', focused_role: 'AXTextField', focused_label: 'Paste URL to download' },
    { trusted: true, frontmost_pid: 42, modal_count: 0, target_count: 1, target_role: 'AXTextField', target_label: 'Paste URL to download', focused_role: 'AXTextField', focused_label: 'Paste URL to download', value: 'h', driver_duration_us: 100 },
  ];
  const driver = createAccessibilityDriver({ platform: 'darwin', appName: 'Goop', expectedPid: 42, runScript: async (script, timeoutMs) => { scripts.push(script); timeouts.push(timeoutMs); return JSON.stringify(replies.shift()); } });
  const result = await driver.perform({ ordinal: 1, kind: 'keystroke', role: 'AXTextField', label: 'Paste URL to download', text: 'h', expected_prior_value: '', completion: { kind: 'attribute_equals', attribute: 'AXValue', value: 'h' }, timeout_ms: 2000 });
  assert.equal(result.ordinal, 1);
  assert.equal(scripts.length, 2);
  assert.match(scripts.join('\n'), /const processMatches=/);
  assert.equal(scripts.filter(script => script.includes("attributes.byName('AXFocused').value=true")).length, 2);
  assert.equal(scripts.filter(script => script.includes('focusDeadline=Date.now()+500')).length, 2);
  assert.equal(scripts.filter(script => script.includes('NSApplicationActivateIgnoringOtherApps')).length, 2);
  assert.equal(scripts.filter(script => script.includes('activationDeadline')).length, 2);
  const dispatchScript = scripts[1];
  assert.ok(dispatchScript.indexOf('focusDeadline=Date.now()+500') < dispatchScript.indexOf('const dispatchFront='));
  assert.ok(dispatchScript.indexOf('const dispatchFront=') < dispatchScript.indexOf('const dispatchStart='));
  assert.ok(dispatchScript.indexOf('const dispatchStart=') < dispatchScript.indexOf('se.keystroke("h")'));
  assert.match(dispatchScript, /dispatchFocused\.role\(\)!=="AXTextField"/);
  assert.match(dispatchScript, /dispatchFocused\.name\(\)!=="Paste URL to download"/);
  assert.doesNotMatch(scripts.join('\n'), /const matches=se\.processes/);
  assert.match(scripts.join('\n'), /windows\[0\]\.entireContents\(\)/);
  assert.doesNotMatch(scripts.join('\n'), /app\.entireContents\(\)/);
  assert.deepEqual(timeouts, [5_000, 7_000]);
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
    const binary = process.execPath;
    const fakeApp = join(root, 'fake-app.cjs');
    writeFileSync(fakeApp, `const fs=require('node:fs');const path=require('node:path');const value=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));value.pid=process.pid;fs.writeFileSync(path.join(process.env.GOOP_RESPONSIVENESS_REPORT_DIR,'frontend-'+value.component_role+'-'+value.page_instance_id+'.json'),JSON.stringify(value),{flag:'wx'});setInterval(()=>{},1000);\n`);
    const manifest = {
      schema_version: 2, token: 'pre-ready-token', ...activationFields(),
      descriptor: { componentRole: 'primary', sessionId: component.session_id, sampleId: component.sample_id, pageInstanceId: component.page_instance_id, lane: 'inspection', scenario: { id: component.scenario?.id ?? component.frontend_trace.scenario.id, manifestSha256: component.frontend_trace.scenario.manifest_sha256 }, workload: component.frontend_trace.workload, phase: 'measured', repetition: 0 },
      actions: [{ actionId: 1, targetId: 'never-dispatched', eventType: 'click', targetRole: 'button', accessibleName: 'Never dispatch', expectedPriorValue: 'false' }],
    };
    component.sample_id = manifest.descriptor.sampleId; component.session_id = manifest.descriptor.sessionId; component.page_instance_id = manifest.descriptor.pageInstanceId;
    const manifestPath = join(root, 'manifest.json'); writeFileSync(manifestPath, JSON.stringify(manifest));
    let captureCalls = 0;
    const result = await runNativePage({
      plan: { binary, app_name: 'Goop', app_data_directory: profile, component_directory: report, limits: { log_limit_bytes: 4096, storage_budget_bytes: 1024 * 1024 } },
      page: { manifest_path: manifestPath, argv: [fakeApp, template], required_labels: ['Never dispatch'], actions: [{ ...manifest.actions[0], dispatch: { kind: 'press', completion: { kind: 'attribute_equals', attribute: 'AXSelected', value: true }, timeout_ms: 2000 } }], timeout_ms: 10_000 },
      manifest, platform: 'darwin',
    }, {
      createDriver: () => ({ activate: async () => ({ frontmost_pid: 42, window_count: 1 }), perform: async () => { throw Error('must not dispatch'); } }),
      captureSnapshot: (snapshotPlatform, rootPid) => {
        captureCalls += 1;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
        return snapshotPlatform === 'win32'
          ? JSON.stringify([{ ProcessId: rootPid, ParentProcessId: 4, CreationDate: '2026-09-20T10:00:00.000Z', ExecutablePath: 'C:\\Goop\\goop.exe', WorkingSetSize: 102400 }])
          : `${rootPid}\t1\t2026-09-20T10:00:00.000Z\t100\t/goop`;
      },
    });
    assert.equal(result.page_component.frontend_trace.failure.code, 'observer_init');
    assert.deepEqual(result.driver_observations, []);
    assert.ok(result.process_series.identities.length >= 1);
    assert.equal(result.process_series.scheduled_reads, 1);
    assert.equal(result.process_series.snapshots.length, 1);
    assert.equal(captureCalls, 1);
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

test('failed focus setup prevents keyboard dispatch and process sampling', async () => {
  const order = [];
  const actions = [{ actionId: 1, targetRole: 'textbox', accessibleName: 'Paste URL to download', expectedPriorValue: '', dispatch: { kind: 'keystroke', text: 'h', completion: { kind: 'attribute_equals', attribute: 'AXValue', value: 'h' }, timeout_ms: 2000 } }];
  await assert.rejects(() => runAccessibilitySequence({
    driver: { perform: async () => { order.push('dispatch'); } }, actions, reportDirectory: '/tmp/reports',
    identity: { session_id: uuid('1'), sample_id: 'sample', page_instance_id: uuid('2'), pid: 42 },
    waitRecorder: async () => { order.push('ready'); },
    afterRecorderReady: async () => { order.push('focus'); throw Error('Accessibility focus setup did not focus the manifest target'); },
    beforeFirstAction: async () => { order.push('sampling'); },
  }), /did not focus/i);
  assert.deepEqual(order, ['ready', 'focus']);
});

test('recorder-disabled control sequence waits for control readiness and never consumes action-ready markers', async () => {
  const order = [];
  const driver = { perform: async action => { order.push(`dispatch-${action.ordinal}`); return { ordinal: action.ordinal, driver_duration_us: action.ordinal * 10, observed_value: true, clock_domain: 'driver_monotonic' }; } };
  const plan = [
    { actionId: 1, targetRole: 'AXTextField', accessibleName: 'Paste URL to download', dispatch: { kind: 'keystroke', text: 'h', completion: { kind: 'attribute_equals', attribute: 'AXValue', value: 'h' }, timeout_ms: 2000 } },
    { actionId: 2, targetRole: 'AXTextField', accessibleName: 'Paste URL to download', dispatch: { kind: 'keystroke', text: 't', completion: { kind: 'attribute_equals', attribute: 'AXValue', value: 'ht' }, timeout_ms: 2000 } },
  ];
  const observations = await runAccessibilitySequence({
    driver, actions: plan, recorderMode: 'control', reportDirectory: '/tmp/reports',
    identity: { session_id: uuid('1'), sample_id: 'sample', page_instance_id: uuid('2'), pid: 42 },
    waitRecorder: async (path, expected) => { order.push('control-ready'); assert.match(path, /control-ready-/); assert.equal(expected.component_kind, 'control_ready'); assert.equal(expected.action_id, null); return expected; },
    waitAction: async () => { throw Error('control sequence must not read action-ready markers'); },
    afterRecorderReady: async () => { order.push('setup'); },
  });
  assert.deepEqual(order, ['control-ready', 'setup', 'dispatch-1', 'dispatch-2']);
  assert.equal(externalAxWorkloadDurationUs(observations, 2), 30);
  assert.throws(() => externalAxWorkloadDurationUs(observations.slice(0, 1), 2), /cardinality/i);
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

test('Lane 2 validator requires the exact 20-character draft-edit workload', () => {
  let cumulative = '';
  const actions = [...'https://x.test/a.mp4'].map((character, index) => {
    const prior = cumulative;
    cumulative += character;
    return {
      actionId: index + 1, targetId: `draft-key-${index + 1}`, eventType: 'input', targetRole: 'textbox', accessibleName: 'Paste URL to download', expectedPriorValue: prior,
      dispatch: { kind: 'keystroke', text: character, ax_prior: { kind: 'attribute_equals', attribute: 'AXValue', value: prior }, completion: { kind: 'attribute_equals', attribute: 'AXValue', value: cumulative }, timeout_ms: 2000 },
    };
  });
  const facts = { seeded_entries: 500, mutation_count: 20 };
  assert.equal(validateDraftActions(actions, facts, 'https://x.test/a.mp4').length, 20);
  for (const [mutate, pattern] of [
    [action => { action.targetRole = 'button'; }, /Lane 3 action|Lane 2/i],
    [action => { action.dispatch.text = 'z'; }, /typed URL/i],
    [action => { action.expectedPriorValue = 'spoofed'; }, /prior value/i],
    [action => { action.dispatch.completion.value = 'spoofed'; }, /completion predicate/i],
    [action => { action.dispatch.timeout_ms = 1999; }, /Lane 3 action|Lane 2/i],
  ]) {
    const malformed = structuredClone(actions);
    mutate(malformed[0]);
    assert.throws(() => validateDraftActions(malformed, facts, 'https://x.test/a.mp4'), pattern);
  }
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

test('measured payload derivation replaces caller-supplied inspection facts with trace and driver evidence', () => {
  const component = frontend({ lane: 'inspection' });
  component.actions = [
    { action_id: 1, target_id: 'select-fixture-1', state: 'settled', armed_us: 90, active_us: 100, terminal_us: 240 },
    { action_id: 2, target_id: 'remove-fixture-2', state: 'settled', armed_us: 251, active_us: 260, terminal_us: 330 },
  ];
  component.setups = [
    { setup_id: 1, target_id: 'fixture-1', state: 'settled', start_us: 1, terminal_us: 220 },
    { setup_id: 2, target_id: 'fixture-2', state: 'cancelled', start_us: 2, terminal_us: 320 },
  ];
  const event = (event_seq, owner, kind, at_us, subject_id = null, span_id = null) => ({ event_seq, owner, span_id, kind, at_us, subject_id, correlation_id: null });
  component.events = [
    event(1, { kind: 'setup', setup_id: 1 }, 'inspection_queued', 1, 'fixture-1', 1),
    event(2, { kind: 'setup', setup_id: 2 }, 'inspection_queued', 2, 'fixture-2', 2),
    event(3, { kind: 'setup', setup_id: 1 }, 'inspection_started', 10, 'fixture-1', 3),
    event(4, { kind: 'setup', setup_id: 1 }, 'inspection_settled', 200, 'fixture-1', 3),
    event(5, { kind: 'setup', setup_id: 1 }, 'inspection_delivered', 220, 'fixture-1', 4),
    event(6, { kind: 'setup', setup_id: 2 }, 'inspection_started', 230, 'fixture-2', 5),
    event(7, { kind: 'action', action_id: 1 }, 'double_raf', 240),
    event(8, { kind: 'setup', setup_id: 2 }, 'inspection_cancelled', 320, 'fixture-2', 5),
  ];
  component.spans = [
    { span_id: 1, owner: { kind: 'setup', setup_id: 1 }, parent_span_id: null, kind: 'inspection_queue', subject_id: 'fixture-1', start_us: 1, end_us: 10, terminal: 'ended', terminal_cause_action_id: null },
    { span_id: 2, owner: { kind: 'setup', setup_id: 2 }, parent_span_id: null, kind: 'inspection_queue', subject_id: 'fixture-2', start_us: 2, end_us: 230, terminal: 'ended', terminal_cause_action_id: null },
    { span_id: 3, owner: { kind: 'setup', setup_id: 1 }, parent_span_id: null, kind: 'inspection_native', subject_id: 'fixture-1', start_us: 10, end_us: 200, terminal: 'ended', terminal_cause_action_id: null },
    { span_id: 4, owner: { kind: 'setup', setup_id: 1 }, parent_span_id: null, kind: 'inspection_delivery', subject_id: 'fixture-1', start_us: 200, end_us: 220, terminal: 'ended', terminal_cause_action_id: null },
    { span_id: 5, owner: { kind: 'setup', setup_id: 2 }, parent_span_id: null, kind: 'inspection_native', subject_id: 'fixture-2', start_us: 230, end_us: 320, terminal: 'cancelled', terminal_cause_action_id: null },
  ];
  const declared = {
    fixture_ids: ['fixture-1', 'fixture-2'], queue_order: [], start_order: [], settle_order: [], deliver_order: [], cancel_order: [],
    maximum_concurrency: 99, first_ready_us: 0, last_nonretired_ready_us: 0, all_terminal_us: 0,
    selected_fixture_id: 'fixture-1', retired_fixture_id: 'fixture-2', external_selection_duration_us: 0, interaction_to_double_raf_us: 0,
  };
  const fixtureSources = [{ id: 'fixture-1', basename: 'one.jpg' }, { id: 'fixture-2', basename: 'two.jpg' }];
  const actual = deriveMeasuredLanePayload({
    lane: 'inspection', declared, manifests: [{ descriptor: { workload: { facts: { source_count: 2 } } } }], fixtureSources, frontendComponents: [component],
    plannedActions: [
      { actionId: 1, targetRole: 'button', accessibleName: 'Select one.jpg' },
      { actionId: 2, targetRole: 'button', accessibleName: 'Remove two.jpg' },
    ],
    driverObservations: [
      { ordinal: 1, driver_duration_us: 75, observed_value: true, clock_domain: 'driver_monotonic' },
      { ordinal: 2, driver_duration_us: 80, observed_value: false, clock_domain: 'driver_monotonic' },
    ], processSeries: [],
  });
  assert.deepEqual(actual.queue_order, ['fixture-1', 'fixture-2']);
  assert.deepEqual(actual.deliver_order, ['fixture-1']);
  assert.deepEqual(actual.cancel_order, ['fixture-2']);
  assert.equal(actual.maximum_concurrency, 1);
  assert.equal(actual.first_ready_us, 220);
  assert.equal(actual.last_nonretired_ready_us, 220);
  assert.equal(actual.all_terminal_us, 320);
  assert.equal(actual.external_selection_duration_us, 75);
  assert.equal(actual.interaction_to_double_raf_us, 140);
  assert.throws(() => deriveMeasuredLanePayload({
    lane: 'inspection', declared, manifests: [{ descriptor: { workload: { facts: { source_count: 2 } } } }], fixtureSources: [{ id: 'fixture-x', basename: 'one.jpg' }, { id: 'fixture-y', basename: 'two.jpg' }], frontendComponents: [component],
    plannedActions: [
      { actionId: 1, targetRole: 'button', accessibleName: 'Select one.jpg' },
      { actionId: 2, targetRole: 'button', accessibleName: 'Remove two.jpg' },
    ],
    driverObservations: [
      { ordinal: 1, driver_duration_us: 75, observed_value: true, clock_domain: 'driver_monotonic' },
      { ordinal: 2, driver_duration_us: 80, observed_value: false, clock_domain: 'driver_monotonic' },
    ], processSeries: [],
  }), /fixture identities/i);
  for (const plannedActions of [
    [{ actionId: 1, targetRole: 'button', accessibleName: 'Select wrong.jpg' }, { actionId: 2, targetRole: 'button', accessibleName: 'Remove two.jpg' }],
    [{ actionId: 1, targetRole: 'button', accessibleName: 'Select one.jpg' }, { actionId: 2, targetRole: 'button', accessibleName: 'Remove wrong.jpg' }],
  ]) assert.throws(() => deriveMeasuredLanePayload({
    lane: 'inspection', declared, manifests: [{ descriptor: { workload: { facts: { source_count: 2 } } } }], fixtureSources, frontendComponents: [component], plannedActions,
    driverObservations: [
      { ordinal: 1, driver_duration_us: 75, observed_value: true, clock_domain: 'driver_monotonic' },
      { ordinal: 2, driver_duration_us: 80, observed_value: false, clock_domain: 'driver_monotonic' },
    ], processSeries: [],
  }), /frozen fixture manifest/i);

  for (const mutate of [
    value => { value.events = value.events.filter(eventValue => eventValue.kind !== 'inspection_started'); },
    value => { value.events.push(event(9, { kind: 'setup', setup_id: 1 }, 'inspection_started', 11, 'fixture-1')); },
    value => { value.spans[0].subject_id = 'fixture-x'; },
  ]) {
    const invalidStart = structuredClone(component);
    mutate(invalidStart);
    assert.throws(() => deriveMeasuredLanePayload({
      lane: 'inspection', declared, manifests: [{ descriptor: { workload: { facts: { source_count: 2 } } } }], fixtureSources, frontendComponents: [invalidStart],
      plannedActions: [
        { actionId: 1, targetRole: 'button', accessibleName: 'Select one.jpg' },
        { actionId: 2, targetRole: 'button', accessibleName: 'Remove two.jpg' },
      ],
      driverObservations: [
        { ordinal: 1, driver_duration_us: 75, observed_value: true, clock_domain: 'driver_monotonic' },
        { ordinal: 2, driver_duration_us: 80, observed_value: false, clock_domain: 'driver_monotonic' },
      ], processSeries: [],
    }), /scheduler evidence|contract/i);
  }

  const overlapping = structuredClone(component);
  overlapping.spans[4].start_us = 20;
  assert.throws(() => deriveMeasuredLanePayload({
    lane: 'inspection', declared, manifests: [{ descriptor: { workload: { facts: { source_count: 2 } } } }], fixtureSources, frontendComponents: [overlapping],
    plannedActions: [
      { actionId: 1, targetRole: 'button', accessibleName: 'Select one.jpg' },
      { actionId: 2, targetRole: 'button', accessibleName: 'Remove two.jpg' },
    ],
    driverObservations: [
      { ordinal: 1, driver_duration_us: 75, observed_value: true, clock_domain: 'driver_monotonic' },
      { ordinal: 2, driver_duration_us: 80, observed_value: false, clock_domain: 'driver_monotonic' },
    ], processSeries: [],
  }), /single-concurrency/i);

  const retiredDelivered = structuredClone(component);
  retiredDelivered.events.splice(7, 0, event(8, { kind: 'setup', setup_id: 2 }, 'inspection_delivered', 319, 'fixture-2'));
  retiredDelivered.events[8].event_seq = 9;
  assert.throws(() => deriveMeasuredLanePayload({
    lane: 'inspection', declared, manifests: [{ descriptor: { workload: { facts: { source_count: 2 } } } }], fixtureSources, frontendComponents: [retiredDelivered],
    plannedActions: [
      { actionId: 1, targetRole: 'button', accessibleName: 'Select one.jpg' },
      { actionId: 2, targetRole: 'button', accessibleName: 'Remove two.jpg' },
    ],
    driverObservations: [
      { ordinal: 1, driver_duration_us: 75, observed_value: true, clock_domain: 'driver_monotonic' },
      { ordinal: 2, driver_duration_us: 80, observed_value: false, clock_domain: 'driver_monotonic' },
    ], processSeries: [],
  }), /retirement|contract/i);

  const missedOverlap = structuredClone(component);
  missedOverlap.actions[0].active_us = 221;
  missedOverlap.spans[1].end_us = 250;
  missedOverlap.spans[4].start_us = 250;
  missedOverlap.events.find(eventValue => eventValue.kind === 'inspection_started' && eventValue.subject_id === 'fixture-2').at_us = 250;
  assert.throws(() => deriveMeasuredLanePayload({
    lane: 'inspection', declared, manifests: [{ descriptor: { workload: { facts: { source_count: 2 } } } }], fixtureSources, frontendComponents: [missedOverlap],
    plannedActions: [
      { actionId: 1, targetRole: 'button', accessibleName: 'Select one.jpg' },
      { actionId: 2, targetRole: 'button', accessibleName: 'Remove two.jpg' },
    ],
    driverObservations: [
      { ordinal: 1, driver_duration_us: 75, observed_value: true, clock_domain: 'driver_monotonic' },
      { ordinal: 2, driver_duration_us: 80, observed_value: false, clock_domain: 'driver_monotonic' },
    ], processSeries: [],
  }), /overlap/i);

  const wrongRaf = structuredClone(component);
  wrongRaf.events.find(eventValue => eventValue.kind === 'double_raf').at_us = 239;
  assert.throws(() => deriveMeasuredLanePayload({
    lane: 'inspection', declared, manifests: [{ descriptor: { workload: { facts: { source_count: 2 } } } }], fixtureSources, frontendComponents: [wrongRaf],
    plannedActions: [
      { actionId: 1, targetRole: 'button', accessibleName: 'Select one.jpg' },
      { actionId: 2, targetRole: 'button', accessibleName: 'Remove two.jpg' },
    ],
    driverObservations: [
      { ordinal: 1, driver_duration_us: 75, observed_value: true, clock_domain: 'driver_monotonic' },
      { ordinal: 2, driver_duration_us: 80, observed_value: false, clock_domain: 'driver_monotonic' },
    ], processSeries: [],
  }), /timing/i);

  for (const mutate of [
    value => { value.events.find(eventValue => eventValue.kind === 'inspection_delivered').owner.setup_id = 2; },
    value => { value.events.find(eventValue => eventValue.kind === 'inspection_delivered').at_us = 190; },
    value => { value.spans.find(span => span.kind === 'inspection_native' && span.subject_id === 'fixture-2').terminal_cause_action_id = 1; },
    value => { value.spans.find(span => span.kind === 'inspection_native' && span.subject_id === 'fixture-2').terminal_cause_action_id = 2; },
  ]) {
    const invalidLifecycle = structuredClone(component);
    mutate(invalidLifecycle);
    assert.throws(() => deriveMeasuredLanePayload({
      lane: 'inspection', declared, manifests: [{ descriptor: { workload: { facts: { source_count: 2 } } } }], fixtureSources, frontendComponents: [invalidLifecycle],
      plannedActions: [
        { actionId: 1, targetRole: 'button', accessibleName: 'Select one.jpg' },
        { actionId: 2, targetRole: 'button', accessibleName: 'Remove two.jpg' },
      ],
      driverObservations: [
        { ordinal: 1, driver_duration_us: 75, observed_value: true, clock_domain: 'driver_monotonic' },
        { ordinal: 2, driver_duration_us: 80, observed_value: false, clock_domain: 'driver_monotonic' },
      ], processSeries: [],
    }), /scheduler evidence|contract/i);
  }
});

test('measured payload derivation derives draft spans and exact Lane 3 cycle summaries', () => {
  const draft = frontend({ lane: 'draft', role: 'pre_quit' });
  draft.actions = Array.from({ length: 20 }, (_, index) => ({ action_id: index + 1, target_id: `key-${index + 1}`, state: 'settled', armed_us: index * 10, active_us: index * 10 + 1, terminal_us: index * 10 + 9 }));
  const persistenceSetups = Array.from({ length: 20 }, (_, index) => ({ setup_id: index + 1, target_id: 'workspace_drafts', state: 'settled', start_us: index * 10 + 2, terminal_us: index * 10 + 7 }));
  draft.setups = [...persistenceSetups, { setup_id: 21, target_id: 'draft_completion', state: 'settled', start_us: 200, terminal_us: 201 }];
  draft.spans = persistenceSetups.flatMap((setup, index) => [
    { span_id: index * 2 + 1, owner: { kind: 'setup', setup_id: setup.setup_id }, parent_span_id: null, kind: 'draft_encode', subject_id: 'workspace_drafts', start_us: index * 10 + 2, end_us: index * 10 + 3, terminal: 'ended', terminal_cause_action_id: null },
    { span_id: index * 2 + 2, owner: { kind: 'setup', setup_id: setup.setup_id }, parent_span_id: null, kind: 'storage_write', subject_id: 'workspace_drafts', start_us: index * 10 + 4, end_us: index * 10 + 5, terminal: 'ended', terminal_cause_action_id: null },
  ]);
  draft.events = [{ event_seq: 1, owner: { kind: 'setup', setup_id: 21 }, span_id: null, kind: 'persistence_settled', at_us: 200, subject_id: 'draft_sha256', correlation_id: digest('a') }];
  const recovered = frontend({ lane: 'draft', role: 'recovery', page: uuid('3') });
  const seedRaw = seededDraftRaw(500);
  const draftManifests = [
    { descriptor: { componentRole: 'pre_quit', workload: { facts: { seeded_entries: 500 } } }, bootstrap: { draftStorage: { raw: seedRaw } } },
    { descriptor: { componentRole: 'recovery' }, completion: { expectedDraftSha256: digest('a'), expectedAxValue: 'https://x.test/a.mp4' } },
  ];
  const draftPayload = deriveMeasuredLanePayload({
    lane: 'draft', declared: { seed_entry_count: 999, seed_byte_count: 999, action_summaries: [], encode_span_ids: [], storage_span_ids: [], logical_persistence_acknowledged: false, expected_draft_sha256: digest('c'), recovered_draft_sha256: digest('a'), expected_ax_value: 'spoofed', recovered_ax_value: 'https://x.test/a.mp4' }, manifests: draftManifests,
    frontendComponents: [draft, recovered], driverObservations: [], processSeries: [],
  });
  assert.equal(draftPayload.seed_entry_count, 500);
  assert.equal(draftPayload.seed_byte_count, Buffer.byteLength(seedRaw));
  assert.equal(draftPayload.expected_draft_sha256, digest('a'));
  assert.equal(draftPayload.expected_ax_value, 'https://x.test/a.mp4');
  assert.deepEqual(draftPayload.action_summaries, Array.from({ length: 20 }, (_, index) => ({ action_id: index + 1 })));
  assert.deepEqual(draftPayload.encode_span_ids, Array.from({ length: 20 }, (_, index) => index * 2 + 1));
  assert.deepEqual(draftPayload.storage_span_ids, Array.from({ length: 20 }, (_, index) => index * 2 + 2));
  assert.equal(draftPayload.logical_persistence_acknowledged, true);
  for (const count of [1, 100]) {
    const smaller = structuredClone(draftManifests);
    smaller[0].descriptor.workload.facts.seeded_entries = count;
    smaller[0].bootstrap.draftStorage.raw = seededDraftRaw(count);
    const result = deriveMeasuredLanePayload({
      lane: 'draft', declared: draftPayload, manifests: smaller, frontendComponents: [draft, recovered], driverObservations: [], processSeries: [],
    });
    assert.equal(result.seed_entry_count, count);
  }

  const mismatchedSeed = structuredClone(draftManifests);
  mismatchedSeed[0].descriptor.workload.facts.seeded_entries = 100;
  assert.throws(() => deriveMeasuredLanePayload({
    lane: 'draft', declared: draftPayload, manifests: mismatchedSeed, frontendComponents: [draft, recovered], driverObservations: [], processSeries: [],
  }), /seeded entry count/i);
  const invalidSeed = structuredClone(draftManifests);
  const invalidEntries = JSON.parse(seedRaw);
  delete invalidEntries.entries[JSON.stringify(['convert', 'seed-0', 'TopBar.url'])];
  invalidEntries.entries[JSON.stringify(['bogus', 'seed-0', 'bogus-slot'])] = { value: [] };
  invalidSeed[0].bootstrap.draftStorage.raw = JSON.stringify(invalidEntries);
  assert.throws(() => deriveMeasuredLanePayload({
    lane: 'draft', declared: draftPayload, manifests: invalidSeed, frontendComponents: [draft, recovered], driverObservations: [], processSeries: [],
  }), /seed entry .* is invalid/i);
  for (const [description, mutate, error] of [
    ['old 500-filler seed', entries => {
      delete entries[JSON.stringify(['extract', 'TopBar.url'])];
      entries[JSON.stringify(['convert', 'seed-495', 'TopBar.url'])] = { value: 'seed-value-495' };
    }, /seed entry .* is invalid/i],
    ['extra mounted draft', entries => { entries[JSON.stringify(['convert', 'Extra.slot'])] = { value: '' }; }, /exceeds 500 entries/i],
    ['wrong mounted value', entries => { entries[JSON.stringify(['convert', 'ConvertPage.files'])] = { value: 'invalid' }; }, /invalid value/i],
  ]) {
    const changed = structuredClone(draftManifests);
    const seed = JSON.parse(seedRaw);
    mutate(seed.entries);
    changed[0].bootstrap.draftStorage.raw = JSON.stringify(seed);
    assert.throws(() => deriveMeasuredLanePayload({
      lane: 'draft', declared: draftPayload, manifests: changed, frontendComponents: [draft, recovered], driverObservations: [], processSeries: [],
    }), error, description);
  }

  const missingWrite = structuredClone(draft);
  missingWrite.spans.pop();
  assert.throws(() => deriveMeasuredLanePayload({
    lane: 'draft', declared: { seed_entry_count: 500, seed_byte_count: 10, action_summaries: [], encode_span_ids: [], storage_span_ids: [], logical_persistence_acknowledged: false, expected_draft_sha256: digest('a'), recovered_draft_sha256: digest('a'), expected_ax_value: 'https://x.test/a.mp4', recovered_ax_value: 'https://x.test/a.mp4' }, manifests: draftManifests,
    frontendComponents: [missingWrite, recovered], driverObservations: [], processSeries: [],
  }), /20 paired/i);
  const wrongAck = structuredClone(draft);
  wrongAck.events[0].correlation_id = digest('b');
  assert.throws(() => deriveMeasuredLanePayload({
    lane: 'draft', declared: { seed_entry_count: 500, seed_byte_count: 10, action_summaries: [], encode_span_ids: [], storage_span_ids: [], logical_persistence_acknowledged: false, expected_draft_sha256: digest('a'), recovered_draft_sha256: digest('a'), expected_ax_value: 'https://x.test/a.mp4', recovered_ax_value: 'https://x.test/a.mp4' }, manifests: draftManifests,
    frontendComponents: [wrongAck, recovered], driverObservations: [], processSeries: [],
  }), /logical acknowledgement/i);
  const wrongAckOwner = structuredClone(draft);
  wrongAckOwner.events[0].owner.setup_id = 20;
  assert.throws(() => deriveMeasuredLanePayload({
    lane: 'draft', declared: draftPayload, manifests: draftManifests, frontendComponents: [wrongAckOwner, recovered], driverObservations: [], processSeries: [],
  }), /logical acknowledgement/i);
  const earlyAck = structuredClone(draft);
  earlyAck.events[0].at_us = 0;
  assert.throws(() => deriveMeasuredLanePayload({
    lane: 'draft', declared: draftPayload, manifests: draftManifests, frontendComponents: [earlyAck, recovered], driverObservations: [], processSeries: [],
  }), /logical acknowledgement/i);
  const extraCancelledSpan = structuredClone(draft);
  extraCancelledSpan.spans.push({ ...extraCancelledSpan.spans[0], span_id: 41, terminal: 'cancelled' });
  assert.throws(() => deriveMeasuredLanePayload({
    lane: 'draft', declared: draftPayload, manifests: draftManifests, frontendComponents: [extraCancelledSpan, recovered], driverObservations: [], processSeries: [],
  }), /20 paired/i);
  for (const mutate of [
    value => { value.spans[0].subject_id = 'wrong'; },
    value => { value.spans[0].start_us = 0; },
    value => { value.spans[1].start_us = value.spans[0].start_us; },
  ]) {
    const invalidPair = structuredClone(draft);
    mutate(invalidPair);
    assert.throws(() => deriveMeasuredLanePayload({
      lane: 'draft', declared: draftPayload, manifests: draftManifests, frontendComponents: [invalidPair, recovered], driverObservations: [], processSeries: [],
    }), /20 paired/i);
  }
  for (const mutate of [
    value => { value.setups[0].start_us = 0; },
    value => { value.setups[1].start_us = 3; value.setups[1].terminal_us = 6; },
  ]) {
    const invalidActionBinding = structuredClone(draft);
    mutate(invalidActionBinding);
    assert.throws(() => deriveMeasuredLanePayload({
      lane: 'draft', declared: draftPayload, manifests: draftManifests, frontendComponents: [invalidActionBinding, recovered], driverObservations: [], processSeries: [],
    }), /20 paired/i);
  }

  const session = frontend({ lane: 'session_memory' });
  session.actions = Array.from({ length: 1750 }, (_, index) => ({ action_id: index + 1, target_id: `a-${index + 1}`, state: 'settled', armed_us: index, active_us: index, terminal_us: index + 1 }));
  const sessionPayload = deriveMeasuredLanePayload({ lane: 'session_memory', declared: { cycle_summaries: [] }, manifests: [{}], frontendComponents: [session], driverObservations: [], processSeries: [{ schema_version: 1 }] });
  assert.deepEqual(sessionPayload.cycle_summaries, Array.from({ length: 50 }, (_, cycle_index) => ({ cycle_index })));
});

test('instrumentation overhead analysis enforces ten balanced alternating pairs and the larger threshold', () => {
  const pairs = Array.from({ length: 10 }, (_, index) => ({
    pair_index: index,
    order: index % 2 === 0 ? 'enabled_first' : 'disabled_first',
    enabled_duration_us: 110_000,
    disabled_duration_us: 100_000,
  }));
  const result = analyzeInstrumentationOverhead(pairs);
  assert.equal(result.pair_count, 10);
  assert.equal(result.paired_median_delta_us, 10_000);
  assert.equal(result.absolute_threshold_us, 5_000);
  assert.equal(result.relative_threshold_percent_milli, 5_000);
  assert.equal(result.exceeded, true);
  assert.throws(() => analyzeInstrumentationOverhead(pairs.slice(0, 9)), /ten/i);
  assert.throws(() => analyzeInstrumentationOverhead(pairs.map(pair => ({ ...pair, order: 'enabled_first' }))), /balanced|alternating/i);
  const heterogeneous = pairs.map((pair, index) => ({ ...pair, disabled_duration_us: index < 5 ? 50_000 : 1_000_000, enabled_duration_us: (index < 5 ? 50_000 : 1_000_000) + 6_000 }));
  const heterogeneousResult = analyzeInstrumentationOverhead(heterogeneous);
  assert.equal(heterogeneousResult.paired_median_delta_us, 6_000);
  assert.equal(heterogeneousResult.exceeded, true);
  const justAboveRelative = pairs.map(pair => ({ ...pair, disabled_duration_us: 250_000, enabled_duration_us: 262_501 }));
  assert.equal(analyzeInstrumentationOverhead(justAboveRelative).exceeded, true);
  const exactRelativeBoundary = pairs.map(pair => ({ ...pair, disabled_duration_us: 250_000, enabled_duration_us: 262_500 }));
  assert.equal(analyzeInstrumentationOverhead(exactRelativeBoundary).exceeded, false);
});

test('suite decision policy blocks excessive overhead and selects exactly one approved terminal outcome', () => {
  const overhead = { pair_count: 10, paired_median_delta_us: 1000, paired_median_percent_milli: 1000, absolute_threshold_us: 5000, relative_threshold_percent_milli: 5000, exceeded: false };
  const suiteIds = ['i1', 'i2', 'i3', 'i4', 'i5', 'd1', 'd2', 'd3', 'd4', 'd5', 'm1', 'm2', 'm3', 'm4', 'm5'];
  const interactionCandidates = [
    { target: 'draft_storage_write', impact_tier: 'discrete_interaction', risk_rank: 2, qualifying_samples: 4, sample_count: 5, threshold_exceeded: true, attribution_share_milli: 700, normalized_exceedance_milli: 200, evidence_sample_ids: ['d1', 'd2', 'd3', 'd4'], accepted_sample_ids: ['d1', 'd2', 'd3', 'd4', 'd5'] },
    { target: 'inspection_selection', impact_tier: 'main_thread_blocking', risk_rank: 1, qualifying_samples: 4, sample_count: 5, threshold_exceeded: true, attribution_share_milli: 600, normalized_exceedance_milli: 300, evidence_sample_ids: ['i1', 'i2', 'i3', 'i4'], accepted_sample_ids: ['i1', 'i2', 'i3', 'i4', 'i5'] },
  ];
  assert.throws(() => selectResponsivenessSuiteDecision({ overhead: { ...overhead, paired_median_delta_us: 6000, paired_median_percent_milli: 6000, exceeded: true }, interactionCandidates: [], memory: { sample_count: 5, accepted_sample_ids: ['m1', 'm2', 'm3', 'm4', 'm5'], qualifying_sample_ids: [] }, evidenceSampleIds: suiteIds }), /overhead/i);
  assert.throws(() => selectResponsivenessSuiteDecision({ overhead: { ...overhead, paired_median_delta_us: 6000, paired_median_percent_milli: 6000 }, interactionCandidates: [], memory: { sample_count: 5, accepted_sample_ids: ['m1', 'm2', 'm3', 'm4', 'm5'], qualifying_sample_ids: [] }, evidenceSampleIds: suiteIds }), /inconsistent/i);
  const interaction = selectResponsivenessSuiteDecision({
    overhead,
    interactionCandidates,
    memory: { sample_count: 5, accepted_sample_ids: ['m1', 'm2', 'm3', 'm4', 'm5'], qualifying_sample_ids: ['m1', 'm2', 'm3', 'm4', 'm5'] },
    evidenceSampleIds: suiteIds,
  });
  assert.equal(interaction.kind, 'interaction_optimization');
  assert.equal(interaction.target, 'draft_storage_write');
  const tied = selectResponsivenessSuiteDecision({
    overhead,
    interactionCandidates: [
      { ...interactionCandidates[0], target: 'a-wide-change', risk_rank: 9 },
      { ...interactionCandidates[0], target: 'z-narrow-change', risk_rank: 1 },
    ],
    memory: { sample_count: 5, accepted_sample_ids: ['m1', 'm2', 'm3', 'm4', 'm5'], qualifying_sample_ids: [] },
    evidenceSampleIds: suiteIds,
  });
  assert.equal(tied.target, 'z-narrow-change');
  assert.throws(() => selectResponsivenessSuiteDecision({ overhead, interactionCandidates, memory: {}, evidenceSampleIds: suiteIds }), /memory decision evidence/i);
  const memory = selectResponsivenessSuiteDecision({ overhead, interactionCandidates: [], memory: { sample_count: 5, accepted_sample_ids: ['m1', 'm2', 'm3', 'm4', 'm5'], qualifying_sample_ids: ['m1', 'm2', 'm3', 'm4'] }, evidenceSampleIds: suiteIds });
  assert.equal(memory.kind, 'allocation_profiling_followup');
  const none = selectResponsivenessSuiteDecision({ overhead, interactionCandidates: [], memory: { sample_count: 5, accepted_sample_ids: ['m1', 'm2', 'm3', 'm4', 'm5'], qualifying_sample_ids: ['m1', 'm2', 'm3'] }, evidenceSampleIds: suiteIds });
  assert.deepEqual(none.kind, 'no_further_work');
  assert.throws(() => selectResponsivenessSuiteDecision({ overhead, interactionCandidates: [{ target: 'bad', impact_tier: 'discrete_interaction', risk_rank: 1, qualifying_samples: 6, sample_count: 5, threshold_exceeded: true, attribution_share_milli: 1001, normalized_exceedance_milli: 1, evidence_sample_ids: ['outside'], accepted_sample_ids: ['d1', 'd2', 'd3', 'd4', 'd5'] }], memory: { sample_count: 5, accepted_sample_ids: ['m1', 'm2', 'm3', 'm4', 'm5'], qualifying_sample_ids: [] }, evidenceSampleIds: suiteIds }), /candidate/i);
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

test('native draft control publishes only complete external AX evidence without a frontend sample', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'goop-native-control-')));
  try {
    const binary = join(root, 'Goop'); writeFileSync(binary, 'release-binary');
    const reports = join(root, 'reports'); mkdirSync(reports);
    const profile = join(root, 'profile'); mkdirSync(profile);
    const seededRaw = seededDraftRaw(500);
    const typed = [...'https://x.test/a.mp4'];
    const manifest = {
      schema_version: 2, recorderMode: 'control', token: 'control-token', ...activationFields('pre_quit'),
      bootstrap: { ...activationFields('pre_quit').bootstrap, initialPath: '/convert', draftStorage: { raw: seededRaw, sha256: hash(seededRaw) } },
      descriptor: { componentRole: 'pre_quit', sessionId: uuid('1'), sampleId: 'draft:500:control:0', pageInstanceId: uuid('2'), lane: 'draft', scenario: { id: 'draft-500-control', manifestSha256: digest('a') }, workload: { id: 'draft-500', facts: { seeded_entries: 500, mutation_count: 20 } }, phase: 'measured', repetition: 0 },
      actions: typed.map((character, index) => ({ actionId: index + 1, targetId: `draft-key-${index + 1}`, eventType: 'input', targetRole: 'textbox', accessibleName: 'Paste URL to download', expectedPriorValue: typed.slice(0, index).join('') })),
    };
    const manifestPath = join(root, 'manifest.json'); writeFileSync(manifestPath, JSON.stringify(manifest));
    const recoveryManifest = {
      ...manifest,
      token: 'control-recovery-token',
      bootstrap: { initialPath: '/convert', draftStorage: null, failNextDraftWrite: false },
      completion: { kind: 'recovery', timeoutMs: 40_000, expectedDraftSha256: hash(finalDraftRaw(seededRaw)), expectedAxValue: typed.join('') },
      descriptor: { ...manifest.descriptor, componentRole: 'recovery', pageInstanceId: uuid('3') },
      actions: [],
    };
    const recoveryManifestPath = join(root, 'recovery-manifest.json'); writeFileSync(recoveryManifestPath, JSON.stringify(recoveryManifest));
    const page = {
      manifest_path: manifestPath, required_labels: ['Paste URL to download'],
      actions: manifest.actions.map((action, index) => ({ ...action, dispatch: { kind: 'keystroke', text: typed[index], ax_prior: { kind: 'attribute_equals', attribute: 'AXValue', value: action.expectedPriorValue }, completion: { kind: 'attribute_equals', attribute: 'AXValue', value: typed.slice(0, index + 1).join('') }, timeout_ms: 2000 } })),
      timeout_ms: 10_000,
    };
    const recoveryPage = { manifest_path: recoveryManifestPath, required_labels: ['Paste URL to download'], recovery_target: { role: 'textbox', label: 'Paste URL to download' }, actions: [], timeout_ms: 10_000 };
    const plan = {
      schema_version: 2, app_name: 'Goop', binary, report_directory: reports, app_data_directory: profile, pages: [page, recoveryPage],
      identity_inputs: identityInputs(binary, [manifestPath, recoveryManifestPath]),
      common: { identity: evidenceIdentity(), clock_origins: { driver_monotonic: { unit: 'us' }, native_monotonic: { unit: 'us' } }, limitations: [], cleanup: { complete: true, removed_paths: 0, error_code: null }, outcome: { kind: 'success' } },
      payload: {}, limits: { log_limit_bytes: 65_536, storage_budget_bytes: 16_777_216 }, cleanup_profile: false,
    };
    const observations = driverObservations(manifest.actions).map((observation, index) => ({ ...observation, driver_duration_us: index + 1 }));
    const cleanupReceipt = { schema_version: 2, component_kind: 'data_store_cleanup', session_id: manifest.descriptor.sessionId, webview_data_store_id: manifest.webviewDataStoreId, removed: true, error_code: null, pid: 43, native_clock: { domain: 'native_monotonic', unit: 'us', elapsed_us: 20 } };
    const result = await runNativeResponsivenessPlan(plan, {
      platform: 'darwin',
      runPage: async ({ manifest: activeManifest }) => ({ page_component: null, driver_observations: activeManifest.descriptor.componentRole === 'recovery' ? [] : observations, external_ax_duration_us: activeManifest.descriptor.componentRole === 'recovery' ? null : 210, process_series: null, recovery_evidence: activeManifest.descriptor.componentRole === 'recovery' ? { ax_value: typed.join('') } : null, cleanup: { complete: true } }),
      runCleanup: async () => cleanupReceipt,
    });
    assert.equal(result.control.component_kind, 'responsiveness_instrumentation_control');
    assert.equal(result.control.recorder_mode, 'control');
    assert.equal(result.control.action_count, 20);
    assert.equal(result.control.external_ax_duration_us, 210);
    assert.equal(result.control.recovery_ax_verified, true);
    assert.equal(result.control.recovered_ax_value_sha256, hash(typed.join('')));
    assert.deepEqual(result.control.outcome, { kind: 'success' });
    assert.equal(existsSync(join(reports, 'control.json')), true);
    assert.equal(existsSync(join(reports, 'sample.json')), false);
    assert.equal(existsSync(join(reports, 'components', 'driver.json')), true);
    const recoveryEvidence = JSON.parse(readFileSync(join(reports, 'components', 'recovery.json'), 'utf8'));
    assert.equal(recoveryEvidence.page_instance_id, recoveryManifest.descriptor.pageInstanceId);
    assert.equal(recoveryEvidence.recovered_ax_value_sha256, hash(typed.join('')));
    assert.equal(recoveryEvidence.ax_value_matches, true);
    assert.equal(readdirSync(join(reports, 'components')).some(name => name.startsWith('frontend-')), false);

    const incompleteReports = join(root, 'incomplete-reports'); mkdirSync(incompleteReports);
    const incompleteProfile = join(root, 'incomplete-profile'); mkdirSync(incompleteProfile);
    await assert.rejects(() => runNativeResponsivenessPlan({ ...plan, report_directory: incompleteReports, app_data_directory: incompleteProfile }, {
      platform: 'darwin',
      runPage: async ({ manifest: activeManifest }) => ({ page_component: null, driver_observations: activeManifest.descriptor.componentRole === 'recovery' ? [] : observations.slice(0, -1), external_ax_duration_us: activeManifest.descriptor.componentRole === 'recovery' ? null : 190, process_series: null, recovery_evidence: activeManifest.descriptor.componentRole === 'recovery' ? { ax_value: typed.join('') } : null, cleanup: { complete: true } }),
      runCleanup: async () => cleanupReceipt,
    }), /cardinality/i);
    assert.equal(existsSync(join(incompleteReports, 'control.json')), false);

    const rollbackReports = join(root, 'rollback-reports'); mkdirSync(rollbackReports);
    const rollbackProfile = join(root, 'rollback-profile'); mkdirSync(rollbackProfile);
    await assert.rejects(() => runNativeResponsivenessPlan({ ...plan, report_directory: rollbackReports, app_data_directory: rollbackProfile }, {
      platform: 'darwin',
      runPage: async ({ manifest: activeManifest }) => ({ page_component: null, driver_observations: activeManifest.descriptor.componentRole === 'recovery' ? [] : observations, external_ax_duration_us: activeManifest.descriptor.componentRole === 'recovery' ? null : 210, process_series: null, recovery_evidence: activeManifest.descriptor.componentRole === 'recovery' ? { ax_value: typed.join('') } : null, cleanup: { complete: true } }),
      runCleanup: async () => cleanupReceipt,
      syncDirectory: () => { throw Error('injected directory sync failure'); },
    }), /directory sync failure/i);
    assert.equal(existsSync(join(rollbackReports, 'control.json')), false);
    assert.equal(existsSync(join(rollbackReports, 'components')), false);
    assert.equal(existsSync(join(rollbackReports, '.incomplete')), true);

    const invalidManifestPath = join(root, 'invalid-manifest.json');
    const invalidWorkload = { ...manifest.descriptor.workload, facts: { seeded_entries: 100, mutation_count: 20 } };
    writeFileSync(invalidManifestPath, JSON.stringify({ ...manifest, descriptor: { ...manifest.descriptor, workload: invalidWorkload } }));
    const invalidRecoveryManifestPath = join(root, 'invalid-recovery-manifest.json');
    writeFileSync(invalidRecoveryManifestPath, JSON.stringify({ ...recoveryManifest, descriptor: { ...recoveryManifest.descriptor, workload: invalidWorkload } }));
    const invalidReports = join(root, 'invalid-reports'); mkdirSync(invalidReports);
    const invalidProfile = join(root, 'invalid-profile'); mkdirSync(invalidProfile);
    const invalidPage = { ...page, manifest_path: invalidManifestPath };
    await assert.rejects(() => runNativeResponsivenessPlan({ ...plan, report_directory: invalidReports, app_data_directory: invalidProfile, pages: [invalidPage, { ...recoveryPage, manifest_path: invalidRecoveryManifestPath }], identity_inputs: identityInputs(binary, [invalidManifestPath, invalidRecoveryManifestPath]) }, { platform: 'darwin' }), /control.*500|500.*control/i);

    const falseCountRaw = seededDraftRaw(1);
    const falseCountManifestPath = join(root, 'false-count-manifest.json');
    writeFileSync(falseCountManifestPath, JSON.stringify({ ...manifest, bootstrap: { ...manifest.bootstrap, draftStorage: { raw: falseCountRaw, sha256: hash(falseCountRaw) } } }));
    const falseCountReports = join(root, 'false-count-reports'); mkdirSync(falseCountReports);
    const falseCountProfile = join(root, 'false-count-profile'); mkdirSync(falseCountProfile);
    const falseCountPage = { ...page, manifest_path: falseCountManifestPath };
    await assert.rejects(() => runNativeResponsivenessPlan({ ...plan, report_directory: falseCountReports, app_data_directory: falseCountProfile, pages: [falseCountPage, recoveryPage], identity_inputs: identityInputs(binary, [falseCountManifestPath, recoveryManifestPath]) }, { platform: 'darwin' }), /seeded entry count|500 entries|500-entry/i);

    const wrongTargetReports = join(root, 'wrong-target-reports'); mkdirSync(wrongTargetReports);
    const wrongTargetProfile = join(root, 'wrong-target-profile'); mkdirSync(wrongTargetProfile);
    await assert.rejects(() => runNativeResponsivenessPlan({ ...plan, report_directory: wrongTargetReports, app_data_directory: wrongTargetProfile, pages: [page, { ...recoveryPage, recovery_target: { role: 'textbox', label: 'Other URL' } }] }, { platform: 'darwin' }), /control recovery/i);
    assert.equal(existsSync(join(wrongTargetReports, 'control.json')), false);

    const wrongRecoveryReports = join(root, 'wrong-recovery-reports'); mkdirSync(wrongRecoveryReports);
    const wrongRecoveryProfile = join(root, 'wrong-recovery-profile'); mkdirSync(wrongRecoveryProfile);
    await assert.rejects(() => runNativeResponsivenessPlan({ ...plan, report_directory: wrongRecoveryReports, app_data_directory: wrongRecoveryProfile }, {
      platform: 'darwin',
      runPage: async ({ manifest: activeManifest }) => ({ page_component: null, driver_observations: activeManifest.descriptor.componentRole === 'recovery' ? [] : observations, external_ax_duration_us: activeManifest.descriptor.componentRole === 'recovery' ? null : 210, process_series: null, recovery_evidence: activeManifest.descriptor.componentRole === 'recovery' ? { ax_value: 'wrong' } : null, cleanup: { complete: true } }),
      runCleanup: async () => cleanupReceipt,
    }), /recovery|persisted/i);
    assert.equal(existsSync(join(wrongRecoveryReports, 'control.json')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('native draft plan runs pre-quit then recovery before exclusive publication', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'goop-native-plan-')));
  try {
    const binary = join(root, 'Goop'); writeFileSync(binary, 'release-binary');
    const reports = join(root, 'reports'); mkdirSync(reports);
    const profile = join(root, 'profile'); mkdirSync(profile);
    const makeManifest = (role, page) => ({
      schema_version: 2,
      token: `token-${role}`,
      ...activationFields(role),
      descriptor: { componentRole: role, sessionId: uuid('1'), sampleId: 'draft:500:measured:0', pageInstanceId: page, lane: 'draft', scenario: { id: 'draft-500', manifestSha256: digest('a') }, workload: { id: 'draft-500', facts: { seeded_entries: 500, mutation_count: 20 } }, phase: 'measured', repetition: 0 },
      actions: role === 'recovery' ? [] : [...'https://x.test/a.mp4'].map((character, index, characters) => ({ actionId: index + 1, targetId: `draft-key-${index + 1}`, eventType: 'input', targetRole: 'textbox', accessibleName: 'Paste URL to download', expectedPriorValue: characters.slice(0, index).join('') })),
    });
    const manifests = [makeManifest('pre_quit', uuid('2')), makeManifest('recovery', uuid('3'))];
    const seededRaw = seededDraftRaw(500);
    manifests[0].bootstrap.draftStorage = { raw: seededRaw, sha256: hash(seededRaw) };
    manifests[1].completion.expectedDraftSha256 = digest('b');
    manifests[1].completion.expectedAxValue = 'https://x.test/a.mp4';
    const pages = manifests.map((manifest, index) => {
      const manifestPath = join(root, `manifest-${index}.json`); writeFileSync(manifestPath, JSON.stringify(manifest));
      return { manifest_path: manifestPath, required_labels: ['Paste URL to download'], ...(manifest.descriptor.componentRole === 'recovery' ? { recovery_target: { role: 'textbox', label: 'Paste URL to download' } } : {}), actions: manifest.actions.map((action, actionIndex) => ({ ...action, dispatch: { kind: 'keystroke', text: 'https://x.test/a.mp4'[actionIndex], ax_prior: { kind: 'attribute_equals', attribute: 'AXValue', value: action.expectedPriorValue }, completion: { kind: 'attribute_equals', attribute: 'AXValue', value: 'https://x.test/a.mp4'.slice(0, actionIndex + 1) }, timeout_ms: 2000 } })), timeout_ms: 10_000 };
    });
    const calls = [];
    const runPage = async ({ manifest }) => {
      calls.push(manifest.descriptor.componentRole);
      const trace = frontend({ lane: 'draft', role: manifest.descriptor.componentRole, page: manifest.descriptor.pageInstanceId });
      trace.sample_id = manifest.descriptor.sampleId;
      trace.scenario = { id: manifest.descriptor.scenario.id, manifest_sha256: manifest.descriptor.scenario.manifestSha256 };
      trace.workload = manifest.descriptor.workload;
      trace.actions = recordedActions(manifest.actions);
      if (manifest.descriptor.componentRole === 'pre_quit') {
        trace.actions = Array.from({ length: 20 }, (_, index) => ({ action_id: index + 1, target_id: manifest.actions[index].targetId, state: 'settled', armed_us: index * 10, active_us: index * 10 + 1, terminal_us: index * 10 + 9 }));
        const persistenceSetups = Array.from({ length: 20 }, (_, index) => ({ setup_id: index + 1, target_id: 'workspace_drafts', state: 'settled', start_us: index * 10 + 2, terminal_us: index * 10 + 7 }));
        trace.setups = [...persistenceSetups, { setup_id: 21, target_id: 'draft_completion', state: 'settled', start_us: 200, terminal_us: 201 }];
        trace.spans = persistenceSetups.flatMap((setup, index) => [
          { span_id: index * 2 + 1, owner: { kind: 'setup', setup_id: setup.setup_id }, parent_span_id: null, kind: 'draft_encode', subject_id: 'workspace_drafts', start_us: index * 10 + 2, end_us: index * 10 + 3, terminal: 'ended', terminal_cause_action_id: null },
          { span_id: index * 2 + 2, owner: { kind: 'setup', setup_id: setup.setup_id }, parent_span_id: null, kind: 'storage_write', subject_id: 'workspace_drafts', start_us: index * 10 + 4, end_us: index * 10 + 5, terminal: 'ended', terminal_cause_action_id: null },
        ]);
        trace.events = [{ event_seq: 1, owner: { kind: 'setup', setup_id: 21 }, span_id: null, kind: 'persistence_settled', at_us: 200, subject_id: 'draft_sha256', correlation_id: digest('b') }];
      } else {
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
      payload: { seed_entry_count: 999, seed_byte_count: 999, action_summaries: Array.from({ length: 20 }, (_, action_id) => ({ action_id: action_id + 1 })), encode_span_ids: [], storage_span_ids: [], logical_persistence_acknowledged: true, expected_draft_sha256: digest('c'), recovered_draft_sha256: digest('c'), expected_ax_value: 'spoofed', recovered_ax_value: 'spoofed' },
      limits: { log_limit_bytes: 65_536, storage_budget_bytes: 16_777_216 }, cleanup_profile: false,
    };
    const cleanupReceipt = manifest => ({ schema_version: 2, component_kind: 'data_store_cleanup', session_id: manifest.descriptor.sessionId, webview_data_store_id: manifest.webviewDataStoreId, removed: true, error_code: null, pid: 43, native_clock: { domain: 'native_monotonic', unit: 'us', elapsed_us: 20 } });
    await assert.rejects(() => runNativeResponsivenessPlan({ ...basePlan, unexpected: true }, { platform: 'darwin', runPage, runCleanup: async ({ manifest }) => cleanupReceipt(manifest) }), /unknown fields: unexpected/);
    await assert.rejects(() => runNativeResponsivenessPlan({ ...basePlan, pages: [{ ...basePlan.pages[0], unexpected: true }, basePlan.pages[1]] }, { platform: 'darwin', runPage, runCleanup: async ({ manifest }) => cleanupReceipt(manifest) }), /unknown fields: unexpected/);
    await assert.rejects(() => runNativeResponsivenessPlan({ ...basePlan, pages: [{ ...basePlan.pages[0], actions: basePlan.pages[0].actions.map((action, index) => index === 0 ? { ...action, dispatch: { ...action.dispatch, unexpected: true } } : action) }, basePlan.pages[1]] }, { platform: 'darwin', runPage, runCleanup: async ({ manifest }) => cleanupReceipt(manifest) }), /unknown fields: unexpected/);
    await assert.rejects(() => runNativeResponsivenessPlan({ ...basePlan, pages: [{ ...basePlan.pages[0], actions: basePlan.pages[0].actions.map((action, index) => index === 0 ? { ...action, dispatch: { ...action.dispatch, text: {} } } : action) }, basePlan.pages[1]] }, { platform: 'darwin', runPage, runCleanup: async ({ manifest }) => cleanupReceipt(manifest) }), /keystroke text/);
    await assert.rejects(() => runNativeResponsivenessPlan({ ...basePlan, report_directory: join(process.cwd(), 'owned-responsiveness-output') }, { platform: 'darwin', runPage, runCleanup: async ({ manifest }) => cleanupReceipt(manifest) }), /outside the identity repository/);
    const result = await runNativeResponsivenessPlan(basePlan, { platform: 'darwin', runPage, runCleanup: async ({ manifest }) => cleanupReceipt(manifest) });
    assert.deepEqual(calls, ['pre_quit', 'recovery']);
    assert.equal(result.sample.frontend_components.length, 2);
    assert.equal(result.sample.payload.expected_draft_sha256, digest('b'));
    assert.equal(result.sample.payload.recovered_draft_sha256, digest('b'));
    assert.equal(result.sample.payload.seed_entry_count, 500);
    assert.equal(result.sample.payload.seed_byte_count, Buffer.byteLength(seededRaw));
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
    let invocation = null;
    const result = await runDataStoreCleanup({
      plan: { binary, app_data_directory: profile, pages: [{ manifest_path: manifestPath }], limits: { log_limit_bytes: 1024, storage_budget_bytes: 1024 * 1024 } },
      manifest, componentDirectory: report,
      runProcess: async options => { invocation = options; writeFileSync(join(report, `data-store-cleanup-${uuid('1')}.json`), JSON.stringify(receipt)); return { success: false }; },
    });
    assert.deepEqual(result, { receipt, helper_success: false });
    assert.deepEqual(invocation.args, ['-ApplePersistenceIgnoreState', 'YES']);
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
    const rollback = join(root, 'rollback'); mkdirSync(rollback);
    assert.throws(() => publishSampleExclusive(rollback, sample, { syncDirectory: () => { throw Error('injected sync failure'); } }), /sync failure/i);
    assert.equal(existsSync(join(rollback, 'sample.json')), false);
    assert.equal(readdirSync(rollback).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('directory sync helper is portable on Windows', () => {
  assert.equal(syncDirectoryPortable('C:\\not-opened-on-windows', 'win32'), false);
});

test('directory sync helper honors Windows host limits while simulating another target', () => {
  assert.equal(syncDirectoryPortable('C:\\not-opened-on-windows', 'darwin', 'win32'), false);
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
