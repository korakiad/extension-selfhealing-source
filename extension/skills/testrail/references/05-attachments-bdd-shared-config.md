# Attachments / BDDs / Shared Steps / Configurations / Datasets / Variables — distilled from official TestRail docs (updated 2026-05)

## Endpoint index (36 total)

**Attachments (12):** add_attachment_to_case, add_attachment_to_plan, add_attachment_to_plan_entry, add_attachment_to_result, add_attachment_to_run, get_attachments_for_case, get_attachments_for_plan, get_attachments_for_plan_entry, get_attachments_for_run, get_attachments_for_test, get_attachment, delete_attachment
**BDDs (2):** get_bdd, add_bdd
**Shared Steps (6):** get_shared_step, get_shared_step_history, get_shared_steps, add_shared_step, update_shared_step, delete_shared_step
**Configurations (7):** get_configs, add_config_group, add_config, update_config_group, update_config, delete_config_group, delete_config
**Datasets (5):** get_dataset, get_datasets, add_dataset, update_dataset, delete_dataset
**Variables (4):** get_variables, add_variable, update_variable, delete_variable

---

# Attachments

**Global upload rules (from the Attachments doc header):**
- All attachment uploads (POST) MUST use header `Content-Type: multipart/form-data`.
- "The attachment should be submitted as form data in the body of the request." UNCLEAR: the exact multipart form field name for the file is NOT stated in this doc — it defers to "Accessing the API" documentation and TestRail's language bindings for examples.
- After TestRail 7.1 (cloud), the attachment management system changed: a new attachment ID format was introduced (see the 7.1+ response example under get_attachments_for_case — IDs become UUID strings, with `legacy_id` carried alongside).

## add_attachment_to_case
- **Request**: `POST index.php?/api/v2/add_attachment_to_case/{case_id}`
- **Path params**: case_id (integer, required) — The ID of the test case the attachment should be added to.
- **Query/filter params**: none documented.
- **Body fields** (POST): the attachment file as multipart/form-data (UNCLEAR: form field name not stated in doc).
- **Response**: single object `{"attachment_id": 443}` — attachment_id (integer): the ID of the attachment uploaded to TestRail.
- **Quirks**: Requires TestRail 6.5.2 or later. Max upload size 256MB. multipart/form-data required. Doc prose says "Adds an attachment to a test plan" — copy-paste error in the official doc; the endpoint name and param clearly target a test case.
- **Errors**: 200 success (attachment ID returned); 400 invalid or unknown test case; 403 no access to the project; 429 TestRail Cloud only — too many requests (API rate limit).

## add_attachment_to_plan
- **Request**: `POST index.php?/api/v2/add_attachment_to_plan/{plan_id}`
- **Path params**: plan_id (integer, required) — The ID of the test plan the attachment should be added to.
- **Query/filter params**: none documented.
- **Body fields** (POST): the attachment file as multipart/form-data (UNCLEAR: form field name not stated in doc).
- **Response**: single object `{"attachment_id": 443}` — attachment_id (integer).
- **Quirks**: Requires TestRail 6.3 or later. Max upload size 256MB. multipart/form-data required.
- **Errors**: 200 success; 400 invalid or unknown test plan; 403 no access to the project; 429 Cloud rate limit.

## add_attachment_to_plan_entry
- **Request**: `POST index.php?/api/v2/add_attachment_to_plan_entry/{plan_id}/{entry_id}`
- **Path params**: plan_id (integer, required) — The ID of the test plan containing the entry; entry_id (integer, required) — The ID of the test plan entry the attachment should be added to.
- **Query/filter params**: none documented.
- **Body fields** (POST): the attachment file as multipart/form-data (UNCLEAR: form field name not stated in doc).
- **Response**: single object `{"attachment_id": 443}` — attachment_id (integer).
- **Quirks**: Requires TestRail 6.3 or later. Max upload size 256MB. multipart/form-data required. Two path segments (plan + entry).
- **Errors**: 200 success; 400 POST request not formatted properly or invalid ID parameter(s); 403 no access to the project or insufficient permissions; 429 Cloud rate limit.

## add_attachment_to_result
- **Request**: `POST index.php?/api/v2/add_attachment_to_result/{result_id}`
- **Path params**: result_id (integer, required) — The ID of the test result the attachment should be added to (see the Results API docs for how to obtain result_ids).
- **Query/filter params**: none documented.
- **Body fields** (POST): the attachment file as multipart/form-data (UNCLEAR: form field name not stated in doc).
- **Response**: single object `{"attachment_id": 443}` — attachment_id (integer).
- **Quirks**: Requires TestRail 5.7 or later. Max upload size 256MB. multipart/form-data required. **The ability to edit test results must be enabled under 'Site Settings' for add_attachment_to_result endpoints to work.**
- **Errors**: 200 success; 400 POST request not formatted properly or invalid result ID; 403 no access to the project or insufficient permissions; 429 Cloud rate limit.

## add_attachment_to_run
- **Request**: `POST index.php?/api/v2/add_attachment_to_run/{run_id}`
- **Path params**: run_id (integer, required) — The ID of the test run the attachment should be added to.
- **Query/filter params**: none documented.
- **Body fields** (POST): the attachment file as multipart/form-data (UNCLEAR: form field name not stated in doc).
- **Response**: single object `{"attachment_id": 443}` — attachment_id (integer).
- **Quirks**: Requires TestRail 6.3 or later. Max upload size 256MB. multipart/form-data required.
- **Errors**: 200 success; 400 POST request not formatted properly or invalid run ID; 403 no access to the project or insufficient permissions; 429 Cloud rate limit.

## get_attachments_for_case
- **Request**: `GET index.php?/api/v2/get_attachments_for_case/{case_id}&limit={limit}&offset={offset}` (note: doc shows filters appended with `&`, consistent with the index.php?/ URL style)
- **Path params**: case_id (integer, required) — The ID of the test case to retrieve attachments from.
- **Query/filter params**: limit (integer) — number of attachments to return, default response size 250, requires TestRail 6.7 or later; offset (integer) — where to start counting attachments from, requires TestRail 6.7 or later.
- **Body fields**: n/a (GET).
- **Response**: paginated wrapper `{offset, limit, size, _links: {next, prev}, attachments: [...]}` — array key is **`attachments`**. NOTE: the pre-7.1 example in the doc shows the links object as `_link` (singular) while the 7.1+ example shows `_links`; UNCLEAR which is authoritative pre-7.1 (likely a doc typo, but as printed: `_link`).
  - Pre-7.1 attachment fields (documented system fields): id (integer, unique attachment ID), name (string), size (integer, bytes), created_on (timestamp), project_id (integer), case_id (integer), user_id (integer, uploader), result_id (integer, test result the attachment belongs to).
  - TestRail 7.1+ (cloud) example fields: client_id (integer), project_id (integer), entity_type (string, e.g. "case"), id (string UUID, e.g. "2ec27be4-812f-4806-9a5d-d39130d1691a"), created_on (timestamp), data_id (string UUID), entity_id (string), filename (string), filetype (string), legacy_id (integer), name (string), size (integer), user_id (integer), is_image (boolean), icon (string).
- **Quirks**: Requires TestRail 5.7 or later. After TestRail 7.1 (cloud) attachment IDs switch from integers to UUID strings — code consuming `id` must handle both. limit/offset only on 6.7+.
- **Errors**: 200 success (array of attachment details); 400 invalid test case ID; 403 no access to the project or insufficient permissions; 429 Cloud rate limit.

## get_attachments_for_plan
- **Request**: `GET index.php?/api/v2/get_attachments_for_plan/{plan_id}&limit={limit}&offset={offset}`
- **Path params**: plan_id (integer, required) — The ID of the test plan to retrieve attachments from.
- **Query/filter params**: limit (integer) — number of attachments to return (default 250), TestRail 6.7+; offset (integer) — start offset, TestRail 6.7+.
- **Body fields**: n/a (GET).
- **Response**: the doc's example shows a **bare JSON array** of attachment objects (no pagination wrapper), despite documenting limit/offset filters. Fields: id (integer), name (string), size (integer, bytes), created_on (timestamp), project_id (integer), case_id (integer, null here), user_id (integer), **entity_attachments_id** (integer — the ID of the attachment *record*, not the attachment itself), **icon_name** (string — icon name used in the TestRail UI), result_id (integer).
- **Quirks**: Requires TestRail 6.3 or later. Response shape (bare array) differs from get_attachments_for_case's paginated wrapper as documented — UNCLEAR whether this is a doc inconsistency or real behavior. Extra fields entity_attachments_id and icon_name appear only in this family.
- **Errors**: 200 success; 400 invalid test ID; 403 no access to the project or insufficient permissions; 429 Cloud rate limit.

## get_attachments_for_plan_entry
- **Request**: `GET index.php?/api/v2/get_attachments_for_plan_entry/{plan_id}/{entry_id}`
- **Path params**: plan_id (integer, required) — The ID of the test plan containing the entry; entry_id (integer, required) — The ID of the test plan entry to retrieve attachments from.
- **Query/filter params**: none documented (no limit/offset listed for this endpoint).
- **Body fields**: n/a (GET).
- **Response**: same response format as get_attachments_for_plan.
- **Quirks**: Requires TestRail 6.3 or later.
- **Errors**: 200 success; 400 invalid test ID; 403 no access to the project or insufficient permissions; 429 Cloud rate limit.

## get_attachments_for_run
- **Request**: `GET index.php?/api/v2/get_attachments_for_run/{run_id}?limit={limit}&offset={offset}` (note: doc shows `?limit=` here vs `&limit=` on the case/plan variants — inconsistent in the official doc)
- **Path params**: run_id (integer, required) — The ID of the test run to retrieve attachments from.
- **Query/filter params**: limit (integer) — number of attachments to return (default 250), TestRail 6.7+; offset (integer) — start offset, TestRail 6.7+.
- **Body fields**: n/a (GET).
- **Response**: same response format as get_attachments_for_plan.
- **Quirks**: Requires TestRail 6.3 or later.
- **Errors**: 200 success; 400 invalid test ID; 403 no access to the project or insufficient permissions; 429 Cloud rate limit.

## get_attachments_for_test
- **Request**: `GET index.php?/api/v2/get_attachments_for_test/{test_id}`
- **Path params**: test_id (integer, required) — The ID of the test to retrieve attachments from.
- **Query/filter params**: none documented (no limit/offset listed for this endpoint).
- **Body fields**: n/a (GET).
- **Response**: same response format as get_attachments_for_case. Returns attachments for a test's **results**.
- **Quirks**: Requires TestRail 5.7 or later.
- **Errors**: 200 success; 400 invalid test ID; 403 no access to the project or insufficient permissions; 429 Cloud rate limit.

## get_attachment
- **Request**: `GET index.php?/api/v2/get_attachment/{attachment_id}`
- **Path params**: attachment_id (integer, required) — doc's param description says "The ID of the test to retrieve attachments from" (copy-paste error in official doc; this is the attachment's ID). Note: on TestRail 7.1+ cloud, attachment IDs are UUID strings (see header note), though this doc types the param as integer.
- **Query/filter params**: none documented.
- **Body fields**: n/a (GET).
- **Response**: **the raw file itself, returned in the body of the response** ("Success (the attachment is returned in the body of the response)") — binary/file content, NOT JSON.
- **Quirks**: Requires TestRail 5.7 or later. Do not attempt to JSON-parse the response.
- **Errors**: 200 success (attachment in response body); 400 invalid attachment ID; 403 no access to the project or insufficient permissions; 429 Cloud rate limit.

## delete_attachment
- **Request**: `POST index.php?/api/v2/delete_attachment/{attachment_id}`
- **Path params**: attachment_id (integer, required) — The ID of the attachment to delete.
- **Query/filter params**: none documented.
- **Body fields** (POST): none documented.
- **Response**: **empty response body** with a 200 response code on success.
- **Quirks**: Requires TestRail 5.7 or later. Delete uses POST (not DELETE), as all TestRail write ops do.
- **Errors**: 200 success (attachment deleted); 400 invalid attachment ID; 403 no access to the project or insufficient permissions; 429 Cloud rate limit.

---

# BDDs

## get_bdd
- **Request**: `GET index.php?/api/v2/get_bdd/{case_id}`
- **Path params**: case_id (integer, required) — The ID of the case.
- **Query/filter params**: none documented.
- **Body fields**: n/a (GET).
- **Response**: **raw .feature file content (Gherkin text), NOT JSON** — exports the BDD scenario from a test case as a .feature file (the doc's response example is plain Gherkin: tags, `Feature:`, `Background:`, `Scenario Outline:`, `Scenario:`, `Rule:`, `Examples:` tables).
- **Quirks**: Response body is Gherkin plain text; do not JSON-parse. No version gate documented.
- **Errors**: 200 OK; 400 invalid or unknown test case; 500 an error occurred. (No 403/429 documented for this endpoint.)

## add_bdd

> **NOT SUPPORTED by qa_testrail_post in v1** — the request body is raw `.feature` text (mechanism UNCLEAR in the official docs); the tool rejects it with `UNSUPPORTED_ENDPOINT`. Edit BDD scenarios in the TestRail UI instead.

- **Request**: `POST index.php?/api/v2/add_bdd/{section_id}`
- **Path params**: section_id (integer, required) — The ID of the section.
- **Query/filter params**: none documented.
- **Body fields** (POST): the .feature file content being imported. UNCLEAR: the doc says "Imports/uploads a BDD scenario from a test case as a .feature file" but does NOT specify the upload mechanism (multipart vs raw body) or any field name.
- **Response**: single JSON object — the created test case. Example fields: id (integer), title (string, taken from the Feature name), section_id (integer), template_id (integer, 4 in example), type_id (integer), priority_id (integer), milestone_id (integer|null), refs (string, taken from the feature tag e.g. "APP-1"), created_by/created_on/updated_by/updated_on, estimate, estimate_forecast, suite_id (integer), display_order (integer), is_deleted (0/1), custom_automation_type, **custom_preconds** (string — receives the feature description + Background), custom_steps, **custom_testrail_bdd_scenario** (string — a JSON-encoded array of `{"content": "<scenario text>"}` objects, one per Scenario/Scenario Outline/Example block), custom_expected, custom_steps_separated, custom_mission, custom_goals.
- **Quirks**: The Gherkin is decomposed: Feature name → title, tag → refs, description/Background → custom_preconds, each scenario → an entry in the JSON-string field custom_testrail_bdd_scenario. Created case uses BDD template (template_id 4 in example). No version gate documented.
- **Errors**: 200 OK; 400 invalid or unknown section; 403 insufficient permissions (cannot access project); 500 an error occurred.

---

# Shared Steps

**Section gate:** Shared Test Steps and all related endpoints are only available in **TestRail 7.0 or later**.

## get_shared_step
- **Request**: `GET index.php?/api/v2/get_shared_step/{shared_step_id}`
- **Path params**: shared_step_id (integer, required) — The ID of the set of shared steps.
- **Query/filter params**: none documented.
- **Body fields**: n/a (GET).
- **Response**: single object — id (integer, ID of the set), title (string), project_id (integer), created_by (integer, user ID), created_on (timestamp, UNIX), updated_by (integer), updated_on (timestamp, UNIX), custom_steps_separated (array of step objects), case_ids (array of integers — all test cases which use this set).
  - custom_steps_separated step fields: additional_info (text), content (text — the "Step" field), expected (text — "Expected Result"), refs (string — "References").
- **Quirks**: `custom_steps_separated` is the *default system name* for the separated-steps field; the name may differ if the field was ever removed and recreated with a different system name on the instance.
- **Errors**: 200 success (shared step returned); 400 invalid or unknown shared step; 403 insufficient permissions; 429 Cloud rate limit.

## get_shared_step_history
- **Request**: `GET index.php?/api/v2/get_shared_step_history/{shared_step_id}`
- **Path params**: shared_step_id (integer, required) — The ID of the set of shared steps.
- **Query/filter params**: none documented as request filters, but the response is paginated (offset/limit/size/_links fields present; example limit 250).
- **Body fields**: n/a (GET).
- **Response**: paginated wrapper `{offset, limit, size, _links: {next, prev}, step_history: [...]}` — array key is **`step_history`**. Each change record: id (integer, ID of the change record — example shows it as a string "1"), user_id (integer — example shows string "4"), timestamp (integer, UNIX time of the change), custom_steps_separated (object/array — full step field set consistent with get_shared_step), title (string, the title of the shared step at that revision).
- **Quirks**: Requires **TestRail 7.3 or later** (stricter than the section's 7.0 gate). Doc prose for this endpoint says "Returns an existing set of shared steps" — copy-paste error; it returns the change history. id/user_id appear as strings in the example despite integer typing. Same custom_steps_separated system-name caveat as get_shared_step.
- **Errors**: 200 success (history returned); 400 invalid or unknown shared step; 403 insufficient permissions; 429 Cloud rate limit.

## get_shared_steps
- **Request**: `GET index.php?/api/v2/get_shared_steps/{project_id}` (filters appended with `&`, e.g. `get_shared_steps/1&created_by=1,2`)
- **Path params**: project_id (integer, required) — The ID of the project.
- **Query/filter params** (doc lists these under a "Request body" heading, but the example shows them as URL filters): created_after (timestamp, optional) — only steps created after this UNIX date; created_before (timestamp, optional); created_by (integer list, optional) — comma-separated creator user IDs; limit/offset (integer, optional) — limit result to :limit, :offset to skip records (doc text says "test runs", copy-paste artifact); updated_after (timestamp, optional); updated_before (timestamp, optional); refs (string, optional) — a single Reference ID (e.g. TR-a, 4291).
- **Body fields**: n/a.
- **Response**: paginated wrapper `{offset, limit, size, _links: {next, prev}, shared_steps: [...]}` — array key is **`shared_steps`**; each entry follows the get_shared_step format. `_links.next` example: `/api/v2/get_shared_steps/1&limit=250&offset=250`.
- **Quirks**: Returns up to 250 entries per response; use offset for more.
- **Errors**: 200 success; 400 invalid or unknown set of shared steps; 403 insufficient permissions; 429 Cloud rate limit.

## add_shared_step
- **Request**: `POST index.php?/api/v2/add_shared_step/{project_id}`
- **Path params**: project_id (integer, required) — The ID of the project.
- **Query/filter params**: none.
- **Body fields** (POST): title (string, **required**) — the title for the set of steps; custom_steps_separated (array, optional) — array of step objects, each containing **at least one** of: additional_info (text), content (text), expected (text), refs (string). NOTE: the doc's request-body table also lists created_by, limit/offset, updated_after, updated_before, refs — these are clearly copy-pasted from the get_shared_steps filter table and make no sense for a create call; treat as doc noise (UNCLEAR if the server accepts/ignores them).
- **Response**: the new shared step set, same format as get_shared_step (id, title, project_id, created_by, created_on, updated_by, updated_on, custom_steps_separated, case_ids).
- **Quirks**: Requires permission to **add test cases** within the project. Same custom_steps_separated system-name caveat.
- **Errors**: 200 success (set created and returned); 400 invalid or unknown set of shared steps; 403 insufficient permissions; 429 Cloud rate limit.

## update_shared_step
- **Request**: `POST index.php?/api/v2/update_shared_step/{shared_update_id}`
- **Path params**: shared_update_id (integer, required) — The ID of the set of shared steps (doc names this param `shared_update_id`, not shared_step_id).
- **Query/filter params**: none.
- **Body fields** (POST): same fields as add_shared_step — title (string; table marks it required:true even though the prose says partial updates are supported — UNCLEAR whether title is truly mandatory on update); custom_steps_separated (array, optional). Same copy-pasted filter rows (created_by, limit/offset, updated_after, updated_before, refs) appear in the table — doc noise.
- **Response**: the updated shared step set, same format as get_shared_step.
- **Quirks**: Partial updates supported (submit only specific fields) — BUT when submitting `custom_steps_separated`, **ALL existing steps are replaced**. Requires permission to edit test cases within the project.
- **Errors**: 200 success (set updated and returned); 400 invalid or unknown test; 403 insufficient permissions; 429 Cloud rate limit.

## delete_shared_step
- **Request**: `POST index.php?/api/v2/delete_shared_step/{shared_update_id}`
- **Path params**: shared_update_id (integer, required) — The ID of the set of shared steps.
- **Query/filter params**: none.
- **Body fields** (POST): keep_in_cases (boolean; table says required:true, default 1/true) — submit `{"keep_in_cases": 0}` to ALSO delete the steps from all test cases that used the set, not just from the shared-step repository.
- **Response**: 200 status code and no other data.
- **Quirks**: Deletion cannot be undone. Default behavior (keep_in_cases=1) keeps the steps inside all test cases that used the set. Requires permission to delete test cases within the project.
- **Errors**: 200 success (set deleted); 400 invalid or unknown shared step ID; 403 insufficient permissions; 429 Cloud rate limit.

---

# Configurations

## get_configs
- **Request**: `GET index.php?/api/v2/get_configs/{project_id}`
- **Path params**: project_id (integer, required) — The ID of the project.
- **Query/filter params**: none documented (no pagination).
- **Body fields**: n/a (GET).
- **Response**: **bare JSON array** of configuration groups (no pagination wrapper). Each group: id (integer), name (string, e.g. "Browsers"), project_id (integer), configs (array). Each config inside: id (integer), name (string, e.g. "Chrome"), group_id (integer).
- **Quirks**: Config IDs are what add_plan / add_plan_entry consume (doc cross-references those endpoints for usage). No version gate on this read endpoint (write endpoints below are 5.2+).
- **Errors**: 200 success (configurations returned); 400 invalid or unknown project; 403 no access to the project; 429 Cloud rate limit.

## add_config_group
- **Request**: `POST index.php?/api/v2/add_config_group/{project_id}`
- **Path params**: project_id (integer, required) — The ID of the project the configuration group should be added to.
- **Query/filter params**: none.
- **Body fields** (POST): name (string, required) — the name of the configuration group. Example: `{"name": "Browsers"}`.
- **Response**: the created configuration group "returned as part of the response" (per response-code text); exact shape not shown in doc — UNCLEAR beyond that.
- **Quirks**: Requires TestRail 5.2 or later.
- **Errors**: 200 success (group created and returned); 400 invalid or unknown project; 403 no permissions to add configuration groups or no access to the project; 429 Cloud rate limit.

## add_config
- **Request**: `POST index.php?/api/v2/add_config/{config_group_id}`
- **Path params**: config_group_id (integer, required) — The ID of the configuration group the configuration should be added to.
- **Query/filter params**: none.
- **Body fields** (POST): name (string, required) — the name of the configuration. Example: `{"name": "Chrome"}`.
- **Response**: created entity returned (response-code text says "the configuration group was created" — copy-paste error in doc; this creates a configuration). Exact shape not shown — UNCLEAR.
- **Quirks**: Requires TestRail 5.2 or later.
- **Errors**: 200 success; 400 invalid or unknown project; 403 no permissions to add configuration or no access to the project; 429 Cloud rate limit.

## update_config_group
- **Request**: `POST index.php?/api/v2/update_config_group/{config_group_id}`
- **Path params**: config_group_id (integer, required) — The ID of the configuration group.
- **Query/filter params**: none.
- **Body fields** (POST): name (string, optional) — the new name of the configuration group. Example: `{"name": "Operating Systems"}`.
- **Response**: updated configuration group returned as part of the response; exact shape not shown — UNCLEAR.
- **Quirks**: Requires TestRail 5.2 or later.
- **Errors**: 200 success (group updated and returned); 400 invalid or unknown configuration group; 403 no permissions to modify configuration groups or no access to the project; 429 Cloud rate limit.

## update_config
- **Request**: `POST index.php?/api/v2/update_config/{config_id}`
- **Path params**: config_id (integer, required) — The ID of the configuration.
- **Query/filter params**: none.
- **Body fields** (POST): name (string, optional) — the new name of the configuration. Example: `{"name": "Firefox"}`.
- **Response**: updated configuration returned as part of the response; exact shape not shown — UNCLEAR.
- **Quirks**: Requires TestRail 5.2 or later.
- **Errors**: 200 success (configuration updated and returned); 400 invalid or unknown configuration; 403 no permissions to modify configurations or no access to the project; 429 Cloud rate limit.

## delete_config_group
- **Request**: `POST index.php?/api/v2/delete_config_group/{config_group_id}`
- **Path params**: config_group_id (integer, required) — The ID of the configuration group.
- **Query/filter params**: none.
- **Body fields** (POST): none documented.
- **Response**: success only (group and all its configurations deleted); no body documented.
- **Quirks**: Requires TestRail 5.2 or later. **Cannot be undone; permanently deletes ALL configurations in the group.** Does not affect closed test plans/runs, or active test plans/runs unless they are updated.
- **Errors**: 200 success (group and all its configurations deleted); 400 invalid or unknown configuration group; 403 no permissions to delete configuration groups or no access to the project; 429 Cloud rate limit.

## delete_config
- **Request**: `POST index.php?/api/v2/delete_config/{config_id}`
- **Path params**: config_id (integer, required) — The ID of the configuration.
- **Query/filter params**: none.
- **Body fields** (POST): none documented.
- **Response**: success only (configuration deleted); no body documented.
- **Quirks**: Requires TestRail 5.2 or later. The doc repeats the config-*group* deletion warning verbatim here ("Deleting a configuration group cannot be undone and also permanently deletes all configurations in this group…") — copy-paste artifact; at minimum deletion cannot be undone, and closed plans/runs are unaffected (active ones unaffected unless updated).
- **Errors**: 200 success (configuration deleted); 400 invalid or unknown configuration; 403 no permissions to delete configurations or no access to the project; 429 Cloud rate limit.

---

# Datasets

**Section gate:** every Datasets endpoint documents a 403 "Not an Enterprise license/subscription" — datasets are an **Enterprise-only** feature.

## get_dataset
- **Request**: `GET index.php?/api/v2/get_dataset/{dataset_id}`
- **Path params**: dataset_id (integer, required) — The ID of the dataset to retrieve.
- **Query/filter params**: none documented.
- **Body fields**: n/a (GET).
- **Response**: single object — id (integer, database ID of the dataset), name (string), variables (array of objects, each: id (integer, variable ID), name (string, variable name), value (string, the value from this dataset for that variable)).
- **Quirks**: Enterprise-only (per 403 text). Variable values are strings.
- **Errors**: 200 success; 400 invalid dataset_id / missing dataset_id; 401 authentication failure; 403 insufficient permissions (cannot access this project) / not an Enterprise license/subscription.

## get_datasets
- **Request**: `GET index.php?/api/v2/get_datasets/{project_id}`
- **Path params**: project_id (integer, required) — The ID of the project from which to retrieve datasets.
- **Query/filter params**: none explicitly tabled, but the response carries standard pagination fields ("fields consistent with pagination of existing bulk GET API endpoints"; example limit 250) — so limit/offset behave as on other bulk GETs.
- **Body fields**: n/a (GET).
- **Response**: paginated wrapper `{offset, limit, size, _links: {next, prev}, datasets: [...]}` — array key is **`datasets`**; each entry is a dataset consistent with get_dataset (id, name, variables[{id, name, value}]).
- **Quirks**: Enterprise-only.
- **Errors**: 200 success; 400 invalid project_id / missing project_id; 401 authentication failure; 403 insufficient permissions / not an Enterprise license/subscription.

## add_dataset
- **Request**: `POST index.php?/api/v2/add_dataset/{project_id}`
- **Path params**: project_id (integer, required) — The ID of the project to which the dataset should be added.
- **Query/filter params**: none.
- **Body fields** (POST): name (string — name of the dataset; required by implication, "as provided"); variables (**object of key/value pairs**, NOT an array: key = variable name, value = string value, e.g. `"variables": {"vara": "test", "varb": "rail"}`). The doc's example body also includes an `id` field (`"id": 7`) — UNCLEAR why an id is submitted on create; the doc does not explain it. Required/optional flags are not tabled for body fields — UNCLEAR formally.
- **Response**: single object like get_dataset — id (integer), name (string), variables as an **array** of `{id, name, value}` objects (note the asymmetry: request takes a key/value map, response returns an array).
- **Quirks**: Enterprise-only. Variable names must already exist in the project; values must be submitted as strings and respect length limits; there is a maximum number of allowed datasets (all per the 400 error list). Dataset names must be unique within the project.
- **Errors**: 200 success; 400 invalid project_id / missing project_id / invalid dataset name / dataset name already exists within the project / variable-value pairs contain invalid data (variable name does not exist, values not submitted as strings, values exceed lengths, etc.) / number of allowed datasets exceeded; 401 authentication failure; 403 insufficient permissions (cannot access this project) / not an Enterprise license/subscription.

## update_dataset
- **Request**: `POST index.php?/api/v2/update_dataset/{dataset_id}`
- **Path params**: dataset_id (integer, required) — doc description says "The ID of the project to which the dataset should be updated" (copy-paste error; it is the dataset's ID).
- **Query/filter params**: none.
- **Body fields** (POST): same format as add_dataset (name + variables key/value map).
- **Response**: the updated dataset, same response format as add_dataset (id, name, variables array).
- **Quirks**: Enterprise-only. Same data-validation constraints as add_dataset.
- **Errors**: 200 success; 400 invalid project_id / missing project_id / invalid dataset name / dataset name already exists within the project / variable-value pairs contain invalid data / number of allowed datasets exceeded; 401 authentication failure; 403 insufficient permissions (cannot access project) / insufficient permissions (no add/edit permission for Test Data within the project) / not an Enterprise license/subscription.

## delete_dataset
- **Request**: `POST index.php?/api/v2/delete_dataset/{dataset_id}`
- **Path params**: dataset_id (integer, required) — The ID of the dataset to be deleted.
- **Query/filter params**: none.
- **Body fields** (POST): none documented.
- **Response**: success only; no body documented.
- **Quirks**: Enterprise-only. Deleting a dataset also removes the dataset's values. **The Default dataset cannot be deleted** (400 "dataset_id is the Default dataset").
- **Errors**: 200 success; 400 invalid dataset_id / missing dataset_id / dataset_id is the Default dataset; 401 authentication failure; 403 insufficient permissions (cannot access project) / insufficient permissions (no add/edit permission for Test Data within the project) / not an Enterprise license/subscription.

---

# Variables

**Section gate:** every Variables endpoint documents a 403 "Not an Enterprise license/subscription" — variables (Test Data) are **Enterprise-only**.

## get_variables
- **Request**: `GET index.php?/api/v2/get_variables/{project_id}`
- **Path params**: project_id (integer, required) — The ID of the project from which to retrieve variables.
- **Query/filter params**: none explicitly tabled; response carries standard pagination fields ("consistent with pagination of existing bulk GET API endpoints"; example limit 250).
- **Body fields**: n/a (GET).
- **Response**: paginated wrapper `{offset, limit, size, _links: {next, prev}, variables: [...]}` — array key is **`variables`**; each entry: id (integer, variable's database ID), name (string). (No `value` here — values live on datasets.)
- **Quirks**: Enterprise-only.
- **Errors**: 200 success; 400 invalid project_id / missing project_id; 401 authentication failure; 403 insufficient permissions (cannot access this project) / not an Enterprise license/subscription.

## add_variable
- **Request**: `POST index.php?/api/v2/add_variable/{project_id}`
- **Path params**: project_id (integer, required) — The ID of the project to which the variable should be added.
- **Query/filter params**: none.
- **Body fields** (POST): name (string) — the variable name. The doc's example body also includes `"id": 613` — UNCLEAR why an id is submitted on create (the response returns a different, server-assigned id: 1675). Required/optional flags not tabled — UNCLEAR formally.
- **Response**: single object `{id, name}` — id (integer, ID of the newly added variable), name (string).
- **Quirks**: Enterprise-only. Variable names must be unique within the project; there is a maximum number of allowed variables.
- **Errors**: 200 success; 400 invalid project_id / missing project_id / invalid variable name / variable name already exists within the project / number of allowed variables exceeded; 401 authentication failure; 403 insufficient permissions (cannot access this project) / insufficient permissions (no add/edit permission for Test Data within the project) / not an Enterprise license/subscription.

## update_variable
- **Request**: `POST index.php?/api/v2/update_variable/{variable_id}`
- **Path params**: variable_id (integer, required) — The ID of the variable to update.
- **Query/filter params**: none.
- **Body fields** (POST): same format as add_variable (name; doc says "the request body for the new dataset has the same response format as add_variable" — "dataset" is a copy-paste error for "variable").
- **Response**: single object `{id, name}` — same format as add_variable (doc again says "returns the new dataset"; copy-paste error — it returns the variable).
- **Quirks**: Enterprise-only.
- **Errors**: 200 success; 400 invalid variable_id / missing variable_id / invalid variable name / variable name already exists within the project; 401 authentication failure; 403 insufficient permissions (cannot access project) / insufficient permissions (no add/edit permission for Test Data within the project) / not an Enterprise license/subscription.

## delete_variable
- **Request**: `POST index.php?/api/v2/delete_variable/{variable_id}`
- **Path params**: variable_id (integer, required) — The ID of the variable to be deleted.
- **Query/filter params**: none.
- **Body fields** (POST): none documented.
- **Response**: success only; no body documented.
- **Quirks**: Enterprise-only. **Deleting a variable also deletes the corresponding values from all datasets.** Note the 403 here cites a *delete* permission for Test Data (vs add/edit on the other write endpoints).
- **Errors**: 200 success; 400 invalid variable_id / missing variable_id; 401 authentication failure; 403 insufficient permissions (cannot access project) / insufficient permissions (no delete permission for Test Data within the project) / not an Enterprise license/subscription.
