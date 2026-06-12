# CR: TestRail skill — prefix-tolerant API client + LM tools + SKILL.md

Status: IMPLEMENTED 2026-06-12 (v4 design; Ralph r1 ×16, r2 ×12, r3 ×11 absorbed; loop
halted by user after r3 — "with these fixes, APPROVE". pnpm validate green; 49 unit checks.)
Date: 2026-06-12

Invariant (r2 root-cause, now explicit): **gateway bytes never reach the model, and the
parser never silently returns wrong data** — every tolerance path (prefix, suffix,
text-non-JSON, parse failure) must satisfy both or fail loud to the output channel.

## Goal

Give the qa-debug agent (and every future skill built on top) read/write access to the
company TestRail instance from inside VS Code:

- **Full TestRail API v2 surface** — all 124 documented endpoints, not a curated subset.
- **Company gateway quirk** — every HTTP response body arrives as an ASCII status text
  glued in front of the JSON (`USERAUTHENSUCESSFULLY{...}`). Every response must be parsed
  through a prefix-tolerant parser.
- **Credentials in VS Code SecretStorage** — URL + username + API key never appear in
  settings files, chat, logs, or the model's context. End-user QA configures once via a
  palette command (transparent-use mandate: no manual config files).
- Foundation layer: later skills (e.g. "file run results", "sync cases") compose on the
  same client + tools; nothing here is single-purpose.

## Ground truth from official docs (support.testrail.com, articles updated 2026-05-26/27)

Distilled endpoint reference (124 endpoints) generated from the 27 official API-reference
articles → `/tmp/testrail-docs/extracted/01..06-*.md` (ship as skill references, see D9).

Protocol facts the design relies on:

- Auth = **HTTP Basic** (`username:apiKey` or `username:password`); API keys minted under
  My Settings. `Content-Type: application/json` is a required header on every JSON request,
  **GETs included** (official curl examples send it on GET).
- All reads are **GET**, all writes are **POST**. Base path `{url}/index.php?/api/v2/<method>`;
  because the whole path after `?` is one query string, extra params append with `&`, never `?`
  (e.g. `get_cases/3&suite_id=8&limit=50`).
- **Pagination** (bulk GETs, TestRail 6.7+): wrapper `{offset, limit, size, _links:{next,prev},
  <array_key>: [...]}`; default+max `limit` = 250; `_links.next === null` ⇒ last page.
  Caveats: the documented next-link omits `index.php?` (`/api/v2/get_shared_steps/1&limit=250…`),
  some endpoints return bare arrays (`get_case_fields`, `get_configs`) or wrapper quirks
  (pre-7.1 `_link` typo) — see D7's recompose-don't-follow rule.
- **Errors**: 200 / 400 (bad entity or body) / 401 (auth) / 403 (permission) / 404 (no such
  endpoint) / 409 (Cloud daily maintenance) / 429 (Cloud rate limit, has `Retry-After`)
  / 5xx (server — docs say caller retries later). Error body shape `{"error": "..."}`.
- **Non-JSON successes exist**: `get_attachment/{id}` returns the raw file body;
  `get_bdd/{case_id}` returns Gherkin `.feature` text. Uploads are `multipart/form-data`,
  file form-field name **`attachment`**, 256MB cap on Cloud.
- Rate limits exist only on TestRail Cloud (180/min Pro, 300/min Enterprise); server installs
  have none — but the client still honors 429 defensively.

## Company quirk (the reason this isn't a stock client)

Observed shape: `USERAUTHENSUCESSFULLY{ ... }` — an uppercase status token prepended by a
company gateway in front of the JSON of **every** response. Exact token vocabulary unknown
(user: "อะไรประมาณนี้"), so the parser treats the prefix as **opaque text**, never as semantics:
HTTP status code remains the only authority. Because the gateway is opaque, the parser also
tolerates **trailing** bytes after the JSON (a prepending gateway is one config knob from an
appending one) and a JSON-shaped envelope prefix (`{"status":"OK"}{payload}`) — see D6.

## Decisions

### D1. Tool surface = 2 generic LM tools, not 124 verbs

`qa_testrail_get` and `qa_testrail_post`.

Why: 124 typed verbs would blow up the languageModelTools contribution and the model's tool
budget; a free-form endpoint string + the shipped endpoint catalog (D9) covers every current
and future endpoint.

**Write confirmation is implemented by us, not assumed from annotations.** The
`contributes.languageModelTools` schema carries no annotations, and gen-lm-tools.mjs emits
only name/modelDescription/inputSchema — `readOnlyHint` never reaches the LM-tool host.
Therefore:

- `qa_testrail_post` implements **`prepareInvocation()`** returning `confirmationMessages`
  that name the endpoint and a payload summary (field names + scalar values truncated;
  never credentials) — VS Code renders a confirm dialog before writes. The confirmation
  **title names the verb class** ("Delete in TestRail: delete_project/3" / "Write to
  TestRail: add_result_for_case/…") so destructive calls don't visually blend into
  add_result noise. Honesty note: chat hosts offer "always allow" affordances — once a QA
  auto-approves, this layer is gone; that residual risk is accepted and is why the SKILL
  keeps the conversational ask.
- `qa_testrail_get` implements `prepareInvocation()` with a benign `invocationMessage`
  ("Reading TestRail: get_cases/14…") and no confirmation.
- The `QaToolDef.annotations` on both defs (`readOnlyHint` true/false,
  `destructiveHint: true` on post — delete_* rides POST) are **MCP-forward-compat
  metadata only** and documented as such in tools.ts.
- SKILL write etiquette (D9) is the conversational layer on top; the `prepareInvocation`
  dialog is the enforcement.

### D2. `endpoint` argument = exact path after `/api/v2/`, with a verb-prefix gate

E.g. `"get_cases/14&suite_id=8&limit=50"`, `"add_result_for_case/81/1234"`. Client always
prefixes `{baseUrl}/index.php?/api/v2/` and rejects inputs containing `://`, leading `/`,
whitespace or control chars, `#` (fetch fragment-truncates every following param), or a
second `?`. The `..` check applies **only to the first path segment** (before the first
`&`) — free-text filter values like `&filter=1..5` or version strings are legitimate.
Filter values containing spaces must be percent-encoded — both tool descriptions state
this explicitly (`filter=login%20page`), so the whitespace rejection never blocks a
legitimate call.

**Verb gate** — one shared pair of allowlist constants, used by both tools in opposite
directions. GET verbs = first path segment `get_*`, `run_report`, or
`run_cross_project_report` (the complete documented GET surface). WRITE verbs = first
segment starting `add_` / `update_` / `delete_` / `close_` / `move_` / `copy_`.

- `qa_testrail_get`: first segment must be a GET verb; a WRITE verb →
  `WRONG_TOOL_FOR_WRITE: use qa_testrail_post`; matches neither →
  `UNKNOWN_ENDPOINT_VERB: check the testrail skill catalog` (a typo like `gett_cases`
  must not bounce the agent to the post tool for a wasted confirm + 404 round trip).
- `qa_testrail_post`: first segment must be a WRITE verb; a GET verb (including
  `run_cross_project_report`) → `WRONG_TOOL_FOR_READ: use qa_testrail_get`;
  neither → `UNKNOWN_ENDPOINT_VERB`.

Verified against the distilled index: every one of the 124 endpoints' first segments is
covered by exactly one of the two classes. Beyond the gate there is no per-endpoint
validation — the references are the catalog; a wrong-but-plausible method name comes back
as TestRail's own 404/400, which the agent can read.

### D3. `body` argument = JSON **object** (extend SSOT schema types)

`QaToolJsonSchema`/`JsonSchemaProp` (tool-contracts) currently allow only
string/number/boolean/array props. Extend `JsonSchemaProp` with `type: 'object'` +
`additionalProperties?: boolean` (verified: gen-lm-tools.mjs copies `inputSchemaJson`
verbatim, so codegen needs no change; zod side `z.record(z.string(), z.unknown())`).
Rationale: TestRail bodies carry markdown/newlines (`custom_steps`); forcing the model to
double-encode JSON-in-a-string is a known escaping-failure source.

`add_bdd` (request body = raw `.feature` text, mechanism UNCLEAR in official docs) is
**unsupported in v1** — enforced by a **deny-set in `qa_testrail_post`** (named error
`UNSUPPORTED_ENDPOINT: add_bdd is not supported in v1 — see the testrail skill catalog`),
not by documentation alone: the tools have no `when` clause, so the model can call them
without ever reading references/05, and a JSON body sent to a raw-Gherkin endpoint may
store mangled data rather than fail safe. Also stated in `references/05` and SKILL.md.

### D4. Non-JSON content (attachments + BDD) — routed by **endpoint name**, not response sniffing

Routing is decided *before* the fetch, from the validated first path segment (response
content-type is unknowable pre-fetch and gateway-rewritable; it is used only for the file
extension and `possiblePrefix` detection):

- `get_attachment/*` → binary save path. `get_bdd/*` → Gherkin text path. Everything else
  → JSON path (D6). A JSON-path response that arrives with a binary content-type is the
  named error `UNEXPECTED_BINARY` (detail to output channel) — never silently decoded.

Per path:

- `qa_testrail_post.attachment_path` (string, optional): when set, the client sends
  `multipart/form-data` with the file under form field `attachment` (official field name)
  and **ignores `body`** — and per D10's own rule, the `qa_testrail_post` description
  states "body is ignored when attachment_path is set" so the model isn't surprised.
  **Outbound containment**: `fs.realpath` the candidate AND each workspace root; for at
  least one root, `path.relative(realRoot, realCandidate)` must neither start with `..`
  **nor be an absolute path** (on Windows, cross-drive/UNC pairs make `path.relative`
  return the absolute target — without the isAbsolute check, `D:\secrets\f` passes a
  `C:\ws` containment test). Multi-root supported; symlink escape and `/workspace-evil`
  prefix-boundary bugs covered. Reject otherwise with `ATTACHMENT_OUTSIDE_WORKSPACE`;
  no workspace open at all → `NO_WORKSPACE` (both attachment directions).
- `get_attachment/{id}`: save bytes (any content-type — attachments can legitimately be
  .txt/.log) to `{firstWorkspaceRoot}/.qa-debug/attachments/<id>.<ext>` and return
  `{ saved_to, bytes, content_type, possiblePrefix? }`.
  **Inbound safety**: filename is keyed by `<id>` alone — `<id>` re-sanitized
  independently of D2 with **strip semantics over the allowed set `A-Za-z0-9-`**
  (TestRail 7.1+ Cloud attachment ids are UUID strings with hyphens, per references/05;
  reject-semantics would break them), never trusted from the endpoint string;
  `<ext>` derived from response content-type via a fixed lookup (fallback `.bin`); the
  server-supplied name is returned as a `display_name` string field but never used in the
  path. After composing, re-verify the resolved final path sits inside
  `.qa-debug/attachments/`. Collision policy = deterministic overwrite by id. Multi-root:
  the **first** workspace folder hosts `.qa-debug/` (stated, not implied).
  **Prefix-corruption detection** (gateway may prepend to binaries too): if content-type
  claims a known binary type but the body opens with a printable-ASCII run before any
  recognizable magic bytes, set `possiblePrefix: true` and log — never strip bytes from a
  binary.
- `get_bdd/{case_id}` (the only documented text-success endpoint): **skip the JSON
  scanner entirely** — a `.feature` file can embed JSON docstrings
  (`"""\n{"a":1}\n"""`), which the scanner would mis-extract as the payload. Split the
  gateway prefix at the **earliest occurrence (not line start — the observed gateway
  glues on the same line, `USERAUTHENSUCESSFULLYFeature: login`)** of a high-precision
  Gherkin opener token: `Feature:`, `Business Need:`, `Ability:` (Gherkin's documented
  synonyms), or `# language:`. Bare `#`/`@` are NEVER split anchors (a mid-file comment
  or tag line would silently discard the real header). Prefix (if any) goes to the
  output channel; the Gherkin text returns as `{ data: <text>, nonJson: true }`. No
  opener found anywhere → **always `PARSE_ERROR`** (body to output channel only — no
  "short enough" tolerance; a short opener-less body is exactly what a gateway-token-only
  response looks like, and raw gateway bytes must never reach the model). Size-cap
  ~256KB; past it, save to the attachments dir and return the file envelope.
- Any **other** 2xx body in which the JSON path finds no parseable JSON is `PARSE_ERROR`
  (no raw text ever returns to the model — see the invariant; no other text-success
  endpoint is documented, so treating unknown text as failure is honest).

### D5. Credentials: SecretStorage + one configure command

- SecretStorage keys (extension-scoped): `qaDebug.testrail.url`,
  `qaDebug.testrail.username`, `qaDebug.testrail.apiKey`. URL lives in secrets too — the
  instance hostname is itself company-internal; nothing TestRail-related syncs via
  settings (no-private-leakage posture). No `qaDebug.testrail.*` keys under
  `contributes.configuration`.
- New command **`qa-debug.configureTestRail`** ("QA Debug: Configure TestRail"):
  three input boxes (URL — validated/normalized, trailing slash + optional `index.php`
  stripped; username/email; API key — `password: true` masked input, with a "create one
  under My Settings > API Keys" prompt hint). Then a **verification call** through the
  real client+parser: bare `get_current_user` first; on 400/404 (the official doc
  ambiguously lists a `user_id` path param and gates it at TestRail 6.6+) fall back to
  `get_projects&limit=1`. Success toast shows the resolved display name (or project
  count) + whether a gateway prefix was detected (output channel gets the detail);
  failure shows the named error and re-opens the wizard. Re-running the command
  overwrites; an explicit "Clear stored TestRail credentials" QuickPick item deletes all
  three keys.
- Tools called before configuration throw `TESTRAIL_NOT_CONFIGURED: run "QA Debug:
  Configure TestRail"` — the SKILL instructs the agent to relay that to the QA verbatim,
  never to ask for credentials in chat.

### D6. Parser contract — `extension/src/testrail/parse.ts` (pure, unit-tested)

One exported function, `parseTestRailBody(raw string)` → `{ data, prefix, suffix }`
(prefix/suffix are the stripped gateway text or null); throws `TestRailParseError`
carrying a snippet + optional hint (snippet handling per the leak rule below).

- Operates on the **trimmed** string throughout (BOM/leading-newline safe: what is
  trimmed is what is parsed).
- Fast path: trimmed starts with `{`/`[` AND `JSON.parse` of the whole trimmed string
  succeeds → `{ data, prefix: null, suffix: null }`.
- Quirk path — **string-aware bracket-depth scanner** (not parse-to-end candidate
  retries): for each candidate start (`{` or `[`) within the first 64KiB, walk the
  balanced extent (tracking string literals + escapes), `JSON.parse` that exact slice.
  **Selection rule** (one bias, stated honestly, not overclaimed): prefer the candidate
  whose extent ends at end-of-trimmed-input — this matches the *observed* gateway
  behavior (text **prefix**) and resolves the JSON-shaped-envelope-prefix case
  (`{"status":"OK"}{payload}` → payload wins). **Short-circuit**: at most one extent can
  end at end-of-input, so scanning stops the moment such an extent parses (the normal
  prefixed-payload case is one walk). If no extent ends at end-of-input, take the
  **longest** (tolerates text trailers); same-tier ties → earliest candidate.
  **Known limit, by design**: a JSON-shaped *suffix* envelope (`{payload}{"txn":"abc"}`)
  mis-selects the trailer — no static rule wins both sides, the prefix bias matches the
  evidence, and the limit is pinned by a D11 test + revisited only on gateway evidence.
  Whenever **≥2 disjoint parseable extents** exist, all extents are logged to the output
  channel as an ambiguity warning, so a mis-selection is diagnosable in one look.
  **Hostile-input bound**: total scan work is capped **body-length-aware** — the larger
  of 2× body length or ~5M steps — so a legitimate multi-MB prefixed bulk page (one
  linear walk) always completes, while a many-candidate hostile prefix cannot pin the
  extension host; past the cap, `TestRailParseError`.
- `prefix` = text before the chosen extent; `suffix` = text after. Both are **logged to
  the qa-debug output channel only** — never interpreted, never surfaced to the model
  (tokens + an invitation to "reason" about gateway internals).
- Empty body (some POSTs return nothing on 200) → `{ data: null, prefix: null, suffix: null }`.
- No parseable JSON at all: `TestRailParseError`. **The snippet never reaches the model**
  (same leak class as NETWORK_ERROR — a gateway/SSO page's first 200 chars embed internal
  hostnames and redirect URLs): the model gets `PARSE_ERROR` + a category hint
  (`"looks like a gateway/SSO login page"` when the body smells like HTML, else
  `"unparseable body — detail in the QA Debug output channel"`); the snippet itself goes
  to the output channel only.
- Binary path bypass: the client only runs `parseTestRailBody` on text-decoded bodies
  (D4 routes binaries before decode); bytes never round-trip through string decode.

### D7. Client contract — `extension/src/testrail/client.ts`

`TestRailClient`, constructed from `{ baseUrl, username, apiKey }` + a log sink. Five
methods, one per content route — the GET tool picks the route by endpoint name (D4):
`getJson` (everything JSON; takes the optional `paginate` flag), `getText` (the
`get_bdd` Gherkin route), `getBinary` (the `get_attachment` save-to-file route),
`postJson`, `postAttachment`. All JSON-ish routes resolve to a common response shape:
the parsed `data`, HTTP `status`, **`hadPrefix`/`hadSuffix` booleans** — the raw
prefix/suffix **text stays inside the client** (parser returns it; the client logs it to
the sink and converts to booleans before anything reaches the tool layer, whose
`jsonResult` house pattern serializes the whole payload to the model; booleans are all
D5's verification toast needs) — plus optional flags: `nonJson` (text route),
`possiblePrefix` (suspected gateway bytes on a non-JSON body), and `paginated`
(`pages`, `truncated`, `truncatedBy: cap | rate_limit`).

- Node 20 global `fetch` (VS Code ≥1.120 host), `AbortController` timeouts: **30s JSON
  calls, 180s `postAttachment`/`getBinary`** (256MB-class transfers on VPN don't fit 30s).
- `Content-Type: application/json` sent on **every** JSON request including GETs (required
  header per official docs). Basic auth header assembled per request.
- **Log/error hygiene (URL is a secret)**: credentials object never logged; log lines
  carry method + endpoint + status + duration only (endpoint is agent-composed, never
  contains host). `NETWORK_ERROR` surfaces only a category to the model —
  `dns | tls | refused | timeout | other` — the raw cause (which can embed
  `getaddrinfo ENOTFOUND testrail.internal.corp` or IPs) goes to the output channel
  only. Every error path that could embed the request URL is scrubbed the same way.
- 429 → `Retry-After` parsed as **integer seconds**; NaN / absent / negative → fixed 5s
  default; cap 30s; retry **once**, second 429 surfaces `RATE_LIMITED`. No auto-retry on
  5xx (agent/QA decides; a paused-test workflow must not silently hammer a sick server).
- Error mapping (complete list of named codes): `TESTRAIL_NOT_CONFIGURED`, `AUTH_FAILED`
  (401), `FORBIDDEN` (403), `BAD_REQUEST` (400, includes TestRail's parsed `error`
  message), `ENDPOINT_NOT_FOUND` (404), `MAINTENANCE` (409), `RATE_LIMITED` (429),
  `SERVER_ERROR` (5xx), `PARSE_ERROR`, `NETWORK_ERROR`, `WRONG_TOOL_FOR_WRITE` /
  `WRONG_TOOL_FOR_READ` / `UNKNOWN_ENDPOINT_VERB` (D2), `UNSUPPORTED_ENDPOINT` (D3),
  `UNEXPECTED_BINARY`, `ATTACHMENT_OUTSIDE_WORKSPACE`, `NO_WORKSPACE` (D4).
  **Wire format**: every message is `CODE: detail` (matching base.ts `toErrorResult`'s
  `^[A-Z_]+:\s` recognition — so the NETWORK_ERROR category rides in the detail,
  `NETWORK_ERROR: tls — …`, never in the code token).
  **2xx POST whose body fails to parse** (e.g. a gateway token glued onto an empty
  delete_* response): the PARSE_ERROR detail must state "HTTP status was 2xx — the write
  may have been applied; verify with a get_* call before retrying" (the agent must not
  blind-retry a possibly-applied write).
- **Pagination — recompose, never follow**: `paginate: true` (GET tool param, default
  false) does NOT fetch `_links.next` (documented link omits `index.php?`; an absolute
  rewrite by the gateway would ship the Basic auth header to a foreign host). Instead:
  treat `_links.next !== null` as "more exists" and recompose the next request locally
  from the original validated endpoint + `&offset={offset+limit}` (arithmetic from the
  wrapper's own fields). **Caller-supplied `offset`/`limit` params are stripped under
  `paginate: true`** (the client owns paging; duplicate-param behavior must not depend on
  PHP's last-occurrence accident) — stated in the tool description. Bare-array /
  wrapper-less responses (get_case_fields, get_configs, pre-7.1 quirks) degrade to
  single page: return as-is, `paginated: { pages: 1, truncated: false }`. Hard caps
  **8 pages / 2000 records** → `truncatedBy: 'cap'`. A 429 that survives its single
  retry mid-pagination returns the **pages already fetched** with
  `truncatedBy: 'rate_limit'` (partial data + an honest flag beats discarding fetched
  budget).

### D8. Config plumbing — `extension/src/testrail/config.ts`

`TestRailService`: lazily builds + caches the client from SecretStorage; invalidated by
`configureTestRail` writes (SecretStorage `onDidChange`). Added to `LmToolDeps` so tool
classes stay constructor-injected like every existing tool. The stdio MCP host
(qa-debug-mcp) does **NOT** register these tools — SecretStorage is an extension-host
facility; tool-contracts defs are host-agnostic, handlers are extension-only (verified:
server.ts imports tools explicitly; appending to qaTools auto-registers nothing there —
same split as qa_pick_element today).

### D9. Skill packaging — `extension/skills/testrail/`

- `SKILL.md` — workflow: check configured → endpoint syntax (D2, incl. percent-encoding
  rule) → consult catalog → pagination recipe (`paginate: true` semantics + truncation) →
  rate-limit etiquette (prefer bulk endpoints: add_results_for_cases over per-case
  loops) → **write etiquette: before ANY `qa_testrail_post` call — verb-agnostic, so
  move_/copy_/close_ bulk mutations are covered, not just add_/update_/delete_ — state
  the exact endpoint + payload summary in chat and get the QA's go-ahead** (the D1
  `prepareInvocation` dialog is the enforcement backstop; the chat ask is the courtesy
  layer) → error code meanings table, including the PARSE_ERROR-on-2xx-write row
  ("the write may have been applied — verify with a get_* before retrying"). Explicitly: the gateway text prefix is handled
  below the tools — the agent never sees or mentions it.
- **Embedded compact catalog (insurance)**: SKILL.md itself carries a one-line-per-
  endpoint index (method + URI template + paginated-array key + required body fields) for
  all 124 endpoints (~130 lines). This keeps the free-form design functional even if
  sibling-file reads fail.
- `references/01-cases.md … 06-labels-filters-reports.md` — the 6 distilled files (full
  params, body fields, response shapes, quirks, errors). **Validation gate**: no existing
  skill in this repo ships sibling files, and Copilot's ability to read files from the
  extension install dir is unproven (same posture as the toolsInclude precedent:
  undocumented → validate live). Spike during implementation: engaged skill instructs a
  reference read in a real Copilot session. If it fails → fallback is a read-only
  `qa_testrail_docs(group)` tool returning reference text from disk (defined then, not
  speculatively built now).
- package.json `contributes.chatSkills` += `./skills/testrail/SKILL.md` (prepare-vsix
  copies `skills/` wholesale — references ship; verified).
- Framework-neutral rule (memory): these docs describe TestRail's own API — naming
  TestRail is the point; no test-framework examples appear in SKILL or references.

### D10. SSOT + codegen + evals

Append both QaToolDefs to `tool-contracts/src/tools.ts` `qaTools` (descriptions follow
the house style: third person, when-to-call / return shape / ≥1 named error — **and must
carry the composition rules themselves**: `&`-not-`?` syntax, percent-encoding of filter
values, "consult the testrail skill catalog for endpoint signatures" — the tools have no
`when` clause, so the model can call them without the skill engaged). Seed package.json
`languageModelTools` entries (displayName, icon `$(checklist)`, no `when` clause), then
`pnpm gen:lm-tools`. The build `--check` guard keeps drift impossible.

**Evals surface**: `evals/src/stub-mcp.ts` iterates `qaTools` and engagement evals build
tool lists from it — two always-visible TestRail tools enter that surface. Implementor
must run the evals reporter test (already part of `pnpm validate`) and either accept the
new tools in the engagement scenarios or filter them out deliberately; silent drift is
not acceptable.

### D11. Tests (run under root `pnpm validate`)

- `extension/test/testrail-parse.test.mts` — pure parser: plain JSON; `PREFIX{...}`;
  `PREFIX[...]`; prefix containing `{` (HTML-with-inline-JS prefix); **JSON-shaped
  envelope prefix** `{"status":"OK"}{payload}` → payload wins; **JSON-shaped suffix**
  `{payload}{"txn":"abc"}` → trailer wins, **pinned as the documented D6 limit** (test
  asserts the ambiguity warning fires); **trailing text garbage after JSON** (suffix
  captured, parse succeeds); BOM/leading-whitespace; empty body; HTML error page →
  TestRailParseError with HTML hint **and no body bytes in the thrown message**; scan
  work cap (hostile many-brace input degrades to error, bounded time; multi-MB
  legitimate prefixed body still parses); huge body fast path; UTF-8 content; Gherkin
  split: **same-line glued prefix** (`USERAUTHENSUCESSFULLYFeature: login`) splits
  correctly, comment/tag-bearing feature is NOT mis-split at `#`/`@`, opener-less body →
  PARSE_ERROR with no body bytes in the message.
- `extension/test/testrail-client.test.mts` — local `http.createServer` stub emitting
  prefixed bodies: auth header correctness (incl. Content-Type on GET); & vs ? URL
  building; verb gate both directions incl. **POST `run_cross_project_report` rejected**
  and typo verb → `UNKNOWN_ENDPOINT_VERB`; pagination recompose (+offset arithmetic,
  **caller-supplied offset/limit stripped**, never fetches the `_links.next` URL —
  assert by serving a poisoned next link), bare-array degrade, truncation cap, 429
  mid-pagination → partial + `truncatedBy: rate_limit`; 429 Retry-After
  integer/NaN/absent cases + single retry; error mapping incl. NETWORK_ERROR category
  scrub (assert no hostname in message), `UNEXPECTED_BINARY` on a JSON route,
  `UNSUPPORTED_ENDPOINT` for add_bdd, and **no prefix/suffix bytes anywhere in the
  resolved response object** (booleans only); **`get_bdd` route**: Gherkin with JSON
  docstring returns full feature text (scanner skipped); multipart field name =
  `attachment`; binary save + `possiblePrefix` detection; outbound containment (symlink
  escape, `/root-evil` prefix-boundary, multi-root, **Windows cross-drive isAbsolute
  hole**) and inbound filename keying (id-only incl. UUID ids, separator smuggling,
  traversal).

## Out of scope (v1)

- Typed per-endpoint wrappers, response models. Free-form by design.
- `add_bdd` (raw .feature request body; mechanism UNCLEAR in official docs) — stated in
  references/05 + SKILL.
- TestRail UI surfaces (tree view, status bar) — chat/agent is the consumer.
- OAuth/SSO flows; only Basic auth per official docs.
- Proxy / self-signed-TLS handling (Node fetch will reject self-signed certs; if the
  company instance needs it, that's a follow-up decision — documented as a known risk).
- Auto-retry policies beyond the single 429 retry.

## File plan

| File | Change |
|---|---|
| `tool-contracts/src/tools.ts` | +`qa_testrail_get`, +`qa_testrail_post`; `JsonSchemaProp` gains `'object'` |
| `extension/tools/gen-lm-tools.mjs` | none (verified pass-through) |
| `extension/src/testrail/parse.ts` | new, pure (bracket-depth scanner) |
| `extension/src/testrail/client.ts` | new |
| `extension/src/testrail/config.ts` | new (`TestRailService`, SecretStorage keys) |
| `extension/src/lm-tools/testrail-get.ts`, `testrail-post.ts` | new tool classes, both with `prepareInvocation` |
| `extension/src/lm-tools/base.ts` | `LmToolDeps` += `testrail: TestRailService` |
| `extension/src/lm-tools/index.ts` | register both tools |
| `extension/src/configure-testrail.ts` | `qa-debug.configureTestRail` wizard |
| `extension/src/extension.ts` | construct `TestRailService(context.secrets)`, wire deps |
| `extension/package.json` | command entry, chatSkills entry, generated languageModelTools |
| `extension/skills/testrail/SKILL.md` (embedded catalog) + `references/*.md` | new |
| `extension/test/testrail-parse.test.mts`, `testrail-client.test.mts` | new |
| `evals` | run reporter test; engagement-scenario inclusion decided explicitly |

## Risks

- **Unknown prefix vocabulary / appending gateways**: mitigated by the bracket-depth
  scanner (prefix AND suffix tolerated, JSON-envelope prefix resolved by
  end-of-input/longest rule); a gateway that wraps JSON *around* the payload in one
  object still fails loud with snippet + hint — correct failure mode for
  guessing-not-allowed.
- **Self-signed TLS** on the internal instance fails at `fetch` → `NETWORK_ERROR(tls)`
  (category only; detail in output channel) — surfaced honestly; follow-up if it bites.
- **Write tool misuse**: `prepareInvocation` confirmation on every post (D1) + verb-
  prefix gate keeps writes out of the frictionless GET tool (D2) + SKILL etiquette +
  destructive endpoints clearly named (`delete_*`) in the catalog.
- **References unreadable by Copilot** (extension-install-dir reads unproven): embedded
  compact catalog in SKILL.md keeps the design functional; spike decides whether the
  full references need a `qa_testrail_docs` tool (D9).
