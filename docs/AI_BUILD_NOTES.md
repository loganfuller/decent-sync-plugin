# AI Build Notes

Read this when installing, testing, versioning, or releasing the plugin. There is no build step: `manifest.json` and `plugin.js` are what Decaid runs.

## Dev Harness (default test path)

```bash
node --check plugin.js
node scripts/dev-harness.mjs --simulate               # 15 s, then exits
node scripts/dev-harness.mjs --seconds 0              # until Ctrl-C
DECENT=192.168.4.33 SERVER_URL=ws://127.0.0.1:8799/sync node scripts/dev-harness.mjs
```

The harness evaluates `plugin.js` with a stand-in `host` and a `fetch` that rewrites `localhost:8080` to the machine at `DECENT`. It reads the real machine's API but changes nothing on the tablet. `--simulate` dispatches two `stateUpdate` events and a `shotStored` for the latest shot.

It does not reproduce Decaid's transport limits, permission checks, event cadence, or QuickJS differences. Confirm anything touching those on a tablet.

Run a scratch server alongside: `PORT=8799 DATA_DIR=/tmp/ds node server.mjs` in `decent-sync-server`. The harness identifies as the same `machineId` as the real tablet; never point it at a server holding real data while the tablet is also connected, or the two sessions replace each other (close code 4409).

## Installing on a Tablet

Ask first. Then:

```bash
scripts/install-plugin.sh <decent-ip> ws://<server-ip>:8787/sync "<machine name>"
AUTH_TOKEN=... scripts/install-plugin.sh ...
```

The script does three calls against `http://<decent-ip>:8080/api/v1/plugins/decent-sync.reaplugin`:

1. `PUT /source` with the manifest and source. Only `manifest.json` and `plugin.js` are uploaded. A loaded plugin is swapped transactionally and restored if the new source fails to load (500).
2. `POST /settings`, which reloads the plugin if loaded.
3. `POST /enable`, which loads it and turns on auto-load.

Check the result on the server terminal (`connected`, collections, `shot index`). `GET /api/v1/plugins` shows `loaded` and `autoLoad`.

## Versioning

- `manifest.json` `version` and `VERSION` in `plugin.js` move together, as semver.
- `PUT /source` rejects a lower version with 409; an equal version is accepted. Bump the version for anything that will be installed on more than one machine.
- Adding a permission makes automatic updates wait for approval (`pendingUpdate`, `POST /api/v1/plugins/:id/update/approve`).

## Releases (once a GitHub remote exists)

Decaid can install and auto-update from GitHub, because the plugin is at the repo root:

```bash
curl -X POST http://<decent-ip>:8080/api/v1/plugins/install/github-branch \
  -H 'content-type: application/json' -d '{"repo": "<owner>/decent-sync-plugin", "branch": "main"}'
```

For release installs, tag `vX.Y.Z` equal to the manifest version and attach exactly one `.zip` holding `manifest.json` and `plugin.js`, flat or inside one folder. Branch installs update on every commit. Release installs update on every new tag. Never tag or publish without explicit approval.
