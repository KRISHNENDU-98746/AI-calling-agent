/**
 * whisperStt.js
 * ─────────────────────────────────────────────────────────────────────────────
 * OpenAI Whisper STT via OpenRouter — REST (multipart/form-data) only.
 * Optimised for Bengali name transcription (language forced to 'bn').
 *
 * Usage:
 *   const { transcribeBengaliName } = require('./whisperStt');
 *   const { transcript } = await transcribeBengaliName(audioBuffer, { mimeType: 'audio/wav' });
 *
 * Required env vars:
 *   OPENROUTER_API_KEY            — your OpenRouter API key
 *   OPENROUTER_WHISPER_MODEL      — (optional) defaults to 'openai/whisper'
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { env } = require('../config/env');

/** Default Whisper model slug served by OpenRouter. */
const DEFAULT_MODEL = 'openai/whisper';

/** OpenRouter transcription endpoint (OpenAI-compatible audio API). */
const OPENROUTER_STT_URL = 'https://openrouter.ai/api/v1/audio/transcriptions';

function requireApiKey() {
  if (!env.openrouter.apiKey) {
    throw new Error(
      'OPENROUTER_API_KEY is not configured. ' +
        'Add it to your .env file to enable Whisper STT for Bengali name recognition.'
    );
  }
}

/**
 * Transcribe an audio buffer using OpenAI Whisper via OpenRouter.
 *
 * @param {Buffer} audioBuffer  Raw audio bytes (WAV, MP3, FLAC, etc.)
 * @param {object} options
 * @param {string} [options.language='bn']        BCP-47 language hint for Whisper.
 *                                                'bn' = Bengali; null = auto-detect.
 * @param {string} [options.mimeType='audio/wav'] MIME type of the audio buffer.
 * @param {string} [options.filename='audio.wav'] Filename used in the multipart form.
 * @param {string} [options.model]                Override the Whisper model slug.
 * @param {string} [options.prompt]              Optional transcription prompt to bias output.
 *                                                A short Bengali phrase keeps Whisper in
 *                                                Bengali script mode.
 * @returns {Promise<{ transcript: string, language: string|null, raw: object }>}
 */
async function speechToText(audioBuffer, options = {}) {
  requireApiKey();

  const {
    language = 'bn',
    mimeType = 'audio/wav',
    filename = 'audio.wav',
    model = env.openrouter.whisperModel || DEFAULT_MODEL,
    prompt = '',
  } = options;

  const form = new FormData();
  const blob = new Blob([audioBuffer], { type: mimeType });
  form.append('file', blob, filename);
  form.append('model', model);

  if (language) {
    form.append('language', language);
  }
  if (prompt) {
    form.append('prompt', prompt);
  }

  // verbose_json gives us back language detection metadata.
  form.append('response_format', 'verbose_json');

  const response = await fetch(OPENROUTER_STT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.openrouter.apiKey}`,
      // OpenRouter attribution headers (optional but recommended).
      'HTTP-Referer': env.publicBaseUrl || 'https://doctor-app',
      'X-Title': 'Doctor Appointment Bengali STT',
    },
    body: form,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Whisper STT (OpenRouter) failed (${response.status}): ${body.slice(0, 300)}`
    );
  }

  const data = await response.json();

  // verbose_json shape: { text, language, segments, duration, ... }
  const transcript = (data.text || '').trim();
  const detectedLanguage = data.language || language || null;

  console.log(
    `[whisper-stt] transcript="${transcript}" detected_language=${detectedLanguage} model=${model}`
  );

  return { transcript, language: detectedLanguage, raw: data };
}

/**
 * Convenience wrapper for Bengali name collection.
 * Always forces language='bn' and adds a minimal Bengali prompt so
 * Whisper transcribes in Bengali script rather than transliterating.
 *
 * @param {Buffer} audioBuffer
 * @param {object} options  Same options as speechToText(); language is always 'bn'.
 * @returns {Promise<{ transcript: string, language: string|null, raw: object }>}
 */
async function transcribeBengaliName(audioBuffer, options = {}) {
  return speechToText(audioBuffer, {
    ...options,
    language: 'bn',
    // Anchor Whisper into Bengali mode so names come back in Bengali script.
    prompt: options.prompt ?? 'আমার নাম',
  });
}

module.exports = {
  speechToText,
  transcribeBengaliName,
  DEFAULT_MODEL,
  OPENROUTER_STT_URL,
};
