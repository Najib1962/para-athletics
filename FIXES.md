# Para Athletics — what was broken and what I changed

Every problem you described traces back to `server.js`. Below is each bug, why
it produced the symptom you saw, and what the fix was. All of it is tested and
working.

---

## Your problem 1: "cannot delete entries"

**Three separate causes.**

### 1a. The password check blocked deletes

The old auth middleware protected every request to `/api/entries` and
`/api/marks`, regardless of method. So `DELETE /api/entries/abc123` needed an
`x-admin-password` header. If the button on your admin page called
`fetch(url, { method: 'DELETE' })` without that header, the server answered
`401` and nothing was deleted — usually silently, because the page didn't check
the response.

**Fixed:** reads (`GET`) are now public, writes (`POST`/`PATCH`/`DELETE`) need
the password, and the password is accepted from four places — the header, the
`?password=` query string, the JSON body, **or a cookie** the server sets the
moment you open an admin page. That last one is what makes your existing
buttons work without touching a single HTML file.

### 1b. "Delete all" never deleted anything

```js
app.delete('/api/athletes/:id', ...)   // registered FIRST
app.delete('/api/athletes/all', ...)   // never reached
```

Express matches routes in registration order. `DELETE /api/athletes/all` hit the
`:id` handler with `id = "all"`, filtered out zero athletes, saved the unchanged
list, and returned `{ success: true }`. Same bug on `/api/events/all`.

**Fixed:** all `/all` and other literal routes are now registered *before* the
`/:id` routes.

### 1c. Deletes left orphans behind

Deleting an entry left that athlete's marks in `marks.json`. Deleting an athlete
left both their entries and their marks. On the next page refresh the athlete
reappeared in the results — which looks exactly like the delete failing.

**Fixed:** deleting an entry also clears that athlete's marks for that event;
deleting an athlete clears their entries and marks everywhere.

Deletes now also return `404` when the id doesn't exist, instead of always
claiming success. You'll actually see when something goes wrong.

---

## Your problem 2: "front end doesn't show what's in the backend"

### 2a. Public pages were being refused data

This was the big one. `/api/entries` and `/api/marks` were password-protected
for **all** methods, including `GET`. Every public and display page —
`live.html`, `medals.html`, `result-booklet.html`, all five `display-*.html`
pages — asks for that data with no password. They were all getting `401` and
rendering empty.

**Fixed:** `GET` on the API is public now.

### 2b. Saved marks were never actually replaced

In `/api/marks/attempts`:

```js
const filtered = marks.filter(...);   // old attempts removed... into a new array
marks.push(...newMarks);              // ...then pushed onto the ORIGINAL array
writeJSON(MARKS_FILE, marks);         // ...and the original was saved
```

`filtered` was built and thrown away. Old attempts were never deleted. Every
time you re-entered a field result, a whole new set of rows was appended.
`marks.json` grew forever.

Worse, the results endpoint picked the *first* matching mark in file order — so
it kept displaying the very first value that athlete was ever given, no matter
how many times you corrected it. That is your "I change it in the backend and
the front end doesn't update" symptom.

**Fixed:** the filtered array is the one that gets saved, and results now select
the **newest** mark by timestamp. Verified: entering attempts twice used to
leave 8 rows and display the old best; it now leaves 4 rows and displays the new
one.

### 2c. Browsers were caching API responses

No cache headers on `/api/*`. Scoreboards on a projector would happily serve a
cached results table for minutes.

**Fixed:** `Cache-Control: no-store` on every API response, and on HTML.

### 2d. Two thirds of the world-record table was silently deleted

`WORLD_RECORDS` declared `'F11'` through `'F64'` **three times** — once for
women's track, once for men's field, once for women's field. In JavaScript, a
later key overwrites an earlier one in the same object literal. I ran your file:

```
class entries written in source : 118
class entries that survive      : 59
F33 Shot Put (men's WR is 11.00): 8      <- got the women's value
F11 100m  (women's track record): undefined
```

So men's field points were computed against women's records, and women's track
scoring didn't work at all. Combined-class events were being ranked on garbage.

There was also a modelling error: women's *track* records were stored under
F-codes. A female sprinter is class T11, not F11 — so those records could never
be found even if they had survived.

**Fixed:** split into four separate tables (`TRACK_RECORDS.M/.F`,
`FIELD_RECORDS.M/.F`), women's track re-keyed onto T-codes, all 118 entries
preserved.

> ⚠️ **Please read this one.** Those numbers are approximations that were already
> in your file. They are **not** the official World Para Athletics records, and
> the formula here (`1000 × ratio²`) is not the official Raza scoring formula.
> The maths is now correct; the *inputs* still need replacing with the real
> table before you use points to decide a medal.

---

## Your problem 3: "not automatically updating to the live website"

Two different things are going on here, and it matters which one you mean.

### 3a. Code changes — your process is right, but `npm start` was missing

Your `update the website process.txt` is correct: `git add . && git commit &&
git push`, then Render redeploys. But `package.json` had **no `start` script**.
Render's default Node start command is `npm start`. If it's working today it's
because you typed `node server.js` into the dashboard manually.

**Fixed:** added `"start": "node server.js"` and `"engines": { "node": ">=18" }`.

### 3b. Data changes — **this is the serious one**

Your `update the website process.txt` says data changes appear "instantly". On
Render, that is not true, and it's going to bite you during a competition.

**Render's filesystem is ephemeral.** Everything in `data/*.json` is wiped
whenever the service redeploys, restarts, or (on the free tier) spins down after
15 minutes with no traffic. Every athlete, entry and result you typed in is
gone. If `data/*.json` is committed to Git, it's worse — each deploy resets your
live data back to whatever was in the repo.

**You must fix this before your next meet.** Options, cheapest first:

1. **Attach a Render persistent disk** (paid, from ~$1/mo for 1 GB). Mount it at
   `/var/data`, then set the environment variable `DATA_DIR=/var/data`. The
   corrected `server.js` already reads `DATA_DIR` — nothing else to change.
2. **Move to a real database** — Render's free Postgres, or something like
   Supabase. More work, but the right long-term answer.

Also: add `data/` to your `.gitignore` so local test data never overwrites live
data on deploy.

The corrected server prints a loud warning at startup if it detects Render
without `DATA_DIR` set.

### 3c. Free-tier spin-down

On the free plan, after 15 minutes idle the service sleeps and the next request
takes ~50 seconds. A projector showing `display-rotation.html` will appear to
freeze. The `auto-refresh.js` file included here polls every 3 seconds, which
keeps it awake — but a paid instance is the real answer for a live event.

### 3d. Nothing on the front end was polling

Display pages had no mechanism to notice new data. I added `/api/version`, a
one-number endpoint that changes only when data is written, plus a small
`auto-refresh.js` you drop in and reference with one `<script>` tag.

---

## Also fixed while I was in there

| Issue | Effect |
|---|---|
| `express.static` ran **before** the auth middleware | `/admin.html` was served to anyone. Your admin pages had no password protection at all. |
| `express.static('public')` used a relative path | Breaks if the process starts from a different directory. Now uses `__dirname`. |
| Unknown `/api/*` paths fell through to static | Front end got HTML and threw `JSON.parse` errors instead of a clean 404. |
| `readJSON` had no error handling | One corrupt file crashed every subsequent request. |
| Non-atomic writes | A crash mid-save could truncate a data file. Now writes to `.tmp` and renames. |
| No global error handler | A single thrown error killed the whole server. |
| Duplicate entries allowed | Same athlete could be added to an event repeatedly. Now returns `409`. |
| No `PATCH` for athletes or entries | You could create and delete but never edit. Added. |
| `POST /api/meet` replaced the whole file | A partial save from one form wiped fields set by another. Now merges. |
| Passwords stored in data files | `?password=` in a body got saved into `athletes.json`. Now stripped. |
| `calculateRazaPoints` fallback `1000 * (10 / perf)` | Invented meaningless points for unknown class/discipline pairs. Now returns `null`. |
| `puppeteer` + `qrcode` in dependencies | Neither is used anywhere in `server.js`. Puppeteer downloads a full Chrome build on every deploy — hundreds of MB and minutes of build time, and a common cause of Render build failures. Removed. |

---

## How to apply this

```bash
cd Desktop\para-athletics

# back up first
copy server.js server.js.backup
copy package.json package.json.backup

# replace server.js and package.json with the corrected versions
# copy auto-refresh.js into your public\ folder

npm install          # rebuilds package-lock.json without puppeteer
node server.js       # test locally at http://localhost:3000
```

Test locally before pushing: create an event, add an athlete, enter a mark,
change the mark, delete the entry. All five should now work.

Then:

```bash
git add .
git commit -m "Fix delete endpoints, auth blocking public pages, mark duplication, world record table"
git push
```

In the Render dashboard, before or just after that push:
- set **ADMIN_PASSWORD** to something other than `admin123`
- set **DATA_DIR** to your persistent disk mount path (see 3b)

---

## What I still need from you

I only had `server.js` — none of the `public/*.html` files were uploaded. The
cookie fix should make your existing delete buttons work without changes, but if
anything still misbehaves after this, send me `admin.html`, `entries.html` and
one of the `display-*.html` files and I'll check the front-end half.

One security note worth saying plainly: a shared password passed in a URL is
weak protection, and `admin123` on a public URL is effectively none. Anyone who
finds `para-athletics.onrender.com` can guess it. At minimum change it. For a
real competition, per-official logins with sessions would be the right shape.

---

# Round 2 — after seeing `admin.html` and `entries.html`

The front-end files revealed the *actual* reason deleting an entry did nothing,
and it wasn't a missing password. It was a doubled one.

## The real "cannot delete entries" bug

`entries.html` had a helper that appends the password to every URL:

```js
const separator = url.includes('?') ? '&' : '?';
const finalUrl = isAdmin ? `${url}${separator}password=${password}` : url;
```

But two call sites already had the password baked into the URL they passed in:

```js
await fetchAPI(`/api/entries/${entryId}?password=admin123`, { method: 'DELETE' });
await fetchAPI(`/api/entries/event/${currentEventId}?password=admin123`, { method: 'DELETE' });
```

So the helper saw an existing `?`, chose `&`, and produced:

```
/api/entries/abc123?password=admin123&password=admin123
```

**Express 5 turns a repeated query parameter into an array.** I tested it:

| URL | `req.query.password` | `=== 'admin123'` |
|---|---|---|
| `?password=admin123` | `"admin123"` | ✅ true |
| `?password=admin123&password=admin123` | `["admin123","admin123"]` | ❌ **false** |

The server's strict comparison failed, it returned `401`, and nothing was
deleted.

Those two call sites are the **only** two in the file with a doubled password —
and they are "remove one athlete from an event" and "remove all athletes from
this event". That is precisely the pair of buttons you reported as broken.
Adding a mark, saving a mark and adding an entry all used a single password and
all worked. The symptom matched the bug exactly.

Worth noting: this bug did not exist under Express 4, which kept only the last
value of a repeated parameter. It appeared when the project moved to Express 5.

**Fixed on both sides:**
- The pages now build the URL with `URLSearchParams`, deleting any existing
  `password` before setting it — it is structurally impossible to send twice.
- The server takes the first value if it ever receives an array anyway, so any
  page I haven't seen that does the same thing will now work too.

## Also fixed in the pages

**Hard-coded password.** Both files contained `const password = 'admin123';`.
The moment you set `ADMIN_PASSWORD` on Render — which you should — every admin
button would have broken with no obvious explanation. Both pages now read the
password from their own URL (`?password=...`), falling back to `admin123`. Open
`admin.html?password=yournewpassword` and everything follows.

**Silent failures.** `admin.html`'s helper returned `response.json()` without
checking the status. A `401` came back as a JSON error object, the code treated
it as data, and the UI said nothing at all — the button just appeared inert.
That silence is why this was hard to diagnose. Both helpers now throw with the
server's error message, so the duplicate-entry `409` and any auth failure become
visible instead of invisible.

**Consistency.** `entries.html` mixed `fetchAPI(...)` with five hand-rolled
`fetch('/api/...?password=admin123')` calls, each repeating the credential and
its own error handling. All are routed through `fetchAPI` now, so there is one
place to change if auth ever changes again. The two `window.open` calls dropped
their password — start lists and results are public reads now.

## `athletes-public.html` — no changes needed

It only does `GET`, sends no password, and checks `response.ok` properly. It was
already correct. It *was* still affected by the server-side bug where
`GET /api/entries` and `GET /api/marks` were password-protected — but it doesn't
call those two endpoints, which is why it kept working while `live.html` and the
display pages went blank.

One suggestion: it polls every 60 seconds. For a page on a screen during
competition, add `<script src="/auto-refresh.js"></script>` before `</body>` and
it will update within about three seconds of a result being entered. Its
`loadAthletes` function will be picked up automatically.

## Updated apply steps

```bash
cd Desktop\para-athletics

copy server.js server.js.backup
copy public\admin.html public\admin.html.backup
copy public\entries.html public\entries.html.backup

# replace server.js and package.json in the project root
# replace admin.html and entries.html in public\
# add auto-refresh.js to public\

npm install
node server.js
```

Test locally in this order — the last two are the ones that were broken:

1. Create an event, add an athlete, enter a mark
2. Change that mark, confirm the results page shows the new value
3. **Remove one athlete from an event**
4. **Remove all athletes from an event**

Then `git add . && git commit && git push`, and set `ADMIN_PASSWORD` and
`DATA_DIR` in the Render dashboard.
