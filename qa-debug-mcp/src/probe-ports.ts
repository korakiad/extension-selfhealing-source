/**
 * CDP probe for the stdio MCP host. Single-sourced in
 * `@qa-debug/mocha-hooks/probe`; re-exported here so `server.ts` keeps
 * importing `probePorts` from `./probe-ports.js`. Parity with the extension's
 * re-export is now guaranteed by construction (same module), not by a
 * "MUST stay identical" comment.
 */
export {
  classifyRuntime,
  normalizeCdpWsUrl,
  probeChromePort,
  probePorts,
} from '@qa-debug/mocha-hooks/probe';
