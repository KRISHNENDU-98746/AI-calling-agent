const { getFirestore } = require('../config/firebase');

/**
 * Saves an appointment booking REQUEST to Firestore.
 * status is always "requested" for this MVP (no external clinic confirmation).
 */
async function saveAppointmentRequest(data) {
  const {
    patientName,
    phoneNumber = null,
    doctorName,
    preferredDate,
    preferredTime,
    language = null,
    conversationId,
    callSid = null,
    source = 'voice_agent',
  } = data;

  if (!patientName || !doctorName || !preferredDate || !preferredTime) {
    throw new Error('Incomplete appointment data');
  }

  const db = getFirestore();
  const docRef = db.collection('appointments').doc();

  const appointment = {
    patientName,
    phoneNumber,
    doctorName,
    preferredDate,
    preferredTime,
    status: 'requested',
    language,
    createdAt: new Date().toISOString(),
    source,
    conversationId: conversationId || docRef.id,
    callSid,
  };

  await docRef.set(appointment);

  return {
    appointmentId: docRef.id,
    ...appointment,
  };
}

module.exports = {
  saveAppointmentRequest,
};
