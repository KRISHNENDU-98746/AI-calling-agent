const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

function normalizePrivateKey(key) {
  if (!key) return '';
  let normalized = key.trim();
  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    normalized = normalized.slice(1, -1);
  }
  return normalized.replace(/\\n/g, '\n');
}

function parseCsv(value) {
  if (!value || typeof value !== 'string') return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function toBool(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 3000,
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
  voiceAudioBaseUrl: (process.env.VOICE_AUDIO_BASE_URL || 'https://clinic-voice-audio.vercel.app').replace(/\/$/, ''),
  internalAgentSecret: process.env.INTERNAL_AGENT_SECRET || '',
  adminApiKey: process.env.ADMIN_API_KEY || '',
  adminCorsOrigins: parseCsv(process.env.ADMIN_CORS_ORIGINS),

  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    phoneNumber: process.env.TWILIO_PHONE_NUMBER || '',
    validateRequests: toBool(process.env.TWILIO_VALIDATE_REQUESTS, false),
  },

  groq: {
    apiKey: process.env.GROQ_API_KEY || '',
    model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
    baseUrl: (process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, ''),
  },

  postCall: {
    enabled: !['0', 'false', 'no', 'off'].includes(String(process.env.POST_CALL_PROCESSOR_ENABLED || 'true').toLowerCase()),
    pollMs: Number(process.env.POST_CALL_POLL_MS) || 3000,
  },

  exotel: {
    sid: process.env.EXOTEL_SID || '',
    apiKey: process.env.EXOTEL_API_KEY || '',
    apiToken: process.env.EXOTEL_API_TOKEN || '',
    phoneNumber: process.env.EXOTEL_PHONE_NUMBER || '',
    sampleRate: Number(process.env.EXOTEL_SAMPLE_RATE) || 8000,
  },

  // Portal/API values for Edesy Voice Platform (inbound WS does not require these to accept audio).
  edesy: {
    accountSid: process.env.EDESY_ACCOUNT_SID || '',
    apiKey: process.env.EDESY_API_KEY || '',
    applicationSid: process.env.EDESY_APPLICATION_SID || '',
    fromNumber: process.env.EDESY_FROM_NUMBER || '',
    sampleRate: Number(process.env.EDESY_SAMPLE_RATE) || 16000,
  },

  sarvam: {
    apiKey: process.env.SARVAM_API_KEY || '',
    baseUrl: 'https://api.sarvam.ai',
    sttLanguage: process.env.SARVAM_STT_LANGUAGE || 'auto',
    sttMode: process.env.SARVAM_STT_MODE || 'codemix',
    ttsLanguage: process.env.SARVAM_TTS_LANGUAGE || 'bn-IN',
    ttsSpeaker: process.env.SARVAM_TTS_SPEAKER || 'shubh',
    ttsModel: process.env.SARVAM_TTS_MODEL || 'bulbul:v3',
  },

  elevenlabs: {
    apiKey: process.env.ELEVENLABS_API_KEY || '',
    voiceId: process.env.ELEVENLABS_VOICE_ID || '',
    model: process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2',
    baseUrl: (process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io').replace(/\/$/, ''),
  },

  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID || '',
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL || '',
    privateKey: normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY || ''),
  },

  clinic: {
    name: process.env.CLINIC_NAME || 'Clinic',
    doctors: parseCsv(process.env.ALLOWED_DOCTORS),
  },
};

// Shared requirements for Exotel and Twilio live call paths.
const CRITICAL_FOR_CALLS = [
  ['SARVAM_API_KEY', env.sarvam.apiKey],
  ['FIREBASE_PROJECT_ID', env.firebase.projectId],
  ['FIREBASE_CLIENT_EMAIL', env.firebase.clientEmail],
  ['FIREBASE_PRIVATE_KEY', env.firebase.privateKey],
];

/**
 * Validates environment configuration.
 * Soft mode (default): warn about missing call-critical vars so /health still works on Render.
 * Strict mode: throw if anything required for live calls is missing.
 */
function validateEnv({ strict = false } = {}) {
  const missing = CRITICAL_FOR_CALLS.filter(([, value]) => !value).map(([name]) => name);

  if (missing.length) {
    const message = `Missing environment variables required for live calls: ${missing.join(', ')}`;
    if (strict) {
      throw new Error(message);
    }
    console.warn(`[env] ${message}`);
  }

  const hasTwilio = Boolean(env.twilio.accountSid && env.twilio.authToken);
  if (!hasTwilio && env.nodeEnv === 'production') {
    console.warn(
      '[env] TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN not set. Twilio /voice will not authenticate live calls; Exotel path remains available.'
    );
  }
  if (!env.exotel.phoneNumber) {
    console.warn(
      '[env] EXOTEL_PHONE_NUMBER is not set (optional metadata only; Voicebot webhook still works).'
    );
  }

  if (!env.publicBaseUrl && env.nodeEnv === 'production') {
    console.warn(
      '[env] PUBLIC_BASE_URL is not set. Media Streams will fall back to the request Host header.'
    );
  }

  return {
    ok: missing.length === 0,
    missing,
    twilio: {
      accountSid: Boolean(env.twilio.accountSid),
      authToken: Boolean(env.twilio.authToken),
      phoneNumber: Boolean(env.twilio.phoneNumber),
    },
  };
}

function reportTwilioEnvStatus(status = {}) {
  const value = (name) => (status[name] ? 'PRESENT' : 'MISSING');
  console.log(
    `[env] Twilio configuration: TWILIO_ACCOUNT_SID=${value('accountSid')} ` +
      `TWILIO_AUTH_TOKEN=${value('authToken')} ` +
      `TWILIO_PHONE_NUMBER=${value('phoneNumber')}`
  );
}

function getPublicBaseUrl(req) {
  if (env.publicBaseUrl) return env.publicBaseUrl;

  const protoHeader = req?.headers?.['x-forwarded-proto'];
  const proto = (Array.isArray(protoHeader) ? protoHeader[0] : protoHeader || 'https')
    .split(',')[0]
    .trim();
  const host = req?.headers?.['x-forwarded-host'] || req?.headers?.host;

  if (!host) {
    throw new Error('Unable to determine public base URL. Set PUBLIC_BASE_URL.');
  }

  return `${proto}://${host}`;
}

function toWebSocketBaseUrl(httpBaseUrl) {
  return httpBaseUrl.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
}

module.exports = {
  env,
  validateEnv,
  reportTwilioEnvStatus,
  getPublicBaseUrl,
  toWebSocketBaseUrl,
};
