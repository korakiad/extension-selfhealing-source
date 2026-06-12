# Plans / Milestones / Suites / Sections / Templates — distilled from official TestRail docs (updated 2026-05)

Endpoint index (29 total):

**Plans (12)**: get_plan, get_plans, add_plan, add_plan_entry, add_run_to_plan_entry, update_plan, update_plan_entry, update_run_in_plan_entry, close_plan, delete_plan, delete_plan_entry, delete_run_from_plan_entry
**Milestones (5)**: get_milestone, get_milestones, add_milestone, update_milestone, delete_milestone
**Suites (5)**: get_suite, get_suites, add_suite, update_suite, delete_suite
**Sections (6)**: get_section, get_sections, add_section, move_section, update_section, delete_section
**Templates (1)**: get_templates

---

# Plans

## get_plan
- **Request**: `GET index.php?/api/v2/get_plan/{plan_id}`
- **Path params**: plan_id (integer, required) — The ID of the test plan
- **Query/filter params**: none documented.
- **Body fields**: n/a (GET)
- **Response**: single object. Fields documented:
  - assignedto_id (integer) — ID of the user the entire test plan is assigned to
  - blocked_count (integer) — number of tests in the plan marked as blocked
  - completed_on (timestamp) — date/time the test plan was closed (UNIX timestamp)
  - created_by (integer) — ID of the user who created the test plan
  - created_on (timestamp) — date/time the test plan was created (UNIX timestamp)
  - custom_status?_count (integer) — number of tests with the respective custom status (example shows custom_status1_count … custom_status7_count)
  - description (string) — description of the test plan
  - entries (array) — array of 'entries', i.e. groups of test runs
  - failed_count (integer) — number of tests marked as failed
  - id (integer) — unique ID of the test plan
  - is_completed (boolean) — true if the test plan was closed
  - milestone_id (integer) — ID of the milestone this test plan belongs to
  - name (string) — name of the test plan
  - passed_count (integer) — number of tests marked as passed
  - project_id (integer) — ID of the project this test plan belongs to
  - refs (string) — comma-separated external requirement IDs — requires TestRail 6.3 or later
  - retest_count (integer) — number of tests marked as a retest
  - untested_count (integer) — number of tests marked as untested
  - url (string) — address/URL of the test plan in the UI
  - start_on (timestamp) — start date of a test plan (UNIX timestamp)
  - due_on (timestamp) — end date of a test plan (UNIX timestamp)
- **Quirks**:
  - Nested entry structure: each element of `entries` has `{id (string GUID), suite_id, name, refs, description, include_all, runs: [...]}`. Each element of `runs` is a full run object: `{id, suite_id, name, description, milestone_id, assignedto_id, include_all, is_completed, completed_on, passed_count, blocked_count, untested_count, retest_count, failed_count, custom_status1..7_count, project_id, plan_id, entry_index (integer), entry_id (string GUID matching the parent entry's id), config (string, e.g. "Chrome"), config_ids (array of integer), created_on, refs, created_by, url}`.
  - An entry is a group of test runs belonging to the same test suite; each group can have a variable number of runs and supports configurations (see add_plan / add_plan_entry).
  - Doc inconsistency: field table lists `due_on`, but the JSON example shows `"due_date": null`. UNCLEAR: which key name is actually returned.
  - refs requires TestRail 6.3+.
- **Errors**: 200 success (plan + its runs returned); 400 invalid or unknown test plan; 403 no access to the project; 429 TestRail Cloud only — too many requests (API rate limit).

## get_plans
- **Request**: `GET index.php?/api/v2/get_plans/{project_id}`
- **Path params**: project_id (integer, required) — The ID of the project
- **Query/filter params** (NOTE: doc labels this table "Request body", but the usage example appends them to the GET URL, e.g. `GET index.php?/api/v2/get_plans/1&is_completed=0&milestone_id=2,3`):
  - created_after (timestamp) — only return test plans created after this date (UNIX timestamp)
  - created_before (timestamp) — only return test plans created before this date (UNIX timestamp)
  - created_by (integer (list)) — comma-separated list of creator user IDs to filter by
  - is_completed (boolean) — 1 = completed test plans only, 0 = active test plans only
  - limit/offset (integer) — limit the result to :limit test plans; use :offset to skip records
  - milestone_id (integer (list)) — comma-separated list of milestone IDs to filter by
  - refs (string) — reference ID (e.g. TR-a, 4291, etc.)
- **Body fields**: n/a (GET; see quirk above about the table label)
- **Response**: paginated wrapper `{offset, limit, size, _links: {next, prev}, plans: [...]}` — array key is **plans**. Each plan follows the same format as get_plan, **except `entries` is NOT included** in the list response.
- **Quirks**: returns up to 250 entries per response; use the `offset` filter for additional records. Doc inconsistency: the parameter table is headed "Request body" although the example uses URL query parameters.
- **Errors**: 200 success (plans returned); 400 invalid or unknown test plan (doc text as written; UNCLEAR — for a project-list endpoint "test plan" is likely a doc copy error but that is what the file says); 403 no access to the project; 429 TestRail Cloud only — too many requests.

## add_plan
- **Request**: `POST index.php?/api/v2/add_plan/{project_id}`
- **Path params**: project_id (integer, required) — The ID of the project the test plan should be added to
- **Query/filter params**: none documented.
- **Body fields**:
  - name (string, required) — the name of the test plan
  - description (string, optional) — the description of the test plan
  - milestone_id (integer, optional) — the ID of the milestone to link to the test plan
  - start_on (timestamp, optional) — the start date of a test plan (UNIX timestamp)
  - due_on (timestamp, optional) — doc description literally says "The start date of a test plan as UNIX timestamp." (apparent copy error; UNCLEAR — presumably the end date, but doc text says start)
  - entries (array, optional) — array of objects describing the test runs of the plan (see add_plan_entry)
- **Quirks**:
  - Entry array shape (from examples): each entry object supports `suite_id`, `name`, `assignedto_id`, `include_all` (boolean), `case_ids` (array of integer, for custom selection when include_all=false), `config_ids` (array of integer), and a nested `runs` array. Each `runs` element supports `include_all`, `case_ids`, `assignedto_id`, `config_ids` — this creates several test runs per plan entry (one per runs element / configuration combination).
  - "The 'refs' field is supported with TestRail 6.3 or later." (refs is not listed in the body table itself.)
- **Response**: single object — the new test plan in the same format as get_plan.
- **Errors**: 200 success (plan created and returned); 400 invalid or unknown project; 403 no permissions to add test plans or no access to the project; 429 TestRail Cloud only — too many requests.

## add_plan_entry
- **Request**: `POST index.php?/api/v2/add_plan_entry/{plan_id}`
- **Path params**: plan_id (integer, required) — The ID of the plan the test runs should be added to
- **Query/filter params**: none documented.
- **Body fields**:
  - suite_id (integer, required "see description") — the ID of the test suite for the test run(s); required if using a project with multiple suites or baseline support
  - name (string, optional) — the name of the test run(s)
  - description (string, optional) — doc says "The description of the test plan" (as written)
  - assignedto_id (integer, optional) — doc description literally says "1 to return completed test plans only. 0 to return active test plans only" (obvious copy error from a filter table; UNCLEAR — actual meaning per the example comments is the default assignee user ID)
  - start_on (timestamp, optional) — the start date of a test plan (UNIX timestamp)
  - due_on (timestamp, optional) — doc again says "The start date of a test plan as UNIX timestamp."
  - include_all (boolean, optional) — doc description literally says "Limit the result to :limit test plans. Use :offset to skip records" (copy error; UNCLEAR — per the example comments it is the default case selection: true = all cases)
  - case_ids (array, optional) — array of case IDs for the custom case selection (required if include_all is false)
  - config_ids (array, optional) — array of configuration IDs used for the test runs of the plan entry
  - refs (string, optional) — comma-separated list of references/requirements
  - runs (array, optional) — an array of test runs; each element may override `include_all`, `case_ids`, `assignedto_id` and set `config_ids` (one run is created per array element)
- **Quirks**:
  - Top-level assignedto_id / include_all / case_ids are defaults for all runs; each run can override them.
  - Top-level `config_ids` must contain the combined list of ALL configurations referenced by individual runs. Each run must specify one configuration per included configuration group and match a full configuration combination (doc gives a Browsers x Operating-Systems example: combos like [2,5] = Firefox + Windows 8 → one test run created per combination chosen).
  - Entries get their own (string GUID) IDs, used with update_plan_entry / delete_plan_entry — distinct from test run IDs.
- **Response**: single object — the new plan entry including its runs, in the same format as one element of get_plan's `entries` field.
- **Errors**: 200 success (runs created and returned; note about entry IDs above); 400 invalid or unknown test plan; 403 no permissions to modify test plans or no access to the project; 429 TestRail Cloud only — too many requests.

## add_run_to_plan_entry
- **Request**: `POST index.php?/api/v2/add_run_to_plan_entry/{plan_id}/{entry_id}`
- **Path params**:
  - plan_id (integer, required) — the ID of the plan the test runs should be added to
  - entry_id (string, required) — the ID of the test plan entry
- **Query/filter params**: none documented.
- **Body fields**:
  - config_ids (array, **required**) — array of configuration IDs used for the test run of the plan entry
  - description (text, optional) — the description of the test run
  - assignedto_id (integer, optional) — the ID of the user the test run should be assigned to
  - start_on (timestamp, optional) — the start date of a test plan (UNIX timestamp)
  - due_on (timestamp, optional) — doc says "The start date of a test plan as UNIX timestamp."
  - include_all (boolean, optional) — true to include all test cases of the suite, false for a custom case selection
  - case_ids (array, optional) — array of case IDs for the custom case selection (required if include_all is false)
  - refs (string, optional) — comma-separated list of references/requirements
- **Quirks**: **requires TestRail 6.4 or later**. No prose description of the endpoint beyond the version gate; example body: `{"config_ids":[1,5],"include_all":false,"case_ids":[1,2,4]}`.
- **Response**: doc has no "Response content" section; the 200 row says "the test run was updated and is returned as part of the response". UNCLEAR: exact response shape (presumably a run object; not specified in the file).
- **Errors**: 200 success; 400 invalid or unknown test plan or plan entry, or invalid POST body; 403 no permissions to modify test plans or no access to the project; 429 TestRail Cloud only — too many requests.

## update_plan
- **Request**: `POST index.php?/api/v2/update_plan/{plan_id}`
- **Path params**: plan_id (integer, required) — The ID of the test plan
- **Query/filter params**: none documented.
- **Body fields**: "With the exception of the entries field, this method supports the same POST fields as add_plan" — i.e. name, description, milestone_id, start_on, due_on (all optional for partial update; entries NOT supported).
- **Quirks**: partial updates supported (submit only the fields to change).
- **Response**: single object — the updated test plan in the same format as get_plan.
- **Errors**: 200 success (plan updated and returned); 400 invalid or unknown test plan; 403 no permissions to modify test plans or no access to the project; 429 TestRail Cloud only — too many requests.

## update_plan_entry
- **Request**: `POST index.php?/api/v2/update_plan_entry/{plan_id}/{entry_id}`
- **Path params**:
  - plan_id (integer, required) — the ID of the test plan
  - entry_id (string, required) — the ID of the test plan entry (note: NOT the test run ID)
- **Query/filter params**: none documented.
- **Body fields**:
  - name (string, listed required=true in the doc table) — the name of the test run(s). UNCLEAR: doc marks it required even though the endpoint advertises partial updates.
  - description (text, optional) — the description of the test run(s) — requires TestRail 5.2 or later
  - assignedto_id (integer, optional) — the ID of the user the test run should be assigned to
  - start_on (timestamp, optional) — the start date of a test plan (UNIX timestamp)
  - due_on (timestamp, optional) — doc says "The start date of a test plan as UNIX timestamp."
  - include_all (boolean, optional) — true to include all test cases of the suite, false for custom case selection (default: true)
  - case_ids (array, optional) — array of case IDs for custom case selection (required if include_all is false)
  - refs (string, optional) — string of external requirement IDs, comma-separated — requires TestRail 6.3 or later
- **Quirks**: **The config_ids and runs fields are NOT supported in POST calls to update_plan_entry** (explicit doc warning). Partial updates supported.
- **Response**: single object — the updated plan entry including its runs, same format as one element of get_plan's `entries` field.
- **Errors**: 200 success (run(s) updated and returned); 400 invalid or unknown test plan or entry; 403 no permissions to modify test plans or no access to the project; 429 TestRail Cloud only — too many requests.

## update_run_in_plan_entry
- **Request**: `POST index.php?/api/v2/update_run_in_plan_entry/{run_id}`
- **Path params**: run_id (integer, required) — The ID of the test run
- **Query/filter params**: none documented.
- **Body fields**:
  - description (text, optional) — the description of the test run
  - assignedto_id (integer, optional) — the ID of the user the test run should be assigned to
  - start_on (timestamp, optional) — the start date of a test plan (UNIX timestamp)
  - due_on (timestamp, optional) — doc says "The start date of a test plan as UNIX timestamp."
  - include_all (boolean, optional) — true to include all test cases of the suite, false for custom case selection (default: true)
  - case_ids (array, required "see description") — array of case IDs for the custom case selection (required if include_all is false)
  - refs (string, optional) — string of external requirement IDs, comma-separated — requires TestRail 6.3 or later
- **Quirks**: **requires TestRail 6.4 or later**. Specifically for updating a run **inside a plan entry that uses configurations**. Addressed by run_id (not plan/entry id). Example body: `{"include_all":false,"case_ids":[1,2,4]}`.
- **Response**: doc has no "Response content" section; 200 row says "the test run was updated and is returned as part of the response". UNCLEAR: exact response shape.
- **Errors**: 200 success; 400 invalid or unknown test run or invalid POST body; 403 no permissions to modify test plans or no access to the project; 429 TestRail Cloud only — too many requests.

## close_plan
- **Request**: `POST index.php?/api/v2/close_plan/{plan_id}`
- **Path params**: plan_id (integer, required) — The ID of the test plan
- **Query/filter params**: none documented.
- **Body fields**: none documented.
- **Response**: single object — the closed test plan in the same format as get_plan.
- **Quirks**: **"Closing a test plan cannot be undone."** Closes the plan and archives its test runs & results.
- **Errors**: 200 success (plan and all its runs closed/archived; plan + runs returned); 400 invalid or unknown test plan; 403 no permissions to close test plans or no access to the project; 429 TestRail Cloud only — too many requests.

## delete_plan
- **Request**: `POST index.php?/api/v2/delete_plan/{plan_id}`
- **Path params**: plan_id (integer, required) — The ID of the test plan
- **Query/filter params**: none documented.
- **Body fields**: none documented.
- **Response**: empty — no response content section documented.
- **Quirks**: **"Deleting a test plan cannot be undone and also permanently deletes all test runs & results of the test plan."**
- **Errors**: 200 success (plan and all its runs deleted); 400 invalid or unknown test plan; 403 no permissions to delete test plans or no access to the project; 429 TestRail Cloud only — too many requests.

## delete_plan_entry
- **Request**: `POST index.php?/api/v2/delete_plan_entry/{plan_id}/{entry_id}`
- **Path params**:
  - plan_id (integer, required) — the ID of the test plan
  - entry_id (string, required) — the ID of the test plan entry (note: NOT the test run ID)
- **Query/filter params**: none documented.
- **Body fields**: none documented.
- **Response**: empty — no response content section documented.
- **Quirks**: deletes one or more existing test runs from a plan. Warning text (as written): "Deleting a test plan cannot be undone and also permanently deletes all test runs & results of the test plan." (Same warning block as delete_plan, applied here to entry deletion.)
- **Errors**: 200 success (run(s) removed from the plan); 400 invalid or unknown test plan or entry; 403 no permissions to delete test plans or no access to the project; 429 TestRail Cloud only — too many requests.

## delete_run_from_plan_entry
- **Request**: `POST index.php?/api/v2/delete_run_from_plan_entry/{run_id}`
- **Path params**: run_id (integer, required) — The ID of the test run
- **Query/filter params**: none documented.
- **Body fields**: none documented.
- **Response**: empty — no response content section documented.
- **Quirks**: deletes a single test run from a test plan entry, addressed by run_id (counterpart to add_run_to_plan_entry). No version gate documented in the file.
- **Errors**: 200 success (run(s) removed from the test plan); 400 invalid or unknown test plan or entry; 403 no permissions to delete test plans or no access to the project; 429 TestRail Cloud only — too many requests.

---

# Milestones

## get_milestone
- **Request**: `GET index.php?/api/v2/get_milestone/{milestone_id}`
- **Path params**: milestone_id (integer, required) — The ID of the milestone
- **Query/filter params**: none documented.
- **Body fields**: n/a (GET)
- **Response**: single object. Fields documented:
  - completed_on (timestamp) — date/time the milestone was marked completed (UNIX timestamp)
  - description (string) — description of the milestone
  - due_on (timestamp) — due date/time of the milestone (UNIX timestamp)
  - id (integer) — unique ID of the milestone
  - is_completed (boolean) — doc text literally says "True if the milestone is marked as started and false otherwise" (identical to is_started's description; apparent copy error — UNCLEAR whether it means completed)
  - is_started (boolean) — true if the milestone is marked as started — requires TestRail 5.3 or later
  - milestones (array) — sub-milestones belonging to this milestone (if any); **only available with get_milestone** — requires TestRail 5.3 or later
  - name (string) — name of the milestone
  - parent_id (integer) — ID of the parent milestone (if any) — requires TestRail 5.3 or later
  - project_id (integer) — ID of the project the milestone belongs to
  - refs (string) — comma-separated list of references/requirements — requires TestRail 6.4 or later
  - start_on (timestamp) — scheduled start date/time (UNIX timestamp) — requires TestRail 5.3 or later
  - started_on (timestamp) — date/time the milestone was started (UNIX timestamp) — requires TestRail 5.3 or later
  - url (string) — address/URL of the milestone in the UI
- **Quirks**: the `milestones` sub-milestone array appears only in get_milestone responses (not get_milestones). Multiple fields version-gated at 5.3+ / 6.4+ as noted above.
- **Errors**: 200 success (milestone returned); 400 invalid or unknown milestone; 403 no access to the project; 429 TestRail Cloud only — too many requests.

## get_milestones
- **Request**: `GET index.php?/api/v2/get_milestones/{project_id}`
- **Path params**: project_id (integer, required) — The ID of the project
- **Query/filter params** (query parameters in the request URL, e.g. `GET index.php?/api/v2/get_milestones/1&is_completed=0`):
  - is_completed (boolean) — 1 = completed milestones only; 0 = open (active/upcoming) milestones only
  - is_started (boolean) — 1 = started milestones only; 0 = upcoming milestones only — requires TestRail 5.3 or later
  - limit (integer) — number of milestones to return (response size is 250 by default) — requires TestRail 6.7 or later
  - offset (integer) — where to start counting milestones from (the offset) — requires TestRail 6.7 or later
- **Body fields**: n/a (GET)
- **Response**: paginated wrapper `{offset, limit, size, _links: {next, prev}, milestones: [...]}` — array key is **milestones**. Each milestone follows the same format as get_milestone (but see the `milestones` sub-array quirk: only available with get_milestone).
- **Quirks**: pagination (limit/offset) requires TestRail 6.7+.
- **Errors**: 200 success (milestones returned); 400 invalid or unknown project; 403 no access to the project; 429 TestRail Cloud only — too many requests.

## add_milestone
- **Request**: `POST index.php?/api/v2/add_milestone/{project_id}`
- **Path params**: project_id (integer, required) — The ID of the project the milestone should be added to
- **Query/filter params**: none beyond the quirk below.
- **Body fields** (NOTE: doc labels this table "Request filters … applied as query parameters in the request URL", but the request example is a JSON body — UNCLEAR which transport the doc intends; the example uses a body):
  - name (string, required) — the name of the milestone
  - description (string, optional) — the description of the milestone
  - due_on (timestamp, optional) — the due date of the milestone (UNIX timestamp)
  - parent_id (integer, optional) — the ID of the parent milestone, if any (for sub-milestones) — requires TestRail 5.3 or later
  - refs (string, optional) — comma-separated list of references/requirements — requires TestRail 6.4 or later
  - start_on (timestamp, optional) — the scheduled start date of the milestone (UNIX timestamp) — requires TestRail 5.3 or later
- **Response**: single object — the new milestone in the same response format as get_milestone.
- **Quirks**: example body: `{"name":"Release 2.0","due_on":1394596385}`.
- **Errors**: 200 success (milestone created and returned); 400 invalid or unknown project; 403 no permissions to add milestones or no access to the project; 429 TestRail Cloud only — too many requests.

## update_milestone
- **Request**: `POST index.php?/api/v2/update_milestone/{milestone_id}`
- **Path params**: milestone_id (integer, required) — The ID of the milestone
- **Query/filter params**: none documented.
- **Body fields** (doc: "The following filters can be applied in the request body"; no required column given — all shown as plain fields):
  - is_completed (boolean, optional) — true if the milestone is considered completed, false otherwise
  - is_started (boolean, optional) — true if the milestone is considered started, false otherwise
  - parent_id (integer, optional) — the ID of the parent milestone, if any (for sub-milestones) — requires TestRail 5.3 or later
  - start_on (timestamp, optional) — the scheduled start date (UNIX timestamp) — requires TestRail 5.3 or later
- **Quirks**: partial updates supported. The doc table lists ONLY the four fields above (it does not say "same fields as add_milestone"); UNCLEAR whether name/description/due_on/refs are also updatable. Example body: `{"is_completed": true}`.
- **Response**: single object — the updated milestone in the same format as get_milestone.
- **Errors**: 200 success (milestone updated and returned); 400 invalid or unknown milestone; 403 no permissions to modify milestones or no access to the project; 429 TestRail Cloud only — too many requests.

## delete_milestone
- **Request**: `POST index.php?/api/v2/delete_milestone/{milestone_id}`
- **Path params**: milestone_id (integer, required) — The ID of the milestone
- **Query/filter params**: none documented.
- **Body fields**: none documented.
- **Response**: empty — no response content section documented.
- **Quirks**: **"Deleting a milestone cannot be undone."**
- **Errors**: 200 success (milestone deleted); 400 invalid or unknown milestone; 403 no permissions to delete milestones or no access to the project; 429 TestRail Cloud only — too many requests.

---

# Suites

## get_suite
- **Request**: `GET index.php?/api/v2/get_suite/{suite_id}`
- **Path params**: suite_id (integer, required) — The ID of the test suite
- **Query/filter params**: none documented.
- **Body fields**: n/a (GET)
- **Response**: single object. Fields documented:
  - completed_on (timestamp) — date/time the test suite was closed (UNIX timestamp) (added with TestRail 4.0)
  - description (string) — description of the test suite
  - id (integer) — unique ID of the test suite
  - is_baseline (boolean) — true if the suite is a baseline test suite (added with TestRail 4.0)
  - is_completed (boolean) — true if the suite is marked completed/archived (added with TestRail 4.0)
  - is_master (boolean) — true if the suite is a master test suite (added with TestRail 4.0)
  - name (string) — name of the test suite
  - project_id (integer) — ID of the project this suite belongs to
  - url (string) — address/URL of the suite in the UI
- **Quirks**: the response-field table also contains a stray `limit/offset (integer) — Limit the result to limit test suites. Use offset to skip records` row — a doc artifact (pagination params do not belong in a single-object response; UNCLEAR why listed here). The JSON example shows only description/id/name/project_id/url.
- **Errors**: 200 success (suite returned); 400 invalid or unknown test suite; 403 no access to the project; 429 TestRail Cloud only — too many requests.

## get_suites
- **Request**: `GET index.php?/api/v2/get_suites/{project_id}`
- **Path params**: project_id (integer, required) — The ID of the project
- **Query/filter params**: none documented in a table (but see pagination quirk; the response carries offset/limit and a `_links.next` of the form `…&limit=250&offset=250`, implying limit/offset are accepted — UNCLEAR: not explicitly listed as request filters in this file).
- **Body fields**: n/a (GET)
- **Response**: paginated wrapper `{offset, limit, size, _links: {next, prev}, suites: [...]}` — array key is **suites**. Each suite follows the same format as get_suite.
- **Quirks**: **"Breaking change on the get_suites endpoint from TestRail 9.3.1 onwards, as it was updated to support pagination."** (Before 9.3.1 it presumably returned a bare array; the doc states only the breaking-change fact.) Doc artifact: the example `_links.next` value references `/api/v2/get_cases/1&limit=250&offset=250` (a get_cases URL inside the get_suites example).
- **Errors**: 200 success (suites returned); 400 invalid or unknown project; 403 no access to the project; 429 TestRail Cloud only — too many requests.

## add_suite
- **Request**: `POST index.php?/api/v2/add_suite/{project_id}`
- **Path params**: project_id (integer, required) — The ID of the project the test suite should be added to
- **Query/filter params**: none documented.
- **Body fields**:
  - name (string, required) — the name of the test suite
  - description (string, optional) — the description of the test suite
- **Response**: single object — the new test suite in the same format as get_suite.
- **Quirks**: "Once you've added a test suite, you can start adding sections and test cases."
- **Errors**: 200 success (suite created and returned); 400 invalid or unknown project; 403 no permissions to add test suites or no access to the project; 429 TestRail Cloud only — too many requests.

## update_suite
- **Request**: `POST index.php?/api/v2/update_suite/{suite_id}`
- **Path params**: suite_id (integer, required) — The ID of the test suite
- **Query/filter params**: none documented.
- **Body fields**: same POST fields as add_suite — name (string), description (string); partial updates supported (submit only fields to change).
- **Response**: single object — the updated test suite in the same format as get_suite.
- **Quirks**: none beyond partial-update support.
- **Errors**: 200 success (suite updated and returned); 400 invalid or unknown test suite; 403 no permissions to modify test suites or no access to the project; 429 TestRail Cloud only — too many requests.

## delete_suite
- **Request**: `POST index.php?/api/v2/delete_suite/{suite_id}`
- **Path params**: suite_id (integer, required) — The ID of the test suite
- **Query/filter params**: `soft` (integer) — omitting soft, or soft=0, deletes the suite and its test cases; **soft=1 returns data on the number of affected tests, cases, etc. WITHOUT actually deleting the entity** (dry-run). UNCLEAR: the doc section is titled just "Soft Parameter" and does not state whether soft is passed as a query param or body field.
- **Body fields**: none documented (other than possibly soft, see above).
- **Response**: empty for a real delete; for soft=1, data on the number of affected tests, cases, etc. (exact shape not documented).
- **Quirks**: **"Deleting a test suite cannot be undone and also deletes all active test runs & results, i.e. test runs & results that weren't closed (archived) yet."**
- **Errors**: 200 success (suite and all active test runs and results deleted); 400 invalid or unknown test suite; 403 no permissions to delete test suites or no access to the project; 429 TestRail Cloud only — too many requests.

---

# Sections

## get_section
- **Request**: `GET index.php?/api/v2/get_section/{section_id}`
- **Path params**: section_id (integer, required) — The ID of the section
- **Query/filter params**: none documented.
- **Body fields**: n/a (GET)
- **Response**: single object. Fields documented:
  - depth (integer) — level in the section hierarchy of the test suite (0 for root-level sections, >0 for child sections)
  - description (string) — description of the section
  - display_order (integer) — the order in the test suite
  - id (integer) — unique ID of the section
  - parent_id (integer) — ID of the parent section in the test suite (null for root sections)
  - name (string) — name of the section
  - suite_id (integer) — ID of the test suite this section belongs to
- **Quirks**: depth, display_order and parent_id together determine the hierarchy of sections in a suite; depth resembles the level in the hierarchy.
- **Errors**: 200 success (section returned); 400 invalid or unknown section; 403 no access to the project; 429 TestRail Cloud only — too many requests.

## get_sections
- **Request**: `GET index.php?/api/v2/get_sections/{project_id}&suite_id={suite_id}`
- **Path params**: project_id (integer, required) — The ID of the project
- **Query/filter params**:
  - suite_id (integer, "See Description") — the ID of the test suite; **optional if the project is operating in single suite mode**, otherwise needed (passed in the URL as `&suite_id=`)
  - limit (integer) — number of sections to return (response size is 250 by default) — requires TestRail 6.7 or later
  - offset (integer) — where to start counting the sections from (the offset) — requires TestRail 6.7 or later
- **Body fields**: n/a (GET)
- **Response**: paginated wrapper `{offset, limit, size, _links: {next, prev}, sections: [...]}` — array key is **sections**. Each section follows the get_section format (the example shows a child section with depth=1 and parent_id pointing to its parent).
- **Quirks**: pagination requires TestRail 6.7+.
- **Errors**: 200 success (sections returned); 400 invalid or unknown project or test suite; 403 no access to the project; 429 TestRail Cloud only — too many requests.

## add_section
- **Request**: `POST index.php?/api/v2/add_section/{project_id}`
- **Path params**: project_id (integer, required) — The ID of the project
- **Query/filter params**: none documented.
- **Body fields**:
  - description (string, optional) — the description of the section
  - suite_id (integer, "See Description") — the ID of the test suite (**ignored if the project is operating in single suite mode, required otherwise**)
  - parent_id (integer, optional) — the ID of the parent section (to build section hierarchies)
  - name (string, required) — the name of the section
- **Response**: single object — the new section in the same format as get_section.
- **Quirks**: example body: `{"suite_id":5,"name":"This is a new section","parent_id":10}`. "Once you've added a section, you can start adding test cases."
- **Errors**: 200 success (section created and returned); 400 invalid or unknown project or test suite; 403 no permissions to add sections or no access to the project; 429 TestRail Cloud only — too many requests.

## move_section
- **Request**: `POST index.php?/api/v2/move_section/{section_id}`
- **Path params**: section_id (integer, required) — The ID of the section
- **Query/filter params**: none documented.
- **Body fields** (no required column in the doc table):
  - parent_id (integer, optional/nullable) — the ID of the parent section (can be null to move the section to the root). **Must be in the same project and suite. May not be a direct child of the section being moved.**
  - after_id (integer, optional/nullable) — the section ID after which the section should be put (can be null)
- **Response**: per the 200 row, "the section was moved and is returned as part of the response" — no explicit response-content section; UNCLEAR exact shape (presumably get_section format).
- **Quirks**: **requires TestRail 6.5.2 or later**. Moves a section to another suite or section — yet parent_id "must be in the same project and suite" (doc tension between the endpoint summary and the parent_id constraint; recorded as written).
- **Errors**: 200 success (section moved and returned); 400 invalid or unknown section_id, parent_id, or after_id; 403 no permissions to add sections or no access to the project (doc says "add" here, as written); 429 TestRail Cloud only — too many requests.

## update_section
- **Request**: `POST index.php?/api/v2/update_section/{section_id}`
- **Path params**: section_id (integer, required) — The ID of the section
- **Query/filter params**: none documented.
- **Body fields** (no required column in the doc table):
  - description (string, optional) — the description of the section
  - name (string, optional) — the name of the section
- **Response**: single object — the updated section in the same format as get_section.
- **Quirks**: partial updates supported. Example body: `{"name": "A better section name"}`.
- **Errors**: 200 success (section updated and returned); 400 invalid or unknown section; 403 no permissions to modify sections or no access to the project; 429 TestRail Cloud only — too many requests.

## delete_section
- **Request**: `POST index.php?/api/v2/delete_section/{section_id}`
- **Path params**: section_id (integer, required) — The ID of the section
- **Query/filter params**: `soft` (integer) — omitting soft, or soft=0, deletes the section and its test cases; **soft=1 returns data on the number of affected tests, cases, etc. without actually deleting the entity in the TestRail UI — the output only shows in the API response** (dry-run). UNCLEAR: doc does not state whether soft is a query param or body field.
- **Body fields**: none documented (other than possibly soft, see above).
- **Response**: empty for a real delete; for soft=1, affected-entity counts (exact shape not documented).
- **Quirks**: **"Deleting a section cannot be undone and also deletes all related test cases as well as active tests & results, i.e. tests & results that weren't closed (archived) yet."**
- **Errors**: 200 success (section deleted); 400 invalid or unknown section; 403 no permissions to delete sections or test cases or no access to the project; 429 TestRail Cloud only — too many requests.

---

# Templates

## get_templates
- **Request**: `GET index.php?/api/v2/get_templates/{project_id}`
- **Path params**: project_id (integer, required) — The ID of the project
- **Query/filter params**: none documented (no pagination).
- **Body fields**: n/a (GET)
- **Response**: **bare JSON array** (NOT a paginated wrapper) of template objects (field layouts for cases/results). Fields per example:
  - id (integer) — unique template ID
  - name (string) — template name (e.g. "Test Case (Text)", "Test Case (Steps)", "Exploratory Session", "Behaviour Driven Development", "AI Evaluation")
  - i18n_custom_id (string) — e.g. "templates_test_case_text"
  - is_default (boolean) — true for the default template, false otherwise
- **Quirks**: read-only — no add/update/delete template endpoints exist in this file. Only id/name/is_default are described in prose; i18n_custom_id appears only in the example (type inferred from example only).
- **Errors**: 200 success (templates returned); 400 invalid or unknown project; 403 no access to the project; 429 TestRail Cloud only — too many requests.
