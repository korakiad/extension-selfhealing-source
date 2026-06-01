/**
 * CDP probe for the extension host. The implementation is single-sourced in
 * `@qa-debug/mocha-hooks/probe`; this file re-exports it so existing imports
 * keep resolving — `commands.ts`, `discover-chromes.ts`, and the unit test
 * `extension/test/runtime-classify.test.mts` (which imports `classifyRuntime`
 * from here).
 *
 * The probe returns the protocol `AvailableChrome` shape, which is structurally
 * identical to the `@qa-debug/pause-store-types` interface the rest of the
 * extension uses, so the results assign without conversion.
 */
export {
  classifyRuntime,
  normalizeCdpWsUrl,
  probeChromePort,
  probePorts,
} from '@qa-debug/mocha-hooks/probe';
