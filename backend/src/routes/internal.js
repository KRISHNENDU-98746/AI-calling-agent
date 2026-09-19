const crypto = require('crypto');
const express = require('express');

const { env } = require('../config/env');
const {
  EMPTY_APPOINTMENT,
  STEPS,
  processConversationTurn,
  getSaveFailedMessage,
} = require('../services/conversation');
const { saveAppointmentRequest } = require('../services/appointment');

const router = express.Router();
const conversations = new Map();
const CONVERSATION_TTL_MS = 60 * 60 * 1000;

function authorized(req) {
  const provided = req.get('x-internal-agent-secret') || '';
  const expected = env.internalAgentSecret;
  if (!expected || provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

function pruneConversations() {
  const cutoff = Date.now() - CONVERSATION_TTL_MS;
  for (const [id, state] of conversations) {
    if (state.updatedAt < cutoff) conversations.delete(id);
  }
}

router.post('/internal/conversation', async (req, res, next) => {
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { conversationId, text, detectedLanguage, callerPhone, callSid } = req.body || {};
  if (
    typeof conversationId !== 'string' ||
    conversationId.length < 1 ||
    conversationId.length > 200 ||
    typeof text !== 'string' ||
    text.length > 4000
  ) {
    return res.status(400).json({ error: 'conversationId and text are required' });
  }

  pruneConversations();
  const previous = conversations.get(conversationId) || {
    step: STEPS.ASK_NAME,
    appointmentData: { ...EMPTY_APPOINTMENT },
    appointmentSaved: false,
  };

  try {
    const turn = processConversationTurn({
      userText: text,
      detectedLanguage,
      step: previous.step,
      appointmentData: previous.appointmentData,
      callerPhone,
    });

    let response = turn.response;
    let appointmentSaved = previous.appointmentSaved;
    if (turn.appointmentReady && !appointmentSaved) {
      try {
        await saveAppointmentRequest({
          ...turn.appointmentData,
          language: turn.detectedLanguage,
          conversationId,
          callSid,
          source: 'videosdk_agent',
        });
        appointmentSaved = true;
      } catch (error) {
        console.error(`[internal] Firestore save failed: ${error.message}`);
        response = getSaveFailedMessage(turn.detectedLanguage);
      }
    }

    conversations.set(conversationId, {
      step: turn.step,
      appointmentData: turn.appointmentData,
      appointmentSaved,
      updatedAt: Date.now(),
    });

    return res.json({
      response,
      step: turn.step,
      appointmentReady: Boolean(turn.appointmentReady && appointmentSaved),
      detectedLanguage: turn.detectedLanguage,
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
