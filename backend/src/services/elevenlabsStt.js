const { WebSocket } = require('ws');
const { env } = require('../config/env');

const ENCODING_TO_FORMAT = {
  mulaw: 'ulaw_8000',
  alaw: 'pcm_8000',
  linear16: 'pcm_8000',
  pcm_s16le: 'pcm_8000',
  pcm_l16: 'pcm_8000',
  pcm_raw: 'pcm_8000',
  s16le: 'pcm_8000',
  slin: 'pcm_8000',
};

function requireApiKey() {
  if (!env.elevenlabs.apiKey) throw new Error('ELEVENLABS_API_KEY is not configured');
}

function normalizeAudioFormat(encoding, sampleRate) {
  if (String(encoding).toLowerCase() === 'mulaw' && Number(sampleRate) === 8000) return 'ulaw_8000';
  if (Number(sampleRate) === 16000) return 'pcm_16000';
  return ENCODING_TO_FORMAT[String(encoding || 'linear16').toLowerCase()] || 'pcm_8000';
}

function createRealtimeSttConnection(options = {}) {
  requireApiKey();

  const {
    languageCode = '',
    model = env.elevenlabs.sttModel,
    encoding = 'mulaw',
    sampleRate = 8000,
    commitStrategy = 'vad',
  } = options;

  const params = new URLSearchParams({
    model_id: model,
    audio_format: normalizeAudioFormat(encoding, sampleRate),
    commit_strategy: commitStrategy,
  });
  if (languageCode && languageCode !== 'auto') params.set('language_code', languageCode.split('-')[0]);

  const url = `${env.elevenlabs.sttBaseUrl}/v1/speech-to-text/realtime?${params.toString()}`;
  console.log(
    `[elevenlabs-stt] connect model=${model} format=${params.get('audio_format')} strategy=${commitStrategy}`
  );

  const ws = new WebSocket(url, {
    headers: { 'xi-api-key': env.elevenlabs.apiKey },
  });

  return {
    ws,
    encoding: params.get('audio_format'),
    sampleRate: Number(sampleRate) || 8000,
    sendAudioBase64(base64Audio) {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: base64Audio,
      }));
    },
    ping() {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    },
    end() {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: '',
        commit: true,
      }));
    },
    close() {
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000);
      } catch {
        // ignore close errors
      }
    },
  };
}

module.exports = { createRealtimeSttConnection, normalizeAudioFormat };
