const express = require('express');
const crypto = require('crypto');
const twilio = require('twilio');
const { env, getPublicBaseUrl, toWebSocketBaseUrl } = require('../config/env');

const router = express.Router();
const { VoiceResponse } = twilio.twiml;
const OUTBOUND_TEST_TWIML =
  '<Response><Say>Hello. This is a test call from the clinic appointment assistant.</Say></Response>';
let twilioClientFactory = (accountSid, authToken) => twilio(accountSid, authToken);

function authorizedForOutboundCall(req) {
  const provided = req.get('x-internal-agent-secret') || '';
  const expected = env.internalAgentSecret;

  if (!expected || provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

function isE164PhoneNumber(value) {
  return typeof value === 'string' && /^\+[1-9]\d{7,14}$/.test(value);
}

function redactSecrets(value) {
  if (value === undefined || value === null) return value;

  let safe = String(value);
  for (const secret of [env.twilio.authToken, env.twilio.accountSid]) {
    if (secret) safe = safe.split(secret).join('[REDACTED]');
  }
  return safe;
}

function logTwilioError(error) {
  console.error('[twilio] /make-call failed:', {
    name: redactSecrets(error?.name || 'Error'),
    message: redactSecrets(error?.message || 'Unknown Twilio error'),
    code: redactSecrets(error?.code),
    status: error?.status ?? error?.statusCode ?? null,
    moreInfo: redactSecrets(error?.moreInfo),
  });
}

function buildMediaStreamUrl(req) {
  const httpBase = getPublicBaseUrl(req);
  const wsBase = toWebSocketBaseUrl(httpBase);
  return `${wsBase}/media-stream`;
}

function maybeValidateTwilioSignature(req, res, next) {
  if (!env.twilio.validateRequests) {
    return next();
  }

  if (!env.twilio.authToken) {
    console.error('[twilio] TWILIO_VALIDATE_REQUESTS is true but TWILIO_AUTH_TOKEN is missing');
    return res.status(500).type('text/plain').send('Server misconfigured');
  }

  const signature = req.headers['x-twilio-signature'];
  if (!signature) {
    return res.status(403).type('text/plain').send('Forbidden');
  }

  let absoluteUrl;
  try {
    absoluteUrl = `${getPublicBaseUrl(req)}${req.originalUrl}`;
  } catch (error) {
    console.error('[twilio] Could not build URL for signature validation:', error.message);
    return res.status(500).type('text/plain').send('Server misconfigured');
  }

  const valid = twilio.validateRequest(
    env.twilio.authToken,
    signature,
    absoluteUrl,
    req.body || {}
  );

  if (!valid) {
    return res.status(403).type('text/plain').send('Forbidden');
  }

  return next();
}

/**
 * Inbound voice webhook.
 * Patient calls the Twilio number -> we answer and open a bidirectional Media Stream.
 * This does NOT place an outbound call to the doctor.
 */
router.post('/voice', maybeValidateTwilioSignature, (req, res) => {
  try {
    const callSid = req.body?.CallSid || 'unknown';
    const from = req.body?.From || 'unknown';

    console.log(`[twilio] Inbound call received callSid=${callSid} from=${from}`);

    const streamUrl = buildMediaStreamUrl(req);
    const twiml = new VoiceResponse();
    const connect = twiml.connect();
    const stream = connect.stream({
      url: streamUrl,
    });

    // Pass useful metadata into the WebSocket "start" event customParameters
    stream.parameter({ name: 'callSid', value: callSid });
    stream.parameter({ name: 'from', value: from });
    stream.parameter({ name: 'to', value: req.body?.To || env.twilio.phoneNumber || '' });

    res.type('text/xml').status(200).send(twiml.toString());
  } catch (error) {
    console.error('[twilio] /voice failed:', error.message);

    const twiml = new VoiceResponse();
    twiml.say(
      { language: 'en-IN', voice: 'Polly.Aditi' },
      'Sorry, I am having a technical problem right now. Please try again later.'
    );
    twiml.hangup();
    res.type('text/xml').status(200).send(twiml.toString());
  }
});

/**
 * Places an outbound call using the configured Twilio number.
 * This route is intended for trusted backend callers only.
 */
router.post('/make-call', async (req, res) => {
  console.log("make-call request body:", {
    bodyType: typeof req.body,
    body: req.body
  });

  if (!authorizedForOutboundCall(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { to } = req.body || {};
  if (!isE164PhoneNumber(to)) {
    return res.status(400).json({ error: 'to must be a valid E.164 phone number' });
  }

  const { accountSid, authToken, phoneNumber } = env.twilio;
  if (!accountSid || !authToken || !phoneNumber) {
    console.error('[twilio] /make-call failed: required Twilio environment variable is missing');
    return res.status(500).json({
      success: false,
      error: 'Unable to place call',
      code: 'TWILIO_CONFIG_MISSING',
    });
  }

  try {
    const client = twilioClientFactory(accountSid, authToken);
    const call = await client.calls.create({
      to,
      from: phoneNumber,
      twiml: OUTBOUND_TEST_TWIML,
    });

    return res.status(201).json({
      success: true,
      callSid: call.sid,
      status: call.status,
    });
  } catch (error) {
    logTwilioError(error);
    return res.status(500).json({
      success: false,
      error: 'Unable to place call',
      code: error?.code ? String(error.code) : null,
    });
  }
});

// Test-only injection point; production uses the Twilio SDK factory above.
router.setTwilioClientFactoryForTests = (factory) => {
  twilioClientFactory = factory;
};

module.exports = router;
