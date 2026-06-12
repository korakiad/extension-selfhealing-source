# Projects / Users / Roles / Groups / Priorities — distilled from official TestRail docs (updated 2026-05)

Endpoint index (18 total):

- Projects: `get_project`, `get_projects`, `add_project`, `update_project`, `delete_project`
- Users: `get_user`, `get_current_user`, `get_user_by_email`, `get_users`, `add_user`, `update_user`
- Roles: `get_roles`
- Groups: `get_group`, `get_groups`, `add_group`, `update_group`, `delete_group`
- Priorities: `get_priorities`

---

## get_project
- **Request**: `GET index.php?/api/v2/get_project/{project_id}`
- **Path params**: project_id (integer, required) — The ID of the project
- **Query/filter params**: none documented.
- **Body fields**: n/a (GET)
- **Response**: single project object. Fields:
  - `id` (integer) — unique ID of the project
  - `announcement` (string) — description/announcement of the project
  - `completed_on` (integer) — date/time when the project was marked completed (UNIX timestamp)
  - `default_role` (string) — name of the default role configured for project access — requires TestRail 7.3+
  - `default_role_id` (integer) — ID of the default role configured for project access — requires TestRail 7.3+
  - `is_completed` (boolean) — true if the project is marked as completed
  - `name` (string) — name of the project
  - `show_announcement` (boolean) — true to show the announcement/description
  - `suite_mode` (integer) — suite mode of the project (1 = single suite mode, 2 = single suite + baselines, 3 = multiple suites)
  - `url` (string) — address/URL of the project in the user interface
  - `groups` (array) — array of group objects — requires TestRail 7.3+. Group object: `id` (integer, ID of the user group), `role` (string, name of the role assigned to the group within the project), `role_id` (integer, ID of the role assigned to the group within the project)
  - `users` (array) — array of user objects — requires TestRail **Enterprise** 7.3+. User object: `id` (integer, ID of the user), `global_role_id` (integer, ID of the role assigned to the user's global profile), `global_role` (string, its name), `project_role_id` (integer, ID of the role assigned to the user within the project, if any), `project_role` (string, its name)
- **Quirks**: suite_mode semantics as above (1/2/3). `default_role`/`default_role_id`/`groups` are TestRail 7.3+ only; `users` array is Enterprise 7.3+ only.
- **Errors**:
  - 200 — Success (project returned)
  - 400 — Invalid or unknown project
  - 403 — No access to the project
  - 429 — TestRail Cloud only — too many requests (API rate limit)

## get_projects
- **Request**: `GET index.php?/api/v2/get_projects`
- **Path params**: none.
- **Query/filter params** (applied as query parameters on the request URL):
  - is_completed (boolean) — 1 to return completed projects only; 0 to return active projects only (doc example: `GET index.php?/api/v2/get_projects&is_completed=0`)
  - limit (integer) — the number of projects the response should return (response size is 250 by default) — requires TestRail 6.7+
  - offset (integer) — where to start counting the projects from (the offset) — requires TestRail 6.7+
- **Body fields**: n/a (GET)
- **Response**: paginated wrapper `{offset, limit, size, _links: {next, prev}, projects: [...]}` — array key is **`projects`**. Each project follows the same format as get_project.
- **Quirks**: only returns projects to which the requester has at least read-access. Default page size 250.
- **Errors**:
  - 200 — Success (projects returned; only those with at least read-access)
  - 429 — TestRail Cloud only — too many requests (API rate limit)

## add_project
- **Request**: `POST index.php?/api/v2/add_project`
- **Path params**: none.
- **Query/filter params**: none documented.
- **Body fields**:
  - name (string, required) — the name of the project
  - announcement (string, optional) — the description/announcement of the project
  - show_announcement (boolean, optional) — true if the announcement should be displayed on the project's overview page
  - suite_mode (integer, optional) — the suite mode of the project (1 = single suite mode, 2 = single suite + baselines, 3 = multiple suites)
- **Response**: single object — the new project, same response format as get_project.
- **Quirks**: admin status required ("Creates a new project (admin status required)").
- **Errors**:
  - 200 — Success (project created and returned)
  - 403 — No permissions to add projects (requires admin rights)
  - 429 — TestRail Cloud only — too many requests (API rate limit)

## update_project
- **Request**: `POST index.php?/api/v2/update_project/{project_id}`
- **Path params**: project_id (integer, required) — The ID of the project
- **Query/filter params**: none documented.
- **Body fields**:
  - name (string, doc table marks it required: true) — the name of the project. UNCLEAR: the doc says "partial updates are supported, i.e. you can submit and update specific fields only" yet still flags `name` as required — and the doc's own request example (`{"announcement": "Happy Holidays Everyone!"}`) omits `name`.
  - announcement (string, optional) — the description/announcement of the project
  - show_announcement (boolean, optional) — true if the announcement should be displayed on the project's overview page
  - suite_mode (integer, optional) — the suite mode of the project (1/2/3 as above)
- **Response**: single object — the updated project. Documented response fields beyond add_project's:
  - `default_role_id` (integer) — ID of the default role configured for project access — requires TestRail 7.3+
  - `groups` (array) — group objects — requires TestRail 7.3+. Group object: `id` (integer, ID of the user group), `role_id` (integer) — ID of the role assigned to the group within the project; submit 0 to change the assignment to 'Global Role'; submit null to clear the project-specific role.
  - `users` (array) — user objects — requires TestRail 7.3+. User object: `id` (integer, ID of the user), `role_id` (integer) — ID of the role assigned to the user within the project; submit 0 to change the assignment to 'Global Role'; submit null to clear the project-specific role assignment.
  - UNCLEAR: the doc's response example shows users keyed as `{"user_id": 4, "role_id": null}` but the USERS field table documents the key as `id`.
- **Quirks**: admin status required. The 0 / null semantics for `role_id` ("0 = Global Role, null = clear project-specific role") are described in the response tables, suggesting these arrays are also submittable for assignment changes — UNCLEAR: doc presents them only under "Response content".
- **Errors**:
  - 200 — Success (project updated and returned)
  - 400 — Invalid or unknown project
  - 403 — No permissions to modify projects (requires admin rights)
  - 429 — TestRail Cloud only — too many requests (API rate limit)

## delete_project
- **Request**: `POST index.php?/api/v2/delete_project/{project_id}`
- **Path params**: project_id (integer, required) — The ID of the project
- **Query/filter params**: none documented.
- **Body fields**: none documented.
- **Response**: empty (no response body documented).
- **Quirks**: admin status required. **Warning from doc**: deleting a project cannot be undone and permanently deletes all test suites & cases, test runs & results, and everything else that is part of the project.
- **Errors**:
  - 200 — Success (project deleted)
  - 400 — Invalid or unknown project
  - 403 — No permissions to delete projects (requires admin rights)
  - 429 — TestRail Cloud only — too many requests (API rate limit)

---

## get_user
- **Request**: `GET index.php?/api/v2/get_user/{user_id}`
- **Path params**: user_id (integer, required) — The ID of the user
- **Query/filter params**: none documented.
- **Body fields**: n/a (GET)
- **Response**: single user object. Fields:
  - `id` (integer) — unique ID of the user
  - `email` (string) — email address of the user as configured in TestRail
  - `email_notifications` (boolean) — true if email notifications are enabled for the user — requires TestRail 7.3+
  - `is_active` (boolean) — true if the user is active
  - `is_admin` (boolean) — true if the user is a TestRail administrator — requires TestRail 7.3+
  - `name` (string) — full name of the user
  - `role_id` (integer) — unique ID of the user's globally assigned role — requires TestRail 6.4+
  - `role` (string) — name of the user's globally assigned role — requires TestRail 6.4+
  - `group_ids` (array) — group IDs the user is assigned to — requires TestRail 7.3+
  - `mfa_required` (boolean) — true if the user profile is configured to require MFA at each login — requires TestRail 7.3+
  - `sso_enabled` (boolean) — true if the user's profile has Single-Sign-On enabled — requires TestRail **Enterprise** 7.3+
  - `assigned_projects` (array) — project IDs to which the user is assigned (see Project Level Administration) — requires TestRail **Enterprise** 7.3+
- **Quirks**: any user can retrieve their own account information; retrieving information for any other user requires administrator access. Response shape differs between TestRail Professional (no `sso_enabled`/`assigned_projects`) and Enterprise (includes them).
- **Errors**:
  - 200 — Success (user returned)
  - 400 — Invalid or unknown user
  - 429 — TestRail Cloud only — too many requests (API rate limit)

## get_current_user
- **Request**: `GET index.php?/api/v2/get_current_user/{user_id}`
- **Path params**: user_id (integer, required) — The ID of the user. UNCLEAR: the doc both describes the endpoint as "Returns user details for the TestRail user making the API request" and lists a required `user_id` path parameter — the doc does not reconcile why an ID is required for the current user.
- **Query/filter params**: none documented.
- **Body fields**: n/a (GET)
- **Response**: single user object. Fields:
  - `id` (integer) — unique ID of the user
  - `email` (string) — email address of the user as configured in TestRail
  - `is_active` (boolean) — true if the user is active
  - `name` (string) — full name of the user
  - `role_id` (integer) — unique ID of the user's globally assigned role — requires TestRail 6.4+
  - `role` (string) — name of the user's globally assigned role — requires TestRail 6.4+
- **Quirks**: **requires TestRail 6.6 or later.** Any user can retrieve their own account information; retrieving information for any other user requires administrator access.
- **Errors**:
  - 200 — Success (user returned)
  - 400 — Invalid or unknown user
  - 429 — TestRail Cloud only — too many requests (API rate limit)

## get_user_by_email
- **Request**: `GET index.php?/api/v2/get_user_by_email&email={email}`
- **Path params**: none (email is passed as `&email=` on the URL).
- **Query/filter params**: email (string, required) — the email address to get the user for
- **Body fields**: n/a (GET)
- **Response**: single user object — same response format as get_user.
- **Quirks**: any user can retrieve their own account information; retrieving information for any other user requires administrator access.
- **Errors**:
  - 200 — Success (user returned)
  - 400/404 — Invalid or unknown email address
  - 429 — TestRail Cloud only — too many requests (API rate limit)

## get_users
- **Request**: `GET index.php?/api/v2/get_users` and `GET index.php?/api/v2/get_users/{project_id}`
- **Path params**: project_id (integer) — the ID of the project for which to retrieve user information; **required for non-administrators** (the doc table marks it required: true, but the prose says it is required only for non-administrators) — requires TestRail 6.6+
- **Query/filter params**: none documented (no limit/offset documented for this endpoint).
- **Body fields**: n/a (GET)
- **Response**: plain array of users (`[{...}, {...}]`, no paginated wrapper shown). Each user follows the same format as get_user. The doc's example shows only `id` and `name` per entry.
- **Quirks**:
  - As of TestRail 6.6, only administrators can use get_users without a project_id; non-administrators must include it.
  - When project_id is omitted, all user information is returned.
  - `get_users/{project_id}` only retrieves users with explicit project access and does **not** list users with global access.
  - When project_id is used: `role`/`role_id` values correspond to the user's project-level access; inactive users are not included; users without access to the project are not included.
- **Errors**:
  - 200 — Success (users returned)
  - 400 — Invalid project_id
  - 403 — Insufficient permissions
  - 429 — TestRail Cloud only — too many requests (API rate limit)

## add_user
- **Request**: `POST index.php?/api/v2/add_user`
- **Path params**: none.
- **Query/filter params**: none documented.
- **Body fields** (note: the doc mislabels this table "The following fields are included in the response", but it is clearly the request-field table — required markers are embedded in the descriptions):
  - name (string, required) — the name of the user
  - email (string, required) — the email address of the user
  - email_notifications (boolean, optional) — false to disable email notifications for the user. Default: true
  - is_active (boolean, optional) — true if the user is active or not. Default: false
  - is_admin (boolean, optional) — true to make the user a TestRail Administrator. Default: false
  - group_ids (array, optional) — array of group IDs to assign the user to
  - mfa_required (boolean, optional) — true to require Multi-Factor Authentication for the user. Default value matches the MFA setting of the instance
  - role_id (integer, optional) — the ID of the global role to assign to the user
  - sso_enabled (boolean, optional) — true to enable SSO for the user. Default value matches the SSO setting of the instance
  - assigned_projects (array, optional) — array of project IDs to assign to a Project Level Administrator (see Project Level Administration)
- **Response**: single object — the new user, same response format as get_user.
- **Quirks**: **requires TestRail 7.3 or later.** New users default to inactive (`is_active` default false).
- **Errors**:
  - 200 — Success (user created)
  - 400 — Invalid field value, such as an email address
  - 403 — No permission to create users

## update_user
- **Request**: `POST index.php?/api/v2/update_user/:user_id` (doc uses colon-style placeholder here)
- **Path params**: user_id (integer, required) — The ID of the user
- **Query/filter params**: none documented.
- **Body fields**: same fields as add_user (name, email, email_notifications, is_active, is_admin, group_ids, mfa_required, role_id, sso_enabled, assigned_projects). The doc does not restate which are required for updates.
- **Response**: single object — the updated user, same response format as get_user.
- **Quirks**: none documented beyond field reuse from add_user. (No explicit version gate stated for this endpoint itself; add_user, whose fields it shares, is 7.3+.)
- **Errors**:
  - 200 — Success (user updated)
  - 400 — Invalid field value, such as an email address
  - 403 — No permission to update users

---

## get_roles
- **Request**: `GET index.php?/api/v2/get_roles`
- **Path params**: none.
- **Query/filter params**: none documented (response examples nonetheless show pagination wrapper fields with limit 250).
- **Body fields**: n/a (GET)
- **Response**: paginated wrapper `{offset, limit, size, _links: {next, prev}, roles: [...]}` — array key is **`roles`**. Role object fields:
  - `id` (integer) — the ID of the role
  - `name` (string) — the name of the role
  - `is_default` (boolean) — true if this is the default user role
  - `is_project_admin` (boolean) — true if the role has Project Level Administration permissions (**requires TestRail Enterprise**; present only in the Enterprise response example)
- **Quirks**: **requires TestRail 7.3 or later.** Professional vs Enterprise response shapes differ only by `is_project_admin`.
- **Errors**: no response-code table documented in this file. UNCLEAR: error codes for get_roles are not listed.

---

## get_group
- **Request**: `GET index.php?/api/v2/get_group/{group_id}`
- **Path params**: group_id (integer, required) — The ID of the group
- **Query/filter params**: none documented.
- **Body fields**: n/a (GET)
- **Response**: single group object. Fields:
  - `id` (integer) — unique ID of the group
  - `name` (string) — name of the group
  - `user_ids` (array) — array of user IDs; each ID is a user belonging to this group
- **Quirks**: Groups endpoints are only available in **TestRail 7.5 or later** (applies to all five group endpoints).
- **Errors**:
  - 200 — Success (group retrieved)
  - 400 — Invalid group_id parameter

## get_groups
- **Request**: `GET index.php?/api/v2/get_groups`
- **Path params**: none.
- **Query/filter params**: none documented (response example nonetheless shows the pagination wrapper with limit 250).
- **Body fields**: n/a (GET)
- **Response**: paginated wrapper `{offset, limit, size, _links: {next, prev}, groups: [...]}` — array key is **`groups`**. Each group has `id` (integer), `name` (string), `user_ids` (array of user IDs).
- **Quirks**: TestRail 7.5+ (section-wide gate).
- **Errors**:
  - 200 — Success (groups retrieved)

## add_group
- **Request**: `POST index.php?/api/v2/add_group`
- **Path params**: none.
- **Query/filter params**: none documented.
- **Body fields** (doc shows them in a fields table without a Required column; request example includes both):
  - name (string, UNCLEAR whether required — no Required column in the doc table) — the name of the group
  - user_ids (array, UNCLEAR whether required) — an array of user IDs; each ID is a user belonging to this group
- **Response**: single object — the new group, same response format as get_group.
- **Quirks**: TestRail 7.5+ (section-wide gate).
- **Errors**:
  - 200 — Success (group created)
  - 400 — Invalid field value, such as an invalid ID in the user_ids array
  - 403 — No permission to create user groups

## update_group
- **Request**: `POST index.php?/api/v2/update_group/{group_id}`
- **Path params**: group_id (integer, required) — The ID of the group
- **Query/filter params**: none documented.
- **Body fields**: same fields as add_group (name, user_ids).
- **Response**: single object — same response format as get_group (doc says "returns the new group").
- **Quirks**: TestRail 7.5+ (section-wide gate). **Replacement semantics**: update_group sets the group's members to match the `user_ids` array provided — it is not possible to incrementally add or remove users; the submitted `user_ids` array should always be the full list of users in the group.
- **Errors**:
  - 200 — Success (group updated)
  - 400 — Invalid field value, such as an invalid ID in the user_ids array
  - 403 — No permission to edit user groups

## delete_group
- **Request**: `POST index.php?/api/v2/delete_group/{group_id}`
- **Path params**: group_id (integer, required) — The ID of the group
- **Query/filter params**: none documented.
- **Body fields**: none documented.
- **Response**: empty — "This endpoint does not return any group data."
- **Quirks**: TestRail 7.5+ (section-wide gate).
- **Errors**:
  - 200 — Success (group deleted)
  - 400 — Invalid group_id
  - 403 — No permission to delete user groups

---

## get_priorities
- **Request**: `GET index.php?/api/v2/get_priorities`
- **Path params**: none.
- **Query/filter params**: none documented.
- **Body fields**: n/a (GET)
- **Response**: plain array of priority objects (no paginated wrapper). Fields per priority:
  - `id` (integer) — unique ID
  - `name` (string) — name of the priority
  - `short_name` (string) — short version of the name
  - `priority` (integer) — determines the order of the priorities
  - `is_default` (boolean) — true for the default priority, false otherwise
- **Quirks**: none documented.
- **Errors**:
  - 200 — Success (available priorities returned)
