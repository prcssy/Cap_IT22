import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore, collection, doc, getDoc, getDocs } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import { getFunctions } from 'firebase/functions';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';

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
  app = initializeApp(firebaseConfig);

  const recaptchaSiteKey = import.meta.env.VITE_FIREBASE_RECAPTCHA_SITE_KEY;
  if (recaptchaSiteKey) {
    // Lets App Check attest from localhost/LAN dev (vite.config.js sets
    // server.host: true) without a real reCAPTCHA pass — register the
    // token this logs to the console as a debug token in Firebase Console
    // > App Check > Apps > (this app) > Manage debug tokens.
    if (import.meta.env.DEV) {
      // crypto.randomUUID only exists in secure contexts (HTTPS/localhost);
      // over plain-HTTP LAN dev (http://192.168.x.x) App Check's debug-token
      // generation would otherwise throw and every callable would fail.
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID !== 'function') {
        crypto.randomUUID = () => {
          const b = crypto.getRandomValues(new Uint8Array(16));
          b[6] = (b[6] & 0x0f) | 0x40;
          b[8] = (b[8] & 0x3f) | 0x80;
          const h = Array.from(b, (x) => x.toString(16).padStart(2, '0'));
          return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10).join('')}`;
        };
      }
      self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
    }
    initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(recaptchaSiteKey),
      isTokenAutoRefreshEnabled: true,
    });
  } else {
    console.warn(
      'VITE_FIREBASE_RECAPTCHA_SITE_KEY not set — App Check is not active for this session.'
    );
  }

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