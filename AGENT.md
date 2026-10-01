# S. N. Tripathi Clinic Voice Agent

## Project goal

Twilio voice appointment agent with ElevenLabs TTS, Sarvam realtime STT, and a small clinic admin dashboard.

## Repository layout

- `backend/` — Node.js/Express API, Twilio/Exotel/Edesy WebSockets, Sarvam STT, ElevenLabs TTS, Groq turn logic, Firebase/Firestore.
- `frontend/` — static dashboard deployed on Vercel.
- `videosdk-agent/` — separate user work; do not modify or stage unless explicitly requested.
- `.venv/` — local environment; never stage.

## Live services

- Dashboard: `https://frontend-omega-sable-33.vercel.app`
- Backend: `https://doctor-34h2.onrender.com`
- Git remote: configured GitHub repository; push only when the user asks.

## Live call flow

`Twilio/Exotel/Edesy audio → Sarvam STT → call session transcript → agent logic → ElevenLabs TTS → caller`

The live audio path must stay fast. Do not add post-call LLM work to the live turn.

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
- `backend/src/services/sarvam.js` — realtime STT.
- `backend/src/services/elevenlabs.js` — live TTS; returns raw `ulaw_8000` audio for telephony.
- `backend/src/services/appointment.js` — Firestore appointment writes.
- `backend/src/services/clinicConfig.js` — clinic/doctor/hours/test-mode config.
- `backend/src/routes/admin.js` — dashboard config and appointment APIs.

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

## Environment variables

Keep secrets only in Render/Vercel environment settings or local `.env`; never commit them.

Required live-call variables include `SARVAM_API_KEY` (STT), `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, Firebase credentials, and Groq credentials. Post-call settings:

```env
POST_CALL_PROCESSOR_ENABLED=true
POST_CALL_POLL_MS=3000
```

See `backend/.env.example` for the non-secret list.

## Verification and deployment

- Backend syntax check: run `node --check` on changed JS files.
- Backend tests: `cd backend; npm test` (Windows sandbox may block child-process spawning with `EPERM`; report that clearly).
- Frontend deploy: `cd frontend; npx vercel --prod --yes` when the user requests deployment.
- Backend deploy: commit only scoped files, then `git push origin main` when the user requests GitHub push.
- Preserve unrelated changes in `videosdk-agent/agent.py` and `.venv/`.

