#!/bin/bash
# Fails if any tracked file (plus new, unignored ones) contains a credential-shaped string:
# webhook signing secrets, encrypted values, provider API keys, Watcher API keys, private
# keys, cloud/GitHub/Slack tokens, or a 32-byte base64 key. The lockfile and generated
# migration snapshots are skipped (integrity hashes look like keys).
set -u
cd "$(dirname "$0")/.."
PATTERN='whsec_[0-9a-f]{20,}|enc:v1:[0-9a-f]{16}:[A-Za-z0-9_-]{8,}:|sk-(proj-)?[A-Za-z0-9_-]{20,}|wk_[A-Za-z0-9_-]{20,}|re_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36}|xox[baprs]-[A-Za-z0-9-]{10,}|hooks\.slack\.com/services/T[A-Z0-9]{8,}/B[A-Z0-9]{8,}/[A-Za-z0-9]{20,}|(^|[^A-Za-z0-9+/])[A-Za-z0-9+/]{43}=($|[^A-Za-z0-9+/=])'
files=$( { git ls-files; git ls-files --others --exclude-standard; } | grep -vE '^(package-lock\.json|drizzle/meta/.*\.json)$|\.(png|jpe?g|gif|ico|svg|woff2?)$' | sort -u)
hits=$(printf '%s\n' "$files" | while IFS= read -r f; do [ -f "$f" ] && grep -nIE "$PATTERN" -- "$f" | sed "s|^|$f:|" | cut -c1-160; done)
if [ -n "$hits" ]; then
  echo "Credential-shaped strings found:"; echo "$hits"; exit 1
fi
echo "Secret scan: no credential-shaped strings in $(printf '%s\n' "$files" | wc -l | tr -d ' ') files."
