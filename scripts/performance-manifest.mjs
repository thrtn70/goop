import { existsSync, lstatSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { sha256File } from './performance-shared.mjs';

export const PERFORMANCE_LIMITATIONS = Object.freeze([
  'Fresh processes with warm filesystem caches; this is not a cold-cache measurement.',
  'Background applications may remain during measurement.',
  'WebKit/XPC attribution is incomplete for descendant RSS.',
  'No dedicated laboratory environment is claimed.',
]);

const rootFields = new Set(['schema_version', 'suite_id', 'limitations', 'defaults', 'fixture_roles', 'workloads']);
const defaultFields = new Set(['warmups', 'repetitions', 'timeout_ms', 'suite_timeout_ms', 'log_limit_bytes', 'suite_log_limit_bytes', 'storage_budget_bytes', 'suite_storage_budget_bytes']);
const commonWorkloadFields = ['id', 'adapter', 'expected_output', 'warmups', 'repetitions', 'timeout_ms', 'log_limit_bytes', 'storage_budget_bytes'];
const convertRequestFields = new Set([
  'image_color_policy',
  'video_options',
  'target',
  'quality_preset',
  'resolution_cap',
  'gif_options',
  'compress_mode',
  'batch_id',
  'metadata_policy',
  'subtitle',
  'image_options',
  'audio_options',
  'track_options',
  'image_alpha_policy',
]);

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw Error(`${label} must be an object`);
  return value;
}

function onlyFields(value, allowed, label) {
  for (const key of Object.keys(object(value, label))) if (!allowed.has(key)) throw Error(`${label} has unknown field: ${key}`);
}

function integer(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw Error(`Invalid ${label}`);
}

function nonempty(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw Error(`${label} must be a nonempty string`);
}

function safeId(value, label) {
  nonempty(value, label);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(value)) throw Error(`${label} must be a safe lowercase identifier`);
}

function validateRequest(request, label) {
  onlyFields(request, convertRequestFields, label);
  nonempty(request.target, `${label}.target`);
}

function validateLimits(value, label, inherited = false) {
  if (!inherited || value.warmups !== undefined) integer(value.warmups, `${label}.warmups`, 1, 1);
  if (!inherited || value.repetitions !== undefined) integer(value.repetitions, `${label}.repetitions`, 1, 20);
  if (!inherited || value.timeout_ms !== undefined) integer(value.timeout_ms, `${label}.timeout_ms`, 1, 3_600_000);
  if (!inherited) integer(value.suite_timeout_ms, `${label}.suite_timeout_ms`, 1, 86_400_000);
  if (!inherited || value.log_limit_bytes !== undefined) integer(value.log_limit_bytes, `${label}.log_limit_bytes`, 1024, 64 * 1024 * 1024);
  if (!inherited) integer(value.suite_log_limit_bytes, `${label}.suite_log_limit_bytes`, 1024, 1024 * 1024 * 1024);
  if (!inherited || value.storage_budget_bytes !== undefined) integer(value.storage_budget_bytes, `${label}.storage_budget_bytes`, 1024, 1024 * 1024 * 1024 * 1024);
  if (!inherited) integer(value.suite_storage_budget_bytes, `${label}.suite_storage_budget_bytes`, 1024, 1024 * 1024 * 1024 * 1024);
}

const targetExtensions = new Map([
  ['jpeg', new Set(['jpg', 'jpeg'])], ['png', new Set(['png'])], ['webp', new Set(['webp'])],
  ['bmp', new Set(['bmp'])], ['tiff', new Set(['tif', 'tiff'])], ['avif', new Set(['avif'])],
  ['jpeg_xl', new Set(['jxl'])], ['mp4', new Set(['mp4'])], ['mkv', new Set(['mkv'])],
  ['webm', new Set(['webm'])], ['gif', new Set(['gif'])], ['avi', new Set(['avi'])],
  ['mov', new Set(['mov'])], ['mp3', new Set(['mp3'])], ['wav', new Set(['wav'])],
  ['flac', new Set(['flac'])], ['aac', new Set(['aac'])], ['ogg', new Set(['ogg'])],
]);

function validateExpectedOutput(value, label, expectedKind, request = null) {
  object(value, label);
  if (expectedKind === 'media') {
    onlyFields(value, new Set(['extension', 'probe', 'format_names', 'required_streams']), label);
    nonempty(value.extension, `${label}.extension`);
    if (!/^[a-z0-9]{1,10}$/.test(value.extension)) throw Error(`Invalid ${label}.extension`);
    if (value.probe !== 'media') throw Error(`Invalid ${label}.probe`);
    if (!Array.isArray(value.format_names) || value.format_names.length === 0 || value.format_names.some(name => typeof name !== 'string' || !/^[a-z0-9_]+$/.test(name))) throw Error(`Invalid ${label}.format_names`);
    if (!Array.isArray(value.required_streams) || value.required_streams.length === 0) throw Error(`Invalid ${label}.required_streams`);
    for (const [index, stream] of value.required_streams.entries()) {
      const streamLabel = `${label}.required_streams[${index}]`;
      onlyFields(stream, new Set(['codec_type', 'codec_name']), streamLabel);
      if (!['video', 'audio'].includes(stream.codec_type) || typeof stream.codec_name !== 'string' || !/^[a-z0-9_]+$/.test(stream.codec_name)) throw Error(`Invalid ${streamLabel}`);
    }
    const allowedExtensions = targetExtensions.get(request?.target);
    if (!allowedExtensions?.has(value.extension)) throw Error(`${label} target and extension do not match`);
    const requestedCodec = request?.video_options?.kind === 'encode' ? request.video_options.codec : null;
    if (requestedCodec && !value.required_streams.some(stream => stream.codec_type === 'video' && stream.codec_name === requestedCodec)) throw Error(`${label} does not require the requested video codec`);
  } else {
    onlyFields(value, new Set(['kind']), label);
    if (value.kind !== expectedKind) throw Error(`Invalid ${label}.kind`);
  }
}

function validateWorkload(workload, index, roles) {
  const label = `workloads[${index}]`;
  object(workload, label);
  safeId(workload.id, `${label}.id`);
  const limits = new Set([...commonWorkloadFields]);
  if (workload.adapter === 'single_conversion') {
    for (const field of ['fixture_role', 'request']) limits.add(field);
    onlyFields(workload, limits, label);
    if (!roles.has(workload.fixture_role)) throw Error(`${label}.fixture_role is undeclared`);
    object(workload.request, `${label}.request`);
    if (workload.request.output_path !== undefined || workload.request.input_path !== undefined) throw Error(`${label}.request paths are suite-owned`);
    validateRequest(workload.request, `${label}.request`);
    validateExpectedOutput(workload.expected_output, `${label}.expected_output`, 'media', workload.request);
  } else if (workload.adapter === 'workload' && workload.mode === 'inspection_burst') {
    for (const field of ['mode', 'fixture_roles', 'source_count']) limits.add(field);
    onlyFields(workload, limits, label);
    if (!Array.isArray(workload.fixture_roles) || workload.fixture_roles.length === 0 || workload.fixture_roles.some(role => !roles.has(role))) throw Error(`${label}.fixture_roles must reference declared roles`);
    integer(workload.source_count, `${label}.source_count`, 1, 10_000);
    validateExpectedOutput(workload.expected_output, `${label}.expected_output`, 'metrics_only');
  } else if (workload.adapter === 'workload' && workload.mode === 'conversion_batch') {
    for (const field of ['mode', 'concurrency', 'items']) limits.add(field);
    onlyFields(workload, limits, label);
    integer(workload.concurrency, `${label}.concurrency`, 1, 16);
    if (!Array.isArray(workload.items) || workload.items.length === 0 || workload.items.length > 10_000) throw Error(`Invalid ${label}.items`);
    const ids = new Set();
    for (const [itemIndex, item] of workload.items.entries()) {
      const itemLabel = `${label}.items[${itemIndex}]`;
      onlyFields(item, new Set(['id', 'fixture_role', 'request', 'expected_output']), itemLabel);
      safeId(item.id, `${itemLabel}.id`);
      if (ids.has(item.id)) throw Error(`Duplicate batch item id: ${item.id}`);
      ids.add(item.id);
      if (!roles.has(item.fixture_role)) throw Error(`${itemLabel}.fixture_role is undeclared`);
      object(item.request, `${itemLabel}.request`);
      if (item.request.output_path !== undefined || item.request.input_path !== undefined) throw Error(`${itemLabel}.request paths are suite-owned`);
      validateRequest(item.request, `${itemLabel}.request`);
      validateExpectedOutput(item.expected_output, `${itemLabel}.expected_output`, 'media', item.request);
    }
    validateExpectedOutput(workload.expected_output, `${label}.expected_output`, 'metrics_only');
  } else if (workload.adapter === 'startup') {
    for (const field of ['jobs']) limits.add(field);
    onlyFields(workload, limits, label);
    if (![0, 200, 1000].includes(workload.jobs)) throw Error(`Invalid ${label}.jobs`);
    validateExpectedOutput(workload.expected_output, `${label}.expected_output`, 'startup_marker');
  } else {
    throw Error(`Unsupported adapter or mode in ${label}`);
  }
  validateLimits(workload, label, true);
}

export function parseManifest(input) {
  const value = typeof input === 'string' ? JSON.parse(input) : structuredClone(input);
  onlyFields(value, rootFields, 'manifest');
  if (value.schema_version !== 1) throw Error('Unsupported manifest schema_version');
  nonempty(value.suite_id, 'manifest.suite_id');
  if (!Array.isArray(value.limitations) || value.limitations.length !== PERFORMANCE_LIMITATIONS.length || value.limitations.some((item, index) => item !== PERFORMANCE_LIMITATIONS[index])) throw Error('Manifest limitations must retain the exact PERF-01A limitations');
  onlyFields(value.defaults, defaultFields, 'manifest.defaults');
  validateLimits(value.defaults, 'manifest.defaults');
  if (!Array.isArray(value.fixture_roles) || value.fixture_roles.length === 0) throw Error('manifest.fixture_roles must not be empty');
  const roles = new Set();
  for (const role of value.fixture_roles) {
    safeId(role, 'fixture role');
    if (roles.has(role)) throw Error(`Duplicate fixture role: ${role}`);
    roles.add(role);
  }
  if (!Array.isArray(value.workloads) || value.workloads.length === 0) throw Error('manifest.workloads must not be empty');
  const workloadIds = new Set();
  value.workloads.forEach((workload, index) => {
    validateWorkload(workload, index, roles);
    if (workloadIds.has(workload.id)) throw Error(`Duplicate workload id: ${workload.id}`);
    workloadIds.add(workload.id);
  });
  return value;
}

export function validateBindings(manifest, input) {
  const binding = typeof input === 'string' ? JSON.parse(input) : structuredClone(input);
  onlyFields(binding, new Set(['schema_version', 'fixtures']), 'bindings');
  if (binding.schema_version !== 1) throw Error('Unsupported bindings schema_version');
  object(binding.fixtures, 'bindings.fixtures');
  const declared = new Set(manifest.fixture_roles);
  for (const role of Object.keys(binding.fixtures)) if (!declared.has(role)) throw Error(`Binding has undeclared fixture role: ${role}`);
  const result = {};
  for (const role of manifest.fixture_roles) {
    const fixture = binding.fixtures[role];
    if (!fixture) throw Error(`Missing fixture binding: ${role}`);
    onlyFields(fixture, new Set(['path', 'sha256', 'bytes']), `binding ${role}`);
    if (!isAbsolute(fixture.path)) throw Error(`Binding path must be absolute: ${role}`);
    if (!/^[0-9a-f]{64}$/.test(fixture.sha256)) throw Error(`Invalid SHA-256 for ${role}`);
    integer(fixture.bytes, `binding ${role}.bytes`, 0, Number.MAX_SAFE_INTEGER);
    if (!existsSync(fixture.path) || !lstatSync(fixture.path).isFile()) throw Error(`Fixture is missing or not a regular file: ${role}`);
    const stats = statSync(fixture.path);
    if (stats.size !== fixture.bytes) throw Error(`Byte-size mismatch for ${role}`);
    if (sha256File(fixture.path) !== fixture.sha256) throw Error(`SHA-256 mismatch for ${role}`);
    result[role] = { ...fixture };
  }
  return result;
}

export function revalidateBindings(manifest, bindings) {
  return validateBindings(manifest, { schema_version: 1, fixtures: bindings });
}

export function validateMediaProbe(probe, expectedOutput) {
  if (!Array.isArray(probe?.streams) || probe.streams.length === 0) throw Error('Independent probe found no usable media stream');
  const actualFormats = new Set(typeof probe?.format?.format_name === 'string' ? probe.format.format_name.split(',') : []);
  if (!expectedOutput.format_names.some(name => actualFormats.has(name))) throw Error(`Independent probe format does not match ${expectedOutput.extension}`);
  for (const expected of expectedOutput.required_streams) {
    if (!probe.streams.some(stream => stream?.codec_type === expected.codec_type && stream?.codec_name === expected.codec_name)) {
      throw Error(`Independent probe is missing ${expected.codec_type}/${expected.codec_name}`);
    }
  }
  return true;
}

export function validateEffectiveExecution(summary, request) {
  const expected = request?.video_options;
  if (expected === null || expected === undefined) return true;
  if (summary === null || typeof summary !== 'object' || summary.requested?.kind !== expected.kind) throw Error('Completed video execution does not match the requested mode');
  if (expected.kind === 'copy') {
    if (summary.encoder !== null) throw Error('Copy workload reported an encoder');
    return true;
  }
  if (summary.requested.codec !== expected.codec || summary.requested.processor !== expected.processor || typeof summary.encoder !== 'string' || summary.encoder === '') throw Error('Completed video encoding does not match the requested codec/processor');
  if (expected.processor === 'software' && /(videotoolbox|nvenc|_qsv|_amf)$/.test(summary.encoder)) throw Error('Software workload reported a hardware encoder');
  return true;
}
