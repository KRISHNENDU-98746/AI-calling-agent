# S. N. Tripathi Clinic Voice Agent

## Project goal

Twilio voice appointment agent with ElevenLabs realtime STT/TTS and a small clinic admin dashboard.

## Repository layout

- `backend/` — Node.js/Express API, Twilio/Exotel/Edesy WebSockets, ElevenLabs Scribe STT/TTS, Groq turn logic, Firebase/Firestore.
- `frontend/` — static dashboard deployed on Vercel.
- `videosdk-agent/` — separate user work; do not modify or stage unless explicitly requested.
- `.venv/` — local environment; never stage.

## Live services

- Dashboard: `https://frontend-omega-sable-33.vercel.app`
- Backend: `https://doctor-34h2.onrender.com`
- Dedicated audio host: `https://clinic-voice-audio.vercel.app`
- Git remote: configured GitHub repository; push only when the user asks.

## Live call flow

`Twilio/Exotel/Edesy audio → ElevenLabs Scribe STT → call session transcript → agent logic → ElevenLabs TTS → caller`

The live audio path must stay fast. Do not add post-call LLM work to the live turn.

### Twilio outbound call path

`Dashboard /make-call → Twilio → /voice (GET or POST) → greeting MP3 → /media-stream → ElevenLabs Scribe STT → agent → ElevenLabs TTS`

- Outbound calls use the backend `/voice` webhook, not inline TwiML.
- `/voice` must accept both GET and POST because Twilio configurations can use either method.
- The webhook returns `text/xml` and opens `wss://doctor-34h2.onrender.com/media-stream`.
- Dedicated audio files are served from `https://clinic-voice-audio.vercel.app/audio/`.
- If the clinic is closed and `testMode` is false, play `clinic-closed.mp3` and hang up; do not open STT.
- If `testMode` is true, the agent remains available outside clinic hours for testing.
- When STT is connecting, buffer the first few seconds of Twilio audio so the caller's name is not lost.

## Post-call flow

`callSessions/{callId} → postCallJobs/{callId} → Firestore worker → Groq JSON extraction → validation/normalization → postCallRecords/{callId}`

- Implemented in `backend/src/services/callSession.js`, `postCallExtraction.js`, and `postCallWorker.js`.
- Invalid/incomplete extraction becomes `needs_review`; never coerce missing date/time or write a bad appointment.
- `callId` is the idempotency key. Do not create random duplicate post-call jobs.
- Firestore collections are created automatically; no SQL migration is needed.

## Important backend files

- `backend/src/websocket/mediaStream.js` — Twilio live media stream.
- `backend/src/websocket/exotelMediaStream.js` — Exotel stream.
- `backend/src/websocket/edesyMediaStream.js` — Edesy stream.
- `backend/src/services/groq.js` — live structured turn generation and intent hint.
- `backend/src/services/conversation.js` — deterministic conversation fallback.
- `backend/src/services/elevenlabsStt.js` — realtime Scribe v2 STT over WebSocket.
- `backend/src/services/elevenlabs.js` — live TTS; returns raw `ulaw_8000` audio for telephony.
- `backend/src/services/appointment.js` — Firestore appointment writes.
- `backend/src/services/clinicConfig.js` — clinic/doctor/hours/test-mode config.
- `backend/src/routes/admin.js` — dashboard config and appointment APIs.
- `backend/src/routes/twilio.js` — outbound `/make-call`, GET/POST `/voice`, and Twilio media-stream TwiML.

## Product rules

- Fixed doctor: `S. N. Tripathi`.
- Opening greeting: `নমস্কার, আমি S. N. Tripathi-র clinic থেকে বলছি। আমি আপনাকে appointment লিখতে সাহায্য করব। আপনার নামটা বলবেন?`
- Clinic status, doctor availability, hours, holidays, token limits, and appointment configuration are deterministic database/config values; do not ask an LLM for them.
- The assistant must not provide medical advice.
- Appointment is saved only after explicit confirmation and complete required fields.

## Frontend rules

- `frontend/app.js` uses India timezone (`Asia/Kolkata`) for clinic schedule rendering.
- Do not hardcode schedule slider position or time labels; derive them from `/admin/dashboard` config.
- Fixed audio can later live under `frontend/public/audio/` and be served by Vercel. Cloudflare R2 is optional, not required yet.
- Current audio files are deployed separately in the `clinic-voice-audio` Vercel project; keep dashboard hosting separate from Twilio audio hosting.
- The dashboard has a `Test mode` toggle. It writes `testMode: true` to `clinic/config` through `/admin/config`.

## Environment variables

Keep secrets only in Render/Vercel environment settings or local `.env`; never commit them.

Required live-call variables include `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, Firebase credentials, and Groq credentials. Sarvam is not used in the live call path. Post-call settings:

```env
POST_CALL_PROCESSOR_ENABLED=true
POST_CALL_POLL_MS=3000
```

Audio hosting:

```env
VOICE_AUDIO_BASE_URL=https://clinic-voice-audio.vercel.app
```

See `backend/.env.example` for the non-secret list.

## Verification and deployment

- Backend syntax check: run `node --check` on changed JS files.
- Live smoke checks before a call:
  - `GET https://doctor-34h2.onrender.com/health` returns 200.
  - `GET` and `POST https://doctor-34h2.onrender.com/voice` return 200 XML.
  - `/voice` XML contains `https://clinic-voice-audio.vercel.app/audio/greeting.mp3` and `wss://doctor-34h2.onrender.com/media-stream`.
  - Dedicated MP3 URLs return 200 with `audio/mpeg`.
  - For after-hours testing, confirm `/admin/dashboard` reports `testMode: true`.
- Backend tests: `cd backend; npm test` (Windows sandbox may block child-process spawning with `EPERM`; report that clearly).
- Frontend deploy: `cd frontend; npx vercel --prod --yes` when the user requests deployment.
- Backend deploy: commit only scoped files, then `git push origin main` when the user requests GitHub push.
- Preserve unrelated changes in `videosdk-agent/agent.py` and `.venv/`.

