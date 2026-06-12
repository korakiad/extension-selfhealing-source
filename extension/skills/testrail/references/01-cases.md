# Cases / Case Fields / Case Types — distilled from official TestRail docs (updated 2026-05)

Source docs: Cases (updated 2026-05-26), Case Fields (updated 2026-05-27), Case Types (updated 2026-05-26).

## Endpoint index (13 total)

Cases:
1. get_case
2. get_cases
3. get_history_for_case
4. add_case
5. copy_cases_to_section
6. update_case
7. update_cases
8. move_cases_to_section
9. delete_case
10. delete_cases

Case Fields:
11. get_case_fields
12. add_case_field

Case Types:
13. get_case_types

---

## get_case
- **Request**: `GET index.php?/api/v2/get_case/{case_id}`
- **Path params**: case_id (integer, required) — the ID of the test case
- **Query/filter params**: none documented.
- **Body fields**: n/a (GET)
- **Response**: single test case object. System fields always included:
  - id (integer) — unique ID of the test case
  - title (string) — title
  - section_id (integer) — section the case belongs to
  - template_id (integer) — template/field-layout ID — requires TestRail 5.2+
  - type_id (integer) — linked case type ID
  - priority_id (integer) — linked priority ID
  - milestone_id (integer) — linked milestone ID
  - refs (string) — comma-separated references/requirements
  - created_by (integer) / created_on (timestamp, UNIX)
  - updated_by (integer) / updated_on (timestamp, UNIX)
  - estimate (timespan, e.g. "30s", "1m 45s") / estimate_forecast (timespan)
  - suite_id (integer) — suite the case belongs to
  - Example also shows: display_order, is_deleted (0/1), and a `labels` array of `{id, title, created_by, created_on}` objects (not in the system-field table; the example JSON for labels is malformed in the doc).
  - Custom fields included with system name prefixed `custom_` (e.g. custom_preconds, custom_steps, custom_expected, custom_steps_separated, custom_mission, custom_goals, custom_automation_type).
- **Quirks**: custom field types are documented under add_case (doc cross-references it).
- **Errors**: 200 success (case returned); 400 invalid or unknown test case; 403 no access to the project; 429 TestRail Cloud only — too many requests (API rate limit).

## get_cases
- **Request**: `GET index.php?/api/v2/get_cases/{project_id}&suite_id={suite_id}`
- **Path params**: project_id (integer, required) — the ID of the project
- **Query/filter params**:
  - suite_id (integer) — test suite ID (optional if the project operates in single suite mode; otherwise see description = effectively required)
  - created_after (timestamp) — only cases created after this date (UNIX timestamp)
  - created_before (timestamp) — only cases created before this date (UNIX timestamp)
  - created_by (integer list) — comma-separated list of creator user IDs
  - filter (string) — only cases with matching filter string in the case title
  - limit (integer) — number of cases to return; response size is 250 by default — requires TestRail 6.7+
  - offset (integer) — where to start counting cases from — requires TestRail 6.7+
  - milestone_id (integer list) — comma-separated milestone IDs (not available if the milestone field is disabled for the project)
  - priority_id (integer list) — comma-separated priority IDs
  - refs (string) — a single Reference ID (e.g. TR-1, 4291) — requires TestRail 6.5.2+
  - section_id (integer) — ID of a test case section
  - template_id (integer list) — comma-separated template IDs — requires TestRail 5.2+
  - type_id (integer list) — comma-separated case type IDs
  - updated_after (timestamp) — only cases updated after this date (UNIX timestamp)
  - updated_before (timestamp) — only cases updated before this date (UNIX timestamp)
  - updated_by (integer) — comma-separated list of user IDs who updated cases (doc declares type "integer" but describes a comma-separated list)
  - label_id (integer list) — comma-separated label IDs
- **Body fields**: n/a (GET)
- **Response**: paginated wrapper `{offset, limit, size, _links: {next, prev}, cases: [...]}` — array key is `cases`; each element has the same format as get_case.
- **Quirks**: one doc example shows a combined usage with odd syntax `&offset=:5&limit=:10&filter=:login` (colons appear verbatim in the doc; other examples use plain `=`). Filters are appended with `&` after the project_id path segment (TestRail's `index.php?/...` URL style).
- **Errors**: 200 success (cases returned); 400 invalid or unknown test case; 403 no access to the project; 429 TestRail Cloud only — too many requests (API rate limit).

## get_history_for_case
- **Request**: `GET index.php?/api/v2/get_history_for_case/{case_id}`
- **Path params**: case_id (integer, required) — the ID of the test case
- **Query/filter params**:
  - limit (integer) — number of case changes to return; response size 250 by default — requires TestRail 6.7+
  - offset (integer) — where to start counting case changes from — requires TestRail 6.7+
- **Body fields**: n/a (GET)
- **Response**: paginated wrapper `{offset, limit, size, _links: {next, prev}, history: [...]}` — array key is `history`. NOTE: the doc's example wraps this whole object inside an outer JSON array `[ { ...wrapper... } ]`; UNCLEAR whether the real response is the wrapper object or an array containing it.
  Each history entry (change record):
  - id (integer) — ID of the test case change
  - created_on (timestamp) — UNIX timestamp the change was made
  - type_id (integer) — change type; typically 6, indicating an 'update'
  - user_id (integer) — ID of the user who made the change
  - changes (array) — details of the changes; each element may contain:
    - type_id (integer) — type of the updated field: 1=string, 2=integer, 3=boolean, 4=date, 5=timespan, 6=text, 7=URL, 8=steps
    - old_text (text) / new_text (text) — previous/new value (used for text fields)
    - label (string) — field label as seen in the UI
    - options (array) — options configured on the field (required, default value, etc.)
    - field (string) — system name of the updated field
    - old_value (varies) / new_value (varies) — previous/new value for any non-text field, including the separated steps field; text or integer depending on field type
- **Quirks**: endpoint itself requires TestRail 6.5.4 or later; limit/offset require 6.7+.
- **Errors**: 200 success; 400 invalid or unknown test case; 403 no access to the project; 429 TestRail Cloud only — too many requests (API rate limit).

## add_case
- **Request**: `POST index.php?/api/v2/add_case/{section_id}`
- **Path params**: section_id (integer, required) — the ID of the section the test case should be added to
- **Query/filter params**: none documented.
- **Body fields** (system fields):
  - title (string, required) — title of the test case
  - template_id (integer, optional) — template (field layout) ID — requires TestRail 5.2+
  - type_id (integer, optional) — case type ID
  - priority_id (integer, optional) — case priority ID
  - estimate (timespan, optional) — e.g. "30s" or "1m 45s"
  - milestone_id (integer, optional) — milestone to link to the case
  - refs (string, optional) — comma-separated references/requirements
  - labels (array of mixed integer|string, optional) — label ID, label title, or both, in array form
  - Custom fields: submit with system name prefixed `custom_` (e.g. `"custom_preconds": "..."`). Supported custom field value types:

  | Custom field type | JSON type | Value semantics |
  |---|---|---|
  | Checkbox | boolean | true = checked, false otherwise |
  | Date | string | date in the format configured for TestRail and the API user (e.g. "07/08/2013") |
  | Dropdown | integer | ID of a dropdown value as configured in the field configuration |
  | Integer | integer | a valid integer |
  | Milestone | integer | ID of a milestone |
  | Multi-select | array | array of IDs as configured in the field configuration |
  | Steps | array | array of step objects (see below) |
  | String | string | max length 250 characters |
  | Text | string | no maximum length |
  | URL | string | string matching URL syntax |
  | User | integer | ID of a user |

  - Structured steps (`custom_steps_separated`): array of `{content, expected}` objects; a shared test step is referenced as `{"shared_step_id": <id>}`. (The doc's combined steps+labels request example is malformed JSON — labels array nested inside the steps array with smart quotes.)
- **Response**: single object — the new test case in the same format as get_case (same system-field list as get_case: created_by, created_on, estimate, estimate_forecast, id, milestone_id, priority_id, refs, section_id, suite_id, template_id [5.2+], title, type_id, updated_by, updated_on, plus `custom_`-prefixed custom fields).
- **Quirks**: none beyond the custom-field typing rules above.
- **Errors**: 200 success (case created and returned); 400 invalid or unknown test case; 403 no access to the project; 429 TestRail Cloud only — too many requests (API rate limit).

## copy_cases_to_section
- **Request**: `POST index.php?/api/v2/copy_cases_to_section/{section_id}`
- **Path params**: section_id (integer, required) — the ID of the section the test case(s) should be copied to
- **Query/filter params**: none documented.
- **Body fields**:
  - case_ids (array of integers, optional per the doc's Required column — "false") — described as "a comma-separated list of case IDs". UNCLEAR: type says array of integers but description says comma-separated list; also UNCLEAR why it is marked not-required.
- **Response**: not shown in the doc beyond the 200 description "the test cases are copied as part of the response". UNCLEAR: exact response shape.
- **Quirks**: copies to another suite/section (bulk operation by nature).
- **Errors**: 200 success (cases copied); 400 invalid or unknown test case; 403 no access to the project; 429 TestRail Cloud only — too many requests (API rate limit).

## update_case
- **Request**: `POST index.php?/api/v2/update_case/{case_id}`
- **Path params**: case_id (integer, required) — the ID of the test case
- **Query/filter params**: none documented.
- **Body fields** (all optional; partial updates supported — submit only the fields to change):
  - section_id (integer, optional) — section the case should be moved/updated to — updating section_id requires TestRail 6.5.2+
  - title (string, optional)
  - template_id (integer, optional) — requires TestRail 5.2+
  - type_id (integer, optional)
  - priority_id (integer, optional)
  - estimate (timespan, optional)
  - milestone_id (integer, optional)
  - refs (string, optional)
  - labels (array of mixed integer|string, optional) — label ID, label title, or both
  - Supports the same POST fields as add_case, including `custom_`-prefixed custom fields.
- **Response**: single object — the updated test case in the same format as get_case.
- **Quirks**: partial updates supported; section_id update gated on TestRail 6.5.2+.
- **Errors**: 200 success (case updated and returned); 400 invalid or unknown test case; 403 no access to the project; 429 TestRail Cloud only — too many requests (API rate limit).

## update_cases (bulk)
- **Request**: `POST index.php?/api/v2/update_cases/{suite_id}`
- **Path params**: suite_id (integer, "see description") — the ID of the test suite (optional if the project operates in single suite mode)
- **Query/filter params**: none documented.
- **Body fields**:
  - case_ids (array of integers, required) — IDs of the cases to update
  - section_id (integer, optional) — requires TestRail 6.5.2+ to update
  - title (string, optional)
  - template_id (integer, optional) — requires TestRail 5.2+
  - type_id (integer, optional)
  - priority_id (integer, optional)
  - estimate (timespan, optional)
  - milestone_id (integer, optional)
  - refs (string, optional)
  - labels (array of mixed integer|string, optional)
  - Supports the same POST fields as add_case (incl. custom fields).
- **Response**: doc says "returns the new test case using the same response format as get_case". UNCLEAR: whether a single object or an array is returned for multiple updated cases.
- **Quirks**: bulk variant of update_case — applies the SAME values to all listed cases; does NOT support different values per test case.
- **Errors**: 200 success; 400 invalid or unknown test case; 403 no access to the project; 429 TestRail Cloud only — too many requests (API rate limit).

## move_cases_to_section
- **Request**: `POST index.php?/api/v2/move_cases_to_section/{section_id}`
- **Path params**: section_id (integer, required) — the ID of the section the case(s) will be moved to
- **Query/filter params**: none documented.
- **Body fields**:
  - suite_id (integer, required) — the ID of the suite the case will be moved to
  - case_ids (array of integers, required) — described as "a comma-separated list of case IDs" (type/description mismatch as in copy_cases_to_section)
- **Response**: not shown beyond the 200 description "the test cases are updated as part of the response". UNCLEAR: exact response shape.
- **Quirks**: moves across suite AND section (both targets in body).
- **Errors**: 200 success (cases updated); 400 invalid or unknown test case; 403 no access to the project; 429 TestRail Cloud only — too many requests (API rate limit).

## delete_case
- **Request**: `POST index.php?/api/v2/delete_case/{case_id}`
- **Path params**: case_id (integer, required) — the ID of the test case
- **Query/filter params**:
  - soft (integer, optional) — `soft=1` returns information about the data which WOULD be deleted (number of affected tests) without actually deleting; omitting soft or `soft=0` performs the deletion. (Doc lists it in the parameter table; the example URI does not show where it goes — by analogy with delete_cases it is appended to the URL.)
- **Body fields**: none documented.
- **Response**: 200 description says "the test case is deleted as part of the response"; with soft=1, returns data on the number of affected tests. UNCLEAR: exact response shape.
- **Quirks**: WARNING in doc — deletion cannot be undone and also permanently deletes all test results in active (not-yet-closed/archived) test runs.
- **Errors**: 200 success (case deleted); 400 invalid or unknown test case; 403 no access to the project; 429 TestRail Cloud only — too many requests (API rate limit).

## delete_cases (bulk)
- **Request**: `POST index.php?/api/v2/delete_cases/{suite_id}&soft=1`
- **Path params**: suite_id (integer, "see description") — the ID of the suite (only required if the project is in multi-suite mode)
- **Query/filter params**:
  - soft (integer, optional) — `soft=1` returns information about the data which would be deleted without proceeding with the deletion
- **Body fields**:
  - case_ids (array of integers, required) — IDs of the test cases to delete, e.g. `{"case_ids": [1, 2, 3]}`
  - project_id (integer, required) — the ID of the project. UNCLEAR: the parameter table marks project_id required, but the URI template only shows {suite_id}; the doc does not show where project_id is placed (body example contains only case_ids).
- **Response**: 200 description says "the test cases are deleted as part of the response". UNCLEAR: exact response shape.
- **Quirks**: same WARNING as delete_case — cannot be undone; permanently deletes all test results in active test runs. Bulk variant of delete_case.
- **Errors**: 200 success (cases deleted); 400 invalid or unknown test case; 403 no access to the project; 429 TestRail Cloud only — too many requests (API rate limit).

---

## get_case_fields
- **Request**: `GET index.php?/api/v2/get_case_fields`
- **Path params**: none.
- **Query/filter params**: none documented.
- **Body fields**: n/a (GET)
- **Response**: plain array of custom field definition objects (no pagination wrapper). Each definition includes:
  - id (integer), name (string, e.g. "preconds"), system_name (string, e.g. "custom_preconds"), label (string), description (string), display_order (integer), type_id (integer — see type table below)
  - configs (array) — per-project configurations; each config has:
    - context: `{is_global (boolean), project_ids (null | array)}` — field applies to a project if is_global is true OR project_ids contains the project's ID
    - id (string)
    - options: e.g. `{default_value, format ("markdown"), is_required (boolean), rows ("5")}` — options vary by field type
- **Custom field type table (type_id)**:

  | type_id | Name |
  |---|---|
  | 1 | String |
  | 2 | Integer |
  | 3 | Text |
  | 4 | URL |
  | 5 | Checkbox |
  | 6 | Dropdown |
  | 7 | User |
  | 8 | Date |
  | 9 | Milestone |
  | 10 | Steps |
  | 12 | Multi-select |

  (No type_id 11 is listed in the doc.)
- **Quirks**: a custom field can have different configurations/options per project (configs array); applicability test = is_global OR project ID in project_ids.
- **Errors**: 200 success (available custom fields returned); 429 TestRail Cloud only — too many requests (API rate limit).

## add_case_field
- **Request**: `POST index.php?/api/v2/add_case_field`
- **Path params**: none.
- **Query/filter params**: none documented.
- **Body fields**:
  - type (string, required) — type identifier for the new field. Supported: String, Integer, Text, URL, Checkbox, Dropdown, User, Date, Milestone, Steps, Multiselect. You can pass the type number or the word, e.g. "5", "string", "String", "Dropdown", "12" — but numbers MUST be sent as strings: `{type: "5"}` not `{type: 5}`, otherwise 400 (Bad Request).
  - name (string, required) — name for the new custom field. Use a simple name WITHOUT the "custom_" prefix — it is added automatically (e.g. "my_int" becomes "custom_my_int").
  - label (string, required) — label for the new custom field
  - description (string, optional)
  - include_all (boolean, optional) — true to include the field for all templates; if false, specify template IDs via template_ids
  - template_ids (array, optional) — template IDs the field applies to when include_all is false
  - configs (object, required) — "an object wrapped in an array" with two default keys per entry: `context` and `options`:
    - context: `{"is_global": true, "project_ids": []}` for global; for specific projects: `{"is_global": false, "project_ids": [5, 10]}`
    - options: "is_required" (boolean) is common to all types. Most types allow "default_value" EXCEPT Multiselect, Milestone, and Date (not allowed there). Dropdown special option `items`: newline-separated `"1, First\n2, Second"`. Text special options: `format` ("plain" or "markdown") and `rows` (initial form size; valid values "3"…"10" or "" empty string).
- **Response**: single object — the new custom field, e.g. fields: id (integer), name, system_name (custom_-prefixed), entity_id (integer), label, description, type_id (integer), location_id (integer), display_order (integer), configs (NOTE: returned as a JSON-encoded STRING, not an array — per the example response), is_multi (0/1), is_active (0/1), status_id (integer), is_system (0/1), include_all (0/1), template_ids (array).
- **Quirks**: type-as-string requirement (400 otherwise); configs round-trips as an escaped JSON string in the response; "custom_" prefix auto-added; per-type option constraints above.
- **Errors**: 200 success (new custom field returned); 400 bad request — check the error message for diagnostics; 404 not found, bad parameter passed; 429 TestRail Cloud only — too many requests (API rate limit).

---

## get_case_types
- **Request**: `GET index.php?/api/v2/get_case_types`
- **Path params**: none.
- **Query/filter params**: none documented.
- **Body fields**: n/a (GET)
- **Response**: plain array of case type objects (no pagination wrapper). Each:
  - id (integer) — unique ID
  - name (string) — e.g. "Automated", "Functionality", "Other"
  - is_default (boolean) — true for the default case type, false otherwise
- **Quirks**: none documented.
- **Errors**: 200 success (case types returned). No other status codes documented for this endpoint.
