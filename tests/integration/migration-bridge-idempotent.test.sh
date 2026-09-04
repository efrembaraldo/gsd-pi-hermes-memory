#!/usr/bin/env bash
# Integration: bridge idempotent test
#
# Verifies that running migrateFromPiHermesMemory twice in a row is safe:
#   1. Second run reports "alreadyMigrated": true in the JSON output.
#   2. The marker file (~/.gsd/agent/.pi-hermes-memory-migration.json)
#      is written and read back consistently.
#   3. Top-level files are NOT duplicated at the destination.
#   4. Existing file content is NOT rewritten by the second run.
#
# The marker check in src/handlers/migrate-from-pi-hermes-memory.ts runs
# BEFORE the legacy-root check, so even when the legacy root is empty
# after the first run (top-level files moved out), the second run still
# returns alreadyMigrated=true instead of noop=true.
#
# Exit codes:
#   0 - all idempotency invariants hold
#   1 - any assertion failed
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

legacy_root="$tmp/.pi/agent/pi-hermes-memory"
agent_root="$tmp/.gsd/agent"

# Pre-create the agent root so Phase 1's fs.rename doesn't trip on the
# missing target directory. See migration-bridge-path.test.sh for the
# full rationale; same reasoning applies here.
mkdir -p "$agent_root"
mkdir -p "$legacy_root"

cat > "$legacy_root/MEMORY.md" <<'EOF'
# MEMORY
§
- idempotency check entry
EOF

cat > "$legacy_root/USER.md" <<'EOF'
# USER
§
- first run target user
EOF

marker="$agent_root/.pi-hermes-memory-migration.json"

run_harness() {
	HOME="$tmp" \
		GSD_CODING_AGENT_DIR="$agent_root" \
		node --import tsx/esm \
			"$repo_root/tests/integration/_helpers/migration-harness.mjs" \
			--legacy-root "$legacy_root" \
			--agent-root "$agent_root"
}

# First run — should move files and write the marker.
first_output="$(run_harness)"

# First run must NOT report alreadyMigrated.
if printf '%s' "$first_output" | grep -q '"alreadyMigrated": true'; then
	echo "FAIL: first run reported alreadyMigrated=true" >&2
	printf '%s\n' "$first_output" >&2
	exit 1
fi

# Marker file must be present after first run.
if [[ ! -f "$marker" ]]; then
	echo "FAIL: marker file missing after first run: $marker" >&2
	exit 1
fi

# Snapshot MEMORY.md before the second run so we can detect any rewrite.
pre_second_md5="$(md5sum "$agent_root/MEMORY.md" | awk '{print $1}')"

# Second run — should report alreadyMigrated=true and skip work.
second_output="$(run_harness)"

if ! printf '%s' "$second_output" | grep -q '"alreadyMigrated": true'; then
	echo "FAIL: second run did not report alreadyMigrated=true" >&2
	printf '%s\n' "$second_output" >&2
	exit 1
fi

# The moved count in the second run should mirror the marker.
second_moved="$(printf '%s' "$second_output" \
	| sed -n 's/^[[:space:]]*"moved":[[:space:]]*\([0-9][0-9]*\),.*$/\1/p')"
if [[ "$second_moved" != "2" ]]; then
	echo "FAIL: second run moved=$second_moved (expected 2)" >&2
	exit 1
fi

# MEMORY.md content must be unchanged after the second run.
post_second_md5="$(md5sum "$agent_root/MEMORY.md" | awk '{print $1}')"
if [[ "$pre_second_md5" != "$post_second_md5" ]]; then
	echo "FAIL: MEMORY.md was modified by second run" >&2
	echo "  before: $pre_second_md5" >&2
	echo "  after:  $post_second_md5" >&2
	exit 1
fi

# Files must not be duplicated. After the first run, MEMORY.md and
# USER.md must have been moved out of the legacy root, and a single
# copy of each must exist at the agent root.
for f in MEMORY.md USER.md; do
	if [[ -f "$legacy_root/$f" ]]; then
		echo "FAIL: $f still present at legacy root after first run" >&2
		exit 1
	fi
	count="$(find "$agent_root" -maxdepth 1 -name "$f" | wc -l | tr -d ' ')"
	if [[ "$count" != "1" ]]; then
		echo "FAIL: $f present $count times at agent root (expected 1)" >&2
		exit 1
	fi
done

echo "PASS: migration is idempotent (marker present, no duplicates, content stable)"
exit 0
