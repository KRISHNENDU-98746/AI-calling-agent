const express = require('express');
const { env, getPublicBaseUrl, toWebSocketBaseUrl } = require('../config/env');

const router = express.Router();

/**
 * Build the Exotel Voicebot WSS URL.
 * Docs: Voicebot dynamic HTTPS URL must return JSON { "url": "wss://..." }
 * Media format on that WSS is raw/slin PCM 16-bit LE @ sample-rate (default 8000).
 */
function buildExotelStreamUrl(req) {
  const httpBase = getPublicBaseUrl(req);
  const wsBase = toWebSocketBaseUrl(httpBase);
  const sampleRate = env.exotel.sampleRate || 8000;

  const params = new URLSearchParams({
    'sample-rate': String(sampleRate),
  });

  // Optional Basic Auth credentials embedded for Exotel to convert into Authorization header.
  // Docs: wss://<API_KEY>:<API_TOKEN>@host/path
  if (env.exotel.apiKey && env.exotel.apiToken) {
    const host = wsBase.replace(/^wss:\/\//i, '').replace(/^ws:\/\//i, '');
    const user = encodeURIComponent(env.exotel.apiKey);
    const pass = encodeURIComponent(env.exotel.apiToken);
    return `wss://${user}:${pass}@${host}/exotel-media-stream?${params.toString()}`;
  }

  return `${wsBase}/exotel-media-stream?${params.toString()}`;
}

function extractCallMeta(req) {
  const body = req.body || {};
  const query = req.query || {};

  return {
    callSid: body.CallSid || body.callSid || query.CallSid || query.call_sid || null,
    from: body.From || body.from || query.From || query.from || null,
    to: body.To || body.to || query.To || query.to || env.exotel.phoneNumber || null,
  };
}

/**
 * Exotel Voicebot dynamic URL resolver.
 * Accepts GET and POST (Exotel may use either depending on flow configuration).
 * Returns HTTP 200 + application/json: { "url": "wss://..." }
 */
function handleExotelWebhook(req, res) {
  try {
    const meta = extractCallMeta(req);
    console.log(
      `[EXOTEL] Incoming call received method=${req.method} callSid=${meta.callSid || 'unknown'} from=${
        meta.from || 'unknown'
      } to=${meta.to || 'unknown'}`
    );

    const streamUrl = buildExotelStreamUrl(req);
    // Never log embedded credentials if Basic Auth is present in the WSS URL.
    const safeStreamUrl = streamUrl.replace(/\/\/([^/@]+):([^/@]+)@/, '//***:***@');
    console.log(`[EXOTEL] Voicebot WSS URL resolved url=${safeStreamUrl}`);

    res.status(200).type('application/json').json({
      url: streamUrl,
    });
  } catch (error) {
    console.error('[EXOTEL] /exotel failed:', error.message);
    res.status(500).type('application/json').json({
      error: 'Failed to resolve Exotel media stream URL',
    });
  }
}

router.get('/exotel', handleExotelWebhook);
router.post('/exotel', handleExotelWebhook);

module.exports = router;
