const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const HOST = process.env.DEV_HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 8766;
const WEB_ROOT = __dirname;
const NAS_ROOT = process.env.NAS_BUILDING_ROOT
  || 'P:\\BBG\\Outside Plant&Coordination\\!!!_Data Base Building Drawing';
const INDEX_TTL_MS = 60_000;
const DOWNLOAD_TOKEN_TTL_MS = 15 * 60_000;
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
  '.svg': 'image/svg+xml'
};

let folderIndex = [];
let folderIndexAt = 0;
const downloadTokens = new Map();

function createDownloadUrl(fullPath) {
  const now = Date.now();
  for (const [token, entry] of downloadTokens) {
    if (entry.expiresAt <= now) downloadTokens.delete(token);
  }
  const token = crypto.randomUUID();
  downloadTokens.set(token, { fullPath, expiresAt: now + DOWNLOAD_TOKEN_TTL_MS });
  return '/api/nas/download?token=' + encodeURIComponent(token);
}

function normalizeBuildingName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^อาคาร\s*/u, '')
    .replace(/\((?:bkk|cmi|cbi|ryg|pkt|sni)\d*\)\s*$/iu, '')
    .replace(/[^a-z0-9ก-๙]+/gu, '');
}

function normalizeArea(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function areaFromFolderName(folderName) {
  return String(folderName || '').match(/\(((?:BKK|CMI|CBI|RYG|PKT|SNI)\d*)\)\s*$/i)?.[1]?.toUpperCase() || '';
}

async function directoryEntries(directoryPath) {
  try {
    return await fs.promises.readdir(directoryPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function buildFolderIndex() {
  const rootEntries = await directoryEntries(NAS_ROOT);
  if (!rootEntries.length) {
    const error = new Error('ไม่สามารถเข้าถึงแหล่งเอกสาร NAS ได้');
    error.code = 'NAS_ROOT_UNAVAILABLE';
    throw error;
  }

  const candidates = [];
  for (const entry of rootEntries.filter(item => item.isDirectory())) {
    const levelOnePath = path.join(NAS_ROOT, entry.name);
    const levelTwoEntries = await directoryEntries(levelOnePath);
    const levelTwoDirectories = levelTwoEntries.filter(item => item.isDirectory());

    if (/^อาคาร\s+/u.test(entry.name) || !levelTwoDirectories.length) {
      candidates.push({
        name: entry.name,
        relativePath: entry.name,
        fullPath: levelOnePath,
        area: areaFromFolderName(entry.name)
      });
    }

    for (const child of levelTwoDirectories) {
      candidates.push({
        name: child.name,
        relativePath: path.join(entry.name, child.name),
        fullPath: path.join(levelOnePath, child.name),
        area: areaFromFolderName(child.name)
      });
    }
  }
  folderIndex = candidates;
  folderIndexAt = Date.now();
  return folderIndex;
}

async function getFolderIndex() {
  if (!folderIndex.length || Date.now() - folderIndexAt > INDEX_TTL_MS) return buildFolderIndex();
  return folderIndex;
}

function matchScore(candidate, names, area) {
  const candidateName = normalizeBuildingName(candidate.name);
  if (!candidateName) return 0;
  if (area && candidate.area && area !== candidate.area) return 0;

  let score = area && candidate.area === area ? 30 : 0;
  for (const rawName of names) {
    const name = normalizeBuildingName(rawName);
    if (!name) continue;
    if (candidateName === name) score = Math.max(score, 130);
    else if (candidateName.includes(name) || name.includes(candidateName)) {
      const ratio = Math.min(candidateName.length, name.length) / Math.max(candidateName.length, name.length);
      score = Math.max(score, 80 + Math.round(ratio * 30));
    }
  }
  return score;
}

async function findBuildingFolder({ nameTh, nameEng, area }) {
  const names = [nameTh, nameEng].filter(Boolean);
  const normalizedArea = normalizeArea(area);
  const ranked = (await getFolderIndex())
    .map(candidate => ({ candidate, score: matchScore(candidate, names, normalizedArea) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.candidate.name.localeCompare(b.candidate.name, 'th'));

  if (!ranked.length || ranked[0].score < 80) return null;
  return ranked[0].candidate;
}

async function scanSupportedFiles(buildingFolder) {
  const output = [];
  const queue = [{ fullPath: buildingFolder.fullPath, relativePath: '' }];

  while (queue.length) {
    const current = queue.shift();
    const entries = await directoryEntries(current.fullPath);
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
      const stat = await fs.promises.stat(fullPath);
      output.push({
        name: entry.name,
        download_url: createDownloadUrl(fullPath),
        category,
        extension: extension.slice(1),
        size: stat.size,
        modified_at: stat.mtime.toISOString()
      });
    }
  }

  return output.sort((a, b) =>
    a.category.localeCompare(b.category) || a.name.localeCompare(b.name, 'th')
  );
}

function contentDispositionFilename(fileName) {
  const fallback = String(fileName || 'download').replace(/[^a-zA-Z0-9._-]/g, '_');
  const encoded = encodeURIComponent(fileName).replace(/[!'()*]/g, character =>
    '%' + character.charCodeAt(0).toString(16).toUpperCase()
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

async function handleNasDownload(res, requestUrl) {
  const token = requestUrl.searchParams.get('token') || '';
  const tokenEntry = downloadTokens.get(token);
  if (!tokenEntry || tokenEntry.expiresAt <= Date.now()) {
    downloadTokens.delete(token);
    sendJson(res, 404, { error: 'ลิงก์ดาวน์โหลดไม่ถูกต้องหรือหมดอายุ' });
    return;
  }
  const fullPath = tokenEntry.fullPath;
  const pathWithinNas = path.relative(NAS_ROOT, fullPath);
  const extension = path.extname(fullPath).toLowerCase();
  if (pathWithinNas.startsWith('..') || path.isAbsolute(pathWithinNas) || !SUPPORTED_EXTENSIONS.has(extension)) {
    sendJson(res, 403, { error: 'ไม่อนุญาตให้ดาวน์โหลดไฟล์นี้' });
    return;
  }
  try {
    const stat = await fs.promises.stat(fullPath);
    if (!stat.isFile()) throw new Error('Not a file');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': contentDispositionFilename(path.basename(fullPath)),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    fs.createReadStream(fullPath).pipe(res);
  } catch {
    sendJson(res, 404, { error: 'ไม่พบไฟล์ที่ต้องการดาวน์โหลด' });
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Permission-NAS-Bridge': '1'
  });
  res.end(JSON.stringify(payload));
}

async function handleNasDocuments(res, requestUrl) {
  try {
    const query = requestUrl.searchParams;
    const folder = await findBuildingFolder({
      nameTh: query.get('nameTh') || '',
      nameEng: query.get('nameEng') || '',
      area: query.get('area') || ''
    });
    if (!folder) {
      sendJson(res, 404, {
        error: 'ไม่พบเอกสารอาคารที่ตรงกับชื่อและ Area ใน NAS'
      });
      return;
    }
    sendJson(res, 200, {
      files: await scanSupportedFiles(folder)
    });
  } catch (err) {
    sendJson(res, err.code === 'NAS_ROOT_UNAVAILABLE' ? 503 : 500, {
      error: err.message || 'อ่านข้อมูล NAS ไม่สำเร็จ'
    });
  }
}

function serveStatic(res, requestUrl) {
  let relativePath = decodeURIComponent(requestUrl.pathname);
  if (relativePath === '/') relativePath = '/Permission_Next.html';
  const filePath = path.resolve(WEB_ROOT, relativePath.replace(/^\/+/, ''));
  const pathWithinWebRoot = path.relative(WEB_ROOT, filePath);
  if (pathWithinWebRoot.startsWith('..') || path.isAbsolute(pathWithinWebRoot)) {
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
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, 'http://' + req.headers.host);
  if (requestUrl.pathname === '/api/nas/building-documents') {
    await handleNasDocuments(res, requestUrl);
    return;
  }
  if (requestUrl.pathname === '/api/nas/download') {
    await handleNasDownload(res, requestUrl);
    return;
  }
  serveStatic(res, requestUrl);
});

server.on('error', err => {
  console.error('Dev server failed:', err.message);
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  console.log('Permission Next dev server: http://' + HOST + ':' + PORT);
});
