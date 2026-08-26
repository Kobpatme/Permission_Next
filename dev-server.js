const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const HOST = process.env.DEV_HOST || '127.0.0.1';
const requestedPort = Number(process.env.PERMISSION_NEXT_PORT ?? process.env.PORT);
// Port 0 asks Windows for an available ephemeral port. The desktop app uses
// this mode so it cannot collide with a stale process or another local service.
const PORT = Number.isInteger(requestedPort) && requestedPort >= 0 && requestedPort <= 65535
  ? requestedPort
  : 8766;
const WEB_ROOT = __dirname;
const BRIDGE_TOKEN = process.env.PERMISSION_BRIDGE_TOKEN || crypto.randomBytes(32).toString('base64url');
const ALLOW_UPLOAD = process.env.NAS_ALLOW_UPLOAD === '1';
const NAS_ROOT = process.env.NAS_BUILDING_ROOT
  || 'P:\\BBG\\Outside Plant&Coordination\\!!!_Data Base Building Drawing';
const INDEX_TTL_MS = 10 * 60_000;
const MISS_REFRESH_COOLDOWN_MS = 5_000;
const DOWNLOAD_TOKEN_TTL_MS = 15 * 60_000;
const MAX_UPLOAD_FILE_BYTES = 100 * 1024 * 1024;
const AREA_TOKEN_PATTERN = '(?:BKK|CMI|CBI|RYG|PKT|SNI|SIN)\\d*';
const THAI_PROVINCES = new Set(`
กรุงเทพมหานคร กระบี่ กาญจนบุรี กาฬสินธุ์ กำแพงเพชร ขอนแก่น จันทบุรี ฉะเชิงเทรา ชลบุรี
ชัยนาท ชัยภูมิ ชุมพร เชียงราย เชียงใหม่ ตรัง ตราด ตาก นครนายก นครปฐม นครพนม
นครราชสีมา นครศรีธรรมราช นครสวรรค์ นนทบุรี นราธิวาส น่าน บึงกาฬ บุรีรัมย์ ปทุมธานี
ประจวบคีรีขันธ์ ปราจีนบุรี ปัตตานี พระนครศรีอยุธยา พะเยา พังงา พัทลุง พิจิตร พิษณุโลก
เพชรบุรี เพชรบูรณ์ แพร่ ภูเก็ต มหาสารคาม มุกดาหาร แม่ฮ่องสอน ยโสธร ยะลา ร้อยเอ็ด
ระนอง ระยอง ราชบุรี ลพบุรี ลำปาง ลำพูน เลย ศรีสะเกษ สกลนคร สงขลา สตูล
สมุทรปราการ สมุทรสงคราม สมุทรสาคร สระแก้ว สระบุรี สิงห์บุรี สุโขทัย สุพรรณบุรี
สุราษฎร์ธานี สุรินทร์ หนองคาย หนองบัวลำภู อ่างทอง อำนาจเจริญ อุดรธานี อุตรดิตถ์
อุทัยธานี อุบลราชธานี
`.trim().split(/\s+/u));
const DEFAULT_ALLOWED_ORIGINS = [
  'https://permission-next.pages.dev',
  'https://kobpatme.github.io'
];
const ALLOWED_ORIGINS = new Set([
  ...DEFAULT_ALLOWED_ORIGINS,
  ...String(process.env.NAS_BRIDGE_ALLOWED_ORIGINS || '').split(',')
].map(origin => origin.trim().replace(/\/$/, '')).filter(Boolean));
const SUPPORTED_EXTENSIONS = new Map([
  ['.dwg', 'dwg'], ['.pdf', 'pdf'], ['.jpg', 'image'], ['.jpeg', 'image'],
  ['.png', 'image'], ['.webp', 'image'], ['.gif', 'image'], ['.tif', 'image'],
  ['.tiff', 'image'], ['.bmp', 'image'], ['.heic', 'image'], ['.heif', 'image']
]);
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.pdf': 'application/pdf',
  '.svg': 'image/svg+xml'
};
const PUBLIC_WEB_FILES = new Set([
  'Permission_Next.html', 'app.js', 'ui.js', 'style.css', 'firebase-init.js', 'firebase-diagnostics.js',
  'quotation-engine.js', 'index.html', '_headers', 'assets/uih-logo.png',
  'assets/vendor/firebase/firebase-app.js',
  'assets/vendor/firebase/firebase-firestore.js',
  'assets/vendor/export/html2canvas.min.js',
  'assets/vendor/export/jspdf.umd.min.js',
  'assets/vendor/leaflet/leaflet.css',
  'assets/vendor/leaflet/leaflet.js',
  'assets/vendor/leaflet/images/layers-2x.png',
  'assets/vendor/leaflet/images/layers.png',
  'assets/vendor/leaflet/images/marker-icon-2x.png',
  'assets/vendor/leaflet/images/marker-icon.png',
  'assets/vendor/leaflet/images/marker-shadow.png',
  'assets/vendor/leaflet-markercluster/leaflet.markercluster.js',
  'assets/vendor/leaflet-markercluster/MarkerCluster.css',
  'assets/vendor/leaflet-markercluster/MarkerCluster.Default.css'
]);

let folderIndex = [];
let folderIndexAt = 0;
let folderIndexPromise = null;
const missRefreshTimes = new Map();
const downloadTokens = new Map();
let resolveReady;
let rejectReady;
const ready = new Promise((resolve, reject) => {
  resolveReady = resolve;
  rejectReady = reject;
});

function isLoopbackOrigin(origin) {
  try {
    const url = new URL(origin);
    return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

function isPermissionPagesOrigin(origin) {
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' && (
      url.hostname === 'permission-next.pages.dev'
      || url.hostname.endsWith('.permission-next.pages.dev')
    );
  } catch {
    return false;
  }
}

function corsHeaders(req) {
  const origin = String(req.headers.origin || '').replace(/\/$/, '');
  if (!origin || (!ALLOWED_ORIGINS.has(origin) && !isLoopbackOrigin(origin) && !isPermissionPagesOrigin(origin))) return {};
  const headers = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Permission-Document-Upload, X-Permission-Upload-User',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
  if (String(req.headers['access-control-request-private-network']).toLowerCase() === 'true') {
    headers['Access-Control-Allow-Private-Network'] = 'true';
  }
  return headers;
}

function isOriginAllowed(req) {
  const origin = String(req.headers.origin || '').replace(/\/$/, '');
  return !origin || ALLOWED_ORIGINS.has(origin) || isLoopbackOrigin(origin) || isPermissionPagesOrigin(origin);
}

function isTrustedDeployedOriginRequest(req) {
  const origin = String(req.headers.origin || '').replace(/\/$/, '');
  return Boolean(origin) && (ALLOWED_ORIGINS.has(origin) || isPermissionPagesOrigin(origin));
}

function createDownloadUrl(fullPath) {
  const now = Date.now();
  for (const [token, entry] of downloadTokens) {
    if (entry.expiresAt <= now) downloadTokens.delete(token);
  }
  const token = crypto.randomUUID();
  downloadTokens.set(token, { fullPath, expiresAt: now + DOWNLOAD_TOKEN_TTL_MS });
  return '/api/nas/download?token=' + encodeURIComponent(token)
    + '&access=' + encodeURIComponent(BRIDGE_TOKEN);
}

function safeTokenEquals(candidate) {
  const supplied = Buffer.from(String(candidate || ''));
  const expected = Buffer.from(BRIDGE_TOKEN);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function isAuthorizedRequest(req, requestUrl) {
  const authorization = String(req.headers.authorization || '');
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  return safeTokenEquals(bearer || requestUrl.searchParams.get('access'));
}

function normalizeBuildingName(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    // Folder names are not consistent: some include "อาคาร", "Building",
    // or an area suffix while the Firestore name fields do not.
    .replace(/^(?:อาคาร|building|bldg\.?)\s*/iu, '')
    .replace(new RegExp(`\\s*(?:\\(${AREA_TOKEN_PATTERN}\\)|\\[${AREA_TOKEN_PATTERN}\\]|\\{${AREA_TOKEN_PATTERN}\\})\\s*$`, 'iu'), '')
    .replace(new RegExp(`(?:\\s|[-_.])${AREA_TOKEN_PATTERN}\\s*$`, 'iu'), '')
    // Keep Unicode letters, marks, and numbers so Thai vowels/tone marks and
    // non-ASCII English names are not accidentally discarded.
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
}

function exactBuildingAliases(value) {
  const rawName = String(value || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '');
  const aliases = new Set();
  const addAlias = alias => {
    const normalized = normalizeBuildingName(alias);
    if (normalized) aliases.add(normalized);
  };
  const addScriptAliases = alias => {
    const thaiAlias = String(alias || '').replace(/[^\p{Script=Thai}\p{M}\p{N}]+/gu, ' ');
    const latinAlias = String(alias || '').replace(/[^\p{Script=Latin}\p{M}\p{N}]+/gu, ' ');
    if (/\p{Script=Thai}/u.test(thaiAlias)) addAlias(thaiAlias);
    if (/\p{Script=Latin}/u.test(latinAlias)) addAlias(latinAlias);
  };

  addAlias(rawName);
  const bracketPattern = /[([{]([^()[\]{}]+)[)\]}]/gu;
  for (const match of rawName.matchAll(bracketPattern)) {
    const bracketValue = match[1].trim();
    if (new RegExp(`^${AREA_TOKEN_PATTERN}$`, 'iu').test(bracketValue)) continue;
    addAlias(bracketValue);
  }
  const withoutBrackets = rawName.replace(bracketPattern, ' ');
  addAlias(withoutBrackets);
  // NAS folders often contain both languages in one name, for example
  // "อาคาร วานิชเพลซ อารีย์ Vanit Place Aree (BKK2)". Treat each script as
  // an exact alias instead of falling back to unsafe substring matching.
  addScriptAliases(withoutBrackets);
  return aliases;
}

function normalizeArea(value) {
  const normalized = String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  // Some legacy NAS folders use SIN for the Samui area whose application code is SNI.
  return normalized.replace(/^SIN(?=\d*$)/, 'SNI');
}

function areaFromFolderName(folderName) {
  const areaPattern = new RegExp(`(?:^|[^a-z0-9])(${AREA_TOKEN_PATTERN})(?=$|[^a-z0-9])`, 'i');
  return normalizeArea(String(folderName || '').match(areaPattern)?.[1] || '');
}

function isProvinceFolder(folderName) {
  const normalized = String(folderName || '')
    .normalize('NFKC')
    .replace(/^[\s\d._-]+/u, '')
    .replace(/^(?:จังหวัด|จ\.?)[\s._-]*/u, '')
    .replace(/[^\p{L}\p{M}]+/gu, '');
  return THAI_PROVINCES.has(normalized);
}

async function directoryEntries(directoryPath) {
  try {
    return await fs.promises.readdir(directoryPath, { withFileTypes: true });
  } catch (cause) {
    const isRoot = path.resolve(directoryPath) === path.resolve(NAS_ROOT);
    const error = new Error(isRoot
      ? 'ไม่สามารถเข้าถึงแหล่งเอกสาร NAS ได้ กรุณาตรวจสอบการเชื่อมต่อหรือสิทธิ์ของ NAS Bridge'
      : 'อ่านรายการโฟลเดอร์จาก NAS ไม่สำเร็จ กรุณาลองใหม่');
    error.code = isRoot ? 'NAS_ROOT_UNAVAILABLE' : 'NAS_DIRECTORY_UNAVAILABLE';
    error.cause = cause;
    throw error;
  }
}

async function buildFolderIndex() {
  const rootEntries = await directoryEntries(NAS_ROOT);
  if (!rootEntries.length) {
    const error = new Error('ไม่สามารถเข้าถึงแหล่งเอกสาร NAS ได้');
    error.code = 'NAS_ROOT_UNAVAILABLE';
    throw error;
  }

  const regionCandidates = await Promise.all(rootEntries.filter(item => item.isDirectory()).map(async entry => {
    const fullPath = path.join(NAS_ROOT, entry.name);
    const candidates = [{
      name: entry.name,
      relativePath: entry.name,
      fullPath,
      depth: 1,
      area: areaFromFolderName(entry.name)
    }];

    const children = await directoryEntries(fullPath);
    const childDirectories = children.filter(item => item.isDirectory());
    for (const child of childDirectories) {
      candidates.push({
        name: child.name,
        relativePath: path.join(entry.name, child.name),
        fullPath: path.join(fullPath, child.name),
        depth: 2,
        area: areaFromFolderName(child.name) || areaFromFolderName(entry.name)
      });
    }
    const provinceCandidates = await Promise.all(
      childDirectories.filter(child => isProvinceFolder(child.name)).map(async province => {
        const provincePath = path.join(fullPath, province.name);
        const buildings = await directoryEntries(provincePath);
        return buildings.filter(item => item.isDirectory()).map(building => ({
          name: building.name,
          relativePath: path.join(entry.name, province.name, building.name),
          fullPath: path.join(provincePath, building.name),
          depth: 3,
          area: areaFromFolderName(building.name)
            || areaFromFolderName(province.name)
            || areaFromFolderName(entry.name)
        }));
      })
    );
    candidates.push(...provinceCandidates.flat());
    return candidates;
  }));
  const candidates = regionCandidates.flat();
  folderIndex = candidates;
  folderIndexAt = Date.now();
  return folderIndex;
}

async function getFolderIndex({ forceRefresh = false } = {}) {
  const indexExpired = Date.now() - folderIndexAt > INDEX_TTL_MS;
  if (!folderIndex.length || forceRefresh || indexExpired) {
    if (!folderIndexPromise) {
      folderIndexPromise = buildFolderIndex().finally(() => {
        folderIndexPromise = null;
      });
    }
    // Wait for a complete refresh. Returning the stale index here made the
    // first request miss folders that appeared or were renamed on the NAS.
    return folderIndexPromise;
  }
  return folderIndex;
}

function exactMatchRank(candidate, nameTh, nameEng, area) {
  const candidateAliases = exactBuildingAliases(candidate.name);
  if (!candidateAliases.size) return null;
  if (area && candidate.area && area !== candidate.area) return null;

  const normalizedThaiName = normalizeBuildingName(nameTh);
  const normalizedEnglishName = normalizeBuildingName(nameEng);
  const languageRank = normalizedThaiName && candidateAliases.has(normalizedThaiName)
    ? 2
    : normalizedEnglishName && candidateAliases.has(normalizedEnglishName)
      ? 1
      : 0;
  if (!languageRank) return null;
  return {
    languageRank,
    areaRank: area && candidate.area === area ? 2 : 1
  };
}

async function findBuildingFolders({ nameTh, nameEng, area }) {
  const normalizedArea = normalizeArea(area);
  const missKey = [normalizeBuildingName(nameTh), normalizeBuildingName(nameEng), normalizedArea].join('|');
  const hadFreshIndex = folderIndex.length > 0 && Date.now() - folderIndexAt <= INDEX_TTL_MS;
  const collectMatches = index => index.map(candidate => ({
      candidate,
      rank: exactMatchRank(candidate, nameTh, nameEng, normalizedArea)
    }))
    .filter(item => item.rank);
  let matches = collectMatches(await getFolderIndex());

  // A folder may have been added or renamed during the cache lifetime. On a
  // miss, rebuild once and retry so the user does not have to wait ten minutes.
  const lastMissRefreshAt = missRefreshTimes.get(missKey) || 0;
  if (!matches.length && hadFreshIndex && Date.now() - lastMissRefreshAt >= MISS_REFRESH_COOLDOWN_MS) {
    missRefreshTimes.set(missKey, Date.now());
    matches = collectMatches(await getFolderIndex({ forceRefresh: true }));
  }

  if (!matches.length) return null;
  const bestLanguageRank = Math.max(...matches.map(item => item.rank.languageRank));
  const languageMatches = matches.filter(item => item.rank.languageRank === bestLanguageRank);
  const bestAreaRank = Math.max(...languageMatches.map(item => item.rank.areaRank));
  const exactMatches = languageMatches.filter(item => item.rank.areaRank === bestAreaRank);

  if (exactMatches.length > 1) {
    const error = new Error(`พบโฟลเดอร์ชื่อเดียวกัน ${exactMatches.length.toLocaleString('th-TH')} แห่ง ระบบจึงหยุดเพื่อป้องกันการใช้ข้อมูลผิดอาคาร`);
    error.code = 'AMBIGUOUS_BUILDING_FOLDER';
    throw error;
  }
  return [exactMatches[0].candidate];
}

async function findBuildingFolder(query) {
  const candidates = await findBuildingFolders(query);
  if (!candidates?.length) return null;
  return candidates[0];
}

async function scanSupportedFiles(buildingFolder) {
  const output = [];
  const queue = [{ fullPath: buildingFolder.fullPath, relativePath: '' }];

  while (queue.length) {
    const currentBatch = queue.splice(0);
    const directoryBatches = await Promise.all(currentBatch.map(async current => ({
      current,
      entries: await directoryEntries(current.fullPath)
    })));
    const fileTasks = [];

    for (const { current, entries } of directoryBatches) {
      for (const entry of entries) {
        const fullPath = path.join(current.fullPath, entry.name);
        const relativePath = current.relativePath ? path.join(current.relativePath, entry.name) : entry.name;
        if (entry.isDirectory()) {
          queue.push({ fullPath, relativePath });
          continue;
        }
        const extension = path.extname(entry.name).toLowerCase();
        const category = SUPPORTED_EXTENSIONS.get(extension);
        if (!category) continue;
        fileTasks.push(fs.promises.stat(fullPath).then(stat => ({
          name: entry.name,
          download_url: createDownloadUrl(fullPath),
          category,
          extension: extension.slice(1),
          size: stat.size,
          modified_at: stat.mtime.toISOString()
        })).catch(() => null));
      }
    }
    output.push(...(await Promise.all(fileTasks)).filter(Boolean));
  }

  return output.sort((a, b) =>
    a.category.localeCompare(b.category) || a.name.localeCompare(b.name, 'th')
  );
}

function contentDispositionFilename(fileName, disposition = 'attachment') {
  const fallback = String(fileName || 'download').replace(/[^a-zA-Z0-9._-]/g, '_');
  const encoded = encodeURIComponent(fileName).replace(/[!'()*]/g, character =>
    '%' + character.charCodeAt(0).toString(16).toUpperCase()
  );
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

async function handleNasDownload(req, res, requestUrl) {
  const token = requestUrl.searchParams.get('token') || '';
  const tokenEntry = downloadTokens.get(token);
  if (!tokenEntry || tokenEntry.expiresAt <= Date.now()) {
    downloadTokens.delete(token);
    sendJson(req, res, 404, { error: 'ลิงก์ดาวน์โหลดไม่ถูกต้องหรือหมดอายุ' });
    return;
  }
  const fullPath = tokenEntry.fullPath;
  const pathWithinNas = path.relative(NAS_ROOT, fullPath);
  const extension = path.extname(fullPath).toLowerCase();
  const previewRequested = requestUrl.searchParams.get('preview') === '1';
  const canPreview = extension === '.pdf' || SUPPORTED_EXTENSIONS.get(extension) === 'image';
  if (pathWithinNas.startsWith('..') || path.isAbsolute(pathWithinNas) || !SUPPORTED_EXTENSIONS.has(extension)) {
    sendJson(req, res, 403, { error: 'ไม่อนุญาตให้ดาวน์โหลดไฟล์นี้' });
    return;
  }
  try {
    const stat = await fs.promises.stat(fullPath);
    if (!stat.isFile()) throw new Error('Not a file');
    res.writeHead(200, {
      'Content-Type': previewRequested && canPreview
        ? (MIME_TYPES[extension] || 'application/octet-stream')
        : 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': contentDispositionFilename(
        path.basename(fullPath),
        previewRequested && canPreview ? 'inline' : 'attachment'
      ),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      ...corsHeaders(req)
    });
    fs.createReadStream(fullPath).pipe(res);
  } catch {
    sendJson(req, res, 404, { error: 'ไม่พบไฟล์ที่ต้องการดาวน์โหลด' });
  }
}

function sendJson(req, res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Permission-NAS-Bridge': '1',
    ...corsHeaders(req)
  });
  res.end(JSON.stringify(payload));
}

function readRequestBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error);
      req.destroy();
    };

    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        const error = new Error(`ไฟล์มีขนาดใหญ่เกิน ${(maxBytes / 1024 / 1024).toLocaleString('th-TH')} MB`);
        error.code = 'UPLOAD_TOO_LARGE';
        fail(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', fail);
  });
}

function safeUploadFileName(value) {
  const raw = String(value || '').replace(/[\\/]/g, '_');
  const baseName = path.basename(raw)
    .replace(/[<>:"|?*\u0000-\u001F]/g, '_')
    .trim();
  if (!baseName || baseName === '.' || baseName === '..') return '';
  return baseName;
}

async function handleNasUpload(req, res, requestUrl) {
  if (!ALLOW_UPLOAD) {
    sendJson(req, res, 403, { code: 'NAS_UPLOAD_DISABLED', error: 'NAS Bridge นี้เปิดในโหมดอ่านอย่างเดียว' });
    return;
  }
  if (req.headers['x-permission-document-upload'] !== '1') {
    sendJson(req, res, 403, { error: 'บัญชีนี้ไม่มีสิทธิ์เพิ่มเอกสาร' });
    return;
  }

  const fileName = safeUploadFileName(requestUrl.searchParams.get('fileName'));
  const extension = path.extname(fileName).toLowerCase();
  if (!fileName || !SUPPORTED_EXTENSIONS.has(extension)) {
    sendJson(req, res, 400, { error: 'รองรับเฉพาะไฟล์ DWG, PDF และรูปภาพตามประเภทที่ระบบกำหนด' });
    return;
  }

  const contentLength = Number(req.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_FILE_BYTES) {
    sendJson(req, res, 413, { error: `ไฟล์มีขนาดใหญ่เกิน ${(MAX_UPLOAD_FILE_BYTES / 1024 / 1024).toLocaleString('th-TH')} MB` });
    return;
  }

  try {
    const folder = await findBuildingFolder({
      nameTh: requestUrl.searchParams.get('nameTh') || '',
      nameEng: requestUrl.searchParams.get('nameEng') || '',
      area: requestUrl.searchParams.get('area') || ''
    });
    if (!folder) {
      sendJson(req, res, 404, { error: 'ไม่พบโฟลเดอร์อาคารสำหรับเพิ่มเอกสาร' });
      return;
    }

    const body = await readRequestBody(req, MAX_UPLOAD_FILE_BYTES);
    if (!body.length) {
      sendJson(req, res, 400, { error: 'ไม่พบข้อมูลไฟล์ที่ต้องการเพิ่ม' });
      return;
    }

    const targetPath = path.join(folder.fullPath, fileName);
    try {
      await fs.promises.writeFile(targetPath, body, { flag: 'wx' });
    } catch (error) {
      if (error.code === 'EEXIST') {
        sendJson(req, res, 409, { error: `มีไฟล์ชื่อ ${fileName} อยู่แล้ว กรุณาเปลี่ยนชื่อไฟล์ก่อนเพิ่ม` });
        return;
      }
      throw error;
    }

    const stat = await fs.promises.stat(targetPath);
    sendJson(req, res, 201, {
      file: {
        name: fileName,
        download_url: createDownloadUrl(targetPath),
        category: SUPPORTED_EXTENSIONS.get(extension),
        extension: extension.slice(1),
        size: stat.size,
        modified_at: stat.mtime.toISOString()
      }
    });
  } catch (err) {
    const statusCode = err.code === 'UPLOAD_TOO_LARGE'
      ? 413
      : err.code === 'AMBIGUOUS_BUILDING_FOLDER'
        ? 409
        : ['NAS_ROOT_UNAVAILABLE', 'NAS_DIRECTORY_UNAVAILABLE'].includes(err.code)
          ? 503
          : 500;
    sendJson(req, res, statusCode, {
      code: err.code || 'NAS_UPLOAD_FAILED',
      error: err.message || 'เพิ่มไฟล์ลง NAS ไม่สำเร็จ'
    });
  }
}

async function handleNasDocuments(req, res, requestUrl) {
  try {
    const query = requestUrl.searchParams;
    const folders = await findBuildingFolders({
      nameTh: query.get('nameTh') || '',
      nameEng: query.get('nameEng') || '',
      area: query.get('area') || ''
    });
    if (!folders?.length) {
      sendJson(req, res, 404, {
        code: 'BUILDING_FOLDER_NOT_FOUND',
        error: 'เชื่อมต่อ NAS แล้ว แต่ไม่พบโฟลเดอร์ที่ตรงกับชื่ออาคารและ Area'
      });
      return;
    }
    const files = (await Promise.all(folders.map(folder => scanSupportedFiles(folder)))).flat();
    sendJson(req, res, 200, {
      folder_found: true,
      matched_folders: folders.length,
      files: files.sort((a, b) =>
        a.category.localeCompare(b.category) || a.name.localeCompare(b.name, 'th')
      )
    });
  } catch (err) {
    const statusCode = err.code === 'AMBIGUOUS_BUILDING_FOLDER'
      ? 409
      : ['NAS_ROOT_UNAVAILABLE', 'NAS_DIRECTORY_UNAVAILABLE'].includes(err.code)
        ? 503
        : 500;
    sendJson(req, res, statusCode, {
      code: err.code || 'NAS_READ_FAILED',
      error: err.message || 'อ่านข้อมูล NAS ไม่สำเร็จ'
    });
  }
}

async function handleNasHealth(req, res) {
  let nasAccess = false;
  try {
    await fs.promises.access(NAS_ROOT, fs.constants.R_OK);
    nasAccess = true;
  } catch {
    nasAccess = false;
  }
  sendJson(req, res, 200, { status: 'ok', version: 2, nas_access: nasAccess });
}

function serveStatic(res, requestUrl) {
  let relativePath = decodeURIComponent(requestUrl.pathname);
  if (relativePath === '/') relativePath = '/Permission_Next.html';
  const filePath = path.resolve(WEB_ROOT, relativePath.replace(/^\/+/, ''));
  const pathWithinWebRoot = path.relative(WEB_ROOT, filePath);
  const normalizedPublicPath = pathWithinWebRoot.split(path.sep).join('/');
  if (pathWithinWebRoot.startsWith('..') || path.isAbsolute(pathWithinWebRoot)
    || !PUBLIC_WEB_FILES.has(normalizedPublicPath)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const responseHeaders = {
      'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' https://www.gstatic.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://tile.openstreetmap.org https://*.tile.openstreetmap.org https://server.arcgisonline.com https://services.arcgisonline.com; connect-src 'self' https://www.gstatic.com https://*.googleapis.com https://*.firebaseio.com wss://*.firebaseio.com; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'"
    };
    res.writeHead(200, responseHeaders);
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, 'http://' + req.headers.host);
  const isNasApi = requestUrl.pathname.startsWith('/api/nas/');
  if (isNasApi && !isOriginAllowed(req)) {
    sendJson(req, res, 403, { error: 'Origin นี้ไม่ได้รับอนุญาตให้เรียก NAS Bridge' });
    return;
  }
  if (isNasApi && req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }
  if (requestUrl.pathname === '/api/nas/health') {
    await handleNasHealth(req, res);
    return;
  }
  if (isNasApi && !isTrustedDeployedOriginRequest(req) && !isAuthorizedRequest(req, requestUrl)) {
    sendJson(req, res, 401, { code: 'BRIDGE_AUTH_REQUIRED', error: 'ไม่สามารถยืนยันสิทธิ์การเชื่อมต่อ NAS Bridge' });
    return;
  }
  if (requestUrl.pathname === '/api/nas/building-documents/upload') {
    if (req.method !== 'POST') {
      sendJson(req, res, 405, { error: 'ต้องใช้คำสั่ง POST สำหรับเพิ่มเอกสาร' });
      return;
    }
    await handleNasUpload(req, res, requestUrl);
    return;
  }
  if (requestUrl.pathname === '/api/nas/building-documents') {
    await handleNasDocuments(req, res, requestUrl);
    return;
  }
  if (requestUrl.pathname === '/api/nas/download') {
    await handleNasDownload(req, res, requestUrl);
    return;
  }
  serveStatic(res, requestUrl);
});

server.on('error', err => {
  console.error('Dev server failed:', err.message);
  rejectReady(err);
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  const address = server.address();
  const activePort = typeof address === 'object' && address ? address.port : PORT;
  console.log('Permission Next dev server: http://' + HOST + ':' + activePort);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1') {
    console.log('Permission Next share access: ?bridge=' + encodeURIComponent(BRIDGE_TOKEN));
    console.log('Permission Next share mode: ' + (ALLOW_UPLOAD ? 'read/write' : 'read-only'));
  }
  console.log('Allowed deployed origins: ' + [...ALLOWED_ORIGINS].join(', '));
  resolveReady({ host: HOST, port: activePort });
});

module.exports = { server, ready, host: HOST, port: PORT, bridgeToken: BRIDGE_TOKEN };
