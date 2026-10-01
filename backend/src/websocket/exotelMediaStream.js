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
const { startCallSession, appendTranscript, finishCallSession } = require('../services/callSession');

const LANGUAGE_TO_TTS = {
  'bn-IN': 'bn-IN',
  'hi-IN': 'hi-IN',
  'en-IN': 'en-IN',
  bn: 'bn-IN',
  hi: 'hi-IN',
  en: 'en-IN',
  mixed: 'en-IN',
};

// Exotel expects 16-bit mono PCM in multiples of 320 bytes.
// Official AgentStream guide: pace ~320 B / 20 ms (do not burst the whole utterance).
const EXOTEL_FRAME_BYTES = 320;
const EXOTEL_BURST_FRAMES = 8; // 8 × 20 ms = 160 ms between awaits
const EXOTEL_FRAME_MS = 20;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    let callSessionId = null;

    let conversationStep = STEPS.ASK_NAME;
    let appointmentData = { ...EMPTY_APPOINTMENT };
    let ttsLanguage = env.sarvam.ttsLanguage;
    const sampleRate = parseSampleRate(req?.url || '');
    let streamStartedAt = Date.now();
    let speakGeneration = 0;
    let botSpeaking = false;

    console.log(
      `[EXOTEL] Call connected conversationId=${conversationId} sampleRate=${sampleRate}`
    );

    const safeSend = (payload) => {
      if (closed || exotelWs.readyState !== WebSocket.OPEN) return false;
      try {
        exotelWs.send(JSON.stringify(payload));
        return true;
      } catch (error) {
        console.error('[EXOTEL] Failed to send to Exotel:', error.message);
        return false;
      }
    };

    const clearExotelBuffer = () => {
      if (!streamSid) return;
      safeSend({ event: 'clear', stream_sid: streamSid });
    };

    /**
     * Pace PCM to Exotel (~320 bytes / 20 ms). Bursting the full TTS payload
     * can make Exotel drop the Voicebot WebSocket after the first reply.
     */
    const sendPcmChunksToExotel = async (pcmBuffer, generation) => {
      if (!streamSid || !pcmBuffer || !pcmBuffer.length) return false;

      let offset = 0;
      let framesInBurst = 0;

      while (offset < pcmBuffer.length) {
        if (closed || generation !== speakGeneration) return false;
        if (exotelWs.readyState !== WebSocket.OPEN) return false;

        let end = Math.min(offset + EXOTEL_FRAME_BYTES, pcmBuffer.length);
        let slice = pcmBuffer.subarray(offset, end);

        const remainder = slice.length % EXOTEL_FRAME_BYTES;
        if (remainder !== 0) {
          const padded = Buffer.alloc(slice.length + (EXOTEL_FRAME_BYTES - remainder), 0);
          slice.copy(padded);
          slice = padded;
        }

        const timestamp = String(Math.max(0, Date.now() - streamStartedAt));
        const ok = safeSend({
          event: 'media',
          sequence_number: String(mediaSequence++),
          stream_sid: streamSid,
          media: {
            chunk: String(mediaChunk++),
            timestamp,
            payload: slice.toString('base64'),
          },
        });
        if (!ok) return false;

        offset = end;
        framesInBurst += 1;
        if (framesInBurst >= EXOTEL_BURST_FRAMES) {
          framesInBurst = 0;
          await sleep(EXOTEL_FRAME_MS);
        }
      }

      if (closed || generation !== speakGeneration) return false;

      // Ask Exotel to ACK when this utterance has been played.
      safeSend({
        event: 'mark',
        sequence_number: String(mediaSequence++),
        stream_sid: streamSid,
        mark: { name: `tts_${generation}` },
      });
      return true;
    };

    const speakText = async (text, languageCode = ttsLanguage) => {
      const generation = ++speakGeneration;
      botSpeaking = true;
      // Stop any queued playback from a previous (e.g. overlapping greeting) turn.
      clearExotelBuffer();

      try {
        const result = await textToSpeech(text, {
          languageCode,
          speechSampleRate: sampleRate,
          outputAudioCodec: 'linear16',
        });
        if (closed || generation !== speakGeneration) return;

        console.log(
          `[EXOTEL] TTS generated conversationId=${conversationId} bytes=${result.audioBuffer.length} lang=${languageCode}`
        );
        const sent = await sendPcmChunksToExotel(
          stripWavHeaderIfPresent(result.audioBuffer),
          generation
        );
        if (sent) {
          console.log(
            `[EXOTEL] TTS playback queued conversationId=${conversationId} generation=${generation}`
          );
        }
      } catch (error) {
        console.error('[EXOTEL] TTS failed:', error.message);
        if (closed || generation !== speakGeneration) return;
        try {
          const fallback = await textToSpeech(FALLBACK_SPEECH, {
            languageCode: 'en-IN',
            speechSampleRate: sampleRate,
            outputAudioCodec: 'linear16',
          });
          if (closed || generation !== speakGeneration) return;
          console.log('[EXOTEL] TTS generated (fallback)');
          await sendPcmChunksToExotel(
            stripWavHeaderIfPresent(fallback.audioBuffer),
            generation
          );
        } catch (fallbackError) {
          console.error('[EXOTEL] Fallback TTS failed:', fallbackError.message);
        }
      } finally {
        if (generation === speakGeneration) {
          botSpeaking = false;
        }
      }
    };

    const cleanup = (reason = 'unknown') => {
      if (closed) return;
      closed = true;
      if (callSessionId) finishCallSession({ callId: callSessionId }).catch(() => {});
      speakGeneration += 1;
      botSpeaking = false;

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

      console.log(`[EXOTEL] Call closed conversationId=${conversationId} reason=${reason}`);
    };

    const handleFinalTranscript = async (transcript, detectedLanguage) => {
      const text = (transcript || '').trim();
      // Ignore STT while we are talking — telephony echo often re-transcribes TTS.
      if (!text || processingTurn || appointmentSaved || botSpeaking || closed) return;

      processingTurn = true;

      try {
        console.log(`[EXOTEL] Transcript: ${text}`);
        appendTranscript({ callId: callSessionId, speaker: 'user', text }).catch(() => {});

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
        appendTranscript({ callId: callSessionId, speaker: 'assistant', text: turn.response }).catch(() => {});

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
          // Inbound audio is muted while botSpeaking, so ignore VAD here.
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
          callSessionId = await startCallSession({ callSid, conversationId, callerPhone });
          streamStartedAt = Date.now();

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
              if (!closed) speakText(greeting, ttsLanguage);
            }, 300);
          }
          break;
        }

        case 'media': {
          if (!audioStreamLogged && msg.media?.payload) {
            audioStreamLogged = true;
            console.log(`[EXOTEL] Audio stream receiving media conversationId=${conversationId}`);
          }
          // Do not feed bot playback echo into STT while speaking.
          if (stt && msg.media?.payload && !botSpeaking) {
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
          console.log(
            `[EXOTEL] Mark received name=${msg.mark?.name || 'unknown'} conversationId=${conversationId}`
          );
          break;

        case 'stop':
          cleanup(`exotel_stop:${msg.stop?.reason || msg.reason || 'stopped'}`);
          break;

        default:
          break;
      }
    });

    exotelWs.on('close', (code, reasonBuf) => {
      const reasonText = reasonBuf ? reasonBuf.toString() : '';
      cleanup(`ws_close:${code}${reasonText ? `:${reasonText}` : ''}`);
    });

    exotelWs.on('error', (error) => {
      console.error('[EXOTEL] Exotel socket error:', error.message);
      cleanup(`ws_error:${error.message}`);
    });
  });

  wss.on('error', (error) => {
    console.error('[EXOTEL] WebSocket server error:', error.message);
  });
}

module.exports = {
  attachExotelMediaStreamServer,
};
