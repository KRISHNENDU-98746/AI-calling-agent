const crypto = require('crypto');
const express = require('express');
const { env } = require('../config/env');
const { getFirestore } = require('../config/firebase');
const { getClinicConfig, updateClinicConfig } = require('../services/clinicConfig');
const router = express.Router();

function authorized(req) {
  if (!env.adminApiKey) return true;
  const provided = req.get('x-admin-api-key') || '';
  return provided.length === env.adminApiKey.length && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(env.adminApiKey));
}
function guard(req, res, next) { return authorized(req) ? next() : res.status(401).json({ error: 'Admin authentication required' }); }
async function getAppointments() {
  const snapshot = await getFirestore().collection('appointments').limit(100).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

router.get('/admin/dashboard', guard, async (_req, res, next) => {
  try { const [config, appointments] = await Promise.all([getClinicConfig(), getAppointments()]); return res.json({ config, appointments, stats: { todayAppointments: appointments.length, patientsServed: appointments.filter((item) => ['completed', 'checked_in'].includes(item.status)).length, tokenLimit: config.tokenLimit } }); } catch (error) { return next(error); }
});
router.patch('/admin/config', guard, async (req, res, next) => {
  try { return res.json({ config: await updateClinicConfig(req.body || {}) }); } catch (error) { return next(error); }
});
router.get('/admin/appointments', guard, async (_req, res, next) => {
  try { return res.json({ appointments: await getAppointments() }); } catch (error) { return next(error); }
});

const { speechToText } = require('../services/sarvam');
const { processConversationTurn, STEPS, EMPTY_APPOINTMENT } = require('../services/conversation');
const conversations = new Map();

router.post('/admin/simulate', guard, express.json({limit: '10mb'}), async (req, res, next) => {
  try {
    const { audioBase64, mimeType, conversationId = 'local-test' } = req.body;
    if (!audioBase64) return res.status(400).json({ error: 'Audio required' });
    
    // Convert base64 to buffer
    const audioBuffer = Buffer.from(audioBase64, 'base64');
    
    // Transcribe
    const stt = await speechToText(audioBuffer, { mimeType });
    const text = stt.transcript;
    
    // Process conversation
    const previous = conversations.get(conversationId) || { step: STEPS.ASK_NAME, appointmentData: { ...EMPTY_APPOINTMENT } };
    const turn = processConversationTurn({
      userText: text,
      detectedLanguage: stt.languageCode,
      step: previous.step,
      appointmentData: previous.appointmentData,
      callerPhone: '+919999999999'
    });
    
    conversations.set(conversationId, { step: turn.step, appointmentData: turn.appointmentData });
    
    return res.json({ transcript: text, agentResponse: turn.response, step: turn.step });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
