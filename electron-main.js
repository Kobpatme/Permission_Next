const { app, BrowserWindow, Menu, dialog, shell, session, ipcMain } = require('electron');
const path = require('path');
const crypto = require('crypto');
const { autoUpdater } = require('electron-updater');

let mainWindow;
let localServer;
let updateCheckPromise = null;
let localOrigin = null;
let updateState = {
  status: 'initializing',
  currentVersion: app.getVersion(),
  availableVersion: null,
  percent: 0,
  supported: false,
  message: 'กำลังเตรียมระบบอัปเดต'
};

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  // Start one embedded local NAS bridge and wait until it is ready before loading the UI.
  process.env.DEV_HOST = '127.0.0.1';
  // Let Windows allocate a free loopback port to avoid EADDRINUSE failures.
  process.env.PORT = '0';
  process.env.PERMISSION_BRIDGE_TOKEN = crypto.randomBytes(32).toString('base64url');
  process.env.NAS_ALLOW_UPLOAD = '1';
  // The desktop app must read documents only from this approved mapped-drive folder.
  process.env.NAS_BUILDING_ROOT = 'P:\\BBG\\Outside Plant&Coordination\\!!!_Data Base Building Drawing';
  localServer = require('./dev-server.js');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Permission Next',
    icon: path.join(__dirname, 'assets', 'uih-logo.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      sandbox: true,
      preload: path.join(__dirname, 'electron-preload.js')
    }
  });

  Menu.setApplicationMenu(null);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:|mailto:|tel:)/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (localOrigin && url.startsWith(localOrigin + '/')) return;
    event.preventDefault();
    if (/^(https?:|mailto:|tel:)/i.test(url)) shell.openExternal(url);
  });

  mainWindow.loadURL(
    `${localOrigin}/Permission_Next.html?bridge=${encodeURIComponent(localServer.bridgeToken)}`
  );

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function updateMessageForError(error) {
  const raw = String(error?.message || error || 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ');
  if (/net::ERR_NAME_NOT_RESOLVED|ENOTFOUND/i.test(raw)) return 'ไม่พบเซิร์ฟเวอร์อัปเดต กรุณาตรวจสอบเครือข่ายบริษัท';
  if (/net::ERR_INTERNET_DISCONNECTED|ENETUNREACH|EHOSTUNREACH/i.test(raw)) return 'ยังเชื่อมต่อเครือข่ายสำหรับอัปเดตไม่ได้';
  if (/403|401|unauthorized|forbidden/i.test(raw)) return 'ไม่มีสิทธิ์เข้าถึงไฟล์อัปเดต';
  return raw.replace(/https?:\/\/[^\s]+/gi, 'เซิร์ฟเวอร์อัปเดต').slice(0, 220);
}

function publishUpdateState(patch = {}) {
  updateState = { ...updateState, ...patch, currentVersion: app.getVersion() };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updates:state', updateState);
  }
  return updateState;
}

function isTrustedUpdateRequest(event) {
  try {
    return Boolean(localOrigin) && new URL(event.senderFrame.url).origin === localOrigin;
  } catch {
    return false;
  }
}

async function checkForAppUpdates(source = 'manual') {
  if (!updateState.supported) return updateState;
  if (updateCheckPromise) return updateCheckPromise;

  publishUpdateState({
    status: 'checking',
    percent: 0,
    message: source === 'automatic' ? 'กำลังตรวจสอบเวอร์ชันล่าสุด' : 'กำลังตรวจสอบอัปเดต'
  });

  updateCheckPromise = autoUpdater.checkForUpdates()
    .catch(error => publishUpdateState({
      status: 'error',
      message: updateMessageForError(error)
    }))
    .finally(() => {
      updateCheckPromise = null;
    });

  await updateCheckPromise;
  return updateState;
}

function configureAutoUpdater() {
  const isPortable = Boolean(process.env.PORTABLE_EXECUTABLE_FILE);
  if (!app.isPackaged || isPortable) {
    publishUpdateState({
      status: isPortable ? 'portable' : 'development',
      supported: false,
      message: isPortable
        ? 'รุ่น Portable ใช้อัปเดตอัตโนมัติไม่ได้ กรุณาติดตั้งรุ่น Setup'
        : 'ระบบอัปเดตจะทำงานในโปรแกรมรุ่นติดตั้ง'
    });
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('checking-for-update', () => publishUpdateState({
    status: 'checking',
    message: 'กำลังตรวจสอบเวอร์ชันล่าสุด'
  }));
  autoUpdater.on('update-available', info => publishUpdateState({
    status: 'available',
    supported: true,
    availableVersion: info.version,
    percent: 0,
    message: `พบเวอร์ชัน ${info.version} กำลังเริ่มดาวน์โหลด`
  }));
  autoUpdater.on('update-not-available', () => publishUpdateState({
    status: 'up-to-date',
    supported: true,
    availableVersion: null,
    percent: 0,
    message: 'คุณใช้เวอร์ชันล่าสุดแล้ว'
  }));
  autoUpdater.on('download-progress', progress => publishUpdateState({
    status: 'downloading',
    supported: true,
    percent: Math.max(0, Math.min(100, Number(progress.percent) || 0)),
    message: `กำลังดาวน์โหลด ${Math.round(Number(progress.percent) || 0)}%`
  }));
  autoUpdater.on('update-downloaded', info => publishUpdateState({
    status: 'downloaded',
    supported: true,
    availableVersion: info.version,
    percent: 100,
    message: 'ดาวน์โหลดเสร็จแล้ว พร้อมติดตั้ง'
  }));
  autoUpdater.on('error', error => publishUpdateState({
    status: 'error',
    supported: true,
    message: updateMessageForError(error)
  }));

  publishUpdateState({
    status: 'idle',
    supported: true,
    message: 'พร้อมตรวจสอบอัปเดต'
  });

  setTimeout(() => checkForAppUpdates('automatic'), 8000);
}

ipcMain.handle('updates:get-state', event => {
  if (!isTrustedUpdateRequest(event)) throw new Error('Untrusted update request');
  return updateState;
});

ipcMain.handle('updates:check', event => {
  if (!isTrustedUpdateRequest(event)) throw new Error('Untrusted update request');
  return checkForAppUpdates('manual');
});

ipcMain.handle('updates:install', event => {
  if (!isTrustedUpdateRequest(event)) throw new Error('Untrusted update request');
  if (updateState.status !== 'downloaded') return false;
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return true;
});

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  try {
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    const serverAddress = await localServer.ready;
    localOrigin = `http://${serverAddress.host}:${serverAddress.port}`;
    createWindow();
    configureAutoUpdater();
  } catch (error) {
    dialog.showErrorBox(
      'Permission Next เปิดไม่สำเร็จ',
      `ไม่สามารถเริ่ม local server ได้\n${error.message}`
    );
    app.quit();
    return;
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
