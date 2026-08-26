const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');
const bridgeToken = 'permission-next-test-bridge-token';

function makeFolder(root, region, building, fileName) {
  const folder = path.join(root, region, building);
  fs.mkdirSync(folder, { recursive: true });
  if (fileName) fs.writeFileSync(path.join(folder, fileName), 'test');
  return folder;
}

function makeProvinceFolder(root, region, province, building, fileName) {
  const folder = path.join(root, region, province, building);
  fs.mkdirSync(folder, { recursive: true });
  if (fileName) fs.writeFileSync(path.join(folder, fileName), 'test');
  return folder;
}

async function waitForServer(child) {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Test server did not start')), 10_000);
    child.stdout.on('data', chunk => {
      if (!String(chunk).includes('Permission Next dev server:')) return;
      clearTimeout(timeout);
      resolve();
    });
    child.once('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`Test server exited with code ${code}`));
    });
  });
}

test('document folders use exact names and stop on ambiguous matches', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-next-map-'));
  const port = 18_766;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  makeFolder(root, 'Region 1', 'อาคาร เอ็กแซ็กท์ พลาซ่า', 'exact.pdf');
  makeFolder(root, 'Region 1', 'Duplicate Center', 'one.pdf');
  makeFolder(root, 'Region 2', 'Duplicate Center', 'two.pdf');
  makeFolder(root, 'Region 1', 'Area Center BKK', 'bkk.pdf');
  makeFolder(root, 'Region 2', 'Area Center CBI', 'cbi.pdf');
  makeFolder(root, 'Region 3', 'SET North Park', 'english.pdf');
  makeFolder(root, 'Region 4', 'อาคาร ไอทีสแควร์หลักสี่ (IT SQUARE) (BKK2)', 'it-square.dwg');
  makeFolder(root, 'Region 5', 'อาคาร วานิชเพลซ อารีย์ Vanit Place Aree (BKK2)', 'vanit.pdf');
  makeFolder(root, 'Region 6', 'ท่าอากาศยานนานาชาติสมุย (SIN)', 'samui.dwg');
  makeProvinceFolder(
    root,
    '4.ภาคตะวันออก',
    'ชลบุรี',
    'อาคาร แหลมทอง บางแสน (SAVELAND)(ชลบุรี)',
    'laemtong.pdf'
  );

  const child = spawn(process.execPath, ['dev-server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      NAS_BUILDING_ROOT: root,
      PERMISSION_BRIDGE_TOKEN: bridgeToken,
      NAS_ALLOW_UPLOAD: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => child.kill());
  await waitForServer(child);

  const request = params => fetch(
    `http://127.0.0.1:${port}/api/nas/building-documents?${new URLSearchParams(params)}`,
    { headers: { Authorization: `Bearer ${bridgeToken}` } }
  );

  const unauthorized = await fetch(`http://127.0.0.1:${port}/api/nas/building-documents?nameEng=test`);
  assert.equal(unauthorized.status, 401);

  const privateProjectFile = await fetch(`http://127.0.0.1:${port}/package.json`);
  assert.equal(privateProjectFile.status, 403);

  const exact = await request({ nameTh: 'เอ็กแซ็กท์ พลาซ่า', area: '' });
  assert.equal(exact.status, 200);
  assert.deepEqual((await exact.json()).files.map(file => file.name), ['exact.pdf']);

  const partial = await request({ nameTh: 'เอ็กแซ็กท์', area: '' });
  assert.equal(partial.status, 404);

  const ambiguous = await request({ nameEng: 'Duplicate Center', area: '' });
  assert.equal(ambiguous.status, 409);
  assert.equal((await ambiguous.json()).code, 'AMBIGUOUS_BUILDING_FOLDER');

  const area = await request({ nameEng: 'Area Center', area: 'BKK' });
  assert.equal(area.status, 200);
  assert.deepEqual((await area.json()).files.map(file => file.name), ['bkk.pdf']);

  const englishFallback = await request({
    nameTh: 'ตลาดหลักทรัพย์ นอร์ทปาร์ค',
    nameEng: 'SET North Park',
    area: ''
  });
  assert.equal(englishFallback.status, 200);
  assert.deepEqual((await englishFallback.json()).files.map(file => file.name), ['english.pdf']);

  const bilingualAlias = await request({
    nameTh: 'ไอที สแควร์',
    nameEng: 'IT Square',
    area: 'BKK2'
  });
  assert.equal(bilingualAlias.status, 200);
  assert.deepEqual((await bilingualAlias.json()).files.map(file => file.name), ['it-square.dwg']);

  const inlineBilingualAlias = await request({
    nameTh: 'อาคาร วานิชเพลซ อารีย์',
    nameEng: 'Vanit Place Aree',
    area: 'BKK2'
  });
  assert.equal(inlineBilingualAlias.status, 200);
  assert.deepEqual((await inlineBilingualAlias.json()).files.map(file => file.name), ['vanit.pdf']);

  const legacySamuiArea = await request({
    nameTh: 'ท่าอากาศยานนานาชาติสมุย',
    nameEng: 'Samui International Airport',
    area: 'SNI'
  });
  assert.equal(legacySamuiArea.status, 200);
  assert.deepEqual((await legacySamuiArea.json()).files.map(file => file.name), ['samui.dwg']);

  makeFolder(root, 'Region 7', 'Newly Added Building', 'new.pdf');
  const refreshedAfterMiss = await request({ nameEng: 'Newly Added Building', area: '' });
  assert.equal(refreshedAfterMiss.status, 200);
  assert.deepEqual((await refreshedAfterMiss.json()).files.map(file => file.name), ['new.pdf']);

  const provinceLevel = await request({
    nameTh: 'อาคาร แหลมทอง บางแสน (SAVELAND)(ชลบุรี)',
    nameEng: 'LAEMTONG Shopping Plaza BANGSAEN',
    area: ''
  });
  assert.equal(provinceLevel.status, 200);
  assert.deepEqual((await provinceLevel.json()).files.map(file => file.name), ['laemtong.pdf']);

  const upload = await fetch(
    `http://127.0.0.1:${port}/api/nas/building-documents/upload?${new URLSearchParams({
      nameEng: 'Duplicate Center',
      fileName: 'must-not-write.pdf'
    })}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bridgeToken}`,
        'X-Permission-Document-Upload': '1'
      },
      body: Buffer.from('must not be written')
    }
  );
  assert.equal(upload.status, 409);
  assert.equal((await upload.json()).code, 'AMBIGUOUS_BUILDING_FOLDER');
  assert.equal(fs.existsSync(path.join(root, 'Region 1', 'Duplicate Center', 'must-not-write.pdf')), false);
  assert.equal(fs.existsSync(path.join(root, 'Region 2', 'Duplicate Center', 'must-not-write.pdf')), false);
});

test('LAN bridge is token-gated, file-allowlisted, and read-only by default', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-next-readonly-'));
  const port = 18_767;
  const token = 'permission-next-readonly-test-token';
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  makeFolder(root, 'Region 1', 'Read Only Center', 'existing.pdf');
  const child = spawn(process.execPath, ['dev-server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      DEV_HOST: '127.0.0.1',
      PORT: String(port),
      NAS_BUILDING_ROOT: root,
      PERMISSION_BRIDGE_TOKEN: token,
      NAS_ALLOW_UPLOAD: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => child.kill());
  await waitForServer(child);

  const publicPage = await fetch(`http://127.0.0.1:${port}/Permission_Next.html`);
  assert.equal(publicPage.status, 200);
  const csp = publicPage.headers.get('content-security-policy') || '';
  assert.match(csp, /default-src 'self'/);
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);

  for (const privatePath of ['/package.json', '/README.md', '/backups/private.xlsx']) {
    assert.equal((await fetch(`http://127.0.0.1:${port}${privatePath}`)).status, 403);
  }

  const apiUrl = `http://127.0.0.1:${port}/api/nas/building-documents?nameEng=Read+Only+Center`;
  assert.equal((await fetch(apiUrl)).status, 401);
  assert.equal((await fetch(apiUrl, { headers: { Authorization: `Bearer ${token}` } })).status, 200);

  const upload = await fetch(
    `http://127.0.0.1:${port}/api/nas/building-documents/upload?nameEng=Read+Only+Center&fileName=blocked.pdf`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Permission-Document-Upload': '1'
      },
      body: Buffer.from('must remain read only')
    }
  );
  assert.equal(upload.status, 403);
  assert.equal(fs.existsSync(path.join(root, 'Region 1', 'Read Only Center', 'blocked.pdf')), false);
});
