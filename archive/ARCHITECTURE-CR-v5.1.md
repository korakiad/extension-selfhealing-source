# ARCHITECTURE v5.1 — Change Request: remove `invalidateRequireCache(file)` no-op from §3.1 retry branch

> **NOTE (post-drop-retry):** Sections of this CR referencing `qa_request_retry`, the `--grep` respawn, retry-pass recovery, or `qa_propose_close_browser` describe behavior that has been removed. See `/Users/kiattikhun/.claude/plans/robust-marinating-whistle.md` for the deletion record. This CR survives as historical context.



> Status: Ralph-loop iteration #1 APPROVE-with-polish (2026-05-21); polish applied below; iteration #2 pending for final sign-off.
>
> Scope: §3.1 retry branch only. No other architectural change.

## 0. Sources (per ARCHITECTURE v5 §0.1)

- ARCHITECTURE.md v5 §3.1 (retry branch pseudocode) + §0.3 (don't-silently-simplify lesson) — repo-local.
- mocha-hooks/README.md "Q2 verification: `require.cache` invalidation for retry decisions" — repo-local, written during S2 implementation.
- mocha-hooks/src/qa-hooks.ts:69–77 (`invalidateRequireCache` function) and qa-hooks.ts:178–181 (retry branch call) — repo-local source.
- Mocha v10.8.2 retry semantics: `node_modules/.pnpm/mocha@10.8.2/.../lib/runner.js:814–823` (clone-on-retry creates `clonedTest` before `hookUp(afterEach)`); `lib/test.js:71–83` (`Test.prototype.clone` snapshots `this.retries()` at clone time). These are the citations §3.1 already gives for "why no native mocha retries".
- Phase 1 retry flow per ARCHITECTURE §3.1 footnote and §4 sequence step 8: "extension re-invokes mocha against the same test file via `--grep <test title>` in a fresh child process".

## 1. The call in question

ARCHITECTURE v5 §3.1 pseudocode includes:

```js
if (decision.kind === 'retry') {
  invalidateRequireCache(this.currentTest.file);
  return;
}
```

qa-hooks.ts:178–181 implements this verbatim. The helper at qa-hooks.ts:69–77:

```ts
function invalidateRequireCache(file: string | null | undefined): void {
  if (!file) return;
  try {
    const resolved = require.resolve(file);
    delete require.cache[resolved];
  } catch {
    // Resolution miss is non-fatal — file is just not in cache to begin with.
  }
}
```

## 2. Empirical finding (mocha-hooks/README.md Q2)

The v5 retry flow uses `--grep <test title>` re-spawn by the extension (S4) or oracle (S2 simulation), NOT mocha's native `retries(N)` — see ARCHITECTURE §3.1 "Why no native mocha retries?" paragraph.

A fresh `child_process.spawn('node', ['mocha', ...])` allocates a fresh Node module cache. Module-resolution state inside the original mocha process is therefore irrelevant to the retry run — the retry happens in a new process whose `require.cache` starts empty.

**The `invalidateRequireCache(file)` call in qa-hooks.ts:179 has zero effect on any v5 code path. It is a no-op.**

(Codified in mocha-hooks/README.md "Q2 verification" section, written during S2 implementation. The current README text says the call is "retained because Phase 2 may consider an in-process retry mechanism" + "removing it without an ARCHITECTURE v5.1 CR would violate the standing rule in ARCHITECTURE v5 §0.3" — i.e., it explicitly defers the removal to this CR.)

## 3. Proposal

Remove the call from §3.1 pseudocode AND from qa-hooks.ts. Specifically:

1. **ARCHITECTURE.md §3.1** — strip line 109 (`invalidateRequireCache(this.currentTest.file);`) from the pseudocode block. Leave the `return;` on what's now line 110.
2. **ARCHITECTURE.md §3.1** — replace the existing "Why no native mocha retries?" paragraph's mention of "The require-cache invalidation is retained per ARCHITECTURE v5 §3.1 because S4's `--grep` respawn relies on a fresh require resolution for the test file across the same Node process" with: "The retry decision is honored by the extension via `--grep` respawn (S4) / oracle (S2 simulation); both spawn a fresh Node process where `require.cache` starts empty by construction. In-process `require.cache` invalidation has no addressable target (the retry runs in a different process), so no in-process invalidation step is performed. A future Phase 2 in-process retry mechanism (not in current scope) would re-introduce a need for cache invalidation — that work, if it lands, takes a v5.x CR to add per the mandatory Phase 2 task tracked in SLICE_PLAN §4." [Iteration #1 polish: tightened from "no in-process invalidation is needed" to the addressable-target framing per reviewer Q6.3 polish.]
3. **ARCHITECTURE.md §6 Status** — append v5→v5.1 entry noting this CR.
4. **mocha-hooks/src/qa-hooks.ts** — delete `invalidateRequireCache` function (lines 69–77) and its call site (line 179). The retry branch becomes:

   ```ts
   if (decision.kind === 'retry') {
     return;
   }
   ```

5. **mocha-hooks/README.md "Q2 verification" section** — rewrite per the new state. The new block must **retain the original Q2 evidence** (the empirical reasoning about a fresh `child_process.spawn` Node process getting an empty `require.cache` by construction; that's the load-bearing fact a Phase 2 designer needs to evaluate whether their new flow re-introduces the need). Move the "retained because Phase 2 may consider an in-process retry mechanism" *conclusion* into a "Phase 2 follow-up" block; **the evidence above it stays**. [Iteration #1 polish: explicit don't-drop-evidence-keep-conclusion guidance per reviewer obs #3.]
6. **SLICE_PLAN.md §4 "Out of phase 1"** — add a mandatory Phase 2 follow-up entry: *"If Phase 2 introduces in-process Mocha retry (not currently scoped), restore `require.cache` invalidation per v5.1 §3 — see ARCHITECTURE.md §3.1 'Why no native mocha retries?' paragraph and mocha-hooks/README.md 'Q2 follow-up' block for the evidence chain."* The cross-reference makes the re-add requirement reachable from both entry points (Phase 2 backlog reading SLICE_PLAN, and §3.1 reading ARCHITECTURE). [Iteration #1 polish: per reviewer obs #2 — discoverability via single entry point was too weak; making it bidirectional makes silent-Phase-2-drift impossible without seeing the flag.]

No other files change.

## 4. Cost analysis

| | Keep call | Remove call (proposed) |
|---|---|---|
| Runtime cost (per retry decision) | 1× `require.resolve` + 1× `delete require.cache[...]` — negligible at hook timescale | 0 |
| Code-reader confusion | Reader sees the call and infers it's load-bearing for retry semantics — it isn't, in v5 | None (call gone; behavior matches comment) |
| Phase 2 carrying cost | Function + call retained; Phase 2 in-process retry can rely on it directly | Phase 2 in-process retry adds back via its own CR (small re-add cost) |
| Compliance with §0.3 "don't silently simplify" | OK (existing v5) | OK (this CR) |
| Compliance with "remove dead code, archive the rationale" — `platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices` "Avoid time-sensitive information" prescribes the **Old patterns** idiom: out-of-current-scope-but-historically-relevant material gets moved into a clearly-labeled archival section rather than left inline. `code.claude.com/docs/en/best-practices` adds: *"Ruthlessly prune. If Claude already does something correctly without the instruction, delete it or convert it to a hook."* Applied here: delete the function + call site (live code), and the README "Phase 2 follow-up" block IS the "Old patterns" archive. [Iteration #1 polish: per reviewer obs #4 — swapped from `anthropic.com/engineering/writing-tools-for-agents` (which is about *tool surface bloat*, not per-function dead code) to the on-point Skills "Old patterns" idiom.] | FAIL (the call is dead in current scope; v5 README explicitly defers removal to a CR) | PASS (matches "Old patterns" archive idiom) |

Net: remove now. Phase 2 will re-add if in-process retry materializes.

## 5. Risk

- **Behavior risk**: zero. The call has no observable effect in any v5 code path. Removing it changes nothing runtime.
- **Future Phase 2 risk**: if Phase 2 introduces an in-process retry mechanism *without* a CR to re-add cache invalidation, the in-process retry would silently use cached modules → stale tests on retry. Mitigation: the v5.1 ARCHITECTURE update + mocha-hooks/README.md "Phase 2 follow-up" block both explicitly call out this re-add requirement. Phase 2 will not be able to introduce in-process retry without seeing this flag.
- **Reviewer pushback risk**: a reviewer could argue keep-it-for-cheap-Phase-2-readiness. Counter: the §0.3 lesson exists precisely to discourage "keep-because-might-need" code. v5 already extracted other Phase 1 dead state mutations (`test.state`, `test.err`, `parent.retries`) for the same reason — this CR is the cleanup-equivalent for require.cache.

## 6. Open questions for reviewer

1. Is there a published Anthropic-source position on "remove dead code now vs. keep for hypothetical future use" specifically for agentic / hook-style instrumentation code? If yes, cite — the cost-table row above would be load-bearing.
2. Should §3.1 instead mark the call `@deprecated // v5.1: no-op for --grep respawn flow` and leave it in, vs. removing entirely? Tradeoff: more discoverable signpost for Phase 2 vs. dead code per question 1.
3. The §3.1 prose change (replacing "is retained per ARCHITECTURE v5 §3.1 because..." with the new wording) — does it preserve enough of the §3.1 mocha-runner.js citation chain that future reviewers don't need to re-derive the Phase 1 retry-via-respawn semantics?

## 7. Recommendation

Remove. Apply changes 1–6 as drafted in §3 above. Step 6 (SLICE_PLAN §4 Phase 2 follow-up entry with bidirectional cross-reference) is **mandatory**, not optional — it is what makes the re-add requirement discoverable from both Phase 2's natural entry point and from ARCHITECTURE §3.1.
