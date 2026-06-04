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

const RUBRIC_JSON_FILE = path.join(__dirname, 'rubric.json');

function loadRubricJson() {
  if (fs.existsSync(RUBRIC_JSON_FILE)) {
    return JSON.parse(fs.readFileSync(RUBRIC_JSON_FILE, 'utf8'));
  }
  return { steps: [] };
}

function saveRubricJson(data) {
  fs.writeFileSync(RUBRIC_JSON_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function buildScoringPrompt(transcript, disposition) {
  const rubric = loadRubricJson();
  const stepBlocks = rubric.steps
    .map(s => `${s.header}\n${s.rules}`)
    .join('\n\n');

  return [
    `You are a quality assurance assistant for a pest control sales team. Score the following call transcript using the rubric below. The call disposition is: ${disposition}.`,
    '',
    'SCORING RULES:',
    'All reps start at 100 points. Deduct points only where steps are missed.',
    '',
    stepBlocks,
    '',
    'SCORE CALCULATION:',
    'After identifying all deductions, calculate the final score as exactly 100 minus the sum of all deductions. Do not round, estimate, or approximate. The score field must equal exactly 100 minus the total deductions — if the math shows 66, the score is 66, not 67 or 68. Show the full math in the calculation field in this format: "100 - [deduction 1] - [deduction 2] ... = [final score]". The number at the end of the calculation string must match the score field exactly.',
    '',
    'Respond ONLY with a valid JSON object with this structure:',
    '{',
    '  "score": <number>,',
    '  "calculation": "<string showing math>",',
    '  "steps": [',
    '    {"name": "Intro", "deduction": <number>, "note": "<explanation>", "status": "<pass|fail|partial|na>"},',
    '    {"name": "Service description", "deduction": <number>, "note": "<explanation>", "status": "<pass|fail|partial|na>"},',
    '    {"name": "Price", "deduction": <number>, "note": "<explanation>", "status": "<pass|fail|partial|na>"},',
    '    {"name": "First close", "deduction": <number>, "note": "<explanation>", "status": "<pass|fail|partial|na>"},',
    '    {"name": "Multiyear contract", "deduction": <number>, "note": "<explanation or N/A>", "status": "<pass|fail|partial|na>"},',
    '    {"name": "RACs", "deduction": <number>, "note": "<explanation>", "status": "<pass|fail|partial|na>"},',
    '    {"name": "Went over contract", "deduction": <number>, "note": "<explanation or CLOSED ONLY>", "status": "<pass|fail|partial|na>"},',
    '    {"name": "Payment resolved", "deduction": <number>, "note": "<explanation or CLOSED ONLY>", "status": "<pass|fail|partial|na>"}',
    '  ],',
    '  "summary": "<2-3 sentence call summary>",',
    '  "compliance_note": "<most important missed compliance step or Fully compliant>",',
    '  "quality_note": "<one coaching note on call quality>"',
    '}',
    '',
    'TRANSCRIPT:',
    transcript
  ].join('\n');
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

// Get all rubric steps
app.get('/api/rubric/steps', (req, res) => {
  const rubric = loadRubricJson();
  res.json(rubric.steps);
});

// Save a step's rules (adds current to history)
app.patch('/api/rubric/steps/:id', (req, res) => {
  const { rules } = req.body;
  if (!rules || typeof rules !== 'string') return res.status(400).json({ error: 'rules text required' });

  const rubric = loadRubricJson();
  const step = rubric.steps.find(s => s.id === req.params.id);
  if (!step) return res.status(404).json({ error: 'Step not found' });

  step.history = [
    { rules: step.rules, savedAt: new Date().toISOString() },
    ...(step.history || [])
  ].slice(0, 10);

  step.rules = rules;
  saveRubricJson(rubric);
  res.json({ step });
});

// Ask Claude to propose a rewrite for a step
app.post('/api/rubric/steps/:id/propose', async (req, res) => {
  const { changeRequest } = req.body;
  if (!changeRequest) return res.status(400).json({ error: 'changeRequest required' });

  const rubric = loadRubricJson();
  const step = rubric.steps.find(s => s.id === req.params.id);
  if (!step) return res.status(404).json({ error: 'Step not found' });

  const prompt = `You are editing a specific step of a QA scoring rubric for pest control sales calls.

Step: "${step.name}"
Step header (do NOT include in your response): "${step.header}"

Current rules for this step:
---
${step.rules}
---

Manager's requested change: "${changeRequest}"

Rewrite the rules for this step to incorporate the requested change while preserving all other existing rules. Keep the same format, tone, and structure. Return ONLY the updated rules text — no step header, no explanation, plain text only.`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    });
    const proposed = message.content[0].text.trim();
    res.json({ proposed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Revert a step to a previous history version
app.post('/api/rubric/steps/:id/revert', (req, res) => {
  const { versionIndex } = req.body;
  if (versionIndex === undefined) return res.status(400).json({ error: 'versionIndex required' });

  const rubric = loadRubricJson();
  const step = rubric.steps.find(s => s.id === req.params.id);
  if (!step) return res.status(404).json({ error: 'Step not found' });
  if (!step.history || !step.history[versionIndex]) return res.status(400).json({ error: 'Invalid version' });

  const target = step.history[versionIndex];

  // Push current to history, remove the one being restored, set as current
  const newHistory = [
    { rules: step.rules, savedAt: new Date().toISOString() },
    ...step.history.filter((_, i) => i !== versionIndex)
  ].slice(0, 10);

  step.rules = target.rules;
  step.history = newHistory;
  saveRubricJson(rubric);
  res.json({ step });
});

app.listen(PORT, () => {
  console.log(`Pest Control Scorer running at http://localhost:${PORT}`);
});
