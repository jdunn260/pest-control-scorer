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
- Location: satisfied by any location information — zip code, city, street address, or any combination. If the customer provides or confirms their city or address, that is a pass even if no zip code was given. Only deduct 2 points if no location information whatsoever was provided or confirmed by either party.
- What pests they are dealing with
- Whether the customer is the homeowner or decision maker
- Whether they have had pest control before
- Timing / urgency: no deduction if (a) the rep explicitly asks if the customer wants service ASAP, (b) the rep assumes urgency and mentions getting it done as soon as possible, (c) the rep asks any question about timeline or scheduling, or (d) the customer volunteers any information about their timeline or urgency unprompted. Only deduct 2 points if the topic of timing or urgency is never addressed at all by either the rep or the customer.

STEP 2 — Service description (max deduction: 10 pts)
Rep must address caller's primary pest concern and give a brief overview of other service aspects. All or nothing.

STEP 3 — Price (max deduction: 10 pts)
INITIAL VISIT: Must be at least $49. Anything below $49 is a fail.
ONGOING SERVICE: The only acceptable recurring plans are:
- Monthly service at $138/month or higher
- Bimonthly service (every 2 months) at $138 per visit or higher — this may be presented as $69/month
Any other frequency — including quarterly, once every 3 months, or anything less frequent than bimonthly — is automatically a fail regardless of the price quoted. If the rep quotes quarterly or any service less frequent than bimonthly, deduct 10 points. Do not evaluate the price amount when the frequency alone makes it a fail.
EXCEPTION: No deduction if the customer mentions an existing competitor service, requests a price match, or has a competing quote.

STEP 4 — First close (max deduction: 10 pts)
After pitching price, rep must attempt an option close before waiting for customer acknowledgement. E.g. "Does today or tomorrow work better?" If skipped, deduct 10.

STEP 5 — Multiyear contract (max deduction: 10 pts)
Score based on the rep's opening offer only — not where they end up after negotiation. If the customer pushes back and the rep moves to a shorter term, do not deduct additional points.
- Rep opens with 24 months only: deduct 0
- Rep offers 24 months OR 18 months as options: deduct 5
- Rep offers 24 months OR 12 months as options: deduct 10
- Rep opens with 18 months only: deduct 5
- Rep offers 18 months OR 12 months as options: deduct 10
- Rep opens with 12 months only: deduct 10
For closed calls: contract length must be discussed. If it is never mentioned, deduct 10 — there is no N/A option for closed calls.
For follow-up calls: if contract length is not mentioned at all, mark as N/A with no deduction.

STEP 6 — RACs (max deduction: 10 pts)
If the call disposition is Closed, automatically award full points for this step — no deduction regardless of how many RAC attempts were made. A closed call is proof the rep successfully moved the customer through the sales process.
If the call disposition is Follow-Up, evaluate normally: rep must make at least 3 attempts to overcome objections or make offers. Any 3 attempts count as a pass. Fewer than 3 = deduct 10.

STEP 7 — Went over contract (max deduction: 21 pts, CLOSED CALLS ONLY)
THERE ARE ONLY THREE REQUIRED ELEMENTS. BILLING FREQUENCY IS NOT REQUIRED AND MUST NEVER BE USED AS A REASON TO DEDUCT POINTS.
The three elements are:

PRICE — any price mentioned during the contract review counts. Does not need to match the final agreed price exactly.
CONTRACT LENGTH — any mention of the duration or number of services counts.
CANCELLATION FEE — EITHER a specific dollar amount OR any mention anywhere on the call of reimbursing, paying back, or returning the initial discount or first visit discount. It does not need to be restated during the contract review if it was mentioned earlier on the call. Any reference to the initial discount being returned upon cancellation is a pass.
If all three are present anywhere on the call, award full points. If any one of the three is completely absent from the entire call, deduct 21 points. No partial credit. No exceptions.

STEP 8 — Payment resolved (max deduction: 10 pts)
This step is strictly pass or fail. No partial credit under any circumstances.
Pass (deduct 0): rep obtained a payment method or established a clear payment plan in any form. All of the following are a pass:
- Customer provides a card number over the phone
- Rep directs the customer to a billing station, payment portal, or online agreement and there is any indication the customer completed it — including the customer saying anything like "I think that went through," "done," "completed," or any similar confirmation
- Rep directs the customer to enter payment in a portal or document and there is no clear indication it failed — give the benefit of the doubt and award full points
- Any active payment collection attempt the customer is complying with
The rep does not need to verbally confirm the card type, card number, or explicitly state that payment was secured. If the customer was sent to a portal and nothing suggests it failed, it is a pass.
Fail (deduct 10): rep made no attempt to collect payment at all — either defaulted to having the technician collect it at the appointment, or payment was never discussed.
Do not deduct partial points for any reason on this step.

SCORE CALCULATION:
After identifying all deductions, calculate the final score as exactly 100 minus the sum of all deductions. Do not round, estimate, or approximate. The score field must equal exactly 100 minus the total deductions — if the math shows 66, the score is 66, not 67 or 68. Show the full math in the calculation field in this format: "100 - [deduction 1] - [deduction 2] ... = [final score]". The number at the end of the calculation string must match the score field exactly.

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

    // Redact credit card numbers (16 digits, with or without spaces/dashes between groups of 4)
    transcript = transcript.replace(/\b(\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4})\b/g, '[REDACTED]');

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
