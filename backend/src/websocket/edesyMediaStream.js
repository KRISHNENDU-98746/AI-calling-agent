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

// Edesy docs: ~640 bytes/frame ≈ 20 ms of mono L16 @ 16 kHz
const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_FRAME_BYTES = 640;

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

function frameBytesForSampleRate(sampleRate) {
  // 20 ms of signed 16-bit mono PCM
  const bytes = Math.round(sampleRate * 0.02 * 2);
  return bytes > 0 ? bytes : DEFAULT_FRAME_BYTES;
}

/**
 * Edesy custom-agent WebSocket handler.
 * Protocol: https://edesy.in/docs/sip-trunk-for-ai-voice-agents/connect/websocket-streaming
 * - First text frame: call metadata JSON
 * - Bidirectional binary frames: L16 PCM (signed 16-bit LE)
 * - Agent control text: killAudio | disconnect | mark
 * - Platform DTMF text: { event: "dtmf", ... }
 */
function attachEdesyMediaStreamServer(wss) {
  wss.on('connection', (edesyWs) => {
    const conversationId = randomUUID();
    let callSid = null;
    let callerPhone = null;
    let sampleRate = env.edesy.sampleRate || DEFAULT_SAMPLE_RATE;
    let frameBytes = frameBytesForSampleRate(sampleRate);
    let metadataReceived = false;
    let stt = null;
    let pingTimer = null;
    let processingTurn = false;
    let greetingSent = false;
    let appointmentSaved = false;
    let closed = false;
    let markCounter = 0;
    let callSessionId = null;

    let conversationStep = STEPS.ASK_NAME;
    let appointmentData = { ...EMPTY_APPOINTMENT };
    let ttsLanguage = env.sarvam.ttsLanguage;

    console.log(`[edesy-media] Client connected conversationId=${conversationId}`);

    const safeSendJson = (payload) => {
      if (closed || edesyWs.readyState !== WebSocket.OPEN) return;
      try {
        edesyWs.send(JSON.stringify(payload));
      } catch (error) {
        console.error('[edesy-media] Failed to send JSON to Edesy:', error.message);
      }
    };

    const safeSendBinary = (buffer) => {
      if (closed || edesyWs.readyState !== WebSocket.OPEN || !buffer?.length) return;
      try {
        edesyWs.send(buffer, { binary: true });
      } catch (error) {
        console.error('[edesy-media] Failed to send audio to Edesy:', error.message);
      }
    };

    const killAudio = () => {
      safeSendJson({ type: 'killAudio' });
    };

    const sendPcmToEdesy = (pcmBuffer) => {
      if (!pcmBuffer?.length) return;

      let offset = 0;
      while (offset < pcmBuffer.length) {
        const end = Math.min(offset + frameBytes, pcmBuffer.length);
        let slice = pcmBuffer.subarray(offset, end);

        // Pad a short final frame with silence so frame size stays consistent.
        if (slice.length < frameBytes) {
          const padded = Buffer.alloc(frameBytes, 0);
          slice.copy(padded);
          slice = padded;
        }

        safeSendBinary(slice);
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
        sendPcmToEdesy(stripWavHeaderIfPresent(result.audioBuffer));

        markCounter += 1;
        safeSendJson({
          type: 'mark',
          data: { name: `utterance-${markCounter}-end` },
        });
      } catch (error) {
        console.error('[edesy-media] TTS failed:', error.message);
        try {
          const fallback = await textToSpeech(FALLBACK_SPEECH, {
            languageCode: 'en-IN',
            speechSampleRate: sampleRate,
            outputAudioCodec: 'linear16',
          });
          sendPcmToEdesy(stripWavHeaderIfPresent(fallback.audioBuffer));
        } catch (fallbackError) {
          console.error('[edesy-media] Fallback TTS failed:', fallbackError.message);
        }
      }
    };

    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (callSessionId) finishCallSession({ callId: callSessionId }).catch(() => {});

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

      console.log(`[edesy-media] Closed conversationId=${conversationId}`);
    };

    const handleFinalTranscript = async (transcript, detectedLanguage) => {
      const text = (transcript || '').trim();
      if (!text || processingTurn || appointmentSaved) return;

      processingTurn = true;
      killAudio();

      try {
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

        if (turn.appointmentReady && !appointmentSaved) {
          try {
            const savedAppointment = await saveAppointmentRequest({
              ...appointmentData,
              language: turn.detectedLanguage || ttsLanguage,
              conversationId,
              callSid,
              source: 'edesy_voice_agent',
            });
            appointmentSaved = true;
            console.log(
              `[edesy-media] Appointment request saved conversationId=${conversationId}`
            );
            await speakText(`${turn.response} আপনি ${savedAppointment.assignedTime || appointmentData.preferredTime}-এ clinic-এ আসবেন। আপনার token number ${savedAppointment.token || 'নির্ধারিত'}।`, ttsLanguage);
          } catch (error) {
            console.error('[edesy-media] Firestore save failed:', error.message);
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
          encoding: 'linear16',
          sampleRate,
          streamType: 'fast',
          silenceDurationMs: 800,
        });
      } catch (error) {
        console.error('[edesy-media] STT connection setup failed:', error.message);
        speakText(FALLBACK_SPEECH, 'en-IN');
        return;
      }

      stt.ws.on('open', () => {
        console.log(`[edesy-media] Sarvam STT connected conversationId=${conversationId}`);
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
          killAudio();
          return;
        }

        if (eventName === 'transcript.final') {
          const transcript = message.text || message.transcript || '';
          const detectedLanguage = message.language || message.language_code || null;
          handleFinalTranscript(transcript, detectedLanguage).catch((error) => {
            console.error('[edesy-media] Turn handling failed:', error.message);
          });
          return;
        }

        if (eventName === 'error') {
          console.error(
            `[edesy-media] Sarvam STT error code=${message.code || 'unknown'} fatal=${Boolean(
              message.is_fatal
            )}`
          );
          if (message.is_fatal) {
            speakText(FALLBACK_SPEECH, 'en-IN');
          }
        }
      });

      stt.ws.on('error', (error) => {
        console.error('[edesy-media] Sarvam STT socket error:', error.message);
      });

      stt.ws.on('close', () => {
        console.log(`[edesy-media] Sarvam STT closed conversationId=${conversationId}`);
      });
    };

    const handleMetadata = (meta) => {
      callSid = meta.call_sid || meta.callSid || null;
      callerPhone = meta.from || null;
      startCallSession({ callSid, conversationId, callerPhone }).then((id) => { callSessionId = id; }).catch(() => {});
      if (meta.sampleRate) {
        sampleRate = Number(meta.sampleRate) || sampleRate;
        frameBytes = frameBytesForSampleRate(sampleRate);
      }

      console.log(
        `[edesy-media] Call metadata callSid=${callSid || 'unknown'} from=${
          callerPhone || 'unknown'
        } to=${meta.to || 'unknown'} direction=${meta.direction || 'unknown'} sampleRate=${sampleRate}`
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
    };

    const handleTextMessage = (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        console.warn('[edesy-media] Ignoring non-JSON text frame');
        return;
      }

      // First text frame is call metadata (has call_sid / callSid).
      if (!metadataReceived && (msg.call_sid || msg.callSid || msg.sampleRate !== undefined)) {
        metadataReceived = true;
        handleMetadata(msg);
        return;
      }

      if (msg.event === 'dtmf') {
        console.log(
          `[edesy-media] DTMF digit=${msg.dtmf || 'unknown'} duration=${
            msg.duration || 'unknown'
          } conversationId=${conversationId}`
        );
        return;
      }

      if (msg.type === 'mark') {
        // Platform playout acknowledgement — no action required for rule-based flow.
        return;
      }
    };

    const handleBinaryAudio = (data) => {
      if (!metadataReceived || !stt) return;
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (!buffer.length) return;
      stt.sendAudioBase64(buffer.toString('base64'));
    };

    edesyWs.on('message', (data, isBinary) => {
      if (isBinary) {
        handleBinaryAudio(data);
        return;
      }
      handleTextMessage(data);
    });

    edesyWs.on('close', () => {
      cleanup();
    });

    edesyWs.on('error', (error) => {
      console.error('[edesy-media] Edesy socket error:', error.message);
      cleanup();
    });
  });

  wss.on('error', (error) => {
    console.error('[edesy-media] WebSocket server error:', error.message);
  });
}

module.exports = {
  attachEdesyMediaStreamServer,
};
