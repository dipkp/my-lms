const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const app = express();

// ── ENV ──────────────────────────────────────────────────────────────────────
const PASSCODE    = process.env.ADMIN_PASSCODE || 'admin123';
const ASSEMBLY_KEY = process.env.ASSEMBLY_KEY || 'bc85b356827f4ba78b00e5559ed47081';
const B2_KEY_ID   = process.env.B2_KEY_ID;
const B2_APP_KEY  = process.env.B2_APP_KEY;
const B2_BUCKET   = process.env.B2_BUCKET || 'my-lms-files';

// ── BACKBLAZE B2 CLIENT (S3-compatible) ──────────────────────────────────────
let s3;
if (B2_KEY_ID && B2_APP_KEY) {
    s3 = new S3Client({
        endpoint: 'https://s3.us-west-004.backblazeb2.com',
        region: 'us-west-004',
        credentials: { accessKeyId: B2_KEY_ID, secretAccessKey: B2_APP_KEY }
    });
}

// Upload buffer to B2, returns public URL
async function uploadToB2(buffer, filename, mimetype) {
    if (!s3) throw new Error('B2 not configured');
    await s3.send(new PutObjectCommand({
        Bucket: B2_BUCKET,
        Key: filename,
        Body: buffer,
        ContentType: mimetype
    }));
    return `https://f004.backblazeb2.com/file/${B2_BUCKET}/${filename}`;
}

// Delete file from B2 by URL
async function deleteFromB2(fileUrl) {
    if (!s3 || !fileUrl) return;
    try {
        const key = fileUrl.split(`/file/${B2_BUCKET}/`)[1];
        if (key) await s3.send(new DeleteObjectCommand({ Bucket: B2_BUCKET, Key: key }));
    } catch (e) { console.error('B2 delete error:', e.message); }
}

// ── MULTER (memory storage — files go to B2, not disk) ───────────────────────
const ALLOWED_AUDIO = /\.(mp3|wav|m4a|ogg|aac|flac|mp4|weba|opus)$/i;
const ALLOWED_DOCX  = /\.(docx?|doc)$/i;
const ALLOWED_PDF   = /\.pdf$/i;

function audioFilter(req, file, cb) {
    if (file.mimetype.startsWith('audio/') || ALLOWED_AUDIO.test(file.originalname)) cb(null, true);
    else cb(new Error('Only audio files are allowed'));
}
function docxFilter(req, file, cb) {
    if (ALLOWED_DOCX.test(file.originalname)) cb(null, true);
    else cb(new Error('Only .docx/.doc files are allowed'));
}
function pdfFilter(req, file, cb) {
    if (ALLOWED_PDF.test(file.originalname)) cb(null, true);
    else cb(new Error('Only PDF files are allowed'));
}
function mixedFilter(req, file, cb) {
    if (file.fieldname === 'audioFile' && (file.mimetype.startsWith('audio/') || ALLOWED_AUDIO.test(file.originalname))) cb(null, true);
    else if (file.fieldname === 'docxFile' && ALLOWED_DOCX.test(file.originalname)) cb(null, true);
    else cb(new Error('Invalid file type for field: ' + file.fieldname));
}

const mem = multer.memoryStorage();
const upload      = multer({ storage: mem, limits: { fileSize: 200 * 1024 * 1024 }, fileFilter: mixedFilter });
const uploadPdf   = multer({ storage: mem, limits: { fileSize: 200 * 1024 * 1024 }, fileFilter: pdfFilter });
const uploadAudio = multer({ storage: mem, limits: { fileSize: 200 * 1024 * 1024 }, fileFilter: audioFilter });

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// ── DATABASE ──────────────────────────────────────────────────────────────────
const dataFile   = './database.json';
const dictFile   = './dictionary.json';
const essaysFile = './essays.json';
const booksFile  = './books.json';
const audioFile  = './audio.json';

[dataFile, dictFile, essaysFile, booksFile, audioFile].forEach(f => {
    if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify([]));
});

const readDB  = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) { return []; } };
const writeDB = (file, data) => { try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (e) { console.error('DB write error:', e.message); } };

function nextIntId(arr) {
    return arr.length > 0 ? Math.max(...arr.map(l => Number.isInteger(l.id) ? l.id : 0)) + 1 : 1;
}

function makeKey(originalname) {
    const safe = originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    return Date.now() + '-' + Math.random().toString(36).slice(2) + '-' + safe;
}

// ── LESSONS ───────────────────────────────────────────────────────────────────
app.get('/lessons', (req, res) => res.json(readDB(dataFile)));

app.post('/reorder-lessons', (req, res) => {
    const { orderedIds } = req.body;
    let lessons = readDB(dataFile);
    const newLessons = [];
    orderedIds.forEach(id => {
        const lesson = lessons.find(l => l.id === id);
        if (lesson) { newLessons.push(lesson); lessons = lessons.filter(l => l.id !== id); }
    });
    writeDB(dataFile, [...newLessons, ...lessons]);
    res.json({ success: true });
});

app.post('/update-transcript', (req, res) => {
    const { id, transcript } = req.body;
    const lessons = readDB(dataFile);
    const idx = lessons.findIndex(l => l.id === id);
    if (idx > -1) { lessons[idx].transcript = transcript || ''; writeDB(dataFile, lessons); }
    res.json({ success: true });
});

app.post('/toggle-bookmark', (req, res) => {
    const { id, bookmarked } = req.body;
    const lessons = readDB(dataFile);
    const idx = lessons.findIndex(l => l.id === id);
    if (idx > -1) { lessons[idx].bookmarked = !!bookmarked; writeDB(dataFile, lessons); }
    res.json({ success: true });
});

app.post('/delete-lesson', async (req, res) => {
    const { id, passcode } = req.body;
    if (passcode !== PASSCODE) return res.status(403).json({ success: false, message: 'Invalid passcode' });
    const lessons = readDB(dataFile);
    const idx = lessons.findIndex(l => l.id === id);
    if (idx === -1) return res.status(404).json({ success: false });
    const lesson = lessons[idx];
    await deleteFromB2(lesson.audioPath);
    await deleteFromB2(lesson.docxPath);
    lessons.splice(idx, 1);
    writeDB(dataFile, lessons);
    res.json({ success: true });
});

app.post('/move-lesson', (req, res) => {
    const { id, course, category } = req.body;
    const lessons = readDB(dataFile);
    const idx = lessons.findIndex(l => l.id === id);
    if (idx > -1) { lessons[idx].course = course; lessons[idx].category = category || 'Moved Items'; writeDB(dataFile, lessons); }
    res.json({ success: true });
});

app.post('/upload', (req, res) => {
    upload.fields([{ name: 'audioFile', maxCount: 1 }, { name: 'docxFile', maxCount: 1 }])(req, res, async (err) => {
        if (err) return res.status(400).json({ success: false, message: err.message });
        try {
            const { title, transcript, course, category, type } = req.body;
            const lessons = readDB(dataFile);
            const newId = nextIntId(lessons);

            const lesson = {
                id: newId,
                course: course || 'course1',
                category: category || 'Uncategorized',
                title: (title || 'Untitled').trim(),
                bookmarked: false,
                transcript: transcript || '',
                type: type || 'audio',
                audioPath: null, docxPath: null, youtubeUrl: null
            };

            if (!req.files || !req.files['audioFile']) return res.status(400).json({ success: false, message: 'Audio file is required' });

            const af = req.files['audioFile'][0];
            lesson.audioPath = await uploadToB2(af.buffer, makeKey(af.originalname), af.mimetype);

            if (req.files['docxFile']) {
                const df = req.files['docxFile'][0];
                lesson.docxPath = await uploadToB2(df.buffer, makeKey(df.originalname), df.mimetype);
                lesson.type = 'docx';
            }

            lessons.push(lesson);
            writeDB(dataFile, lessons);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ success: false, message: e.message }); }
    });
});

app.post('/add-youtube', (req, res) => {
    const { title, youtubeUrl, course, category } = req.body;
    const lessons = readDB(dataFile);
    lessons.push({
        id: nextIntId(lessons),
        course: course || 'course1',
        category: category || 'Part 4',
        title: (title || 'YouTube').trim(),
        bookmarked: false, transcript: '',
        type: 'youtube', audioPath: null, docxPath: null, youtubeUrl
    });
    writeDB(dataFile, lessons);
    res.json({ success: true });
});

// ── DICTIONARY ────────────────────────────────────────────────────────────────
app.get('/dictionary', (req, res) => res.json(readDB(dictFile)));

app.post('/dictionary', (req, res) => {
    const dict = readDB(dictFile);
    const { word, meaning, synonyms, category } = req.body;
    if (!word) return res.status(400).json({ success: false });
    const existing = dict.find(d => d.word.toLowerCase() === word.toLowerCase());
    if (existing) {
        if (meaning   !== undefined) existing.meaning   = meaning;
        if (synonyms  !== undefined) existing.synonyms  = synonyms;
        if (category  !== undefined) existing.category  = category;
    } else {
        dict.push({ id: nextIntId(dict), word, meaning: meaning || '', synonyms: synonyms || '', category: category || 'General' });
    }
    writeDB(dictFile, dict);
    res.json({ success: true });
});

app.post('/dictionary/bulk', (req, res) => {
    const dict = readDB(dictFile);
    const { items } = req.body;
    if (!items || !Array.isArray(items)) return res.status(400).json({ success: false });
    items.forEach(item => {
        if (!item.word) return;
        const existing = dict.find(d => d.word.toLowerCase() === item.word.toLowerCase());
        if (existing) {
            if (item.meaning  !== undefined) existing.meaning  = item.meaning;
            if (item.synonyms !== undefined) existing.synonyms = item.synonyms;
            if (item.category !== undefined) existing.category = item.category;
        } else {
            dict.push({ id: nextIntId(dict), word: item.word, meaning: item.meaning || '', synonyms: item.synonyms || '', category: item.category || 'General' });
        }
    });
    writeDB(dictFile, dict);
    res.json({ success: true });
});

app.post('/dictionary/delete', (req, res) => {
    let dict = readDB(dictFile);
    dict = dict.filter(d => d.id !== req.body.id);
    writeDB(dictFile, dict);
    res.json({ success: true });
});

// ── ESSAYS ────────────────────────────────────────────────────────────────────
app.get('/essays', (req, res) => res.json(readDB(essaysFile)));

app.post('/essays/add-bulk', (req, res) => {
    const essaysDB = readDB(essaysFile);
    const { essays, folder } = req.body;
    let maxId = essaysDB.length ? Math.max(...essaysDB.map(e => e.id)) : 0;
    essays.forEach(e => { maxId++; essaysDB.push({ id: maxId, title: e.title, content: e.content, folder: folder || 'General', locked: true }); });
    writeDB(essaysFile, essaysDB);
    res.json({ success: true });
});

app.post('/essays/toggle-lock', (req, res) => {
    const essays = readDB(essaysFile);
    const idx = essays.findIndex(e => e.id === req.body.id);
    if (idx > -1) { essays[idx].locked = false; writeDB(essaysFile, essays); }
    res.json({ success: true });
});

app.post('/essays/delete', (req, res) => {
    let essays = readDB(essaysFile);
    essays = essays.filter(e => e.id !== req.body.id);
    writeDB(essaysFile, essays);
    res.json({ success: true });
});

// ── BOOKS (PDF) ───────────────────────────────────────────────────────────────
app.get('/api/books', (req, res) => res.json(readDB(booksFile)));

app.post('/api/books/upload', (req, res) => {
    uploadPdf.array('pdfs')(req, res, async (err) => {
        if (err) return res.status(400).json({ success: false, message: err.message });
        if (!req.files || req.files.length === 0) return res.status(400).json({ success: false, message: 'No PDF files received.' });
        try {
            let db = readDB(booksFile);
            for (const f of req.files) {
                const url = await uploadToB2(f.buffer, makeKey(f.originalname), f.mimetype);
                db.push({ id: nextIntId(db), name: f.originalname, path: url, category: req.body.category || 'listening' });
            }
            writeDB(booksFile, db);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ success: false, message: e.message }); }
    });
});

app.post('/api/books/delete', async (req, res) => {
    let db = readDB(booksFile);
    const item = db.find(b => b.id === req.body.id);
    if (item) await deleteFromB2(item.path);
    writeDB(booksFile, db.filter(b => b.id !== req.body.id));
    res.json({ success: true });
});

// ── AUDIO FOLDER ──────────────────────────────────────────────────────────────
app.get('/api/audio', (req, res) => res.json(readDB(audioFile)));

app.post('/api/audio/upload', (req, res) => {
    uploadAudio.array('audioFiles')(req, res, async (err) => {
        if (err) return res.status(400).json({ success: false, message: err.message });
        if (!req.files || req.files.length === 0) return res.status(400).json({ success: false, message: 'No audio files received.' });
        try {
            let db = readDB(audioFile);
            let folderNames = [];
            try { folderNames = JSON.parse(req.body.folderNames || '[]'); } catch (e) { folderNames = []; }
            for (let i = 0; i < req.files.length; i++) {
                const f = req.files[i];
                const url = await uploadToB2(f.buffer, makeKey(f.originalname), f.mimetype);
                db.push({ id: nextIntId(db), name: f.originalname, path: url, folder: folderNames[i] || 'General' });
            }
            writeDB(audioFile, db);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ success: false, message: e.message }); }
    });
});

app.post('/api/audio/delete', async (req, res) => {
    let db = readDB(audioFile);
    const item = db.find(a => a.id === req.body.id);
    if (item) await deleteFromB2(item.path);
    writeDB(audioFile, db.filter(a => a.id !== req.body.id));
    res.json({ success: true });
});

// ── UTILS ─────────────────────────────────────────────────────────────────────
app.post('/fetch-playlist', async (req, res) => {
    const { playlistUrl } = req.body;
    try {
        const listMatch = playlistUrl.match(/[?&]list=([a-zA-Z0-9_-]+)/);
        if (!listMatch) return res.status(400).json({ success: false, message: 'Invalid URL' });
        const pageUrl = `https://www.youtube.com/playlist?list=${listMatch[1]}`;
        const html = await new Promise((resolve, reject) => {
            const r = https.get(pageUrl, resp => {
                let d = '';
                resp.on('data', c => d += c);
                resp.on('end', () => resolve(d));
                resp.on('error', reject);
            });
            r.setTimeout(10000, () => { r.destroy(); reject(new Error('Playlist fetch timed out')); });
            r.on('error', reject);
        });
        const videoIds = [...new Set([...html.matchAll(/watch\?v=([a-zA-Z0-9_-]{11})/g)].map(m => m[1]))];
        const videos = videoIds.map((vid, i) => ({ title: `Video ${i + 1}`, url: `https://www.youtube.com/watch?v=${vid}`, thumbnail: `https://img.youtube.com/vi/${vid}/mqdefault.jpg` }));
        res.json({ success: true, playlistTitle: 'YouTube Playlist', videos });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.get('/export-data', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=backup.json');
    res.send(JSON.stringify(readDB(dataFile), null, 2));
});

app.get('/view-docx', async (req, res) => {
    const fileUrl = req.query.path;
    if (!fileUrl || !fileUrl.startsWith('https://')) return res.status(400).send('Invalid path');
    https.get(fileUrl, (r) => {
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        r.pipe(res);
    }).on('error', () => res.status(404).send('Not found'));
});

// ── ASSEMBLYAI PROXY ──────────────────────────────────────────────────────────
const dns = require('dns');
function checkAssemblyAI(cb) { dns.lookup('api.assemblyai.com', (err) => cb(!err)); }

app.post('/api/transcribe/upload', express.raw({ type: 'application/octet-stream', limit: '200mb' }), (req, res) => {
    const body = req.body;
    checkAssemblyAI(reachable => {
        if (!reachable) return res.status(503).json({ error: 'Server has no internet access to reach AssemblyAI.' });
        const options = {
            hostname: 'api.assemblyai.com', path: '/v2/upload', method: 'POST', timeout: 30000,
            headers: { 'authorization': ASSEMBLY_KEY, 'content-type': 'application/octet-stream', 'content-length': body.length }
        };
        const aReq = https.request(options, aRes => {
            let data = '';
            aRes.on('data', c => data += c);
            aRes.on('end', () => res.status(aRes.statusCode).set('Content-Type', 'application/json').send(data));
        });
        aReq.on('error', e => { if (!res.headersSent) res.status(500).json({ error: e.message }); });
        aReq.on('timeout', () => { aReq.destroy(); if (!res.headersSent) res.status(500).json({ error: 'Upload timed out' }); });
        aReq.write(body);
        aReq.end();
    });
});

app.post('/api/transcribe/start', (req, res) => {
    const body = JSON.stringify({ ...req.body, speech_model: "universal-2" });
    const options = {
        hostname: 'api.assemblyai.com', path: '/v2/transcript', method: 'POST', timeout: 15000,
        headers: { 'authorization': ASSEMBLY_KEY, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
    };
    const aReq = https.request(options, aRes => {
        let data = '';
        aRes.on('data', c => data += c);
        aRes.on('end', () => res.status(aRes.statusCode).set('Content-Type', 'application/json').send(data));
    });
    aReq.on('error', e => { if (!res.headersSent) res.status(500).json({ error: e.message }); });
    aReq.on('timeout', () => { aReq.destroy(); if (!res.headersSent) res.status(500).json({ error: 'Transcription start timed out' }); });
    aReq.write(body);
    aReq.end();
});

app.get('/api/transcribe/poll/:id', (req, res) => {
    const options = {
        hostname: 'api.assemblyai.com', path: '/v2/transcript/' + req.params.id,
        method: 'GET', timeout: 10000,
        headers: { 'authorization': ASSEMBLY_KEY }
    };
    const aReq = https.request(options, aRes => {
        let data = '';
        aRes.on('data', c => data += c);
        aRes.on('end', () => res.status(aRes.statusCode).set('Content-Type', 'application/json').send(data));
    });
    aReq.on('error', e => { if (!res.headersSent) res.status(500).json({ error: e.message }); });
    aReq.on('timeout', () => { aReq.destroy(); if (!res.headersSent) res.status(500).json({ error: 'Poll timed out' }); });
    aReq.end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
