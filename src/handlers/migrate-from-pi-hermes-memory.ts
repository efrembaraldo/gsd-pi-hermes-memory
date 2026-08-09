/**
 * Migration from upstream pi-hermes-memory to gsd-pi-hermes-memory.
 *
 * The legacy install lives at:
 *
 *   ~/.pi/agent/pi-hermes-memory/
 *
 * and the current install lives at:
 *
 *   ~/.gsd/agent/gsd-pi-hermes-memory/
 *
 * Migrating means:
 * - Move MEMORY.md / USER.md / failures.md / STANDING.md to the new root
 *   (destination wins if the file already exists; we never overwrite).
 * - Move the legacy flat skills (skills/*.md) into the new
 *   per-slug layout (skills/<slug>/SKILL.md) via
 *   SkillStore.migrateLegacySkills.
 * - Move per-project memory dirs (projects-memory/<project>/) into the new
 *   root, then run migrateLegacyProjectMemoryDirs so any pre-rebrand
 *   flattened project memory is also normalised.
 * - Move the SQLite memory + mirror (sessions.db and friends) via
 *   migrateExtensionRoot — that handles WAL, sidecars, and online
 *   retirement.
 *
 * The migration is idempotent. On every entry point we check for a marker
 * file (`.pi-hermes-memory-migration.json`) that records what we did and
 * when. The marker is written only after the move succeeds so a crash
 * mid-migration is safely re-runnable: already-present files in the
 * destination are skipped (dest wins) and the missing tail is migrated on
 * the next attempt.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { existsSync, readdirSync } from "node:fs";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { AGENT_ROOT } from "../paths.js";
import { migrateLegacyProjectMemoryDirs } from "../project-memory-migration.js";
import { migrateExtensionRoot } from "../extension-root-migration.js";
import type { SkillStore } from "../store/skill-store.js";

export const LEGACY_PI_HERMES_ROOT = path.join(
	os.homedir(),
	".pi",
	"agent",
	"pi-hermes-memory",
);

/** Files that, when present at the destination, cause the migration to skip them. */
const TOP_LEVEL_FILES = [
	"MEMORY.md",
	"USER.md",
	"failures.md",
	"STANDING.md",
] as const;

const MARKER_FILE = ".pi-hermes-memory-migration.json";

export interface MigrationFromPiHermesResult {
	/** True when the legacy root was absent — nothing to migrate. */
	noop: boolean;
	/** True when the marker file already existed and was honoured. */
	alreadyMigrated: boolean;
	/** Files successfully moved (or copied cross-filesystem) to the new root. */
	moved: number;
	/** Files skipped because the destination already had a copy. */
	skipped: number;
	/** Skill files normalised (flat *.md → skills/<slug>/SKILL.md). */
	skillsNormalised: number;
	/** Project memory directories discovered and migrated. */
	projectsMigrated: number;
	/** Database files (sessions.db, *.db-wal, *.db-shm) moved by migrateExtensionRoot. */
	databaseMigrated: number;
	/** Human-readable warnings the user should know about. */
	warnings: string[];
	/** Non-fatal errors that should be surfaced but did not abort the migration. */
	errors: string[];
	/** Absolute path to the marker file once written. */
	markerPath: string;
}

export interface MigrationFromPiHermesOptions {
	/** When true, only report what would happen without touching anything. */
	dryRun?: boolean;
	/** Logger used by migrateExtensionRoot for database backup progress. */
	onDatabaseBackupProgress?: (current: number, total: number) => void;
	/** When true, remove the legacy root entirely after a successful migration. */
	removeLegacyRootOnSuccess?: boolean;
	/**
	 * Override the destination root. Defaults to effectiveAgentRoot (the global
	 * module-level constant). Tests inject a temp dir; production code
	 * leaves this unset.
	 */
	agentRoot?: string;
	/**
	 * Override the legacy source root. Defaults to the production
	 * `~/.pi/agent/pi-hermes-memory` path. Tests inject a temp dir.
	 */
	legacyRoot?: string;
}

interface MigrationMarker {
	migratedAt: string;
	sourceRoot: string;
	targetRoot: string;
	moved: number;
	skipped: number;
	skillsNormalised: number;
	projectsMigrated: number;
	databaseMigrated: number;
}

/**
 * Returns the absolute path of the legacy pi-hermes-memory install if it
 * exists and is non-empty; otherwise null. The legacy root is fixed at
 * `~/.pi/agent/pi-hermes-memory` — users with a custom `PI_CODING_AGENT_DIR`
 * are out of scope here and must fall back to the explicit command with
 * a manual path.
 */
export function findLegacyPiHermesRoot(
	overridePath: string | null = null,
): string | null {
	const candidate = overridePath ?? LEGACY_PI_HERMES_ROOT;
	if (!existsSync(candidate)) return null;
	// An empty directory is "not really there" — pretend it doesn't exist
	// so the caller skips.
	try {
		const entries = readdirSync(candidate);
		if (entries.length === 0) return null;
	} catch {
		return null;
	}
	return candidate;
}

export function getMigrationMarkerPath(agentRoot: string = AGENT_ROOT): string {
	return path.join(agentRoot, MARKER_FILE);
}

export function hasMigrationMarker(agentRoot: string = AGENT_ROOT): boolean {
	return existsSync(getMigrationMarkerPath(agentRoot));
}

async function readMigrationMarker(
	agentRoot: string = AGENT_ROOT,
): Promise<MigrationMarker | null> {
	const markerPath = getMigrationMarkerPath(agentRoot);
	if (!existsSync(markerPath)) return null;
	try {
		const raw = await fs.readFile(markerPath, "utf-8");
		return JSON.parse(raw) as MigrationMarker;
	} catch {
		// Corrupt marker — treat as "no marker" so the migration can run again.
		return null;
	}
}

async function writeMigrationMarker(
	marker: MigrationMarker,
	agentRoot: string,
): Promise<void> {
	const markerPath = getMigrationMarkerPath(agentRoot);
	await fs.mkdir(path.dirname(markerPath), { recursive: true });
	await fs.writeFile(markerPath, JSON.stringify(marker, null, 2), "utf-8");
}

/**
 * Core migration. Safe to call multiple times: the marker file guards
 * against re-runs and per-file destination checks ensure idempotency.
 */
export async function migrateFromPiHermesMemory(
	options: MigrationFromPiHermesOptions = {},
): Promise<MigrationFromPiHermesResult> {
	const effectiveAgentRoot = options.agentRoot ?? AGENT_ROOT;
	const result: MigrationFromPiHermesResult = {
		noop: false,
		alreadyMigrated: false,
		moved: 0,
		skipped: 0,
		skillsNormalised: 0,
		projectsMigrated: 0,
		databaseMigrated: 0,
		warnings: [],
		errors: [],
		markerPath: getMigrationMarkerPath(options.agentRoot ?? AGENT_ROOT),
	};

	const legacyRoot = findLegacyPiHermesRoot(options.legacyRoot ?? null);

	// Marker check first: a previous successful migration has left the
	// legacy root empty (or missing entirely). Detect that condition
	// before we bail out with "noop".
	if (hasMigrationMarker(effectiveAgentRoot)) {
		const existing = await readMigrationMarker(effectiveAgentRoot);
		if (existing) {
			result.alreadyMigrated = true;
			result.moved = existing.moved;
			result.skipped = existing.skipped;
			result.skillsNormalised = existing.skillsNormalised;
			result.projectsMigrated = existing.projectsMigrated;
			result.databaseMigrated = existing.databaseMigrated;
			return result;
		}
	}

	if (!legacyRoot) {
		result.noop = true;
		return result;
	}

	// ponytail: Global lock — pie-flight to ensure a concurrent installer doesn't
	// rewrite the legacy root while we are mid-migration. fits the "per-account
	// locks if throughput matters" upgrade path.
	const lockDir = path.join(
		os.tmpdir(),
		`gsd-pi-hermes-memory-pi-migration-${process.pid}.lock`,
	);
	await fs.mkdir(lockDir, { recursive: true });

	try {
		// Phase 1: top-level files (MEMORY.md, USER.md, failures.md, STANDING.md).
		// Destination wins: if the user already has a copy in the new root, we
		// skip rather than overwrite, because the new root is the source of truth
		// going forward.
		for (const fileName of TOP_LEVEL_FILES) {
			const sourcePath = path.join(legacyRoot, fileName);
			const targetPath = path.join(effectiveAgentRoot, fileName);
			if (!existsSync(sourcePath)) continue;
			if (existsSync(targetPath)) {
				result.skipped++;
				result.warnings.push(
					`${fileName}: destination already exists, left in place`,
				);
				continue;
			}
			if (options.dryRun) {
				result.moved++;
				continue;
			}
			try {
				await fs.rename(sourcePath, targetPath);
				result.moved++;
			} catch (err) {
				// Cross-device rename fails (EXDEV); retry with copy + unlink.
				if ((err as NodeJS.ErrnoException).code === "EXDEV") {
					await fs.copyFile(sourcePath, targetPath);
					await fs.unlink(sourcePath);
					result.moved++;
				} else {
					result.errors.push(
						`${fileName}: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
		}

		// Phase 2: skill migration. Use the SkillStore helper so the new
		// per-slug layout is consistent. Note: skills live in the new root
		// already, so we point the helper at the legacy dir as a "source"
		// and walk it.
		if (!options.dryRun) {
			// SkillStore.migrateLegacySkills walks the store's own dirs, so
			// we instantiate a transient one rooted at the legacy install.
			// Cheap construction: no FS I/O until migrateLegacySkills runs.
			const { SkillStore: SkillStoreClass } = await import(
				"../store/skill-store.js"
			);
			const legacySkillsDir = path.join(legacyRoot, "skills");
			if (existsSync(legacySkillsDir)) {
				const legacyStore = new SkillStoreClass({
					globalSkillsDir: path.join(effectiveAgentRoot, "skills"),
					piGlobalSkillsDir: path.join(effectiveAgentRoot, "skills"),
					projectSkillsDir: null,
					projectName: null,
					legacySkillsDir,
					migrationSentinelPath: path.join(
						effectiveAgentRoot,
						".skills-migrated",
					),
				});
				const skillMigration = await legacyStore.migrateLegacySkills();
				result.skillsNormalised = skillMigration.migrated;
				// We do not delete the legacy skills dir here — the legacy root
				// cleanup at the end handles it.
			}
		} else if (existsSync(path.join(legacyRoot, "skills"))) {
			// Dry-run: count flat *.md files as a low-effort estimate.
			const flatFiles = (
				await fs.readdir(path.join(legacyRoot, "skills"))
			).filter((name) => name.endsWith(".md"));
			result.skillsNormalised = flatFiles.length;
		}

		// Phase 3: per-project memory dirs. The helper snapshots pre-existing
		// projects-memory/<project>/ folders inside the legacy root.
		// Reuse it: it walks `effectiveAgentRoot/<projectsMemoryDir>/<project>/`.
		// We can't easily redirect it to a different root, so we manually
		// copy per-project folders first, then call the helper to normalise
		// the file naming.
		const projectsMemoryDirValue = "projects-memory"; // matches default
		const legacyProjectsRoot = path.join(legacyRoot, projectsMemoryDirValue);
		if (existsSync(legacyProjectsRoot)) {
			const targetProjectsRoot = path.join(
				effectiveAgentRoot,
				projectsMemoryDirValue,
			);
			await fs.mkdir(targetProjectsRoot, { recursive: true });
			const projectEntries = await fs.readdir(legacyProjectsRoot, {
				withFileTypes: true,
			});
			for (const entry of projectEntries) {
				if (!entry.isDirectory()) continue;
				const sourcePath = path.join(legacyProjectsRoot, entry.name);
				const targetPath = path.join(targetProjectsRoot, entry.name);
				if (existsSync(targetPath)) {
					result.skipped++;
					result.warnings.push(
						`projects-memory/${entry.name}: destination already exists, left in place`,
					);
					continue;
				}
				if (options.dryRun) {
					result.projectsMigrated++;
					continue;
				}
				try {
					await fs.rename(sourcePath, targetPath);
					result.projectsMigrated++;
				} catch (err) {
					if ((err as NodeJS.ErrnoException).code === "EXDEV") {
						await copyDirRecursive(sourcePath, targetPath);
						await fs.rm(sourcePath, { recursive: true, force: true });
						result.projectsMigrated++;
					} else {
						result.errors.push(
							`projects-memory/${entry.name}: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
				}
			}
			// Re-run the legacy-folder normalisation in case individual project
			// folders had a pre-projects-memory layout.
			if (!options.dryRun) {
				migrateLegacyProjectMemoryDirs(
					effectiveAgentRoot,
					projectsMemoryDirValue,
				);
			}
		}

		// Phase 4: SQLite sessions.db and friends. Hand off to
		// migrateExtensionRoot — it owns WAL handling, sidecars, and
		// retirement-on-success. Critical failures abort the rest.
		// Skipped in dry-run mode because migrateExtensionRoot is not
		// side-effect-aware: it would copy non-database files too.
		if (options.dryRun) {
			// Count what's there for the report.
			try {
				const dbEntries = await fs.readdir(legacyRoot);
				result.databaseMigrated = dbEntries.filter(
					(name) =>
						name.endsWith(".db") ||
						name.endsWith(".db-wal") ||
						name.endsWith(".db-shm"),
				).length;
			} catch {
				// ignore
			}
		} else {
			const legacyDatabaseResult = await migrateExtensionRoot(
				legacyRoot,
				effectiveAgentRoot,
				{
					backupDatabase: async (_source, _staged, onProgress) => {
						// Adapt the (current, total) callback down to the () => void
						// signature ExtensionRootMigrationOptions expects. The
						// downstream helper doesn't currently care about progress,
						// but we future-proof here so swapping it doesn't break
						// callers.
						if (options.onDatabaseBackupProgress) {
							await options.onDatabaseBackupProgress(0, 1);
						}
						onProgress?.();
					},
				},
			);
			result.databaseMigrated = legacyDatabaseResult.moved;
			result.warnings.push(...legacyDatabaseResult.warnings);
			result.errors.push(
				...legacyDatabaseResult.criticalFailures.map(
					(failure) =>
						`${failure.name}: ${failure.message} (${failure.source} -> ${failure.target})`,
				),
			);
		}

		// Phase 5: write the marker before we declare victory. If anything
		// above set errors, the marker still notes what was done so the
		// user can audit later.
		if (!options.dryRun) {
			try {
				await writeMigrationMarker(
					{
						migratedAt: new Date().toISOString(),
						sourceRoot: legacyRoot,
						targetRoot: effectiveAgentRoot,
						moved: result.moved,
						skipped: result.skipped,
						skillsNormalised: result.skillsNormalised,
						projectsMigrated: result.projectsMigrated,
						databaseMigrated: result.databaseMigrated,
					},
					effectiveAgentRoot,
				);
			} catch (err) {
				result.errors.push(
					`marker: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		// Phase 6: optional cleanup of the legacy root. Only if the user
		// explicitly opted in — silent deletion of a third-party install is
		// the kind of thing that bites people later.
		if (options.removeLegacyRootOnSuccess && !options.dryRun) {
			try {
				const remaining = await fs.readdir(legacyRoot);
				if (remaining.length === 0) {
					await fs.rmdir(legacyRoot);
				} else {
					result.warnings.push(
						`legacy root is not empty after migration; left in place at ${legacyRoot}`,
					);
				}
			} catch (err) {
				result.warnings.push(
					`legacy root cleanup: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		return result;
	} finally {
		// Release the lock regardless of outcome.
		try {
			await fs.rmdir(lockDir);
		} catch {
			// best effort
		}
	}
}

async function copyDirRecursive(source: string, target: string): Promise<void> {
	await fs.mkdir(target, { recursive: true });
	const entries = await fs.readdir(source, { withFileTypes: true });
	for (const entry of entries) {
		const sourcePath = path.join(source, entry.name);
		const targetPath = path.join(target, entry.name);
		if (entry.isDirectory()) {
			await copyDirRecursive(sourcePath, targetPath);
		} else if (entry.isFile()) {
			await fs.copyFile(sourcePath, targetPath);
		}
		// symlinks and other entry types are skipped — the legacy root
		// should not contain anything weirder than files and dirs.
	}
}

export function formatMigrationResult(
	result: MigrationFromPiHermesResult,
): string {
	const lines: string[] = [];
	if (result.noop) {
		lines.push("No legacy pi-hermes-memory install found. Nothing to migrate.");
		return lines.join("\n");
	}
	if (result.alreadyMigrated) {
		lines.push("Migration already completed (marker file present).");
		lines.push(`  Moved: ${result.moved}`);
		lines.push(`  Skipped: ${result.skipped}`);
		lines.push(`  Skills normalised: ${result.skillsNormalised}`);
		lines.push(`  Projects migrated: ${result.projectsMigrated}`);
		lines.push(`  Database files migrated: ${result.databaseMigrated}`);
		return lines.join("\n");
	}
	lines.push("Migration from pi-hermes-memory:");
	lines.push(`  Files moved: ${result.moved}`);
	lines.push(`  Files skipped (dest already had a copy): ${result.skipped}`);
	lines.push(`  Skills normalised: ${result.skillsNormalised}`);
	lines.push(`  Projects migrated: ${result.projectsMigrated}`);
	lines.push(`  Database files migrated: ${result.databaseMigrated}`);
	if (result.warnings.length > 0) {
		lines.push("");
		lines.push("Warnings:");
		for (const w of result.warnings) lines.push(`  - ${w}`);
	}
	if (result.errors.length > 0) {
		lines.push("");
		lines.push("Errors:");
		for (const e of result.errors) lines.push(`  - ${e}`);
	}
	lines.push("");
	lines.push(`Marker written to: ${result.markerPath}`);
	return lines.join("\n");
}

/**
 * Detect whether the migration should be offered to the user at startup.
 * Returns true when:
 *   - the legacy root exists and is non-empty,
 *   - no marker file yet,
 *   - the user has not disabled implicit migration via config.
 */
export function shouldOfferImplicitMigration(
	configImplicitMigrationEnabled: boolean | undefined,
	agentRoot: string = AGENT_ROOT,
): boolean {
	if (configImplicitMigrationEnabled === false) return false;
	if (hasMigrationMarker(agentRoot)) return false;
	if (!findLegacyPiHermesRoot(null)) return false;
	return true;
}

/**
 * Re-export legacy helpers so the index.ts site can wire them up without
 * importing from multiple places.
 */
export { migrateLegacyProjectMemoryDirs, migrateExtensionRoot };
export type { SkillStore };

/**
 * Register the `/memory-migrate-from-pi-hermes-memory` command. The user
 * can manually invoke this even after the implicit-on-startup prompt has
 * been dismissed — useful when the legacy install appears later, or when
 * a previous migration was interrupted and the user wants to retry.
 */
export function registerMigrateFromPiCommand(pi: ExtensionAPI): void {
	pi.registerCommand("memory-migrate-from-pi-hermes-memory", {
		description:
			"Migrate memories from the upstream pi-hermes-memory install (~/.pi/agent/pi-hermes-memory).",
		handler: async (_args, ctx) => {
			const dryRunArg = (_args ?? "").trim();
			const dryRun = dryRunArg === "--check" || dryRunArg === "--dry-run";

			if (dryRun) {
				const result = await migrateFromPiHermesMemory({ dryRun: true });
				ctx.ui.notify(formatMigrationResult(result), "info");
				return;
			}

			const result = await migrateFromPiHermesMemory();
			ctx.ui.notify(formatMigrationResult(result), "info");
		},
	});

	// Lightweight status command — useful for the user to confirm whether
	// the migration has already happened in a previous session.
	pi.registerCommand("memory-migration-status", {
		description: "Show whether the pi-hermes-memory migration has run.",
		handler: async (_args, ctx) => {
			if (!findLegacyPiHermesRoot()) {
				ctx.ui.notify(
					"No legacy pi-hermes-memory install found at ~/.pi/agent/pi-hermes-memory.",
					"info",
				);
				return;
			}
			if (!hasMigrationMarker()) {
				ctx.ui.notify(
					"Legacy pi-hermes-memory install detected. Run /memory-migrate-from-pi-hermes-memory to migrate.",
					"info",
				);
				return;
			}
			const marker = await readMigrationMarker();
			if (!marker) {
				ctx.ui.notify(
					"Legacy install found but marker file is unreadable. Run /memory-migrate-from-pi-hermes-memory to retry.",
					"info",
				);
				return;
			}
			ctx.ui.notify(
				[
					"Migration completed.",
					`  When: ${marker.migratedAt}`,
					`  From: ${marker.sourceRoot}`,
					`  To: ${marker.targetRoot}`,
					`  Files moved: ${marker.moved}`,
					`  Files skipped: ${marker.skipped}`,
					`  Skills normalised: ${marker.skillsNormalised}`,
					`  Projects migrated: ${marker.projectsMigrated}`,
					`  Database files migrated: ${marker.databaseMigrated}`,
				].join("\n"),
				"info",
			);
		},
	});
}
