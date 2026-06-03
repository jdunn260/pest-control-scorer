# Pest Control Scorer

A full-stack web app for scoring pest control sales calls. Managers upload MP3 recordings, the app transcribes them via AssemblyAI and scores them against an 8-step QA rubric using Claude AI.

## Features

- **Drag & drop upload** — drop an MP3, enter the rep's name, select a disposition (Follow-Up or Closed)
- **Live status updates** — real-time progress as the call is uploaded, transcribed, and scored
- **Automatic scoring** — 8-step rubric covering intro questions, service description, pricing, closing technique, contract length, objection handling, contract review, and payment collection
- **Dashboard** — table of all scored calls with color-coded scores (green 80+, amber 60–79, red below 60)
- **Scorecard view** — full breakdown per step with pass/fail status, deductions, notes, and a coaching summary

## Stack

- **Backend:** Node.js + Express
- **Transcription:** AssemblyAI (with speaker diarization)
- **Scoring:** Anthropic Claude (claude-sonnet-4-6)
- **Storage:** JSON file (no database setup required)
- **Frontend:** Plain HTML/CSS/JS, dark theme

## Setup

1. **Clone the repo**
   ```bash
   git clone git@github.com:jdunn260/pest-control-scorer.git
   cd pest-control-scorer
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment variables**
   ```bash
   cp .env.example .env
   ```
   Then edit `.env` and add your API keys:
   ```
   ASSEMBLYAI_API_KEY=your_assemblyai_api_key
   ANTHROPIC_API_KEY=your_anthropic_api_key
   ```

4. **Start the app**
   ```bash
   npm start
   ```

5. Open [http://localhost:3000](http://localhost:3000)

## Scoring Rubric

| Step | Max Deduction | Notes |
|---|---|---|
| Intro | 10 pts | 5 qualifying questions, 2 pts each |
| Service description | 10 pts | Must address primary pest + overview |
| Price | 10 pts | Min $49 initial / $138 ongoing |
| First close | 10 pts | Option close required before waiting for response |
| Multiyear contract | 10 pts | Start at 24mo; 5pt deduction for 18mo, 10pt for 12mo |
| RACs | 10 pts | 3+ objection-handling attempts required |
| Went over contract *(Closed only)* | 21 pts | Must confirm price, billing, length, cancellation fee |
| Payment resolved *(Closed only)* | 10 pts | Payment method obtained before hanging up |
