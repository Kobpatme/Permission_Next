const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const appSource = fs.readFileSync(path.resolve(__dirname, '..', 'app.js'), 'utf8');

test('NAS document operations have bounded waits and restore upload controls', () => {
  assert.match(appSource, /const NAS_DOCUMENT_REQUEST_TIMEOUT_MS = 60000;/);
  assert.match(appSource, /const NAS_UPLOAD_REQUEST_TIMEOUT_MS = 120000;/);
  assert.match(appSource, /buildingDocumentRequests\.get\(key\)\?\.abort\(\)/);
  assert.match(appSource, /uploadButton\.classList\.remove\('loading'\)/);
  assert.match(appSource, /uploadButton\.textContent = '\+ เพิ่ม'/);
});

test('write forms reject repeated submissions while a save is pending', () => {
  assert.match(appSource, /if \(userAdminForm\.dataset\.busy === 'true'\) return;/);
  assert.match(appSource, /if \(buildingEditorForm\.dataset\.busy === 'true'\) return;/);
  assert.match(appSource, /setFormSubmitBusy\(buildingEditorForm, true, 'กำลังบันทึก\.\.\.'\)/);
});
