/**
 * Tests for migrate-from-pi-hermes-memory.
 *
 * The migration runs against the real filesystem so we exercise the
 * atomic rename + marker file path. Tests isolate themselves with a
 * throwaway AGENT_ROOT and a fake legacy root.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The module is re-imported per test against the freshly stubbed
// GSD_CODING_AGENT_DIR. We don't import the static module here because
// `AGENT_ROOT` is captured at module load time.

// Each test gets a fresh agentRoot directory. The migration accepts
// `agentRoot` as an option so we don't fight module-load-time constants.
async function setupAgentRoot(): Promise<{
	dir: string;
	fresh: typeof import("../../src/handlers/migrate-from-pi-hermes-memory.js");
}> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-mig-test-"));
	// ESM cache-bust the module so each test gets a fresh import of the
	// helpers. The agentRoot is passed explicitly via the option bag.
	const cacheBust = `?ts=${Date.now()}-${Math.random()}`;
	const fresh = (await import(
		`../../src/handlers/migrate-from-pi-hermes-memory.js${cacheBust}`
	)) as typeof import("../../src/handlers/migrate-from-pi-hermes-memory.js");
	return { dir, fresh };
}

describe("migrateFromPiHermesMemory", () => {
	let agentRoot: string;
	let legacyRoot: string;
	let fresh: typeof import("../../src/handlers/migrate-from-pi-hermes-memory.js");

	const previousAgentRoot = process.env.GSD_CODING_AGENT_DIR;
	const previousHome = process.env.HOME;

	beforeEach(async () => {
		// The module reads $HOME for the legacy root — stub it into a temp
		// directory so we don't touch the real ~/.pi/agent.
		const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-mig-home-"));
		process.env.HOME = homeDir;
		process.env.USERPROFILE = homeDir;
		const setup = await setupAgentRoot();
		agentRoot = setup.dir;
		fresh = setup.fresh;
		legacyRoot = path.join(homeDir, ".pi", "agent", "pi-hermes-memory");
		await fs.mkdir(legacyRoot, { recursive: true });
	});

	afterEach(async () => {
		// Restore env vars before nuking the temp dirs so other tests
		// outside this suite aren't affected.
		if (previousAgentRoot === undefined) {
			delete process.env.GSD_CODING_AGENT_DIR;
		} else {
			process.env.GSD_CODING_AGENT_DIR = previousAgentRoot;
		}
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
	});

	it("returns noop when the legacy root is absent", async () => {
		await fs.rm(legacyRoot, { recursive: true, force: true });
		const result = await fresh.migrateFromPiHermesMemory({ agentRoot, legacyRoot });
		assert.equal(result.noop, true);
		assert.equal(result.moved, 0);
	});

	it("moves MEMORY.md, USER.md, failures.md, STANDING.md into the new root", async () => {
		await fs.writeFile(
			path.join(legacyRoot, "MEMORY.md"),
			"agent memory",
			"utf-8",
		);
		await fs.writeFile(
			path.join(legacyRoot, "USER.md"),
			"user profile",
			"utf-8",
		);
		await fs.writeFile(
			path.join(legacyRoot, "failures.md"),
			"failures",
			"utf-8",
		);
		await fs.writeFile(path.join(legacyRoot, "STANDING.md"), "rules", "utf-8");

		const result = await fresh.migrateFromPiHermesMemory({ agentRoot, legacyRoot });

		assert.equal(result.moved, 4);
		assert.equal(result.skipped, 0);
		assert.equal(
			await fs.readFile(path.join(agentRoot, "MEMORY.md"), "utf-8"),
			"agent memory",
		);
		assert.equal(
			await fs.readFile(path.join(agentRoot, "USER.md"), "utf-8"),
			"user profile",
		);
		assert.equal(
			await fs.readFile(path.join(agentRoot, "failures.md"), "utf-8"),
			"failures",
		);
		assert.equal(
			await fs.readFile(path.join(agentRoot, "STANDING.md"), "utf-8"),
			"rules",
		);
		// Legacy files are gone.
		assert.equal(fsSync.existsSync(path.join(legacyRoot, "MEMORY.md")), false);
	});

	it("skips files when the destination already has a copy", async () => {
		await fs.writeFile(path.join(legacyRoot, "MEMORY.md"), "new", "utf-8");
		await fs.writeFile(path.join(agentRoot, "MEMORY.md"), "existing", "utf-8");

		const result = await fresh.migrateFromPiHermesMemory({ agentRoot, legacyRoot });

		assert.equal(result.moved, 0);
		assert.equal(result.skipped, 1);
		assert.equal(
			await fs.readFile(path.join(agentRoot, "MEMORY.md"), "utf-8"),
			"existing",
		);
		assert.match(
			result.warnings.join("\n"),
			/MEMORY\.md: destination already exists/,
		);
	});

	it("writes the marker file on success and is idempotent", async () => {
		await fs.writeFile(
			path.join(legacyRoot, "MEMORY.md"),
			"agent memory",
			"utf-8",
		);

		const first = await fresh.migrateFromPiHermesMemory({ agentRoot, legacyRoot });
		assert.equal(first.moved, 1);
		assert.equal(fresh.hasMigrationMarker(agentRoot), true);

		const second = await fresh.migrateFromPiHermesMemory({ agentRoot, legacyRoot });
		assert.equal(second.alreadyMigrated, true);
		assert.equal(second.moved, 1);
		// second run is a no-op for filesystem state.
	});

	it("migrates per-project memory directories", async () => {
		const projectDir = path.join(legacyRoot, "projects-memory", "myproject");
		await fs.mkdir(projectDir, { recursive: true });
		await fs.writeFile(
			path.join(projectDir, "MEMORY.md"),
			"project-scoped",
			"utf-8",
		);

		const result = await fresh.migrateFromPiHermesMemory({ agentRoot, legacyRoot });

		assert.equal(result.projectsMigrated, 1);
		assert.equal(
			await fs.readFile(
				path.join(agentRoot, "projects-memory", "myproject", "MEMORY.md"),
				"utf-8",
			),
			"project-scoped",
		);
	});

	it("dry-run reports what would happen without touching anything", async () => {
		await fs.writeFile(
			path.join(legacyRoot, "MEMORY.md"),
			"agent memory",
			"utf-8",
		);

		const result = await fresh.migrateFromPiHermesMemory({ agentRoot, legacyRoot, dryRun: true });

		assert.equal(result.moved, 1);
		// File is still in the legacy root.
		assert.equal(fsSync.existsSync(path.join(legacyRoot, "MEMORY.md")), true);
		// Marker is not written on dry-run.
		assert.equal(fresh.hasMigrationMarker(agentRoot), false);
	});

	it("formatMigrationResult handles the noop case", () => {
		const output = fresh.formatMigrationResult({
			noop: true,
			alreadyMigrated: false,
			moved: 0,
			skipped: 0,
			skillsNormalised: 0,
			projectsMigrated: 0,
			databaseMigrated: 0,
			warnings: [],
			errors: [],
			markerPath: "/dev/null",
		});
		assert.match(output, /Nothing to migrate/);
	});

	it("does not throw when the legacy root is empty", async () => {
		// Empty directory should be treated as noop.
		const result = await fresh.migrateFromPiHermesMemory({ agentRoot, legacyRoot });
		assert.equal(result.noop, true);
	});
});
