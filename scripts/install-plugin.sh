#!/usr/bin/env bash
# Install (or update) the Decent Sync plugin on a Decaid machine over its REST API.
#
#   scripts/install-plugin.sh <decent-ip> <server-ws-url> [machine-name]
#   scripts/install-plugin.sh 192.168.4.33 ws://192.168.4.49:8787/sync "Home DE1Pro"
#
# Set AUTH_TOKEN in the environment to configure the plugin's secure token.
set -euo pipefail

DECENT=${1:?decent ip}
SERVER_URL=${2:?server ws url}
NAME=${3:-}
ID=decent-sync.reaplugin
DIR="$(cd "$(dirname "$0")/.." && pwd)"
API="http://$DECENT:8080/api/v1/plugins/$ID"

python3 - "$DIR" > /tmp/decent-sync-source.json <<'PY'
import json, sys, pathlib
d = pathlib.Path(sys.argv[1])
print(json.dumps({"manifest": json.loads((d / "manifest.json").read_text()),
                  "plugin": (d / "plugin.js").read_text()}))
PY

echo "→ uploading plugin source"
curl -fsS -X PUT "$API/source" -H 'content-type: application/json' --data @/tmp/decent-sync-source.json; echo
rm -f /tmp/decent-sync-source.json

echo "→ configuring settings"
SETTINGS=$(python3 -c 'import json,sys,os; s={"ServerUrl":sys.argv[1],"MachineName":sys.argv[2]}; t=os.environ.get("AUTH_TOKEN"); s.update({"AuthToken":t} if t else {}); print(json.dumps(s))' "$SERVER_URL" "$NAME")
curl -fsS -X POST "$API/settings" -H 'content-type: application/json' -d "$SETTINGS"; echo

echo "→ enabling"
curl -fsS -X POST "$API/enable"; echo
