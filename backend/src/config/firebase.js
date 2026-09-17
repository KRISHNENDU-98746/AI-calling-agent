const admin = require('firebase-admin');
const { env } = require('./env');

let firestore = null;
let initAttempted = false;
let initError = null;

function hasFirebaseCredentials() {
  return Boolean(
    env.firebase.projectId && env.firebase.clientEmail && env.firebase.privateKey
  );
}

function initFirebase() {
  if (firestore) return firestore;
  if (initAttempted) {
    if (initError) throw initError;
    return firestore;
  }

  initAttempted = true;

  if (!hasFirebaseCredentials()) {
    initError = new Error(
      'Firebase is not configured. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY.'
    );
    throw initError;
  }

  try {
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: env.firebase.projectId,
          clientEmail: env.firebase.clientEmail,
          privateKey: env.firebase.privateKey,
        }),
        projectId: env.firebase.projectId,
      });
    }

    firestore = admin.firestore();
    return firestore;
  } catch (error) {
    initError = error;
    console.error('[firebase] Initialization failed:', error.message);
    throw error;
  }
}

function getFirestore() {
  return initFirebase();
}

function isFirebaseReady() {
  try {
    initFirebase();
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  getFirestore,
  isFirebaseReady,
  hasFirebaseCredentials,
  admin,
};
