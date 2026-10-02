#!/usr/bin/env node
// Runs plugin.js in Node with a stand-in for Decaid's plugin host, so the plugin
// can be exercised against a real machine's API and a sync server without
// installing anything on the tablet.
//
//   node scripts/dev-harness.mjs [--simulate] [--seconds N]
//
// Env: DECENT (192.168.4.33), SERVER_URL (ws://127.0.0.1:8787/sync),
//      MACHINE_NAME (Harness), AUTH_TOKEN, POLL_SECONDS (5)
//
// --simulate dispatches a stateUpdate pair and a shotStored for the latest shot.
// The stand-in covers only what plugin.js uses: host.log, host.transport, and
// plugin-scoped fetch. It does not reproduce Decaid's resource limits.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DECENT = process.env.DECENT || "192.168.4.33";
const SERVER_URL = process.env.SERVER_URL || "ws://127.0.0.1:8787/sync";
const args = process.argv.slice(2);
const SIMULATE = args.includes("--simulate");
const SECONDS = Number(args[args.indexOf("--seconds") + 1]) || (args.includes("--seconds") ? 0 : 15);

const realFetch = globalThis.fetch;
const pluginFetch = async (url, init = {}) => {
  const r = await realFetch(String(url).replace("localhost:8080", `${DECENT}:8080`), init);
  const body = await r.text();
  return { status: r.status, ok: r.ok, headers: r.headers, text: async () => body, json: async () => JSON.parse(body) };
};

const sockets = new Map();
let nextHandle = 0;
const host = {
  log: (m) => console.log(`[plugin] ${m}`),
  transport: {
    open: ({ url }) =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        const handle = `h${++nextHandle}`;
        const rec = { ws, queue: [], cb: null };
        const deliver = (ev) => (rec.cb ? rec.cb(ev) : rec.queue.push(ev));
        ws.onopen = () => {
          sockets.set(handle, rec);
          resolve({ handle });
        };
        ws.onerror = () => (sockets.has(handle) ? deliver({ type: "error", code: "transport_error", message: "socket error" }) : reject(new Error("connect failed")));
        ws.onmessage = (e) => deliver({ type: "data", dataType: "text", data: e.data });
        ws.onclose = (e) => deliver({ type: "close", code: e.code, reason: e.reason });
      }),
    onEvent: (handle, cb) => {
      const rec = sockets.get(handle);
      rec.cb = cb;
      rec.queue.splice(0).forEach(cb);
    },
    send: async (handle, payload) => sockets.get(handle).ws.send(payload.data),
    close: async (handle) => sockets.get(handle)?.ws.close(),
  },
};

const source = fs.readFileSync(path.join(root, "plugin.js"), "utf8");
const plugin = new Function("host", "fetch", `${source}\nreturn createPlugin(host);`)(host, pluginFetch);

console.log(`harness: Decaid API ${DECENT}:8080, server ${SERVER_URL}, ${SECONDS ? `${SECONDS}s` : "until Ctrl-C"}`);
plugin.onLoad({
  ServerUrl: SERVER_URL,
  MachineName: process.env.MACHINE_NAME || "Harness",
  AuthToken: process.env.AUTH_TOKEN || "",
  PollSeconds: Number(process.env.POLL_SECONDS || 5),
});

if (SIMULATE) {
  const latest = await pluginFetch("http://localhost:8080/api/v1/shots/latest").then((r) => r.json()).catch(() => null);
  setTimeout(() => plugin.onEvent({ name: "stateUpdate", payload: { state: { state: "idle", substate: "ready" }, groupTemperature: 92 } }), 1500);
  setTimeout(() => plugin.onEvent({ name: "stateUpdate", payload: { state: { state: "espresso", substate: "pouring" }, groupTemperature: 93 } }), 1700);
  if (latest?.id) setTimeout(() => plugin.onEvent({ name: "shotStored", payload: { id: latest.id } }), 2500);
}

const stop = () => {
  plugin.onUnload();
  setTimeout(() => process.exit(0), 200);
};
process.on("SIGINT", stop);
if (SECONDS) setTimeout(stop, SECONDS * 1000);
