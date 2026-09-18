const { WebSocket } = require('ws');
const { env } = require('../config/env');

const FALLBACK_SPEECH =
  'Sorry, I am having a technical problem right now. Please try again later.';

function requireApiKey() {
  if (!env.sarvam.apiKey) {
    throw new Error('SARVAM_API_KEY is not configured');
  }
}

function authHeaders(extra = {}) {
  requireApiKey();
  return {
    'api-subscription-key': env.sarvam.apiKey,
    ...extra,
  };
}

/**
 * REST Speech-to-Text for short audio clips (under 30s).
 * Prefer createRealtimeSttConnection() for live Twilio calls.
 */
async function speechToText(audioBuffer, options = {}) {
  requireApiKey();

  const {
    languageCode = env.sarvam.sttLanguage === 'auto' ? undefined : env.sarvam.sttLanguage,
    model = 'saaras:v3',
    mode = env.sarvam.sttMode,
    filename = 'audio.wav',
    mimeType = 'audio/wav',
  } = options;

  const form = new FormData();
  const blob = new Blob([audioBuffer], { type: mimeType });
  form.append('file', blob, filename);
  form.append('model', model);
  form.append('mode', mode);
  if (languageCode) {
    form.append('language_code', languageCode);
  }

  const response = await fetch(`${env.sarvam.baseUrl}/speech-to-text`, {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Sarvam STT failed (${response.status}): ${body.slice(0, 200)}`);
  }

  const data = await response.json();
  return {
    transcript: data.transcript || data.text || '',
    languageCode: data.language_code || languageCode || null,
    raw: data,
  };
}

/**
 * REST Text-to-Speech.
 * Defaults to mulaw @ 8kHz so audio can be streamed back to Twilio unchanged.
 */
async function textToSpeech(text, options = {}) {
  requireApiKey();

  const {
    languageCode = env.sarvam.ttsLanguage,
    speaker = env.sarvam.ttsSpeaker,
    model = env.sarvam.ttsModel,
    speechSampleRate = 8000,
    outputAudioCodec = 'mulaw',
    pace = 1.0,
  } = options;

  const response = await fetch(`${env.sarvam.baseUrl}/text-to-speech`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      text,
      // Official REST field name per docs.sarvam.ai text-to-speech convert
      language_code: languageCode,
      speaker,
      model,
      pace,
      speech_sample_rate: speechSampleRate,
      output_audio_codec: outputAudioCodec,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Sarvam TTS failed (${response.status}): ${body.slice(0, 200)}`);
  }

  const data = await response.json();
  const audioBase64 = Array.isArray(data.audios) ? data.audios.join('') : '';

  if (!audioBase64) {
    throw new Error('Sarvam TTS returned no audio');
  }

  return {
    audioBase64,
    audioBuffer: Buffer.from(audioBase64, 'base64'),
    requestId: data.request_id || null,
    raw: data,
  };
}

/**
 * Open Sarvam realtime STT WebSocket (saaras:v3-realtime).
 * Compatible with Twilio Media Streams: encoding=mulaw, sample_rate=8000.
 * Exotel/Edesy PCM: encoding=linear16 (raw signed 16-bit LE), sample_rate=8000|16000.
 *
 * Docs: https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming
 * Realtime encoding enum: linear16 | linear32 | mulaw | alaw (NOT legacy pcm_s16le).
 */
const REALTIME_ENCODING_ALIASES = {
  linear16: 'linear16',
  linear32: 'linear32',
  mulaw: 'mulaw',
  alaw: 'alaw',
  // Legacy Streaming API codec names → realtime equivalents
  pcm_s16le: 'linear16',
  pcm_l16: 'linear16',
  pcm_raw: 'linear16',
  s16le: 'linear16',
  slin: 'linear16',
};

function normalizeRealtimeEncoding(encoding) {
  const key = String(encoding || 'linear16').toLowerCase().trim();
  const normalized = REALTIME_ENCODING_ALIASES[key];
  if (!normalized) {
    throw new Error(
      `Unsupported Sarvam realtime STT encoding "${encoding}". Use linear16, linear32, mulaw, or alaw.`
    );
  }
  return normalized;
}

function createRealtimeSttConnection(options = {}) {
  requireApiKey();

  const {
    languageCode = env.sarvam.sttLanguage || 'auto',
    model = 'saaras:v3-realtime',
    mode = env.sarvam.sttMode || 'codemix',
    streamType = 'fast',
    endpointing = 'vad',
    encoding = 'mulaw',
    sampleRate = 8000,
    silenceDurationMs = 700,
    threshold = 0.3,
    minSpeechDurationMs = 250,
  } = options;

  const normalizedEncoding = normalizeRealtimeEncoding(encoding);
  const normalizedSampleRate = Number(sampleRate) === 16000 ? 16000 : 8000;

  const params = new URLSearchParams({
    language_code: languageCode,
    model,
    mode,
    stream_type: streamType,
    endpointing,
    encoding: normalizedEncoding,
    sample_rate: String(normalizedSampleRate),
    silence_duration_ms: String(silenceDurationMs),
    threshold: String(threshold),
    min_speech_duration_ms: String(minSpeechDurationMs),
  });

  const url = `wss://api.sarvam.ai/speech-to-text-realtime/ws?${params.toString()}`;
  console.log(
    `[sarvam] STT connect model=${model} language=${languageCode} mode=${mode} encoding=${normalizedEncoding} sample_rate=${normalizedSampleRate} stream_type=${streamType}`
  );

  const ws = new WebSocket(url, {
    headers: {
      'api-subscription-key': env.sarvam.apiKey,
    },
  });

  return {
    ws,
    encoding: normalizedEncoding,
    sampleRate: normalizedSampleRate,
    sendAudioBase64(base64Audio) {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(
        JSON.stringify({
          event: 'audio_input',
          audio: base64Audio,
        })
      );
    },
    ping() {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ event: 'ping' }));
    },
    end() {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ event: 'end' }));
    },
    close() {
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(1000);
        }
      } catch {
        // ignore close errors
      }
    },
  };
}

async function synthesizeFallbackSpeech(languageCode = env.sarvam.ttsLanguage) {
  try {
    return await textToSpeech(FALLBACK_SPEECH, { languageCode });
  } catch (error) {
    console.error('[sarvam] Fallback TTS failed:', error.message);
    return null;
  }
}

module.exports = {
  FALLBACK_SPEECH,
  speechToText,
  textToSpeech,
  createRealtimeSttConnection,
  normalizeRealtimeEncoding,
  synthesizeFallbackSpeech,
};
