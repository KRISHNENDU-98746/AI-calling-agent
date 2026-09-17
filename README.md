# AI Appointment Agent

Inbound AI phone receptionist for clinics. Patients call your Twilio number; the Render-hosted Node.js backend answers, talks with Sarvam STT/TTS, books an appointment **request** in Firestore, and never calls the doctor.

```
Patient → Twilio number → POST /voice (TwiML) → WebSocket /media-stream
        → Sarvam realtime STT → LLM → Sarvam TTS → Patient
        → Firestore appointments (status: requested)
```

## Project structure

```
├── backend/                 # Deploy this folder on Render
│   ├── src/
│   │   ├── server.js
│   │   ├── config/
│   │   ├── routes/
│   │   ├── services/
│   │   └── websocket/
│   ├── package.json
│   ├── .env.example
│   └── .gitignore
├── frontend/                # Placeholder for a future dashboard
└── README.md
```

## Prerequisites

- Node.js 18+
- Twilio account + voice-enabled phone number
- Sarvam AI API key
- OpenAI-compatible LLM API key (OpenAI, Groq, Azure OpenAI, etc.)
- Firebase project with Firestore enabled + service account

## 1. Install

```bash
cd backend
npm install
```

## 2. Create `.env`

```bash
copy .env.example .env
```

On macOS/Linux:

```bash
cp .env.example .env
```

## 3. Configure credentials

Edit `backend/.env`:

| Variable | Required for live calls | Purpose |
|---|---|---|
| `PORT` | No (default 3000) | HTTP port. Render sets this automatically. |
| `PUBLIC_BASE_URL` | Yes on Render | Public HTTPS URL, e.g. `https://your-service.onrender.com` |
| `TWILIO_ACCOUNT_SID` | Yes | Twilio Account SID |
| `TWILIO_AUTH_TOKEN` | Yes | Twilio Auth Token |
| `TWILIO_PHONE_NUMBER` | Recommended | Your Twilio AI receptionist number |
| `TWILIO_VALIDATE_REQUESTS` | No | Set `true` in production to verify Twilio signatures |
| `SARVAM_API_KEY` | Yes | Sarvam API subscription key |
| `SARVAM_STT_LANGUAGE` | No | Default `auto` |
| `SARVAM_STT_MODE` | No | Default `codemix` (Bengali/Hindi/English mix) |
| `SARVAM_TTS_LANGUAGE` | No | Default `en-IN` (greeting language) |
| `SARVAM_TTS_SPEAKER` | No | Default `shubh` |
| `SARVAM_TTS_MODEL` | No | Default `bulbul:v3` |
| `AI_API_KEY` | Yes | LLM provider API key |
| `AI_BASE_URL` | Yes | OpenAI-compatible base URL, e.g. `https://api.openai.com/v1` |
| `AI_MODEL` | Yes | Model name, e.g. `gpt-4o-mini` |
| `FIREBASE_PROJECT_ID` | Yes | Firebase project id |
| `FIREBASE_CLIENT_EMAIL` | Yes | Service account email |
| `FIREBASE_PRIVATE_KEY` | Yes | Service account private key (`\n` escaped newlines are handled) |
| `CLINIC_NAME` | No | Spoken clinic name |
| `ALLOWED_DOCTORS` | No | Comma-separated doctor names |

### Firebase private key tip

In `.env`, keep the key on one line with escaped newlines:

```env
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n"
```

## 4. Start locally

```bash
cd backend
npm start
```

## 5. Test health

```bash
curl http://localhost:3000/health
```

Expected:

```json
{
  "status": "ok",
  "service": "ai-appointment-agent"
}
```

Run automated checks:

```bash
cd backend
npm test
```

## 6. Configure Twilio webhook

1. Buy/use a Twilio Voice phone number.
2. Open that number’s **Voice Configuration**.
3. Set the **A CALL COMES IN** webhook to:

```text
https://YOUR-RENDER-DOMAIN/voice
```

Example:

```text
https://ai-appointment-agent.onrender.com/voice
```

4. Method: **HTTP POST**
5. Save.

Local development needs a public tunnel (for example ngrok / Cloudflare Tunnel) pointed at your local port, then use that HTTPS URL as the webhook:

```text
https://YOUR-TUNNEL-DOMAIN/voice
```

Also set:

```env
PUBLIC_BASE_URL=https://YOUR-TUNNEL-DOMAIN
```

so the Media Stream WebSocket URL becomes `wss://YOUR-TUNNEL-DOMAIN/media-stream`.

## 7. Test an inbound phone call

1. Deploy or expose the backend publicly.
2. Confirm `GET /health` returns 200.
3. Confirm Twilio voice webhook points to `POST /voice`.
4. Call your Twilio number from a mobile phone.
5. The AI should greet you and collect name / doctor / date / time.
6. Check Firestore collection `appointments` for a new document with `status: "requested"` and `source: "ai_voice_agent"`.

## Render settings

| Setting | Value |
|---|---|
| Root Directory | `backend` |
| Runtime | Node |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Instance | Web Service |

Add all `.env` variables in the Render Environment dashboard.

Set:

```env
PUBLIC_BASE_URL=https://YOUR-SERVICE.onrender.com
NODE_ENV=production
```

Render provides `PORT` automatically. Do not hardcode it.

## Appointment data (Firestore)

Collection: `appointments`

```text
appointmentId
  patientName
  phoneNumber
  doctorName
  preferredDate
  preferredTime
  status          # "requested"
  language
  createdAt
  source          # "ai_voice_agent"
  conversationId
  callSid
```

This MVP stores a **booking request**, not a clinic-confirmed appointment.

## Safety behavior

The agent will not diagnose, prescribe, or give medical advice. For emergencies it directs the caller to emergency services.

## MVP limitations

- No clinic calendar sync / slot availability checks
- No doctor outbound calling
- No SMS confirmation
- No human handoff / transfer
- TTS greeting starts in the configured default language, then follows the caller
- Requires valid Sarvam + LLM + Firebase credentials for a real call
- Twilio Media Streams need a stable public WSS endpoint (Render or tunnel)

## What you still need for the first real call

1. Fill every required env var above
2. Enable Firestore in Firebase
3. Deploy to Render (or use a tunnel locally)
4. Set Twilio voice webhook to `https://YOUR-DOMAIN/voice` (POST)
5. Call the Twilio number
