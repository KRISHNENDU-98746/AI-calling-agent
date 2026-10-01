const { getFirestore } = require('../config/firebase');
const { getClinicConfig } = require('./clinicConfig');

function indiaDateKey() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

function minutesFromClock(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : 9 * 60;
}

function formatClock(totalMinutes) {
  const hour = Math.floor(totalMinutes / 60) % 24;
  const minute = totalMinutes % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

async function reserveTokenSlot(db, config) {
  const dateKey = indiaDateKey();
  const counterRef = db.collection('clinic').doc(`tokenCounter_${dateKey}`);
  const duration = Math.max(5, Number(config?.appointmentDurationMinutes) || 20);
  const start = minutesFromClock(config?.hours?.start || '09:00');
  let token = 1;
  await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(counterRef);
    token = Number(snapshot.data()?.lastToken || 0) + 1;
    tx.set(counterRef, { dateKey, lastToken: token, updatedAt: new Date().toISOString() }, { merge: true });
  });
  return { token, assignedTime: formatClock(start + (token - 1) * duration), dateKey, duration };
}

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
    idempotencyKey = null,
  } = data;

  if (!patientName || !doctorName || !preferredDate || !preferredTime) {
    throw new Error('Incomplete appointment data');
  }

  const db = getFirestore();
  const docRef = db.collection('appointments').doc(idempotencyKey || undefined);
  const clinicConfig = await getClinicConfig();
  const slot = await reserveTokenSlot(db, clinicConfig);

  const appointment = {
    patientName,
    phoneNumber,
    callerNumber: phoneNumber,
    doctorName,
    preferredDate,
    preferredTime,
    status: 'requested',
    language,
    createdAt: new Date().toISOString(),
    source,
    conversationId: conversationId || docRef.id,
    callSid,
    token: slot.token,
    assignedTime: slot.assignedTime,
    slotDate: slot.dateKey,
    slotDurationMinutes: slot.duration,
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
