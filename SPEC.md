# Studio Scheduler — Specification

Version 1.0 · Status: approved for build

## 1. Overview

Studio Scheduler is a single-studio booking calendar hosted on GitHub Pages. Visitors see a
read-only month calendar of booked slots. The studio owner manages those slots from an admin page
in the same site, authenticating with a personal GitHub token and writing changes straight back to
the repository as commits.

There is no database, no server, and no build step. The schedule lives in one JSON file in the
repo, and the repository's commit history doubles as an audit log of every schedule change.

## 2. Goals and non-goals

### Goals

- Public, mobile-friendly calendar showing which dates and times are taken.
- Owner can add, edit, and delete bookings from a browser with no local tooling.
- Booking hours enforced automatically: weekdays open late, weekends open all day.
- Zero hosting cost and no external services beyond GitHub itself.
- Plain HTML, CSS, and JavaScript — no framework, no bundler, no dependencies.

### Non-goals

- Self-service booking by clients. Visitors cannot write; they contact the owner.
- Multiple rooms or resources. One bookable space.
- Recurring bookings. Each booking is a single dated slot.
- Approval workflow. A booking exists or it does not.
- Real-time sync between simultaneous admins.
- Payments, reminders, or notifications.

## 3. Architecture

```
Visitor  --GET-->  GitHub Pages  -->  index.html + data/bookings.json   (read-only)

Owner    --GET-->  GitHub Pages  -->  admin.html
         --GET/PUT-->  GitHub REST API (contents endpoint, owner's token)
                            |
                            v
                    commit to data/bookings.json
                            |
                            v
                    Pages rebuild (~30-60 s)  -->  visitors see the change
```

The public page reads the deployed JSON file. The admin page never reads the deployed file — it
reads through the GitHub API, which returns current content immediately and supplies the blob SHA
required to write. This avoids editing against a stale CDN copy.

## 4. Data model

### `data/bookings.json`

```json
{
  "version": 1,
  "updated": "2026-08-30T09:12:00.000Z",
  "bookings": [
    {
      "id": "b_1a2b3c4d",
      "date": "2026-09-14",
      "start": "18:00",
      "end": "19:30",
      "name": "Ana K."
    }
  ]
}
```

| Field   | Type   | Rules |
|---------|--------|-------|
| `id`    | string | `b_` followed by 8 lowercase hex characters, generated with `crypto.getRandomValues`. Immutable. |
| `date`  | string | `YYYY-MM-DD`, local studio date. |
| `start` | string | `HH:MM`, 24-hour, on the slot grid. |
| `end`   | string | `HH:MM`, 24-hour, on the slot grid. May be `24:00`, meaning end of that date. |
| `name`  | string | 1–60 characters after trimming. Free text. |

`updated` is an ISO 8601 UTC timestamp set on every write. `version` allows future migrations.

### Time representation

Times are stored as local wall-clock strings, never as UTC instants. All arithmetic happens in
minutes since midnight (0–1440), so `24:00` is simply 1440 and needs no special case. Dates are
parsed field by field into a local `Date`; `new Date("2026-09-14")` is never used, because it
parses as UTC and shifts the day for anyone west of Greenwich.

The studio's timezone is recorded in `config.json` for display only. Because both storage and
display are wall-clock, daylight-saving transitions cannot shift an existing booking.

### File ordering

Bookings are sorted by `date`, then `start`, then `id` before every write. A deterministic file
order keeps commit diffs to the lines that actually changed.

## 5. Booking hours

Bookable windows depend on the day of the week.

| Day type           | Window        |
|--------------------|---------------|
| Weekday (Mon–Fri)  | 16:00 – 24:00 |
| Weekend (Sat, Sun) | 00:00 – 24:00 |

Both windows are defined in `config.json` and can be changed without touching code. Weekend days
are a configurable list of day indices, so a studio that treats Friday evening as weekend can say
so. Bookings never cross midnight: a session running past midnight is entered as two bookings on
two dates.

The window is enforced twice — the admin form only offers times inside the window, and validation
rejects out-of-window values before any commit.

## 6. Public page (`index.html`)

**Language.** The interface is Serbian in Latin script, declared as `lang="sr-Latn-RS"`. Day and
month names live in `assets/common.js`; full dates use the genitive month form ("14. septembra
2026."), while month headings use the nominative ("Septembar 2026"). Timestamps are formatted with
the `sr-RS` locale. Switching to Cyrillic means replacing those two name arrays and the literal
strings in the three script files; nothing else is language-dependent. Git commit messages stay in
English, since they are repository metadata rather than interface text.

**Month grid.** Weeks start Monday. Each cell shows the day number and, if the day has bookings, a
count badge. Days outside the current month are dimmed. Today is outlined.

**Day detail.** Clicking a day opens a list beneath the grid: each booking as `18:00 – 19:30 · Ana
K.`, in time order, plus the day's bookable window and the free ranges remaining inside it.

**Navigation.** Previous and next month buttons and a "Today" button. The visible month is
reflected in the URL hash (`#2026-09`) so a specific month can be linked.

**Data loading.** `fetch("data/bookings.json?v=" + Date.now())` — the cache-busting parameter is
required because the Pages CDN otherwise serves stale copies for several minutes. A load failure
shows an inline error, not a blank page.

**Contact.** A link from `config.json` (mail or form URL) for visitors wanting to request a slot.

**Escaping.** Every value from the JSON file is inserted with `textContent`, never `innerHTML`.

**Export.** A per-month "Download .ics" button generates an iCalendar file in the browser. No
service involved.

**Responsive.** Single-column layout below 600 px, with the month grid remaining a 7-column grid at
reduced cell size.

## 7. Admin page (`admin.html`)

Publicly reachable, like every file on a Pages site. Reachability is harmless: without a valid
token the page can display the schedule but cannot change it. The token is the entire
authorization boundary.

**Connection panel.** Repository owner, name, and branch, auto-detected from the Pages URL
(`{owner}.github.io/{repo}/`) and overridable. A password-type field for the token, with Save and
Disconnect. Saved values live in `localStorage`. A status line shows the connected identity.

**Booking form.** Date picker, start `<select>`, end `<select>`, name field, Add button. The two
selects are populated from the chosen date's window and the configured slot length, so an invalid
time cannot be picked in the first place. The end list starts one slot after the selected start.
Choosing a date repopulates both.

**Booking list.** Bookings for the visible month, grouped by date, each with Edit and Delete. Edit
loads the row into the form in edit mode with Save changes and Cancel. Delete asks for confirmation
naming the booking.

**Commit granularity.** Each action commits immediately, one commit per change:

- `Add booking: 2026-09-14 18:00-19:30 (Ana K.)`
- `Edit booking: 2026-09-14 18:00-19:30 (Ana K.)`
- `Delete booking: 2026-09-14 18:00-19:30 (Ana K.)`

**Feedback.** After a successful commit the page reports that the change is saved and that the
public site updates in about a minute — it does not claim the visitor-facing site is already
current, because it is not.

## 8. GitHub write protocol

1. **Read.** `GET /repos/{owner}/{repo}/contents/data/bookings.json?ref={branch}` with headers
   `Authorization: Bearer <token>` and `Accept: application/vnd.github+json`. The response carries
   base64 `content` and a blob `sha`.
2. **Decode.** Base64 to bytes to text via `TextDecoder`, so non-ASCII names survive intact.
3. **Mutate.** Apply the change in memory, re-sort, set `updated`.
4. **Encode.** Text to bytes via `TextEncoder`, bytes to base64. Serialize with two-space indent and
   a trailing newline.
5. **Write.** `PUT` the same path with `{ message, content, sha, branch }`.
6. **Conflict.** A `409` or `422` means the SHA moved — someone else committed. The client refetches,
   replays the same logical change against the fresh data, and retries once. A second failure
   surfaces as "the file changed elsewhere, reload and try again" rather than silently overwriting.

Failure responses are reported by meaning, not by raw status code: `401` as an invalid or expired
token, `403` as insufficient permission or rate limiting, `404` as a wrong repository or a token
lacking access to it.

## 9. Validation rules

Applied on every add and edit, before any network write:

1. `date` matches `YYYY-MM-DD` and is a real calendar date.
2. `start` and `end` match `HH:MM` and land on the slot grid.
3. `start` is strictly before `end`.
4. Both fall inside that date's bookable window.
5. No overlap with another booking on the same date. Intervals are half-open, so a slot ending at
   19:30 and one starting at 19:30 do not conflict. When editing, the booking's own row is excluded
   from the comparison.
6. `name` is 1–60 characters after trimming.

A past date produces a warning, not a rejection — the owner may be recording history.

## 10. Security

- The admin token is a **fine-grained** personal access token limited to this one repository with
  **Contents: Read and write** and nothing else. A classic token is not acceptable: it would grant
  access to every repository the account owns.
- The token is held in `localStorage` on the owner's own browser. Any script executing on
  `admin.html` can read it, so that page loads no third-party scripts, no CDN assets, and no
  analytics. Every asset is same-origin.
- The token is never written to the repository, never placed in a URL or query string, and never
  sent anywhere except `api.github.com`.
- Token expiry should be set to 90 days and the token re-pasted when it lapses.
- If the repository is public, every booking name in the file is public and remains readable in the
  commit history after deletion. Initials are recommended over full names.
- Deleting a booking removes it from the current file but not from history. This is a property of
  git, not a defect, but it means the file must never carry data that would be harmful to retain.

## 11. Configuration (`config.json`)

```json
{
  "studioName": "Studio",
  "timezone": "Europe/Belgrade",
  "slotMinutes": 30,
  "weekStart": 1,
  "hours": {
    "weekendDays": [0, 6],
    "weekday": { "open": "16:00", "close": "24:00" },
    "weekend": { "open": "00:00", "close": "24:00" }
  },
  "contact": { "label": "Request a slot", "href": "mailto:you@example.com" },
  "repo": { "owner": "", "name": "", "branch": "main" }
}
```

`weekendDays` uses JavaScript day indices, 0 for Sunday through 6 for Saturday. `weekStart` sets the
first column of the month grid. Empty `repo` fields fall back to auto-detection from the Pages URL.

## 12. File layout

```
index.html            public calendar
admin.html            admin editor
assets/style.css      shared styles, light and dark
assets/common.js      config load, time and date helpers, hours, validation
assets/app.js         public calendar behavior
assets/admin.js       token handling, CRUD, GitHub commits
config.json           studio settings
data/bookings.json    the schedule
.nojekyll             disables Jekyll processing on Pages
README.md             setup and operation
SPEC.md               this document
```

## 13. Deployment

1. Create the repository and push these files to `main`.
2. Settings → Pages → Source: "Deploy from a branch", branch `main`, folder `/ (root)`.
3. Wait for the first deploy, then open `https://{owner}.github.io/{repo}/`.
4. Create a fine-grained PAT scoped to this repository with Contents: Read and write.
5. Open `/admin.html`, confirm the detected repository, paste the token, save.
6. Add a booking and confirm it appears on the public page after the rebuild.

## 13a. Asset versioning

GitHub Pages serves every file with `cache-control: max-age=600`, so a returning visitor keeps the
previous CSS and JavaScript for up to ten minutes after a deploy — long enough to render new HTML
against old scripts. The HTML therefore references assets with a version query,
`assets/app.js?v=2`, which changes the cache key and forces a fresh copy.

**Bump the number in both `index.html` and `admin.html` whenever a file under `assets/` changes.**
`data/bookings.json` and `config.json` need no version, since the scripts already fetch them with a
timestamp parameter and `cache: 'no-store'`.

## 14. Known limits

- Public updates lag commits by roughly 30–60 seconds while Pages rebuilds. Changed assets reach
  returning visitors immediately only if the version query was bumped; otherwise up to ten minutes
  later, when the browser cache expires.
- The whole schedule loads at once. Performance is unaffected well past a thousand bookings; the
  file would only need yearly archiving far beyond realistic single-studio volume.
- Concurrent admin edits are resolved by SHA conflict and retry, not prevented.
- GitHub's API allows 5,000 authenticated requests per hour, orders of magnitude above use here.

## 15. Possible later work

Client self-service booking, which requires a token-holding proxy such as a Cloudflare Worker;
multiple rooms; recurring slots; a pending/approved status. Each was considered and deliberately
excluded from version 1.
