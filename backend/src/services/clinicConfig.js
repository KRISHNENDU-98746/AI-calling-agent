const { getFirestore, isFirebaseReady } = require('../config/firebase');

const defaultConfig = {
  clinicName: 'S. N. Tripathi', doctorName: 'S. N. Tripathi', specialty: 'General physician',
  agentGreeting: 'আমি S.N. Tripathi-র clinic থেকে বলছি। আমি আপনাকে appointment লিখতে সাহায্য করব। আপনার নাম বলবেন?', closedBehavior: 'polite', replyStyle: 'short',
  clinicOpen: true, doctorAvailable: true, agentEnabled: true,
  clinicClosedMessage: 'দুঃখিত, আজ clinic বন্ধ। অনুগ্রহ করে অন্য দিনে call করুন।',
  hours: { start: '09:00', end: '17:00' }, appointmentDurationMinutes: 15, tokenLimit: 30,
  slots: ['09:30', '10:15', '11:00', '12:30'], updatedAt: null,
};
let memoryConfig = { ...defaultConfig };

function normalize(input = {}) {
  const next = { ...memoryConfig };
  for (const key of ['clinicName', 'doctorName', 'specialty', 'agentGreeting', 'closedBehavior', 'replyStyle', 'clinicClosedMessage', 'clinicOpen', 'doctorAvailable', 'agentEnabled', 'appointmentDurationMinutes', 'tokenLimit', 'slots']) if (input[key] !== undefined) next[key] = input[key];
  if (input.hours && typeof input.hours === 'object') next.hours = { start: String(input.hours.start || next.hours.start), end: String(input.hours.end || next.hours.end) };
  next.clinicOpen = Boolean(next.clinicOpen); next.doctorAvailable = Boolean(next.doctorAvailable); next.agentEnabled = Boolean(next.agentEnabled);
  next.tokenLimit = Math.max(0, Number(next.tokenLimit) || 0); next.appointmentDurationMinutes = Math.max(5, Number(next.appointmentDurationMinutes) || 15);
  next.slots = Array.isArray(next.slots) ? next.slots.map(String).filter(Boolean).slice(0, 100) : []; next.updatedAt = new Date().toISOString();
  return next;
}

async function getClinicConfig() {
  if (!isFirebaseReady()) return { ...memoryConfig };
  const ref = getFirestore().collection('clinic').doc('config'); const snapshot = await ref.get();
  if (!snapshot.exists) { await ref.set(defaultConfig, { merge: true }); return { ...defaultConfig }; }
  return { ...defaultConfig, ...snapshot.data() };
}

async function updateClinicConfig(input) {
  const next = normalize(input); memoryConfig = next;
  if (isFirebaseReady()) await getFirestore().collection('clinic').doc('config').set(next, { merge: true });
  return next;
}

function minutesFromClock(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function getIndiaMinutes(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  return Number(parts.find((part) => part.type === 'hour')?.value || 0) * 60 + Number(parts.find((part) => part.type === 'minute')?.value || 0);
}

function isWithinClinicHours(config, now = new Date()) {
  const start = minutesFromClock(config?.hours?.start);
  const end = minutesFromClock(config?.hours?.end);
  if (start === null || end === null) return true;
  const current = getIndiaMinutes(now);
  return start <= end ? current >= start && current < end : current >= start || current < end;
}

function isClinicAvailable(config, now = new Date()) {
  return Boolean(config?.clinicOpen && config?.doctorAvailable && config?.agentEnabled && isWithinClinicHours(config, now));
}

module.exports = { defaultConfig, getClinicConfig, updateClinicConfig, isWithinClinicHours, isClinicAvailable };
