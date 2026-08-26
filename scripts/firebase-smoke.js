const { app, BrowserWindow } = require('electron');

const targetUrl = process.argv[2];
if (!targetUrl) throw new Error('Usage: electron scripts/firebase-smoke.js <url>');

app.whenReady().then(() => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  window.webContents.on('console-message', (_event, details) => {
    console.log(`[browser:${details.level}] ${details.message}`);
  });
  window.webContents.on('did-fail-load', (_event, code, description) => {
    console.error(`LOAD_FAILED ${code}: ${description}`);
  });
  window.webContents.on('did-finish-load', () => {
    setTimeout(async () => {
      const result = await window.webContents.executeJavaScript(`({
        ready: Boolean(window.FSDB),
        error: window.FSDB_ERROR || null,
        title: document.title
      })`);
      console.log(`FIREBASE_SMOKE ${JSON.stringify(result)}`);
      app.exit(result.ready ? 0 : 1);
    }, 3000);
  });
  window.loadURL(targetUrl);
});
