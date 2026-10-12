# 🎙️ AI Clinic Voice Receptionist (Doctor Appointment Agent)

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-4.21-blue.svg)](https://expressjs.com/)
[![Twilio](https://img.shields.io/badge/Telephony-Twilio-red.svg)](https://www.twilio.com/)
[![ElevenLabs](https://img.shields.io/badge/Voice%20AI-ElevenLabs-black.svg)](https://elevenlabs.io/)
[![Groq](https://img.shields.io/badge/LLM-Groq-orange.svg)](https://groq.com/)
[![Firebase](https://img.shields.io/badge/Database-Firestore-amber.svg)](https://firebase.google.com/)

An intelligent, real-time inbound & outbound AI phone receptionist for doctor clinics. Patients call your phone number; the AI agent answers in Bengali/English, converses naturally, collects appointment details (Patient Name, Doctor, Date, Time Slot), confirms the appointment, and logs structured records directly into **Firebase Firestore**.

---

## 📑 Table of Contents

- [System Architecture](#-system-architecture)
- [Key Features](#-key-features)
- [Mandatory vs Optional APIs](#-mandatory-vs-optional-apis)
- [Repository Structure](#-repository-structure)
- [Prerequisites](#-prerequisites)
- [Quick Start Guide](#-quick-start-guide)
- [Environment Variables (.env)](#-environment-variables-env)
- [Telephony Webhook Setup](#-telephony-webhook-setup)
- [API Endpoints](#-api-endpoints)
- [Security & Production Best Practices](#-security--production-best-practices)

---

## 🏛️ System Architecture

```
                                 ┌────────────────────────┐
                                 │   Patient / Caller     │
                                 └───────────┬────────────┘
                                             │  Phone Call
                                             ▼
                                 ┌────────────────────────┐
                                 │   Twilio / Exotel      │
                                 └───────────┬────────────┘
                                             │
                       ┌─────────────────────┴─────────────────────┐
                       │ Webhook: POST /voice                      │ WebSocket: /media-stream
                       ▼                                           ▼
             ┌───────────────────┐                     ┌───────────────────────┐
             │ Node.js / Express │                     │ Real-time Audio Stream │
             │   Backend Server  │                     └───────────┬───────────┘
             └─────────┬─────────┘                                 │
                       │                                           ▼
                       │                               ┌───────────────────────┐
                       │                               │ ElevenLabs Scribe STT │
                       │                               │ (Speech-to-Text)      │
                       │                               └───────────┬───────────┘
                       │                                           │ Real-time transcript
                       │                                           ▼
                       │                               ┌───────────────────────┐
                       │                               │ Groq LLM Turn Engine  │
                       │                               │ (Intent & Dialogue)   │
                       │                               └───────────┬───────────┘
                       │                                           │ Natural Bengali/English
                       │                                           ▼
                       │                               ┌───────────────────────┐
                       │                               │ ElevenLabs TTS        │
                       │                               │ (mulaw 8kHz Telephony)│
                       │                               └───────────┬───────────┘
                       ▼                                           │ Audio response
             ┌───────────────────┐                                 ▼
             │ Firebase Firestore│◄─────────────────────── Caller Hears Voice
             │ (Appointments DB) │
             └───────────────────┘
```

---

## ✨ Key Features

- **Ultra-low Latency Voice Interaction**: Uses ElevenLabs real-time streaming STT & TTS over WebSockets.
- **Natural Language Understanding**: Powered by Groq's high-speed inference for fluid multi-turn clinic conversations.
- **Bengali & English Support**: Native phonetic handling and bilingual support tailored for Indian clinic environments.
- **Automated Appointment Extraction**: Post-call worker extracts verified patient details and creates structured Firestore documents.
- **Deterministic Scheduling Logic**: Strictly respects clinic hours, doctor availability, token limits, and holiday rules.
- **Multi-Telephony Ready**: Built-in support for Twilio, Exotel, and Edesy voice carriers.

---

## 🔑 Mandatory vs Optional APIs

To run this project successfully, you will need the following APIs.

### 🔴 Mandatory APIs (Required to Run Live Calls)

| # | Service / Provider | Purpose | Environment Variables |
|---|--------------------|---------|-----------------------|
| 1 | **Telephony Provider**<br>*(Twilio)* | Receives incoming phone calls, handles outgoing calls, and streams bidirectional caller audio over WebSockets (`/media-stream`). | `TWILIO_ACCOUNT_SID`<br>`TWILIO_AUTH_TOKEN`<br>`TWILIO_PHONE_NUMBER` |
| 2 | **Voice AI**<br>*(ElevenLabs)* | Provides real-time Speech-to-Text (**Scribe v2 Realtime**) and ultra-fast Bengali/English Text-to-Speech formatted for 8kHz telephony. | `ELEVENLABS_API_KEY`<br>`ELEVENLABS_VOICE_ID` |
| 3 | **LLM Engine**<br>*(Groq)* | Executes ultra-fast turn-by-turn conversation logic and performs post-call patient detail extraction into structured JSON. | `GROQ_API_KEY`<br>`GROQ_MODEL` |
| 4 | **Database**<br>*(Google Firebase Firestore)* | Stores appointment requests, call session states, doctor configurations, clinic schedules, and audit records. | `FIREBASE_PROJECT_ID`<br>`FIREBASE_CLIENT_EMAIL`<br>`FIREBASE_PRIVATE_KEY` |

> [!IMPORTANT]
> **Without the 4 APIs above, live phone calls cannot complete an appointment.** The backend validates these critical credentials on boot.

---

### 🟡 Optional / Fallback APIs

| Service | Purpose | Environment Variables |
|---------|---------|-----------------------|
| **Sarvam AI** | Alternative Indian AI voice provider. Used for fallback STT/TTS or testing with `bulbul:v3` and `saaras:v4`. | `SARVAM_API_KEY` |
| **OpenRouter (Whisper)** | OpenAI Whisper fallback specifically for transcribing complex Bengali names if needed. | `OPENROUTER_API_KEY`<br>`OPENROUTER_WHISPER_MODEL` |
| **Exotel / Edesy** | Alternative Indian telephony providers if not using Twilio. | `EXOTEL_SID`, `EXOTEL_API_KEY`, `EXOTEL_API_TOKEN` / `EDESY_API_KEY` |
| **Admin Secret** | Protects administrative management and simulation endpoints. | `ADMIN_API_KEY`, `INTERNAL_AGENT_SECRET` |

---

## 📂 Repository Structure

```
├── backend/
│   ├── src/
│   │   ├── config/              # Environment config and Firebase initialization
│   │   │   ├── env.js
│   │   │   └── firebase.js
│   │   ├── routes/              # Express HTTP route controllers
│   │   │   ├── admin.js         # Appointment & clinic config endpoints
│   │   │   ├── exotel.js        # Exotel telephony webhooks
│   │   │   ├── health.js        # /health monitoring check
│   │   │   ├── internal.js      # Internal worker & agent APIs
│   │   │   └── twilio.js        # Twilio /voice and /make-call routes
│   │   ├── services/            # Core business logic & integrations
│   │   │   ├── appointment.js   # Firestore appointment creator
│   │   │   ├── callSession.js   # Call session persistence
│   │   │   ├── clinicConfig.js  # Hours, doctor lists, test mode
│   │   │   ├── conversation.js  # Deterministic dialogue state machine
│   │   │   ├── elevenlabs.js    # ElevenLabs TTS streaming
│   │   │   ├── elevenlabsStt.js # ElevenLabs Scribe STT WebSocket
│   │   │   ├── groq.js          # Groq fast turn generator
│   │   │   ├── postCallExtraction.js # Post-call LLM extraction
│   │   │   ├── postCallWorker.js# Background queue worker
│   │   │   ├── sarvam.js        # Sarvam AI STT/TTS service
│   │   │   └── whisperStt.js    # OpenRouter Whisper fallback
│   │   ├── websocket/           # Telephony WebSocket media stream handlers
│   │   │   ├── edesyMediaStream.js
│   │   │   ├── exotelMediaStream.js
│   │   │   └── mediaStream.js   # Twilio media stream handler
│   │   └── server.js            # Main HTTP & WebSocket server entrypoint
│   ├── tests/                   # Automated backend test suite
│   ├── .env.example             # Environment template (no secrets)
│   ├── package.json
│   └── .gitignore
├── videosdk-agent/              # Standalone VideoSDK telephony worker (Python)
│   ├── agent.py
│   ├── requirements.txt
│   └── .env.example
├── .gitignore
├── AGENT.md                     # Internal architecture specifications
└── README.md                    # Project documentation
```

---

## ⚙️ Prerequisites

Ensure you have the following installed on your machine or server:

- **Node.js**: v18.0.0 or higher
- **npm**: v9.0.0 or higher
- **Twilio Account**: with an active phone number enabled for Voice
- **ElevenLabs Account**: with API access and a chosen Voice ID
- **Groq Cloud Account**: with an active API Key
- **Firebase Project**: with Cloud Firestore enabled and a Service Account key

---

## 🚀 Quick Start Guide

### 1. Clone & Install Dependencies

```bash
# Clone the repository
git clone <your-repository-url>
cd <repository-folder>

# Install backend dependencies
cd backend
npm install
```

### 2. Configure Environment Variables

Create your local `.env` file from `.env.example`:

```bash
# On Windows (PowerShell):
Copy-Item .env.example .env

# On macOS / Linux:
cp .env.example .env
```

Open `backend/.env` in your editor and fill in your actual API credentials (see table below).

### 3. Start the Server

```bash
# Development mode (auto-reload on changes)
npm run dev

# Production mode
npm start
```

Default server port is `3000`.

### 4. Verify Health

In another terminal, check if the server is healthy:

```bash
curl http://localhost:3000/health
```

Expected response:
```json
{
  "status": "ok",
  "service": "appointment-voice-agent",
  "env": {
    "ok": true,
    "missing": []
  }
}
```

---

## 🔐 Environment Variables (.env)

Below is the complete reference for `backend/.env`:

```ini
# Server Settings
PORT=3000
NODE_ENV=development
PUBLIC_BASE_URL=https://your-public-domain.com

# 1. Telephony (Twilio - MANDATORY)
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_PHONE_NUMBER=+1234567890
TWILIO_VALIDATE_REQUESTS=false

# 2. Voice AI (ElevenLabs - MANDATORY)
ELEVENLABS_API_KEY=your_elevenlabs_api_key
ELEVENLABS_VOICE_ID=your_voice_id_here
ELEVENLABS_MODEL=eleven_multilingual_v2
ELEVENLABS_STT_MODEL=scribe_v2_realtime
ELEVENLABS_STT_LANGUAGE=

# 3. LLM Engine (Groq - MANDATORY)
GROQ_API_KEY=gsk_your_groq_api_key
GROQ_MODEL=openai/gpt-oss-120b
POST_CALL_PROCESSOR_ENABLED=true
POST_CALL_POLL_MS=3000

# 4. Database (Firebase Firestore - MANDATORY)
FIREBASE_PROJECT_ID=your-firebase-project-id
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@your-project.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEv...YOUR_ESCAPED_KEY...\n-----END PRIVATE KEY-----\n"

# Clinic Configuration
CLINIC_NAME="S. N. Tripathi Clinic"
ALLOWED_DOCTORS="Dr. S. N. Tripathi"
VOICE_AUDIO_BASE_URL=https://clinic-voice-audio.vercel.app

# Optional / Fallback APIs
SARVAM_API_KEY=
OPENROUTER_API_KEY=
EXOTEL_SID=
EXOTEL_API_KEY=
EXOTEL_API_TOKEN=
ADMIN_API_KEY=
INTERNAL_AGENT_SECRET=
```

> [!TIP]
> **Firebase Private Key formatting**: Make sure newlines in `FIREBASE_PRIVATE_KEY` are escaped with `\n` and wrapped in quotation marks.

---

## 📞 Telephony Webhook Setup

### Twilio Configuration
1. Expose your local port via a tunnel (e.g. `ngrok http 3000`) or deploy to **Render / Railway / VPS**.
2. Go to the [Twilio Console](https://console.twilio.com/) → **Phone Numbers** → **Manage** → **Active Numbers**.
3. Under **Voice & Fax**:
   - **A CALL COMES IN**: Select `Webhook`
   - **URL**: `https://your-domain.com/voice`
   - **HTTP Method**: `HTTP POST` (or `HTTP GET`)
4. Save changes. When you dial your Twilio number, your server will answer and start the conversation!

---

## 📡 API Endpoints

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| `GET` | `/health` | Server and environment health check | No |
| `POST` / `GET` | `/voice` | Twilio inbound call webhook (returns TwiML) | Twilio / Public |
| `POST` | `/make-call` | Triggers an outbound call to a patient | No / Admin |
| `GET` | `/admin/dashboard` | Clinic status, appointments, and token metrics | `x-admin-api-key` |
| `GET` | `/admin/appointments` | Lists all booked appointments | `x-admin-api-key` |
| `PATCH` | `/admin/config` | Updates clinic settings (e.g. `testMode`, token limits) | `x-admin-api-key` |
| `POST` | `/admin/simulate` | Simulates an audio conversation turn for testing | `x-admin-api-key` |

---

## 🛡️ Security & Production Best Practices

1. **Never Commit Secrets**: Never push `.env` files or Firebase Service Account JSON files to Git. Both are included in `.gitignore`.
2. **Twilio Signature Verification**: In production, set `TWILIO_VALIDATE_REQUESTS=true` to reject unauthorized HTTP requests.
3. **Admin API Key**: Set `ADMIN_API_KEY` to secure administrative routes (`/admin/*`) from unauthorized access.
4. **WebSocket Security**: Keep media stream WebSocket connections secured under `wss://`.

---

## 📄 License

This project is licensed for clinic appointment voice operations. Unauthorized distribution is prohibited.
#   A I - c a l l i n g - a g e n t  
 