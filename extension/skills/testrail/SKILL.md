---
name: testrail
description: Use when the QA asks to read from or write to the company TestRail instance — test cases, runs, results, plans, milestones, sections, attachments, users, reports ("file these results to TestRail", "get the cases in suite X", "create a run for this milestone", "attach this screenshot to the failed result"). Routes to the qa-debug `qa_testrail_get` / `qa_testrail_post` tools, which cover the FULL TestRail API v2 surface (124 endpoints) via a free-form endpoint string — the endpoint catalog below + the references/ files are the signature source. Requires one-time credential setup via the "QA Debug: Configure TestRail" command (VS Code secret storage); if a tool returns TESTRAIL_NOT_CONFIGURED, relay that command name to the QA verbatim and STOP — never ask for credentials in chat. Does NOT engage for generic test-debugging (use qa-debug skill) or element identification (identify-element / identify-live).
---

# /testrail — company TestRail instance access

Two tools cover all 124 documented TestRail API v2 endpoints:

- **`qa_testrail_get`** — every read: `get_*`, `run_report`, `run_cross_project_report`. No confirmation prompt.
- **`qa_testrail_post`** — every write: `add_*` / `update_*` / `delete_*` / `close_*` / `move_*` / `copy_*`. VS Code shows a confirmation dialog on each call.

Both take `endpoint` = the exact path after `/api/v2/` from the catalog below. The company gateway's response quirks are handled **below** the tools — never mention or reason about response prefixes; HTTP-status-mapped named errors are the only failure signal you see.

## Rules

1. **Credentials**: handled by the extension (VS Code secret storage). `TESTRAIL_NOT_CONFIGURED` → tell the QA: *run **"QA Debug: Configure TestRail"** from the Command Palette*, then stop. NEVER ask for a username, password, API key, or instance URL in chat.
2. **Endpoint syntax**: params append with `&`, never `?` (the whole API path is one query string): `get_cases/14&suite_id=8&limit=50`. Percent-encode values containing spaces: `&filter=login%20page`. IDs come from prior reads — don't guess them.
3. **Consult the signature first**: find the endpoint in the catalog below, then read its `references/` file for params, body fields, and response shape before composing a call. Do not improvise field names from memory.
4. **Pagination**: bulk reads return `{ offset, limit, size, _links, <plural-resource-key>: [...] }`, max 250 records/page. Pass `paginate: true` to auto-collect (caps at 8 pages / 2000 records; the result's `paginated.truncated` + `truncatedBy` tell you if there is more). `truncatedBy: "rate_limit"` means a partial result — say so.
5. **Write etiquette**: before ANY `qa_testrail_post` call, state the exact endpoint + a payload summary in chat and get the QA's go-ahead. For `delete_*`, warn that deletes are permanent and cascade (e.g. `delete_project` removes its suites, runs, results). The VS Code dialog is the backstop, not the ask.
6. **Rate-limit etiquette**: prefer bulk endpoints (`add_results_for_cases` over an `add_result_for_case` loop; `update_cases` over per-case updates). TestRail Cloud throttles at 180–300 req/min.
7. **Verify-don't-retry on writes**: `PARSE_ERROR` from a `qa_testrail_post` whose detail says "the write may have been applied" → check with a `get_*` call before re-issuing. Never blind-retry a write.
8. **Non-JSON endpoints**: `get_attachment/{id}` saves the file and returns `{ saved_to, bytes, content_type }` (mention `possiblePrefix: true` to the QA as possible corruption). `get_bdd/{case_id}` returns raw Gherkin as `{ data, nonJson: true }`. `add_bdd` is NOT supported (`UNSUPPORTED_ENDPOINT`) — edit BDD scenarios in the TestRail UI.

## Error codes

| code | meaning / action |
|---|---|
| `TESTRAIL_NOT_CONFIGURED` | Relay: run **"QA Debug: Configure TestRail"**. Stop. |
| `WRONG_TOOL_FOR_WRITE` / `WRONG_TOOL_FOR_READ` | You picked the wrong tool for the verb — switch. |
| `UNKNOWN_ENDPOINT_VERB` | First path segment isn't a documented verb — check the catalog (typo?). |
| `UNSUPPORTED_ENDPOINT` | `add_bdd` — not supported in v1. |
| `INVALID_ENDPOINT` | Malformed endpoint string (whitespace, `?`, `#`, scheme) — fix syntax per Rule 2. |
| `AUTH_FAILED` (401) | Credentials rejected — QA should re-run the configure command. |
| `FORBIDDEN` (403) | The QA's TestRail account lacks permission for this entity. |
| `BAD_REQUEST` (400) | TestRail's own message is included — read it; usually a missing/typo'd field or nonexistent ID. |
| `ENDPOINT_NOT_FOUND` (404) | Endpoint path wrong for this TestRail version. |
| `MAINTENANCE` (409) | Cloud daily maintenance — retry later. |
| `RATE_LIMITED` (429) | Already retried once internally. Slow down; prefer bulk endpoints. |
| `SERVER_ERROR` (5xx) | TestRail-side problem; safe to retry reads later. For writes, verify first (Rule 7). |
| `PARSE_ERROR` | Body wasn't parseable — detail is in the QA Debug output channel. On a write: Rule 7. |
| `NETWORK_ERROR` | Category only (dns / tls / refused / timeout) — VPN or instance reachability; detail in the output channel. |
| `NO_WORKSPACE` / `ATTACHMENT_OUTSIDE_WORKSPACE` | Attachment paths must live inside the open workspace folder. |

## Recipes

- **File results for a run**: `get_run/{run_id}` → confirm with QA → `add_results_for_cases/{run_id}` with `{ "results": [{ "case_id": …, "status_id": 1|5, "comment": … }] }` (status 1=passed 2=blocked 3=untested 4=retest 5=failed; custom statuses via `get_statuses`).
- **Create a run for a milestone**: `get_milestones/{project_id}` → `add_run/{project_id}` with `{ "suite_id", "name", "milestone_id", "include_all" | "case_ids" }`.
- **Attach a failure screenshot**: `qa_testrail_post` `add_attachment_to_result/{result_id}` with `attachment_path` (file inside the workspace; `body` is ignored).
- **Find cases**: `get_cases/{project_id}&suite_id={id}&filter={text}` — `filter` matches case titles.

## Endpoint catalog (all 124 — request lines only; params/bodies/responses in references/)

### Cases / Case Fields / Case Types — details in `references/01-cases.md`

| endpoint | request |
|---|---|
| `get_case` | `GET get_case/{case_id}` |
| `get_cases` | `GET get_cases/{project_id}&suite_id={suite_id}` |
| `get_history_for_case` | `GET get_history_for_case/{case_id}` |
| `add_case` | `POST add_case/{section_id}` |
| `copy_cases_to_section` | `POST copy_cases_to_section/{section_id}` |
| `update_case` | `POST update_case/{case_id}` |
| `update_cases` | `POST update_cases/{suite_id}` |
| `move_cases_to_section` | `POST move_cases_to_section/{section_id}` |
| `delete_case` | `POST delete_case/{case_id}` |
| `delete_cases` | `POST delete_cases/{suite_id}&soft=1` |
| `get_case_fields` | `GET get_case_fields` |
| `add_case_field` | `POST add_case_field` |
| `get_case_types` | `GET get_case_types` |

### Results / Result Fields / Runs / Tests / Statuses — details in `references/02-results-runs-tests.md`

| endpoint | request |
|---|---|
| `get_results` | `GET get_results/{test_id}` |
| `get_results_for_case` | `GET get_results_for_case/{run_id}/{case_id}` |
| `get_results_for_run` | `GET get_results_for_run/{run_id}` |
| `add_result` | `POST add_result/{test_id}` |
| `add_result_for_case` | `POST add_result_for_case/{run_id}/{case_id}` |
| `add_results` | `POST add_results/{run_id}` |
| `add_results_for_cases` | `POST add_results_for_cases/{run_id}` |
| `get_result_fields` | `GET get_result_fields` |
| `get_run` | `GET get_run/{run_id}` |
| `get_runs` | `GET get_runs/{project_id}` |
| `add_run` | `POST add_run/{project_id}` |
| `update_run` | `POST update_run/{run_id}` |
| `close_run` | `POST close_run/{run_id}` |
| `delete_run` | `POST delete_run/{run_id}` |
| `get_test` | `GET get_test/{test_id}` |
| `get_tests` | `GET get_tests/{run_id}` |
| `update_test` | `POST update_test/{test_id}` |
| `update_tests` | `POST update_tests` |
| `get_case_statuses` | `GET get_case_statuses` |
| `get_statuses` | `GET get_statuses` |

### Plans / Milestones / Suites / Sections / Templates — details in `references/03-plans-milestones-suites-sections.md`

| endpoint | request |
|---|---|
| `get_plan` | `GET get_plan/{plan_id}` |
| `get_plans` | `GET get_plans/{project_id}` |
| `add_plan` | `POST add_plan/{project_id}` |
| `add_plan_entry` | `POST add_plan_entry/{plan_id}` |
| `add_run_to_plan_entry` | `POST add_run_to_plan_entry/{plan_id}/{entry_id}` |
| `update_plan` | `POST update_plan/{plan_id}` |
| `update_plan_entry` | `POST update_plan_entry/{plan_id}/{entry_id}` |
| `update_run_in_plan_entry` | `POST update_run_in_plan_entry/{run_id}` |
| `close_plan` | `POST close_plan/{plan_id}` |
| `delete_plan` | `POST delete_plan/{plan_id}` |
| `delete_plan_entry` | `POST delete_plan_entry/{plan_id}/{entry_id}` |
| `delete_run_from_plan_entry` | `POST delete_run_from_plan_entry/{run_id}` |
| `get_milestone` | `GET get_milestone/{milestone_id}` |
| `get_milestones` | `GET get_milestones/{project_id}` |
| `add_milestone` | `POST add_milestone/{project_id}` |
| `update_milestone` | `POST update_milestone/{milestone_id}` |
| `delete_milestone` | `POST delete_milestone/{milestone_id}` |
| `get_suite` | `GET get_suite/{suite_id}` |
| `get_suites` | `GET get_suites/{project_id}` |
| `add_suite` | `POST add_suite/{project_id}` |
| `update_suite` | `POST update_suite/{suite_id}` |
| `delete_suite` | `POST delete_suite/{suite_id}` |
| `get_section` | `GET get_section/{section_id}` |
| `get_sections` | `GET get_sections/{project_id}&suite_id={suite_id}` |
| `add_section` | `POST add_section/{project_id}` |
| `move_section` | `POST move_section/{section_id}` |
| `update_section` | `POST update_section/{section_id}` |
| `delete_section` | `POST delete_section/{section_id}` |
| `get_templates` | `GET get_templates/{project_id}` |

### Projects / Users / Roles / Groups / Priorities — details in `references/04-projects-users-roles.md`

| endpoint | request |
|---|---|
| `get_project` | `GET get_project/{project_id}` |
| `get_projects` | `GET get_projects` |
| `add_project` | `POST add_project` |
| `update_project` | `POST update_project/{project_id}` |
| `delete_project` | `POST delete_project/{project_id}` |
| `get_user` | `GET get_user/{user_id}` |
| `get_current_user` | `GET get_current_user/{user_id}` |
| `get_user_by_email` | `GET get_user_by_email&email={email}` |
| `get_users` | `GET get_users` |
| `add_user` | `POST add_user` |
| `update_user` | `POST update_user/:user_id` |
| `get_roles` | `GET get_roles` |
| `get_group` | `GET get_group/{group_id}` |
| `get_groups` | `GET get_groups` |
| `add_group` | `POST add_group` |
| `update_group` | `POST update_group/{group_id}` |
| `delete_group` | `POST delete_group/{group_id}` |
| `get_priorities` | `GET get_priorities` |

### Attachments / BDDs / Shared Steps / Configurations / Datasets / Variables — details in `references/05-attachments-bdd-shared-config.md`

| endpoint | request |
|---|---|
| `add_attachment_to_case` | `POST add_attachment_to_case/{case_id}` |
| `add_attachment_to_plan` | `POST add_attachment_to_plan/{plan_id}` |
| `add_attachment_to_plan_entry` | `POST add_attachment_to_plan_entry/{plan_id}/{entry_id}` |
| `add_attachment_to_result` | `POST add_attachment_to_result/{result_id}` |
| `add_attachment_to_run` | `POST add_attachment_to_run/{run_id}` |
| `get_attachments_for_case` | `GET get_attachments_for_case/{case_id}&limit={limit}&offset={offset}` |
| `get_attachments_for_plan` | `GET get_attachments_for_plan/{plan_id}&limit={limit}&offset={offset}` |
| `get_attachments_for_plan_entry` | `GET get_attachments_for_plan_entry/{plan_id}/{entry_id}` |
| `get_attachments_for_run` | `GET get_attachments_for_run/{run_id}?limit={limit}&offset={offset}` |
| `get_attachments_for_test` | `GET get_attachments_for_test/{test_id}` |
| `get_attachment` | `GET get_attachment/{attachment_id}` |
| `delete_attachment` | `POST delete_attachment/{attachment_id}` |
| `get_bdd` | `GET get_bdd/{case_id}` |
| `add_bdd` | `POST add_bdd/{section_id}` |
| `get_shared_step` | `GET get_shared_step/{shared_step_id}` |
| `get_shared_step_history` | `GET get_shared_step_history/{shared_step_id}` |
| `get_shared_steps` | `GET get_shared_steps/{project_id}` |
| `add_shared_step` | `POST add_shared_step/{project_id}` |
| `update_shared_step` | `POST update_shared_step/{shared_update_id}` |
| `delete_shared_step` | `POST delete_shared_step/{shared_update_id}` |
| `get_configs` | `GET get_configs/{project_id}` |
| `add_config_group` | `POST add_config_group/{project_id}` |
| `add_config` | `POST add_config/{config_group_id}` |
| `update_config_group` | `POST update_config_group/{config_group_id}` |
| `update_config` | `POST update_config/{config_id}` |
| `delete_config_group` | `POST delete_config_group/{config_group_id}` |
| `delete_config` | `POST delete_config/{config_id}` |
| `get_dataset` | `GET get_dataset/{dataset_id}` |
| `get_datasets` | `GET get_datasets/{project_id}` |
| `add_dataset` | `POST add_dataset/{project_id}` |
| `update_dataset` | `POST update_dataset/{dataset_id}` |
| `delete_dataset` | `POST delete_dataset/{dataset_id}` |
| `get_variables` | `GET get_variables/{project_id}` |
| `add_variable` | `POST add_variable/{project_id}` |
| `update_variable` | `POST update_variable/{variable_id}` |
| `delete_variable` | `POST delete_variable/{variable_id}` |

### Labels / Dynamic Filter Fields / Reports — details in `references/06-labels-filters-reports.md`

| endpoint | request |
|---|---|
| `get_label` | `GET get_label/{label_id}` |
| `get_labels` | `GET get_labels/{project_id}` |
| `update_label` | `POST update_label/{label_id}` |
| `get_dynamic_filter_fields` | `GET get_dynamic_filter_fields/{project_id}` |
| `get_reports` | `GET get_reports/{project_id}` |
| `run_report` | `GET run_report/{report_template_id}` |
| `get_cross_project_reports` | `GET get_cross_project_reports/` |
| `run_cross_project_report` | `GET run_cross_project_report/{report_template_id}` |