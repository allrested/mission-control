#!/usr/bin/env bash
# Self-test for the reconciler's username sanitizer (devshell/reconcile-users.sh).
# No framework: replicates only the sanitize pipeline and asserts on it directly.
set -euo pipefail

sanitize() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_-' '_' | sed 's/^[^a-z0-9]*//'
}

# 1. Leading dash must never survive (would be parsed as an option by useradd/usermod/id).
r="$(sanitize '-x')"
[ -n "$r" ] || { echo "FAIL: -x sanitized to empty"; exit 1; }
case "$r" in -*) echo "FAIL: -x sanitized to '$r' (still leads with -)"; exit 1 ;; esac
echo "ok: -x -> $r"

# 2. Mixed case + space collapses to a single underscore.
r="$(sanitize 'Foo Bar')"
[ "$r" = "foo_bar" ] || { echo "FAIL: 'Foo Bar' -> '$r', expected foo_bar"; exit 1; }
echo "ok: Foo Bar -> $r"

# 3. Path traversal characters never survive.
r="$(sanitize 'a/../b')"
case "$r" in *[/.]*) echo "FAIL: 'a/../b' -> '$r' still contains / or ."; exit 1 ;; esac
echo "ok: a/../b -> $r"

# 4. An input that sanitizes to nothing but symbols must be rejected (empty after strip).
r="$(sanitize '!!!')"
[ -z "$r" ] || { echo "FAIL: '!!!' -> '$r', expected empty (caller must reject empty)"; exit 1; }
echo "ok: !!! -> '' (rejected)"

# 5. Unicode collapses to the safe charset only.
r="$(sanitize 'Ünïcödé😀')"
case "$r" in *[!a-z0-9_-]*) echo "FAIL: unicode input -> '$r' contains unsafe chars"; exit 1 ;; esac
echo "ok: unicode -> $r"

echo "ALL PASS"
