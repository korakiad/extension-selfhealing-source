/**
 * InspectionArbiter — the single shared "what owns the browser inspection right
 * now" predicate, consulted by BOTH SessionManager (Mocha run → pause) and
 * LiveSessionManager (Live Inspect Session). They are mutually exclusive within
 * one window because `mcpProvider` binds a SINGLE endpoint (mcp-provider.ts) —
 * two inspections would clobber each other's MCP registration.
 *
 * This guards the WITHIN-WINDOW case only. Across windows (separate ext hosts)
 * safety comes from port-pool allocation + per-project profiles, not this class.
 */

export type InspectionKind = 'run' | 'live';

export class InspectionArbiter {
  private runActive = false;
  private liveActive = false;

  setRunActive(v: boolean): void {
    this.runActive = v;
  }
  setLiveActive(v: boolean): void {
    this.liveActive = v;
  }
  get isRunActive(): boolean {
    return this.runActive;
  }
  get isLiveActive(): boolean {
    return this.liveActive;
  }

  /** Run and live are mutually exclusive; a second live is also refused. */
  canStart(kind: InspectionKind): boolean {
    return kind === 'run' ? !this.liveActive : !(this.runActive || this.liveActive);
  }

  /** Human-readable reason a `canStart` returned false (for UI), else undefined. */
  blockingReason(): string | undefined {
    if (this.runActive) return 'a Mocha suite run (or a paused test) is active';
    if (this.liveActive) return 'a Live Inspect Session is already active';
    return undefined;
  }
}
