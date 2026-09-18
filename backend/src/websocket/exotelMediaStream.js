const { WebSocket } = require('ws');
const { randomUUID } = require('crypto');
const {
  createRealtimeSttConnection,
  textToSpeech,
  FALLBACK_SPEECH,
} = require('../services/sarvam');
const {
  processConversationTurn,
  getGreetingMessage,
  getSaveFailedMessage,
  EMPTY_APPOINTMENT,
  STEPS,
} = require('../services/conversation');
const { saveAppointmentRequest } = require('../services/appointment');
const { env } = require('../config/env');

const LANGUAGE_TO_TTS = {
  'bn-IN': 'bn-IN',
  'hi-IN': 'hi-IN',
  'en-IN': 'en-IN',
  bn: 'bn-IN',
  hi: 'hi-IN',
  en: 'en-IN',
  mixed: 'en-IN',
};

// Exotel bidirectional media must be chunked in multiples of 320 bytes.
// 3200 bytes = 100ms of 16-bit mono @ 8kHz (docs minimum window).
const EXOTEL_CHUNK_BYTES = 3200;

function mapLanguageForTts(detectedLanguage) {
  if (!detectedLanguage) return env.sarvam.ttsLanguage;
  return LANGUAGE_TO_TTS[detectedLanguage] || env.sarvam.ttsLanguage;
}

function stripWavHeaderIfPresent(audioBuffer) {
  if (
    audioBuffer.length > 44 &&
    audioBuffer.toString('ascii', 0, 4) === 'RIFF' &&
    audioBuffer.toString('ascii', 8, 12) === 'WAVE'
  ) {
    return audioBuffer.subarray(44);
  }
  return audioBuffer;
}

function parseSampleRate(urlOrQuery) {
  try {
    if (typeof urlOrQuery === 'string' && urlOrQuery.includes('sample-rate=')) {
      const match = urlOrQuery.match(/sample-rate=(\d+)/i);
      if (match) return Number(match[1]) || 8000;
    }
  } catch {
    // ignore
  }
  return env.exotel.sampleRate || 8000;
}

/**
 * Exotel AgentStream / Voicebot WebSocket handler.
 * Protocol per Exotel docs: connected/start/media/stop/clear/mark,
 * media payload = raw/slin 16-bit LE PCM base64.
 */
function attachExotelMediaStreamServer(wss) {
  wss.on('connection', (exotelWs, req) => {
    const conversationId = randomUUID();
    let streamSid = null;
    let callSid = null;
    let callerPhone = null;
    let stt = null;
    let pingTimer = null;
    let processingTurn = false;
    let greetingSent = false;
    let appointmentSaved = false;
    let closed = false;
    let mediaSequence = 1;
    let mediaChunk = 1;

    let conversationStep = STEPS.ASK_NAME;
    let appointmentData = { ...EMPTY_APPOINTMENT };
    let ttsLanguage = env.sarvam.ttsLanguage;
    const sampleRate = parseSampleRate(req?.url || '');

    console.log(
      `[EXOTEL] Call connected conversationId=${conversationId} sampleRate=${sampleRate}`
    );

    const safeSend = (payload) => {
      if (closed || exotelWs.readyState !== WebSocket.OPEN) return;
      try {
        exotelWs.send(JSON.stringify(payload));
      } catch (error) {
        console.error('[EXOTEL] Failed to send to Exotel:', error.message);
      }
    };

    const clearExotelBuffer = () => {
      if (!streamSid) return;
      safeSend({ event: 'clear', stream_sid: streamSid });
    };

    const sendPcmChunksToExotel = (pcmBuffer) => {
      if (!streamSid || !pcmBuffer || !pcmBuffer.length) return;

      let offset = 0;
      while (offset < pcmBuffer.length) {
        let end = Math.min(offset + EXOTEL_CHUNK_BYTES, pcmBuffer.length);
        let slice = pcmBuffer.subarray(offset, end);

        // Pad final short chunk up to a multiple of 320 bytes with silence.
        const remainder = slice.length % 320;
        if (remainder !== 0) {
          const padded = Buffer.alloc(slice.length + (320 - remainder), 0);
          slice.copy(padded);
          slice = padded;
        }

        safeSend({
          event: 'media',
          sequence_number: String(mediaSequence++),
          stream_sid: streamSid,
          media: {
            chunk: mediaChunk++,
            timestamp: String(Date.now()),
            payload: slice.toString('base64'),
          },
        });

        offset = end;
      }
    };

    const speakText = async (text, languageCode = ttsLanguage) => {
      try {
        const result = await textToSpeech(text, {
          languageCode,
          speechSampleRate: sampleRate,
          outputAudioCodec: 'linear16',
        });
        console.log(
          `[EXOTEL] TTS generated conversationId=${conversationId} bytes=${result.audioBuffer.length} lang=${languageCode}`
        );
        sendPcmChunksToExotel(stripWavHeaderIfPresent(result.audioBuffer));
      } catch (error) {
        console.error('[EXOTEL] TTS failed:', error.message);
        try {
          const fallback = await textToSpeech(FALLBACK_SPEECH, {
            languageCode: 'en-IN',
            speechSampleRate: sampleRate,
            outputAudioCodec: 'linear16',
          });
          console.log('[EXOTEL] TTS generated (fallback)');
          sendPcmChunksToExotel(stripWavHeaderIfPresent(fallback.audioBuffer));
        } catch (fallbackError) {
          console.error('[EXOTEL] Fallback TTS failed:', fallbackError.message);
        }
      }
    };

    const cleanup = () => {
      if (closed) return;
      closed = true;

      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }

      if (stt) {
        try {
          stt.end();
        } catch {
          // ignore
        }
        stt.close();
        stt = null;
      }

      console.log(`[EXOTEL] Call closed conversationId=${conversationId}`);
    };

    const handleFinalTranscript = async (transcript, detectedLanguage) => {
      const text = (transcript || '').trim();
      if (!text || processingTurn || appointmentSaved) return;

      processingTurn = true;
      clearExotelBuffer();

      try {
        console.log(`[EXOTEL] Transcript: ${text}`);

        if (detectedLanguage) {
          ttsLanguage = mapLanguageForTts(detectedLanguage);
        }

        const turn = processConversationTurn({
          userText: text,
          detectedLanguage: detectedLanguage || ttsLanguage,
          step: conversationStep,
          appointmentData,
          clinicName: env.clinic.name,
          doctors: env.clinic.doctors,
          callerPhone,
        });

        conversationStep = turn.step;
        appointmentData = {
          ...appointmentData,
          ...turn.appointmentData,
        };

        if (!appointmentData.phoneNumber && callerPhone) {
          appointmentData.phoneNumber = callerPhone;
        }

        if (turn.detectedLanguage) {
          ttsLanguage = mapLanguageForTts(turn.detectedLanguage);
        }

        console.log(
          `[EXOTEL] Agent response generated step=${conversationStep} ready=${Boolean(
            turn.appointmentReady
          )}`
        );

        if (turn.appointmentReady && !appointmentSaved) {
          try {
            await saveAppointmentRequest({
              ...appointmentData,
              language: turn.detectedLanguage || ttsLanguage,
              conversationId,
              callSid,
              source: 'exotel_voice_agent',
            });
            appointmentSaved = true;
            console.log(
              `[EXOTEL] Appointment request saved conversationId=${conversationId}`
            );
            await speakText(turn.response, ttsLanguage);
          } catch (error) {
            console.error('[EXOTEL] Firestore save failed:', error.message);
            conversationStep = STEPS.CONFIRM;
            await speakText(getSaveFailedMessage(ttsLanguage), ttsLanguage);
          }
          return;
        }

        await speakText(turn.response, ttsLanguage);
      } finally {
        processingTurn = false;
      }
    };

    const connectStt = () => {
      try {
        stt = createRealtimeSttConnection({
          languageCode: env.sarvam.sttLanguage || 'auto',
          mode: env.sarvam.sttMode || 'codemix',
          // Exotel Voicebot: raw/slin = signed 16-bit LE PCM → Sarvam realtime "linear16"
          encoding: 'linear16',
          sampleRate,
          streamType: 'fast',
          silenceDurationMs: 800,
        });
      } catch (error) {
        console.error('[EXOTEL] STT connection setup failed:', error.message);
        speakText(FALLBACK_SPEECH, 'en-IN');
        return;
      }

      stt.ws.on('open', () => {
        console.log(`[EXOTEL] Sarvam STT connected conversationId=${conversationId}`);
        pingTimer = setInterval(() => {
          if (stt) stt.ping();
        }, 20000);
      });

      stt.ws.on('message', (raw) => {
        let message;
        try {
          message = JSON.parse(raw.toString());
        } catch {
          return;
        }

        const eventName = message.event || message.type;

        if (eventName === 'vad.speech_start') {
          clearExotelBuffer();
          return;
        }

        if (eventName === 'transcript.final') {
          const transcript = message.text || message.transcript || '';
          const detectedLanguage = message.language || message.language_code || null;
          handleFinalTranscript(transcript, detectedLanguage).catch((error) => {
            console.error('[EXOTEL] Turn handling failed:', error.message);
          });
          return;
        }

        if (eventName === 'error') {
          console.error(
            `[EXOTEL] Sarvam STT error code=${message.code || 'unknown'} fatal=${Boolean(
              message.is_fatal
            )} message=${message.message || message.error || JSON.stringify(message)}`
          );
          if (message.is_fatal) {
            speakText(FALLBACK_SPEECH, 'en-IN');
          }
        }
      });

      stt.ws.on('error', (error) => {
        console.error('[EXOTEL] Sarvam STT socket error:', error.message);
      });

      stt.ws.on('close', () => {
        console.log(`[EXOTEL] Sarvam STT closed conversationId=${conversationId}`);
      });
    };

    let audioStreamLogged = false;

    exotelWs.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      switch (msg.event) {
        case 'connected':
          console.log(`[EXOTEL] Protocol connected conversationId=${conversationId}`);
          break;

        case 'start': {
          streamSid = msg.start?.stream_sid || msg.stream_sid || null;
          callSid = msg.start?.call_sid || null;
          callerPhone = msg.start?.from || msg.start?.custom_parameters?.from || null;

          console.log(
            `[EXOTEL] Audio stream connected streamSid=${streamSid || 'unknown'} callSid=${
              callSid || 'unknown'
            } from=${callerPhone || 'unknown'}`
          );

          connectStt();

          if (!greetingSent) {
            greetingSent = true;
            conversationStep = STEPS.ASK_NAME;
            const greeting = getGreetingMessage(env.clinic.name, ttsLanguage);
            setTimeout(() => {
              speakText(greeting, ttsLanguage);
            }, 300);
          }
          break;
        }

        case 'media': {
          if (!audioStreamLogged && msg.media?.payload) {
            audioStreamLogged = true;
            console.log(`[EXOTEL] Audio stream receiving media conversationId=${conversationId}`);
          }
          if (stt && msg.media?.payload) {
            stt.sendAudioBase64(msg.media.payload);
          }
          break;
        }

        case 'dtmf':
          console.log(
            `[EXOTEL] DTMF digit=${msg.dtmf?.digit || 'unknown'} conversationId=${conversationId}`
          );
          break;

        case 'mark':
          break;

        case 'stop':
          cleanup();
          break;

        default:
          break;
      }
    });

    exotelWs.on('close', () => {
      cleanup();
    });

    exotelWs.on('error', (error) => {
      console.error('[EXOTEL] Exotel socket error:', error.message);
      cleanup();
    });
  });

  wss.on('error', (error) => {
    console.error('[EXOTEL] WebSocket server error:', error.message);
  });
}

module.exports = {
  attachExotelMediaStreamServer,
};
