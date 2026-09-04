#!/usr/bin/env node
/**
 * Shared test harness for the migration-bridge integration tests.
 *
 * Usage:
 *   node --import tsx/esm tests/integration/_helpers/migration-harness.mjs \
 *     --legacy-root <abs-path> \
 *     --agent-root <abs-path> \
 *     [--dry-run]
 *
 * Why a Node ESM harness (not a .test.ts)?
 *   The .test.ts files in this repo go through the project's tsx test runner,
 *   which fans out one process per file. A dedicated harness gives us full
 *   control over argv parsing, process exit codes, and stdout/stderr
 *   separation — the contract the three .test.sh scripts assert against.
 *
 * Exit codes:
 *   0 - migration succeeded with zero errors (result.errors.length === 0)
 *   1 - migration completed but reported errors
 *   2 - usage error (missing or malformed arguments)
 */
import process from "node:process";

function parseArgs(argv) {
	const args = {
		legacyRoot: null,
		agentRoot: null,
		dryRun: false,
		help: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "--legacy-root": {
				const value = argv[++i];
				if (value === undefined) {
					throw new Error("--legacy-root requires a value");
				}
				args.legacyRoot = value;
				break;
			}
			case "--agent-root": {
				const value = argv[++i];
				if (value === undefined) {
					throw new Error("--agent-root requires a value");
				}
				args.agentRoot = value;
				break;
			}
			case "--dry-run":
				args.dryRun = true;
				break;
			case "-h":
			case "--help":
				args.help = true;
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return args;
}

function usage() {
	return [
		"Usage: migration-harness.mjs --legacy-root <abs-path> --agent-root <abs-path> [--dry-run]",
		"",
		"Runs migrateFromPiHermesMemory with explicit roots and prints the",
		"result as JSON to stdout.",
		"",
		"Exit codes:",
		"  0  migration succeeded (result.errors.length === 0)",
		"  1  migration reported errors",
		"  2  usage error",
		"",
	].join("\n");
}

async function main() {
	let args;
	try {
		args = parseArgs(process.argv.slice(2));
	} catch (err) {
		process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n\n${usage()}`);
		process.exit(2);
	}

	if (args.help) {
		process.stdout.write(`${usage()}\n`);
		process.exit(0);
	}

	if (!args.legacyRoot || !args.agentRoot) {
		process.stderr.write(
			`Error: --legacy-root and --agent-root are required.\n\n${usage()}`,
		);
		process.exit(2);
	}

	// The migration handler lives at src/handlers/migrate-from-pi-hermes-memory.ts.
	// tsx (loaded via --import tsx/esm) resolves the .js specifier to the .ts source.
	const mod = await import(
		"../../../src/handlers/migrate-from-pi-hermes-memory.js"
	);
	if (typeof mod.migrateFromPiHermesMemory !== "function") {
		process.stderr.write(
			"Error: migrateFromPiHermesMemory is not exported by the migration module.\n",
		);
		process.exit(2);
	}

	const result = await mod.migrateFromPiHermesMemory({
		legacyRoot: args.legacyRoot,
		agentRoot: args.agentRoot,
		dryRun: args.dryRun,
	});

	// Pretty-printed JSON: the .test.sh scripts grep specific keys in the
	// output, so the format must stay stable.
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

	if (result.errors.length > 0) {
		process.exit(1);
	}
	process.exit(0);
}

main().catch((err) => {
	const stack = err && typeof err === "object" && "stack" in err ? err.stack : String(err);
	process.stderr.write(`Harness crashed: ${stack}\n`);
	process.exit(1);
});
