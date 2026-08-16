/**
 * Para Athletics System - server.js
 * Corrected version.
 *
 * Fixes applied (see FIXES.md for the full explanation):
 *  1. /all routes now registered BEFORE /:id routes (delete-all actually works)
 *  2. Auth rewritten: GET is public, writes require the password, admin HTML
 *     pages are actually protected, and a cookie keeps admin pages working
 *     even if a fetch() forgets the password header
 *  3. /api/marks/attempts no longer duplicates old marks (the `filtered`
 *     array was computed and then thrown away)
 *  4. WORLD_RECORDS duplicate keys removed - two thirds of the table was
 *     being silently overwritten by JavaScript
 *  5. Results now use the NEWEST mark, not the first one found
 *  6. API responses send no-store so scoreboards stop showing stale data
 *  7. Atomic writes + safe reads so a crash can't corrupt a JSON file
 *  8. DATA_DIR is configurable, for Render persistent disks
 *  9. PATCH endpoints added for athletes and entries
 * 10. /api/version lets front-end pages poll cheaply for changes
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// FIX: password should come from the environment in production.
// Set ADMIN_PASSWORD in the Render dashboard. Falls back to the old default.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// ---------- MIDDLEWARE ----------
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// FIX: never let a browser or proxy cache API data. This is the single most
// common reason a scoreboard keeps showing an old result after an admin
// edits it.
app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
});

// ---------- DATA STORAGE ----------
// FIX: allow an external data directory so a Render persistent disk can be
// mounted at e.g. /var/data. Without this, every deploy wipes all data.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

const ATHLETES_FILE = path.join(DATA_DIR, 'athletes.json');
const ENTRIES_FILE = path.join(DATA_DIR, 'entries.json');
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');
const MARKS_FILE = path.join(DATA_DIR, 'marks.json');
const MEET_FILE = path.join(DATA_DIR, 'meet.json');
const REFERENCE_FILE = path.join(DATA_DIR, 'reference.json');

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

function initDataFile(filePath, defaultData) {
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, JSON.stringify(defaultData, null, 2));
    }
}

initDataFile(ATHLETES_FILE, []);
initDataFile(ENTRIES_FILE, []);
initDataFile(EVENTS_FILE, []);
initDataFile(MARKS_FILE, []);
initDataFile(MEET_FILE, {
    name: 'Para Athletics Competition',
    venue: 'Stadium',
    date: new Date().toISOString().split('T')[0],
    timezone: 'UTC',
    days: []
});
initDataFile(REFERENCE_FILE, {
    disciplines: [
        '100m', '200m', '400m', '800m', '1500m', '5000m', '10000m',
        'Marathon',
        '4x100m Relay', '4x400m Relay',
        'Long Jump', 'Triple Jump', 'High Jump', 'Pole Vault',
        'Shot Put', 'Discus', 'Javelin', 'Club Throw', 'Pentathlon'
    ],
    classes: [
        'T11', 'T12', 'T13', 'T20', 'T32', 'T33', 'T34', 'T35', 'T36', 'T37',
        'T38', 'T40', 'T41', 'T42', 'T43', 'T44', 'T45', 'T46', 'T47', 'T51',
        'T52', 'T53', 'T54', 'T61', 'T62', 'T63', 'T64', 'T72',
        'F11', 'F12', 'F13', 'F20', 'F31', 'F32', 'F33', 'F34', 'F35', 'F36',
        'F37', 'F38', 'F40', 'F41', 'F42', 'F43', 'F44', 'F45', 'F46', 'F51',
        'F52', 'F53', 'F54', 'F55', 'F56', 'F57', 'F61', 'F62', 'F63', 'F64'
    ],
    restrictions: {
        'Club Throw': ['F31', 'F32', 'F51']
    },
    guideClasses: ['T11', 'T12', 'F11', 'F12']
});

// FIX: a half-written file used to crash every request afterwards.
// Read defensively, write atomically.
function readJSON(file, fallback) {
    try {
        const raw = fs.readFileSync(file, 'utf8');
        if (!raw.trim()) return fallback;
        return JSON.parse(raw);
    } catch (err) {
        console.error(`[data] Could not read ${path.basename(file)}:`, err.message);
        return fallback;
    }
}

let dataVersion = Date.now();

// Pages that want to know about changes register here. The server then
// pushes to them the moment anything is written, rather than each page
// asking every few seconds.
const liveListeners = new Set();

function writeJSON(file, data) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file); // atomic on the same filesystem
    dataVersion = Date.now();

    for (const send of liveListeners) {
        try { send(dataVersion); } catch (_) { /* a dead page must not break a save */ }
    }
}

function getAthletes() { return readJSON(ATHLETES_FILE, []); }
function getEntries() { return readJSON(ENTRIES_FILE, []); }
function getEvents() { return readJSON(EVENTS_FILE, []); }
function getMarks() { return readJSON(MARKS_FILE, []); }
function getMeet() { return readJSON(MEET_FILE, {}); }
function getReference() { return readJSON(REFERENCE_FILE, {}); }

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ---------- RAZA POINTS SYSTEM ----------
// The hand-made world-record table that used to live here has been replaced
// by raza.js, which holds the official World Para Athletics constants
// extracted straight from WPA's own calculator workbooks.
//
// This is not a cosmetic change. The old maths was 1000*(ratio of world
// records)^2, which is not the Raza formula and produced different rankings.
// In a combined F33/F34 shot put it placed the F34 athlete first where
// official Raza places the F33 athlete first.
const raza = require('./raza');

const RELAY_DISCIPLINES = ['4x100m Relay', '4x400m Relay'];

function isTrackDiscipline(d) {
    return raza.isTrackEvent(d) || RELAY_DISCIPLINES.includes(d);
}
function isFieldDiscipline(d) {
    return raza.isFieldEvent(d);
}

/**
 * Returns { points, reason } - points is null when WPA publishes no
 * constants for that class/discipline/sex combination, with a human-readable
 * reason so the results page can explain itself instead of showing a blank.
 */
function calculateRazaPoints(classCode, discipline, performance, sex, youth) {
    return raza.razaPoints({
        discipline,
        classCode,
        sex,
        mark: performance,
        youth: !!youth
    });
}


// ---------- ADMIN AUTHENTICATION ----------
// FIX: the old middleware ran AFTER express.static, so /admin.html was served
// to anyone, password or not. It also blocked GET /api/entries and
// GET /api/marks for everyone, which is why public and display pages showed
// nothing. New rules:
//   - GET on /api/* is public (scoreboards and public pages need it)
//   - POST/PATCH/PUT/DELETE on /api/* needs the password
//   - admin HTML pages need the password
//   - the password may arrive as ?password=, an x-admin-password header,
//     a JSON body field, or the cookie set when an admin page is opened

const ADMIN_PAGES = [
    '/admin.html', '/athletes.html', '/entries.html',
    // These write marks or wipe the whole competition, so they need the
    // password too. Previously anyone with the address could reach them.
    '/reset-data.html', '/startlist-referee.html', '/startlists-results.html',
    '/cleanup.html'
];
const COOKIE_NAME = 'pa_admin';

function readCookie(req, name) {
    const header = req.headers.cookie;
    if (!header) return null;
    for (const part of header.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        if (part.slice(0, idx).trim() === name) {
            return decodeURIComponent(part.slice(idx + 1).trim());
        }
    }
    return null;
}

// FIX: Express 5 turns a repeated query parameter into an ARRAY. A page that
// sent ?password=admin123&password=admin123 produced ['admin123','admin123'],
// which never equalled the expected string, so the request was rejected with
// 401. The pages are fixed too, but the server should not be brittle about it.
function firstValue(v) {
    return Array.isArray(v) ? v[0] : v;
}

function suppliedPassword(req) {
    return firstValue(req.headers['x-admin-password'])
        || firstValue(req.query.password)
        || (req.body && firstValue(req.body.password))
        || readCookie(req, COOKIE_NAME);
}

// FIX: check every place a password might arrive, and accept if ANY of them
// is right. The old version took the first one it found and stopped there.
// That mattered because several pages still have "admin123" written into
// them: once you change the password, those pages send the old one, the
// check stopped at that wrong value, and the cookie set when you logged in
// was never looked at. Now a valid cookie carries you through regardless.
function isAuthed(req) {
    const candidates = [
        req.headers['x-admin-password'],
        req.query.password,
        req.body && req.body.password,
        readCookie(req, COOKIE_NAME)
    ];
    return candidates.some(value => firstValue(value) === ADMIN_PASSWORD);
}

app.use((req, res, next) => {
    const p = req.path;

    // Admin HTML pages - must run BEFORE express.static
    if (ADMIN_PAGES.includes(p)) {
        if (!isAuthed(req)) {
            return res.redirect('/login.html');
        }
        // Remember the password so fetch() calls from this page work even if
        // they forget to send the header. This is what fixes "cannot delete".
        res.cookie
            ? res.cookie(COOKIE_NAME, ADMIN_PASSWORD, { httpOnly: false, sameSite: 'lax' })
            : res.set('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(ADMIN_PASSWORD)}; Path=/; SameSite=Lax`);
        return next();
    }

    // API: reads are public, writes are protected
    if (p.startsWith('/api/')) {
        if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
            return next();
        }

        // Team entry is the one write a member of the public is meant to make.
        // team-entry.html is how visiting clubs submit their squad, and those
        // managers have no admin password - requiring one would break the form
        // completely. It was open in the original app and stays open here.
        if (p === '/api/team-entry') return next();

        if (isAuthed(req)) return next();
        return res.status(401).json({
            error: 'Admin access required',
            message: 'Send the admin password as ?password=..., an x-admin-password header, or open an admin page first.'
        });
    }

    return next();
});

// ---------- LIVE AUTO-UPDATE ----------
// Every public page should refresh itself when a result changes. Rather than
// asking you to add a <script> tag to a dozen HTML files by hand, the server
// adds it as each page is served. Nothing in public/ needs editing.
//
// Admin pages are deliberately left alone - a page reloading under you while
// you are typing marks would be maddening.

const LIVE_SCRIPT = `(function(){
  var last = null;

  function refresh() {
    // Only functions that READ. Nothing here saves anything.
    var safe = ['refreshAll','refreshBooklet','refreshSchedule','refreshEvents',
                'refreshData','loadResults','loadMedals','loadAthletes','loadEvent',
                'loadStats','loadEvents','loadData','loadEventData'];
    var called = 0;
    for (var i = 0; i < safe.length; i++) {
      if (typeof window[safe[i]] === 'function') {
        try { window[safe[i]](); called++; } catch (e) {}
      }
    }
    if (!called) location.reload();
  }

  function seen(v) {
    if (last === null) { last = v; return; }
    if (v !== last) { last = v; refresh(); }
  }

  // Preferred: the server holds the connection open and tells us the moment
  // something changes. This keeps working in a background tab, which repeated
  // asking does not - browsers slow background timers to about once a minute,
  // so a scoreboard behind another tab used to update late or not at all.
  var stream = null;
  function connect() {
    try { stream = new EventSource('/api/stream'); } catch (e) { return startPolling(); }
    stream.onmessage = function (e) {
      try { seen(JSON.parse(e.data).version); } catch (err) {}
    };
    stream.onerror = function () {
      if (stream) { stream.close(); stream = null; }
      setTimeout(connect, 5000);   // free hosting sleeps; keep trying
      startPolling();              // meanwhile fall back to asking
    };
  }

  // Safety net, in case the open connection is blocked by a network or proxy.
  var polling = null;
  function poll() {
    fetch('/api/version', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) { seen(d.version); })
      .catch(function () {});
  }
  function startPolling() {
    if (polling) return;
    polling = setInterval(poll, 5000);
  }

  // Catch up straight away whenever the tab is brought back to the front.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) poll();
  });

  poll();
  connect();
})();`;

app.get('/auto-refresh.js', (req, res) => {
    res.type('application/javascript').set('Cache-Control', 'no-store').send(LIVE_SCRIPT);
});

const PUBLIC_DIR = path.join(__dirname, 'public');
const NO_LIVE = [
    '/admin.html', '/entries.html', '/athletes.html', '/login.html',
    '/reset-data.html', '/startlist-referee.html', '/startlists-results.html',
    // A visiting manager may spend several minutes typing a whole squad into
    // this form. Refreshing it would throw all of that away.
    '/team-entry.html',
    // Refreshing this mid-clean-up would clear the list you are working from.
    '/cleanup.html'
];

app.use((req, res, next) => {
    // Only intercept page requests; everything else falls through to static.
    let name = req.path === '/' ? '/index.html' : req.path;
    if (!name.endsWith('.html')) return next();
    if (NO_LIVE.includes(name)) return next();

    const file = path.join(PUBLIC_DIR, name);
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file)) return next();

    fs.readFile(file, 'utf8', (err, html) => {
        if (err) return next();
        const tag = '<script src="/auto-refresh.js"></script>';
        const out = html.includes('</body>')
            ? html.replace(/<\/body>/i, tag + '</body>')
            : html + tag;
        res.set('Cache-Control', 'no-store, must-revalidate').type('html').send(out);
    });
});

// FIX: __dirname, not a relative path (a relative path breaks whenever the
// process is started from a different working directory). HTML is served with
// no-store so a redeployed page is picked up immediately.
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            res.set('Cache-Control', 'no-store, must-revalidate');
        }
    }
}));

// ---------- HEALTH / VERSION ----------
app.get('/api/health', (req, res) => {
    res.json({ ok: true, uptime: process.uptime(), dataDir: DATA_DIR });
});

// Front-end pages can poll this every few seconds and only re-fetch when the
// number changes - far cheaper than reloading the whole results table.
// Held open by every public page. Nothing is sent until data changes, so an
// idle connection costs almost nothing.
app.get('/api/stream', (req, res) => {
    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    if (res.flushHeaders) res.flushHeaders();
    res.write(`data: ${JSON.stringify({ version: dataVersion })}\n\n`);

    const send = version => res.write(`data: ${JSON.stringify({ version })}\n\n`);
    liveListeners.add(send);

    // A comment line every 25 seconds stops proxies closing an idle connection.
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 25000);

    req.on('close', () => {
        liveListeners.delete(send);
        clearInterval(keepAlive);
    });
});

app.get('/api/version', (req, res) => {
    res.json({ version: dataVersion });
});

// ---------- ATHLETE ENDPOINTS ----------
app.get('/api/athletes', (req, res) => {
    res.json(getAthletes());
});

app.post('/api/athletes', (req, res) => {
    const athletes = getAthletes();
    const body = { ...req.body };
    delete body.password; // don't persist the credential
    const newAthlete = { id: generateId(), ...body, createdAt: new Date().toISOString() };
    athletes.push(newAthlete);
    writeJSON(ATHLETES_FILE, athletes);
    res.json(newAthlete);
});

app.post('/api/athletes/bulk', (req, res) => {
    const payload = Array.isArray(req.body) ? req.body : req.body.athletes;
    if (!Array.isArray(payload)) {
        return res.status(400).json({ error: 'Expected an array of athletes' });
    }
    const athletes = getAthletes();
    const newAthletes = payload.map(a => ({
        id: generateId(), ...a, createdAt: new Date().toISOString()
    }));
    athletes.push(...newAthletes);
    writeJSON(ATHLETES_FILE, athletes);
    res.json(newAthletes);
});

// FIX: /all MUST be registered before /:id, otherwise Express matches
// "all" as an :id, filters nothing, and cheerfully reports success.
app.delete('/api/athletes/all', (req, res) => {
    writeJSON(ATHLETES_FILE, []);
    res.json({ success: true, deleted: 'all' });
});

app.patch('/api/athletes/:id', (req, res) => {
    const athletes = getAthletes();
    const index = athletes.findIndex(a => a.id === req.params.id);
    if (index === -1) return res.status(404).json({ error: 'Athlete not found' });
    const body = { ...req.body };
    delete body.password;
    delete body.id;
    athletes[index] = { ...athletes[index], ...body, updatedAt: new Date().toISOString() };
    writeJSON(ATHLETES_FILE, athletes);
    res.json(athletes[index]);
});

app.delete('/api/athletes/:id', (req, res) => {
    const athletes = getAthletes();
    const filtered = athletes.filter(a => a.id !== req.params.id);
    // FIX: report honestly instead of always saying success
    if (filtered.length === athletes.length) {
        return res.status(404).json({ error: 'Athlete not found', id: req.params.id });
    }
    writeJSON(ATHLETES_FILE, filtered);

    // FIX: also remove that athlete's entries and marks, otherwise the results
    // page keeps showing orphaned rows.
    const entries = getEntries().filter(e => e.athleteId !== req.params.id);
    const marks = getMarks().filter(m => m.athleteId !== req.params.id);
    writeJSON(ENTRIES_FILE, entries);
    writeJSON(MARKS_FILE, marks);

    res.json({ success: true, deleted: req.params.id });
});

// ---------- EVENT ENDPOINTS ----------
app.get('/api/events', (req, res) => {
    res.json(getEvents());
});

app.post('/api/events', (req, res) => {
    const events = getEvents();
    const body = { ...req.body };
    delete body.password;
    const newEvent = {
        id: generateId(),
        ...body,
        status: body.status || 'pending',
        createdAt: new Date().toISOString()
    };
    events.push(newEvent);
    writeJSON(EVENTS_FILE, events);
    res.json(newEvent);
});

// /all before /:id (see note above)
app.delete('/api/events/all', (req, res) => {
    writeJSON(EVENTS_FILE, []);
    writeJSON(ENTRIES_FILE, []);
    writeJSON(MARKS_FILE, []);
    res.json({ success: true, deleted: 'all' });
});

app.get('/api/events/:id', (req, res) => {
    const event = getEvents().find(e => e.id === req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    res.json(event);
});

app.patch('/api/events/:id', (req, res) => {
    const events = getEvents();
    const index = events.findIndex(e => e.id === req.params.id);
    if (index === -1) return res.status(404).json({ error: 'Event not found' });
    const body = { ...req.body };
    delete body.password;
    delete body.id;
    events[index] = { ...events[index], ...body, updatedAt: new Date().toISOString() };
    writeJSON(EVENTS_FILE, events);
    res.json(events[index]);
});

app.delete('/api/events/:id', (req, res) => {
    const events = getEvents();
    const filteredEvents = events.filter(e => e.id !== req.params.id);
    if (filteredEvents.length === events.length) {
        return res.status(404).json({ error: 'Event not found', id: req.params.id });
    }
    writeJSON(EVENTS_FILE, filteredEvents);
    writeJSON(ENTRIES_FILE, getEntries().filter(e => e.eventId !== req.params.id));
    writeJSON(MARKS_FILE, getMarks().filter(m => m.eventId !== req.params.id));
    res.json({ success: true, deleted: req.params.id });
});

// ---------- ENTRY ENDPOINTS ----------
app.get('/api/entries', (req, res) => {
    const entries = getEntries();
    const { eventId, athleteId } = req.query;
    let out = entries;
    if (eventId) out = out.filter(e => e.eventId === eventId);
    if (athleteId) out = out.filter(e => e.athleteId === athleteId);
    res.json(out);
});

app.post('/api/entries', (req, res) => {
    const entries = getEntries();
    const body = { ...req.body };
    delete body.password;

    if (!body.eventId || !body.athleteId) {
        return res.status(400).json({ error: 'eventId and athleteId are required' });
    }
    // FIX: block duplicate entries, which used to pile up silently and make
    // the same athlete appear several times in a start list.
    const dupe = entries.find(e => e.eventId === body.eventId && e.athleteId === body.athleteId);
    if (dupe) return res.status(409).json({ error: 'Athlete already entered in this event', entry: dupe });

    const newEntry = { id: generateId(), ...body, createdAt: new Date().toISOString() };
    entries.push(newEntry);
    writeJSON(ENTRIES_FILE, entries);
    res.json(newEntry);
});

app.post('/api/entries/bulk', (req, res) => {
    const entries = getEntries();
    const { eventId, athleteIds } = req.body;
    if (!eventId || !Array.isArray(athleteIds)) {
        return res.status(400).json({ error: 'eventId and athleteIds[] are required' });
    }
    const newEntries = [];
    for (const athleteId of athleteIds) {
        if (entries.some(e => e.eventId === eventId && e.athleteId === athleteId)) continue;
        const entry = { id: generateId(), eventId, athleteId, createdAt: new Date().toISOString() };
        entries.push(entry);
        newEntries.push(entry);
    }
    writeJSON(ENTRIES_FILE, entries);
    res.json(newEntries);
});

// specific routes before /:id
app.delete('/api/entries/all', (req, res) => {
    writeJSON(ENTRIES_FILE, []);
    res.json({ success: true, deleted: 'all' });
});

app.delete('/api/entries/event/:eventId', (req, res) => {
    const entries = getEntries();
    const filtered = entries.filter(e => e.eventId !== req.params.eventId);
    writeJSON(ENTRIES_FILE, filtered);
    // marks for that event become meaningless too
    writeJSON(MARKS_FILE, getMarks().filter(m => m.eventId !== req.params.eventId));
    res.json({ success: true, removed: entries.length - filtered.length });
});

app.patch('/api/entries/:id', (req, res) => {
    const entries = getEntries();
    const index = entries.findIndex(e => e.id === req.params.id);
    if (index === -1) return res.status(404).json({ error: 'Entry not found' });
    const body = { ...req.body };
    delete body.password;
    delete body.id;
    entries[index] = { ...entries[index], ...body, updatedAt: new Date().toISOString() };
    writeJSON(ENTRIES_FILE, entries);
    res.json(entries[index]);
});

app.delete('/api/entries/:id', (req, res) => {
    const entries = getEntries();
    const target = entries.find(e => e.id === req.params.id);
    if (!target) {
        return res.status(404).json({ error: 'Entry not found', id: req.params.id });
    }
    writeJSON(ENTRIES_FILE, entries.filter(e => e.id !== req.params.id));

    // FIX: remove the athlete's marks for that event too. Leaving them behind
    // meant a deleted athlete reappeared in the results as soon as the page
    // refreshed - which looks exactly like "the delete didn't work".
    const marks = getMarks().filter(
        m => !(m.eventId === target.eventId && m.athleteId === target.athleteId)
    );
    writeJSON(MARKS_FILE, marks);

    res.json({ success: true, deleted: req.params.id });
});

// ---------- MARK ENDPOINTS ----------
app.get('/api/marks', (req, res) => {
    const marks = getMarks();
    const { eventId, athleteId } = req.query;
    let out = marks;
    if (eventId) out = out.filter(m => m.eventId === eventId);
    if (athleteId) out = out.filter(m => m.athleteId === athleteId);
    res.json(out);
});

// Get attempts for a specific athlete/event.
// Registered before /api/marks/:id so "attempts" is never read as an id.
app.get('/api/marks/attempts', (req, res) => {
    const marks = getMarks();
    const { eventId, athleteId } = req.query;
    if (!eventId || !athleteId) {
        return res.status(400).json({ error: 'eventId and athleteId required' });
    }
    const attempts = marks
        .filter(m => m.eventId === eventId && m.athleteId === athleteId && m.attempt !== undefined && !m.isBest)
        .sort((a, b) => a.attempt - b.attempt);

    const best = marks.find(m => m.eventId === eventId && m.athleteId === athleteId && m.isBest === true);
    res.json({ attempts, best: best ? best.mark : null });
});

app.post('/api/marks', (req, res) => {
    const marks = getMarks();
    const { eventId, athleteId, mark } = req.body;
    if (!eventId || !athleteId) {
        return res.status(400).json({ error: 'eventId and athleteId are required' });
    }

    // replace any previous mark for this athlete in this event
    const filtered = marks.filter(m => !(m.eventId === eventId && m.athleteId === athleteId));

    const newMark = {
        id: generateId(),
        eventId,
        athleteId,
        mark,
        isBest: true,           // FIX: single marks are now flagged too, so the
                                // results endpoint finds them consistently
        createdAt: new Date().toISOString()
    };
    filtered.push(newMark);
    writeJSON(MARKS_FILE, filtered);
    res.json(newMark);
});

// FIX: THIS IS THE BIG ONE. The original built a `filtered` array with the old
// marks removed... then pushed onto the ORIGINAL `marks` array and saved that.
// The old attempts were never deleted. Every re-entry added another full set,
// and because the results endpoint picked the FIRST matching mark it kept
// showing the very first value the athlete was ever given. That is the "I edit
// a mark and the front end doesn't change" bug.
app.post('/api/marks/attempts', (req, res) => {
    const marks = getMarks();
    const { eventId, athleteId, attempts } = req.body;

    if (!eventId || !athleteId || !Array.isArray(attempts)) {
        return res.status(400).json({ error: 'eventId, athleteId and attempts[] are required' });
    }

    const kept = marks.filter(m => !(m.eventId === eventId && m.athleteId === athleteId));

    const newMarks = attempts.map((attempt, index) => ({
        id: generateId(),
        eventId,
        athleteId,
        mark: (attempt === null || attempt === undefined || attempt === '') ? 'DNS' : attempt,
        attempt: index + 1,
        createdAt: new Date().toISOString()
    }));

    const validAttempts = attempts.filter(a => a !== null && a !== '' && !isNaN(parseFloat(a)) && parseFloat(a) > 0);
    let best = 'DNS';
    if (validAttempts.length > 0) {
        best = Math.max(...validAttempts.map(a => parseFloat(a))).toString();
    }

    newMarks.push({
        id: generateId(),
        eventId,
        athleteId,
        mark: best,
        isBest: true,
        createdAt: new Date().toISOString()
    });

    kept.push(...newMarks);        // <-- was `marks.push(...)`
    writeJSON(MARKS_FILE, kept);   // <-- was `writeJSON(MARKS_FILE, marks)`
    res.json({ success: true, marks: newMarks });
});

app.delete('/api/marks/all', (req, res) => {
    writeJSON(MARKS_FILE, []);
    res.json({ success: true, deleted: 'all' });
});

// Clear one athlete's marks in one event (all attempts plus the best)
app.delete('/api/marks/event/:eventId/athlete/:athleteId', (req, res) => {
    const marks = getMarks();
    const { eventId, athleteId } = req.params;
    const filtered = marks.filter(m => !(m.eventId === eventId && m.athleteId === athleteId));
    writeJSON(MARKS_FILE, filtered);
    res.json({ success: true, removed: marks.length - filtered.length });
});

app.delete('/api/marks/:id', (req, res) => {
    const marks = getMarks();
    const filtered = marks.filter(m => m.id !== req.params.id);
    if (filtered.length === marks.length) {
        return res.status(404).json({ error: 'Mark not found', id: req.params.id });
    }
    writeJSON(MARKS_FILE, filtered);
    res.json({ success: true, deleted: req.params.id });
});

// ---------- RESULTS ENDPOINTS ----------
app.get('/api/events/:id/startlist', (req, res) => {
    const eventId = req.params.id;
    const event = getEvents().find(e => e.id === eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const entries = getEntries().filter(e => e.eventId === eventId);
    const athletes = getAthletes();

    const startList = entries
        .map(entry => ({ ...entry, athlete: athletes.find(a => a.id === entry.athleteId) || null }))
        .filter(s => s.athlete);

    res.json({ event, startList });
});

app.get('/api/events/:id/results', (req, res) => {
    const eventId = req.params.id;
    const event = getEvents().find(e => e.id === eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const entries = getEntries().filter(e => e.eventId === eventId);
    const marks = getMarks().filter(m => m.eventId === eventId);
    const athletes = getAthletes();
    const reference = getReference();
    const guideClasses = reference.guideClasses || [];

    let eventClasses = [];
    if (event.classes && event.classes.length > 0) eventClasses = event.classes;
    else if (event.class) eventClasses = [event.class];

    const entryClasses = entries
        .map(e => { const a = athletes.find(x => x.id === e.athleteId); return a ? a.class : null; })
        .filter(Boolean);

    // The classes DECLARED on the event decide whether this is a combined
    // event - not whoever happens to be entered. Otherwise one athlete entered
    // in the wrong class silently flips a single-class event onto Raza points
    // and changes every placing.
    const declared = eventClasses.map(c => String(c).toUpperCase());
    const isCombinedClass = declared.length > 1
        || event.isCombined === true
        || (declared.length === 0 && new Set(entryClasses).size > 1);

    const uniqueClasses = declared.length ? declared
                                          : [...new Set(entryClasses)];

    // FIX: pick the NEWEST mark. The old code took the first match in file
    // order, so once duplicates existed it displayed the oldest value forever.
    function markFor(athleteId) {
        const mine = marks
            .filter(m => m.athleteId === athleteId)
            .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
        return mine.find(m => m.isBest === true) || mine[0] || null;
    }

    const results = entries.map(entry => {
        const athlete = athletes.find(a => a.id === entry.athleteId);
        const mark = markFor(entry.athleteId);

        let points = null;
        let pointsNote = null;
        const performance = mark && mark.mark ? mark.mark : 'DNS';

        // Pass the mark through as typed. raza.js handles "11.10", "2:05.43"
        // and "1:02:33.5" - parseFloat used to turn "2:05.43" into 2.
        if (mark && mark.mark && athlete) {
            const scored = calculateRazaPoints(
                athlete.class, event.discipline, mark.mark, athlete.sex, event.youth
            );
            points = scored.points;
            if (points === null && scored.reason && scored.reason !== 'no valid performance') {
                pointsNote = scored.reason;
            }
        }

        return {
            entryId: entry.id,
            athleteId: entry.athleteId,
            name: athlete ? athlete.name : 'Unknown',
            class: athlete ? athlete.class : '',
            sex: athlete ? athlete.sex : '',
            bib: athlete ? athlete.bib : '',
            club: athlete ? athlete.club : '',
            mark: performance,
            points,
            pointsNote,
            outOfClass: !!(athlete && declared.length &&
                           !declared.includes(String(athlete.class).toUpperCase())),
            hasGuide: athlete ? guideClasses.includes(athlete.class) : false,
            guide: athlete && guideClasses.includes(athlete.class) ? 'Yes' : ''
        };
    });

    const isTrack = isTrackDiscipline(event.discipline);
    const isRelay = RELAY_DISCIPLINES.includes(event.discipline);
    const isField = isFieldDiscipline(event.discipline);

    results.forEach(r => {
        if (['DNS', 'DNF', 'DQ', 'NM'].includes(r.mark)) {
            r.value = null;
            r.isDNS = true;
            r.points = null;
        } else {
            const v = parseFloat(r.mark);
            r.value = isNaN(v) ? null : v;
            r.isDNS = isNaN(v);   // FIX: an unparseable mark is now treated as
                                  // no-result instead of poisoning the sort
            if (r.isDNS) r.points = null;
        }
    });

    results.sort((a, b) => {
        if (a.isDNS && b.isDNS) return 0;
        if (a.isDNS) return 1;
        if (b.isDNS) return -1;

        if (isCombinedClass && a.points !== null && b.points !== null) return b.points - a.points;
        if (isCombinedClass && a.points !== null && b.points === null) return -1;
        if (isCombinedClass && a.points === null && b.points !== null) return 1;

        if (isTrack || isRelay) return a.value - b.value;
        if (isField) return b.value - a.value;
        return 0;
    });

    let rank = 1;
    results.forEach((r, index) => {
        if (r.isDNS) {
            r.rank = '-';
            return;
        }
        let isTie = false;
        if (index > 0 && !results[index - 1].isDNS) {
            isTie = (isCombinedClass && r.points !== null && results[index - 1].points !== null)
                ? r.points === results[index - 1].points
                : r.value === results[index - 1].value;
        }
        r.rank = isTie ? results[index - 1].rank : rank;
        rank++;
    });

    res.json({
        event,
        results,
        isCombinedClass,
        uniqueClasses,
        declaredClasses: declared,
        // So the results pages can say WHICH table was used. Youth and open
        // give different points for the same mark, and silently using the
        // wrong one is very hard to spot.
        youth: !!event.youth,
        pointsTable: event.youth ? 'World Para Athletics Youth' : 'World Para Athletics Open',
        outOfClassCount: results.filter(r => r.outOfClass).length,
        rankingMethod: isCombinedClass ? 'Raza Points' : 'Performance',
        razaTableVersion: isCombinedClass ? raza.TABLE_VERSION : undefined
    });
});

// ---------- RAZA LOOKUP ENDPOINTS ----------
// Public reads, so a results page or a coach on a phone can use them.

// Score one performance. e.g. /api/raza?discipline=Shot Put&class=F33&sex=M&mark=12.00
app.get('/api/raza', (req, res) => {
    const { discipline, class: classCode, sex, mark, youth } = req.query;
    const out = raza.razaPoints({
        discipline, classCode, sex, mark, youth: youth === 'true' || youth === '1'
    });
    res.json({ ...out, tableVersion: raza.TABLE_VERSION });
});

// What performance is needed for a given points total (qualifying standards)?
app.get('/api/raza/required', (req, res) => {
    const { discipline, class: classCode, sex, points, youth } = req.query;
    const required = raza.performanceForPoints({
        discipline, classCode, sex,
        points: parseFloat(points),
        youth: youth === 'true' || youth === '1'
    });
    res.json({
        required,
        reference: raza.referencePerformance(discipline, classCode, sex),
        tableVersion: raza.TABLE_VERSION
    });
});

// Which events and classes the official table actually covers.
app.get('/api/raza/table', (req, res) => {
    res.json({
        tableVersion: raza.TABLE_VERSION,
        maxPoints: raza.A,
        track: raza.TRACK_EVENTS,
        field: raza.FIELD_EVENTS,
        classes: [...raza.TRACK_EVENTS, ...raza.FIELD_EVENTS].reduce((acc, ev) => {
            acc[ev] = { M: raza.classesFor(ev, 'M'), W: raza.classesFor(ev, 'F') };
            return acc;
        }, {})
    });
});

// ---------- MEET ENDPOINTS ----------
app.get('/api/meet', (req, res) => {
    res.json(getMeet());
});

app.post('/api/meet', (req, res) => {
    const body = { ...req.body };
    delete body.password;
    // FIX: merge instead of replacing wholesale, so a partial save from one
    // form no longer wipes fields owned by another form.
    const merged = { ...getMeet(), ...body };
    writeJSON(MEET_FILE, merged);
    res.json(merged);
});

// ---------- REFERENCE ENDPOINTS ----------
app.get('/api/reference', (req, res) => {
    res.json(getReference());
});

// ---------- TEAM ENTRY ENDPOINT ----------
app.post('/api/team-entry', (req, res) => {
    const { club, country, manager, email, athletes } = req.body;

    if (!club || !country || !manager || !email) {
        return res.status(400).json({ error: 'Missing required team information' });
    }
    if (!Array.isArray(athletes) || athletes.length === 0) {
        return res.status(400).json({ error: 'No athletes provided' });
    }

    const events = getEvents();
    // FIX: read once, write once. The original re-read and re-wrote both files
    // inside the loop, which is slow and can lose entries under concurrency.
    const allAthletes = getAthletes();
    const allEntries = getEntries();

    let imported = 0;
    let errors = 0;
    const results = [];

    for (const athlete of athletes) {
        try {
            const existing = allAthletes.find(a => a.name === athlete.name && a.class === athlete.class);

            let athleteId;
            if (existing) {
                athleteId = existing.id;
            } else {
                const newAthlete = {
                    id: generateId(),
                    name: athlete.name,
                    class: athlete.class,
                    sex: athlete.sex || 'M',
                    bib: athlete.bib || '',
                    club,
                    country,
                    createdAt: new Date().toISOString()
                };
                allAthletes.push(newAthlete);
                athleteId = newAthlete.id;
            }

            let entryCount = 0;
            for (const eventName of (athlete.events || [])) {
                const matchedEvent = events.find(e =>
                    e.discipline === eventName ||
                    (e.name && e.name.includes(eventName)) ||
                    (e.discipline && eventName.includes(e.discipline))
                );
                if (!matchedEvent) continue;

                const exists = allEntries.find(e => e.eventId === matchedEvent.id && e.athleteId === athleteId);
                if (exists) continue;

                allEntries.push({
                    id: generateId(),
                    eventId: matchedEvent.id,
                    athleteId,
                    createdAt: new Date().toISOString()
                });
                entryCount++;
            }

            imported++;
            results.push({ name: athlete.name, status: 'success', entries: entryCount, newAthlete: !existing });
        } catch (error) {
            errors++;
            results.push({ name: athlete.name, status: 'error', error: error.message });
        }
    }

    writeJSON(ATHLETES_FILE, allAthletes);
    writeJSON(ENTRIES_FILE, allEntries);

    res.json({ success: true, club, imported, errors, results });
});

// ---------- ERROR HANDLING ----------
// FIX: unknown API paths used to fall through to express.static and return the
// HTML index page, so the front end tried to JSON.parse("<!DOCTYPE html>") and
// showed a confusing parse error instead of "not found".
app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Unknown API endpoint', path: req.originalUrl });
});

// FIX: any thrown error used to kill the process. Now it returns JSON.
app.use((err, req, res, next) => {
    console.error('[error]', err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'Server error', message: err.message });
});

process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));
process.on('uncaughtException', err => console.error('[uncaughtException]', err));

// ---------- SERVER START ----------
app.listen(PORT, '0.0.0.0', () => {
    console.log('========================================');
    console.log('Para Athletics System');
    console.log('========================================');
    console.log(`Local:    http://localhost:${PORT}`);
    console.log(`Data dir: ${DATA_DIR}`);
    if (!process.env.DATA_DIR && process.env.RENDER) {
        console.warn('WARNING: DATA_DIR is not set and this looks like Render.');
        console.warn('         Data will be ERASED on every deploy and restart.');
        console.warn('         Attach a persistent disk and set DATA_DIR to its mount path.');
    }
    if (ADMIN_PASSWORD === 'admin123') {
        console.warn('WARNING: using the default admin password. Set ADMIN_PASSWORD.');
    }
    console.log('========================================');
});
