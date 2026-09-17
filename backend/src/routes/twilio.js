const express = require('express');
const twilio = require('twilio');
const { env, getPublicBaseUrl, toWebSocketBaseUrl } = require('../config/env');

const router = express.Router();
const { VoiceResponse } = twilio.twiml;

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

module.exports = router;
