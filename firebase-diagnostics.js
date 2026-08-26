(function setupFirebaseDiagnostics() {
  window.FSDB_ERROR = null;

  function rememberFirebaseError(value) {
    const message = String(value?.message || value || 'Firebase initialization failed');
    window.FSDB_ERROR = message;
    console.error('Permission Next database initialization failed:', message);
  }

  window.addEventListener('error', event => {
    const source = String(event.filename || '');
    const message = String(event.message || '');
    if (/firebase/i.test(source) || /firebase|firestore|module script/i.test(message)) {
      rememberFirebaseError(event.error || message);
    }
  });

  window.addEventListener('unhandledrejection', event => {
    const message = String(event.reason?.message || event.reason || '');
    if (/firebase|firestore|module/i.test(message)) rememberFirebaseError(event.reason || message);
  });
})();
