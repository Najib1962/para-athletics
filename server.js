const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Data paths
const DATA_DIR = path.join(__dirname, 'data');
const ATHLETES_FILE = path.join(DATA_DIR, 'athletes.json');
const ENTRIES_FILE = path.join(DATA_DIR, 'entries.json');
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');
const MARKS_FILE = path.join(DATA_DIR, 'marks.json');
const MEET_FILE = path.join(DATA_DIR, 'meet.json');
const REFERENCE_FILE = path.join(DATA_DIR, 'reference.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize files if they don't exist
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

// Helper functions
function readJSON(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJSON(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function getAthletes() { return readJSON(ATHLETES_FILE); }
function getEntries() { return readJSON(ENTRIES_FILE); }
function getEvents() { return readJSON(EVENTS_FILE); }
function getMarks() { return readJSON(MARKS_FILE); }
function getMeet() { return readJSON(MEET_FILE); }
function getReference() { return readJSON(REFERENCE_FILE); }

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

// ---------- RAZA POINTS SYSTEM ----------
// FIX: the table that used to sit here listed F11 to F64 THREE times over -
// once for women's track, once for men's field, once for women's field.
// JavaScript keeps only the last of a repeated entry, so two thirds of it was
// wiped out the moment the file loaded: 118 records written, 59 surviving.
// A men's shot put was then scored against a women's record.
//
// The sum was not the Raza formula either, and had no upper limit, which is
// how a club throw could show 2074 when the maximum is 1200.
//
// raza.js holds the official World Para Athletics constants, taken straight
// from their own calculator spreadsheets and checked against their published
// results: 421 of 422 rows match exactly.
const raza = require('./raza');

function calculateRazaPoints(classCode, discipline, performance, sex, youth) {
    const out = raza.razaPoints({
        discipline: discipline,
        classCode: classCode,
        sex: sex,
        mark: performance,
        youth: !!youth
    });
    return out.points;   // a number, or null where WPA publishes none
}


// ---------- ADMIN AUTHENTICATION ----------
const ADMIN_PASSWORD = 'admin123';

function isAdminRoute(path) {
    const adminPatterns = [
        '/admin.html', '/athletes.html', '/entries.html',
        '/api/entries', '/api/marks', '/api/events/all', '/api/athletes/all',
        '/api/entries/', '/api/marks/', '/api/events/all', '/api/athletes/all'
    ];
    return adminPatterns.some(pattern => path === pattern || path.startsWith(pattern));
}

// Middleware to protect admin routes
app.use((req, res, next) => {
    if (!isAdminRoute(req.path)) {
        return next();
    }
    // FIX: entries.html sends the password twice in the address when you
    // delete an entry. Express 5 reads a repeated setting as a LIST
    // rather than as text, so this comparison failed and the delete was
    // refused - silently, because the page never checks the answer.
    // Taking the first value makes it work either way.
    const supplied = req.headers['x-admin-password'] || req.query.password;
    const password = Array.isArray(supplied) ? supplied[0] : supplied;
    if (password === ADMIN_PASSWORD) {
        return next();
    }
    res.status(401).json({ 
        error: 'Admin access required',
        message: 'Please provide admin password'
    });
});

// ---------- ATHLETE ENDPOINTS ----------
app.get('/api/athletes', (req, res) => {
    res.json(getAthletes());
});

app.post('/api/athletes', (req, res) => {
    const athletes = getAthletes();
    const newAthlete = {
        id: generateId(),
        ...req.body,
        createdAt: new Date().toISOString()
    };
    athletes.push(newAthlete);
    writeJSON(ATHLETES_FILE, athletes);
    res.json(newAthlete);
});

app.post('/api/athletes/bulk', (req, res) => {
    const athletes = getAthletes();
    const newAthletes = req.body.map(a => ({
        id: generateId(),
        ...a,
        createdAt: new Date().toISOString()
    }));
    athletes.push(...newAthletes);
    writeJSON(ATHLETES_FILE, athletes);
    res.json(newAthletes);
});

app.delete('/api/athletes/:id', (req, res) => {
    const athletes = getAthletes();
    const filtered = athletes.filter(a => a.id !== req.params.id);
    writeJSON(ATHLETES_FILE, filtered);
    res.json({ success: true });
});

app.delete('/api/athletes/all', (req, res) => {
    writeJSON(ATHLETES_FILE, []);
    res.json({ success: true });
});

// ---------- EVENT ENDPOINTS ----------
app.get('/api/events', (req, res) => {
    res.json(getEvents());
});

app.get('/api/events/:id', (req, res) => {
    const event = getEvents().find(e => e.id === req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    res.json(event);
});

app.post('/api/events', (req, res) => {
    const events = getEvents();
    const newEvent = {
        id: generateId(),
        ...req.body,
        status: 'pending',
        createdAt: new Date().toISOString()
    };
    events.push(newEvent);
    writeJSON(EVENTS_FILE, events);
    res.json(newEvent);
});

app.patch('/api/events/:id', (req, res) => {
    const events = getEvents();
    const index = events.findIndex(e => e.id === req.params.id);
    if (index === -1) return res.status(404).json({ error: 'Event not found' });
    events[index] = { ...events[index], ...req.body };
    writeJSON(EVENTS_FILE, events);
    res.json(events[index]);
});

app.delete('/api/events/:id', (req, res) => {
    const events = getEvents();
    const entries = getEntries();
    const marks = getMarks();
    
    const filteredEntries = entries.filter(e => e.eventId !== req.params.id);
    const filteredMarks = marks.filter(m => m.eventId !== req.params.id);
    const filteredEvents = events.filter(e => e.id !== req.params.id);
    
    writeJSON(EVENTS_FILE, filteredEvents);
    writeJSON(ENTRIES_FILE, filteredEntries);
    writeJSON(MARKS_FILE, filteredMarks);
    res.json({ success: true });
});

app.delete('/api/events/all', (req, res) => {
    writeJSON(EVENTS_FILE, []);
    writeJSON(ENTRIES_FILE, []);
    writeJSON(MARKS_FILE, []);
    res.json({ success: true });
});

// ---------- ENTRY ENDPOINTS ----------
app.get('/api/entries', (req, res) => {
    const entries = getEntries();
    const eventId = req.query.eventId;
    if (eventId) {
        res.json(entries.filter(e => e.eventId === eventId));
    } else {
        res.json(entries);
    }
});

app.post('/api/entries', (req, res) => {
    const entries = getEntries();
    const newEntry = {
        id: generateId(),
        ...req.body,
        createdAt: new Date().toISOString()
    };
    entries.push(newEntry);
    writeJSON(ENTRIES_FILE, entries);
    res.json(newEntry);
});

app.post('/api/entries/bulk', (req, res) => {
    const entries = getEntries();
    const { eventId, athleteIds } = req.body;
    const newEntries = athleteIds.map(athleteId => ({
        id: generateId(),
        eventId,
        athleteId,
        createdAt: new Date().toISOString()
    }));
    entries.push(...newEntries);
    writeJSON(ENTRIES_FILE, entries);
    res.json(newEntries);
});

app.delete('/api/entries/:id', (req, res) => {
    const entries = getEntries();
    const filtered = entries.filter(e => e.id !== req.params.id);
    writeJSON(ENTRIES_FILE, filtered);
    res.json({ success: true });
});

app.delete('/api/entries/event/:eventId', (req, res) => {
    const entries = getEntries();
    const filtered = entries.filter(e => e.eventId !== req.params.eventId);
    writeJSON(ENTRIES_FILE, filtered);
    res.json({ success: true });
});

// ---------- MARK ENDPOINTS ----------
app.get('/api/marks', (req, res) => {
    const marks = getMarks();
    const eventId = req.query.eventId;
    if (eventId) {
        res.json(marks.filter(m => m.eventId === eventId));
    } else {
        res.json(marks);
    }
});

app.post('/api/marks', (req, res) => {
    const marks = getMarks();
    const { eventId, athleteId, mark } = req.body;
    
    const filtered = marks.filter(m => !(m.eventId === eventId && m.athleteId === athleteId));
    
    const newMark = {
        id: generateId(),
        eventId,
        athleteId,
        mark,
        createdAt: new Date().toISOString()
    };
    filtered.push(newMark);
    writeJSON(MARKS_FILE, filtered);
    res.json(newMark);
});

app.delete('/api/marks/:id', (req, res) => {
    const marks = getMarks();
    const filtered = marks.filter(m => m.id !== req.params.id);
    writeJSON(MARKS_FILE, filtered);
    res.json({ success: true });
});

// ---------- FIELD EVENT ATTEMPTS ENDPOINTS ----------
// Save multiple attempts for a field event
app.post('/api/marks/attempts', (req, res) => {
    const marks = getMarks();
    const { eventId, athleteId, attempts } = req.body;
    
    // Remove existing marks for this athlete/event
    const filtered = marks.filter(m => !(m.eventId === eventId && m.athleteId === athleteId));
    
    // Save each attempt as a separate mark with attempt number
    const newMarks = attempts.map((attempt, index) => ({
        id: generateId(),
        eventId,
        athleteId,
        mark: attempt || 'DNS',
        attempt: index + 1,
        createdAt: new Date().toISOString()
    }));
    
    // Also save the best attempt as the main mark
    const validAttempts = attempts.filter(a => a && !isNaN(parseFloat(a)) && parseFloat(a) > 0);
    let best = 'DNS';
    if (validAttempts.length > 0) {
        const bestValue = Math.max(...validAttempts.map(a => parseFloat(a)));
        best = bestValue.toString();
    }
    
    // Add the best as the main mark
    newMarks.push({
        id: generateId(),
        eventId,
        athleteId,
        mark: best,
        isBest: true,
        createdAt: new Date().toISOString()
    });
    
    // Add all new marks
    marks.push(...newMarks);
    writeJSON(MARKS_FILE, marks);
    res.json({ success: true, marks: newMarks });
});

// Get attempts for a specific athlete/event
app.get('/api/marks/attempts', (req, res) => {
    const marks = getMarks();
    const { eventId, athleteId } = req.query;
    
    if (!eventId || !athleteId) {
        return res.status(400).json({ error: 'eventId and athleteId required' });
    }
    
    const attempts = marks.filter(m => 
        m.eventId === eventId && 
        m.athleteId === athleteId &&
        m.attempt !== undefined &&
        !m.isBest
    ).sort((a, b) => a.attempt - b.attempt);
    
    const best = marks.find(m => 
        m.eventId === eventId && 
        m.athleteId === athleteId &&
        m.isBest === true
    );
    
    res.json({ attempts, best: best ? best.mark : null });
});

// ---------- RESULTS ENDPOINTS ----------
app.get('/api/events/:id/startlist', (req, res) => {
    const eventId = req.params.id;
    const event = getEvents().find(e => e.id === eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    
    const entries = getEntries().filter(e => e.eventId === eventId);
    const athletes = getAthletes();
    
    const startList = entries.map(entry => {
        const athlete = athletes.find(a => a.id === entry.athleteId);
        return {
            ...entry,
            athlete: athlete || null
        };
    }).filter(s => s.athlete);
    
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
    if (event.classes && event.classes.length > 0) {
        eventClasses = event.classes;
    } else if (event.class) {
        eventClasses = [event.class];
    }
    
    const entryClasses = entries.map(e => {
        const athlete = athletes.find(a => a.id === e.athleteId);
        return athlete ? athlete.class : null;
    }).filter(c => c);
    
    const uniqueClasses = [...new Set([...eventClasses, ...entryClasses])];
    const isCombinedClass = uniqueClasses.length > 1 || event.isCombined || false;
    
    // FIX: skip entries whose athlete has been deleted. They used to appear
    // as "Unknown" on results and could not be removed from any screen,
    // because the entries page hides rows with a missing athlete.
    const results = entries
        .filter(entry => athletes.some(a => a.id === entry.athleteId))
        .map(entry => {
        const athlete = athletes.find(a => a.id === entry.athleteId);
        // Find best mark for this athlete (isBest: true) or any mark
        const mark = marks.find(m => m.athleteId === entry.athleteId && m.isBest === true) || 
                     marks.find(m => m.athleteId === entry.athleteId);
        
        let points = null;
        let performance = mark ? mark.mark : 'DNS';
        
        if (mark && mark.mark && !['DNS', 'DNF', 'DQ', 'NM'].includes(mark.mark) && athlete) {
            const perf = parseFloat(mark.mark);
            if (!isNaN(perf) && perf > 0) {
                points = calculateRazaPoints(athlete.class, event.discipline, perf, athlete.sex, event.youth);
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
            points: points,
            hasGuide: athlete ? guideClasses.includes(athlete.class) : false,
            guide: athlete && guideClasses.includes(athlete.class) ? 'Yes' : ''
        };
    });
    
    const isTrack = ['100m', '200m', '400m', '800m', '1500m', '5000m', '10000m', 'Marathon'].includes(event.discipline);
    const isRelay = ['4x100m Relay', '4x400m Relay'].includes(event.discipline);
    const isField = ['Long Jump', 'Triple Jump', 'High Jump', 'Pole Vault', 'Shot Put', 'Discus', 'Javelin', 'Club Throw'].includes(event.discipline);
    
    results.forEach(r => {
        if (r.mark === 'DNS' || r.mark === 'DNF' || r.mark === 'DQ' || r.mark === 'NM') {
            r.value = null;
            r.isDNS = true;
            r.points = null;
        } else {
            const time = parseFloat(r.mark);
            r.value = isNaN(time) ? null : time;
            r.isDNS = false;
        }
    });
    
    results.sort((a, b) => {
        if (a.isDNS && b.isDNS) return 0;
        if (a.isDNS) return 1;
        if (b.isDNS) return -1;
        
        if (isCombinedClass && a.points !== null && b.points !== null) {
            return b.points - a.points;
        }
        
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
        } else {
            let isTie = false;
            if (index > 0 && !results[index-1].isDNS) {
                if (isCombinedClass && r.points !== null && results[index-1].points !== null) {
                    isTie = r.points === results[index-1].points;
                } else {
                    isTie = r.value === results[index-1].value;
                }
            }
            
            if (isTie) {
                r.rank = results[index-1].rank;
            } else {
                r.rank = rank;
            }
            rank++;
        }
    });
    
    res.json({ 
        event, 
        results, 
        isCombinedClass, 
        uniqueClasses,
        rankingMethod: isCombinedClass ? 'Raza Points' : 'Performance'
    });
});

// ---------- MEET ENDPOINTS ----------
app.get('/api/meet', (req, res) => {
    res.json(getMeet());
});

app.post('/api/meet', (req, res) => {
    writeJSON(MEET_FILE, req.body);
    res.json(req.body);
});

// ---------- REFERENCE ENDPOINTS ----------
app.get('/api/reference', (req, res) => {
    res.json(getReference());
});

// ---------- TEAM ENTRY ENDPOINT ----------
app.post('/api/team-entry', async (req, res) => {
    const { club, country, manager, email, phone, athletes } = req.body;

    if (!club || !country || !manager || !email) {
        return res.status(400).json({ error: 'Missing required team information' });
    }

    if (!athletes || athletes.length === 0) {
        return res.status(400).json({ error: 'No athletes provided' });
    }

    let imported = 0;
    let errors = 0;
    const results = [];

    // Get all existing events
    const events = getEvents();

    for (const athlete of athletes) {
        try {
            // Check if athlete already exists (by name and class)
            const existingAthletes = getAthletes();
            const existing = existingAthletes.find(a => 
                a.name === athlete.name && 
                a.class === athlete.class
            );

            let athleteId;
            if (existing) {
                athleteId = existing.id;
            } else {
                // Create new athlete
                const newAthlete = {
                    id: generateId(),
                    name: athlete.name,
                    class: athlete.class,
                    sex: athlete.sex || 'M',
                    bib: athlete.bib || '',
                    club: club,
                    createdAt: new Date().toISOString()
                };
                existingAthletes.push(newAthlete);
                writeJSON(ATHLETES_FILE, existingAthletes);
                athleteId = newAthlete.id;
            }

            // Register for events
            const entries = getEntries();
            let entryCount = 0;

            for (const eventName of athlete.events) {
                // Find matching event
                const matchedEvent = events.find(e =>
                    e.discipline === eventName ||
                    e.name.includes(eventName) ||
                    eventName.includes(e.discipline)
                );

                if (matchedEvent) {
                    // Check if entry already exists
                    const existingEntry = entries.find(e => 
                        e.eventId === matchedEvent.id && 
                        e.athleteId === athleteId
                    );

                    if (!existingEntry) {
                        entries.push({
                            id: generateId(),
                            eventId: matchedEvent.id,
                            athleteId: athleteId,
                            createdAt: new Date().toISOString()
                        });
                        entryCount++;
                    }
                }
            }

            if (entryCount > 0) {
                writeJSON(ENTRIES_FILE, entries);
            }

            imported++;
            results.push({ 
                name: athlete.name, 
                status: 'success', 
                entries: entryCount,
                newAthlete: !existing
            });

        } catch (error) {
            errors++;
            results.push({ 
                name: athlete.name, 
                status: 'error', 
                error: error.message 
            });
        }
    }

    res.json({
        success: true,
        club: club,
        imported: imported,
        errors: errors,
        results: results
    });
});

// ---------- SERVER START ----------
app.listen(PORT, '0.0.0.0', () => {
    console.log('========================================');
    console.log('🚀 Para Athletics System');
    console.log('========================================');
    console.log(`📍 Local: http://localhost:${PORT}`);
    console.log(`🔐 Admin Password: admin123`);
    console.log('========================================');
});