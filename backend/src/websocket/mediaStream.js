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

function mapLanguageForTts(detectedLanguage) {
  if (!detectedLanguage) return env.sarvam.ttsLanguage;
  return LANGUAGE_TO_TTS[detectedLanguage] || env.sarvam.ttsLanguage;
}

function extractMulawPayload(audioBuffer) {
  // If Sarvam returns a WAV container despite mulaw codec, strip the 44-byte header.
  if (
    audioBuffer.length > 44 &&
    audioBuffer.toString('ascii', 0, 4) === 'RIFF' &&
    audioBuffer.toString('ascii', 8, 12) === 'WAVE'
  ) {
    return audioBuffer.subarray(44).toString('base64');
  }
  return audioBuffer.toString('base64');
}

/**
 * Handles one Twilio Media Stream WebSocket connection for an inbound call.
 */
function attachMediaStreamServer(wss) {
  wss.on('connection', (twilioWs) => {
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

    let conversationStep = STEPS.ASK_NAME;
    let appointmentData = { ...EMPTY_APPOINTMENT };
    let ttsLanguage = env.sarvam.ttsLanguage;

    console.log(`[media-stream] Client connected conversationId=${conversationId}`);

    const safeSend = (payload) => {
      if (closed || twilioWs.readyState !== WebSocket.OPEN) return;
      try {
        twilioWs.send(JSON.stringify(payload));
      } catch (error) {
        console.error('[media-stream] Failed to send to Twilio:', error.message);
      }
    };

    const clearTwilioBuffer = () => {
      if (!streamSid) return;
      safeSend({ event: 'clear', streamSid });
    };

    const sendMulawToTwilio = (mulawBase64) => {
      if (!streamSid || !mulawBase64) return;
      safeSend({
        event: 'media',
        streamSid,
        media: { payload: mulawBase64 },
      });
    };

    const speakText = async (text, languageCode = ttsLanguage) => {
      try {
        const result = await textToSpeech(text, {
          languageCode,
          speechSampleRate: 8000,
          outputAudioCodec: 'mulaw',
        });
        sendMulawToTwilio(extractMulawPayload(result.audioBuffer));
      } catch (error) {
        console.error('[media-stream] TTS failed:', error.message);
        try {
          const fallback = await textToSpeech(FALLBACK_SPEECH, {
            languageCode: 'en-IN',
            speechSampleRate: 8000,
            outputAudioCodec: 'mulaw',
          });
          sendMulawToTwilio(extractMulawPayload(fallback.audioBuffer));
        } catch (fallbackError) {
          console.error('[media-stream] Fallback TTS failed:', fallbackError.message);
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

      console.log(`[media-stream] Closed conversationId=${conversationId}`);
    };

    const handleFinalTranscript = async (transcript, detectedLanguage) => {
      const text = (transcript || '').trim();
      if (!text || processingTurn || appointmentSaved) return;

      processingTurn = true;
      clearTwilioBuffer();

      try {
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

        if (turn.appointmentReady && !appointmentSaved) {
          try {
            await saveAppointmentRequest({
              ...appointmentData,
              language: turn.detectedLanguage || ttsLanguage,
              conversationId,
              callSid,
            });
            appointmentSaved = true;
            console.log(
              `[media-stream] Appointment request saved conversationId=${conversationId}`
            );
            await speakText(turn.response, ttsLanguage);
          } catch (error) {
            console.error('[media-stream] Firestore save failed:', error.message);
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
          encoding: 'mulaw',
          sampleRate: 8000,
          streamType: 'fast',
          silenceDurationMs: 800,
        });
      } catch (error) {
        console.error('[media-stream] STT connection setup failed:', error.message);
        speakText(FALLBACK_SPEECH, 'en-IN');
        return;
      }

      stt.ws.on('open', () => {
        console.log(`[media-stream] Sarvam STT connected conversationId=${conversationId}`);
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
          // Barge-in: stop current agent audio when caller starts speaking
          clearTwilioBuffer();
          return;
        }

        if (eventName === 'transcript.final') {
          const transcript = message.text || message.transcript || '';
          const detectedLanguage = message.language || message.language_code || null;
          handleFinalTranscript(transcript, detectedLanguage).catch((error) => {
            console.error('[media-stream] Turn handling failed:', error.message);
          });
          return;
        }

        if (eventName === 'error') {
          console.error(
            `[media-stream] Sarvam STT error code=${message.code || 'unknown'} fatal=${Boolean(
              message.is_fatal
            )}`
          );
          if (message.is_fatal) {
            speakText(FALLBACK_SPEECH, 'en-IN');
          }
        }
      });

      stt.ws.on('error', (error) => {
        console.error('[media-stream] Sarvam STT socket error:', error.message);
      });

      stt.ws.on('close', () => {
        console.log(`[media-stream] Sarvam STT closed conversationId=${conversationId}`);
      });
    };

    twilioWs.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      switch (msg.event) {
        case 'connected':
          break;

        case 'start': {
          streamSid = msg.start?.streamSid || msg.streamSid || null;
          callSid =
            msg.start?.callSid ||
            msg.start?.customParameters?.callSid ||
            null;
          callerPhone = msg.start?.customParameters?.from || null;

          console.log(
            `[media-stream] Stream started streamSid=${streamSid || 'unknown'} callSid=${
              callSid || 'unknown'
            }`
          );

          connectStt();

          if (!greetingSent) {
            greetingSent = true;
            conversationStep = STEPS.ASK_NAME;
            const greeting = getGreetingMessage(env.clinic.name, ttsLanguage);
            // Small delay so Twilio stream is fully ready
            setTimeout(() => {
              speakText(greeting, ttsLanguage);
            }, 300);
          }
          break;
        }

        case 'media': {
          if (stt && msg.media?.payload && !processingTurn) {
            stt.sendAudioBase64(msg.media.payload);
          } else if (stt && msg.media?.payload && processingTurn) {
            // Still forward audio so VAD can detect barge-in after agent finishes
            stt.sendAudioBase64(msg.media.payload);
          }
          break;
        }

        case 'stop':
          cleanup();
          break;

        default:
          break;
      }
    });

    twilioWs.on('close', () => {
      cleanup();
    });

    twilioWs.on('error', (error) => {
      console.error('[media-stream] Twilio socket error:', error.message);
      cleanup();
    });
  });
}

module.exports = {
  attachMediaStreamServer,
};
