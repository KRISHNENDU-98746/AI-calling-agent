const express = require('express');
const { env } = require('../config/env');
const { hasFirebaseCredentials } = require('../config/firebase');

const router = express.Router();

function sendHealth(_req, res) {
  res.status(200).json({
    status: 'ok',
    service: 'ai-appointment-agent',
    endpoints: {
      voice: '/voice',
      mediaStream: '/media-stream',
      exotel: '/exotel',
      exotelMediaStream: '/exotel-media-stream',
    },
    config: {
      publicBaseUrlSet: Boolean(env.publicBaseUrl),
      sarvamConfigured: Boolean(env.sarvam.apiKey),
      elevenlabsConfigured: Boolean(env.elevenlabs.apiKey && env.elevenlabs.voiceId),
      firebaseConfigured: hasFirebaseCredentials(),
      exotelPhoneConfigured: Boolean(env.exotel.phoneNumber),
      twilioConfigured: Boolean(env.twilio.accountSid && env.twilio.authToken),
      exotelSampleRate: env.exotel.sampleRate || 8000,
    },
  });
}

router.get('/health', sendHealth);
router.get('/health/', sendHealth);
router.head('/health', (_req, res) => {
  res.status(200).end();
});

module.exports = router;
