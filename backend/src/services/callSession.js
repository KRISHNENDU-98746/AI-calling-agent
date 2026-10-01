const { getFirestore } = require('../config/firebase');

const memorySessions = new Map();

function sessionIdFor({ callSid, conversationId }) {
  return String(callSid || conversationId);
}

async function startCallSession(meta) {
  const id = sessionIdFor(meta);
  const session = {
    callId: id,
    conversationId: meta.conversationId || null,
    callSid: meta.callSid || null,
    callerPhone: meta.callerPhone || null,
    status: 'live',
    transcript: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  memorySessions.set(id, session);
  try { await getFirestore().collection('callSessions').doc(id).set(session, { merge: true }); } catch (error) { console.warn(`[call-session] persistence unavailable: ${error.message}`); }
  return id;
}

async function appendTranscript({ callId, speaker = 'user', text }) {
  if (!callId || !text) return;
  const item = { speaker, text: String(text).trim(), at: new Date().toISOString() };
  const cached = memorySessions.get(callId);
  if (cached) { cached.transcript.push(item); cached.updatedAt = item.at; }
  try {
    const db = getFirestore();
    await db.runTransaction(async (tx) => {
      const ref = db.collection('callSessions').doc(callId);
      const snap = await tx.get(ref);
      const current = snap.exists ? snap.data() : { callId, transcript: [] };
      tx.set(ref, { ...current, transcript: [...(current.transcript || []), item], updatedAt: item.at }, { merge: true });
    });
  } catch (error) { console.warn(`[call-session] transcript persistence failed: ${error.message}`); }
}

async function finishCallSession({ callId }) {
  if (!callId) return;
  const now = new Date().toISOString();
  const job = { jobId: callId, callId, status: 'queued', createdAt: now, updatedAt: now, attempts: 0 };
  const cached = memorySessions.get(callId);
  if (cached) { cached.status = 'completed'; cached.updatedAt = now; }
  try {
    const db = getFirestore();
    const sessionRef = db.collection('callSessions').doc(callId);
    const jobRef = db.collection('postCallJobs').doc(callId);
    await db.runTransaction(async (tx) => {
      const existingJob = await tx.get(jobRef);
      if (!existingJob.exists) tx.set(jobRef, job);
      tx.set(sessionRef, { status: 'completed', endedAt: now, updatedAt: now }, { merge: true });
    });
  } catch (error) { console.warn(`[call-session] post-call job enqueue failed: ${error.message}`); }
}

module.exports = { startCallSession, appendTranscript, finishCallSession, sessionIdFor };
