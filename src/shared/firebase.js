import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore, collection, doc, getDoc, getDocs } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import { getFunctions } from 'firebase/functions';

const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID,
};

const missingFirebaseConfig = Object.entries(firebaseConfig)
  .filter(([, value]) => !value)
  .map(([key]) => key);

if (missingFirebaseConfig.length) {
  console.warn(
    'Missing Firebase config values for:',
    missingFirebaseConfig.join(', '),
    'Please check your .env file.'
  );
}

let app;
let auth;
let db;
let storage;
let functions;

try {
  app       = initializeApp(firebaseConfig);
  auth      = getAuth(app);
  db        = getFirestore(app);
  storage   = getStorage(app);
  functions = getFunctions(app);
} catch (error) {
  console.warn('Firebase initialization failed.', error);
}

// Dev-only console access, e.g. `await auth.currentUser.getIdTokenResult()`
// to inspect custom claims. Gated behind import.meta.env.DEV so it never
// ships in the production bundle.
if (import.meta.env.DEV && auth) {
  window.auth = auth;
  window.db = db;
  window.collection = collection;
  window.doc = doc;
  window.getDoc = getDoc;
  window.getDocs = getDocs;
}

export { auth, db, storage, functions };