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

// SSE clients: Map<callId, Set<res>>
const sseClients = new Map();

function sendSSE(callId, event, data) {
  const clients = sseClients.get(callId);
  if (!clients) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach(res => {
    try { res.write(payload); } catch {}
  });
}

function buildScoringPrompt(transcript, disposition) {
  return `You are a quality assurance assistant for a pest control sales team. Score the following call transcript using the rubric below. The call disposition is: ${disposition}.

SCORING RULES:
All reps start at 100 points. Deduct points only where steps are missed.

STEP 1 — Intro (max deduction: 10 pts)
The rep must ask or confirm all 5 of the following. If the customer volunteers the information unprompted, no deduction for that question. Deduct 2 points per missed question:
- Zip code / city / location
- What pests they are dealing with
- What type of property it is and whether they are the homeowner / decision maker (combined — counts as one question)
- Whether they have had pest control before
- Whether they want to get this done ASAP

STEP 2 — Service description (max deduction: 10 pts)
Rep must address caller's primary pest concern and give a brief overview of other service aspects. All or nothing.

STEP 3 — Price (max deduction: 10 pts)
Rep must start at or above $49 for initial visit and $138 per visit for ongoing service. Monthly billing is acceptable (e.g. $69/month for bimonthly). Deduct 10 if below minimums. EXCEPTION: no deduction if customer mentions existing competitor service, requests a price match, or has a competing quote.

STEP 4 — First close (max deduction: 10 pts)
After pitching price, rep must attempt an option close before waiting for customer acknowledgement. E.g. "Does today or tomorrow work better?" If skipped, deduct 10.

STEP 5 — Multiyear contract (max deduction: 10 pts)
Rep should start at 24-month contract. Deduct 0 for 24mo, 5 for 18mo, 10 for 12mo. If contract length not mentioned, mark N/A — no deduction. On follow-up calls, only scored if contract length is discussed.

STEP 6 — RACs (max deduction: 10 pts)
Rep must make at least 3 attempts to overcome objections or make offers. Any 3 attempts count as a pass. Fewer than 3 = deduct 10.

CLOSED CALLS ONLY:
STEP 7 — Went over contract (max deduction: 21 pts)
This step is strictly all or nothing. The rep must clearly communicate all four of the following elements during the contract review portion of the call: price, billing frequency, contract length, and cancellation fee. If any single element is missing from the contract review, deduct the full 21 points. There is no partial credit under any circumstances.
Important: credit is only given for what the rep communicates during the contract review itself. Do not give credit for any element that was only mentioned earlier in the call (e.g. during the pitch or objection handling). The rep must cover all four as part of going over the contract.
The four elements do not need to be stated in a formal or structured way. As long as each element is clearly communicated to the customer during the contract review, it counts. For example: saying "$75 every 2 months" covers both price and billing frequency in a single phrase. Saying "we warranty the home for 12 months" counts as contract length. Multiple elements can be conveyed together conversationally — do not deduct points if the information is present but delivered informally rather than as a checklist.
For the cancellation fee: the rep does not need to state a specific dollar amount. Explaining it as "reimbursing the initial discount," "paying back the discount on the first visit," or any similar description of the concept is acceptable. A specific dollar amount is also fine if given.

STEP 8 — Payment resolved (max deduction: 10 pts)
Rep must obtain payment method or clear plan for payment before hanging up. If not resolved, deduct 10.

Respond ONLY with a valid JSON object with this structure:
{
  "score": <number>,
  "calculation": "<string showing math>",
  "steps": [
    {"name": "Intro", "deduction": <number>, "note": "<explanation>", "status": "<pass|fail|partial|na>"},
    {"name": "Service description", "deduction": <number>, "note": "<explanation>", "status": "<pass|fail|partial|na>"},
    {"name": "Price", "deduction": <number>, "note": "<explanation>", "status": "<pass|fail|partial|na>"},
    {"name": "First close", "deduction": <number>, "note": "<explanation>", "status": "<pass|fail|partial|na>"},
    {"name": "Multiyear contract", "deduction": <number>, "note": "<explanation or N/A>", "status": "<pass|fail|partial|na>"},
    {"name": "RACs", "deduction": <number>, "note": "<explanation>", "status": "<pass|fail|partial|na>"},
    {"name": "Went over contract", "deduction": <number>, "note": "<explanation or CLOSED ONLY>", "status": "<pass|fail|partial|na>"},
    {"name": "Payment resolved", "deduction": <number>, "note": "<explanation or CLOSED ONLY>", "status": "<pass|fail|partial|na>"}
  ],
  "summary": "<2-3 sentence call summary>",
  "compliance_note": "<most important missed compliance step or Fully compliant>",
  "quality_note": "<one coaching note on call quality>"
}

TRANSCRIPT:
${transcript}`;
}

async function processCall(callId, filePath, disposition) {
  try {
    // Step 1: Upload to AssemblyAI
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

    // Step 2: Request transcription
    sendSSE(callId, 'status', { step: 'transcribing', message: 'Transcribing audio... this may take a minute.' });

    const transcriptRes = await axios.post('https://api.assemblyai.com/v2/transcript', {
      audio_url: audioUrl,
      speaker_labels: true
    }, {
      headers: { authorization: ASSEMBLYAI_API_KEY }
    });
    const transcriptId = transcriptRes.data.id;

    // Step 3: Poll for completion
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

    db.updateCall(callId, { transcript, status: 'scoring' });

    // Step 4: Score with Claude
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

// ─── Routes ──────────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// SSE stream for a call
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

// Get all calls for dashboard
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

// Get single call with full scorecard
app.get('/api/calls/:id', (req, res) => {
  const call = db.getCall(parseInt(req.params.id));
  if (!call) return res.status(404).json({ error: 'Not found' });
  res.json(call);
});

app.listen(PORT, () => {
  console.log(`Pest Control Scorer running at http://localhost:${PORT}`);
});
