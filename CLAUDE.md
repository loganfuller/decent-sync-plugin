# CLAUDE.md

@AGENTS.md

## Quick Commands

```bash
node --check plugin.js                                       # syntax check
node scripts/dev-harness.mjs --simulate                      # run against the DE1 API + local server, no tablet changes
SERVER_URL=ws://127.0.0.1:8799/sync node scripts/dev-harness.mjs --seconds 0   # until Ctrl-C
scripts/install-plugin.sh 192.168.4.33 ws://<server-ip>:8787/sync "Home DE1Pro"   # real install; ask first
```
