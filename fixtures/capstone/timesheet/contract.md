## Technical notes: the interface the acceptance checks use

Marisol's nephew, who looks after the bakery's computer, wrote these notes with the payroll company so that the app can be checked the same way whoever builds it. Where the notes and the answers above both speak, they say the same thing.

### Delivering the work

- Build on the seed repository you are given (Node.js and TypeScript, versions pinned in it). You may add npm packages. The app must not call any service outside this machine (no hosted database, no web API) and must not write anywhere except its data directory.
- `npm install`, then `npm run build`, then `npm start` starts the app. `npm test` runs the project's own tests and exits 0 when they pass. Your own tests are measured too, by mutation testing.
- `npm start` reads two environment variables: `PORT` (default `3000`) and `DATA_DIR` (default `./data`), the only place the app keeps its data. The directory is created if it is missing, and the data survives a restart.
- The `version` in `package.json` follows Semantic Versioning 2.0.0. The HTTP API and the payroll CSV below are its public interface.
- If you work in a repository with tools, commit your work there. If you can only reply in text, give every file in full, each under a line `### path/to/file` followed by one fenced code block with the whole file. A later reply lists only the files it adds or changes, and a file to delete as `### path/to/file` followed by the line `(deleted)`.

### Time

- All days and weeks are in the bakery's time zone, `America/Los_Angeles`, with its daylight-saving changes.
- A week starts on Sunday at 00:00 and ends at the next Sunday's 00:00. A week is named by its Sunday's date, `YYYY-MM-DD`; a week name that is not a Sunday is refused.
- The API accepts timestamps in ISO 8601 with a UTC offset or `Z` (`2026-11-01T01:30:00-07:00`), to the minute: seconds other than `00`, and fractions of a second, are refused. The API returns timestamps as `YYYY-MM-DDTHH:mm:ss±hh:mm` with the Pacific offset in effect at that instant.
- Durations are whole minutes of real elapsed time.

### The HTTP API

JSON in and out, `Content-Type: application/json`, field names in camelCase. Money is in whole cents and hours in whole minutes. "Sorted by name" means by the name's characters in Unicode code point order, then by id.

**Who is acting.** Every request except `GET /api/health` and `POST /api/setup` carries the header `X-User-Id: <person id>`. A missing, unknown or inactive person gets `401`. An action marked (managers), or marked for a manager or that person, returns `403` to anyone else.

**Errors.** Every error response has the body `{"error": "<a message a person can read>"}`, with:
- `400` for invalid input;
- `401` as above;
- `403` when this person may not do this;
- `404` for something that does not exist;
- `409` for a conflict with the current state: a stale `version`, an overlapping shift, a timesheet in the wrong status, or setup already done.

**Health.** `GET /api/health` returns `200` with `{"ok": true, "version": "<package.json version>"}`.

**Setup.** `POST /api/setup` with `{"name": string, "hourlyRateCents": integer}` creates the first manager while there are no people at all, and returns `201` with the person. Once anyone exists it returns `409`.

**People.** A person is `{"id": string, "name": string, "role": "employee" | "manager", "hourlyRateCents": integer, "active": boolean}`. `hourlyRateCents` is the rate set with the latest `fromWeek` below, or the starting rate when there is none.
- `POST /api/people` (managers): `{"name", "role", "hourlyRateCents"}` returns `201` with the person. The name must not be empty and the rate must be a positive integer.
- `GET /api/people`: managers get everyone, sorted by name, then id; an employee gets a list holding only themselves.
- `GET /api/people/:id`: a manager, or that person.
- `PATCH /api/people/:id` (managers): any of `{"name", "role", "active"}`; returns `200` with the person.
- `POST /api/people/:id/rates` (managers; a Could have): `{"hourlyRateCents", "fromWeek": "YYYY-MM-DD"}` returns `201`. That week and every later week use the new rate; earlier weeks keep theirs.

**Shifts.** A shift is `{"id": string, "personId": string, "start": timestamp, "end": timestamp, "minutes": integer, "note": string | null, "version": integer}`. A shift belongs to the timesheet of the week its `start` falls in.
- `POST /api/shifts`: `{"personId", "start", "end", "note"?}` returns `201` with the shift. An employee may add shifts only for themselves (`403` otherwise); a manager for anyone.
- `PUT /api/shifts/:id`: `{"start", "end", "note"?, "version"}` returns `200` with the shift, its `version` one higher.
- `DELETE /api/shifts/:id?version=<n>` returns `204`.
- `GET /api/shifts/:id`: the shift, to a manager or its person.
- Refused with `400`: `end` not after `start`; more than 16 hours (960 minutes); a shift that runs past the end of the week it starts in; a change that moves a shift into a different week. Refused with `409`: overlapping another shift of the same person (touching end to start is not an overlap); a stale `version`; a timesheet that is not `open`; an inactive person.

**Timesheets.** One person's week: `{"personId", "weekStart": "YYYY-MM-DD", "status": "open" | "submitted" | "approved", "version": integer, "shifts": [shift, sorted by start], "totals": {"regularMinutes", "overtimeMinutes", "regularPayCents", "overtimePayCents", "totalPayCents"}}`. A timesheet exists, `open`, with `version` 1 and no shifts, for every person and every week. Its `version` goes up by one on every change to it or to any of its shifts.
- `GET /api/timesheets?week=YYYY-MM-DD`: managers get one for each person who is active or has shifts that week, sorted by name, then id; an employee gets only their own.
- `GET /api/timesheets/:personId/:weekStart`: a manager, or that person.
- `POST /api/timesheets/:personId/:weekStart/submit` with `{"version"}`: that person or a manager; `open` to `submitted`.
- `POST .../approve` with `{"version"}`: a manager other than that person; `submitted` to `approved`.
- `POST .../reject` with `{"version", "reason"}`: a manager other than that person; `submitted` to `open`.
- `POST .../reopen` with `{"version", "reason"}`: a manager other than that person; `approved` to `open`.
- Each returns `200` with the timesheet. `reason` must not be empty (`400`).
- `GET .../history`: a manager, or that person. It returns entries, oldest first: `{"at": timestamp, "byPersonId", "action": "shift_added" | "shift_changed" | "shift_removed" | "submitted" | "approved" | "rejected" | "reopened", "reason": string | null, "shiftId": string | null, "before": {"start", "end"} | null, "after": {"start", "end"} | null}`.

**Pay.** `overtimeMinutes` is the week's minutes over 2,400 (40 hours), and `regularMinutes` the rest. For each kind of pay in a week, pay = minutes × `hourlyRateCents` × multiplier ÷ 60, where the multiplier is 1 for regular time and 1.5 for overtime, rounded to the nearest cent with half a cent rounded up. `totalPayCents` is the sum of the rounded amounts. The rate is the one in effect for that week.

### The payroll CSV

`GET /api/export.csv?week=YYYY-MM-DD` (managers) returns `200`, `Content-Type: text/csv`, following RFC 4180 with CRLF line endings. The first line is exactly:

```
employee_id,employee_name,week_start,regular_hours,overtime_hours,regular_pay,overtime_pay,total_pay
```

Then one line per approved timesheet of that week, sorted by name, then id. Hours are minutes ÷ 60 with two decimals, rounded half up (`7.50`); pay is dollars with two decimals and no symbol or separators (`1234.50`), from the cents above. A field containing a comma, a double quote or a line break is quoted, with double quotes doubled.

### The web pages

Pages take `?as=<person id>` to sign in as that person, the same as picking the name on the sign-in page; a signed-in person stays signed in.
- `/`: the sign-in page (pick your name), or the first-run setup when there are no people.
- `/week/YYYY-MM-DD`: for a manager, the team's week as a table, with people down the side, Sunday to Saturday across the top with each day's hours, then total hours, overtime and status; for an employee, their own week.
- `/timesheet/:personId/:weekStart`: one timesheet, with its shifts, totals, history and the actions this person may take.

The pages meet WCAG 2.2 level AA and work at a width of 390 pixels as well as on a desktop.
