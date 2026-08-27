#!/usr/bin/env bash
# Deploys worker/worker.js straight to Cloudflare via the REST API - no
# browser, no Git-triggered build (that pipeline has been unreliable for
# this account; this script is the durable fallback that always works).
# Requires CF_API_TOKEN in the environment - never commit that token.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${CF_API_TOKEN:-}" ]; then
  echo "Set CF_API_TOKEN first, e.g.: export CF_API_TOKEN=cfut_..." >&2
  exit 1
fi

ACCOUNT_ID="4c6c3934d60d7f89b0d79b4dddf0be5f"
SCRIPT_NAME="countmy-api"

TMP_META="$(mktemp)"
cat > "$TMP_META" <<'EOF'
{
  "main_module": "worker.js",
  "compatibility_date": "2026-08-27",
  "bindings": [
    {"type": "ai", "name": "AI"},
    {"type": "kv_namespace", "name": "COUNTMY_STATUS", "namespace_id": "453b08cd0db84e9e946d94e066f91f88"},
    {"type": "d1", "name": "COUNTMY_DB", "id": "73ec3c6d-1ed0-4a83-b909-da4413946855"}
  ]
}
EOF

curl -sS -X PUT "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${SCRIPT_NAME}" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -F "metadata=<${TMP_META};type=application/json" \
  -F "worker.js=@worker/worker.js;type=application/javascript+module"

rm -f "$TMP_META"
echo ""
echo "Deployed. Verify: curl -s https://countmy-api.boatengbobby.workers.dev/status?shop=x"
