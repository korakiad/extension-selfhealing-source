# Results / Result Fields / Runs / Tests / Statuses — distilled from official TestRail docs (updated 2026-05)

Endpoint index (20 total):
1. get_results
2. get_results_for_case
3. get_results_for_run
4. add_result
5. add_result_for_case
6. add_results
7. add_results_for_cases
8. get_result_fields
9. get_run
10. get_runs
11. add_run
12. update_run
13. close_run
14. delete_run
15. get_test
16. get_tests
17. update_test
18. update_tests
19. get_case_statuses
20. get_statuses

Non-endpoint doc section also covered: `quality_rating` (a result field concept documented in the Result Fields page, NOT an API endpoint — see note after get_result_fields).

---

## get_results
- **Request**: `GET index.php?/api/v2/get_results/{test_id}`
- **Path params**: test_id (integer, required) — the ID of the test
- **Query/filter params**:
  - limit (integer) — limit of test results shown in the response; response size limit is 250 by default — requires TestRail 6.7 or later
  - offset (integer) — position where the response should start from — requires TestRail 6.7 or later
  - defects_filter (string) — a single Defect ID (e.g. TR-1, 4291, etc.)
  - status_id (integer list) — comma-separated list of status IDs to filter by (e.g. `&status_id=4,5`)
- **Body fields**: n/a (GET)
- **Response**: paginated wrapper `{offset, limit, size, _links: {next, prev}, results: [...]}` — array key is `results`. Each result object always includes these system fields: assignedto_id (integer — assignee/user of the result), comment (string — comment or error message), created_by (integer — user who created the result), created_on (timestamp — UNIX timestamp of creation), defects (string — comma-separated defects linked to the result), elapsed (timespan — e.g. "1m" or "2m 30s"), id (integer — unique result ID), status_id (integer — e.g. passed/failed, see get_statuses), test_id (integer — the test this result belongs to), version (string — build version tested against). Example response also shows `custom_step_results: []`.
- **Quirks**: Returns up to 250 entries per response; use offset for more. Filter usage in example uses `&` directly after the URI (`get_results/1&status_id=4,5&limit=10`). limit/offset appear both in the Parameters table and the Request filters table. The doc contains an apparently misplaced paragraph about depth/display_order/parent fields determining section hierarchy in a test suite ("see get_sections for an example") — these fields are not in the result response example; UNCLEAR: why this paragraph is present in the Results doc.
- **Errors**: 200 success (results returned); 400 invalid or unknown test; 403 no access to the project; 429 TestRail Cloud only — too many requests (API rate limit).

## get_results_for_case
- **Request**: `GET index.php?/api/v2/get_results_for_case/{run_id}/{case_id}`
- **Path params**: run_id (integer, required) — the ID of the test run; case_id (integer, required) — the ID of the test case
- **Query/filter params**:
  - defects_filter (string) — a single Defect ID (e.g. TR-1, 4291, etc.)
  - limit (integer) — number of test results the response should return (250 by default) — requires TestRail 6.7 or later
  - offset (integer) — where to start counting the results from — requires TestRail 6.7 or later
  - status_id (integer list) — comma-separated list of status IDs to filter by
- **Body fields**: n/a (GET)
- **Response**: same format as get_results — paginated wrapper `{offset, limit, size, _links, results: [...]}` with the same per-result system fields.
- **Quirks**: Difference vs get_results: expects test run + test case instead of a test. A test is an "instance" of a test case inside a run (TestRail creates a test per case in the suite when a run is created). Up to 250 entries per response.
- **Errors**: 200 success; 400 invalid or unknown test run or case; 403 no access to the project; 429 TestRail Cloud only — too many requests.

## get_results_for_run
- **Request**: `GET index.php?/api/v2/get_results_for_run/{run_id}`
- **Path params**: run_id (integer, required) — the ID of the test run
- **Query/filter params**:
  - created_after (timestamp) — only results created after this date (UNIX timestamp)
  - created_before (timestamp) — only results created before this date (UNIX timestamp)
  - created_by (integer list) — comma-separated list of creator user IDs
  - defects_filter (string) — a single Defect ID (e.g. TR-1, 4291, etc.)
  - limit (integer) — limit of results shown (250 by default) — requires TestRail 6.7 or later
  - offset (integer) — position where the response should start from — requires TestRail 6.7 or later
  - status_id (integer list) — comma-separated list of status IDs to filter by
- **Body fields**: n/a (GET)
- **Response**: same format as get_results — paginated wrapper `{offset, limit, size, _links, results: [...]}`.
- **Quirks**: Up to 250 entries per response; use offset for more. Example: `get_results_for_run/1&created_by=5&limit=10`.
- **Errors**: 200 success; 400 invalid or unknown test run; 403 no access to the project; 429 TestRail Cloud only — too many requests.

## add_result
- **Request**: `POST index.php?/api/v2/add_result/{test_id}`
- **Path params**: test_id (integer, required) — the ID of the test the result should be added to
- **Query/filter params**: none documented
- **Body fields** (all system fields; required/optional not marked per-field in the doc):
  - status_id (integer) — the ID of the test status. Default system statuses: 1 Passed, 2 Blocked, 3 Untested (NOT allowed when adding a new result), 4 Retest, 5 Failed. Full list of system + custom statuses via get_statuses.
  - comment (string) — comment/description for the result
  - version (string) — version or build tested against
  - elapsed (timespan) — time to execute, e.g. "30s" or "1m 45s"
  - defects (string) — comma-separated list of defects to link
  - assignedto_id (integer) — user ID the test should be assigned to
  - Custom fields: submitted with system name prefixed `custom_` (e.g. `custom_comment`). Supported custom field types: Checkbox (boolean), Date (string, in the TestRail-configured format e.g. "07/08/2013"), Dropdown (integer — ID of a dropdown value), Integer (integer), Milestone (integer — milestone ID), Multi-select (array of IDs), Step Results (array of objects — e.g. `custom_step_results: [{content, expected, actual, status_id}, ...]`), String (string, max 250 chars), Text (string, no max length), URL (string matching URL syntax), User (integer — user ID).
- **Response**: single object — same format as a get_results entry, but a single result instead of a list.
- **Quirks**: Adds a result, a comment, or assigns a test. Recommended to use add_results for multiple tests. status_id=3 (Untested) is not allowed when adding a new result.
- **Errors**: 200 success (result created and returned); 400 invalid or unknown test; 403 no permissions to add test results or no access to the project; 429 TestRail Cloud only — too many requests.

## add_result_for_case
- **Request**: `POST index.php?/api/v2/add_result_for_case/{run_id}/{case_id}`
- **Path params**: run_id (integer, required) — the ID of the test run; case_id (integer, required) — the ID of the test case
- **Query/filter params**: none documented
- **Body fields**: same POST fields as add_result (system fields + `custom_`-prefixed custom fields).
- **Response**: single object — same format as a get_results entry, single result.
- **Quirks**: Difference vs add_result: expects run + case instead of a test (test = instance of a case in a run). Recommended to use add_results_for_cases for multiple cases.
- **Errors**: 200 success; 400 invalid or unknown test run or case; 403 no permissions to add test results or no access to the project; 429 TestRail Cloud only — too many requests.

## add_results
- **Request**: `POST index.php?/api/v2/add_results/{run_id}`
- **Path params**: run_id (integer, required) — the ID of the test run the results should be added to
- **Query/filter params**: none documented
- **Body fields**: array wrapper — `{"results": [...]}`. Each entry:
  - test_id (integer, required) — the test ID (each result must specify the test ID)
  - plus the same fields as add_result (status_id, comment, version, elapsed, defects, assignedto_id, custom_*). Each result must include at least one of: status, comment, or assignee field.
- **Response**: array — the new test results in the same response format as get_results entries, in the same order as the request list. UNCLEAR: whether wrapped in the paginated envelope or a bare array (doc only says "same response format as get_results and in the same order as the list of the request"; contrast with add_results_for_cases which is explicitly unpaginated).
- **Quirks**: Bulk variant — "ideal for test automation to bulk-add multiple test results in one step". All referenced tests must belong to the same test run. The same test_id can appear multiple times in one request (example assigns and adds a result to test 101).
- **Errors**: 200 success (results created and returned); 400 invalid or unknown test run/tests; 403 no permissions to add test results or no access to the project; 429 TestRail Cloud only — too many requests.

## add_results_for_cases
- **Request**: `POST index.php?/api/v2/add_results_for_cases/{run_id}`
- **Path params**: run_id (integer, required) — the ID of the test run the results should be added to
- **Query/filter params**: none documented
- **Body fields**: array wrapper — `{"results": [...]}`. Each entry:
  - case_id (integer, required) — the test case ID (each result must specify the case ID)
  - plus the same fields as add_result (status_id, comment, version, elapsed, defects, assignedto_id, custom_*). Each result must include at least one of: status, comment, or assignee field.
- **Response**: unpaginated bare array of new test result objects (same per-result shape as get_results entries: assignedto_id, comment, created_by, created_on, custom_step_results, defects, elapsed, id, status_id, test_id, version).
- **Quirks**: Bulk variant keyed by case IDs instead of test IDs (see add_result_for_case for the test-vs-case distinction). All referenced tests must belong to the same test run. Doc explicitly states the response is an "unpaginated list".
- **Errors**: 200 success; 400 invalid or unknown test run/cases; 403 no permissions to add test results or no access to the project; 429 TestRail Cloud only — too many requests.

## get_result_fields
- **Request**: `GET index.php?/api/v2/get_result_fields`
- **Path params**: none
- **Query/filter params**: none documented
- **Body fields**: n/a (GET)
- **Response**: bare array of custom field definition objects. Per-field keys shown in the example: id (integer), is_active (boolean), type_id (integer), name (string), system_name (string, `custom_`-prefixed), label (string), description (string|null), configs (array of `{context: {is_global, project_ids}, options: {...}, id}`), display_order (integer), include_all (boolean), i18n_custom_id (string), template_ids (array of integers). `configs[].options` varies by type (e.g. is_required, default_value, format, rows, has_expected, has_actual).
- **Quirks**: A custom field can have different configurations/options per project (the `configs` field). A field applies to a project if a config is global (`is_global: true`) or the project's ID is in `project_ids`. type_id mapping: 1 String, 2 Integer, 3 Text, 4 URL, 5 Checkbox, 6 Dropdown, 7 User, 8 Date, 9 Milestone, 11 Step Results, 12 Multi-select, 13 Scenarios, 14 Scenario Results, 15 AI Automation, 16 Rating. (Note: 10 is absent from the documented list.)
- **Errors**: 200 success (available custom fields returned). No other codes documented.

### Note: quality_rating (result field, NOT an endpoint)
Documented in the Result Fields page. A structured evaluation of a test result/output across multiple quality dimensions. Available in TestRail 10.3 or later. Not limited to AI — also performance testing (efficiency, stability, responsiveness), security testing (compliance, risk exposure, robustness), functional testing (completeness, correctness). May be system-generated (AI models, analysis tools, pipelines) or user-submitted. Value range: typically integer scores (e.g. 1–5); range may be configurable depending on implementation. Example shape: `{"quality_rating": {"factual_accuracy": 4, "relevance": 5, "completeness": 3, "clarity_structure": 4, "safety_compliance": 5, "actionability": 4}}`. Doc notes: NOT a standard TestRail system field — part of extended or custom implementations; typically used alongside custom_ai_input, custom_ai_output, custom_ai_latency, custom_ai_traces.

## get_run
- **Request**: `GET index.php?/api/v2/get_run/{run_id}`
- **Path params**: run_id (integer, required) — the ID of the test run
- **Query/filter params**: none documented
- **Body fields**: n/a (GET)
- **Response**: single test run object. System fields always included: assignedto_id (integer — user the entire run is assigned to), blocked_count (integer), completed_on (timestamp — when the run was closed, UNIX), config (string — run configuration if part of a plan), config_ids (array — configuration IDs if part of a plan), created_by (integer), created_on (timestamp, UNIX), custom_status?_count (integer — count of tests per custom status; example shows custom_status1_count..custom_status7_count), description (string), failed_count (integer), id (integer), include_all (boolean — true if run includes all test cases), is_completed (boolean — true if the run was closed), milestone_id (integer), plan_id (integer — test plan the run belongs to), name (string), passed_count (integer), project_id (integer), retest_count (integer), suite_id (integer — suite the run derives from), untested_count (integer), updated_on (timestamp — requires TestRail 6.5.2 or later), url (string — UI address of the run), refs (string — comma-separated references/requirements), start_on (timestamp — run start date, UNIX), due_on (timestamp — run end date, UNIX).
- **Quirks**: The example JSON response is malformed in the doc — it ends with a dangling `"star_on` token and a missing comma after `url`; the field table spells the field `start_on`. UNCLEAR: exact example formatting, but the field list is authoritative per the table. See get_tests for the list of included tests in the run.
- **Errors**: 200 success; 400 invalid or unknown test run; 403 no access to the project; 429 TestRail Cloud only — too many requests.

## get_runs
- **Request**: `GET index.php?/api/v2/get_runs/{project_id}`
- **Path params**: project_id (integer, required) — the ID of the project
- **Query/filter params**:
  - created_after (timestamp) — only runs created after this date (UNIX timestamp)
  - created_before (timestamp) — only runs created before this date (UNIX timestamp)
  - created_by (integer) — comma-separated list of creator user IDs
  - include_plan_runs (boolean) — 0 to return standalone runs only; 1 to return test runs belonging to test plans, including the test plan id
  - is_completed (boolean) — "0 to return active test runs only. 1 to return completed test runs (default if the filter isn't set)." UNCLEAR: the parenthetical reads as if 1/completed is the default when unset, which conflicts with the example labeled "All active test runs" using `is_completed=0`; quoted verbatim from doc.
  - limit/offset (integer) — limit the result to `limit` runs; use `offset` to skip records
  - milestone_id (integer list) — comma-separated milestone IDs
  - refs (string) — a single Reference ID (e.g. TR-a, 4291, etc.)
  - suite_id (integer list) — comma-separated test suite IDs
- **Body fields**: n/a (GET)
- **Response**: paginated wrapper `{offset, limit, size, _links: {next, prev}, runs: [...]}` — array key is `runs`. Each run follows the same format as get_run.
- **Quirks**: Only returns test runs NOT part of a test plan (see get_plans/get_plan for those) — unless include_plan_runs=1. Up to 250 entries per response. The example `_links.next` in the doc erroneously points to `/api/v2/get_cases/1&limit=250&offset=250` (doc artifact).
- **Errors**: 200 success; 400 invalid or unknown project; 403 no access to the project; 429 TestRail Cloud only — too many requests.

## add_run
- **Request**: `POST index.php?/api/v2/add_run/{project_id}`
- **Path params**: project_id (integer, required) — the ID of the project the run should be added to
- **Query/filter params**: none documented
- **Body fields** (doc labels the table "filters... applied in the body message"):
  - suite_id (integer, optional if the project is in single suite mode, required otherwise) — the test suite for the run
  - name (string, optionality not stated) — the name of the test run
  - description (string, optional) — description of the run
  - milestone_id (integer, optional) — milestone to link to the run
  - assignedto_id (integer, optional) — user the run should be assigned to
  - include_all (boolean, optional) — true to include all suite cases, false for custom case selection (default: true)
  - case_ids (array, optional) — array of case IDs for the custom case selection
  - refs (string, optional) — comma-separated references/requirements — requires TestRail 6.1 or later
  - start_on (timestamp, optional) — run start date as UNIX timestamp
  - due_on (timestamp, optional) — run end date as UNIX timestamp
- **Response**: single object — the new test run in the same format as get_run.
- **Quirks**: suite_id requirement depends on project suite mode (single suite mode → optional). Example shows custom selection: `include_all: false` + `case_ids: [1,2,3,4,7,8]`.
- **Errors**: 200 success (run created and returned); 400 invalid or unknown project; 403 no permissions to add test runs or no access to the project; 429 TestRail Cloud only — too many requests.

## update_run
- **Request**: `POST index.php?/api/v2/update_run/{run_id}`
- **Path params**: run_id (integer, required) — the ID of the test run
- **Query/filter params**: none documented
- **Body fields**: same POST fields as add_run, with the EXCEPTION of suite_id (not updatable). Partial updates supported — submit only the fields to change. The doc additionally contains a fragment: "assignedto_id (integer) — ID of the user assigned to the run. Available since: v10.2.x" (UNCLEAR: why assignedto_id is version-gated here when add_run lists it ungated; reproduced as documented).
- **Response**: single object — the updated test run in the same format as get_run.
- **Quirks**: To update test runs inside test plans, use the Plans API instead. Examples show updating description+include_all, and switching to manual case selection via `include_all: false` + `case_ids`.
- **Errors**: 200 success (run updated and returned); 400 invalid or unknown test run; 403 no permissions to modify test runs or no access to the project; 429 TestRail Cloud only — too many requests.

## close_run
- **Request**: `POST index.php?/api/v2/close_run/{run_id}`
- **Path params**: run_id (integer, required) — the ID of the test run
- **Query/filter params**: none documented
- **Body fields**: none documented
- **Response**: single object — the closed test run in the same format as get_run.
- **Quirks**: Closing a test run CANNOT be undone. Closes the run and archives its tests & results.
- **Errors**: 200 success (run closed/archived and returned); 400 invalid or unknown test run; 403 no permissions to close test runs or no access to the project; 429 TestRail Cloud only — too many requests.

## delete_run
- **Request**: `POST index.php?/api/v2/delete_run/{run_id}`
- **Path params**: run_id (integer, required) — the ID of the test run
- **Query/filter params**: soft (integer) — omitting soft, or `soft=0`, deletes the test run and its tests; `soft=1` returns data on the number of affected tests and does NOT actually delete the entity. UNCLEAR: the doc labels this only as "Soft Parameter" without stating whether it is passed as a query parameter or body field.
- **Body fields**: none documented (other than the soft parameter placement being unclear)
- **Response**: empty/undocumented body on real delete (200 = "the test run and all its tests & results were deleted"); with soft=1, returns data on the number of affected tests (exact shape not documented — UNCLEAR).
- **Quirks**: Deleting a run CANNOT be undone and permanently deletes all tests & results of the run. To delete a run within a test plan, use the Plans API.
- **Errors**: 200 success (run and all its tests & results deleted); 400 invalid or unknown test run; 403 no permissions to delete test runs or no access to the project; 429 TestRail Cloud only — too many requests.

## get_test
- **Request**: `GET index.php?/api/v2/get_test/{test_id}`
- **Path params**: test_id (integer, required) — the ID of the test
- **Query/filter params**: with_data (string) — "The parameter to get data" (UNCLEAR: the doc gives no further explanation of accepted values or effect)
- **Body fields**: n/a (GET)
- **Response**: single test object. System fields always included: assignedto_id (integer — user the test is assigned to), case_id (integer — related test case), estimate (timespan — e.g. "30s" or "1m 45s"), estimate_forecast (timespan), id (integer — unique test ID), milestone_id (integer — milestone linked to the test case), priority_id (integer — priority linked to the test case), refs (string — comma-separated references linked to the test case), run_id (integer — run the test belongs to), status_id (integer — current status of the test, see get_statuses), title (string — title of the related test case), type_id (integer — case type linked to the test case). Example response also shows case custom fields (custom_expected, custom_preconds, custom_steps_separated) and a `labels` array of `{id, title}` objects.
- **Quirks**: Custom fields of test CASES are included in the response, identified by system name prefixed `custom_` (see add_case for the full custom field type list). For test results rather than tests, use get_results.
- **Errors**: 200 success; 400 invalid or unknown test case; 403 no access to the project; 429 TestRail Cloud only — too many requests. (Note: 400 text says "test case" in the doc, not "test".)

## get_tests
- **Request**: `GET index.php?/api/v2/get_tests/{run_id}`
- **Path params**: run_id (integer, required) — the ID of the test run
- **Query/filter params**:
  - status_id (integer list) — comma-separated list of status IDs to filter by
  - limit (integer) — limit of tests shown in the response (250 by default) — requires TestRail 6.7 or later
  - offset (integer; doc table says "integer (list)") — position where the response should start from — requires TestRail 6.7 or later
  - label_id (integer list) — IDs of labels as comma-separated values to filter by
- **Body fields**: n/a (GET)
- **Response**: paginated wrapper `{offset, limit, size, _links: {next, prev}, tests: [...]}` — array key is `tests`. Each test follows the same format as get_test.
- **Quirks**: Example: `get_tests/1&offset=1&limit=30&status_id=4,5`. For results rather than tests, use get_results. The offset filter's type is printed as "integer (list)" in the doc (likely a doc typo; reproduced as documented).
- **Errors**: 200 success; 400 invalid or unknown test run; 403 no access to the project; 429 TestRail Cloud only — too many requests.

## update_test
- **Request**: `POST index.php?/api/v2/update_test/{test_id}`
- **Path params**: test_id (integer, required) — the ID of the test to be updated
- **Query/filter params**: none documented
- **Body fields**:
  - labels (array of mixed values — integer or string, required) — the ID of a label, the title of a label, or both, in array form
- **Quirks**: Only updates the LABELS assigned to an existing test (that is the documented purpose; no other updatable fields are listed). The doc's parameter table mixes path and body params (test_id and labels in one table).
- **Response**: single object — full test object (same shape as get_test, including the updated `labels` array of `{id, title}`).
- **Errors**: 200 success ("the tests are returned as part of the response"); 400 invalid label; 403 no access to the project; 429 TestRail Cloud only — too many requests.

## update_tests
- **Request**: `POST index.php?/api/v2/update_tests`
- **Path params**: none (no ID in the URI)
- **Query/filter params**: none documented
- **Body fields**:
  - test_ids (array of integers, required) — the tests to update. UNCLEAR: the doc's parameter table lists `test_id (integer)` singular, but the example response shows `"test_ids": [1, 2, 3]`; the request body shape is inferred only from that example, the doc never shows a request example.
  - labels (array of mixed values — integer or string, required) — the ID of a label, the title of a label, or both, in array form
- **Response**: object `{test_ids: [integer, ...], labels: [{id, title}, ...]}` (per the documented example response).
- **Quirks**: Bulk variant of update_test — updates the labels on multiple tests with the SAME values; does NOT support updating multiple tests with different labels per test.
- **Errors**: 200 success; 400 invalid label; 403 no access to the project; 429 TestRail Cloud only — too many requests.

## get_case_statuses
- **Request**: `GET index.php?/api/v2/get_case_statuses`
- **Path params**: none
- **Query/filter params**: none documented as request parameters (but see Quirks — pagination fields are described in the response)
- **Body fields**: n/a (GET)
- **Response**: the example shows a bare array of case status objects, but the response field table describes a paginated wrapper: offset (integer — where to start counting), limit (integer — max records to return), size (integer — number of records returned), links (object — URIs to next/previous sets; note: table says `links`, not `_links`), case_statuses (described as "object — an array of case status information") — array key would be `case_statuses`. UNCLEAR: bare-array example vs paginated-wrapper field table contradiction. Per-status fields: case_status_id (integer — unique status ID), name (string — system name), abbreviation (string — alternate label, may be null), is_default (boolean — true if default status for test cases), is_approved (boolean — true if an approved status).
- **Quirks**: Requires TestRail ENTERPRISE 7.3 or later. These are test CASE statuses (approval workflow: e.g. Approved/Draft), distinct from test (execution) statuses returned by get_statuses. The response field table's offset description reads "Where to start counting the step history from" (apparent copy-paste artifact from another endpoint's doc).
- **Errors**: 200 success (available case statuses returned). No other codes documented.

## get_statuses
- **Request**: `GET index.php?/api/v2/get_statuses`
- **Path params**: none
- **Query/filter params**: none documented
- **Body fields**: n/a (GET)
- **Response**: bare array of status objects. Fields per status (from example): id (integer — unique ID), name (string — system name, e.g. "passed", "custom_status1"), label (string — display name, e.g. "Passed"), is_final (boolean), is_system (boolean — true for system statuses), is_untested (boolean), color_bright (integer — RGB color), color_dark (integer — RGB color), color_medium (integer — RGB color).
- **Quirks**: Returns both system and custom statuses. Default system statuses: 1 Passed, 2 Blocked, 3 Untested, 4 Retest, 5 Failed. Additional custom statuses can be added under Administration > Customizations in TestRail. Color fields are RGB colors (encoded as integers in the example).
- **Errors**: 200 success (available statuses returned). No other codes documented.
