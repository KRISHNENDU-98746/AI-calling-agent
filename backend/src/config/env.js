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

  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    phoneNumber: process.env.TWILIO_PHONE_NUMBER || '',
    validateRequests: toBool(process.env.TWILIO_VALIDATE_REQUESTS, false),
  },

  sarvam: {
    apiKey: process.env.SARVAM_API_KEY || '',
    baseUrl: 'https://api.sarvam.ai',
    sttLanguage: process.env.SARVAM_STT_LANGUAGE || 'auto',
    sttMode: process.env.SARVAM_STT_MODE || 'codemix',
    ttsLanguage: process.env.SARVAM_TTS_LANGUAGE || 'en-IN',
    ttsSpeaker: process.env.SARVAM_TTS_SPEAKER || 'shubh',
    ttsModel: process.env.SARVAM_TTS_MODEL || 'bulbul:v3',
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

const CRITICAL_FOR_CALLS = [
  ['TWILIO_ACCOUNT_SID', env.twilio.accountSid],
  ['TWILIO_AUTH_TOKEN', env.twilio.authToken],
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

  if (!env.publicBaseUrl && env.nodeEnv === 'production') {
    console.warn(
      '[env] PUBLIC_BASE_URL is not set. Twilio Media Streams will fall back to the request Host header.'
    );
  }

  return {
    ok: missing.length === 0,
    missing,
  };
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
  getPublicBaseUrl,
  toWebSocketBaseUrl,
};
