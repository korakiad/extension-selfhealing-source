# Next-session execution prompt

Paste the content below as the **first message** of a new Claude Code session in `/Users/kiattikhun/claude-project/mocha-vscode-tesitng`. The model will load `MEMORY.md` automatically and pick up from where we left off.

---

## Prompt to paste

```
Continue Task #23 F5 smoke verification — three commits landed this session (v5.6 5bcb28a, v5.7 41313a1, v5.8 ea46bf0) but the F5 manual smokes are owed. Read [[project-qa-companion]] "F5 manual smokes OWED next session" block for full details + priority order; the short version is:

1. (Prereq) Click "Give Up" in Test Explorer to clear the pre-v5.6 stuck pause that lingers in globalState. After this single click, sentinel flow takes over.

2. (Highest value) **v5.8 Thread 1 resolution verification.** Re-run fixture-tests-wdio/specs/selector.spec.js (current spec has `#login-btnxxx` — intentional bad selector). When agent calls qa-debug:qa_get_failure_context, failing_assertion MUST contain the ACTUAL wdio error (something like "element ('#login-btnxxx') still not displayed" — wdio v8's element-not-found error text). It must NOT be the defensive placeholder "(test marked failed but Mocha did not capture an error...)". Also stack_trace.frames must be populated, not empty.

3. **v5.6 onDecision wire verification.** Have agent call qa-debug:qa_request_retry. Output Channel "QA Debug Companion" should show three lines in order: [qa-debug-mcp] qa_request_retry called + [qa-debug-mcp] onDecision sessionId=... kind=retry committed=true + the canonical audit row with by=agent. Status-bar hides within 500ms, mocha respawns. Repeat for qa-debug:qa_request_give_up (no respawn, clean exit).

4. **v5.7 sentinel verification (three smokes A/B/C).** See [[project-qa-companion]] for exact PASS/FAIL criteria. Smoke A is the quick win: F5, Cmd+Q without running anything, re-F5 — must NOT see "QA Paused" status bar; Output Channel should show "[activate] clean-shutdown sentinel found".

Use the diagnostic playbook in [[project-wdio-test-err-undefined]] if anything in #2 unexpectedly shows the defensive placeholder again (would indicate the fix regressed or there's a new edge case).

If all four pass: ใส่ผลลัพธ์ใน chat แล้วทำต่อตามที่ user สั่ง. If any fail: paste Output Channel + chat output here and we'll diagnose.

Uncommitted carryover (NOT touched by v5.6–v5.8): fixture-tests-wdio/package.json (chromedriver dep) + fixture-tests-wdio/specs/selector.spec.js (selector edit). Leave for user to commit separately unless asked.

Tools: lightweight PLAN + Ralph review for any design changes per [[feedback-ralph-loop-scope]] — not full ARCHITECTURE-CR-vN.md unless architectural.
```

---

## ทำไมต้องเขียนแบบนี้

- ขึ้นด้วย verb เลย (`Continue Task #23 F5 smoke verification`) ให้ Claude เริ่ม action ทันที
- อ้างอิง memory entries ด้วย `[[double-bracket]]` syntax — Claude จะ Read file นั้นทันที่ก่อนตอบ
- จัด priority order ชัด (#1 prereq → #2 highest value → #3 → #4)
- มี PASS/FAIL criteria เฉพาะแต่ละ smoke (ไม่ต้องไปขุดจาก memory ทั้งหมด)
- ระบุ diagnostic fallback (playbook in memory) เผื่อเจอปัญหา
- บอก carryover files ที่ห้ามแตะโดยไม่ได้ขอ
- บอก tool convention (lightweight PLAN ไม่ใช่ full CR doc)
