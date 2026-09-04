#!/usr/bin/env bash
# Integration: bridge SQLite retention test
#
# Verifies that migrateFromPiHermesMemory preserves a SQLite database
# (sessions.db) across migration:
#   1. The file lands at the new root.
#   2. `PRAGMA integrity_check;` returns 'ok' (no corruption).
#   3. The data we wrote pre-migration is intact (row count + payload).
#
# The migration uses SQLite's online backup API internally
# (see src/extension-root-migration.ts → migrateDatabaseGeneration →
# backup source → staged file → fs.link to target), so the destination
# is a valid SQLite file even though we never opened the source DB
# during migration.
#
# Exit codes:
#   0 - DB migrated, integrity_check ok, row data preserved
#   1 - any assertion failed
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

legacy_root="$tmp/.pi/agent/pi-hermes-memory"
agent_root="$tmp/.gsd/agent"

# Pre-create the agent root so Phase 4 (migrateExtensionRoot) can stage
# the SQLite backup under `.sessions-db-migration-<uuid>/`. Without
# this, stageDatabaseSnapshot's `fs.lstat(staged)` fails with ENOENT
# because the staging directory's parent is missing. Same rationale
# as migration-bridge-path.test.sh.
mkdir -p "$agent_root"
mkdir -p "$legacy_root"

# Synthesize a sessions.db with one table and one row. better-sqlite3
# is a runtime dependency of this project (see package.json) so it's
# resolvable from cwd.
node -e '
const Database = require("better-sqlite3");
const target = process.argv[1];
const db = new Database(target);
db.exec("CREATE TABLE test_t (id INTEGER PRIMARY KEY, payload TEXT)");
db.prepare("INSERT INTO test_t (id, payload) VALUES (?, ?)").run(1, "retention-check");
db.close();
' "$legacy_root/sessions.db"

if [[ ! -f "$legacy_root/sessions.db" ]]; then
	echo "FAIL: failed to seed sessions.db at $legacy_root/sessions.db" >&2
	exit 1
fi

# Pre-migration sanity: confirm the seeded DB is healthy and the row
# is reachable. This isolates harness bugs from migration bugs.
seed_integrity="$(sqlite3 "$legacy_root/sessions.db" 'PRAGMA integrity_check;')"
if [[ "$seed_integrity" != "ok" ]]; then
	echo "FAIL: seed DB integrity_check='$seed_integrity' (expected ok)" >&2
	exit 1
fi

# Run the harness. We pass explicit roots so paths.ts / os.homedir()
# do not leak the real user home into the test.
HOME="$tmp" \
	GSD_CODING_AGENT_DIR="$agent_root" \
	node --import tsx/esm \
		"$repo_root/tests/integration/_helpers/migration-harness.mjs" \
		--legacy-root "$legacy_root" \
		--agent-root "$agent_root"

target_db="$agent_root/sessions.db"
if [[ ! -f "$target_db" ]]; then
	echo "FAIL: $target_db not created by migration" >&2
	exit 1
fi

# 1. integrity_check must be 'ok'. sqlite3 prints "ok" on success.
integrity="$(sqlite3 "$target_db" 'PRAGMA integrity_check;')"
if [[ "$integrity" != "ok" ]]; then
	echo "FAIL: integrity_check='$integrity' (expected 'ok')" >&2
	exit 1
fi

# 2. Row count must be 1 — no data loss.
count="$(sqlite3 "$target_db" 'SELECT count(*) FROM test_t;')"
if [[ "$count" != "1" ]]; then
	echo "FAIL: test_t row count='$count' (expected '1')" >&2
	exit 1
fi

# 3. Payload must be intact — no silent corruption.
payload="$(sqlite3 "$target_db" 'SELECT payload FROM test_t WHERE id = 1;')"
if [[ "$payload" != "retention-check" ]]; then
	echo "FAIL: test_t payload='$payload' (expected 'retention-check')" >&2
	exit 1
fi

echo "PASS: sessions.db migrated with integrity_check=ok and 1 row preserved"
exit 0
