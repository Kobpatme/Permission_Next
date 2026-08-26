const { spawnSync } = require('child_process');
const path = require('path');

const rawUpdateUrl = process.argv[2] || process.env.PERMISSION_NEXT_UPDATE_URL || '';
let updateUrl;

try {
  updateUrl = new URL(rawUpdateUrl);
  if (!['http:', 'https:'].includes(updateUrl.protocol)) throw new Error('unsupported protocol');
} catch {
  console.error(
    'กรุณาระบุ URL โฟลเดอร์อัปเดตก่อน build\n' +
    'ตัวอย่าง: npm run dist -- https://updates.company.local/permission-next/'
  );
  process.exit(1);
}

if (updateUrl.protocol !== 'https:') {
  console.warn('คำเตือน: ควรใช้ HTTPS สำหรับเซิร์ฟเวอร์อัปเดตในระบบจริง');
}

const electronBuilderCli = require.resolve('electron-builder/out/cli/cli.js');
const buildEnv = {
  ...process.env,
  electron_config_cache: process.env.electron_config_cache || path.join(process.cwd(), '.electron-cache'),
  ELECTRON_BUILDER_CACHE: process.env.ELECTRON_BUILDER_CACHE || path.join(process.cwd(), '.electron-builder-cache')
};
const result = spawnSync(process.execPath, [
  electronBuilderCli,
  '--win',
  'nsis',
  '--config.directories.output=dist-installer',
  '--config.publish.provider=generic',
  `--config.publish.url=${updateUrl.href}`
], {
  cwd: process.cwd(),
  env: buildEnv,
  stdio: 'inherit'
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
