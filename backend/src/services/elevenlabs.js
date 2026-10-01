const { env } = require('../config/env');

const FALLBACK_SPEECH =
  'Sorry, I am having a technical problem right now. Please try again later.';

function requireConfig() {
  const missing = [];
  if (!env.elevenlabs.apiKey) missing.push('ELEVENLABS_API_KEY');
  if (!env.elevenlabs.voiceId) missing.push('ELEVENLABS_VOICE_ID');
  if (missing.length) {
    throw new Error(`ElevenLabs TTS is not configured: ${missing.join(', ')}`);
  }
}

/**
 * Generate raw μ-law 8kHz audio for Twilio/Exotel/Edesy media streams.
 * The response is intentionally not MP3: raw telephony audio avoids a
 * conversion step and keeps the live call path low-latency.
 */
async function textToSpeech(text, _options = {}) {
  requireConfig();

  const params = new URLSearchParams({ output_format: 'ulaw_8000' });
  const response = await fetch(
    `${env.elevenlabs.baseUrl}/v1/text-to-speech/${encodeURIComponent(env.elevenlabs.voiceId)}?${params}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': env.elevenlabs.apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/basic',
      },
      body: JSON.stringify({
        text: String(text || ''),
        model_id: env.elevenlabs.model,
      }),
    }
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`ElevenLabs TTS failed (${response.status}): ${body.slice(0, 240)}`);
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());
  if (!audioBuffer.length) throw new Error('ElevenLabs TTS returned no audio');

  return { audioBuffer, raw: { outputFormat: 'ulaw_8000', model: env.elevenlabs.model } };
}

module.exports = { FALLBACK_SPEECH, textToSpeech };
