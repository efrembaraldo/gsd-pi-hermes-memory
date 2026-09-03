#!/usr/bin/env node
/**
 * Link `@gsd/pi-*` (workspace-only sub-packages of the gsd-pi monorepo) into
 * the standard `node_modules/@gsd/<pkg>` location by creating relative
 * directory symlinks that point into the `node_modules/@opengsd/gsd-pi/packages/`
 * subtree installed via the regular `@opengsd/gsd-pi` npm dependency.
 *
 * Why symlinks instead of vendor copies:
 *   - One source of truth: the npm-published `@opengsd/gsd-pi` package. No
 *     extra disk copy, no per-build drift between vendor/ and the actual
 *     installed tree.
 *   - `npm install` is self-sufficient: no `GSD_PI_CHECKOUT` env var, no
 *     separate build step before `tsc` / `tsx --test` can resolve `@gsd/*`.
 *   - Idempotent: re-running on an already-linked tree is a no-op and prints
 *     a single diagnostic line. Safe to wire into `precheck`, `pretest`, and
 *     `prepublishOnly` without side-effect cost.
 *
 * Preconditions (both must hold or the script exits 1 with a diagnostic):
 *   1. `node_modules/@opengsd/gsd-pi/` exists (i.e. `@opengsd/gsd-pi` was
 *      actually installed by npm). If missing, the user is told to
 *      `npm install`.
 *   2. The installed `@opengsd/gsd-pi` version is >= `MIN_GSDPI_VERSION`
 *      (currently `1.17.0`). Below the floor, the user is told which version
 *      was found and which range satisfies it.
 *
 * Output (stdout, structured):
 *   - `[link-pi-sdks] linked N/3 symlinks (from @opengsd/gsd-pi@X.Y.Z, min 1.17.0)` — on a real (re)link
 *   - `[link-pi-sdks] 3/3 symlinks already ready (from @opengsd/gsd-pi@X.Y.Z, min 1.17.0), skipping` — on idempotent no-op
 *   - `[link-pi-sdks] FAIL: …` — on any precondition failure (exit 1)
 *
 * Diagnostics for a future agent (D004):
 *   - `ls -la node_modules/@gsd/` lists the three symlinks
 *   - `readlink node_modules/@gsd/<pkg>` returns the relative target
 *   - `node -p "require('./node_modules/@opengsd/gsd-pi/package.json').version"` returns the installed version
 */

import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	symlinkSync,
	unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const NM = join(ROOT, "node_modules");
const GSD_SCOPE = join(NM, "@gsd");
const GSDPI_PKG = join(NM, "@opengsd", "gsd-pi");

/**
 * The npm-published wrapper that ships the workspace packages as a
 * single tarball. The floor below matches the lower bound of the
 * `dependencies["@opengsd/gsd-pi"]` range in package.json — keeping
 * them in lockstep prevents the "installed satisfies package.json but
 * is older than the script allows" trap.
 */
const MIN_GSDPI_VERSION = "1.17.0";

/**
 * The three workspace sub-packages actually imported by this extension's
 * source code (`src/`). Adding a new entry here must be paired with adding
 * the `@gsd/<name>` import to a TypeScript file, otherwise the link is dead
 * weight.
 */
const PACKAGES = ["pi-coding-agent", "pi-ai", "pi-tui"];

/**
 * Parse an X.Y.Z version string into a numeric tuple.
 * Accepts a leading range operator (`^`, `~`) by stripping non-digits.
 * Returns [NaN, …] for malformed input; callers should treat NaN as
 * "unparseable" rather than relying on numeric comparisons.
 *
 * @param {string} v
 * @returns {[number, number, number]}
 */
function parseVersion(v) {
	const cleaned = String(v).replace(/[^0-9.]/g, "");
	const parts = cleaned.split(".");
	const nums = [0, 0, 0];
	for (let i = 0; i < 3; i += 1) {
		const n = Number(parts[i]);
		nums[i] = Number.isFinite(n) ? n : NaN;
	}
	return /** @type {[number, number, number]} */ (nums);
}

/**
 * Numeric three-part semver comparison. Returns -1 if `a < b`, 0 if equal,
 * 1 if `a > b`. Only the first three components are considered — pre-release
 * tags (`-rc.1`, `-beta.2`) are ignored because the floor we're enforcing is
 * a stable release.
 *
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1}
 */
function compareVersions(a, b) {
	const [a1, a2, a3] = parseVersion(a);
	const [b1, b2, b3] = parseVersion(b);
	if (a1 !== b1) return a1 < b1 ? -1 : 1;
	if (a2 !== b2) return a2 < b2 ? -1 : 1;
	if (a3 !== b3) return a3 < b3 ? -1 : 1;
	return 0;
}

/**
 * Build the relative symlink target that lives in
 * `node_modules/@gsd/<name>` and points at
 * `node_modules/@opengsd/gsd-pi/packages/<name>`.
 *
 * @param {string} name
 * @returns {string}
 */
function relativeTarget(name) {
	// From node_modules/@gsd/ the parent is node_modules/.
	return join("..", "@opengsd", "gsd-pi", "packages", name);
}

/**
 * Snapshot the current link state for diagnostics + idempotency check.
 * Returns an object per package: `{ name, linkPath, exists, isSymlink,
 * target }`. The `target` is `null` when the entry doesn't exist or isn't
 * a symlink.
 *
 * @returns {Array<{ name: string, linkPath: string, exists: boolean, isSymlink: boolean, target: string | null }>}
 */
function inspectLinks() {
	return PACKAGES.map((name) => {
		const linkPath = join(GSD_SCOPE, name);
		const exists = existsSync(linkPath);
		let isSymlink = false;
		let target = /** @type {string | null} */ (null);
		if (exists) {
			try {
				isSymlink = lstatSync(linkPath).isSymbolicLink();
				if (isSymlink) target = readlinkSync(linkPath);
			} catch {
				// treat unreadable symlink as "not a symlink" for idempotency
				isSymlink = false;
			}
		}
		return { name, linkPath, exists, isSymlink, target };
	});
}

/**
 * Idempotency predicate: every entry is a symlink with the exact relative
 * target we would create. Used to short-circuit and emit the
 * `already ready` diagnostic instead of touching the filesystem.
 *
 * @returns {boolean}
 */
function allSymlinksReady() {
	const expected = relativeTarget; // bind for closure
	return inspectLinks().every(
		(e) => e.isSymlink && e.target === expected(e.name),
	);
}

/**
 * Read the installed `@opengsd/gsd-pi` version. Caller must ensure
 * `GSDPI_PKG` exists; this helper reads + parses. A read or JSON-parse
 * failure here means the installed tree is corrupt (partial install,
 * truncated file, hand-edited package.json) — surface that as a FAIL
 * rather than letting `JSON.parse` throw an opaque `SyntaxError`.
 *
 * @returns {string}
 */
function readInstalledVersion() {
	const pkgPath = join(GSDPI_PKG, "package.json");
	let raw;
	try {
		raw = readFileSync(pkgPath, "utf-8");
	} catch (err) {
		fail(
			`[link-pi-sdks] FAIL: could not read ${pkgPath}: ${err && err.message ? err.message : String(err)}`,
		);
	}
	let pkg;
	try {
		pkg = JSON.parse(raw);
	} catch (err) {
		fail(
			`[link-pi-sdks] FAIL: could not parse ${pkgPath}: ${err && err.message ? err.message : String(err)}`,
		);
	}
	if (!pkg || typeof pkg.version !== "string") {
		fail(
			`[link-pi-sdks] FAIL: ${pkgPath} is missing a string \`version\` field`,
		);
	}
	return pkg.version;
}

function fail(message) {
	// Print on a dedicated channel so callers / CI can grep `[link-pi-sdks] FAIL`.
	console.error(message);
	process.exit(1);
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

if (!existsSync(GSDPI_PKG)) {
	fail(
		`[link-pi-sdks] FAIL: @opengsd/gsd-pi not installed at ${GSDPI_PKG}; run npm install`,
	);
}

const installed = readInstalledVersion();
if (compareVersions(installed, MIN_GSDPI_VERSION) < 0) {
	fail(
		`[link-pi-sdks] FAIL: @opengsd/gsd-pi@${installed} < ${MIN_GSDPI_VERSION}; install @opengsd/gsd-pi@^${MIN_GSDPI_VERSION}`,
	);
}

if (allSymlinksReady()) {
	console.log(
		`[link-pi-sdks] 3/3 symlinks already ready (from @opengsd/gsd-pi@${installed}, min ${MIN_GSDPI_VERSION}), skipping`,
	);
	process.exit(0);
}

// Reconcile: ensure @gsd/ scope directory exists, then for each package
// remove any pre-existing entry (file, directory, dangling symlink, or
// stale symlink with wrong target) and create the relative directory
// symlink fresh. Doing the unlink defensively makes the script tolerant
// of partial state left by older install strategies (vendor copy +
// different symlink target).
mkdirSync(GSD_SCOPE, { recursive: true });

let linked = 0;
for (const name of PACKAGES) {
	const linkPath = join(GSD_SCOPE, name);
	const target = relativeTarget(name);

	// `lstatSync` (NOT `existsSync`) is required here: `existsSync` follows
	// symlinks, so a broken/dangling symlink reports `false` and the
	// subsequent `symlinkSync` fails with EEXIST. `lstatSync` inspects the
	// entry itself — file, dir, or any kind of symlink — without following.
	let preExisting = false;
	try {
		lstatSync(linkPath);
		preExisting = true;
	} catch {
		preExisting = false;
	}

	if (preExisting) {
		try {
			unlinkSync(linkPath);
		} catch {
			// ignore: unlink failed (permissions, etc.) — symlinkSync will
			// surface a clearer error below
		}
	}

	symlinkSync(target, linkPath, "dir");
	linked += 1;
}

console.log(
	`[link-pi-sdks] linked ${linked}/${PACKAGES.length} symlinks (from @opengsd/gsd-pi@${installed}, min ${MIN_GSDPI_VERSION})`,
);
