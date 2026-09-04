#!/usr/bin/env node
/**
 * Type-check the extension against the OLDEST Pi SDK we claim to support.
 *
 * Why this exists: `dependencies["@opengsd/gsd-pi"]` is the only thing telling a
 * user whether this extension works on their Pi, and nothing verified it.
 * Historically the declared floor had drifted to `>=0.74.0` while
 * `src/handlers/review-memory-ops.ts` imports `@gsd/pi-ai/compat`, a subpath
 * that did not exist before 0.80.1 — so anyone on 0.74-0.79.x got
 * ERR_PACKAGE_PATH_NOT_EXPORTED and no extension at all, with nothing in CI to
 * catch it.
 *
 * The regular `check` job structurally cannot catch this: it installs whatever
 * the devDependency range resolves to, which is always new enough.
 *
 * Run: node scripts/check-min-sdk.mjs
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCOPE = "@gsd";
// pi-tui is a direct dependency rather than a peer, but its types cross the
// boundary (ExtensionCommandContext.ui.custom takes a pi-tui TUI). Leaving it
// at a different version yields a duplicate-private-property error instead of
// a real finding, so it moves with the floor.
const FLOOR_PACKAGES = [`${SCOPE}/pi-coding-agent`, `${SCOPE}/pi-ai`, `${SCOPE}/pi-tui`];

const scopeDir = path.join(repoRoot, "node_modules", SCOPE);
const stashDir = path.join(repoRoot, "node_modules", `${SCOPE}.real`);

function restore() {
  // Idempotent: safe to call from the finally block and from signal handlers.
  try {
    if (existsSync(stashDir)) {
      if (existsSync(scopeDir)) unlinkSync(scopeDir);
      renameSync(stashDir, scopeDir);
    }
  } catch (error) {
    console.error(
      `\nFAILED TO RESTORE node_modules/${SCOPE}. Run: mv "${stashDir}" "${scopeDir}"\n`,
      error,
    );
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { restore(); process.exit(130); });
}

let pkg;
try {
  pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf-8"));
} catch (error) {
  console.error(`[check-min-sdk] FAIL: cannot parse package.json: ${error.message}`);
  process.exit(1);
}
// After S01 the floor is declared via `dependencies["@opengsd/gsd-pi"]` (a
// version range like "^1.17.0"); see T01 for the migration rationale.
const range = pkg.dependencies?.["@opengsd/gsd-pi"];
const floor = /(\d+\.\d+\.\d+)/.exec(range ?? "")?.[1];
if (!floor) {
  console.error(`[check-min-sdk] FAIL: dependencies["@opengsd/gsd-pi"] range "${range}" has no explicit floor — pin one like "^1.17.0"`);
  process.exit(1);
}

console.log(`Minimum supported @opengsd/gsd-pi: ${floor} (nests ${FLOOR_PACKAGES.map((n) => `${n}@${floor}`).join(", ")} under packages/)`);

const scratch = mkdtempSync(path.join(tmpdir(), "pi-hermes-min-sdk-"));
let failed = false;
try {
  writeFileSync(path.join(scratch, "package.json"), `${JSON.stringify({ name: "min-sdk-probe", private: true })}\n`);
  // Pin the allow-scripts setting in the scratch .npmrc. npm 11+ treats a
  // global `npm config set allow-scripts=…` as a project-scoped `--allow-scripts`
  // flag and rejects it with EALLOWSCRIPTS unless the project (or its .npmrc)
  // declares its own `allow-scripts`. We don't need any scripts to run for
  // type-checking, so allow nothing here.
  writeFileSync(path.join(scratch, ".npmrc"), `allow-scripts=false\n`);
  // The sub-packages listed in FLOOR_PACKAGES are nested inside the
  // `@opengsd/gsd-pi` tarball at `packages/<name>/` (see scripts/link-pi-sdks.mjs
  // for the dev-install wiring) and are NOT published as standalone packages
  // on npm — installing them directly (`npm install @gsd/pi-coding-agent@…`)
  // 404s. Install only the parent and point the swap symlink at its nested
  // packages/ directory, which is the same shape link-pi-sdks.mjs produces
  // for the dev install.
  const parentSpec = `@opengsd/gsd-pi@${floor}`;
  console.log(`Installing ${parentSpec} ...`);
  execFileSync("npm", ["install", "--silent", "--no-audit", "--no-fund", "--no-package-lock", parentSpec], {
    cwd: scratch,
    stdio: ["ignore", "ignore", "inherit"],
    // Strip npm_* env vars inherited from `npm run` — the parent npm process
    // injects `npm_config_allow_scripts`, which npm 11+ treats as a
    // project-scoped `--allow-scripts` flag and rejects with EALLOWSCRIPTS
    // unless the project (or its .npmrc) declares its own. We only need the
    // packages on disk for type-checking, so the cleanest fix is to give the
    // child npm a config-free environment; the scratch .npmrc above is the
    // only allow-scripts authority the child sees.
    env: (() => {
      const filtered = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (k === "npm_config_allow_scripts" || k === "npm_lifecycle_event" || k === "npm_lifecycle_script" || k === "npm_command" || k === "npm_execpath") continue;
        filtered[k] = v;
      }
      return filtered;
    })(),
  });

  // Swap the scope in place so the project's own tsconfig applies unchanged —
  // no divergent probe config that could drift from what `npm run check` uses.
  //
  // Compatibility note (post-S01): scopeDir (`node_modules/@gsd/`) now contains
  // 3 symlinks created by scripts/link-pi-sdks.mjs that point at
  // `node_modules/@opengsd/gsd-pi/packages/*`. The stash/swap below is unchanged
  // because `renameSync` moves the scope directory itself (the symlinks are
  // entries *inside* it, not targets of the swap) and `stashDir` lives at
  // `node_modules/@gsd.real` — a sibling path that does not collide with any
  // symlink, so the original state is fully restored by `restore()` even if the
  // probe install fails.
  renameSync(scopeDir, stashDir);
  symlinkSync(path.join(scratch, "node_modules", "@opengsd", "gsd-pi", "packages"), scopeDir);

  console.log("Type-checking src against the minimum SDK ...");
  execFileSync(path.join(repoRoot, "node_modules", ".bin", "tsc"), ["--noEmit"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  console.log(`OK — src type-checks against ${SCOPE}/pi-coding-agent@${floor}`);
} catch (error) {
  failed = true;
  if (!/Command failed/.test(String(error?.message))) console.error(error);
  console.error(
    `\nsrc does NOT type-check against the declared minimum (${floor}).\n`
    + "Either raise the dependencies[\"@opengsd/gsd-pi\"] floor in package.json to a version that works,\n"
    + "or stop using the SDK API that is missing at that version.\n",
  );
} finally {
  restore();
  rmSync(scratch, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
