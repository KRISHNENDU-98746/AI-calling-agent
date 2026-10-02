const { WebSocket } = require('ws');
const { randomUUID } = require('crypto');
const { createRealtimeSttConnection } = require('../services/elevenlabsStt');
const { textToSpeech, FALLBACK_SPEECH } = require('../services/elevenlabs');
const { generateAppointmentTurn } = require('../services/groq');
const { saveAppointmentRequest } = require('../services/appointment');
const { env } = require('../config/env');
const { getClinicConfig, isClinicAvailable } = require('../services/clinicConfig');
const { startCallSession, appendTranscript, finishCallSession } = require('../services/callSession');

const BENGALI_GREETING = 'নমস্কার, আমি S. N. Tripathi-র clinic থেকে বলছি। আমি আপনাকে appointment লিখতে সাহায্য করব। আপনার নামটা বলবেন?';
const BENGALI_SAVE_FAILED =
  'দুঃখিত, অ্যাপয়েন্টমেন্টের অনুরোধটি এখন সংরক্ষণ করা যায়নি। পরে আবার চেষ্টা করুন।';
const BENGALI_SAVE_SUCCESS =
  'ধন্যবাদ। আপনার appointment confirm করা হয়েছে। S.N. Tripathi-র clinic-এ আপনার appointment নোট করা হয়েছে।';
function bookingSuccessMessage(savedAppointment) {
  const time = savedAppointment?.assignedTime || savedAppointment?.preferredTime || 'নির্ধারিত সময়ে';
  const token = savedAppointment?.token || 'নির্ধারিত';
  return `${BENGALI_SAVE_SUCCESS} আপনি ${time}-এ clinic-এ আসবেন। আপনার token number ${token}।`;
}

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
  if (!detectedLanguage) return 'bn-IN';
  return LANGUAGE_TO_TTS[detectedLanguage] || 'bn-IN';
}

function extractMulawPayload(audioBuffer) {
  // Strip a WAV container if a future telephony provider returns one.
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
    let clinicConfig = null;
    let callSessionId = null;
    const pendingSttAudio = [];
    const MAX_PENDING_STT_CHUNKS = 150; // ~3 seconds of Twilio 20ms audio
    let forwardedSttChunks = 0;
    let sttMessageCount = 0;

    let appointmentData = {
      patientName: null,
      doctorName: null,
      preferredDate: null,
      preferredTime: null,
      phoneNumber: null,
    };
    let ttsLanguage = 'bn-IN';
    const conversationHistory = [];

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

    const forwardAudioToStt = (payload) => {
      if (!stt || !payload) return;
      if (stt.ws.readyState === WebSocket.OPEN) {
        stt.sendAudioBase64(payload);
        forwardedSttChunks += 1;
        if (forwardedSttChunks === 1) console.log(`[media-stream] First audio chunk sent to ElevenLabs STT conversationId=${conversationId}`);
        return;
      }
      if (stt.ws.readyState === WebSocket.CONNECTING) {
        pendingSttAudio.push(payload);
        if (pendingSttAudio.length > MAX_PENDING_STT_CHUNKS) pendingSttAudio.shift();
      }
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

      if (callSessionId) finishCallSession({ callId: callSessionId }).catch((error) => console.error('[media-stream] post-call enqueue failed:', error.message));

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
        appendTranscript({ callId: callSessionId, speaker: 'user', text }).catch(() => {});
        if (!clinicConfig || !isClinicAvailable(clinicConfig)) {
          await speakText(clinicConfig?.clinicClosedMessage || 'দুঃখিত, আজ clinic বন্ধ। অনুগ্রহ করে অন্য দিনে call করুন।', 'bn-IN');
          return;
        }

        appointmentData.doctorName = clinicConfig.doctorName || appointmentData.doctorName || 'Dr. Rahman';

        if (detectedLanguage) {
          ttsLanguage = mapLanguageForTts(detectedLanguage);
        }

        const turn = await generateAppointmentTurn({
          userText: text,
          history: conversationHistory,
          appointmentData,
          clinicName: clinicConfig.clinicName || env.clinic.name,
          doctors: [clinicConfig.doctorName || 'Dr. Rahman'],
        });

        appointmentData = {
          ...appointmentData,
          ...turn.appointmentData,
        };

        if (!appointmentData.phoneNumber && callerPhone) {
          appointmentData.phoneNumber = callerPhone;
        }

        ttsLanguage = mapLanguageForTts(turn.responseLanguage);

        conversationHistory.push(
          { role: 'user', content: text },
          { role: 'assistant', content: turn.reply }
        );
        appendTranscript({ callId: callSessionId, speaker: 'assistant', text: turn.reply }).catch(() => {});

        if (turn.shouldSave && !appointmentSaved) {
          try {
            const savedAppointment = await saveAppointmentRequest({
              ...appointmentData,
              language: turn.responseLanguage || 'bn',
              conversationId,
              callSid,
            });
            appointmentSaved = true;
            console.log(
              `[media-stream] Appointment request saved conversationId=${conversationId}`
            );
            await speakText(bookingSuccessMessage(savedAppointment), 'bn-IN');
          } catch (error) {
            console.error('[media-stream] Firestore save failed:', error.message);
            await speakText(BENGALI_SAVE_FAILED, 'bn-IN');
          }
          return;
        }

        await speakText(turn.reply, ttsLanguage);
      } finally {
        processingTurn = false;
      }
    };

    const connectStt = () => {
      try {
        stt = createRealtimeSttConnection({
          languageCode: env.elevenlabs.sttLanguage || '',
          model: env.elevenlabs.sttModel,
          encoding: 'mulaw',
          sampleRate: 8000,
          streamType: 'fast',
          silenceDurationMs: 500,
        });
      } catch (error) {
        console.error('[media-stream] STT connection setup failed:', error.message);
        speakText(FALLBACK_SPEECH, 'en-IN');
        return;
      }

      stt.ws.on('open', () => {
        console.log(`[media-stream] ElevenLabs STT connected conversationId=${conversationId}`);
        while (pendingSttAudio.length) stt.sendAudioBase64(pendingSttAudio.shift());
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

        const eventName = message.event || message.type || message.message_type;
        sttMessageCount += 1;
        if (eventName === 'session_started' || eventName === 'partial_transcript' || eventName === 'committed_transcript') {
          console.log(`[media-stream] ElevenLabs STT event=${eventName} textLength=${String(message.text || '').length} count=${sttMessageCount}`);
        }

        if (eventName === 'vad.speech_start') {
          // Barge-in: stop current agent audio when caller starts speaking
          clearTwilioBuffer();
          return;
        }

        if (eventName === 'transcript.final' || eventName === 'committed_transcript') {
          const transcript = message.text || message.transcript || '';
          const detectedLanguage = message.language || message.language_code || null;
          handleFinalTranscript(transcript, detectedLanguage).catch((error) => {
            console.error('[media-stream] Turn handling failed:', error.message);
          });
          return;
        }

        if (eventName === 'error' || eventName === 'rate_limited' || eventName === 'unaccepted_terms') {
          console.error(
            `[media-stream] ElevenLabs STT error type=${eventName} message=${message.error || message.message || message.warning || 'unknown'}`
          );
          if (message.is_fatal || eventName !== 'error') {
            speakText(FALLBACK_SPEECH, 'en-IN');
          }
        }
      });

      stt.ws.on('error', (error) => {
        console.error('[media-stream] ElevenLabs STT socket error:', error.message);
      });

      stt.ws.on('close', (code, reason) => {
        console.log(`[media-stream] ElevenLabs STT closed conversationId=${conversationId} code=${code} reason=${String(reason || '').slice(0, 120)} chunks=${forwardedSttChunks} messages=${sttMessageCount}`);
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
          const skipGreeting = msg.start?.customParameters?.skipGreeting === 'true';
          callSessionId = await startCallSession({ callSid, conversationId, callerPhone });

          console.log(
            `[media-stream] Stream started streamSid=${streamSid || 'unknown'} callSid=${
              callSid || 'unknown'
            }`
          );

          clinicConfig = await getClinicConfig().catch((error) => {
            console.error('[media-stream] Clinic config unavailable:', error.message);
            return null;
          });

          if (clinicConfig && isClinicAvailable(clinicConfig)) connectStt();

          if (!greetingSent && !skipGreeting) {
            greetingSent = true;
            // Small delay so Twilio stream is fully ready
            setTimeout(() => {
              const greeting = clinicConfig && isClinicAvailable(clinicConfig)
                ? (clinicConfig.agentGreeting || BENGALI_GREETING)
                : (clinicConfig?.clinicClosedMessage || 'দুঃখিত, আজ clinic বন্ধ। অনুগ্রহ করে অন্য দিনে call করুন।');
              speakText(greeting, 'bn-IN');
            }, 0);
          } else if (skipGreeting) greetingSent = true;
          break;
        }

        case 'media': {
          // Buffer the first chunks while ElevenLabs' realtime socket is connecting;
          // otherwise a caller who says their name immediately can be missed.
          if (stt && msg.media?.payload) forwardAudioToStt(msg.media.payload);
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
