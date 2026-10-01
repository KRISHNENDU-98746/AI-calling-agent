const { getFirestore } = require('../config/firebase');
const { extractPostCallData } = require('./postCallExtraction');
const { env } = require('../config/env');

let timer = null;
let running = false;

async function processOnePostCallJob() {
  if (running) return false;
  running = true;
  try {
    const db = getFirestore();
    const jobs = await db.collection('postCallJobs').where('status', '==', 'queued').limit(1).get();
    if (jobs.empty) return false;
    const jobRef = jobs.docs[0].ref;
    let job;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(jobRef);
      if (!snap.exists || snap.data().status !== 'queued') return;
      job = snap.data();
      tx.update(jobRef, { status: 'processing', attempts: (job.attempts || 0) + 1, updatedAt: new Date().toISOString() });
    });
    if (!job) return false;
    try {
      const sessionSnap = await db.collection('callSessions').doc(job.callId).get();
      const transcript = sessionSnap.data()?.transcript || [];
      const extracted = await extractPostCallData(transcript);
      // Store the validated extraction separately. Do not coerce one free-form
      // appointment_request into both required appointment date/time fields.
      // The existing live flow remains the only path that creates an appointment.
      await db.collection('postCallRecords').doc(job.callId).set({
        callId: job.callId,
        ...extracted,
        status: 'needs_review',
        reason: 'Post-call extraction has one free-form appointment_request; separate date/time confirmation is required.',
        createdAt: new Date().toISOString(),
      }, { merge: true });
      await jobRef.update({ status: 'completed', extracted, requiresReview: true, updatedAt: new Date().toISOString() });
      await db.collection('callSessions').doc(job.callId).set({ processingStatus: 'completed', extracted, requiresReview: true }, { merge: true });
    } catch (error) {
      console.error(`[post-call] ${job.callId} failed: ${error.message}`);
      await jobRef.update({ status: 'needs_review', error: error.message, updatedAt: new Date().toISOString() });
      await db.collection('callSessions').doc(job.callId).set({ processingStatus: 'needs_review', processingError: error.message }, { merge: true });
    }
    return true;
  } finally { running = false; }
}

function startPostCallWorker() {
  if (timer || !env.postCall.enabled) return;
  const pollMs = Math.max(1000, env.postCall.pollMs);
  timer = setInterval(() => processOnePostCallJob().catch((error) => console.error('[post-call] worker error:', error.message)), pollMs);
  timer.unref?.();
  console.log(`[post-call] worker started pollMs=${pollMs}`);
}

module.exports = { startPostCallWorker, processOnePostCallJob };
