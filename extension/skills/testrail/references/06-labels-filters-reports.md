# Labels / Dynamic Filter Fields / Reports — distilled from official TestRail docs (updated 2026-05)

Endpoint index (8 total):
1. get_label
2. get_labels
3. update_label
4. get_dynamic_filter_fields
5. get_reports
6. run_report
7. get_cross_project_reports
8. run_cross_project_report

---

## get_label
- **Request**: `GET index.php?/api/v2/get_label/{label_id}`
- **Path params**: label_id (integer, required) — The ID of the label.
- **Query/filter params**: none documented.
- **Body fields**: n/a (GET).
- **Response**: single object. Example fields: `id` (integer), `name` (string, e.g. "Release 2.0"), `created_by` (shown as `"user_id"` string in example), `created_on` (described as "unique timestamp"). UNCLEAR: get_label example uses `name` while get_labels items and update_label response use `title` — field naming is inconsistent across the doc.
- **Quirks**: none documented beyond the name/title inconsistency above.
- **Errors**: 200 Success (label returned in response); 400 Invalid label; 403 No access to the project; 429 TestRail Cloud only — too many requests (see API rate limit).

## get_labels
- **Request**: `GET index.php?/api/v2/get_labels/{project_id}`
- **Path params**: project_id (integer, required) — The ID of the project.
- **Query/filter params**:
  - offset (integer, optional) — "Where to start counting the test cases from the offset." (doc says "test cases", likely meaning labels — recorded verbatim)
  - limit (integer, optional) — The number of labels the response should return.
- **Body fields**: n/a (GET).
- **Response**: paginated wrapper `{offset, limit, size, _links: {next, prev}, labels: [...]}` — array key is **`labels`**. Each label item: `id` (integer), `title` (string), `created_by` (string in example, e.g. "2"), `created_on` (timestamp). Example shows limit/size 250 and `_links.next` like `/api/v2/get_labels/1&limit=250&offset=250`.
- **Quirks**: list items use `title` while get_label's single-object example uses `name` (doc inconsistency).
- **Errors**: 200 Success (labels returned in response); 400 Invalid label (doc says "Invalid label" even though the input is a project_id — recorded verbatim); 403 No access to the project; 429 TestRail Cloud only — too many requests (see API rate limit).

## update_label
- **Request**: `POST index.php?/api/v2/update_label/{label_id}`
- **Path params**: label_id (integer) — label to update (appears in the URI template; the parameter table does not re-list it).
- **Query/filter params**: none documented.
- **Body fields**:
  - project_id (integer, required) — The ID of the project where the label is to be updated.
  - title (string, required) — The title of the label. Maximum 20 characters allowed.
- **Response**: single object. Example: `{ "id": 1, "title": "Release 2.0" }` — fields `id` (integer), `title` (string).
- **Quirks**: doc's parameter table lists project_id/title but not label_id (label_id only appears in the URI). UNCLEAR: whether project_id/title are body fields vs. other transport — the doc gives a single "Parameters" table without distinguishing.
- **Errors**: 200 Success (the label is returned as part of the response); 400 "Invalid or unknown test case" (verbatim from doc — apparent copy-paste artifact; presumably means invalid/unknown label); 403 No access to the project; 429 TestRail Cloud only — too many requests (see API rate limit).

NOTE: The Labels doc defines ONLY get_label, get_labels, update_label. No add_label or delete_label endpoint appears in this file.

---

## get_dynamic_filter_fields
- **Request**: `GET index.php?/api/v2/get_dynamic_filter_fields/{project_id}`
- **Path params**: project_id (integer, required) — The ID of the project for which dynamic filter fields should be returned.
- **Query/filter params**: none documented (no pagination).
- **Body fields**: n/a (GET).
- **Response**: plain JSON **array** of field-definition objects (no pagination wrapper). Each object:
  - type_id (integer) — field type ID; clients use it to determine how to render/construct filters.
  - system_name (string) — system name of the field; used when constructing dynamic_filters.
  - label (string) — display label of the field.
  - options (string) — available options for fields with selectable values (dropdown, multiselect, user, milestone, priority, status, type, templates). Format in examples: newline-separated `"<id>, <label>"` pairs, e.g. `"1, Low\n2, Medium\n3, High"`.
  - sub_filters (string) — supported operators for condition-based fields (string, URL, integer, date), e.g. `"1, Is\n2, Is Not\n5, Contains\n6, Does not contain"`.
  - Field type IDs documented: 1 String, 2 Integer, 3 Text, 4 URL, 5 Checkbox, 6 Dropdown, 7 User, 8 Date, 9 Milestone, 10 Steps, 12 Multi-select. (11 is absent from the table.)
  - Supported system fields can include: Assigned To, Automation Type, Created By, Created On, Estimate, Forecast, Labels, Milestone, Priority, References, Templates, Title, Type, Updated By, Updated On — plus active custom case fields available for the project and supported by dynamic filtering.
- **Quirks**:
  - Returns only fields supported by TestRail's dynamic filter behavior for the selected project (matches the UI's dynamic filter fields). Non-filterable field types — Text, Steps, Scenarios — are NOT returned.
  - When using a returned field in a `dynamic_filters` payload, prefix the system_name with `cases:` (e.g. `"cases:priority_id": {"values": [2]}` inside `{"mode": "1", "filters": {...}}`).
  - Intended to be called BEFORE constructing dynamic_filters payloads (for API clients, CLIs, integrations rendering filter options outside the UI).
  - Dynamic filters are supported when creating or updating test runs and test plans (selections behave like the UI's Selection Filter).
- **Errors**: 200 Success (available dynamic filter fields returned); 400 Invalid or unknown project; 403 No access to the project; 429 TestRail Cloud only — too many requests.

---

## get_reports
- **Request**: `GET index.php?/api/v2/get_reports/{project_id}`
- **Path params**: project_id (integer, required) — The ID of the project for which you want a list of API accessible reports.
- **Query/filter params**: none documented (no pagination).
- **Body fields**: n/a (GET).
- **Response**: plain JSON **array** of report objects (no pagination wrapper). System fields ALWAYS included:
  - id (integer) — unique ID for the report
  - name (string) — name of the report
  - description (string) — description of the report
  - notify_user (boolean) — whether the author should be notified once the report has been executed
  - notify_link (boolean) — whether emails with links to the report should be sent
  - notify_link_recipients (string) — list of users to whom the report should be sent
  - notify_attachment (boolean) — whether the report should be emailed as an attachment
  - notify_attachment_html_format (boolean) — emailed in HTML format, if notify_attachment is true
  - notify_attachment_pdf_format (boolean) — emailed in PDF format, if notify_attachment is true
  - Example also shows report-template-specific fields (not in the "always included" table): notify_attachment_recipients, cases_groupby, changes_daterange, changes_daterange_from/to, suites_include, suites_ids, sections_include, sections_ids, cases_columns (object mapping e.g. `"cases:id": 75`), cases_filters, cases_limit, content_hide_links, cases_include_new, cases_include_updated.
- **Quirks**: Only reports created with the "Create this report: On-demand via the API" checkbox checked are visible/executable via the API (they appear in the report list's "API Templates" section). The "Create this report:" setting CANNOT be modified after the report is saved — existing scheduled reports cannot be converted to API-accessible.
- **Errors**: 200 Success (reports returned in response); 400 Invalid or unknown project; 403 No access to the project; 429 TestRail Cloud only — too many requests (see API rate limit).

## run_report
- **Request**: `GET index.php?/api/v2/run_report/{report_template_id}`
- **Path params**: report_template_id (type not stated in a parameter table; the prose calls it "the report_id parameter") — ID of the API-accessible report template to execute. UNCLEAR: doc text says "identified using the report_id parameter" while the URI says {report_template_id}.
- **Query/filter params**: none documented.
- **Body fields**: n/a (GET).
- **Response**: single object with URLs for accessing the generated report:
  - report_url (string) — e.g. `.../index.php?/reports/view/383`
  - report_html (string) — e.g. `.../index.php?/reports/get_html/383`
  - report_pdf (string) — e.g. `.../index.php?/reports/get_pdf/383`
- **Quirks**:
  - Version gate: **requires TestRail 5.7 or later**.
  - Async generation: "The report may not be available immediately after being run, and the time the report takes before it is available can vary, especially for TestRail Server customers" — i.e. the returned URLs may not be immediately fetchable.
  - Note it is a GET despite executing/triggering a report run.
- **Errors**: 200 Success (the reports are returned in the response); 400 Invalid report template ID; 403 No access to the project; 429 TestRail Cloud only — too many requests (see API rate limit).

## get_cross_project_reports
- **Request**: `GET index.php?/api/v2/get_cross_project_reports/`
- **Path params**: none — "Does not have an input parameter."
- **Query/filter params**: none documented.
- **Body fields**: n/a (GET).
- **Response**: plain JSON **array** of cross-project report objects (no pagination wrapper). System fields ALWAYS included:
  - id (integer) — unique ID for the report
  - name (string) — name of the report
  - description (string) — description of the report
  - project_ids (list) — project IDs included in the report
  - user_ids (list) — user IDs included in the report — **available for User Workload reports only**
  - include_elapsed_test_time (boolean) — whether test elapsed time is included — **User Workload only**
  - include_estimated_test_time (boolean) — whether test estimated time is included — **User Workload only**
  - sort_by (string) — selected sorting option — **User Workload only**
  - include_open_milestones (boolean) — whether open milestones are included
  - include_completed_milestones (boolean) — whether completed milestones are included
  - include_open_runs_and_plans (boolean) — whether open runs and plans are included
  - include_completed_runs_and_plans (boolean) — whether completed runs and plans are included
  - report_timeframe (date) — timeframe selected for the execution of the report (example shows `"90 days"`)
  - included_statuses (list) — statuses selected for the report (example shows `"Passed, Blocked, Untested"` as a string)
  - notify_user (boolean) — notify author once executed
  - notify_link (boolean) — send emails with links to the report
  - notify_link_recipients (string) — users to whom the report should be sent
  - notify_attachment (boolean) — email the report as an attachment
  - notify_attachment_html_format (boolean) — email in HTML format if notify_attachment is true
  - notify_attachment_pdf_format (boolean) — email in PDF format if notify_attachment is true
  - Example also shows notify_attachment_recipients and content_hide_links (not in the "always included" table).
- **Quirks**: **License gate: available for Enterprise license plans only.** Returns "all API available cross-project reports the user has access to" — the same On-demand-via-the-API creation requirement and API Templates visibility described at the top of the Reports doc applies.
- **Errors**: 200 Success (reports returned in response); 403 "TestRail Enterprise only. Access denied. User role does not grant access."; 429 TestRail Cloud only — too many requests (see API rate limit). (No 400 documented for this endpoint.)

## run_cross_project_report
- **Request**: `GET index.php?/api/v2/run_cross_project_report/{report_template_id}`
- **Path params**: report_template_id (type not stated) — ID of the cross-project report template to execute.
- **Query/filter params**: none documented.
- **Body fields**: n/a (GET).
- **Response**: single object with URLs for accessing the generated report:
  - report_url (string) — e.g. `.../index.php?/cross_project_reports/view/383`
  - report_html (string) — e.g. `.../index.php?/cross_project_reports/get_html/383`
  - report_pdf (string) — e.g. `.../index.php?/cross_project_reports/get_pdf/383`
- **Quirks**: **License gate: available for Enterprise license plans only.** Same async caveat as run_report (report may not be available immediately after being run; delay varies, especially for TestRail Server). GET despite being an execute action. URL paths use `cross_project_reports/...` (vs. `reports/...` for run_report).
- **Errors**: 200 Success (the reports are returned in the response); 400 Invalid report template ID; 403 No access to the project; 429 TestRail Cloud only — too many requests (see API rate limit).
