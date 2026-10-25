#!/usr/bin/env node
// Print the oldest macOS Goop declares it runs on: bundle.macOS.minimumSystemVersion
// in src-tauri/tauri.conf.json. That key is the only place the number lives.
// The bundler writes it into Info.plist, and `tauri build` exports it as
// MACOSX_DEPLOYMENT_TARGET for its cargo build (tauri-build repeats it for the
// app crate); scripts/build-static-heif-deps.sh builds the static HEIC stack
// for it, and the workflows put it in that stack's cache key. On macOS runners
// the workflows also export it as MACOSX_DEPLOYMENT_TARGET, so plain cargo
// builds and tests compile their cc and cmake code for it as well.
//
// Usage:
//   node scripts/macos-deployment-target.mjs [path/to/tauri.conf.json]
//
// Exit 0 with the version on stdout. Exit 1, with nothing on stdout, when the
// key is missing or is not a dotted version, so a caller that substitutes the
// output can never build for, or cache under, an empty or default floor.

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULT_CONFIG = fileURLToPath(new URL("../src-tauri/tauri.conf.json", import.meta.url));
const KEY = "bundle.macOS.minimumSystemVersion";
// major.minor, optionally .patch: what LSMinimumSystemVersion, clang's
// -mmacosx-version-min and a Mach-O minos all accept. Nothing else, so the
// value is safe to pass to cmake and to put in a cache key.
const VERSION = /^\d+\.\d+(\.\d+)?$/;

export function deploymentTarget(config) {
  const value = config?.bundle?.macOS?.minimumSystemVersion;
  if (typeof value !== "string" || !VERSION.test(value)) {
    throw new Error(`${KEY} must be a macOS version such as "13.3", got ${JSON.stringify(value)}`);
  }
  return value;
}

function main(argv) {
  const path = argv[0] ?? DEFAULT_CONFIG;
  let config;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.error(`[macos-deployment-target] cannot read ${KEY} from ${path}: ${error.message}`);
    return 1;
  }
  try {
    process.stdout.write(`${deploymentTarget(config)}\n`);
    return 0;
  } catch (error) {
    console.error(`[macos-deployment-target] ${path}: ${error.message}`);
    return 1;
  }
}

// Run as a script, not when imported. Both sides are resolved through any
// symlinks: node already has for import.meta.url, but argv[1] is the path as
// typed, and a mismatch here would exit 0 having printed nothing.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
