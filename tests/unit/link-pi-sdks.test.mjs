#!/usr/bin/env node
/**
 * node:test suite for `scripts/link-pi-sdks.mjs`.
 *
 * Written as plain `.mjs` (not `.ts`) on purpose: this test exercises a
 * build-time shell of the project (the symlink linker), and we want it to
 * run with the stock `node --test` runner — no tsx dependency, no
 * TypeScript toolchain, no transpile step. It also acts as a contract that
 * the linker keeps working even if the rest of the repo's `.ts` toolchain
 * is broken.
 *
 * Layout convention: tests live under `tests/`, scripts under `scripts/`.
 * The project root is two levels up from this file.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	readFileSync,
	readlinkSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const SCRIPT = join(ROOT, "scripts", "link-pi-sdks.mjs");
const GSDPI_PKG_JSON = join(ROOT, "node_modules", "@opengsd", "gsd-pi", "package.json");
const GSD_SCOPE = join(ROOT, "node_modules", "@gsd");

const PACKAGES = ["pi-coding-agent", "pi-ai", "pi-tui"];
const MIN_VERSION = "1.17.0";

/**
 * Run the linker script as a child process, returning both stdout and
 * stderr. The script is invoked via `node` directly (no tsx) to keep
 * this test isolated from the project's TS toolchain.
 *
 * @param {{ env?: Record<string, string> | undefined }} [opts]
 * @returns {{ code: number, stdout: string, stderr: string }}
 */
function runLinker(opts = {}) {
	try {
		const stdout = execFileSync("node", [SCRIPT], {
			cwd: ROOT,
			env: { ...process.env, ...(opts.env ?? {}) },
			stdio: ["ignore", "pipe", "pipe"],
			encoding: "utf-8",
		});
		return { code: 0, stdout: String(stdout ?? ""), stderr: "" };
	} catch (err) {
		return {
			code: typeof err?.status === "number" ? err.status : 1,
			stdout: err?.stdout ? String(err.stdout) : "",
			stderr: err?.stderr ? String(err.stderr) : "",
		};
	}
}

/**
 * Compare two X.Y.Z strings numerically — duplicates `compareVersions`
 * from the linker but exposed here so the test can reason about the
 * floor directly without re-implementing semver parsing in every case.
 *
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1}
 */
function cmpVersion(a, b) {
	const [a1 = 0, a2 = 0, a3 = 0] = String(a)
		.replace(/[^0-9.]/g, "")
		.split(".")
		.map((n) => Number(n));
	const [b1 = 0, b2 = 0, b3 = 0] = String(b)
		.replace(/[^0-9.]/g, "")
		.split(".")
		.map((n) => Number(n));
	if (a1 !== b1) return a1 < b1 ? -1 : 1;
	if (a2 !== b2) return a2 < b2 ? -1 : 1;
	if (a3 !== b3) return a3 < b3 ? -1 : 1;
	return 0;
}

/**
 * Read the version field of an installed `@gsd/<pkg>` via its symlink.
 * Throws if the package.json is missing or malformed — both are real
 * regressions and should fail this suite loudly.
 *
 * @param {string} name
 * @returns {string}
 */
function readLinkedPkgVersion(name) {
	const pkgJson = JSON.parse(
		readFileSync(join(GSD_SCOPE, name, "package.json"), "utf-8"),
	);
	assert.equal(pkgJson.name, `@gsd/${name}`, `linked ${name} name mismatch`);
	assert.equal(typeof pkgJson.version, "string", `linked ${name} has no version`);
	return pkgJson.version;
}

// ---------------------------------------------------------------------------
// Sanity: precondition for the whole file
// ---------------------------------------------------------------------------

test("precondition: @opengsd/gsd-pi is installed", () => {
	assert.ok(
		existsSync(GSDPI_PKG_JSON),
		`expected ${GSDPI_PKG_JSON} to exist — run \`npm install\` first`,
	);
	const pkg = JSON.parse(readFileSync(GSDPI_PKG_JSON, "utf-8"));
	assert.ok(
		cmpVersion(pkg.version, MIN_VERSION) >= 0,
		`installed @opengsd/gsd-pi@${pkg.version} must satisfy floor ${MIN_VERSION}`,
	);
});

// ---------------------------------------------------------------------------
// Test 1 — idempotent run leaves state unchanged
// ---------------------------------------------------------------------------

test("idempotent run leaves state unchanged", () => {
	const first = runLinker();
	// The first run may either create or short-circuit; either way it must
	// succeed and the symlink targets must match the canonical relative
	// path. We don't assert on the diagnostic text here — that's covered
	// by the dedicated tests below — only on the resulting filesystem state.
	assert.equal(first.code, 0, `first run failed: ${first.stderr}`);

	const afterFirst = PACKAGES.map((name) => ({
		name,
		target: readlinkSync(join(GSD_SCOPE, name)),
	}));
	for (const { name, target } of afterFirst) {
		assert.equal(
			target,
			join("..", "@opengsd", "gsd-pi", "packages", name),
			`${name} symlink target drifted after first run`,
		);
	}

	const second = runLinker();
	assert.equal(second.code, 0, `second run failed: ${second.stderr}`);
	assert.match(
		second.stdout,
		/\[link-pi-sdks\] 3\/3 symlinks already ready/,
		`second run must emit the idempotent diagnostic, got: ${second.stdout}`,
	);

	const afterSecond = PACKAGES.map((name) => ({
		name,
		target: readlinkSync(join(GSD_SCOPE, name)),
	}));
	assert.deepEqual(
		afterSecond,
		afterFirst,
		"idempotent run changed symlink targets",
	);
});

// ---------------------------------------------------------------------------
// Test 2 — 3 symlinks exist and are dir symlinks
// ---------------------------------------------------------------------------

test("3 symlinks exist and are directory symlinks", () => {
	for (const name of PACKAGES) {
		const linkPath = join(GSD_SCOPE, name);
		assert.ok(existsSync(linkPath), `${linkPath} does not exist`);
		// `lstatSync` (not `statSync`) so we inspect the symlink itself
		// rather than following it — a dangling symlink would otherwise
		// report `isSymbolicLink() === false`.
		assert.equal(
			lstatSync(linkPath).isSymbolicLink(),
			true,
			`${linkPath} is not a symbolic link`,
		);
		// Following the link must resolve to a directory (the linked
		// package source tree). `statSync` follows symlinks by default,
		// which is what we want here — `lstatSync.isDirectory()` would
		// always be `false` because the symlink itself is not a dir.
		assert.equal(
			statSync(linkPath).isDirectory(),
			true,
			`${linkPath} does not resolve to a directory`,
		);
	}
});

// ---------------------------------------------------------------------------
// Test 3 — target package.json reachable and valid
// ---------------------------------------------------------------------------

test("target package.json reachable and valid (>= MIN_VERSION)", () => {
	for (const name of PACKAGES) {
		const version = readLinkedPkgVersion(name);
		assert.ok(
			cmpVersion(version, MIN_VERSION) >= 0,
			`@gsd/${name}@${version} does not satisfy floor ${MIN_VERSION}`,
		);
	}
});

// ---------------------------------------------------------------------------
// Test 4 — MIN_GSDPI_VERSION guard rejects older versions
// ---------------------------------------------------------------------------

test("MIN_GSDPI_VERSION guard rejects older versions", () => {
	const originalRaw = readFileSync(GSDPI_PKG_JSON, "utf-8");
	const originalPkg = JSON.parse(originalRaw);
	const originalVersion = originalPkg.version;
	const tampered = { ...originalPkg, version: "1.16.0" };

	try {
		writeFileSync(GSDPI_PKG_JSON, `${JSON.stringify(tampered, null, 2)}\n`);

		const result = runLinker();
		assert.equal(result.code, 1, "linker must exit 1 on version below floor");
		assert.match(
			result.stderr,
			/\[link-pi-sdks\] FAIL:.*1\.17\.0/,
			`stderr must mention the floor 1.17.0, got: ${result.stderr}`,
		);
		assert.match(
			result.stderr,
			/1\.16\.0/,
			`stderr must mention the installed 1.16.0, got: ${result.stderr}`,
		);
	} finally {
		// Restore verbatim — preserving whitespace so subsequent reads
		// don't observe a diff caused by the test itself.
		writeFileSync(GSDPI_PKG_JSON, originalRaw);
		// Sanity: the restored file parses and reports the original
		// version. If this assertion fails, the test is not safe to run
		// again until the operator investigates the corrupted state.
		const restored = JSON.parse(readFileSync(GSDPI_PKG_JSON, "utf-8"));
		assert.equal(
			restored.version,
			originalVersion,
			`failed to restore ${GSDPI_PKG_JSON} after tampering test`,
		);
	}
});
