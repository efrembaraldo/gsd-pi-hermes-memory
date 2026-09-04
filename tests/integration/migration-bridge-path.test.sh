#!/usr/bin/env bash
# Integration: bridge path test
#
# Verifies that migrateFromPiHermesMemory moves the top-level markdown files
# (MEMORY.md / USER.md / failures.md / STANDING.md) from the legacy root
# (~/.pi/agent/pi-hermes-memory) to the new agent root (~/.gsd/agent)
# with byte-identical content.
#
# This is the "happy path" contract: the most basic migration scenario.
# Idempotency is covered by migration-bridge-idempotent.test.sh;
# SQLite retention by migration-bridge-retention.test.sh.
#
# Exit codes:
#   0 - all 4 files present at the new root with byte-identical content
#   1 - any assertion failed
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

legacy_root="$tmp/.pi/agent/pi-hermes-memory"
agent_root="$tmp/.gsd/agent"

# Pre-create the agent root. The migration's Phase 1 does fs.rename without
# mkdir-recursive, so an absent target directory produces ENOENT errors
# (Phase 4 / migrateExtensionRoot creates the target as a fallback, but
# the errors stay in result.errors). The harness exits non-zero on
# errors and `set -e` would abort the test. Pre-creating matches the
# production scenario where the extension has already been initialised
# at least once.
mkdir -p "$agent_root"
mkdir -p "$legacy_root"

# Synthetic fixture — 1-2 entries per file, delimited by § (the
# project's standard entry delimiter). Heredoc with quoted EOF so
# $variables and `command` are passed through literally.
cat > "$legacy_root/MEMORY.md" <<'EOF'
# MEMORY
§
- First memory entry
§
- Second memory entry
EOF

cat > "$legacy_root/USER.md" <<'EOF'
# USER
§
- prefers concise output
§
- writes in Italian
EOF

cat > "$legacy_root/failures.md" <<'EOF'
# FAILURES
§
- 2024-12-01: test suite hung on shutdown
EOF

cat > "$legacy_root/STANDING.md" <<'EOF'
# STANDING
§
- Always check git status before commit
EOF

# Capture pre-migration content for bytewise comparison. We compare
# against the captured expected bytes (not a re-read of the legacy
# file, which would be empty after migration).
expected_memory="$(cat "$legacy_root/MEMORY.md")"
expected_user="$(cat "$legacy_root/USER.md")"
expected_failures="$(cat "$legacy_root/failures.md")"
expected_standing="$(cat "$legacy_root/STANDING.md")"

# Run the harness. We pass --legacy-root and --agent-root explicitly so
# paths.ts / os.homedir() do not leak the real user home into the test.
# HOME and GSD_CODING_AGENT_DIR are belt-and-suspenders for any module
# that reads them at import time (paths.ts captures GSD_CODING_AGENT_DIR
# on first import; LEGACY_PI_HERMES_ROOT captures os.homedir()).
HOME="$tmp" \
	GSD_CODING_AGENT_DIR="$agent_root" \
	node --import tsx/esm \
		"$repo_root/tests/integration/_helpers/migration-harness.mjs" \
		--legacy-root "$legacy_root" \
		--agent-root "$agent_root"

# Assert each file landed at the new root with identical content.
for f in MEMORY.md USER.md failures.md STANDING.md; do
	target="$agent_root/$f"
	if [[ ! -f "$target" ]]; then
		echo "FAIL: $target was not created" >&2
		exit 1
	fi
done

actual_memory="$(cat "$agent_root/MEMORY.md")"
actual_user="$(cat "$agent_root/USER.md")"
actual_failures="$(cat "$agent_root/failures.md")"
actual_standing="$(cat "$agent_root/STANDING.md")"

fail=0
if [[ "$actual_memory" != "$expected_memory" ]]; then
	echo "FAIL: MEMORY.md content mismatch" >&2
	diff <(printf '%s' "$expected_memory") <(printf '%s' "$actual_memory") >&2 || true
	fail=1
fi
if [[ "$actual_user" != "$expected_user" ]]; then
	echo "FAIL: USER.md content mismatch" >&2
	diff <(printf '%s' "$expected_user") <(printf '%s' "$actual_user") >&2 || true
	fail=1
fi
if [[ "$actual_failures" != "$expected_failures" ]]; then
	echo "FAIL: failures.md content mismatch" >&2
	diff <(printf '%s' "$expected_failures") <(printf '%s' "$actual_failures") >&2 || true
	fail=1
fi
if [[ "$actual_standing" != "$expected_standing" ]]; then
	echo "FAIL: STANDING.md content mismatch" >&2
	diff <(printf '%s' "$expected_standing") <(printf '%s' "$actual_standing") >&2 || true
	fail=1
fi

if [[ "$fail" -ne 0 ]]; then
	exit 1
fi

echo "PASS: 4 top-level files migrated with byte-identical content"
exit 0
