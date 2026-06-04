require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('./database');

const app = express();
const PORT = 3000;

const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!ASSEMBLYAI_API_KEY || !ANTHROPIC_API_KEY) {
  console.error('Error: ASSEMBLYAI_API_KEY and ANTHROPIC_API_KEY must be set in environment or .env file');
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

// ─── Rubric ───────────────────────────────────────────────────────────────────

const RUBRIC_FILE = path.join(__dirname, 'rubric.txt');
const DEFAULT_RUBRIC_FILE = path.join(__dirname, 'rubric.default.txt');

// Seed default file on first run
if (!fs.existsSync(DEFAULT_RUBRIC_FILE) && fs.existsSync(RUBRIC_FILE)) {
  fs.copyFileSync(RUBRIC_FILE, DEFAULT_RUBRIC_FILE);
}

function loadRubric() {
  if (fs.existsSync(RUBRIC_FILE)) return fs.readFileSync(RUBRIC_FILE, 'utf8');
  if (fs.existsSync(DEFAULT_RUBRIC_FILE)) return fs.readFileSync(DEFAULT_RUBRIC_FILE, 'utf8');
  return '';
}

function buildScoringPrompt(transcript, disposition) {
  return loadRubric()
    .replace('{DISPOSITION}', disposition)
    .replace('{TRANSCRIPT}', transcript);
}

// ─── SSE ──────────────────────────────────────────────────────────────────────

const sseClients = new Map();

function sendSSE(callId, event, data) {
  const clients = sseClients.get(callId);
  if (!clients) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach(res => { try { res.write(payload); } catch {} });
}

// ─── Call processing ──────────────────────────────────────────────────────────

async function processCall(callId, filePath, disposition) {
  try {
    sendSSE(callId, 'status', { step: 'uploading', message: 'Uploading audio to transcription service...' });

    const fileStream = fs.createReadStream(filePath);
    const uploadRes = await axios.post('https://api.assemblyai.com/v2/upload', fileStream, {
      headers: {
        authorization: ASSEMBLYAI_API_KEY,
        'content-type': 'application/octet-stream',
        'transfer-encoding': 'chunked'
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    });
    const audioUrl = uploadRes.data.upload_url;

    sendSSE(callId, 'status', { step: 'transcribing', message: 'Transcribing audio... this may take a minute.' });

    const transcriptRes = await axios.post('https://api.assemblyai.com/v2/transcript', {
      audio_url: audioUrl,
      speaker_labels: true
    }, { headers: { authorization: ASSEMBLYAI_API_KEY } });
    const transcriptId = transcriptRes.data.id;

    let transcript = null;
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const pollRes = await axios.get(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
        headers: { authorization: ASSEMBLYAI_API_KEY }
      });
      const status = pollRes.data.status;

      if (status === 'completed') {
        if (pollRes.data.utterances && pollRes.data.utterances.length > 0) {
          transcript = pollRes.data.utterances
            .map(u => `Speaker ${u.speaker}: ${u.text}`)
            .join('\n');
        } else {
          transcript = pollRes.data.text;
        }
        break;
      } else if (status === 'error') {
        throw new Error(`Transcription failed: ${pollRes.data.error}`);
      }

      if (i % 5 === 0 && i > 0) {
        sendSSE(callId, 'status', { step: 'transcribing', message: `Still transcribing... (${i * 3}s elapsed)` });
      }
    }

    if (!transcript) throw new Error('Transcription timed out');

    // Redact credit card numbers (16 digits, with or without spaces/dashes between groups of 4)
    transcript = transcript.replace(/\b(\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4})\b/g, '[REDACTED]');

    db.updateCall(callId, { transcript, status: 'scoring' });

    sendSSE(callId, 'status', { step: 'scoring', message: 'Analyzing transcript and generating score...' });

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      messages: [{ role: 'user', content: buildScoringPrompt(transcript, disposition) }]
    });

    const rawContent = message.content[0].text.trim();
    const jsonText = rawContent.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const scorecard = JSON.parse(jsonText);

    db.updateCall(callId, { score: scorecard.score, scorecard, status: 'complete' });
    sendSSE(callId, 'complete', { callId, score: scorecard.score });

  } catch (err) {
    console.error('Processing error for call', callId, err.message);
    db.updateCall(callId, { status: 'error', error: err.message });
    sendSSE(callId, 'error', { message: err.message });
  } finally {
    try { fs.unlinkSync(filePath); } catch {}
  }
}

// ─── Score override helper ────────────────────────────────────────────────────

function recalcScore(steps) {
  const total = steps.reduce((sum, s) => sum + (typeof s.deduction === 'number' ? s.deduction : 0), 0);
  const score = 100 - total;
  const parts = steps
    .filter(s => typeof s.deduction === 'number' && s.deduction > 0)
    .map(s => `${s.deduction} (${s.name}${s.overridden ? '*' : ''})`);
  const calculation = parts.length
    ? `100 - ${parts.join(' - ')} = ${score}${steps.some(s => s.overridden) ? ' (*manually adjusted)' : ''}`
    : `100 = ${score}`;
  return { score, calculation };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// SSE stream
app.get('/api/status/:callId', (req, res) => {
  const callId = parseInt(req.params.callId);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  if (!sseClients.has(callId)) sseClients.set(callId, new Set());
  sseClients.get(callId).add(res);

  const call = db.getCall(callId);
  if (call) {
    if (call.status === 'complete') {
      res.write(`event: complete\ndata: ${JSON.stringify({ callId, score: call.score })}\n\n`);
    } else if (call.status === 'error') {
      res.write(`event: error\ndata: ${JSON.stringify({ message: call.error || 'Processing failed' })}\n\n`);
    }
  }

  req.on('close', () => {
    const clients = sseClients.get(callId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) sseClients.delete(callId);
    }
  });
});

// Upload and process a call
app.post('/api/upload', upload.single('audio'), async (req, res) => {
  const { rep_name, disposition } = req.body;
  if (!req.file) return res.status(400).json({ error: 'No audio file provided' });
  if (!rep_name || !disposition) return res.status(400).json({ error: 'Missing rep_name or disposition' });

  const callId = db.insertCall(rep_name.trim(), disposition);
  res.json({ callId });
  processCall(callId, req.file.path, disposition);
});

// Get all calls
app.get('/api/calls', (req, res) => {
  const calls = db.getAllCalls().map(c => ({
    id: c.id,
    rep_name: c.rep_name,
    disposition: c.disposition,
    created_at: c.created_at,
    score: c.score,
    status: c.status
  }));
  res.json(calls);
});

// Get single call
app.get('/api/calls/:id', (req, res) => {
  const call = db.getCall(parseInt(req.params.id));
  if (!call) return res.status(404).json({ error: 'Not found' });
  res.json(call);
});

// Override a step on a scored call
app.patch('/api/calls/:id', (req, res) => {
  const call = db.getCall(parseInt(req.params.id));
  if (!call) return res.status(404).json({ error: 'Not found' });
  if (!call.scorecard) return res.status(400).json({ error: 'No scorecard to override' });

  const { stepIndex, deduction, status, override_note } = req.body;
  if (stepIndex === undefined || deduction === undefined || !status) {
    return res.status(400).json({ error: 'stepIndex, deduction, and status are required' });
  }

  const sc = typeof call.scorecard === 'string' ? JSON.parse(call.scorecard) : call.scorecard;
  const step = sc.steps[stepIndex];
  if (!step) return res.status(400).json({ error: 'Invalid stepIndex' });

  // Preserve original values on first override
  if (!step.overridden) {
    step.original_deduction = step.deduction;
    step.original_status = step.status;
  }

  step.deduction = deduction;
  step.status = status;
  step.override_note = override_note || '';
  step.overridden = true;

  const { score, calculation } = recalcScore(sc.steps);
  sc.score = score;
  sc.calculation = calculation;
  sc.has_overrides = true;

  db.updateCall(call.id, { score, scorecard: sc });
  res.json({ score, calculation, step });
});

// Get rubric
app.get('/api/rubric', (req, res) => {
  const rubric = loadRubric();
  const defaultRubric = fs.existsSync(DEFAULT_RUBRIC_FILE)
    ? fs.readFileSync(DEFAULT_RUBRIC_FILE, 'utf8')
    : rubric;
  res.json({ rubric, isDefault: rubric === defaultRubric });
});

// Save rubric
app.post('/api/rubric', (req, res) => {
  const { rubric } = req.body;
  if (!rubric || typeof rubric !== 'string') return res.status(400).json({ error: 'rubric text required' });
  fs.writeFileSync(RUBRIC_FILE, rubric, 'utf8');
  res.json({ ok: true });
});

// Reset rubric to default
app.post('/api/rubric/reset', (req, res) => {
  if (!fs.existsSync(DEFAULT_RUBRIC_FILE)) return res.status(404).json({ error: 'No default found' });
  fs.copyFileSync(DEFAULT_RUBRIC_FILE, RUBRIC_FILE);
  res.json({ ok: true, rubric: fs.readFileSync(DEFAULT_RUBRIC_FILE, 'utf8') });
});

app.listen(PORT, () => {
  console.log(`Pest Control Scorer running at http://localhost:${PORT}`);
});
