# Studio Scheduler

A booking calendar for a single studio, hosted free on GitHub Pages. Visitors see a read-only month
calendar. The owner adds, edits, and deletes bookings from an admin page, and every change is
committed to `data/bookings.json` in this repository.

No database, no server, no build step. Plain HTML, CSS, and JavaScript.

## Booking hours

| Day type           | Bookable      |
|--------------------|---------------|
| Monday–Friday      | 16:00 – 24:00 |
| Saturday, Sunday   | 00:00 – 24:00 |

Change either window in [`config.json`](config.json). The admin form only offers times inside the
window for the chosen date, and validation rejects anything outside it.

## Setup

1. **Push this repository to GitHub** on the `main` branch.

2. **Turn on Pages.** Settings → Pages → Source: *Deploy from a branch*, branch `main`, folder
   `/ (root)`. The site appears at `https://<owner>.github.io/<repo>/`.

3. **Edit `config.json`.** Set `studioName`, `timezone`, and the `contact` link visitors use to
   request a slot. Leave `repo` empty — the admin page detects it from the Pages URL — or fill it in
   if you use a custom domain.

4. **Create a token.** GitHub → Settings → Developer settings → Personal access tokens →
   *Fine-grained tokens* → Generate new token:
   - Repository access: **Only select repositories** → this repository
   - Permissions → Repository permissions → **Contents: Read and write**
   - Nothing else. Expiration: 90 days.

5. **Connect.** Open `https://<owner>.github.io/<repo>/admin.html`, check the detected owner and
   repository, paste the token, press Connect.

6. **Add a booking** and confirm it shows on the public calendar after the rebuild.

## Daily use

Open `admin.html`, pick a date, choose start and end from the dropdowns, type a name, press
**Add booking**. Each action commits straight away, so the commit log is a full history of schedule
changes.

The public site is served from a CDN and lags a commit by roughly 30–60 seconds. The admin page
reads through the GitHub API instead, so it is always current.

## Security

- Use a **fine-grained** token scoped to this repository with Contents: Read and write. A classic
  token would grant access to every repository on the account.
- The token is stored in `localStorage` in your own browser and sent only to `api.github.com`. It is
  never written into the repository.
- `admin.html` deliberately loads no third-party scripts, no CDN assets, and no analytics, because
  any script running on that page could read the token.
- `admin.html` being publicly reachable is fine — without a valid token it cannot write anything.
- If this repository is public, booking names are public and stay in the commit history after
  deletion. Use initials rather than full names.
- Set an expiry on the token and paste a fresh one when it lapses.

## Local preview

Open `index.html` over HTTP rather than as a `file://` URL, since `fetch` will not read local files:

```bash
python -m http.server 8000
```

Then visit <http://localhost:8000>. The admin page works locally too, as long as the owner and
repository fields are filled in by hand.

## Files

| Path | Purpose |
|------|---------|
| `index.html` | Public calendar |
| `admin.html` | Admin editor |
| `assets/common.js` | Config, time and date helpers, booking hours, validation |
| `assets/app.js` | Public calendar behavior |
| `assets/admin.js` | Token handling, CRUD, GitHub commits |
| `assets/style.css` | Styles, light and dark |
| `config.json` | Studio settings |
| `data/bookings.json` | The schedule |
| `SPEC.md` | Full specification |

## Editing the schedule by hand

`data/bookings.json` can be edited directly in GitHub if the admin page is unavailable. Keep the
shape intact:

```json
{
  "version": 1,
  "updated": "2026-08-30T09:12:00.000Z",
  "bookings": [
    { "id": "b_1a2b3c4d", "date": "2026-09-14", "start": "18:00", "end": "19:30", "name": "Ana K." }
  ]
}
```

`id` must be unique, `date` is `YYYY-MM-DD`, and times are `HH:MM` on the slot grid. `24:00` is a
valid end time meaning midnight at the end of that date.
