#!/usr/bin/env bash
# Cherry-pick infrastructure: applies commits from an upstream
# pi-hermes-memory source onto this repo, idempotently.
#
# Why a manifest + script:
#   - Slices S03-S05 require multiple, repeatable cherry-picks from
#     upstream. Tracking them in a TSV makes the queue explicit and
#     auditable; codifying application in bash makes it deterministic.
#   - Idempotency: re-running is a no-op once a commit is already applied.
#     We detect "already applied" by scanning `git log` for the
#     `(cherry picked from commit <SHA>)` trailer that `git cherry-pick -x`
#     writes automatically.
#
# Preconditions:
#   1. We're inside a git work-tree (the script runs `git cherry-pick`).
#   2. The manifest file `scripts/cherry-pick.manifest` exists and is a
#      valid TSV (slug<TAB>ref<TAB>description).
#   3. The upstream source is reachable. Resolution order:
#        a. `$GSD_PI_HERMES_CHERRYPICK_REPO` env var (path or URL).
#        b. `git remote get-url pi-hermes-upstream`.
#        c. Otherwise the script fails with an actionable diagnostic.
#
# Usage:
#   bash scripts/cherry-pick.sh           # apply all non-empty entries
#   bash scripts/cherry-pick.sh --help    # print this block
#   bash scripts/cherry-pick.sh --list    # print manifest (dry run)
#
# Output (stdout, structured):
#   - `[cherry-pick] applied N/M entries from <repo>`              — real progress
#   - `[cherry-pick] M/M entries already applied, skipping`        — full no-op
#   - `[cherry-pick] 0/N applied, A already applied, P pending ref` — partial
#   - `[cherry-pick] FAIL: …`                                      — exit 1
#
# Per-slug log: `.cherry-pick-logs/<slug>.log` (gitignored).
#
# Diagnostics for a future agent:
#   - `cat .cherry-pick-logs/<slug>.log` to inspect a single run
#   - `git log --grep="cherry picked from commit <SHA>"` to verify presence
#   - `bash scripts/cherry-pick.sh --list` to inspect the queue

set -euo pipefail

# ----- constants
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
MANIFEST="$HERE/cherry-pick.manifest"
LOG_DIR="$ROOT/.cherry-pick-logs"
DEFAULT_REMOTE="pi-hermes-upstream"

# ----- helpers
log()  { printf '[cherry-pick] %s\n' "$*"; }
fail() { printf '[cherry-pick] FAIL: %s\n' "$*" >&2; exit 1; }

# Print the leading doc-block (this comment) with `#` markers stripped so
# the usage line in --help matches the file header verbatim.
usage() {
	sed -n '2,/^set -euo pipefail/p' "${BASH_SOURCE[0]}" \
		| sed -n '1,/^$/p' \
		| sed 's/^# \{0,1\}//'
}

# ----- arg parsing
case "${1:-}" in
	-h | --help)
		usage
		exit 0
		;;
	--list)
		[[ -f "$MANIFEST" ]] || fail "manifest not found: $MANIFEST"
		awk -F'\t' 'NF && $1 !~ /^#/ {
			ref = ($2 == "" ? "<pending>" : $2)
			printf "%s\t%s\t%s\n", $1, ref, $3
		}' "$MANIFEST"
		exit 0
		;;
	"")
		# Default invocation: fall through to the main loop below.
		;;
	*)
		fail "unknown argument: $1 (try --help)"
		;;
esac

# ----- preconditions
cd "$ROOT"
git rev-parse --git-dir >/dev/null 2>&1 || fail "not inside a git work-tree: $ROOT"
[[ -f "$MANIFEST" ]] || fail "manifest not found: $MANIFEST"

mkdir -p "$LOG_DIR"

# Validate ref shape: hex string 7..40 chars. Refusing anything else keeps
# us from feeding garbage to `git fetch <repo> <ref>` and ending up with a
# cryptic "couldn't find remote ref" message.
ref_is_valid() {
	[[ "$1" =~ ^[0-9a-f]{7,40}$ ]]
}

# Lazy upstream resolution: only fail with "no upstream configured" when we
# actually need to fetch. A manifest of all-placeholder entries must run
# cleanly even without a remote (S02 ships before S03+ populates real SHAs).
REPO=""
resolve_repo() {
	if [[ -n "$REPO" ]]; then
		return 0
	fi
	if [[ -n "${GSD_PI_HERMES_CHERRYPICK_REPO:-}" ]]; then
		REPO="$GSD_PI_HERMES_CHERRYPICK_REPO"
		return 0
	fi
	local repo_url
	if repo_url="$(git remote get-url "$DEFAULT_REMOTE" 2>/dev/null)" && [[ -n "$repo_url" ]]; then
		REPO="$repo_url"
		return 0
	fi
	return 1
}

# ----- main loop
applied=0
already=0
pending=0
total=0

# We iterate over raw manifest lines and split via `cut` rather than
# `while IFS=$'\t' read -r slug ref desc`. The latter runs into a POSIX
# quirk: when IFS is a whitespace character (tab included), bash treats
# runs of IFS whitespace as a single delimiter, so a line `slug\t\tdesc`
# collapses into two fields and `ref` swallows the description. `cut -f`
# doesn't have that behaviour — it counts tab delimiters literally.
while IFS= read -r line || [[ -n "$line" ]]; do
	# Skip blank lines and comment lines (lines starting with `#`).
	[[ -z "$line" || "$line" == \#* ]] && continue

	slug="$(printf '%s' "$line" | cut -f1)"
	ref="$(printf '%s' "$line"  | cut -f2)"
	desc="$(printf '%s' "$line" | cut -f3-)"

	total=$((total + 1))

	log_file="$LOG_DIR/$slug.log"
	: >"$log_file"
	log_line() {
		printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$log_file"
	}

	if [[ -z "$ref" ]]; then
		pending=$((pending + 1))
		log_line "skip: empty ref (placeholder); description='$desc'"
		continue
	fi

	if ! ref_is_valid "$ref"; then
		log_line "FAIL: malformed ref '$ref' (expected 7..40 hex chars)"
		fail "malformed ref in manifest: slug=$slug ref=$ref"
	fi

	# Lazy upstream resolution — only required when we have a real ref to fetch.
	if ! resolve_repo; then
		log_line "FAIL: no upstream configured (set \$GSD_PI_HERMES_CHERRYPICK_REPO or add remote '$DEFAULT_REMOTE')"
		fail "no upstream configured: set \$GSD_PI_HERMES_CHERRYPICK_REPO or add remote '$DEFAULT_REMOTE'"
	fi

	# idempotency: already applied?
	if git log --grep="cherry picked from commit $ref" --oneline -1 | grep -q .; then
		already=$((already + 1))
		log_line "skip: commit $ref already applied"
		continue
	fi

	# Fetch the commit by SHA. Works for both remote URLs and local paths
	# because `git fetch <repo> <refspec>` accepts either form.
	log_line "fetch $ref from $REPO"
	if ! git fetch --no-tags "$REPO" "$ref" 2>>"$log_file"; then
		log_line "FAIL: fetch failed (see $log_file)"
		fail "fetch $ref from $REPO failed (see $log_file)"
	fi

	# Apply. `--allow-empty` keeps the script idempotent against trivial
	# upstream changes; `--ff` would defeat the cherry-pick trailer.
	log_line "cherry-pick -x $ref"
	if ! git cherry-pick -x --allow-empty "$ref" >>"$log_file" 2>&1; then
		git cherry-pick --abort >>"$log_file" 2>&1 || true
		log_line "FAIL: cherry-pick produced conflicts; aborted"
		fail "cherry-pick $ref failed (conflicts; see $log_file)"
	fi

	applied=$((applied + 1))
	log_line "applied"
done < "$MANIFEST"

# ----- summary
if [[ "$total" -eq 0 ]]; then
	fail "manifest is empty: $MANIFEST"
fi

if [[ "$applied" -eq 0 && "$already" -gt 0 && "$pending" -eq 0 ]]; then
	log "$total/$total entries already applied, skipping"
elif [[ "$applied" -eq 0 ]]; then
	log "$total/$total entries processed: 0 applied, $already already applied, $pending pending ref"
else
	log "$applied/$total entries applied from $REPO ($already already applied, $pending pending ref)"
fi
