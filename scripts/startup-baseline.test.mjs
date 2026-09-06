import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStartup, summarizeStartup } from './startup-baseline.mjs';

async function fake(code, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'goop-startup-test-'));
  try {
    const file = join(root, 'runner.cjs');
    writeFileSync(file, code);
    return await runStartup({ binary: process.execPath, args: [file], directory: join(root, 'run'), settings: {}, readinessTimeoutMs: 1500, idleMs: 30, killGraceMs: 30, ...options });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
test('timeout kills a TERM-resistant child before returning', async () => {
  const result = await fake("process.on('SIGTERM',()=>{});setInterval(()=>{},10)");
  assert.equal(result.success, false);
  assert.equal(result.timed_out, true);
  assert.equal(result.exit_signal, 'SIGKILL');
  assert.throws(() => process.kill(result.pid, 0), { code: 'ESRCH' });
});
test('invalid and failed readiness excluded from medians', async () => {
  const result = await fake("require('node:fs').writeFileSync(process.env.GOOP_STARTUP_REPORT,JSON.stringify({schema_version:1,backend_ready_ms:-1,pid:process.pid}));setInterval(()=>{},10)");
  assert.equal(result.success, false);
  assert.equal(summarizeStartup([result]).launch_to_ready_ms.median_ms, null);
});
test('valid marker must belong to the launched PID', async () => {
  const result = await fake("require('node:fs').writeFileSync(process.env.GOOP_STARTUP_REPORT,JSON.stringify({schema_version:1,backend_ready_ms:1,pid:1}));setInterval(()=>{},10)");
  assert.equal(result.success, false);
});
test('records marker and idle RSS then waits for child exit', async () => {
  const result = await fake("require('node:fs').writeFileSync(process.env.GOOP_STARTUP_REPORT,JSON.stringify({schema_version:1,backend_ready_ms:1,pid:process.pid}));setInterval(()=>{},10)");
  assert.equal(result.success, true);
  assert.ok(result.launch_to_ready_ms >= 0);
  assert.ok(result.idle_tree_rss_KiB > 0);
  assert.throws(() => process.kill(result.pid, 0), { code: 'ESRCH' });
});
test('timeout also reaps a TERM-resistant descendant after its parent exits', { timeout: 5000 }, async () => {
  const start = performance.now();
  const result = await fake("require('node:child_process').spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},10)\"],{stdio:'inherit'});setInterval(()=>{},10)");
  assert.equal(result.success, false);
  assert.equal(result.timed_out, true);
  assert.ok(performance.now() - start < 3000);
});
import { seedQueue } from './startup-baseline.mjs';
import { execFileSync } from 'node:child_process';
test('empty and populated fixtures have identical schema and no runnable rows', () => {
  const root = mkdtempSync(join(tmpdir(), 'goop-startup-db-'));
  try {
    const schemas = [];
    for (const count of [0, 200]) {
      const path = join(root, `${count}.db`);
      seedQueue(path, count);
      schemas.push(execFileSync('/usr/bin/sqlite3', [path, '.schema'], { encoding: 'utf8' }));
      assert.equal(execFileSync('/usr/bin/sqlite3', [path, 'SELECT COUNT(*) FROM jobs'], { encoding: 'utf8' }).trim(), String(count));
      assert.equal(execFileSync('/usr/bin/sqlite3', [path, "SELECT COUNT(*) FROM jobs WHERE state != 'done' OR kind != 'convert'"], { encoding: 'utf8' }).trim(), '0');
    }
    assert.equal(schemas[0], schemas[1]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('launch settings remain valid with update and notification switches disabled', async () => {
  const result = await fake("const fs=require('node:fs'),path=require('node:path');const s=JSON.parse(fs.readFileSync(path.join(process.env.GOOP_CONFIG_DIR,'settings.json')));if(s.auto_check_updates!==false||s.yt_dlp_auto_update!==false||s.notifications_enabled!==false||s.theme!=='dark'||s.extract_concurrency!==2||s.convert_concurrency!==1)process.exit(2);fs.writeFileSync(process.env.GOOP_STARTUP_REPORT,JSON.stringify({schema_version:1,backend_ready_ms:1,pid:process.pid}));setInterval(()=>{},10)", { settings: { auto_check_updates: true, yt_dlp_auto_update: true, notifications_enabled: true, history_view_mode: 'invalid' } });
  assert.equal(result.success, true);
});
test('a ready marker cannot turn an absent process into a successful idle sample', async () => {
  const result = await fake("require('node:fs').writeFileSync(process.env.GOOP_STARTUP_REPORT,JSON.stringify({schema_version:1,backend_ready_ms:1,pid:process.pid}));setInterval(()=>{},10)", { readSnapshot: () => '1 0 123 init\n' });
  assert.ok(result.marker);
  assert.equal(result.success, false);
  assert.equal(result.idle_tree_rss_KiB, null);
});
