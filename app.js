// ====== DATA ======
// ข้อมูลตั้งต้น (912 รายการ) ถูกนำเข้าสู่ Firestore เรียบร้อยแล้ว จึงลบออกจากไฟล์นี้เพื่อลดขนาดไฟล์และความเสี่ยงด้านข้อมูล
// (ข้อมูลจริงทั้งหมดตอนนี้อยู่ใน Firestore collection 'buildings' เท่านั้น ไม่ได้ฝังอยู่ในไฟล์นี้อีกต่อไป)
const RAW_DATA = [];

const CHECK_PERMISSION_STALE_DAYS = 365;
const CHECK_PERMISSION_EXCLUDED_STATUSES = new Set(['Check Permission', 'MOU', 'อาคารปิดถาวร']);

function makeValidatedLocalDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  const date = new Date(year, month - 1, day);
  if (
    Number.isNaN(date.getTime())
    || date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
  ) return null;
  return date;
}

function parseBuildingUpdateDate(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') {
    const date = value.toDate();
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  const raw = String(value).trim();
  if (!raw) return null;

  const isoDate = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoDate) {
    const year = Number(isoDate[1]);
    const month = Number(isoDate[2]);
    const day = Number(isoDate[3]);
    return makeValidatedLocalDate(year, month, day);
  }

  const slashDate = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (slashDate) {
    const day = Number(slashDate[1]);
    const month = Number(slashDate[2]);
    let year = Number(slashDate[3]);
    if (year < 100) year += 2000;
    if (year > 2400) year -= 543;
    return makeValidatedLocalDate(year, month, day);
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatBuildingUpdateDate(value) {
  const date = parseBuildingUpdateDate(value);
  if (!date) return value || '—';
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${date.getFullYear()}`;
}

function isBuildingUpdateStale(updateDate, today = new Date()) {
  const date = parseBuildingUpdateDate(updateDate);
  if (!date) return false;

  const staleBefore = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  staleBefore.setDate(staleBefore.getDate() - CHECK_PERMISSION_STALE_DAYS);
  return date < staleBefore;
}

function applyAutoCheckPermissionStatus(item) {
  const currentStatus = String(item.status || '').trim();
  if (CHECK_PERMISSION_EXCLUDED_STATUSES.has(currentStatus)) return item;
  if (isBuildingUpdateStale(item.update_date)) item.status = 'Check Permission';
  return item;
}

function shouldAutoCheckPermissionStatus(item) {
  const currentStatus = String(item?.status || '').trim();
  return !CHECK_PERMISSION_EXCLUDED_STATUSES.has(currentStatus)
    && isBuildingUpdateStale(item?.update_date);
}

function normalizeBuildingRecord(r) {
  const item = { ...r };
  let it = (r.install_type||'').toLowerCase().trim();
  if (it === 'building') item.install_type = 'Building';
  else if (['shopping mall','shopping mall (mou)','mall'].includes(it)) item.install_type = 'Shopping Mall';
  else if (['nikom','nikom (mou)'].includes(it)) item.install_type = 'Nikom';
  else if (it === 'data center') item.install_type = 'Data center';
  else if (it === 'market') item.install_type = 'Market';
  else if (it === 'airport') item.install_type = 'Airport';
  else if (it === 'port') item.install_type = 'Port';
  let area = (item.area||'').trim().toUpperCase().replace('ฺ','');
  item.area = area;
  applyAutoCheckPermissionStatus(item);
  item._searchText = `${item.name_th||''} ${item.name_eng||''} ${item.location||''}`.toLowerCase();
  item._nameSearchText = `${item.name_th||''} ${item.name_eng||''}`.toLowerCase();
  return item;
}

// ====== FIREBASE / FIRESTORE ======
// การเชื่อมต่อ Firestore จริง ๆ ถูกตั้งค่าไว้ในบล็อก JS module ด้านบนสุดของไฟล์ (ก่อนแท็ก script หลักนี้)
// (ต้องใช้ modular SDK เพราะฐานข้อมูลนี้เป็น "named database" ชื่อ permission-building ไม่ใช่ (default))
// สคริปต์นั้นจะ expose ฟังก์ชันที่จำเป็นไว้ที่ window.FSDB แล้วยิง event 'fsdb-ready' เมื่อพร้อม

let DATA = [];
let firestoreUnsub = null;
let PERMISSION_TYPE_FORMULAS = {};
let PERMISSION_TYPE_FORMULA_VERSION = null;

function setPermissionTypeFormulaRegistry(rawConfig) {
  const formulas = rawConfig?.formulas;
  PERMISSION_TYPE_FORMULAS = formulas && typeof formulas === 'object'
    ? Object.fromEntries(
        Object.entries(formulas)
          .map(([type, formula]) => [String(type).trim().toUpperCase(), formula])
          .filter(([type, formula]) => ['L1', 'L2', 'L3'].includes(type) && formula && typeof formula === 'object')
      )
    : {};
  PERMISSION_TYPE_FORMULA_VERSION = Number(rawConfig?.version) || null;
}

function whenFsdbReady(callback) {
  if (window.FSDB) { callback(); return; }
  window.addEventListener('fsdb-ready', callback, { once: true });
}

function setSyncStatus(text, isError = false) {
  const el = document.getElementById('sync-status');
  if (el) {
    el.textContent = text;
    el.style.color = isError ? 'var(--red)' : 'var(--text2)';
  }
  if (isError) console.warn('[Firestore]', text);
  else console.log('[Firestore]', text);
}

function stripInternalFields(rec) {
  const clean = { ...rec };
  delete clean._searchText;
  delete clean._nameSearchText;
  delete clean._docId;
  return clean;
}

const BUILDING_CSV_COLUMNS = [
  ['id', 'ID'],
  ['name_th', 'ชื่ออาคาร (ไทย)'],
  ['name_eng', 'ชื่ออาคาร (อังกฤษ)'],
  ['status', 'Status'],
  ['group', 'Group'],
  ['type', 'Type'],
  ['install_type', 'Install Type'],
  ['survey_type', 'Survey Type'],
  ['area', 'Area'],
  ['province', 'Province'],
  ['location', 'Location'],
  ['lat', 'Latitude'],
  ['lng', 'Longitude'],
  ['wm_point', 'WM Point'],
  ['enclosure', 'Enclosure'],
  ['max_horizontal', 'Max H-Wire (m.)'],
  ['damage_deposit', 'เงินประกันติดตั้ง (Deposit)'],
  ['contract_deposit', 'ค่ามัดจำสัญญา (Contract Deposit)'],
  ['insurance_fee', 'ค่าประกัน (Insurance)'],
  ['main_fee', 'ค่าธรรมเนียม (Main Fee)'],
  ['annual_fee', 'ค่าบริการรายปี (Annual Fee)'],
  ['coordination_fee', 'ค่าธรรมเนียมประสานงาน (Coordination Fee)'],
  ['shaft_fee_per_floor', 'ค่า Shaft ต่อชั้น'],
  ['horizontal_fee', 'ค่าวางสายทั้งเส้น /ม.'],
  ['installation_profile', 'สูตรต้นทุนติดตั้งเฉพาะอาคาร'],
  ['other_fees', 'ค่าใช้จ่ายเพิ่มเติม'],
  ['duration', 'ระยะ Permission'],
  ['update_date', 'อัปเดตล่าสุด'],
  ['address', 'Address'],
  ['contact', 'Contact'],
  ['phone', 'Phone'],
  ['mobile', 'Mobile'],
  ['email', 'Email'],
  ['remark', 'Remark']
];

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function makeLocalDateStamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function exportBuildingsCsv() {
  if (!canManageUsers()) {
    alert('บัญชีนี้ไม่มีสิทธิ์ export ข้อมูล');
    return;
  }
  if (!DATA.length) {
    alert('ยังไม่มีข้อมูลอาคารสำหรับ export');
    return;
  }

  const rows = [
    BUILDING_CSV_COLUMNS.map(([, label]) => csvCell(label)).join(','),
    ...DATA.map(record => BUILDING_CSV_COLUMNS
      .map(([key]) => csvCell(record[key]))
      .join(','))
  ];
  const csv = '\uFEFF' + rows.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `permission_next_buildings_${makeLocalDateStamp()}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ====== BASIC AUTH / ROLES ======
const AUTH_SESSION_KEY = 'permission_next_session_v1';
const PASSWORD_SALT = 'permission-next-basic-auth-v1';
const DEFAULT_ADMIN = {
  email: 'admin101@uih.co.th',
  password: 'admin101',
  role: 'admin',
  display_name: 'Admin'
};
const ROLE_LABELS = {
  admin: 'Admin',
  permission: 'Permission',
  sale: 'Sale'
};
const FEE_LABELS = {
  damageDeposit: 'เงินประกันติดตั้ง (Deposit)',
  contractDeposit: 'ค่ามัดจำสัญญา (Contract Deposit)',
  insurance: 'ค่าประกัน (Insurance)',
  mainFee: 'ค่าธรรมเนียม (Main Fee)',
  annualFee: 'ค่าบริการรายปี (Annual Fee)',
  coordinationFee: 'ค่าธรรมเนียมประสานงาน (Coordination Fee)',
  closure: 'ค่า ODF',
  splice: 'ค่า Splice'
};

let APP_USERS = [];
let usersUnsub = null;
let currentUser = null;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function roleLabel(role) {
  return ROLE_LABELS[role] || role || '-';
}

function canManageUsers() {
  return currentUser?.role === 'admin';
}

function canManageBuildings() {
  return ['admin', 'permission'].includes(currentUser?.role);
}

function hasBuildingDocumentRole() {
  return ['admin', 'permission'].includes(currentUser?.role);
}

function canViewBuildingDocuments() {
  return hasBuildingDocumentRole();
}

function setBoxMessage(id, message, isError = true) {
  const box = document.getElementById(id);
  if (!box) return;
  box.textContent = message || '';
  box.style.color = isError ? 'var(--red)' : 'var(--green)';
  box.style.background = isError ? 'var(--red-bg)' : 'var(--green-bg)';
  box.style.borderColor = isError ? 'rgba(239,68,68,.24)' : 'rgba(16,185,129,.24)';
  box.classList.toggle('show', Boolean(message));
}

function applyFieldAriaLabels(root = document) {
  root.querySelectorAll('.building-field').forEach(field => {
    const label = field.querySelector('label');
    const control = field.querySelector('input, select, textarea');
    if (!label || !control || control.hasAttribute('aria-label') || control.hasAttribute('aria-labelledby')) return;
    const labelText = label.textContent.replace(/\s*\*\s*$/, '').trim();
    if (labelText) control.setAttribute('aria-label', labelText);
  });
}

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function passwordHash(email, password) {
  return sha256(`${password}:${PASSWORD_SALT}`);
}

function readSavedSession() {
  try {
    localStorage.removeItem(AUTH_SESSION_KEY);
    return JSON.parse(sessionStorage.getItem(AUTH_SESSION_KEY) || 'null');
  } catch {
    return null;
  }
}

function saveSession(user) {
  localStorage.removeItem(AUTH_SESSION_KEY);
  sessionStorage.setItem(AUTH_SESSION_KEY, JSON.stringify({
    email: user.email,
    role: user.role,
    display_name: user.display_name || '',
    saved_at: Date.now()
  }));
}

function clearSession() {
  sessionStorage.removeItem(AUTH_SESSION_KEY);
  localStorage.removeItem(AUTH_SESSION_KEY);
}

function sanitizeUser(user) {
  if (!user) return null;
  return {
    email: normalizeEmail(user.email || user.id),
    role: user.role || 'sale',
    display_name: user.display_name || '',
    disabled: Boolean(user.disabled),
    created_at: user.created_at || null,
    updated_at: user.updated_at || null
  };
}

function applyRoleUi() {
  document.body.classList.toggle('role-admin', canManageUsers());
  document.body.classList.toggle('role-permission', currentUser?.role === 'permission');
  document.body.classList.toggle('role-sale', currentUser?.role === 'sale');

  const pill = document.getElementById('current-user-pill');
  if (pill) {
    pill.querySelector('strong').textContent = currentUser?.display_name || currentUser?.email || '-';
    pill.querySelector('span').textContent = roleLabel(currentUser?.role);
  }

  document.getElementById('add-building-btn')?.classList.toggle('role-hidden', !canManageBuildings());
  document.getElementById('export-csv-btn')?.classList.toggle('role-hidden', !canManageUsers());
  document.getElementById('sync-boq-db-btn')?.classList.toggle('role-hidden', !canManageUsers());
  document.querySelectorAll('.edit-building-btn').forEach(btn => {
    btn.classList.toggle('role-hidden', !canManageBuildings());
  });
  document.getElementById('building-editor-delete-btn')?.classList.toggle('role-hidden', !canManageBuildings());
  document.querySelectorAll('#drawer-tab-documents, #tab-documents').forEach(el => {
    el.classList.toggle('role-hidden', !canViewBuildingDocuments());
  });
  if (!canViewBuildingDocuments() && document.getElementById('drawer-tab-documents')?.classList.contains('active')) {
    switchTab('general');
  }
}

function setCurrentUser(user) {
  currentUser = user ? sanitizeUser(user) : null;
  if (!currentUser) clearBuildingDocumentsCache();
  if (currentUser) {
    document.body.classList.remove('auth-locked');
    saveSession(currentUser);
  } else {
    document.body.classList.add('auth-locked');
    clearSession();
  }
  applyRoleUi();
}

async function ensureDefaultAdminUser() {
  const existingAdmin = await window.FSDB.getUser(DEFAULT_ADMIN.email);
  if (existingAdmin) return;
  await window.FSDB.setUser(DEFAULT_ADMIN.email, {
    email: DEFAULT_ADMIN.email,
    role: DEFAULT_ADMIN.role,
    display_name: DEFAULT_ADMIN.display_name,
    password_hash: await passwordHash(DEFAULT_ADMIN.email, DEFAULT_ADMIN.password),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });
}

function startUsersSync() {
  if (usersUnsub) usersUnsub();
  usersUnsub = window.FSDB.onAuthSnapshot(
    users => {
      APP_USERS = users.map(sanitizeUser)
        .filter(Boolean)
        .sort((a, b) => a.email.localeCompare(b.email));
      renderUserAdminList();
      if (currentUser) {
        const latest = APP_USERS.find(u => u.email === currentUser.email && !u.disabled);
        if (!latest) {
          setCurrentUser(null);
          setBoxMessage('login-message', 'บัญชีนี้ถูกปิดใช้งานหรือถูกลบแล้ว กรุณาเข้าสู่ระบบใหม่');
        } else if (latest.role !== currentUser.role || latest.display_name !== currentUser.display_name) {
          setCurrentUser(latest);
        }
      }
    },
    err => console.error('Users sync error:', err)
  );
}

async function restoreSession() {
  const saved = readSavedSession();
  if (!saved?.email) return;
  const user = await window.FSDB.getUser(saved.email);
  if (user && !user.disabled) setCurrentUser(user);
}

async function initAuth() {
  try {
    await ensureDefaultAdminUser();
    startUsersSync();
    await restoreSession();
  } catch (err) {
    console.error('Auth init error:', err);
    setBoxMessage('login-message', 'เริ่มต้นระบบผู้ใช้ไม่สำเร็จ: ' + err.message);
  }
}

async function loginWithPassword(email, password) {
  const cleanEmail = normalizeEmail(email);
  if (!cleanEmail || !password) throw new Error('กรุณากรอก ID และ Password');
  const user = await window.FSDB.getUser(cleanEmail);
  if (!user || user.disabled) throw new Error('ไม่พบบัญชีผู้ใช้ หรือบัญชีถูกปิดใช้งาน');
  const hash = await passwordHash(cleanEmail, password);
  if (hash !== user.password_hash) throw new Error('ID หรือ Password ไม่ถูกต้อง');
  setCurrentUser(user);
}

function resetUserForm() {
  const form = document.getElementById('user-admin-form');
  if (!form) return;
  form.reset();
  form.elements['editing_email'].value = '';
  form.elements['password'].required = true;
  setBoxMessage('user-admin-message', '');
  rememberFormState(form);
}

function editUser(email) {
  const user = APP_USERS.find(u => u.email === normalizeEmail(email));
  const form = document.getElementById('user-admin-form');
  if (!user || !form) return;
  form.elements['editing_email'].value = user.email;
  form.elements['email'].value = user.email;
  form.elements['role'].value = user.role;
  form.elements['display_name'].value = user.display_name || '';
  form.elements['password'].value = '';
  form.elements['password'].required = false;
  setBoxMessage('user-admin-message', 'กำลังแก้ไขผู้ใช้: ' + user.email, false);
  rememberFormState(form);
}

const UNSAVED_CHANGES_CONFIRM_MESSAGE = 'มีข้อมูลที่ยังไม่ได้บันทึก ต้องการปิดหน้าต่างและทิ้งข้อมูลนี้หรือไม่?';
const dialogFocusReturn = new WeakMap();

function openDialogAccessibility(dialog, initialFocus = null) {
  if (!dialog) return;
  if (document.activeElement instanceof HTMLElement) {
    dialogFocusReturn.set(dialog, document.activeElement);
  }
  dialog.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => {
    const target = initialFocus || dialog.querySelector(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    target?.focus();
  });
}

function closeDialogAccessibility(dialog) {
  if (!dialog) return;
  dialog.setAttribute('aria-hidden', 'true');
  const returnTarget = dialogFocusReturn.get(dialog);
  if (returnTarget?.isConnected) returnTarget.focus();
  dialogFocusReturn.delete(dialog);
}

function trapDialogTabKey(event) {
  if (event.key !== 'Tab') return;
  const dialogs = [...document.querySelectorAll('[role="dialog"].open[aria-hidden="false"]')];
  if (!dialogs.length) return;
  const dialog = dialogs.reduce((top, candidate) =>
    Number(getComputedStyle(candidate).zIndex) > Number(getComputedStyle(top).zIndex) ? candidate : top
  );
  const focusable = [...dialog.querySelectorAll(
    'button:not([disabled]):not([hidden]), input:not([disabled]):not([hidden]), select:not([disabled]):not([hidden]), textarea:not([disabled]):not([hidden]), [tabindex]:not([tabindex="-1"])'
  )].filter(el => el.getClientRects().length);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function serializeFormState(form) {
  if (!form) return '';
  const fields = Array.from(form.querySelectorAll('input, select, textarea')).map(el => ({
    name: el.name || el.id || '',
    type: el.type || el.tagName,
    value: el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value
  }));
  return JSON.stringify(fields);
}

function rememberFormState(form) {
  if (!form) return;
  form.dataset.initialState = serializeFormState(form);
}

function formStateChanged(form) {
  if (!form) return false;
  return (form.dataset.initialState || '') !== serializeFormState(form);
}

function confirmDiscardFormChanges(form) {
  return !formStateChanged(form) || confirm(UNSAVED_CHANGES_CONFIRM_MESSAGE);
}

function closeUserAdminModal(force = false) {
  const modal = document.getElementById('user-admin-modal');
  const form = document.getElementById('user-admin-form');
  if (!modal) return true;
  if (!force && !confirmDiscardFormChanges(form)) return false;
  modal.classList.remove('open');
  closeDialogAccessibility(modal);
  resetUserForm();
  return true;
}

async function deleteUserAccount(email) {
  if (!canManageUsers()) return;
  const cleanEmail = normalizeEmail(email);
  if (cleanEmail === currentUser?.email) {
    setBoxMessage('user-admin-message', 'ไม่สามารถลบบัญชีที่กำลังใช้งานอยู่ได้');
    return;
  }
  if (!confirm('ต้องการลบผู้ใช้นี้หรือไม่: ' + cleanEmail)) return;
  await window.FSDB.deleteUser(cleanEmail);
  setBoxMessage('user-admin-message', 'ลบผู้ใช้เรียบร้อยแล้ว', false);
}

async function saveUserFromForm(form) {
  if (!canManageUsers()) return;
  const formData = new FormData(form);
  const editingEmail = normalizeEmail(formData.get('editing_email'));
  const email = normalizeEmail(formData.get('email'));
  const password = String(formData.get('password') || '');
  const role = String(formData.get('role') || 'sale');
  const displayName = String(formData.get('display_name') || '').trim();

  if (!email) throw new Error('กรุณากรอก ID / Email');
  if (!['admin', 'permission', 'sale'].includes(role)) throw new Error('Role ไม่ถูกต้อง');
  if (!editingEmail && !password) throw new Error('กรุณากรอกรหัสผ่านสำหรับผู้ใช้ใหม่');

  const existing = editingEmail ? await window.FSDB.getUser(editingEmail) : null;
  const payload = {
    email,
    role,
    display_name: displayName,
    updated_at: new Date().toISOString()
  };
  if (!existing) payload.created_at = new Date().toISOString();
  if (password) payload.password_hash = await passwordHash(email, password);
  const nextUser = existing ? { ...existing, ...payload, email } : payload;

  if (editingEmail && editingEmail !== email) {
    await window.FSDB.setUser(email, nextUser);
    await window.FSDB.deleteUser(editingEmail);
  } else {
    await window.FSDB.setUser(email, nextUser);
  }
  resetUserForm();
  setBoxMessage('user-admin-message', 'บันทึกผู้ใช้เรียบร้อยแล้ว', false);
}

function renderUserAdminList() {
  const tbody = document.getElementById('user-admin-list');
  const count = document.getElementById('user-admin-count');
  if (count) count.textContent = APP_USERS.length + ' users';
  if (!tbody) return;
  tbody.innerHTML = APP_USERS.map(user => `
    <tr>
      <td>${esc(user.email)}</td>
      <td><span class="user-role-badge">${esc(roleLabel(user.role))}</span></td>
      <td>${esc(user.display_name || '-')}</td>
      <td>
        <div class="user-row-actions">
          <button class="user-admin-btn" type="button" data-user-edit="${attrEsc(user.email)}">แก้ไข</button>
          <button class="user-admin-btn danger" type="button" data-user-delete="${attrEsc(user.email)}">ลบ</button>
        </div>
      </td>
    </tr>
  `).join('') || '<tr><td colspan="4" style="color:var(--muted);text-align:center;">ยังไม่มีผู้ใช้</td></tr>';
}

// ------ นำเข้าข้อมูลเดิม (RAW_DATA) เข้า Firestore ครั้งแรกเท่านั้น ------
// ถ้าคอลเลกชัน 'buildings' มีข้อมูลอยู่แล้ว จะไม่ทำการ seed ซ้ำ
async function migrateRawDataIfEmpty() {
  if (!RAW_DATA.length) {
    // ไม่มีข้อมูลตั้งต้นฝังอยู่ในไฟล์นี้แล้ว (ถูกลบออกหลังจากนำเข้า Firestore สำเร็จ)
    // ระบบจะใช้ข้อมูลจาก Firestore เพียงอย่างเดียวเท่านั้น
    return false;
  }

  const isEmpty = await window.FSDB.isCollectionEmpty();
  if (!isEmpty) return false;

  setSyncStatus('กำลังนำเข้าข้อมูลเริ่มต้น ' + RAW_DATA.length + ' รายการ...');
  const records = RAW_DATA.map(normalizeBuildingRecord);
  const usedIds = new Set();
  let autoIdCounter = Math.max(0, ...records.map(r => Number(r.id) || 0)) + 1;

  const chunkSize = 400; // Firestore batch จำกัด 500 operations/ครั้ง
  for (let i = 0; i < records.length; i += chunkSize) {
    const batch = window.FSDB.newBatch();
    records.slice(i, i + chunkSize).forEach(rec => {
      let id = rec.id;
      if (id === null || id === undefined || usedIds.has(String(id))) {
        id = autoIdCounter++;
      }
      usedIds.add(String(id));
      window.FSDB.setInBatch(batch, id, stripInternalFields({ ...rec, id }));
    });
    await window.FSDB.commitBatch(batch);
    setSyncStatus(`กำลังนำเข้าข้อมูล... (${Math.min(i + chunkSize, records.length)}/${records.length})`);
  }
  setSyncStatus('นำเข้าข้อมูลเริ่มต้นสำเร็จ');
  return true;
}

async function persistAutoCheckPermissionStatuses(updates) {
  const docIds = [...new Set(updates.map(item => item.docId).filter(Boolean).map(String))];
  if (!docIds.length) return;

  try {
    const chunkSize = 400;
    for (let i = 0; i < docIds.length; i += chunkSize) {
      const batch = window.FSDB.newBatch();
      docIds.slice(i, i + chunkSize).forEach(docId => {
        window.FSDB.setMergeInBatch(batch, docId, { status: 'Check Permission' });
      });
      await window.FSDB.commitBatch(batch);
    }
    setSyncStatus(`อัปเดตสถานะ Check Permission อัตโนมัติ ${docIds.length} รายการ`);
  } catch (err) {
    console.error('Auto Check Permission update failed:', err);
    setSyncStatus('อัปเดตสถานะ Check Permission อัตโนมัติไม่สำเร็จ: ' + err.message, true);
  }
}

// ------ ซิงค์ข้อมูลแบบ real-time: ทุกครั้งที่มีคนแก้ไข/เพิ่ม/ลบ ทุก client จะเห็นทันที ------
function startRealtimeSync() {
  if (firestoreUnsub) firestoreUnsub();
  firestoreUnsub = window.FSDB.onSnapshot(
    snapshot => {
      const autoCheckUpdates = [];
      setPermissionTypeFormulaRegistry(null);
      DATA = snapshot.docs
        .map(docSnap => {
          const raw = docSnap.data();
          if (raw._kind === 'permission_next_auth') return null;
          if (raw._kind === 'permission_type_formulas') {
            setPermissionTypeFormulaRegistry(raw);
            return null;
          }
          raw._docId = docSnap.id;
          if (raw.id === undefined || raw.id === null || raw.id === '') raw.id = docSnap.id;
          if (shouldAutoCheckPermissionStatus(raw)) autoCheckUpdates.push({ docId: docSnap.id });
          return normalizeBuildingRecord(raw);
        })
        .filter(Boolean);
      const boqProfileCount = DATA.filter(item => item.boq_profile && typeof item.boq_profile === 'object').length;
      const costClassifiedCount = DATA.filter(item =>
        Number(item.boq_profile?.cost_classification_version) >= 1
      ).length;
      const syncStatus = document.getElementById('sync-status');
      if (syncStatus) {
        syncStatus.dataset.buildingCount = String(DATA.length);
        syncStatus.dataset.boqProfileCount = String(boqProfileCount);
        syncStatus.dataset.costClassifiedCount = String(costClassifiedCount);
      }
      setSyncStatus(`ซิงค์ล่าสุด ${new Date().toLocaleTimeString('th-TH')} • BOQ ${boqProfileCount}/${DATA.length} • Cost ${costClassifiedCount}/${DATA.length}`);
      applyFilters();
      persistAutoCheckPermissionStatuses(autoCheckUpdates);
    },
    err => {
      console.error('Firestore sync error:', err);
      setSyncStatus('เชื่อมต่อ Firestore ไม่สำเร็จ: ' + err.message, true);
    }
  );
}

async function initFirestoreData() {
  try {
    setSyncStatus('กำลังเชื่อมต่อ Firestore...');
    await migrateRawDataIfEmpty();
  } catch (err) {
    console.error('Migrate error:', err);
    setSyncStatus('นำเข้าข้อมูลเริ่มต้นไม่สำเร็จ: ' + err.message, true);
  }
  startRealtimeSync();
}

whenFsdbReady(initFirestoreData);
whenFsdbReady(initAuth);

if (typeof L === 'undefined') {
  const mapEl = document.getElementById('map');
  if (mapEl) {
    mapEl.innerHTML = `
      <div class="map-error">
        <div class="map-error-box">
          <strong>ไม่สามารถโหลดแผนที่ได้</strong><br>
          กรุณาตรวจสอบอินเทอร์เน็ต หรือเปิดใช้งานไฟล์ Leaflet ให้พร้อมก่อนใช้งาน
        </div>
      </div>`;
  }
  throw new Error('Leaflet library failed to load');
}

// ====== THEME ======
let isDark = false;
const themeBtn = document.getElementById('theme-btn');
let tileLayer;
// Keep the default map mode explicit: Mod2 uses the standard OpenStreetMap tiles.
let mapMode = 'osm';
const MAP_ATTRIBUTION = {
  osm: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
  esriImagery: 'Tiles &copy; <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a>',
  esriLabels: 'Labels &copy; <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a>'
};
const MAP_TILE_URLS = {
  osm: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  esriImagery: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  esriLabels: 'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'
};
const TILE_OPTIONS = {
  maxZoom: 19,
  updateWhenIdle: true,
  keepBuffer: 3
};

function applyTheme() {
  document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
  const ico = document.getElementById('theme-ico');
  const lbl = document.getElementById('theme-label');
  if(ico && lbl){
    lbl.textContent = isDark ? 'Dark' : 'Light';
    ico.innerHTML = isDark
      ? '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'
      : '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>';
  }
  if (tileLayer) {
    map.removeLayer(tileLayer);
    tileLayer = makeTile().addTo(map);
  }
}

function makeTile() {
  if (mapMode === 'satellite') {
    return L.tileLayer(MAP_TILE_URLS.esriImagery, {
      ...TILE_OPTIONS,
      attribution: MAP_ATTRIBUTION.esriImagery
    });
  }
  if (mapMode === 'hybrid') {
    return L.layerGroup([
      L.tileLayer(MAP_TILE_URLS.esriImagery, {
        ...TILE_OPTIONS,
        attribution: MAP_ATTRIBUTION.esriImagery
      }),
      L.tileLayer(MAP_TILE_URLS.esriLabels, {
        ...TILE_OPTIONS,
        attribution: MAP_ATTRIBUTION.esriLabels
      })
    ]);
  }
  return L.tileLayer(MAP_TILE_URLS.osm, {
    ...TILE_OPTIONS,
    noWrap: true,
    attribution: MAP_ATTRIBUTION.osm
  });
}

themeBtn.addEventListener('click', () => { isDark = !isDark; applyTheme(); });
document.getElementById('map-mode-toggle')?.addEventListener('click', e => {
  const btn = e.target.closest('button[data-mode]');
  if (!btn) return;
  mapMode = btn.dataset.mode;
  document.querySelectorAll('#map-mode-toggle button').forEach(b => b.classList.toggle('active', b === btn));
  if (tileLayer) map.removeLayer(tileLayer);
  tileLayer = makeTile().addTo(map);
});

// ====== MAP ======
const map = L.map('map', { center: [13.75, 100.52], zoom: 11, zoomControl: true });
tileLayer = makeTile().addTo(map);

// ====== DISTANCE MEASUREMENT ======
const measureButton = document.getElementById('measure-distance-btn');
const measureStatus = document.getElementById('measure-status');
const measureLayer = L.layerGroup().addTo(map);
const measurePreviewLayer = L.layerGroup().addTo(map);
let measureState = 'idle';
let measurePoints = [];
let measureLine = null;
let measureMarkers = [];

function formatMapDistance(meters) {
  if (meters < 1000) return `${Math.round(meters).toLocaleString('th-TH')} ม.`;
  const digits = meters < 10000 ? 2 : 1;
  return `${(meters / 1000).toLocaleString('th-TH', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  })} กม.`;
}

function getMeasuredDistance(points = measurePoints) {
  return points.slice(1).reduce((total, point, index) => {
    return total + map.distance(points[index], point);
  }, 0);
}

function setMeasureStatus(distance, instruction) {
  measureStatus.hidden = false;
  measureStatus.innerHTML = `<strong>ระยะรวม ${formatMapDistance(distance)}</strong><br>${instruction}`;
}

function updateMeasurementVisuals() {
  if (measureLine) measureLine.setLatLngs(measurePoints);
  let cumulativeDistance = 0;
  measureMarkers.forEach((marker, index) => {
    if (index) cumulativeDistance += map.distance(measurePoints[index - 1], measurePoints[index]);
    marker.setTooltipContent(index === 0 ? 'จุดเริ่มต้น' : formatMapDistance(cumulativeDistance));
  });
  const instruction = measureState === 'finished'
    ? 'ลากจุดเพื่อปรับเส้นทาง • กด “ล้างระยะ” เพื่อเริ่มใหม่'
    : 'ลากจุดเพื่อปรับ • คลิกเพิ่มจุด • ดับเบิลคลิกหรือคลิกขวาเพื่อจบ';
  setMeasureStatus(getMeasuredDistance(), instruction);
}

function renderMeasurement() {
  measureLayer.clearLayers();
  measureLine = null;
  measureMarkers = [];
  if (measurePoints.length > 1) {
    measureLine = L.polyline(measurePoints, {
      color: '#2563eb', weight: 4, opacity: .95, lineCap: 'round', lineJoin: 'round'
    }).addTo(measureLayer);
  }

  let cumulativeDistance = 0;
  measurePoints.forEach((point, index) => {
    if (index) cumulativeDistance += map.distance(measurePoints[index - 1], point);
    const label = index === 0 ? 'จุดเริ่มต้น' : formatMapDistance(cumulativeDistance);
    const marker = L.marker(point, {
      draggable: true,
      autoPan: true,
      keyboard: false,
      zIndexOffset: 1000,
      icon: L.divIcon({
        className: `measure-drag-marker${index === 0 ? ' measure-start-point' : ''}`,
        iconSize: [index === 0 ? 16 : 14, index === 0 ? 16 : 14],
        iconAnchor: [index === 0 ? 8 : 7, index === 0 ? 8 : 7]
      })
    }).bindTooltip(label, {
      permanent: true, direction: 'top', offset: [0, -7], className: 'measure-tooltip'
    }).addTo(measureLayer);
    marker.on('dragstart', () => measurePreviewLayer.clearLayers());
    marker.on('drag', e => {
      measurePoints[index] = e.target.getLatLng();
      updateMeasurementVisuals();
    });
    marker.on('dragend', e => {
      measurePoints[index] = e.target.getLatLng();
      updateMeasurementVisuals();
    });
    measureMarkers.push(marker);
  });
}

function clearMeasurement() {
  measureState = 'idle';
  measurePoints = [];
  measureLayer.clearLayers();
  measurePreviewLayer.clearLayers();
  measureLine = null;
  measureMarkers = [];
  measureStatus.hidden = true;
  measureStatus.textContent = '';
  measureButton.classList.remove('active');
  measureButton.setAttribute('aria-pressed', 'false');
  measureButton.textContent = 'วัดระยะ';
  document.getElementById('map').classList.remove('measuring');
  map.doubleClickZoom.enable();
}

function startMeasurement() {
  clearMeasurement();
  measureState = 'drawing';
  measureButton.classList.add('active');
  measureButton.setAttribute('aria-pressed', 'true');
  measureButton.textContent = 'ยกเลิก';
  document.getElementById('map').classList.add('measuring');
  map.doubleClickZoom.disable();
  setMeasureStatus(0, 'คลิกเพื่อวางจุด • ลากจุดเพื่อปรับ • ดับเบิลคลิกหรือคลิกขวาเพื่อจบ');
}

function finishMeasurement() {
  if (measureState !== 'drawing' || measurePoints.length < 2) return;
  measureState = 'finished';
  measurePreviewLayer.clearLayers();
  measureButton.textContent = 'ล้างระยะ';
  document.getElementById('map').classList.remove('measuring');
  map.doubleClickZoom.enable();
  setMeasureStatus(getMeasuredDistance(), 'ลากจุดเพื่อปรับเส้นทาง • กด “ล้างระยะ” เพื่อเริ่มใหม่');
}

measureButton?.addEventListener('click', () => {
  if (measureState === 'idle') startMeasurement();
  else clearMeasurement();
});

map.on('click', e => {
  if (measureState !== 'drawing') return;
  measurePoints.push(e.latlng);
  renderMeasurement();
  setMeasureStatus(getMeasuredDistance(), 'ลากจุดเพื่อปรับ • คลิกเพิ่มจุด • ดับเบิลคลิกหรือคลิกขวาเพื่อจบ');
});

map.on('mousemove', e => {
  if (measureState !== 'drawing' || !measurePoints.length) return;
  const previewPoints = [measurePoints[measurePoints.length - 1], e.latlng];
  measurePreviewLayer.clearLayers();
  L.polyline(previewPoints, {
    color: '#2563eb', weight: 3, opacity: .7, dashArray: '6 7', interactive: false
  }).addTo(measurePreviewLayer);
  const previewDistance = getMeasuredDistance() + map.distance(previewPoints[0], previewPoints[1]);
  setMeasureStatus(previewDistance, 'ลากจุดเพื่อปรับ • คลิกเพิ่มจุด • ดับเบิลคลิกหรือคลิกขวาเพื่อจบ');
});

map.on('dblclick', e => {
  if (measureState !== 'drawing') return;
  if (measurePoints.length > 1) {
    const last = map.latLngToContainerPoint(measurePoints[measurePoints.length - 1]);
    const previous = map.latLngToContainerPoint(measurePoints[measurePoints.length - 2]);
    if (last.distanceTo(previous) <= 8) measurePoints.pop();
  }
  renderMeasurement();
  finishMeasurement();
  if (e.originalEvent) L.DomEvent.stop(e.originalEvent);
});

map.on('contextmenu', e => {
  if (measureState !== 'drawing') return;
  finishMeasurement();
  if (e.originalEvent) L.DomEvent.preventDefault(e.originalEvent);
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && measureState !== 'idle') clearMeasurement();
});

// ====== MARKER COLORS ======
function statusColor(s) {
  if (s === 'Permission Confirmed') return '#22c55e';
  if (s === 'MOU') return '#a855f7';
  if (s === 'อาคารปิดถาวร') return '#ef4444';
  return '#f59e0b';
}
function makeIcon(color, isSelected) {
  const width = isSelected ? 42 : 34;
  const height = isSelected ? 52 : 42;
  return L.divIcon({
    className: '',
    html: `<div class="pm-marker ${isSelected ? 'selected' : ''}" style="--marker-color:${color}">
      <svg width="${width}" height="${height}" viewBox="0 0 34 42" aria-hidden="true">
        <path class="pin-shell" d="M17 1.75c8.2 0 14.85 6.35 14.85 14.18 0 9.75-11.02 21.22-14.1 24.23a1.08 1.08 0 0 1-1.5 0C13.17 37.15 2.15 25.68 2.15 15.93 2.15 8.1 8.8 1.75 17 1.75Z"/>
        <circle class="pin-core" cx="17" cy="16" r="8.2"/>
        <circle class="pin-glint" cx="14.4" cy="13.25" r="2.05"/>
      </svg>
    </div>`,
    iconSize: [width, height], iconAnchor: [width / 2, height - 2], popupAnchor: [0, -height + 8]
  });
}

// ====== TOOLTIP ======
const tooltip = document.getElementById('map-tooltip');

function showTooltip(x, y, r) {
  document.getElementById('tt-name').textContent = r.name_th || '—';
  document.getElementById('tt-eng').textContent = r.name_eng || '';
  document.getElementById('tt-row').innerHTML = `
    <span class="tag ${statusTag(r.status)}">${esc(r.status||'')}</span>
    ${r.area ? `<span class="tag tag-neutral">${esc(r.area)}</span>` : ''}
    ${r.type ? `<span class="tag ${typeTag(r.type)}">${esc(r.type)}</span>` : ''}
  `;
  tooltip.style.display = 'block';
  posTooltip(x, y);
}
function posTooltip(x, y) {
  const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
  const mw = document.getElementById('map-wrap').offsetWidth;
  const mh = document.getElementById('map-wrap').offsetHeight;
  let left = x + 14, top = y - th / 2;
  if (left + tw > mw - 10) left = x - tw - 14;
  if (top < 10) top = 10;
  if (top + th > mh - 10) top = mh - th - 10;
  tooltip.style.left = left + 'px';
  tooltip.style.top = top + 'px';
}
function hideTooltip() { tooltip.style.display = 'none'; }

// ====== DETAIL DRAWER ======
let selectedId = null;
let allMarkers = [];
const statusLayerSet = new Set(['Permission Confirmed', 'MOU', 'Check Permission', 'อาคารปิดถาวร']);
let lastRenderedData = DATA;

function statusTag(s) {
  if (s === 'Permission Confirmed') return 'tag-confirmed';
  if (s === 'MOU') return 'tag-mou';
  if (s === 'อาคารปิดถาวร') return 'tag-closed';
  return 'tag-check';
}
function groupTag(g) {
  if (g === 'Priority 1') return 'tag-p1';
  if (g === 'Priority 2') return 'tag-p2';
  return 'tag-x';
}
function typeTag(t) {
  if (t === 'L1') return 'tag-l1';
  if (t === 'L2') return 'tag-l2';
  if (t === 'L3') return 'tag-l3';
  return 'tag-neutral';
}
function canCalculateQuotation(status) {
  return !['MOU', 'อาคารปิดถาวร'].includes(String(status || '').trim());
}
function isStatusLayerVisible(status) {
  if (!statusLayerSet.has(status)) return true;
  const btn = [...document.querySelectorAll('.layer-toggle')].find(el => el.dataset.statusLayer === status);
  return btn?.classList.contains('off') !== true;
}
function updateLegendCounts(data) {
  document.getElementById('legend-confirmed').textContent = data.filter(r=>r.status==='Permission Confirmed').length;
  document.getElementById('legend-mou').textContent = data.filter(r=>r.status==='MOU').length;
  document.getElementById('legend-check').textContent = data.filter(r=>r.status==='Check Permission').length;
  document.getElementById('legend-closed').textContent = data.filter(r=>r.status==='อาคารปิดถาวร').length;
}
function fitVisibleMarkers() {
  const points = allMarkers.map(({marker}) => marker.getLatLng()).filter(Boolean);
  if (!points.length) return;
  if (points.length === 1) {
    map.setView(points[0], Math.max(map.getZoom(), 16), { animate: true });
    return;
  }
  map.fitBounds(L.latLngBounds(points).pad(0.14), { animate: true, maxZoom: 16 });
}
function fmt(v, pre='฿') {
  if (v === null || v === undefined || v === '' || v === 0) return '—';
  const n = Number(v);
  if (isNaN(n)) return v;
  return pre + n.toLocaleString('th-TH');
}
function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function attrEsc(s) { return esc(s).replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function mapHref(r) {
  const lat = Number(r.lat);
  const lng = Number(r.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return '';
  return `https://maps.google.com/?q=${lat},${lng}`;
}
function coordText(r) {
  const lat = Number(r.lat);
  const lng = Number(r.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return '';
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}
async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}
function svgIcon(name, cls = 'svg-icon') {
  const icons = {
    alert: '<path d="M12 3 2.8 20h18.4L12 3Z"/><path d="M12 9v5"/><path d="M12 17h.01"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    vertical: '<path d="M12 3v18"/><path d="m7 8 5-5 5 5"/><path d="m7 16 5 5 5-5"/>',
    horizontal: '<path d="M3 12h18"/><path d="m8 7-5 5 5 5"/><path d="m16 7 5 5-5 5"/>',
    ruler: '<path d="M4 17 17 4l3 3L7 20l-3-3Z"/><path d="m14 7 3 3"/><path d="m11 10 2 2"/><path d="m8 13 3 3"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>',
    download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
    image: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8" cy="10" r="1.5"/><path d="m21 15-5-5L5 19"/>',
    calc: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8"/><path d="M8 11h.01"/><path d="M12 11h.01"/><path d="M16 11h.01"/><path d="M8 15h.01"/><path d="M12 15h.01"/><path d="M16 15h.01"/>',
    reset: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v6h6"/>',
    clip: '<path d="M9 3h6l2 2v3H7V5l2-2Z"/><path d="M7 8h10v13H7z"/><path d="M9 13h6"/><path d="M9 17h6"/>',
    eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="3"/>'
  };
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.alert}</svg>`;
}
function iconText(name, text) {
  return `${svgIcon(name)}<span>${esc(text)}</span>`;
}

const BUILDING_DOCUMENT_CATEGORIES = Object.freeze({
  dwg: { label: 'แบบ DWG', extensions: new Set(['dwg']), icon: 'file' },
  pdf: { label: 'เอกสาร PDF', extensions: new Set(['pdf']), icon: 'file' },
  image: {
    label: 'รูปภาพ',
    extensions: new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'tif', 'tiff', 'bmp', 'heic', 'heif']),
    icon: 'image'
  }
});
const MAX_BUILDING_DOCUMENT_FILES = 1500;
const DEFAULT_LOCAL_NAS_BRIDGE_URL = 'http://127.0.0.1:8766';
const buildingDocumentsCache = new Map();
let nasBridgeBasePromise = null;

function normalizeNasBridgeBase(value) {
  return String(value || '').trim().replace(/\/$/, '');
}

async function findNasBridgeBase() {
  const configuredBase = normalizeNasBridgeBase(window.PERMISSION_NAS_BRIDGE_URL);
  const currentIsBridge = ['127.0.0.1', 'localhost'].includes(location.hostname)
    && location.port === '8766';
  const candidates = [...new Set([
    configuredBase,
    currentIsBridge ? location.origin : '',
    DEFAULT_LOCAL_NAS_BRIDGE_URL
  ].filter(Boolean))];

  for (const base of candidates) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1800);
    try {
      const response = await fetch(base + '/api/nas/health', {
        cache: 'no-store',
        mode: 'cors',
        targetAddressSpace: 'loopback',
        signal: controller.signal
      });
      const health = response.ok ? await response.json() : null;
      if (response.headers.get('X-Permission-NAS-Bridge') === '1' && health?.nas_access === true) return base;
    } catch (err) {
      console.warn('NAS Bridge candidate unavailable:', base, err?.message || err);
    } finally {
      clearTimeout(timeout);
    }
  }
  return null;
}

function getNasBridgeBase() {
  if (!nasBridgeBasePromise) nasBridgeBasePromise = findNasBridgeBase();
  return nasBridgeBasePromise;
}

function releaseBuildingDocumentUrls(data) {
  for (const file of data?.files || []) {
    if (String(file?.download_url || '').startsWith('blob:')) URL.revokeObjectURL(file.download_url);
  }
}

function clearBuildingDocumentsCache() {
  for (const data of buildingDocumentsCache.values()) releaseBuildingDocumentUrls(data);
  buildingDocumentsCache.clear();
}

function cacheBuildingDocuments(key, data) {
  releaseBuildingDocumentUrls(buildingDocumentsCache.get(key));
  buildingDocumentsCache.set(key, data);
}

function buildingDocumentKey(record) {
  return String(record?._docId || record?.id || '');
}

function formatDocumentSize(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value.toLocaleString('th-TH')} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toLocaleString('th-TH', { maximumFractionDigits: 1 })} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toLocaleString('th-TH', { maximumFractionDigits: 1 })} MB`;
  return `${(value / 1024 ** 3).toLocaleString('th-TH', { maximumFractionDigits: 1 })} GB`;
}

function formatDocumentTimestamp(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('th-TH', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function normalizedBuildingDocumentData(raw, record) {
  const files = (Array.isArray(raw?.files) ? raw.files : [])
    .map(file => ({
      name: String(file?.name || ''),
      download_url: String(file?.download_url || ''),
      category: String(file?.category || ''),
      extension: String(file?.extension || '').toLowerCase(),
      size: Number(file?.size) || 0,
      modified_at: file?.modified_at || null
    }))
    .filter(file => file.name && BUILDING_DOCUMENT_CATEGORIES[file.category]);
  return {
    building_id: raw?.building_id || buildingDocumentKey(record),
    files,
    synced_at: raw?.synced_at || null,
    synced_by: raw?.synced_by || ''
  };
}

function buildingDocumentRowsHtml(files) {
  return files.map(file => `
    <div class="building-doc-row">
      <span class="building-doc-type ${attrEsc(file.category)}">${esc(file.extension.toUpperCase())}</span>
      <div class="building-doc-info">
        <strong title="${attrEsc(file.name)}">${esc(file.name)}</strong>
        <span>${esc(formatDocumentSize(file.size))} • ${esc(formatDocumentTimestamp(file.modified_at))}</span>
      </div>
      ${file.download_url ? `<a class="building-doc-download" href="${attrEsc(file.download_url)}" download="${attrEsc(file.name)}" title="ดาวน์โหลด ${attrEsc(file.name)}">${svgIcon('download')}<span>Download</span></a>` : ''}
    </div>
  `).join('');
}

function renderBuildingDocuments(record, options = {}) {
  const panel = document.getElementById('tab-documents');
  if (!panel) return;
  if (!canViewBuildingDocuments()) {
    panel.innerHTML = '';
    return;
  }

  const key = buildingDocumentKey(record);
  const data = normalizedBuildingDocumentData(options.data ?? buildingDocumentsCache.get(key), record);
  const files = data.files.map((file, index) => ({ ...file, _index: index }));
  if (options.loading) {
    panel.innerHTML = '<div class="building-doc-empty">กำลังโหลดรายการเอกสาร...</div>';
    return;
  }

  const statusMessage = options.error
    ? `<div class="building-doc-status error">${esc(options.error)}</div>`
    : options.message
      ? `<div class="building-doc-status success">${esc(options.message)}</div>`
      : '';

  const categorySections = Object.entries(BUILDING_DOCUMENT_CATEGORIES).map(([category, config]) => {
    const categoryFiles = files.filter(file => file.category === category);
    return `
      <section class="building-doc-category">
        <button class="building-doc-category-head" type="button"
          data-document-category="${attrEsc(category)}"
          aria-expanded="false"
          aria-controls="building-doc-list-${attrEsc(category)}"
          ${categoryFiles.length ? '' : 'disabled'}>
          <span>${svgIcon(config.icon)}${esc(config.label)}</span>
          <span class="building-doc-category-meta">
            <strong>${categoryFiles.length.toLocaleString('th-TH')}</strong>
            <svg class="building-doc-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m8 10 4 4 4-4"/></svg>
          </span>
        </button>
        <div class="building-doc-list" id="building-doc-list-${attrEsc(category)}" hidden></div>
      </section>
    `;
  }).join('');

  panel.innerHTML = `
    <div class="building-doc-toolbar">
      <div>
        <div class="section-head">เอกสารอาคารจาก NAS</div>
        <p>ระบบค้นหาเอกสารให้อัตโนมัติ และเปิดให้ดาวน์โหลดเฉพาะไฟล์ที่พบ</p>
      </div>
    </div>
    ${statusMessage}
    <div class="building-doc-summary">
      <span>รวม <strong>${files.length.toLocaleString('th-TH')}</strong> ไฟล์</span>
      <span>ตรวจล่าสุด <strong>${esc(formatDocumentTimestamp(data.synced_at))}</strong></span>
      ${data.synced_by ? `<span>โดย <strong>${esc(data.synced_by)}</strong></span>` : ''}
    </div>
    ${categorySections}
  `;
}

document.getElementById('tab-documents').addEventListener('click', event => {
  const toggle = event.target.closest('.building-doc-category-head');
  if (!toggle || toggle.disabled) return;
  const list = document.getElementById(toggle.getAttribute('aria-controls'));
  if (!list) return;

  const willExpand = toggle.getAttribute('aria-expanded') !== 'true';
  toggle.setAttribute('aria-expanded', String(willExpand));
  toggle.closest('.building-doc-category')?.classList.toggle('expanded', willExpand);
  list.hidden = !willExpand;

  if (willExpand && !list.dataset.rendered) {
    const record = findBuildingById(selectedId);
    const data = normalizedBuildingDocumentData(
      buildingDocumentsCache.get(buildingDocumentKey(record)),
      record
    );
    const category = toggle.dataset.documentCategory;
    list.innerHTML = buildingDocumentRowsHtml(data.files.filter(file => file.category === category));
    list.dataset.rendered = 'true';
  }
});

async function loadBuildingDocuments(record) {
  if (!canViewBuildingDocuments()) return;
  const key = buildingDocumentKey(record);
  if (!key) return;
  try {
    await syncBuildingDocuments(record);
  } catch (err) {
    console.warn('Automatic building document search unavailable:', err?.message || err);
    if (String(selectedId) === String(record.id)) {
      renderBuildingDocuments(record, {
        data: buildingDocumentsCache.get(key),
        error: 'ค้นหารายการเอกสารอัตโนมัติไม่สำเร็จ: ' + err.message
      });
    }
  }
}

async function discoverBuildingDocumentsFromNas(record) {
  const bridgeBase = await getNasBridgeBase();
  if (!bridgeBase) return null;
  const query = new URLSearchParams({
    nameTh: record?.name_th || '',
    nameEng: record?.name_eng || '',
    area: record?.area || ''
  });
  let response;
  try {
    response = await fetch(bridgeBase + '/api/nas/building-documents?' + query.toString(), {
      cache: 'no-store',
      mode: 'cors',
      targetAddressSpace: 'loopback'
    });
  } catch {
    return null;
  }
  if (response.headers.get('X-Permission-NAS-Bridge') !== '1') return null;
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'ค้นหาโฟลเดอร์อาคารใน NAS ไม่สำเร็จ');
  return {
    files: (Array.isArray(result.files) ? result.files : []).map(file => ({
      ...file,
      download_url: file.download_url ? new URL(file.download_url, bridgeBase + '/').href : ''
    }))
  };
}

async function syncBuildingDocuments(record) {
  if (!canViewBuildingDocuments()) throw new Error('บัญชีนี้ไม่มีสิทธิ์ดูหรือค้นหาเอกสาร');
  const key = buildingDocumentKey(record);
  if (!key) throw new Error('ไม่พบรหัสอาคารสำหรับค้นหาเอกสาร');
  const currentData = normalizedBuildingDocumentData(buildingDocumentsCache.get(key), record);
  if (String(selectedId) === String(record.id)) {
    renderBuildingDocuments(record, { data: currentData, syncing: true });
  }

  let selected;
  try {
    selected = await discoverBuildingDocumentsFromNas(record);
  } catch (err) {
    if (err?.name === 'AbortError') {
      if (String(selectedId) === String(record.id)) renderBuildingDocuments(record, { data: currentData });
      return;
    }
    throw err;
  }
  if (!selected) {
    nasBridgeBasePromise = null;
    throw new Error('เชื่อมต่อเอกสาร NAS ไม่ได้ กรุณาอนุญาต Local Network Access ของเว็บไซต์ และตรวจว่า Permission NAS Bridge เปิดอยู่');
  }
  if (selected.files.length > MAX_BUILDING_DOCUMENT_FILES) {
    throw new Error(`จำนวนไฟล์เกิน ${MAX_BUILDING_DOCUMENT_FILES.toLocaleString('th-TH')} รายการ กรุณาแยกโฟลเดอร์อาคารให้เล็กลง`);
  }
  if (!selected.files.length) {
    throw new Error('ไม่พบไฟล์ DWG, PDF หรือรูปภาพในโฟลเดอร์ที่เลือก');
  }
  const files = selected.files
    .map(file => ({ ...file }))
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name, 'th'));
  const payload = {
    building_id: record.id,
    files,
    synced_at: new Date().toISOString()
  };
  cacheBuildingDocuments(key, payload);
  if (String(selectedId) === String(record.id)) {
    renderBuildingDocuments(record, {
      data: payload,
      message: `ค้นหาเอกสารจาก NAS สำเร็จ ${files.length.toLocaleString('th-TH')} ไฟล์`
    });
  }
}

function formatPhone(p) {
  const raw = String(p).trim();
  if (!raw || raw === '-') return raw;

  // แยก extension ออกจากเบอร์หลัก: #XXXX, ext.XXXX, ext XXXX, ต่อ XXXX, ·XXXX
  const extMatch = raw.match(/^(.+?)\s*(?:#|ext\.?\s*|ต่อ\s*|·\s*)\s*([\d,]+)\s*$/i);

  let mainPart, extPart;
  if (extMatch) {
    mainPart = extMatch[1].trim();
    extPart = extMatch[2].trim();
  } else {
    mainPart = raw;
    extPart = null;
  }

  // เอาเฉพาะตัวเลขและ + (กรณี +66)
  let digits = mainPart.replace(/[^\d+]/g, "");
  digits = digits.replace(/^\+66/, "0");
  if (digits && !digits.startsWith("0") && !digits.startsWith("+")) digits = "0" + digits;

  let display;
  if (/^02/.test(digits) && digits.length === 9) {
    // กทม. 9 หลัก: 02-XXXX-XXXX
    display = "02-" + digits.slice(2,6) + "-" + digits.slice(6);
  } else if (/^0[3-9]\d/.test(digits) && (digits.length === 8 || digits.length === 9)) {
    // ต่างจังหวัด: 0XX-XXX-XX หรือ 0XX-XXX-XXX
    display = digits.slice(0,3) + "-" + digits.slice(3,6) + "-" + digits.slice(6);
  } else if (/^0[689]\d/.test(digits) && digits.length === 10) {
    // มือถือ 10 หลัก: 0XX-XXX-XXXX
    display = digits.slice(0,3) + "-" + digits.slice(3,6) + "-" + digits.slice(6);
  } else {
    display = digits || raw;
  }

  // ต่อ extension (ใช้ "ต่อ" เป็น standard)
  if (extPart) {
    const exts = extPart.split(",").map(x => x.trim()).filter(Boolean);
    display += " ต่อ " + exts.join(", ");
  }

  return display;
}

function formatPhoneTelLink(p) {
  const raw = String(p).trim();
  if (!raw || raw === '-') return { display: raw, tel: '' };

  const extMatch = raw.match(/^(.+?)\s*(?:#|ext\.?\s*|ต่อ\s*|·\s*)\s*([\d,]+)\s*$/i);
  let mainPart = extMatch ? extMatch[1].trim() : raw;

  let digits = mainPart.replace(/[^\d+]/g, "");
  digits = digits.replace(/^\+66/, "0");
  if (digits && !digits.startsWith("0") && !digits.startsWith("+")) digits = "0" + digits;

  return { display: formatPhone(p), tel: digits };
}

function openDrawer(r) {
  selectedId = r.id;
  const buildingMapHref = mapHref(r);
  const buildingCoordText = coordText(r);

  // Update sidebar selection
  document.querySelectorAll('.list-item').forEach(el => {
    el.classList.toggle('selected', String(el.dataset.id) === String(r.id));
  });
  const sel = document.querySelector('.list-item[data-id="'+r.id+'"]');
  if (sel) sel.scrollIntoView({ block:'nearest', behavior:'smooth' });

  // Update marker sizes
  allMarkers.forEach(({marker, data:d}) => {
    marker.setIcon(makeIcon(statusColor(d.status), d.id === r.id));
  });

  // Header
  document.getElementById('d-title').textContent = r.name_th || '—';
  document.getElementById('d-eng').textContent = r.name_eng || '';
  document.getElementById('d-tags').innerHTML = `
    <span class="tag ${statusTag(r.status)}">${esc(r.status||'—')}</span>
    <span class="tag ${groupTag(r.group)}">${esc(r.group||'—')}</span>
    ${r.survey_type ? `<span class="tag tag-neutral">${esc(r.survey_type)}</span>` : ''}
    ${r.type ? `<span class="tag ${typeTag(r.type)}">${esc(r.type)}</span>` : ''}
    ${r.install_type ? `<span class="tag tag-neutral">${esc(r.install_type)}</span>` : ''}
  `;

  // Tab: General
  document.getElementById('tab-general').innerHTML = `
    <div class="section-head" style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
      <span>ข้อมูลอาคาร</span>
      ${canManageBuildings() ? `<button class="edit-building-btn" type="button" data-building-id="${attrEsc(r.id)}" style="border:1px solid var(--border2);background:var(--surface2);color:var(--text2);border-radius:8px;padding:6px 10px;cursor:pointer;font-size:12px;">แก้ไขข้อมูล</button>` : ''}
    </div>
    <div class="info-grid">
      <div class="info-cell"><label>Area</label><p>${esc(r.area||'—')}</p></div>
      <div class="info-cell"><label>จังหวัด</label><p>${esc(r.province||'—')}</p></div>
      <div class="info-cell"><label>ทำเล / โซน</label><p>${esc(r.location||'—')}</p></div>
      <div class="info-cell"><label>ระยะ Permission</label><p>${r.duration ? esc(r.duration)+' วัน' : '—'}</p></div>
      <div class="info-cell"><label>อัปเดตล่าสุด</label><p>${esc(formatBuildingUpdateDate(r.update_date))}</p></div>
      <div class="info-cell"><label>WM Point</label><p>${esc(r.wm_point||'—')}</p></div>
      <div class="info-cell"><label>Enclosure</label><p>${esc(r.enclosure||'—')}</p></div>
      <div class="info-cell"><label>Max H-Wire (ม.)</label><p>${esc(r.max_horizontal||'—')}</p></div>
      ${r.address ? `<div class="info-cell full"><label>ที่อยู่</label><p style="font-size:12px;line-height:1.6;color:var(--text2)">${esc(r.address)}${buildingMapHref ? ` <a href="${attrEsc(buildingMapHref)}" target="_blank" rel="noopener" style="font-size:11px;margin-left:6px">ดูแผนที่</a>` : ''}</p></div>` : ''}
      ${buildingMapHref ? `<div class="info-cell"><label>พิกัด</label><p class="coord-row"><a href="${attrEsc(buildingMapHref)}" target="_blank" rel="noopener">${esc(buildingCoordText)}</a><button class="copy-coord-btn" type="button" data-copy-coord="${attrEsc(buildingCoordText)}">${svgIcon('clip')}<span>คัดลอก</span></button></p></div>` : ''}
      ${r.remark ? `<div class="info-cell full"><div class="remark-box">${esc(r.remark)}</div></div>` : ''}
      ${canCalculateQuotation(r.status) ? `
      <div class="info-cell full" style="margin-top: 15px; padding-top: 15px; border-top: 1px solid var(--border);">
        <button class="quotation-open-btn" data-building-id="${attrEsc(r.id)}" style="width: 100%; padding: 12px; background: var(--green); color: white; border: none; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; transition: all .18s; font-family: inherit;">ประเมินราคาเบื้องต้น</button>
      </div>` : ''}
    </div>
  `;
  applyRoleUi();

  // Tab: Contact
  const contacts = (String(r.contact||'')).split(/[,\/]/).map(s=>s.trim()).filter(Boolean);
  const phones = (String(r.phone||'')).split(/[,\/]/).map(s=>s.trim()).filter(Boolean);
  const mobiles = (String(r.mobile||'')).split(/[,\/]/).map(s=>s.trim()).filter(Boolean);
  const emails = (String(r.email||'')).split(/[,;]/).map(s=>s.trim()).filter(Boolean);
  document.getElementById('tab-contact').innerHTML = `
    <div class="section-head">ผู้ติดต่อ</div>
    <div class="contact-card">
      <div class="contact-name">${contacts.length ? contacts.map(esc).join(' / ') : '—'}</div>
      ${phones.length ? `<div class="contact-row"><span class="ico"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.84 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.77 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.15a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg></span><span class="val">${phones.map(p=>{const r=formatPhoneTelLink(p); return r.tel ? `<a href="tel:${attrEsc(r.tel)}">${esc(r.display)}</a>` : `<span>${esc(r.display)}</span>`;}).join('<br>')}</span></div>` : ''}
      ${mobiles.length ? `<div class="contact-row"><span class="ico"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg></span><span class="val">${mobiles.map(m=>{const r=formatPhoneTelLink(m); return r.tel ? `<a href="tel:${attrEsc(r.tel)}">${esc(r.display)}</a>` : `<span>${esc(r.display)}</span>`;}).join('<br>')}</span></div>` : ''}
      ${emails.length ? `<div class="contact-row"><span class="ico"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg></span><span class="val">${emails.map(e=>`<a href="mailto:${attrEsc(e)}">${esc(e)}</a>`).join('<br>')}</span></div>` : ''}
      ${!contacts.length && !phones.length && !mobiles.length && !emails.length ? '<p style="color:var(--muted);font-size:13px">ไม่มีข้อมูลผู้ติดต่อ</p>' : ''}
    </div>
  `;

  // Tab: Fee
  const feeRows = getBuildingBoqFees(r)
    .filter(item => item.calculation_type === 'revenue_share'
      ? Number(item.rate) !== 0
      : item.amount !== 0)
    .map(item => {
      const isRevenueShare = item.calculation_type === 'revenue_share';
      return {
        label: item.label,
        amount: isRevenueShare ? null : item.amount,
        valueText: isRevenueShare
          ? `${formatCurrencyNumeric(Number(item.rate) || 0)}%`
          : fmt(item.amount),
        detail: isRevenueShare
          ? [item.cost_type, `คิดจากรายได้${item.revenue_period === 'annual' ? 'รายปี' : 'รายเดือน'}`].filter(Boolean).join(' • ')
          : [item.cost_type, item.unit !== 'ครั้ง' ? item.unit : ''].filter(Boolean).join(' • ')
      };
    });

  const totalFee = feeRows.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);

  document.getElementById('tab-fee').innerHTML = feeRows.length
    ? `<div class="section-head">ค่าธรรมเนียม</div>
       <table class="fee-table">
         ${feeRows.map(item => `<tr><td>${esc(item.label)}${item.detail ? `<br><span style="font-size:11px;color:var(--muted);font-weight:600">${esc(item.detail)}</span>` : ''}</td><td>${esc(item.valueText)}</td></tr>`).join('')}
         ${totalFee > 0 ? `<tr class="fee-total-row"><td>รวมทั้งหมด</td><td>${fmt(totalFee)}</td></tr>` : ''}
       </table>`
    : `<div class="no-fee">ไม่มีข้อมูลค่าธรรมเนียม</div>`;

  if (canViewBuildingDocuments()) loadBuildingDocuments(r);
  else document.getElementById('tab-documents').innerHTML = '';

  // Reset to first tab
  switchTab('general');
}
window.openDrawer = openDrawer;

function switchTab(name) {
  if (name === 'documents' && !canViewBuildingDocuments()) name = 'general';
  document.querySelectorAll('.dtab').forEach(t => {
    const active = t.dataset.tab === name;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', String(active));
    t.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll('.tab-panel').forEach(p => {
    const active = p.id === 'tab-'+name;
    p.classList.toggle('active', active);
    p.hidden = !active;
  });
}

document.getElementById('drawer-tabs').addEventListener('click', e => {
  const tab = e.target.closest('.dtab');
  if (tab) switchTab(tab.dataset.tab);
});
document.getElementById('drawer-tabs').addEventListener('keydown', e => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  const tabs = [...e.currentTarget.querySelectorAll('[role="tab"]')]
    .filter(tab => !tab.classList.contains('role-hidden'));
  const currentIndex = tabs.indexOf(document.activeElement);
  if (currentIndex < 0) return;
  e.preventDefault();
  let nextIndex = currentIndex;
  if (e.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
  if (e.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
  if (e.key === 'Home') nextIndex = 0;
  if (e.key === 'End') nextIndex = tabs.length - 1;
  switchTab(tabs[nextIndex].dataset.tab);
  tabs[nextIndex].focus();
});
document.getElementById('tab-general').addEventListener('click', e => {
  const copyBtn = e.target.closest('.copy-coord-btn');
  if (copyBtn) {
    copyText(copyBtn.dataset.copyCoord || '').then(() => {
      const label = copyBtn.querySelector('span');
      copyBtn.classList.add('copied');
      if (label) label.textContent = 'คัดลอกแล้ว';
      setTimeout(() => {
        copyBtn.classList.remove('copied');
        if (label) label.textContent = 'คัดลอก';
      }, 1600);
    });
    return;
  }
  const editBtn = e.target.closest('.edit-building-btn');
  if (editBtn) {
    if (!canManageBuildings()) {
      alert('บัญชีนี้ไม่มีสิทธิ์แก้ไขข้อมูลอาคาร');
      return;
    }
    const record = DATA.find(d => String(d.id) === String(editBtn.dataset.buildingId));
    openBuildingEditor(record || null);
    return;
  }
  const btn = e.target.closest('.quotation-open-btn');
  if (btn) quickCalculateQuotation(btn.dataset.buildingId);
});
document.addEventListener('click', e => {
  const btn = e.target.closest('.lf-popup-action');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  openDrawerById(btn.dataset.popupBuildingId);
});

// drawer-close handled by modal manager below

// ====== LAYER GROUP ======
const layerGroup = (L.markerClusterGroup ? L.markerClusterGroup({
  showCoverageOnHover: false,
  maxClusterRadius: 46,
  spiderfyOnMaxZoom: true,
  iconCreateFunction(cluster) {
    return L.divIcon({
      html: `<div class="pm-cluster">${cluster.getChildCount()}</div>`,
      className: 'marker-cluster',
      iconSize: [42, 42],
      iconAnchor: [21, 21]
    });
  }
}) : L.layerGroup()).addTo(map);

function openDrawerById(id) {
  const r = findBuildingById(id);
  map.closePopup();
  if (r) window.openDrawer(r);
}

function buildMarkerPopup(r) {
  const color = statusColor(r.status);
  return `
    <div class="lf-popup-premium" style="--popup-color:${color}">
      <div class="lf-popup-head">
        <span class="lf-popup-dot"></span>
        <div>
          <div class="lf-popup-title">${esc(r.name_th||'—')}</div>
          <div class="lf-popup-sub">${esc(r.name_eng||'')}${r.area ? ` · ${esc(r.area)}` : ''}</div>
        </div>
      </div>
      <div class="lf-popup-body">
        <div class="lf-popup-tags">
          <span class="tag ${statusTag(r.status)}">${esc(r.status||'—')}</span>
          ${r.type ? `<span class="tag ${typeTag(r.type)}">${esc(r.type)}</span>` : ''}
          ${r.install_type ? `<span class="tag tag-neutral">${esc(r.install_type)}</span>` : ''}
        </div>
        <button class="lf-popup-action" type="button" data-popup-building-id="${attrEsc(r.id)}">ดูรายละเอียด</button>
      </div>
    </div>
  `;
}

function renderMarkers(data) {
  layerGroup.clearLayers();
  allMarkers = [];
  const usedCoords = {};
  data.filter(r => isStatusLayerVisible(r.status)).forEach(r => {
    const lat = parseFloat(r.lat);
    const lng = parseFloat(r.lng);
    if (!lat || !lng || lat < 5 || lat > 25) return;
    
    let mapLat = lat;
    let mapLng = lng;
    const coordKey = `${mapLat.toFixed(5)},${mapLng.toFixed(5)}`;
    
    if (usedCoords[coordKey] !== undefined) {
      usedCoords[coordKey]++;
      const offsetCount = usedCoords[coordKey];
      // กระจายจุดที่ซ้อนกัน (Jitter)
      const angle = offsetCount * Math.PI / 4;
      const radius = 0.00015 + (offsetCount * 0.00005);
      mapLat += radius * Math.cos(angle);
      mapLng += radius * Math.sin(angle);
    } else {
      usedCoords[coordKey] = 0;
    }

    const marker = L.marker([mapLat, mapLng], {
      icon: makeIcon(statusColor(r.status), r.id === selectedId)
    }).bindPopup(buildMarkerPopup(r), { closeButton: true, minWidth: 230, maxWidth: 280 });

    // Hover tooltip (mouseover/mouseout)
    marker.on('mouseover', function(e) {
      const mp = document.getElementById('map-wrap').getBoundingClientRect();
      const px = e.originalEvent.clientX - mp.left;
      const py = e.originalEvent.clientY - mp.top;
      showTooltip(px, py, r);
    });
    marker.on('mousemove', function(e) {
      const mp = document.getElementById('map-wrap').getBoundingClientRect();
      posTooltip(e.originalEvent.clientX - mp.left, e.originalEvent.clientY - mp.top);
    });
    marker.on('mouseout', hideTooltip);

    // Click → open drawer
    marker.on('click', function() {
      hideTooltip();
      marker.openPopup();
    });

    layerGroup.addLayer(marker);
    allMarkers.push({ marker, data: r });
  });
}

function render(data) {
  lastRenderedData = data;

  const conf = data.filter(r=>r.status==='Permission Confirmed').length;
  const mou  = data.filter(r=>r.status==='MOU').length;
  const chk  = data.filter(r=>r.status==='Check Permission').length;
  const closed = data.filter(r=>r.status==='อาคารปิดถาวร').length;
  document.getElementById('st-confirmed').textContent = conf;
  document.getElementById('st-mou').textContent = mou;
  document.getElementById('st-check').textContent = chk;
  document.getElementById('st-closed').textContent = closed;
  const totalBadge = document.getElementById('total-badge');
  if (totalBadge) totalBadge.textContent = data.length;
  document.getElementById('result-count').textContent = `แสดง ${data.length} รายการ`;
  document.getElementById('sb-count').textContent = data.length + ' รายการ';
  updateLegendCounts(data);

  // Sidebar list
  const list = document.getElementById('sidebar-list');
  list.innerHTML = '';
  const listFrag = document.createDocumentFragment();
  data.forEach(r => {
    const el = document.createElement('div');
    el.className = 'list-item' + (r.id === selectedId ? ' selected' : '');
    el.dataset.id = r.id;
    el.innerHTML = `
      <div class="li-name">${esc(r.name_th||'—')}</div>
      <div class="li-eng">${esc(r.name_eng||'')}</div>
      <div class="li-meta">
        <span class="tag ${statusTag(r.status)}">${esc(r.status||'—')}</span>
        <span class="tag ${groupTag(r.group)}">${esc(r.group||'—')}</span>
        ${r.area ? `<span class="tag tag-neutral">${esc(r.area)}</span>` : ''}
        ${r.install_type ? `<span class="tag tag-neutral">${esc(r.install_type)}</span>` : ''}
      </div>`;
    el.addEventListener('click', () => {
      openDrawer(r);
      if (r.lat && r.lng) map.setView([r.lat, r.lng], 15, {animate: true});
    });
    listFrag.appendChild(el);
  });
  list.appendChild(listFrag);

  renderMarkers(data);
}

// ====== FILTERS ======
function getFiltered() {
  const q = document.getElementById('search-input').value.toLowerCase().trim();
  const fStatus  = document.getElementById('f-status').value;
  const fGroup   = document.getElementById('f-group').value;
  const fType    = document.getElementById('f-type').value;
  const fInstall = document.getElementById('f-install').value;
  const fSurvey  = document.getElementById('f-survey').value;
  const fArea    = document.getElementById('f-area').value;

  document.querySelectorAll('.flt').forEach(s => s.classList.toggle('active', !!s.value));

  return DATA.filter(r => {
    if (q) {
      if (!r._searchText.includes(q)) return false;
    }
    if (fStatus && r.status !== fStatus) return false;
    if (fGroup === 'X' && r.group !== 'X') return false;
    if (fGroup && fGroup !== 'X' && r.group !== fGroup) return false;
    if (fType && r.type !== fType) return false;
    if (fInstall && r.install_type !== fInstall) return false;
    if (fSurvey && r.survey_type !== fSurvey) return false;
    if (fArea && r.area !== fArea) return false;
    return true;
  });
}

function applyFilters() { render(getFiltered()); }

let markerRestoreFrame = null;
function restoreVisibleMarkers() {
  if (markerRestoreFrame !== null) cancelAnimationFrame(markerRestoreFrame);
  markerRestoreFrame = requestAnimationFrame(() => {
    markerRestoreFrame = null;
    applyFilters();
    map.invalidateSize({ pan: false });
    if (typeof layerGroup.refreshClusters === 'function') layerGroup.refreshClusters();
  });
}
window.restoreVisibleMarkers = restoreVisibleMarkers;

// Leaflet/MarkerCluster can temporarily detach the selected marker while a
// popup is closing. Rebuild the active filtered layer on the next paint.
map.on('popupclose', restoreVisibleMarkers);

function debounce(fn, delay = 160) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

const applyFiltersDebounced = debounce(applyFilters, 160);

document.querySelectorAll('.flt').forEach(s => s.addEventListener('change', applyFilters));
document.getElementById('filter-toggle')?.addEventListener('click', e => {
  const filterbar = document.getElementById('filterbar');
  const collapsed = filterbar.classList.toggle('filters-collapsed');
  e.currentTarget.setAttribute('aria-expanded', String(!collapsed));
  const label = e.currentTarget.querySelector('.filter-toggle-text');
  if (label) label.textContent = collapsed ? 'แสดงตัวกรอง' : 'ตัวกรอง';
  setTimeout(() => map.invalidateSize(), 240);
});
document.getElementById('legend-toggle')?.addEventListener('click', e => {
  const panel = document.getElementById('legend-panel');
  const collapsed = panel.classList.toggle('collapsed');
  e.currentTarget.classList.toggle('active', !collapsed);
});
document.getElementById('fit-bounds-btn')?.addEventListener('click', fitVisibleMarkers);
document.querySelectorAll('.layer-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    const off = btn.classList.toggle('off');
    const state = btn.querySelector('.layer-state');
    if (state) state.textContent = off ? 'ซ่อน' : 'แสดง';
    renderMarkers(lastRenderedData);
  });
});

document.getElementById('btn-reset').addEventListener('click', () => {
  document.getElementById('search-input').value = '';
  document.getElementById('search-clear').style.display = 'none';
  document.querySelectorAll('.flt').forEach(s => { s.value = ''; s.classList.remove('active'); });
  document.querySelectorAll('.layer-toggle').forEach(btn => {
    btn.classList.remove('off');
    const state = btn.querySelector('.layer-state');
    if (state) state.textContent = 'แสดง';
  });
  document.getElementById('autocomplete').style.display = 'none';
  applyFilters();
});

// ====== AUTOCOMPLETE ======
const searchInput = document.getElementById('search-input');
const ac = document.getElementById('autocomplete');
const searchClear = document.getElementById('search-clear');

searchInput.addEventListener('input', () => {
  const q = searchInput.value.toLowerCase().trim();
  searchClear.style.display = q ? 'block' : 'none';
  applyFiltersDebounced();
  if (q.length < 1) { ac.style.display = 'none'; return; }
  const matches = DATA.filter(r =>
    r._nameSearchText.includes(q)
  ).slice(0, 10);
  if (!matches.length) { ac.style.display = 'none'; return; }
  ac.innerHTML = matches.map(r => `
    <div class="ac-item" data-id="${attrEsc(r.id)}">
      <div class="ac-dot" style="background:${statusColor(r.status)}"></div>
      <div class="ac-texts">
        <div class="ac-th">${esc(r.name_th||'—')}</div>
        <div class="ac-en">${esc(r.name_eng||'')} · ${esc(r.area||'')} · ${esc(r.status||'')}</div>
      </div>
    </div>`).join('');
  ac.style.display = 'block';
  ac.querySelectorAll('.ac-item').forEach(el => {
    el.addEventListener('mousedown', (e) => { e.preventDefault(); });
    el.addEventListener('click', () => {
      const r = DATA.find(d => String(d.id) === el.dataset.id);
      if (r) {
        searchInput.value = r.name_th;
        searchClear.style.display = 'block';
        ac.style.display = 'none';
        searchInput.blur();
        applyFilters();
        openDrawer(r);
        if (r.lat && r.lng) map.setView([r.lat, r.lng], 16, {animate:true});
      }
    });
  });
});

searchClear.addEventListener('click', () => {
  searchInput.value = '';
  searchClear.style.display = 'none';
  ac.style.display = 'none';
  applyFilters();
});

document.addEventListener('click', e => {
  if (!e.target.closest('.search-wrap')) ac.style.display = 'none';
});

function toNullableNumber(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const DEFAULT_INSTALLATION_PROFILE = Object.freeze({
  version: 1,
  meters_per_floor: 5,
  cable_rate_per_meter: 158.36,
  equipment_cost: 2200,
  odf_cost: 200,
  splice_cost: 400,
  floor_count_mode: 'inclusive',
  cable_route_basis: 'total_distance'
});

const INSTALLATION_PROFILE_NUMBER_FIELDS = [
  'meters_per_floor',
  'cable_rate_per_meter',
  'equipment_cost',
  'odf_cost',
  'splice_cost'
];

function getBuildingInstallationProfile(record) {
  const currentProfile = record?.installation_profile;
  const legacyProfile = record?.calculation_profile;
  const storedProfile = currentProfile && typeof currentProfile === 'object'
    ? currentProfile
    : (legacyProfile && typeof legacyProfile === 'object' ? legacyProfile : {});
  const resolvedProfile = { ...DEFAULT_INSTALLATION_PROFILE };
  INSTALLATION_PROFILE_NUMBER_FIELDS.forEach(field => {
    const rawValue = storedProfile[field];
    if (rawValue === null || rawValue === undefined || rawValue === '') return;
    const value = Number(rawValue);
    const isValid = Number.isFinite(value)
      && (field === 'meters_per_floor' ? value > 0 : value >= 0);
    if (isValid) resolvedProfile[field] = value;
  });
  return {
    ...resolvedProfile,
    version: Number(storedProfile.version) || DEFAULT_INSTALLATION_PROFILE.version,
    floor_count_mode: 'inclusive',
    cable_route_basis: 'total_distance'
  };
}

function getStoredBuildingInstallationValue(record, field) {
  const storedProfile = record?.installation_profile || record?.calculation_profile;
  const value = storedProfile?.[field];
  return value === null || value === undefined ? '' : value;
}

function buildBuildingInstallationProfile(formData, existingProfile = null) {
  const profile = existingProfile && typeof existingProfile === 'object'
    ? { ...existingProfile }
    : {};
  INSTALLATION_PROFILE_NUMBER_FIELDS.forEach(field => {
    delete profile[field];
    const value = toNullableNumber(formData.get(`calc_${field}`));
    if (value !== null) profile[field] = value;
  });
  return {
    ...profile,
    version: DEFAULT_INSTALLATION_PROFILE.version,
    floor_count_mode: 'inclusive',
    cable_route_basis: 'total_distance',
    updated_at: new Date().toISOString()
  };
}

function normalizeDuplicateValue(value) {
  return String(value || '').trim().toLocaleLowerCase('th-TH').replace(/\s+/g, '');
}

function collectBuildingIds(record, extraIds = []) {
  return new Set([
    record?._docId,
    record?.id,
    ...extraIds
  ].filter(v => v !== null && v !== undefined && v !== '').map(String));
}

function buildingMatchesId(record, id) {
  if (id === null || id === undefined || id === '') return false;
  return collectBuildingIds(record).has(String(id));
}

function findBuildingById(id) {
  return DATA.find(item => buildingMatchesId(item, id)) || null;
}

function setBuildingEditorMessage(message = '') {
  const box = document.getElementById('building-editor-message');
  if (!box) return;
  box.textContent = message;
  box.classList.toggle('show', Boolean(message));
}

function clearBuildingEditorInvalidState(form) {
  setBuildingEditorMessage('');
  form?.querySelectorAll('.is-invalid').forEach(el => el.classList.remove('is-invalid'));
}

function normalizeOtherFees(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map(item => {
      const calculationType = item?.calculation_type === 'revenue_share' ? 'revenue_share' : 'fixed';
      return {
        label: String(item?.label || item?.name || '').trim(),
        calculation_type: calculationType,
        amount: calculationType === 'fixed'
          ? toNullableNumber(item?.amount ?? item?.value ?? item?.fee)
          : null,
        rate: calculationType === 'revenue_share'
          ? toNullableNumber(item?.rate ?? item?.percentage ?? item?.amount)
          : null,
        revenue_period: calculationType === 'revenue_share'
          ? (item?.revenue_period === 'annual' ? 'annual' : 'monthly')
          : null,
        note: String(item?.note || item?.remark || '').trim()
      };
    }).filter(item => item.label || item.amount !== null || item.rate !== null || item.note);
  }
  if (typeof value === 'object') {
    return Object.entries(value).map(([label, amount]) => ({
      label: String(label || '').trim(),
      calculation_type: 'fixed',
      amount: toNullableNumber(amount),
      rate: null,
      revenue_period: null,
      note: ''
    })).filter(item => item.label || item.amount !== null);
  }
  return [];
}

function addOtherFeeRow(fee = {}) {
  const list = document.getElementById('other-fees-list');
  if (!list) return;

  const row = document.createElement('div');
  row.className = 'other-fee-row';
  const calculationType = fee.calculation_type === 'revenue_share' ? 'revenue_share' : 'fixed';
  const value = calculationType === 'revenue_share' ? fee.rate : fee.amount;
  row.innerHTML = `
    <div class="building-field"><label>ชื่อรายการ</label><input name="other_fee_label" type="text" value="${attrEsc(fee.label || '')}" placeholder="เช่น ค่าบัตรผ่าน"></div>
    <div class="building-field"><label>วิธีคิด</label><select name="other_fee_calculation_type"><option value="fixed"${calculationType === 'fixed' ? ' selected' : ''}>จำนวนเงินคงที่</option><option value="revenue_share"${calculationType === 'revenue_share' ? ' selected' : ''}>ส่วนแบ่งรายได้ (%)</option></select></div>
    <div class="building-field"><label class="other-fee-value-label">${calculationType === 'revenue_share' ? 'อัตรา (%)' : 'จำนวนเงิน (บาท)'}</label><input name="other_fee_value" type="number" step="0.01" min="0" ${calculationType === 'revenue_share' ? 'max="100"' : ''} value="${attrEsc(value ?? '')}"></div>
    <div class="building-field other-fee-period"${calculationType === 'revenue_share' ? '' : ' hidden'}><label>คิดจากรายได้</label><select name="other_fee_revenue_period"><option value="monthly"${fee.revenue_period !== 'annual' ? ' selected' : ''}>รายเดือน</option><option value="annual"${fee.revenue_period === 'annual' ? ' selected' : ''}>รายปี</option></select></div>
    <div class="building-field"><label>หมายเหตุ</label><input name="other_fee_note" type="text" value="${attrEsc(fee.note || '')}" placeholder="เช่น รายปี / ต่อครั้ง"></div>
    <button type="button" class="other-fee-remove">ลบ</button>
  `;
  list.appendChild(row);
  applyFieldAriaLabels(row);
}

function updateOtherFeeRowControls(row) {
  if (!row) return;
  const isRevenueShare = row.querySelector('[name="other_fee_calculation_type"]')?.value === 'revenue_share';
  const valueLabel = row.querySelector('.other-fee-value-label');
  const valueInput = row.querySelector('[name="other_fee_value"]');
  const periodField = row.querySelector('.other-fee-period');
  if (valueLabel) valueLabel.textContent = isRevenueShare ? 'อัตรา (%)' : 'จำนวนเงิน (บาท)';
  if (valueInput) {
    if (isRevenueShare) valueInput.setAttribute('max', '100');
    else valueInput.removeAttribute('max');
  }
  if (periodField) periodField.hidden = !isRevenueShare;
}

function renderOtherFeeRows(fees = []) {
  const list = document.getElementById('other-fees-list');
  if (!list) return;
  list.innerHTML = '';
  normalizeOtherFees(fees).forEach(addOtherFeeRow);
}

function collectOtherFees() {
  return [...document.querySelectorAll('#other-fees-list .other-fee-row')]
    .map(row => {
      const calculationType = row.querySelector('[name="other_fee_calculation_type"]')?.value === 'revenue_share'
        ? 'revenue_share'
        : 'fixed';
      const value = toNullableNumber(row.querySelector('[name="other_fee_value"]')?.value);
      return {
        label: String(row.querySelector('[name="other_fee_label"]')?.value || '').trim(),
        calculation_type: calculationType,
        amount: calculationType === 'fixed' ? value : null,
        rate: calculationType === 'revenue_share' ? value : null,
        revenue_period: calculationType === 'revenue_share'
          ? (row.querySelector('[name="other_fee_revenue_period"]')?.value === 'annual' ? 'annual' : 'monthly')
          : null,
        note: String(row.querySelector('[name="other_fee_note"]')?.value || '').trim()
      };
    })
    .filter(item => item.label || item.amount !== null || item.rate !== null || item.note);
}

const BUILDING_BOQ_FEE_FIELDS = [
  { field: 'damage_deposit', label: FEE_LABELS.damageDeposit, payable: false, unit: 'ครั้ง', category: 'deposit', cost_type: 'DEPOSIT' },
  { field: 'contract_deposit', label: FEE_LABELS.contractDeposit, payable: true, unit: 'ครั้ง', category: 'deposit', cost_type: 'DEPOSIT' },
  { field: 'insurance_fee', label: FEE_LABELS.insurance, payable: false, unit: 'ครั้ง', category: 'insurance', cost_type: 'OPEX' },
  { field: 'main_fee', label: FEE_LABELS.mainFee, payable: true, unit: 'ครั้ง', category: 'building_fee', cost_type: 'CAPEX' },
  { field: 'annual_fee', label: FEE_LABELS.annualFee, payable: true, unit: 'ครั้ง', category: 'building_fee', cost_type: 'OPEX' },
  { field: 'coordination_fee', label: FEE_LABELS.coordinationFee, payable: true, unit: 'ครั้ง', category: 'building_fee', cost_type: 'CAPEX' },
  { field: 'shaft_fee_per_floor', label: 'ค่า Shaft ต่อชั้น', payable: true, unit: 'ชั้น', category: 'variable_fee', cost_type: 'CAPEX' },
  { field: 'horizontal_fee', label: 'ค่าวางสายทั้งเส้น /ม.', payable: true, unit: 'เมตร', category: 'variable_fee', cost_type: 'CAPEX' }
];

const BOQ_COST_TYPES = new Set(['CAPEX', 'OPEX', 'DEPOSIT', 'UNCLASSIFIED']);

function resolveBuildingBoqCostType(item) {
  const explicit = String(item?.cost_type || '').trim().toUpperCase();
  if (BOQ_COST_TYPES.has(explicit)) return explicit;
  const key = String(item?.source_field || item?.key || '').trim();
  const category = String(item?.category || '').trim();
  if (category === 'deposit' || ['damage_deposit', 'contract_deposit'].includes(key)) return 'DEPOSIT';
  if (category === 'insurance' || key === 'annual_fee' || key === 'insurance_fee') return 'OPEX';
  if (category === 'other_fee') return 'UNCLASSIFIED';
  if (category === 'building_fee' || category === 'variable_fee') return 'CAPEX';
  return 'UNCLASSIFIED';
}

function applyBuildingBoqCostClassification(profile, classifiedAt = new Date().toISOString()) {
  const fees = (Array.isArray(profile?.fees) ? profile.fees : [])
    .map((item, index) => {
      const normalized = normalizeBuildingBoqFee(item, index);
      return normalized ? { ...item, ...normalized } : null;
    })
    .filter(Boolean);
  const fixedFees = fees.filter(item => !['variable_fee', 'revenue_share'].includes(item.category));
  const totalByType = costType => fixedFees
    .filter(item => item.cost_type === costType)
    .reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  return {
    ...(profile && typeof profile === 'object' ? profile : {}),
    fees,
    payable_total: fixedFees.filter(item => item.payable).reduce((sum, item) => sum + (Number(item.amount) || 0), 0),
    non_payable_total: fixedFees.filter(item => !item.payable).reduce((sum, item) => sum + (Number(item.amount) || 0), 0),
    capex_total: totalByType('CAPEX'),
    opex_total: totalByType('OPEX'),
    deposit_total: totalByType('DEPOSIT'),
    unclassified_total: totalByType('UNCLASSIFIED'),
    variable_rate_count: fees.length - fixedFees.length,
    cost_classification_version: 1,
    cost_classified_at: classifiedAt
  };
}

function buildBuildingBoqProfile(record, existingProfile = null) {
  const managedFeeSources = new Set([
    ...BUILDING_BOQ_FEE_FIELDS.map(item => item.field),
    'other_fees'
  ]);
  const externalFees = (Array.isArray(existingProfile?.fees) ? existingProfile.fees : [])
    .map((item, index) => {
      const normalized = normalizeBuildingBoqFee(item, index);
      return normalized ? { ...item, ...normalized } : null;
    })
    .filter(item => item && !managedFeeSources.has(item.source_field || item.key));
  const fees = BUILDING_BOQ_FEE_FIELDS
    .map(item => ({
      key: item.field,
      source_field: item.field,
      label: item.label,
      amount: toNullableNumber(record?.[item.field]),
      unit: item.unit,
      payable: item.payable,
      category: item.category,
      cost_type: item.cost_type
    }))
    .filter(item => item.amount !== null);

  normalizeOtherFees(record?.other_fees).forEach((item, index) => {
    const isRevenueShare = item.calculation_type === 'revenue_share';
    fees.push({
      key: `other_fee_${index + 1}`,
      source_field: 'other_fees',
      label: item.label || 'ค่าใช้จ่ายเพิ่มเติม',
      calculation_type: isRevenueShare ? 'revenue_share' : 'fixed',
      amount: isRevenueShare ? null : item.amount,
      rate: isRevenueShare ? item.rate : null,
      revenue_period: isRevenueShare ? item.revenue_period : null,
      unit: isRevenueShare ? '%' : (item.note || 'ครั้ง'),
      note: item.note || '',
      payable: true,
      category: isRevenueShare ? 'revenue_share' : 'other_fee',
      cost_type: isRevenueShare ? 'OPEX' : 'UNCLASSIFIED'
    });
  });
  fees.push(...externalFees);

  return applyBuildingBoqCostClassification({
    ...(existingProfile && typeof existingProfile === 'object' ? existingProfile : {}),
    building_id: record?.id ?? record?._docId ?? '',
    building_name_th: record?.name_th || '',
    building_name_eng: record?.name_eng || '',
    status: record?.status || '',
    group: record?.group || '',
    type: record?.type || '',
    install_type: record?.install_type || '',
    area: record?.area || '',
    province: record?.province || '',
    update_date: record?.update_date || null,
    fees,
    synced_at: new Date().toISOString()
  });
}

function hasStoredBuildingBoqProfile(record) {
  return Boolean(record?.boq_profile && Array.isArray(record.boq_profile.fees));
}

function normalizeBuildingBoqFee(item, index = 0) {
  const calculationType = item?.calculation_type === 'revenue_share' || item?.category === 'revenue_share'
    ? 'revenue_share'
    : 'fixed';
  const amount = toNullableNumber(item?.amount);
  const rate = calculationType === 'revenue_share'
    ? toNullableNumber(item?.rate ?? item?.percentage ?? item?.amount)
    : null;
  if (calculationType === 'fixed' && amount === null) return null;
  if (calculationType === 'revenue_share' && rate === null) return null;
  return {
    key: String(item?.key || item?.source_field || `fee_${index + 1}`),
    source_field: String(item?.source_field || item?.key || ''),
    label: String(item?.label || 'ค่าใช้จ่ายอาคาร').trim(),
    calculation_type: calculationType,
    amount: calculationType === 'fixed' ? amount : null,
    rate,
    revenue_period: calculationType === 'revenue_share'
      ? (item?.revenue_period === 'annual' ? 'annual' : 'monthly')
      : null,
    unit: calculationType === 'revenue_share' ? '%' : String(item?.unit || 'ครั้ง').trim(),
    note: String(item?.note || '').trim(),
    payable: item?.payable !== false,
    category: calculationType === 'revenue_share' ? 'revenue_share' : String(item?.category || 'building_fee').trim(),
    cost_type: calculationType === 'revenue_share' ? 'OPEX' : resolveBuildingBoqCostType(item)
  };
}

function getBuildingBoqProfile(record) {
  return hasStoredBuildingBoqProfile(record)
    ? record.boq_profile
    : buildBuildingBoqProfile(record || {});
}

function getBuildingBoqFees(record) {
  return (getBuildingBoqProfile(record).fees || [])
    .map(normalizeBuildingBoqFee)
    .filter(Boolean);
}

function getBuildingBoqFee(record, key) {
  const cleanKey = String(key || '');
  return getBuildingBoqFees(record).find(item =>
    item.key === cleanKey || item.source_field === cleanKey
  ) || null;
}

function getBuildingBoqFeeAmount(record, key) {
  return getBuildingBoqFee(record, key)?.amount ?? null;
}

function getBuildingBoqOtherFees(record) {
  if (!hasStoredBuildingBoqProfile(record)) return normalizeOtherFees(record?.other_fees);
  return getBuildingBoqFees(record)
    .filter(item => ['other_fee', 'revenue_share'].includes(item.category) || item.source_field === 'other_fees')
    .map(item => ({
      label: item.label,
      amount: item.amount,
      calculation_type: item.calculation_type,
      rate: item.rate,
      revenue_period: item.revenue_period,
      note: item.note || (item.calculation_type === 'fixed' && item.unit !== 'ครั้ง' ? item.unit : '')
    }));
}

function formatBuildingBoqFeeQuantity(fee) {
  if (fee?.calculation_type === 'revenue_share') {
    return `${formatCurrencyNumeric(Number(fee.rate) || 0)}% ของรายได้${fee.revenue_period === 'annual' ? 'รายปี' : 'รายเดือน'}`;
  }
  if (!fee?.unit || fee.unit === 'ครั้ง') return '1 ครั้ง';
  return fee.category === 'other_fee' ? fee.unit : `1 ${fee.unit}`;
}

const PERMISSION_FIELD_RULES = Object.freeze({
  main_fee: { label: 'ค่าธรรมเนียม (Main Fee)', cost_type: 'CAPEX' },
  coordination_fee: { label: 'ค่าธรรมเนียมประสานงาน', cost_type: 'CAPEX' },
  engineer_sign_fee: { label: 'ค่าวิศวกรลงนาม', cost_type: 'CAPEX' },
  circuit_activation_fee: { label: 'ค่าเปิดวงจร', cost_type: 'CAPEX', multiplier: 'circuitCount', unit: 'วงจร' },
  ot_fee_per_night: { label: 'ค่าดำเนินการนอกเวลา', cost_type: 'CAPEX', multiplier: 'otNights', unit: 'คืน' },
  insurance_fee: { label: 'ค่าประกัน (Insurance)', cost_type: 'CAPEX' },
  customer_fee: { label: 'ค่าใช้จ่ายต่อลูกค้า', cost_type: 'CAPEX' },
  damage_deposit: { label: 'เงินประกันติดตั้ง (Deposit)', cost_type: 'DEPOSIT', payable: false },
  contract_deposit: { label: 'ค่ามัดจำสัญญา', cost_type: 'DEPOSIT', payable: true },
  monthly_fee: { label: 'ค่าบริการรายเดือน', cost_type: 'OPEX', suffix: '/เดือน' },
  annual_fee: { label: 'ค่าบริการรายปี', cost_type: 'OPEX', suffix: '/ปี' },
  horizontal_fee: { label: 'ค่าวางสายทั้งเส้น', cost_type: 'CAPEX' },
  shaft_fee_per_floor: { label: 'ค่า Shaft ต่อชั้น', cost_type: 'CAPEX' },
  shaft_fee_per_meter: { label: 'ค่า Shaft ต่อเมตร', cost_type: 'CAPEX' },
  shaft_fee_per_time: { label: 'ค่า Shaft ต่อครั้ง', cost_type: 'CAPEX' },
  fee_per_meter: { label: 'ค่าธรรมเนียมต่อเมตร', cost_type: 'CAPEX' },
  annual_fee_per_meter: { label: 'ค่าบริการรายปีต่อเมตร', cost_type: 'OPEX' },
  core_rent_per_month_contract: { label: 'ค่าเช่า Core ตามสัญญา', cost_type: 'OPEX' },
  core_rent_per_month_1yr: { label: 'ค่าเช่า Core สัญญา 1 ปี', cost_type: 'OPEX' },
  core_rent_per_month_2yr: { label: 'ค่าเช่า Core สัญญา 2 ปี', cost_type: 'OPEX' },
  core_rent_per_month_3yr: { label: 'ค่าเช่า Core สัญญา 3 ปี', cost_type: 'OPEX' }
});

const PERMISSION_FORMULA_MODES = Object.freeze({
  horizontal: new Set(['none', 'fixed']),
  shaft: new Set(['none', 'per_floor', 'per_meter', 'per_time']),
  distanceBasis: new Set(['none', 'indoor']),
  coreRent: new Set(['none', 'by_contract'])
});

function resolvePermissionCalculationProfile(building) {
  const buildingType = String(building?.type || '').trim().toUpperCase();
  const typeFormula = PERMISSION_TYPE_FORMULAS[buildingType];
  const buildingProfile = building?.permission_calculation
    && typeof building.permission_calculation === 'object'
    && building.permission_calculation.enabled !== false
    ? building.permission_calculation
    : null;

  if (!typeFormula || typeFormula.enabled === false) {
    return buildingProfile
      ? { ...buildingProfile, _source: 'permission_calculation', _formulaType: null }
      : null;
  }

  const chooseMode = (field, allowedField, fallback = 'none') => {
    const allowedModes = new Set(
      (Array.isArray(typeFormula[allowedField]) ? typeFormula[allowedField] : [fallback])
        .map(value => String(value || fallback))
    );
    const requestedMode = String(buildingProfile?.[field] || typeFormula[field] || fallback);
    return allowedModes.has(requestedMode) ? requestedMode : fallback;
  };
  const chooseConfiguredFields = field => {
    const allowedFields = new Set(
      Array.isArray(typeFormula[field]) ? typeFormula[field].map(value => String(value)) : []
    );
    const buildingFields = Array.isArray(buildingProfile?.[field])
      ? buildingProfile[field].map(value => String(value))
      : [];
    return buildingFields.filter(value => allowedFields.has(value));
  };

  return {
    ...typeFormula,
    enabled: true,
    version: Number(typeFormula.version || PERMISSION_TYPE_FORMULA_VERSION) || 1,
    fixed_capex_fields: chooseConfiguredFields('fixed_capex_fields'),
    refundable_fields: chooseConfiguredFields('refundable_fields'),
    recurring_fields: chooseConfiguredFields('recurring_fields'),
    horizontal_mode: chooseMode('horizontal_mode', 'allowed_horizontal_modes'),
    horizontal_distance_basis: chooseMode(
      'horizontal_distance_basis',
      'allowed_horizontal_distance_bases',
      'none'
    ),
    shaft_mode: chooseMode('shaft_mode', 'allowed_shaft_modes'),
    fee_per_meter_basis: chooseMode('fee_per_meter_basis', 'allowed_fee_per_meter_bases'),
    annual_fee_per_meter_basis: chooseMode(
      'annual_fee_per_meter_basis',
      'allowed_annual_fee_per_meter_bases'
    ),
    core_rent_mode: chooseMode('core_rent_mode', 'allowed_core_rent_modes'),
    default_shaft_times: buildingProfile?.default_shaft_times ?? typeFormula.default_shaft_times,
    default_circuit_count: buildingProfile?.default_circuit_count ?? typeFormula.default_circuit_count,
    default_ot_nights: buildingProfile?.default_ot_nights ?? typeFormula.default_ot_nights,
    default_contract_years: buildingProfile?.default_contract_years ?? typeFormula.default_contract_years,
    _source: 'permission_type_formula',
    _formulaType: buildingType
  };
}

function hasEnabledPermissionCalculation(building) {
  return Boolean(resolvePermissionCalculationProfile(building));
}

function getPermissionInputRequirements(building) {
  const profile = resolvePermissionCalculationProfile(building);
  if (!profile) return null;
  const fixedFields = Array.isArray(profile.fixed_capex_fields) ? profile.fixed_capex_fields : [];
  return {
    profile,
    needsShaftTimes: profile.shaft_mode === 'per_time',
    needsCircuitCount: fixedFields.includes('circuit_activation_fee') || profile.core_rent_mode === 'by_contract',
    needsOtNights: fixedFields.includes('ot_fee_per_night'),
    needsContractYears: profile.core_rent_mode === 'by_contract'
  };
}

function parseStrictPermissionNumber(building, field, dataIssues, warnings) {
  const rawValue = building?.[field];
  const isBlank = rawValue === null || rawValue === undefined || rawValue === '';
  const isNumericString = typeof rawValue === 'string'
    && /^-?(?:\d+\.?\d*|\.\d+)$/.test(rawValue.trim());
  const value = typeof rawValue === 'number'
    ? rawValue
    : (isNumericString ? Number(rawValue) : Number.NaN);
  if (isBlank || !Number.isFinite(value) || value < 0) {
    const boqFallback = getBuildingBoqFeeAmount(building, field);
    if (typeof boqFallback === 'number' && Number.isFinite(boqFallback) && boqFallback >= 0) {
      warnings.push(`ฟิลด์ ${PERMISSION_FIELD_RULES[field]?.label || field} ใช้ค่าตัวเลขสำรองจาก BOQ`);
      return boqFallback;
    }
    if (!isBlank) {
      warnings.push(
        `ฟิลด์ ${PERMISSION_FIELD_RULES[field]?.label || field} ไม่ใช่ค่าธรรมเนียมตัวเลข `
        + 'จึงถือว่าอาคารนี้ไม่มีค่าธรรมเนียมรายการดังกล่าว'
      );
    }
    return 0;
  }
  return value;
}

function validatePermissionMode(value, allowedModes, field, errors) {
  const cleanValue = String(value || 'none');
  if (allowedModes.has(cleanValue)) return cleanValue;
  errors.push({ field, label: field, reason: `ไม่รองรับโหมด "${cleanValue}"` });
  return 'none';
}

function resolveCoreRentField(contractYears) {
  if (contractYears <= 1) return 'core_rent_per_month_1yr';
  if (contractYears === 2) return 'core_rent_per_month_2yr';
  return 'core_rent_per_month_3yr';
}

function calculatePermissionCost(building, inputs) {
  const profile = resolvePermissionCalculationProfile(building);
  if (!profile) return null;
  const errors = [];
  const dataIssues = [];
  const warnings = [];
  const payableItems = [];
  const excludedItems = [];
  const processedFields = new Set();

  const addItem = ({ field, label, value, qty, cost_type = 'CAPEX', payable = true, period = null }) => {
    if (!(value > 0)) return;
    const resolvedCostType = period === 'monthly'
      ? 'OPEX_MONTHLY'
      : (period === 'annual' ? 'OPEX_ANNUAL' : cost_type);
    const item = { field, label, value, qty, cost_type: resolvedCostType, payable, period };
    (payable ? payableItems : excludedItems).push(item);
  };

  const addConfiguredField = (field, forcedCostType = null) => {
    if (processedFields.has(field)) return;
    const rule = PERMISSION_FIELD_RULES[field];
    if (!rule) {
      errors.push({ field, label: field, reason: 'ยังไม่มีกฎคำนวณกลางสำหรับฟิลด์นี้' });
      return;
    }
    processedFields.add(field);
    const rate = parseStrictPermissionNumber(building, field, dataIssues, warnings);
    if (rate === null) return;
    const multiplier = rule.multiplier ? Number(inputs[rule.multiplier]) : 1;
    const value = rate * multiplier;
    const qty = rule.multiplier
      ? `${formatCurrencyNumeric(rate)} บาท × ${formatCurrencyNumeric(multiplier)} ${rule.unit}`
      : `1 ครั้ง${rule.suffix || ''}`;
    addItem({
      field,
      label: `${rule.label}${rule.suffix || ''}`,
      value,
      qty,
      cost_type: forcedCostType || rule.cost_type,
      payable: rule.payable !== false,
      period: rule.suffix === '/เดือน' ? 'monthly' : (rule.suffix === '/ปี' ? 'annual' : null)
    });
  };

  const fixedFields = Array.isArray(profile.fixed_capex_fields) ? profile.fixed_capex_fields : [];
  const refundableFields = Array.isArray(profile.refundable_fields) ? profile.refundable_fields : [];
  const recurringFields = Array.isArray(profile.recurring_fields) ? profile.recurring_fields : [];
  fixedFields.forEach(field => addConfiguredField(field, 'CAPEX'));
  refundableFields.forEach(field => addConfiguredField(field, 'DEPOSIT'));
  recurringFields.forEach(field => addConfiguredField(field, 'OPEX'));

  const horizontalMode = validatePermissionMode(
    profile.horizontal_mode,
    PERMISSION_FORMULA_MODES.horizontal,
    'permission_calculation.horizontal_mode',
    errors
  );
  const horizontalDistanceBasis = validatePermissionMode(
    profile.horizontal_distance_basis,
    PERMISSION_FORMULA_MODES.distanceBasis,
    'permission_calculation.horizontal_distance_basis',
    errors
  );
  if (horizontalMode === 'fixed') {
    if (horizontalDistanceBasis !== 'indoor') {
      errors.push({
        field: 'permission_calculation.horizontal_distance_basis',
        label: 'ฐานระยะ Horizontal',
        reason: 'สูตรกลางรองรับโหมด fixed เมื่อฐานระยะเป็น indoor เท่านั้น'
      });
    }
    const rate = parseStrictPermissionNumber(building, 'horizontal_fee', dataIssues, warnings);
    if (rate !== null) {
      addItem({
        field: 'horizontal_fee',
        label: `ค่าวางสายทั้งเส้น (${formatCurrencyNumeric(rate)} บ./ม. × ระยะรวม ${formatCurrencyNumeric(inputs.totalCableDistance)} ม.)`,
        value: rate * inputs.totalCableDistance,
        qty: `${formatCurrencyNumeric(inputs.totalCableDistance)} ม.`,
        cost_type: 'CAPEX'
      });
    }
  }

  const shaftMode = validatePermissionMode(
    profile.shaft_mode,
    PERMISSION_FORMULA_MODES.shaft,
    'permission_calculation.shaft_mode',
    errors
  );
  const shaftRules = {
    per_floor: { field: 'shaft_fee_per_floor', multiplier: inputs.floorCount, unit: 'ชั้น' },
    per_meter: { field: 'shaft_fee_per_meter', multiplier: inputs.verticalDistance, unit: 'ม.' },
    per_time: { field: 'shaft_fee_per_time', multiplier: inputs.shaftTimes, unit: 'ครั้ง' }
  };
  if (shaftRules[shaftMode]) {
    const shaftRule = shaftRules[shaftMode];
    const rate = parseStrictPermissionNumber(building, shaftRule.field, dataIssues, warnings);
    if (rate !== null) {
      addItem({
        field: shaftRule.field,
        label: `ค่า Shaft (${formatCurrencyNumeric(rate)} บาท/${shaftRule.unit} × ${formatCurrencyNumeric(shaftRule.multiplier)} ${shaftRule.unit})`,
        value: rate * shaftRule.multiplier,
        qty: `${formatCurrencyNumeric(shaftRule.multiplier)} ${shaftRule.unit}`,
        cost_type: 'CAPEX'
      });
    }
  }

  const feePerMeterBasis = validatePermissionMode(
    profile.fee_per_meter_basis,
    PERMISSION_FORMULA_MODES.distanceBasis,
    'permission_calculation.fee_per_meter_basis',
    errors
  );
  if (feePerMeterBasis === 'indoor') {
    const rate = parseStrictPermissionNumber(building, 'fee_per_meter', dataIssues, warnings);
    if (rate !== null) {
      addItem({
        field: 'fee_per_meter',
        label: `ค่าธรรมเนียมตามระยะภายในอาคาร (${formatCurrencyNumeric(rate)} บ./ม.)`,
        value: rate * inputs.totalCableDistance,
        qty: `${formatCurrencyNumeric(inputs.totalCableDistance)} ม.`,
        cost_type: 'CAPEX'
      });
    }
  }

  const annualFeePerMeterBasis = validatePermissionMode(
    profile.annual_fee_per_meter_basis,
    PERMISSION_FORMULA_MODES.distanceBasis,
    'permission_calculation.annual_fee_per_meter_basis',
    errors
  );
  if (annualFeePerMeterBasis === 'indoor') {
    const rate = parseStrictPermissionNumber(building, 'annual_fee_per_meter', dataIssues, warnings);
    if (rate !== null) {
      addItem({
        field: 'annual_fee_per_meter',
        label: `ค่าบริการรายปีตามระยะ (${formatCurrencyNumeric(rate)} บ./ม./ปี)`,
        value: rate * inputs.totalCableDistance,
        qty: `${formatCurrencyNumeric(inputs.totalCableDistance)} ม.`,
        cost_type: 'OPEX',
        period: 'annual'
      });
    }
  }

  const coreRentMode = validatePermissionMode(
    profile.core_rent_mode,
    PERMISSION_FORMULA_MODES.coreRent,
    'permission_calculation.core_rent_mode',
    errors
  );
  if (coreRentMode === 'by_contract') {
    const preferredField = resolveCoreRentField(inputs.contractYears);
    const preferredRawValue = building?.[preferredField];
    const preferredValueMissing = preferredRawValue === null
      || preferredRawValue === undefined
      || preferredRawValue === '';
    let rateField = preferredField;
    let rate;
    if (preferredValueMissing && building?.core_rent_per_month_contract !== null && building?.core_rent_per_month_contract !== undefined) {
      rateField = 'core_rent_per_month_contract';
      rate = parseStrictPermissionNumber(building, rateField, dataIssues, warnings);
      warnings.push(`ไม่พบอัตรา Core สำหรับสัญญา ${inputs.contractYears} ปี จึงใช้อัตราตามสัญญาแทน`);
    } else {
      rate = parseStrictPermissionNumber(building, preferredField, dataIssues, warnings);
    }
    if (rate > 0) {
      addItem({
        field: rateField,
        label: `ค่าเช่า Core รายเดือน (สัญญา ${inputs.contractYears} ปี)`,
        value: rate * inputs.circuitCount,
        qty: `${formatCurrencyNumeric(rate)} บาท × ${formatCurrencyNumeric(inputs.circuitCount)} Core`,
        cost_type: 'OPEX',
        period: 'monthly'
      });
    }
  }

  return {
    source: profile._source,
    formulaType: profile._formulaType,
    version: Number(profile.version || building.permission_formula_version) || 1,
    profile,
    payableItems,
    excludedItems,
    errors,
    dataIssues,
    warnings
  };
}

async function syncBuildingBoqProfiles({ skipConfirm = false, silent = false, refreshCostTypes = false } = {}) {
  if (!canManageUsers()) {
    alert('บัญชีนี้ไม่มีสิทธิ์สร้าง BOQ database');
    return;
  }
  if (!DATA.length) {
    alert('ยังไม่มีข้อมูลอาคารสำหรับสร้าง BOQ database');
    return;
  }
  if (!window.FSDB?.setMergeInBatch) {
    alert('Firestore ยังไม่พร้อมสำหรับ BOQ database');
    return;
  }

  const recordsWithoutBoq = DATA.filter(record => !hasStoredBuildingBoqProfile(record));
  const targetRecords = refreshCostTypes ? DATA : recordsWithoutBoq;
  if (!targetRecords.length) {
    if (!silent) alert(`ข้อมูล BOQ ครบแล้ว ${DATA.length} อาคาร`);
    return;
  }

  if (!skipConfirm) {
    const actionText = refreshCostTypes ? 'จัดหมวด CAPEX/OPEX' : 'สร้างข้อมูล BOQ สำหรับอาคารที่ยังไม่มี';
    const confirmed = confirm(`ต้องการ${actionText} ${targetRecords.length} รายการใช่หรือไม่?`);
    if (!confirmed) return;
  }

  const btn = document.getElementById('sync-boq-db-btn');
  const originalHtml = btn?.innerHTML || '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = 'กำลัง sync...';
  }

  try {
    const profiles = targetRecords
      .map(record => {
        const boqProfile = hasStoredBuildingBoqProfile(record)
          ? applyBuildingBoqCostClassification(record.boq_profile)
          : buildBuildingBoqProfile(record);
        return {
          docId: String(record?._docId || record?.id || '').trim(),
          boqProfile,
          updatedAt: boqProfile.cost_classified_at || boqProfile.synced_at
        };
      })
      .filter(item => item.docId);
    const chunkSize = 400;
    for (let i = 0; i < profiles.length; i += chunkSize) {
      const batch = window.FSDB.newBatch();
      profiles.slice(i, i + chunkSize).forEach(item => {
        window.FSDB.setMergeInBatch(batch, item.docId, {
          boq_profile: item.boqProfile,
          boq_updated_at: item.updatedAt
        });
      });
      await window.FSDB.commitBatch(batch);
    }
    if (!silent) {
      const resultText = refreshCostTypes ? 'จัดหมวด CAPEX/OPEX สำเร็จ' : 'สร้างข้อมูล BOQ สำหรับอาคารที่ยังไม่มีสำเร็จ';
      alert(`${resultText} ${profiles.length} รายการ`);
    }
  } catch (err) {
    console.error('Sync BOQ database failed:', err);
    if (silent) setSyncStatus('สร้าง BOQ database ไม่สำเร็จ: ' + err.message, true);
    else alert('สร้าง BOQ database ไม่สำเร็จ: ' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalHtml || 'BOQ DB';
    }
  }
}

function findDuplicateBuilding(payload, existingRecord, existingId) {
  const nameTh = normalizeDuplicateValue(payload.name_th);
  const nameEng = normalizeDuplicateValue(payload.name_eng);
  const currentIds = collectBuildingIds(existingRecord, [existingId, payload.id]);
  const hasCoords = Number.isFinite(payload.lat) && Number.isFinite(payload.lng);
  const lat = hasCoords ? payload.lat.toFixed(6) : '';
  const lng = hasCoords ? payload.lng.toFixed(6) : '';

  return DATA.find(item => {
    if ([...collectBuildingIds(item)].some(id => currentIds.has(id))) return false;

    const sameThaiName = nameTh && normalizeDuplicateValue(item.name_th) === nameTh;
    const sameEnglishName = nameEng && normalizeDuplicateValue(item.name_eng) === nameEng;
    const itemLat = Number(item.lat);
    const itemLng = Number(item.lng);
    const sameCoords = hasCoords && Number.isFinite(itemLat) && Number.isFinite(itemLng)
      && itemLat.toFixed(6) === lat
      && itemLng.toFixed(6) === lng;

    return sameThaiName || sameEnglishName || sameCoords;
  }) || null;
}

function duplicateSensitiveFieldsChanged(payload, existingRecord) {
  if (!existingRecord) return true;
  const sameNameTh = normalizeDuplicateValue(payload.name_th) === normalizeDuplicateValue(existingRecord.name_th);
  const sameNameEng = normalizeDuplicateValue(payload.name_eng) === normalizeDuplicateValue(existingRecord.name_eng);
  const payloadLat = Number(payload.lat);
  const payloadLng = Number(payload.lng);
  const existingLat = Number(existingRecord.lat);
  const existingLng = Number(existingRecord.lng);
  const sameLat = Number.isFinite(payloadLat) && Number.isFinite(existingLat)
    ? payloadLat.toFixed(6) === existingLat.toFixed(6)
    : payload.lat === existingRecord.lat;
  const sameLng = Number.isFinite(payloadLng) && Number.isFinite(existingLng)
    ? payloadLng.toFixed(6) === existingLng.toFixed(6)
    : payload.lng === existingRecord.lng;
  return !(sameNameTh && sameNameEng && sameLat && sameLng);
}

function openBuildingEditor(record = null) {
  if (!canManageBuildings()) {
    alert('บัญชีนี้ไม่มีสิทธิ์จัดการข้อมูลอาคาร');
    return;
  }
  const modal = document.getElementById('building-editor-modal');
  const form = document.getElementById('building-editor-form');
  const deleteBtn = document.getElementById('building-editor-delete-btn');
  if (!modal || !form) return;

  form.reset();
  clearBuildingEditorInvalidState(form);
  form.elements['record_id'].value = record?._docId || record?.id || '';
  form.elements['name_th'].value = record?.name_th ?? '';
  form.elements['name_eng'].value = record?.name_eng ?? '';
  form.elements['status'].value = record?.status ?? 'Check Permission';
  form.elements['group'].value = record?.group ?? 'X';
  form.elements['type'].value = record?.type ?? 'L2';
  form.elements['install_type'].value = record?.install_type ?? 'Building';
  form.elements['survey_type'].value = record?.survey_type ?? 'Need Survey';
  form.elements['duration'].value = record?.duration ?? '';
  form.elements['area'].value = record?.area ?? '';
  form.elements['province'].value = record?.province ?? '';
  form.elements['location'].value = record?.location ?? '';
  form.elements['lat'].value = record?.lat ?? '';
  form.elements['lng'].value = record?.lng ?? '';
  form.elements['address'].value = record?.address ?? '';
  form.elements['contact'].value = record?.contact ?? '';
  form.elements['phone'].value = record?.phone ?? '';
  form.elements['mobile'].value = record?.mobile ?? '';
  form.elements['email'].value = record?.email ?? '';
  form.elements['remark'].value = record?.remark ?? '';
  form.elements['wm_point'].value = record?.wm_point ?? 'No';
  form.elements['enclosure'].value = record?.enclosure ?? 'No';
  form.elements['max_horizontal'].value = record?.max_horizontal ?? '';
  form.elements['damage_deposit'].value = getBuildingBoqFeeAmount(record, 'damage_deposit') ?? '';
  form.elements['contract_deposit'].value = getBuildingBoqFeeAmount(record, 'contract_deposit') ?? '';
  form.elements['insurance_fee'].value = getBuildingBoqFeeAmount(record, 'insurance_fee') ?? '';
  form.elements['main_fee'].value = getBuildingBoqFeeAmount(record, 'main_fee') ?? '';
  form.elements['annual_fee'].value = getBuildingBoqFeeAmount(record, 'annual_fee') ?? '';
  form.elements['coordination_fee'].value = getBuildingBoqFeeAmount(record, 'coordination_fee') ?? '';
  form.elements['shaft_fee_per_floor'].value = getBuildingBoqFeeAmount(record, 'shaft_fee_per_floor') ?? '';
  form.elements['horizontal_fee'].value = getBuildingBoqFeeAmount(record, 'horizontal_fee') ?? '';
  INSTALLATION_PROFILE_NUMBER_FIELDS.forEach(field => {
    form.elements[`calc_${field}`].value = getStoredBuildingInstallationValue(record, field);
  });
  renderOtherFeeRows(getBuildingBoqOtherFees(record));

  document.getElementById('building-editor-title').textContent = record ? 'แก้ไขข้อมูลอาคาร' : 'เพิ่มอาคารใหม่';
  if (deleteBtn) deleteBtn.hidden = !record;
  modal.classList.add('open');
  openDialogAccessibility(modal, form.elements['name_th']);
  rememberFormState(form);
}

function closeBuildingEditor(options = {}) {
  const modal = document.getElementById('building-editor-modal');
  const form = document.getElementById('building-editor-form');
  if (!modal) return true;
  if (!options.force && !confirmDiscardFormChanges(form)) return false;
  modal.classList.remove('open');
  closeDialogAccessibility(modal);
  return true;
}

function closeDetailDrawerAfterDelete() {
  const drawer = document.getElementById('detail-drawer');
  drawer?.classList.remove('open');
  closeDialogAccessibility(drawer);
  document.getElementById('drawer-overlay')?.classList.remove('open');
  selectedId = null;
}

async function deleteBuildingFromForm(form) {
  if (!canManageBuildings()) {
    alert('บัญชีนี้ไม่มีสิทธิ์ลบข้อมูลอาคาร');
    return;
  }
  const id = form?.elements['record_id']?.value;
  if (!id) return;

  const record = findBuildingById(id);
  const buildingName = record?.name_th || record?.name_eng || `ID ${id}`;
  const confirmed = confirm(`ต้องการลบข้อมูลอาคาร "${buildingName}" ใช่หรือไม่?`);
  if (!confirmed) return;

  try {
    await window.FSDB.deleteDoc(id);
    // ไม่ต้องแก้ DATA หรือเรียก applyFilters() เอง เพราะ onSnapshot listener
    // จะรับรู้การเปลี่ยนแปลงจาก Firestore และอัปเดตหน้าจอให้อัตโนมัติ (ทุก client)
    closeBuildingEditor({ force: true });
    closeDetailDrawerAfterDelete();
  } catch (err) {
    console.error('ลบข้อมูลไม่สำเร็จ:', err);
    alert('ลบข้อมูลไม่สำเร็จ: ' + err.message);
  }
}

async function saveBuildingFromForm(form) {
  if (!canManageBuildings()) {
    setBuildingEditorMessage('บัญชีนี้ไม่มีสิทธิ์บันทึกข้อมูลอาคาร');
    return;
  }
  const formData = new FormData(form);
  const existingId = formData.get('record_id');
  const existingRecord = existingId ? findBuildingById(existingId) : null;
  clearBuildingEditorInvalidState(form);

  const invalidCalculationInput = INSTALLATION_PROFILE_NUMBER_FIELDS
    .map(field => form.elements[`calc_${field}`])
    .find(input => {
      if (!input || String(input.value).trim() === '') return false;
      const value = Number(input.value);
      return !Number.isFinite(value)
        || (input.name === 'calc_meters_per_floor' ? value <= 0 : value < 0);
    });
  if (invalidCalculationInput) {
    invalidCalculationInput.classList.add('is-invalid');
    setBuildingEditorMessage('ค่ากำหนดสูตรต้องเป็นตัวเลขไม่ติดลบ และเมตรต่อชั้นต้องมากกว่า 0');
    invalidCalculationInput.focus();
    return;
  }

  const invalidRevenueShareRow = [...form.querySelectorAll('.other-fee-row')].find(row => {
    if (row.querySelector('[name="other_fee_calculation_type"]')?.value !== 'revenue_share') return false;
    const rate = toNullableNumber(row.querySelector('[name="other_fee_value"]')?.value);
    return rate === null || rate < 0 || rate > 100;
  });
  if (invalidRevenueShareRow) {
    const rateInput = invalidRevenueShareRow.querySelector('[name="other_fee_value"]');
    rateInput?.classList.add('is-invalid');
    setBuildingEditorMessage('อัตราส่วนแบ่งรายได้ต้องอยู่ระหว่าง 0 ถึง 100%');
    rateInput?.focus();
    return;
  }

  // รายการใหม่: ใช้ Firestore auto-generated ID เพื่อกันชนกันเวลามีหลายคนเพิ่มข้อมูลพร้อมกัน
  const recordId = existingId || window.FSDB.newId();

  const payload = normalizeBuildingRecord({
    id: existingRecord?.id ?? recordId,
    update_date: new Date().toISOString().slice(0, 10),
    name_th: String(formData.get('name_th') || '').trim(),
    name_eng: String(formData.get('name_eng') || '').trim(),
    area: String(formData.get('area') || '').trim(),
    type: String(formData.get('type') || '').trim(),
    install_type: String(formData.get('install_type') || '').trim(),
    location: String(formData.get('location') || '').trim(),
    province: String(formData.get('province') || '').trim(),
    lat: toNullableNumber(formData.get('lat')),
    lng: toNullableNumber(formData.get('lng')),
    address: String(formData.get('address') || '').trim() || null,
    contact: String(formData.get('contact') || '').trim() || null,
    phone: String(formData.get('phone') || '').trim() || null,
    mobile: String(formData.get('mobile') || '').trim() || null,
    email: String(formData.get('email') || '').trim() || null,
    status: String(formData.get('status') || '').trim(),
    duration: String(formData.get('duration') || '').trim() || null,
    group: String(formData.get('group') || '').trim(),
    survey_type: String(formData.get('survey_type') || '').trim(),
    max_horizontal: toNullableNumber(formData.get('max_horizontal')),
    wm_point: String(formData.get('wm_point') || '').trim(),
    enclosure: String(formData.get('enclosure') || '').trim(),
    damage_deposit: toNullableNumber(formData.get('damage_deposit')),
    contract_deposit: toNullableNumber(formData.get('contract_deposit')),
    insurance_fee: toNullableNumber(formData.get('insurance_fee')),
    main_fee: toNullableNumber(formData.get('main_fee')),
    annual_fee: toNullableNumber(formData.get('annual_fee')),
    coordination_fee: toNullableNumber(formData.get('coordination_fee')),
    shaft_fee_per_floor: toNullableNumber(formData.get('shaft_fee_per_floor')),
    horizontal_fee: toNullableNumber(formData.get('horizontal_fee')),
    other_fees: collectOtherFees(),
    remark: String(formData.get('remark') || '').trim() || null
  });
  payload.installation_profile = buildBuildingInstallationProfile(
    formData,
    existingRecord?.installation_profile || existingRecord?.calculation_profile
  );
  delete payload.calculation_profile;

  if (!payload.name_th) {
    form.elements['name_th']?.classList.add('is-invalid');
    setBuildingEditorMessage('กรุณากรอกชื่ออาคาร (ภาษาไทย)');
    form.elements['name_th']?.focus();
    return;
  }

  const duplicate = duplicateSensitiveFieldsChanged(payload, existingRecord)
    ? findDuplicateBuilding(payload, existingRecord, existingId)
    : null;
  if (duplicate) {
    const duplicateName = duplicate.name_th || duplicate.name_eng || `ID ${duplicate.id}`;
    const duplicateMessage = `พบข้อมูลอาคารซ้ำในระบบ: ${duplicateName} กรุณาตรวจสอบชื่ออาคารหรือพิกัดก่อนบันทึก`;
    form.elements['name_th']?.classList.add('is-invalid');
    if (payload.name_eng) form.elements['name_eng']?.classList.add('is-invalid');
    if (Number.isFinite(payload.lat) && Number.isFinite(payload.lng)) {
      form.elements['lat']?.classList.add('is-invalid');
      form.elements['lng']?.classList.add('is-invalid');
    }
    setBuildingEditorMessage(duplicateMessage);
    form.elements['name_th']?.focus();
    return;
  }

  try {
    const boqProfile = buildBuildingBoqProfile(payload, existingRecord?.boq_profile);
    await window.FSDB.setDoc(recordId, stripInternalFields({
      ...payload,
      boq_profile: boqProfile,
      boq_updated_at: boqProfile.synced_at
    }));
    // ข้อมูลใน DATA จะถูกอัปเดตอัตโนมัติผ่าน onSnapshot listener
    closeBuildingEditor({ force: true });
    openDrawerById(recordId);
  } catch (err) {
    console.error('บันทึกข้อมูลไม่สำเร็จ:', err);
    setBuildingEditorMessage('บันทึกข้อมูลไม่สำเร็จ: ' + err.message);
  }
}


// ====== INIT ======
// เรนเดอร์ครั้งแรกด้วย DATA ว่าง ระหว่างรอ Firestore ซิงค์ข้อมูลเข้ามา (ดู initFirestoreData() ด้านบน)
render(DATA);

// ====== QUOTATION FEATURE ======
const QE = () => window.QuotationEngine;
const lazyScripts = {};
let quotationAutoCalcTimer = null;

function loadScriptOnce(src, globalName, timeoutMs = 15000) {
  if (window[globalName]) return Promise.resolve();
  if (!lazyScripts[src]) {
    lazyScripts[src] = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      let timeoutId;
      const finish = error => {
        clearTimeout(timeoutId);
        script.onload = null;
        script.onerror = null;
        if (error) {
          script.remove();
          delete lazyScripts[src];
          reject(error);
        } else if (!window[globalName]) {
          script.remove();
          delete lazyScripts[src];
          reject(new Error(`Library loaded without exposing window.${globalName}`));
        } else {
          resolve();
        }
      };
      script.src = src;
      script.async = true;
      script.crossOrigin = 'anonymous';
      script.onload = () => finish();
      script.onerror = () => finish(new Error(`Unable to load ${src}`));
      timeoutId = setTimeout(() => finish(new Error(`Timed out loading ${src}`)), timeoutMs);
      document.head.appendChild(script);
    });
  }
  return lazyScripts[src];
}

async function loadLibraryFromSources(sources, globalName) {
  if (window[globalName]) return;
  let lastError;
  for (const src of sources) {
    try {
      await loadScriptOnce(src, globalName);
      return;
    } catch (error) {
      lastError = error;
      console.warn(`โหลด ${globalName} จาก ${src} ไม่สำเร็จ`, error);
    }
  }
  throw lastError || new Error(`Unable to load ${globalName}`);
}

function loadImageLibrary() {
  return loadLibraryFromSources([
    'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
    'https://unpkg.com/html2canvas@1.4.1/dist/html2canvas.min.js'
  ], 'html2canvas');
}

function loadJsPdfLibrary() {
  return loadLibraryFromSources([
    'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
    'https://unpkg.com/jspdf@2.5.1/dist/jspdf.umd.min.js'
  ], 'jspdf');
}

function loadPdfLibrary() {
  return Promise.all([loadImageLibrary(), loadJsPdfLibrary()]);
}

// Quotation modal functions
function setQuotationExportEnabled(enabled) {
  [
    'quotation-pdf-btn',
    'quotation-image-btn',
    'quotation-print-btn',
    'quotation-copy-btn',
    'quotation-copy-preview-btn'
  ].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = !enabled;
  });
}

function invalidateQuotationResult() {
  window._quotationCalculated = false;
  window.currentQuotationSnapshot = null;
  const banner = document.getElementById('quotation-stale-banner');
  if (banner) banner.hidden = true;
  setQuotationExportEnabled(false);
}

function markQuotationCalculated() {
  window._quotationCalculated = true;
  const banner = document.getElementById('quotation-stale-banner');
  if (banner) banner.hidden = true;
  setQuotationExportEnabled(true);
}

function onQuotationInputChanged() {
  if (window._quotationCalculated) {
    const banner = document.getElementById('quotation-stale-banner');
    if (banner) banner.hidden = false;
  }
  window._quotationCalculated = false;
  window.currentQuotationSnapshot = null;
  setQuotationExportEnabled(false);
  updateHorizontalWireWarning();
  scheduleQuotationAutoCalculate();
}

function updateHorizontalWireWarning() {
  const building = window.currentBuildingData || {};
  const warningEl = document.getElementById('quotation-hwire-warning');
  const hwireEl = document.getElementById('quotation-hwire');
  if (!warningEl || !hwireEl) return;
  const result = QE().checkHorizontalDistance(hwireEl.value, building.max_horizontal);
  if (result.level === 'warning') {
    warningEl.textContent = result.message;
    warningEl.hidden = false;
  } else {
    warningEl.textContent = '';
    warningEl.hidden = true;
  }
}

function getQuotationWmFloor(building) {
  const wmFloors = QE().parseWmFloors(building?.wm_point);
  if (wmFloors.length > 0) {
    const select = document.getElementById('quotation-wm-select');
    const numeric = Number(select?.value);
    const label = select?.selectedOptions?.[0]?.dataset.floorLabel
      || QE().formatFloorLabel(numeric);
    if (!Number.isFinite(numeric)) {
      return { numeric: null, label: null, error: 'กรุณาเลือกชั้น WM' };
    }
    return { numeric, label, error: null };
  }
  const parsed = QE().parseFloorInput(document.getElementById('quotation-wm-manual')?.value);
  if (!parsed) {
    return { numeric: null, label: null, error: 'กรุณากรอกหรือเลือกชั้น WM' };
  }
  return { numeric: parsed.numeric, label: parsed.label, error: null };
}

function canAutoCalculateQuotation() {
  const customerName = document.getElementById('quotation-customer')?.value.trim();
  const custFloor = QE().parseFloorInput(document.getElementById('quotation-cust-floor')?.value);
  const building = window.currentBuildingData || {};
  const wmFloor = getQuotationWmFloor(building);
  const hwire = Number(document.getElementById('quotation-hwire')?.value);
  return Boolean(
    customerName
    && custFloor
    && wmFloor.numeric !== null
    && !wmFloor.error
    && Number.isFinite(hwire)
    && hwire >= 0
  );
}

function scheduleQuotationAutoCalculate() {
  clearTimeout(quotationAutoCalcTimer);
  quotationAutoCalcTimer = setTimeout(() => {
    if (canAutoCalculateQuotation()) {
      calculateQuotation({ auto: true, silent: true });
    }
  }, 700);
}

function switchQuotationMobileTab(tab) {
  const container = document.getElementById('quotation-container');
  if (!container) return;
  container.classList.remove('quotation-tab-form', 'quotation-tab-preview');
  container.classList.add(tab === 'preview' ? 'quotation-tab-preview' : 'quotation-tab-form');
  document.querySelectorAll('.quotation-mobile-tab').forEach(btn => {
    const active = btn.dataset.quotationTab === tab;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
}

function openQuotationModal() {
  invalidateQuotationResult();
  _updateQuotationDynamicInputs();
  const modal = document.getElementById('quotation-modal');
  modal.classList.add('open');
  switchQuotationMobileTab('form');
  openDialogAccessibility(modal, document.getElementById('quotation-customer'));
  initializeQuotationMeta(window.currentBuildingData || {});
  _updateQuotationDynamicInputs();
  rememberQuotationState();
}

function _updateQuotationDynamicInputs() {
  const building = window.currentBuildingData || {};
  const buildingName = building.name_th || building.name_eng || '';
  const calculationProfile = getBuildingInstallationProfile(building);
  const permissionRequirements = getPermissionInputRequirements(building);

  // Building info banner
  const infoBox = document.getElementById('quotation-building-info');
  const infoName = document.getElementById('quotation-building-name');
  if (buildingName) {
    infoName.textContent = buildingName;
    infoBox.style.display = 'block';
  } else {
    infoBox.style.display = 'none';
  }
  const calculationProfileEl = document.getElementById('quotation-calculation-profile');
  if (calculationProfileEl) {
    calculationProfileEl.textContent =
      `ต้นทุนติดตั้ง: ${formatCurrencyNumeric(calculationProfile.meters_per_floor)} ม./ชั้น • ` +
      `ค่าสาย ${formatCurrencyNumeric(calculationProfile.cable_rate_per_meter)} บ./ม. • ` +
      `อุปกรณ์ ${formatCurrencyNumeric(calculationProfile.equipment_cost)} บ. • ` +
      `ODF ${formatCurrencyNumeric(calculationProfile.odf_cost)} บ. • ` +
      `Splice ${formatCurrencyNumeric(calculationProfile.splice_cost)} บ. • ` +
      (permissionRequirements
        ? `Permission formula v${Number(permissionRequirements.profile.version) || 1}`
        : 'Permission: BOQ fallback');
  }

  // Parse wm_point field
  const wmRaw = String(building.wm_point || '').trim();
  const wmFloors = QE().parseWmFloors(wmRaw);
  const hasSelectableWmFloor = wmFloors.length > 0;

  const wmSelectGroup = document.getElementById('quotation-wm-group');
  const wmManualGroup = document.getElementById('quotation-wm-manual-group');
  const wmSelect = document.getElementById('quotation-wm-select');

  if (hasSelectableWmFloor) {
    wmSelect.innerHTML = wmFloors.map(f =>
      `<option value="${f.numeric}" data-floor-label="${attrEsc(f.label)}">ชั้น ${esc(f.label)}</option>`
    ).join('');
    wmSelectGroup.style.display = 'block';
    wmManualGroup.style.display = 'none';
  } else {
    wmSelect.innerHTML = '';
    wmSelectGroup.style.display = 'none';
    wmManualGroup.style.display = 'block';
    document.getElementById('quotation-wm-manual').value = '';
    const manualHint = document.getElementById('quotation-wm-manual-hint');
    const statesWmExists = wmRaw && !['no', 'null'].includes(wmRaw.toLowerCase());
    if (manualHint) {
      manualHint.lastChild.textContent = statesWmExists
        ? ' อาคารนี้ระบุว่ามี WM แต่ยังไม่มีข้อมูลเลขชั้น กรุณากรอกเอง'
        : ' อาคารนี้ไม่มีข้อมูลชั้น WM ในระบบ';
    }
  }

  // Horizontal distance default + fee hint
  const hwireInputEl = document.getElementById('quotation-hwire');
  const maxHorizontal = Number(building.max_horizontal) || 0;
  const hasHorizontalInput = hwireInputEl && String(hwireInputEl.value || '').trim() !== '';
  if (hwireInputEl && maxHorizontal > 0 && !hasHorizontalInput) {
    hwireInputEl.value = maxHorizontal;
  }

  const hwireRate = Number(getBuildingBoqFeeAmount(building, 'horizontal_fee')) || 0;
  const hwireRateEl = document.getElementById('quotation-hwire-rate');
  const hwireHints = [];
  if (maxHorizontal > 0) {
    hwireHints.push(`ใช้ Max H-Wire จากข้อมูลอาคาร ${formatCurrencyNumeric(maxHorizontal)} ม. เป็นค่าเริ่มต้น`);
  }
  if (hwireRate > 0) {
    hwireHints.push(`อาคารนี้มีค่าวางสายทั้งเส้น ${formatCurrencyNumeric(hwireRate)} บาท/เมตร คิดจากระยะสายรวม`);
  }
  hwireRateEl.textContent = hwireHints.join(' | ');
  hwireRateEl.style.color = hwireHints.length ? 'var(--yellow)' : 'var(--muted)';
  updateHorizontalWireWarning();

  const permissionPanel = document.getElementById('quotation-permission-inputs');
  const permissionInputConfig = [
    {
      groupId: 'quotation-shaft-times-group',
      inputId: 'quotation-shaft-times',
      visible: permissionRequirements?.needsShaftTimes,
      defaultValue: permissionRequirements?.profile.default_shaft_times ?? 1
    },
    {
      groupId: 'quotation-circuit-count-group',
      inputId: 'quotation-circuit-count',
      visible: permissionRequirements?.needsCircuitCount,
      defaultValue: permissionRequirements?.profile.default_circuit_count ?? 1
    },
    {
      groupId: 'quotation-ot-nights-group',
      inputId: 'quotation-ot-nights',
      visible: permissionRequirements?.needsOtNights,
      defaultValue: permissionRequirements?.profile.default_ot_nights ?? 0
    },
    {
      groupId: 'quotation-contract-years-group',
      inputId: 'quotation-contract-years',
      visible: permissionRequirements?.needsContractYears,
      defaultValue: permissionRequirements?.profile.default_contract_years ?? 1
    }
  ];
  permissionInputConfig.forEach(config => {
    const group = document.getElementById(config.groupId);
    const input = document.getElementById(config.inputId);
    if (group) group.style.display = config.visible ? 'block' : 'none';
    if (input && config.visible && String(input.value).trim() === '') {
      input.value = String(config.defaultValue);
    }
  });
  if (permissionPanel) {
    permissionPanel.style.display = permissionInputConfig.some(config => config.visible) ? 'block' : 'none';
  }

  // Revenue inputs are quotation-specific because forecast revenue can change over time.
  const revenueShareFees = getBuildingBoqFees(building)
    .filter(item => item.payable && item.calculation_type === 'revenue_share');
  const needsMonthlyRevenue = revenueShareFees.some(item => item.revenue_period !== 'annual');
  const needsAnnualRevenue = revenueShareFees.some(item => item.revenue_period === 'annual');
  const revenuePanel = document.getElementById('quotation-revenue-panel');
  const monthlyRevenueGroup = document.getElementById('quotation-monthly-revenue-group');
  const annualRevenueGroup = document.getElementById('quotation-annual-revenue-group');
  if (revenuePanel) revenuePanel.style.display = revenueShareFees.length ? 'block' : 'none';
  if (monthlyRevenueGroup) monthlyRevenueGroup.style.display = needsMonthlyRevenue ? 'block' : 'none';
  if (annualRevenueGroup) annualRevenueGroup.style.display = needsAnnualRevenue ? 'block' : 'none';
  const revenueHint = document.getElementById('quotation-revenue-hint');
  if (revenueHint) {
    revenueHint.textContent = revenueShareFees.map(item =>
      `${item.label} ${formatCurrencyNumeric(Number(item.rate) || 0)}% (${item.revenue_period === 'annual' ? 'รายปี' : 'รายเดือน'})`
    ).join(' • ');
  }

  // Reset summary/shaft info
  document.getElementById('quotation-distance-summary').style.display = 'none';
  document.getElementById('quotation-shaft-info').style.display = 'none';
}

const QUOTATION_STATE_IDS = [
  'quotation-customer',
  'quotation-cust-floor',
  'quotation-wm-select',
  'quotation-wm-manual',
  'quotation-hwire',
  'quotation-shaft-times',
  'quotation-circuit-count',
  'quotation-ot-nights',
  'quotation-contract-years',
  'quotation-monthly-revenue',
  'quotation-annual-revenue',
  'quotation-remark'
];

function serializeQuotationState() {
  return JSON.stringify(QUOTATION_STATE_IDS.map(id => {
    const el = document.getElementById(id);
    return [id, el ? el.value : ''];
  }).concat([['calculated', window._quotationCalculated ? '1' : '0']]));
}

function rememberQuotationState() {
  const modal = document.getElementById('quotation-modal');
  if (!modal) return;
  modal.dataset.initialState = serializeQuotationState();
}

function quotationStateChanged() {
  const modal = document.getElementById('quotation-modal');
  if (!modal) return false;
  return (modal.dataset.initialState || '') !== serializeQuotationState();
}

function closeQuotationModal(options = {}) {
  const modal = document.getElementById('quotation-modal');
  if (!modal) return true;
  if (!options.force && quotationStateChanged() && !confirm(UNSAVED_CHANGES_CONFIRM_MESSAGE)) return false;
  modal.classList.remove('open');
  closeDialogAccessibility(modal);
  return true;
}

function quickCalculateQuotation(buildingId) {
  // หาข้อมูลอาคาร
  const building = DATA.find(d => String(d.id) === String(buildingId));
  
  // Set customer name only — ระยะสายจะคำนวณจากชั้น WM + ชั้นลูกค้า
  // ไม่ auto-fill ชื่อลูกค้า ให้ผู้ใช้กรอกเอง
  
  // Store building data for calculation and clear previous quotation inputs
  resetQuotationForm({ buildingData: building || {} });
  
  // Open modal (will call _updateQuotationDynamicInputs)
  openQuotationModal();
}

function initializeQuotationMeta(building) {
  const dates = QE().buildQuotationDates();
  const quoteRef = QE().generateQuotationRef(building?.id ?? building?._docId);
  const salesPerson = currentUser?.display_name || currentUser?.email || '-';
  window._quotationMeta = { ...dates, quoteRef, salesPerson };
  document.getElementById('prev-date').textContent = dates.issuedText;
  document.getElementById('prev-expiry-date').textContent = dates.expiresText;
  document.getElementById('prev-quote-ref').textContent = quoteRef;
  document.getElementById('prev-sales-person').textContent = salesPerson;
  document.getElementById('prev-valid-days').textContent = String(dates.validDays);
}

// Format currency
function formatCurrency(value) {
  return new Intl.NumberFormat('th-TH', {
    style: 'currency',
    currency: 'THB',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
}

function formatCurrencyNumeric(value) {
  return value.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatPermissionDuration(value) {
  const cleanValue = String(value ?? '').trim();
  if (!cleanValue) return '';
  return /วัน$/.test(cleanValue) ? cleanValue : `${cleanValue} วัน`;
}

function getQuotationExportMessage() {
  return document.getElementById('quotation-export-message') || document.getElementById('quotation-message');
}

function resetQuotationExportMessage() {
  const exportMsgEl = document.getElementById('quotation-export-message');
  if (exportMsgEl) exportMsgEl.style.display = 'none';
}

// Calculate quotation
function calculateQuotation(options = {}) {
  const { silent = false, auto = false } = options;
  const customerName = document.getElementById('quotation-customer').value.trim();
  const custFloorParsed = QE().parseFloorInput(document.getElementById('quotation-cust-floor').value);
  const hwireInput = parseFloat(document.getElementById('quotation-hwire').value) || 0;
  const remarkText = document.getElementById('quotation-remark')?.value.trim() || '';
  const msgEl = document.getElementById('quotation-message');
  resetQuotationExportMessage();
  window._quotationCalculated = false;
  window.currentQuotationSnapshot = null;
  setQuotationExportEnabled(false);

  // Validate customer name
  if (!customerName) {
    msgEl.className = 'error';
    msgEl.innerHTML = iconText('x', 'กรุณากรอกชื่อลูกค้า');
    msgEl.style.display = 'block';
    return;
  }

  // Get WM floor
  const building = window.currentBuildingData || {};
  const boqFees = getBuildingBoqFees(building);
  const revenueShareFeeRules = boqFees
    .filter(item => item.payable && item.calculation_type === 'revenue_share');
  const needsMonthlyRevenue = revenueShareFeeRules.some(item => item.revenue_period !== 'annual');
  const needsAnnualRevenue = revenueShareFeeRules.some(item => item.revenue_period === 'annual');
  const monthlyRevenueRaw = document.getElementById('quotation-monthly-revenue')?.value ?? '';
  const annualRevenueRaw = document.getElementById('quotation-annual-revenue')?.value ?? '';
  const monthlyRevenue = Number(monthlyRevenueRaw);
  const annualRevenue = Number(annualRevenueRaw);

  if (needsMonthlyRevenue && (monthlyRevenueRaw === '' || !Number.isFinite(monthlyRevenue) || monthlyRevenue < 0)) {
    msgEl.className = 'error';
    msgEl.innerHTML = iconText('x', 'กรุณากรอกรายได้ประมาณการต่อเดือน');
    msgEl.style.display = 'block';
    document.getElementById('quotation-monthly-revenue')?.focus();
    return;
  }

  if (needsAnnualRevenue && (annualRevenueRaw === '' || !Number.isFinite(annualRevenue) || annualRevenue < 0)) {
    msgEl.className = 'error';
    msgEl.innerHTML = iconText('x', 'กรุณากรอกรายได้ประมาณการต่อปี');
    msgEl.style.display = 'block';
    document.getElementById('quotation-annual-revenue')?.focus();
    return;
  }

  const wmFloor = getQuotationWmFloor(building);
  if (wmFloor.error) {
    msgEl.className = 'error';
    msgEl.innerHTML = iconText('x', wmFloor.error);
    msgEl.style.display = 'block';
    return;
  }

  if (!custFloorParsed) {
    msgEl.className = 'error';
    msgEl.innerHTML = iconText('x', 'กรุณากรอกชั้นที่ลูกค้าอยู่ (เช่น 20, B1, G)');
    msgEl.style.display = 'block';
    return;
  }

  const custFloor = custFloorParsed.numeric;
  const custFloorLabel = custFloorParsed.label;
  const wmFloorNumeric = wmFloor.numeric;
  const wmFloorLabel = wmFloor.label;

  const hwireCheck = QE().checkHorizontalDistance(hwireInput, building.max_horizontal);
  if (hwireCheck.level === 'error') {
    msgEl.className = 'error';
    msgEl.innerHTML = iconText('x', hwireCheck.message);
    msgEl.style.display = 'block';
    return;
  }
  updateHorizontalWireWarning();

  if (hwireInput < 0) {
    msgEl.className = 'error';
    msgEl.innerHTML = iconText('x', 'ระยะ Horizontal ต้องไม่ติดลบ');
    msgEl.style.display = 'block';
    return;
  }

  const permissionRequirements = getPermissionInputRequirements(building);
  const readQuotationCountInput = (id, label, { min = 0 } = {}) => {
    const input = document.getElementById(id);
    const value = Number(input?.value);
    if (!input || !Number.isFinite(value) || value < min || !Number.isInteger(value)) {
      msgEl.className = 'error';
      msgEl.innerHTML = iconText('x', `กรุณากรอก${label}เป็นจำนวนเต็มตั้งแต่ ${min} ขึ้นไป`);
      msgEl.style.display = 'block';
      input?.focus();
      return null;
    }
    return value;
  };
  const shaftTimes = permissionRequirements?.needsShaftTimes
    ? readQuotationCountInput('quotation-shaft-times', 'จำนวนครั้งที่ใช้ Shaft')
    : Number(permissionRequirements?.profile.default_shaft_times ?? 1);
  const circuitCount = permissionRequirements?.needsCircuitCount
    ? readQuotationCountInput('quotation-circuit-count', 'จำนวนวงจร / Core', { min: 1 })
    : Number(permissionRequirements?.profile.default_circuit_count ?? 1);
  const otNights = permissionRequirements?.needsOtNights
    ? readQuotationCountInput('quotation-ot-nights', 'จำนวนคืนที่ทำงานนอกเวลา')
    : Number(permissionRequirements?.profile.default_ot_nights ?? 0);
  const contractYears = permissionRequirements?.needsContractYears
    ? readQuotationCountInput('quotation-contract-years', 'อายุสัญญา', { min: 1 })
    : Number(permissionRequirements?.profile.default_contract_years ?? 1);
  if ([shaftTimes, circuitCount, otNights, contractYears].some(value => value === null)) return;

  // ===== DISTANCE CALCULATION =====
  const calculationProfile = getBuildingInstallationProfile(building);
  const metersPerFloor = calculationProfile.meters_per_floor;
  const verticalFloorCount = QE().countVerticalFloors(wmFloorNumeric, custFloor);
  const verticalDistance = verticalFloorCount * metersPerFloor;
  const totalCableDistance = verticalDistance + hwireInput;

  // Show distance summary
  const summaryBox = document.getElementById('quotation-distance-summary');
  document.getElementById('quotation-dist-vertical').innerHTML =
    `${svgIcon('vertical')} แนวตั้ง: นับรวมชั้น ${wmFloorLabel} ถึง ${custFloorLabel} = ${verticalFloorCount} ชั้น × ${formatCurrencyNumeric(metersPerFloor)} ม. = ${formatCurrencyNumeric(verticalDistance)} ม.`;
  document.getElementById('quotation-dist-horizontal').innerHTML =
    `${svgIcon('horizontal')} แนวนอน: ${formatCurrencyNumeric(hwireInput)} ม.`;
  document.getElementById('quotation-dist-total').innerHTML =
    `${svgIcon('ruler')} ระยะสายรวม: ${formatCurrencyNumeric(verticalDistance)} + ${formatCurrencyNumeric(hwireInput)} = ${formatCurrencyNumeric(totalCableDistance)} ม.`;
  summaryBox.style.display = 'block';

  // ===== COST CALCULATION =====
  const cableRatePerMeter = calculationProfile.cable_rate_per_meter;
  const equipmentCost = calculationProfile.equipment_cost;
  const odfCost = calculationProfile.odf_cost;
  const spliceCost = calculationProfile.splice_cost;
  const cableCost = totalCableDistance * cableRatePerMeter;

  const permissionResult = calculatePermissionCost(building, {
    floorCount: verticalFloorCount,
    verticalDistance,
    horizontalDistance: hwireInput,
    totalCableDistance,
    shaftTimes,
    circuitCount,
    otNights,
    contractYears
  });
  if (permissionResult?.errors.length) {
    const errorItems = permissionResult.errors
      .map(item => `<li><strong>${esc(item.label)}</strong>: ${esc(item.reason)}</li>`)
      .join('');
    msgEl.className = 'error';
    msgEl.innerHTML = `${iconText('x', 'ไม่สามารถคำนวณค่า Permission ได้ เนื่องจากข้อมูลอาคารไม่สมบูรณ์')}<ul style="margin:8px 0 0 20px;">${errorItems}</ul>`;
    msgEl.style.display = 'block';
    document.getElementById('quotation-distance-summary').style.display = 'none';
    return;
  }
  const permissionDataIssues = permissionResult?.dataIssues || [];
  const permissionWarnings = [
    ...(permissionResult?.warnings || []),
    ...permissionDataIssues.map(item => `${item.label}: ${item.reason}`)
  ];

  let buildingFees;
  let nonPayableFees;
  if (permissionResult) {
    buildingFees = permissionResult.payableItems;
    nonPayableFees = permissionResult.excludedItems;
  } else {
    const fixedPayableFees = boqFees
      .filter(item => item.payable && !['variable_fee', 'revenue_share'].includes(item.category))
      .map(item => ({
        field: item.source_field || item.key,
        label: item.label,
        value: item.amount,
        qty: formatBuildingBoqFeeQuantity(item),
        cost_type: item.cost_type
      }));
    nonPayableFees = boqFees
      .filter(item => !item.payable && item.amount > 0)
      .map(item => ({
        field: item.source_field || item.key,
        label: item.label,
        value: item.amount,
        qty: formatBuildingBoqFeeQuantity(item),
        cost_type: item.cost_type
      }));
    const shaftRatePerFloor = Number(getBuildingBoqFeeAmount(building, 'shaft_fee_per_floor')) || 0;
    const cableRouteRatePerMeter = Number(getBuildingBoqFeeAmount(building, 'horizontal_fee')) || 0;
    buildingFees = [
      ...fixedPayableFees,
      {
        field: 'shaft_fee_per_floor',
        label: `ค่า Shaft (${formatCurrencyNumeric(shaftRatePerFloor)} บ./ชั้น × ${verticalFloorCount} ชั้น)`,
        value: shaftRatePerFloor * verticalFloorCount,
        qty: `${verticalFloorCount} ชั้น`,
        cost_type: getBuildingBoqFee(building, 'shaft_fee_per_floor')?.cost_type || 'CAPEX',
        hidden: shaftRatePerFloor === 0
      },
      {
        field: 'horizontal_fee',
        label: `ค่าวางสายทั้งเส้น (${formatCurrencyNumeric(cableRouteRatePerMeter)} บ./ม. × ระยะรวม ${formatCurrencyNumeric(totalCableDistance)} ม.)`,
        value: cableRouteRatePerMeter * totalCableDistance,
        qty: `${formatCurrencyNumeric(totalCableDistance)} ม.`,
        cost_type: getBuildingBoqFee(building, 'horizontal_fee')?.cost_type || 'CAPEX',
        hidden: cableRouteRatePerMeter === 0
      }
    ].filter(item => !item.hidden && item.value > 0);
  }

  const shaftInfoEl = document.getElementById('quotation-shaft-info');
  const shaftSummaryEl = document.getElementById('quotation-shaft-summary');
  const shaftItem = buildingFees.find(item => String(item.field || '').startsWith('shaft_fee_'));
  if (shaftItem) {
    shaftSummaryEl.innerHTML = `${svgIcon('alert')} ${esc(shaftItem.label)} = ${formatCurrencyNumeric(shaftItem.value)} บาท`;
    shaftInfoEl.style.display = 'block';
  } else {
    shaftInfoEl.style.display = 'none';
  }

  const revenueShareFees = revenueShareFeeRules.map(item => {
    const rate = Number(item.rate) || 0;
    const isAnnual = item.revenue_period === 'annual';
    const baseRevenue = isAnnual ? annualRevenue : monthlyRevenue;
    const periodValue = baseRevenue * rate / 100;
    return {
      label: `${item.label} (${formatCurrencyNumeric(rate)}% ของรายได้${isAnnual ? 'รายปี' : 'รายเดือน'})`,
      rate,
      period: isAnnual ? 'annual' : 'monthly',
      baseRevenue,
      value: periodValue,
      monthlyValue: isAnnual ? periodValue / 12 : periodValue,
      annualValue: isAnnual ? periodValue : periodValue * 12,
      qty: `${formatCurrencyNumeric(rate)}% × ${formatCurrencyNumeric(baseRevenue)} บาท/${isAnnual ? 'ปี' : 'เดือน'}`,
      cost_type: 'OPEX'
    };
  });
  const revenueShareMonthlyTotal = revenueShareFees.reduce((sum, item) => sum + item.monthlyValue, 0);
  const revenueShareAnnualTotal = revenueShareFees.reduce((sum, item) => sum + item.annualValue, 0);

  const installationSubtotal = cableCost + equipmentCost + odfCost + spliceCost;
  const costTypeLabels = {
    CAPEX: 'CAPEX',
    OPEX: 'OPEX',
    OPEX_MONTHLY: 'OPEX รายเดือน',
    OPEX_ANNUAL: 'OPEX รายปี',
    DEPOSIT: 'Deposit ที่ต้องชำระ',
    UNCLASSIFIED: 'ยังไม่จัดประเภท'
  };
  const payableGroups = ['CAPEX', 'OPEX', 'OPEX_MONTHLY', 'OPEX_ANNUAL', 'DEPOSIT', 'UNCLASSIFIED']
    .map(costType => ({
      costType,
      label: costTypeLabels[costType],
      items: buildingFees.filter(item => item.cost_type === costType)
    }))
    .map(group => ({
      ...group,
      total: group.items.reduce((sum, item) => sum + item.value, 0)
    }));
  const buildingCapexTotal = payableGroups.find(group => group.costType === 'CAPEX')?.total || 0;
  const capexTotal = installationSubtotal + buildingCapexTotal;
  const opexTotal = payableGroups.find(group => group.costType === 'OPEX')?.total || 0;
  const monthlyOpexTotal = payableGroups.find(group => group.costType === 'OPEX_MONTHLY')?.total || 0;
  const annualOpexTotal = payableGroups.find(group => group.costType === 'OPEX_ANNUAL')?.total || 0;
  const depositPayableTotal = payableGroups.find(group => group.costType === 'DEPOSIT')?.total || 0;
  const unclassifiedPayableTotal = payableGroups.find(group => group.costType === 'UNCLASSIFIED')?.total || 0;
  const nonPayableTotal = nonPayableFees.reduce((sum, item) => sum + item.value, 0);
  const totalCost = capexTotal + opexTotal + depositPayableTotal + unclassifiedPayableTotal;

  // ===== UPDATE FORM DISPLAY =====
  document.getElementById('quotation-cable-cost').textContent = formatCurrency(cableCost);
  document.getElementById('quotation-equipment-cost').textContent = formatCurrency(equipmentCost);
  document.getElementById('quotation-closure-cost').textContent = formatCurrency(odfCost);
  document.getElementById('quotation-splice-cost').textContent = formatCurrency(spliceCost);
  document.getElementById('quotation-installation-subtotal').textContent = formatCurrency(installationSubtotal);

  const buildingFeesContainer = document.getElementById('quotation-building-fees');
  const permissionFormulaHtml = `
      <div class="quotation-calc-section">
        <span>สูตร Permission</span>
        <span>${permissionResult
          ? `${permissionResult.formulaType
              ? `สูตรกลาง ${permissionResult.formulaType}`
              : 'สูตรรายอาคาร'} v${permissionResult.version}${permissionDataIssues.length ? ' • ผลบางส่วน' : ''}`
          : 'BOQ fallback'}</span>
      </div>
      ${permissionWarnings.length ? `
        <div style="color:var(--yellow);font-size:11px;line-height:1.6;margin:8px 0;">
          ${permissionWarnings.map(warning => `• ${esc(warning)}`).join('<br>')}
        </div>` : ''}`;
  const buildingFeesHtml = payableGroups.filter(group => group.total > 0).map(group => `
      <div class="quotation-calc-section">
        <span>${esc(group.label)}</span>
        <span>${formatCurrency(group.total)}</span>
      </div>
      ${group.items.map(f => `
        <div class="quotation-calc-row">
          <span class="quotation-calc-label">${esc(f.label)}</span>
          <span class="quotation-calc-value">${formatCurrency(f.value)}</span>
        </div>`).join('')}`).join('');
  const nonPayableFeesHtml = nonPayableFees.length ? `
      <div class="quotation-calc-section">
        <span>Deposit / รายการไม่รวม</span>
        <span>${formatCurrency(nonPayableTotal)} • ไม่นำไปรวม</span>
      </div>
      ${nonPayableFees.map(f => `
        <div class="quotation-calc-row">
          <span class="quotation-calc-label">${esc(f.label)}</span>
          <span class="quotation-calc-value">${formatCurrency(f.value)}</span>
        </div>`).join('')}` : '';
  const costBreakdownHtml = `
      <div class="quotation-cost-breakdown">
        <div><span>CAPEX รวม</span><strong>${formatCurrency(capexTotal)}</strong></div>
        <div><span>OPEX รวม</span><strong>${formatCurrency(opexTotal)}</strong></div>
        ${monthlyOpexTotal > 0 ? `<div><span>OPEX รายเดือน (ไม่รวมยอดเริ่มต้น)</span><strong>${formatCurrency(monthlyOpexTotal)}/เดือน</strong></div>` : ''}
        ${annualOpexTotal > 0 ? `<div><span>OPEX รายปี (ไม่รวมยอดเริ่มต้น)</span><strong>${formatCurrency(annualOpexTotal)}/ปี</strong></div>` : ''}
        ${depositPayableTotal > 0 ? `<div><span>Deposit ที่ต้องชำระ</span><strong>${formatCurrency(depositPayableTotal)}</strong></div>` : ''}
        ${unclassifiedPayableTotal > 0 ? `<div><span>ยังไม่จัดประเภท</span><strong>${formatCurrency(unclassifiedPayableTotal)}</strong></div>` : ''}
        ${nonPayableTotal > 0 ? `<div class="excluded"><span>รายการไม่นำไปรวม</span><strong>${formatCurrency(nonPayableTotal)}</strong></div>` : ''}
      </div>`;
  buildingFeesContainer.innerHTML = permissionFormulaHtml + buildingFeesHtml + nonPayableFeesHtml + costBreakdownHtml;

  const revenueShareSummaryEl = document.getElementById('quotation-revenue-share-summary');
  revenueShareSummaryEl.innerHTML = revenueShareFees.length ? `
      <div class="quotation-calc-section">
        <span>OPEX ส่วนแบ่งรายได้</span>
        <span>ค่าใช้จ่ายต่อเนื่อง</span>
      </div>
      ${revenueShareFees.map(f => `
        <div class="quotation-calc-row">
          <span class="quotation-calc-label">${esc(f.label)}</span>
          <span class="quotation-calc-value">${formatCurrency(f.value)}/${f.period === 'annual' ? 'ปี' : 'เดือน'}</span>
        </div>`).join('')}
      <div class="quotation-cost-breakdown">
        <div><span>รวมส่วนแบ่งเฉลี่ยต่อเดือน</span><strong>${formatCurrency(revenueShareMonthlyTotal)}</strong></div>
        <div><span>รวมส่วนแบ่งต่อปี</span><strong>${formatCurrency(revenueShareAnnualTotal)}</strong></div>
      </div>` : '';

  document.getElementById('quotation-total-label').textContent =
    permissionDataIssues.length
      ? 'ยอดประเมินจากข้อมูลที่คำนวณได้'
      : revenueShareFees.length || monthlyOpexTotal > 0 || annualOpexTotal > 0
      ? 'ยอดเริ่มต้นที่ต้องชำระ'
      : 'ยอดรวมที่ต้องชำระ';

  document.getElementById('quotation-total-cost').textContent = formatCurrency(totalCost);
  window.currentQuotationSnapshot = {
    created_at: new Date().toISOString(),
    building_id: building.id ?? building._docId ?? null,
    installation_profile: { ...calculationProfile },
    permission_formula: permissionResult
      ? {
          source: permissionResult.source,
          formula_type: permissionResult.formulaType,
          version: permissionResult.version,
          profile: {
            fixed_capex_fields: [...(permissionResult.profile.fixed_capex_fields || [])],
            refundable_fields: [...(permissionResult.profile.refundable_fields || [])],
            recurring_fields: [...(permissionResult.profile.recurring_fields || [])],
            horizontal_mode: permissionResult.profile.horizontal_mode || 'none',
            horizontal_distance_basis: permissionResult.profile.horizontal_distance_basis || 'none',
            shaft_mode: permissionResult.profile.shaft_mode || 'none',
            fee_per_meter_basis: permissionResult.profile.fee_per_meter_basis || 'none',
            annual_fee_per_meter_basis: permissionResult.profile.annual_fee_per_meter_basis || 'none',
            core_rent_mode: permissionResult.profile.core_rent_mode || 'none'
          },
          payable_items: permissionResult.payableItems.map(item => ({ ...item })),
          excluded_items: permissionResult.excludedItems.map(item => ({ ...item })),
          complete: permissionDataIssues.length === 0,
          data_issues: permissionDataIssues.map(item => ({ ...item })),
          warnings: permissionResult.warnings.map(item => String(item))
        }
      : { source: 'boq_fallback', version: null },
    inputs: {
      wm_floor: wmFloorNumeric,
      wm_floor_label: wmFloorLabel,
      customer_floor: custFloor,
      customer_floor_label: custFloorLabel,
      remark: remarkText,
      floor_count: verticalFloorCount,
      vertical_distance: verticalDistance,
      horizontal_distance: hwireInput,
      total_cable_distance: totalCableDistance,
      shaft_times: shaftTimes,
      circuit_count: circuitCount,
      ot_nights: otNights,
      contract_years: contractYears
    },
    totals: {
      installation: installationSubtotal,
      capex: capexTotal,
      opex: opexTotal,
      opex_monthly: monthlyOpexTotal,
      opex_annual: annualOpexTotal,
      payable_deposit: depositPayableTotal,
      excluded: nonPayableTotal,
      payable_total: totalCost
    }
  };

  // ===== UPDATE PREVIEW =====
  const permissionDurationText = formatPermissionDuration(building.duration);
  const permissionDurationBlock = document.getElementById('prev-permission-duration-block');
  document.getElementById('prev-customer-name').textContent = customerName;
  document.getElementById('prev-building-name').textContent = building.name_th || building.name_eng || '-';
  document.getElementById('prev-permission-duration').textContent = permissionDurationText || '-';
  if (permissionDurationBlock) permissionDurationBlock.style.display = permissionDurationText ? '' : 'none';
  document.getElementById('prev-customer-floor').textContent = `ชั้น ${custFloorLabel}`;
  document.getElementById('prev-wm-floor').textContent = `ชั้น ${wmFloorLabel}`;
  const remarkBlock = document.getElementById('prev-remark-block');
  const remarkEl = document.getElementById('prev-remark');
  if (remarkBlock && remarkEl) {
    if (remarkText) {
      remarkEl.textContent = remarkText;
      remarkBlock.hidden = false;
    } else {
      remarkEl.textContent = '-';
      remarkBlock.hidden = true;
    }
  }
  if (window._quotationMeta) {
    document.getElementById('prev-date').textContent = window._quotationMeta.issuedText;
    document.getElementById('prev-expiry-date').textContent = window._quotationMeta.expiresText;
    document.getElementById('prev-quote-ref').textContent = window._quotationMeta.quoteRef;
    document.getElementById('prev-sales-person').textContent = window._quotationMeta.salesPerson;
  }
  document.getElementById('prev-distance').textContent = `${totalCableDistance} ม. (แนวตั้ง ${verticalDistance} + แนวนอน ${hwireInput})`;
  document.getElementById('prev-cable-cost').textContent = formatCurrencyNumeric(cableCost) + ' บาท';
  document.getElementById('prev-equipment-cost').textContent = formatCurrencyNumeric(equipmentCost) + ' บาท';
  document.getElementById('prev-odf-cost').textContent = formatCurrencyNumeric(odfCost) + ' บาท';
  document.getElementById('prev-splice-cost').textContent = formatCurrencyNumeric(spliceCost) + ' บาท';
  document.getElementById('prev-installation-subtotal').textContent = formatCurrencyNumeric(installationSubtotal) + ' บาท';

  const prevBuildingFeesContainer = document.getElementById('prev-building-fees-table');
  let previewItemIndex = 5;
  const buildingFeesPreviewHtml = payableGroups.filter(group => group.total > 0).map(group => {
    const rows = group.items.map(fee => `
        <tr>
          <td>${previewItemIndex++}</td>
          <td>${esc(fee.label)}</td>
          <td>${esc(fee.qty)}</td>
          <td class="quotation-amount">${formatCurrencyNumeric(fee.value)} บาท</td>
        </tr>`).join('');
    return `
      <tr class="quotation-section-row">
        <td colspan="4">${esc(group.label)}</td>
      </tr>
      ${rows}
      <tr class="quotation-subtotal-row">
        <td colspan="3">รวม ${esc(group.label)}</td>
        <td class="quotation-amount">${formatCurrencyNumeric(group.total)} บาท</td>
      </tr>`;
  }).join('');
  const nonPayableFeesPreviewHtml = nonPayableFees.length ? `
      <tr class="quotation-section-row">
        <td colspan="4">Deposit / รายการไม่รวมยอด</td>
      </tr>
      ${nonPayableFees.map(f => `
        <tr>
          <td>${previewItemIndex++}</td>
          <td>${esc(f.label)}</td>
          <td>${esc(f.qty)}</td>
          <td class="quotation-amount">${formatCurrencyNumeric(f.value)} บาท</td>
        </tr>`).join('')}
      <tr class="quotation-subtotal-row">
        <td colspan="3">รวมรายการไม่นำมาคำนวณ</td>
        <td class="quotation-amount">${formatCurrencyNumeric(nonPayableTotal)} บาท</td>
      </tr>` : '';
  const revenueShareFeesPreviewHtml = revenueShareFees.length ? `
      <tr class="quotation-section-row">
        <td colspan="4">OPEX ส่วนแบ่งรายได้ (ค่าใช้จ่ายต่อเนื่อง)</td>
      </tr>
      ${revenueShareFees.map(f => `
        <tr>
          <td>${previewItemIndex++}</td>
          <td>${esc(f.label)}</td>
          <td>${esc(f.qty)}</td>
          <td class="quotation-amount">${formatCurrencyNumeric(f.value)} บาท/${f.period === 'annual' ? 'ปี' : 'เดือน'}</td>
        </tr>`).join('')}` : '';
  prevBuildingFeesContainer.innerHTML = buildingFeesPreviewHtml + nonPayableFeesPreviewHtml + revenueShareFeesPreviewHtml;

  document.getElementById('prev-cost-breakdown').innerHTML = `
    <div><span>สูตร Permission</span><strong>${permissionResult
      ? `${permissionResult.formulaType
          ? `สูตรกลาง ${permissionResult.formulaType}`
          : 'สูตรรายอาคาร'} v${permissionResult.version}${permissionDataIssues.length ? ' • ผลบางส่วน' : ''}`
      : 'BOQ fallback'}</strong></div>
    ${permissionDataIssues.length ? `<div style="display:block;color:#b45309;"><span>คำเตือนข้อมูล</span><strong style="display:block;margin-top:4px;">${permissionDataIssues.map(item => `${esc(item.label)}: ${esc(item.reason)}`).join('<br>')}</strong></div>` : ''}
    <div><span>CAPEX รวม</span><strong>${formatCurrencyNumeric(capexTotal)} บาท</strong></div>
    <div><span>OPEX รวม</span><strong>${formatCurrencyNumeric(opexTotal)} บาท</strong></div>
    ${monthlyOpexTotal > 0 ? `<div><span>OPEX รายเดือน (ไม่รวมยอดเริ่มต้น)</span><strong>${formatCurrencyNumeric(monthlyOpexTotal)} บาท/เดือน</strong></div>` : ''}
    ${annualOpexTotal > 0 ? `<div><span>OPEX รายปี (ไม่รวมยอดเริ่มต้น)</span><strong>${formatCurrencyNumeric(annualOpexTotal)} บาท/ปี</strong></div>` : ''}
    ${depositPayableTotal > 0 ? `<div><span>Deposit ที่ต้องชำระ</span><strong>${formatCurrencyNumeric(depositPayableTotal)} บาท</strong></div>` : ''}
    ${unclassifiedPayableTotal > 0 ? `<div><span>ยังไม่จัดประเภท</span><strong>${formatCurrencyNumeric(unclassifiedPayableTotal)} บาท</strong></div>` : ''}
    ${nonPayableTotal > 0 ? `<div class="excluded"><span>รายการไม่นำมาคำนวณ</span><strong>${formatCurrencyNumeric(nonPayableTotal)} บาท</strong></div>` : ''}`;
  document.getElementById('prev-revenue-share-summary').innerHTML = revenueShareFees.length ? `
    <div><span>ส่วนแบ่งรายได้เฉลี่ยต่อเดือน</span><strong>${formatCurrencyNumeric(revenueShareMonthlyTotal)} บาท</strong></div>
    <div><span>ส่วนแบ่งรายได้ต่อปี</span><strong>${formatCurrencyNumeric(revenueShareAnnualTotal)} บาท</strong></div>` : '';
  document.getElementById('prev-total-label').textContent =
    permissionDataIssues.length
      ? 'ยอดประเมินจากข้อมูลที่คำนวณได้'
      : revenueShareFees.length || monthlyOpexTotal > 0 || annualOpexTotal > 0
      ? 'ยอดเริ่มต้นที่ต้องชำระ'
      : 'ยอดรวมที่ต้องชำระ';
  document.getElementById('prev-total').textContent = formatCurrencyNumeric(totalCost) + ' บาท';

  markQuotationCalculated();
  window._quotationLastCustomer = customerName;
  window._quotationCopyPayload = {
    quoteRef: window._quotationMeta?.quoteRef,
    customerName,
    buildingName: building.name_th || building.name_eng || '-',
    wmFloorLabel,
    custFloorLabel,
    totalCostText: formatCurrencyNumeric(totalCost) + ' บาท',
    revenueMonthlyText: revenueShareFees.length
      ? formatCurrencyNumeric(revenueShareMonthlyTotal) + ' บาท/เดือน'
      : '',
    issuedText: window._quotationMeta?.issuedText,
    expiresText: window._quotationMeta?.expiresText,
    salesPerson: window._quotationMeta?.salesPerson,
    remark: remarkText
  };
  if (!silent) {
    msgEl.className = permissionDataIssues.length ? 'error' : 'success';
    msgEl.innerHTML = permissionDataIssues.length
      ? iconText('alert', `คำนวณสำเร็จเฉพาะรายการที่มีข้อมูลถูกต้อง — ข้าม ${permissionDataIssues.length} รายการที่ต้องยืนยันกับเจ้าของข้อมูล`)
      : iconText('check', auto ? 'อัปเดตการคำนวณอัตโนมัติแล้ว' : 'คำนวณสำเร็จ');
    msgEl.style.display = 'block';
    if (!permissionDataIssues.length) {
      setTimeout(() => msgEl.style.display = 'none', auto ? 2000 : 3000);
    }
  } else if (permissionDataIssues.length && !auto) {
    msgEl.className = 'error';
    msgEl.innerHTML = iconText('alert', `คำนวณสำเร็จเฉพาะรายการที่มีข้อมูลถูกต้อง — ข้าม ${permissionDataIssues.length} รายการที่ต้องยืนยันกับเจ้าของข้อมูล`);
    msgEl.style.display = 'block';
  }
  rememberQuotationState();
}

// Generate PDF
async function waitForQuotationFonts() {
  if (document.fonts?.load) {
    try {
      await Promise.race([
        Promise.all([
          document.fonts.load('400 12px "Noto Sans Thai"'),
          document.fonts.load('700 12px "Noto Sans Thai"'),
          document.fonts.load('800 20px "Noto Sans Thai"'),
          document.fonts.ready
        ]),
        new Promise(resolve => setTimeout(resolve, 4000))
      ]);
    } catch (err) {
      console.warn('โหลดฟอนต์ไทยสำหรับ PDF ไม่ครบ จะใช้ฟอนต์สำรอง:', err);
    }
  }
  // Allow layout to settle after the font metrics change before html2canvas captures it.
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

function quotationLogoFallbackDataUrl() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="112" height="112" viewBox="0 0 112 112"><rect width="112" height="112" rx="20" fill="#1d4ed8"/><path d="M25 29h34c19 0 30 10 30 27S78 83 59 83H43v16H25V29zm18 16v22h15c8 0 13-4 13-11s-5-11-13-11H43z" fill="white"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('อ่านข้อมูลรูปภาพไม่สำเร็จ'));
    reader.readAsDataURL(blob);
  });
}

async function buildExportImageMap(element) {
  const imageMap = new Map();
  await Promise.all([...element.querySelectorAll('img')].map(async image => {
    const src = image.currentSrc || image.src;
    if (!src || src.startsWith('data:') || src.startsWith('blob:')) return;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(src, {
        mode: 'cors',
        cache: 'force-cache',
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      imageMap.set(src, await blobToDataUrl(await response.blob()));
    } catch (error) {
      console.warn('ไม่สามารถฝังรูปภายนอกในไฟล์ Export ได้ จะใช้รูปสำรอง:', src, error);
      if (image.classList.contains('quotation-preview-logo')) {
        imageMap.set(src, quotationLogoFallbackDataUrl());
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }));
  return imageMap;
}

async function withQuotationExportLayout(element, task) {
  const previousScrollTop = element.scrollTop;
  element.classList.add('quotation-exporting');
  try {
    await waitForQuotationFonts();
    const imageMap = await buildExportImageMap(element);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return await task(imageMap);
  } finally {
    element.classList.remove('quotation-exporting');
    element.scrollTop = previousScrollTop;
  }
}

function applyExportCloneFixes(clonedDocument, imageMap) {
  const clone = clonedDocument.getElementById('quotation-preview');
  if (!clone) return;
  clone.classList.add('quotation-exporting');
  clone.querySelectorAll('img').forEach(image => {
    const replacement = imageMap.get(image.currentSrc || image.src) || imageMap.get(image.src);
    if (replacement) image.src = replacement;
  });
}

function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error('เบราว์เซอร์ไม่สามารถสร้างไฟล์รูปภาพได้'));
    }, type, quality);
  });
}

function cropCanvasToQuotationContent(canvas, element) {
  const elementRect = element.getBoundingClientRect();
  const contentRects = [...element.children]
    .filter(child => !child.classList.contains('quotation-preview-watermark'))
    .map(child => child.getBoundingClientRect())
    .filter(rect => rect.width > 0 && rect.height > 0);
  if (!contentRects.length || !elementRect.width || !elementRect.height) return canvas;

  const padding = Math.max(12, parseFloat(getComputedStyle(element).paddingTop) || 24);
  const left = Math.max(elementRect.left, Math.min(...contentRects.map(rect => rect.left)) - padding);
  const top = Math.max(elementRect.top, Math.min(...contentRects.map(rect => rect.top)) - padding);
  const right = Math.min(elementRect.right, Math.max(...contentRects.map(rect => rect.right)) + padding);
  const bottom = Math.min(elementRect.bottom, Math.max(...contentRects.map(rect => rect.bottom)) + padding);
  const scaleX = canvas.width / element.scrollWidth;
  const scaleY = canvas.height / element.scrollHeight;
  const sourceX = Math.max(0, Math.floor((left - elementRect.left) * scaleX));
  const sourceY = Math.max(0, Math.floor((top - elementRect.top) * scaleY));
  const sourceWidth = Math.min(canvas.width - sourceX, Math.ceil((right - left) * scaleX));
  const sourceHeight = Math.min(canvas.height - sourceY, Math.ceil((bottom - top) * scaleY));
  if (sourceWidth <= 0 || sourceHeight <= 0) return canvas;

  const cropped = document.createElement('canvas');
  cropped.width = sourceWidth;
  cropped.height = sourceHeight;
  const context = cropped.getContext('2d');
  if (!context) return canvas;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, cropped.width, cropped.height);
  context.drawImage(
    canvas,
    sourceX, sourceY, sourceWidth, sourceHeight,
    0, 0, cropped.width, cropped.height
  );
  return cropped;
}

async function renderQuotationCanvas(element, imageMap) {
  const canvas = await window.html2canvas(element, {
    scale: 2,
    useCORS: true,
    allowTaint: false,
    backgroundColor: '#ffffff',
    logging: false,
    scrollX: 0,
    scrollY: 0,
    width: element.scrollWidth,
    height: element.scrollHeight,
    windowWidth: element.scrollWidth,
    windowHeight: element.scrollHeight,
    onclone: clonedDocument => applyExportCloneFixes(clonedDocument, imageMap)
  });
  return cropCanvasToQuotationContent(canvas, element);
}

function canvasToPdfBlob(canvas) {
  const JsPDF = window.jspdf?.jsPDF;
  if (!JsPDF) throw new Error('ไม่พบไลบรารี่ jsPDF');

  const pdf = new JsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 8;
  const contentWidth = pageWidth - (margin * 2);
  const contentHeight = pageHeight - (margin * 2);
  const projectedHeight = canvas.height * contentWidth / canvas.width;

  // ใบประเมินมาตรฐานที่สูงเกิน A4 เพียงเล็กน้อยให้อยู่หน้าเดียว
  // เพื่อไม่ให้ส่วนสรุป/ลายเซ็นถูกตัดไปอยู่หน้าที่สองโดยไม่จำเป็น
  if (projectedHeight <= contentHeight * 1.12) {
    const scale = Math.min(contentWidth / canvas.width, contentHeight / canvas.height);
    const renderWidth = canvas.width * scale;
    const renderHeight = canvas.height * scale;
    const x = (pageWidth - renderWidth) / 2;
    const y = (pageHeight - renderHeight) / 2;
    pdf.addImage(canvas, 'PNG', x, y, renderWidth, renderHeight, undefined, 'FAST');
    return pdf.output('blob');
  }

  // เอกสารที่ยาวมากแบ่งเป็นหลายหน้า A4 โดยตัดจาก Canvas เต็มความกว้าง
  const sliceHeight = Math.max(1, Math.floor(canvas.width * contentHeight / contentWidth));
  let sourceY = 0;
  let pageIndex = 0;
  while (sourceY < canvas.height) {
    const currentHeight = Math.min(sliceHeight, canvas.height - sourceY);
    const pageCanvas = document.createElement('canvas');
    pageCanvas.width = canvas.width;
    pageCanvas.height = currentHeight;
    const context = pageCanvas.getContext('2d');
    if (!context) throw new Error('ไม่สามารถเตรียมหน้า PDF ได้');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
    context.drawImage(
      canvas,
      0, sourceY, canvas.width, currentHeight,
      0, 0, pageCanvas.width, pageCanvas.height
    );
    if (pageIndex > 0) pdf.addPage();
    const renderHeight = currentHeight * contentWidth / canvas.width;
    const y = currentHeight < sliceHeight ? (pageHeight - renderHeight) / 2 : margin;
    pdf.addImage(pageCanvas, 'PNG', margin, y, contentWidth, renderHeight, undefined, 'FAST');
    sourceY += currentHeight;
    pageIndex += 1;
  }
  return pdf.output('blob');
}

function canvasToA4Image(canvas) {
  const pageWidth = 1600;
  const pageHeight = Math.round(pageWidth * 297 / 210);
  const margin = Math.round(pageWidth * 8 / 210);
  const contentWidth = pageWidth - (margin * 2);
  const contentHeight = pageHeight - (margin * 2);
  const projectedHeight = canvas.height * contentWidth / canvas.width;
  const fitsSinglePage = projectedHeight <= contentHeight * 1.12;
  const scale = fitsSinglePage
    ? Math.min(contentWidth / canvas.width, contentHeight / canvas.height)
    : contentWidth / canvas.width;
  const renderWidth = Math.round(canvas.width * scale);
  const renderHeight = Math.round(canvas.height * scale);
  const output = document.createElement('canvas');
  output.width = pageWidth;
  output.height = fitsSinglePage ? pageHeight : renderHeight + (margin * 2);
  const context = output.getContext('2d');
  if (!context) throw new Error('ไม่สามารถจัดรูปภาพสำหรับ Export ได้');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, output.width, output.height);
  const x = Math.round((output.width - renderWidth) / 2);
  const y = fitsSinglePage ? Math.round((output.height - renderHeight) / 2) : margin;
  context.drawImage(canvas, x, y, renderWidth, renderHeight);
  return output;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function generateQuotationPDF() {
  const customerName = document.getElementById('quotation-customer').value.trim();
  const msgEl = getQuotationExportMessage();
  const pdfBtn = document.getElementById('quotation-pdf-btn');

  if (!window._quotationCalculated || !customerName) {
    msgEl.className = 'error';
    msgEl.innerHTML = iconText('x', 'กรุณากรอกข้อมูลและกดคำนวณก่อน');
    msgEl.style.display = 'block';
    return;
  }

  if (pdfBtn) pdfBtn.disabled = true;

  if (typeof window.html2canvas !== 'function' || !window.jspdf?.jsPDF) {
    msgEl.className = 'error';
    msgEl.textContent = 'กำลังโหลดไลบรารี่ PDF...';
    msgEl.style.display = 'block';
    try {
      await loadPdfLibrary();
    } catch (err) {
      if (pdfBtn) pdfBtn.disabled = false;
      msgEl.className = 'error';
      msgEl.innerHTML = iconText('x', 'โหลดไลบรารี่ PDF ไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ต');
      msgEl.style.display = 'block';
      return;
    }
  }
  
  const element = document.getElementById('quotation-preview');
  const filename = `quotation_${QE().sanitizeFilename(customerName)}_${Date.now()}.pdf`;

  try {
    if (pdfBtn) pdfBtn.disabled = true;
    msgEl.className = '';
    msgEl.textContent = 'กำลังจัดรูปแบบและสร้างไฟล์ PDF...';
    msgEl.style.display = 'block';
    const pdfBlob = await withQuotationExportLayout(element, async imageMap => {
      if (typeof window.html2canvas !== 'function' || !window.jspdf?.jsPDF) {
        throw new Error('โหลดส่วนประกอบสำหรับสร้าง PDF ไม่ครบ');
      }
      const canvas = await renderQuotationCanvas(element, imageMap);
      return canvasToPdfBlob(canvas);
    });
    downloadBlob(pdfBlob, filename);

    msgEl.className = 'success';
    msgEl.innerHTML = iconText('check', 'PDF ดาวน์โหลดสำเร็จ');
    msgEl.style.display = 'block';
    setTimeout(() => msgEl.style.display = 'none', 3000);
  } catch (err) {
    console.error('สร้าง PDF ไม่สำเร็จ:', err);
    msgEl.className = 'error';
    msgEl.innerHTML = iconText('x', 'สร้างไฟล์ PDF ไม่สำเร็จ กรุณาลองใหม่');
    msgEl.style.display = 'block';
  } finally {
    if (pdfBtn) pdfBtn.disabled = false;
  }
}

// Generate Image
async function generateQuotationImage() {
  const customerName = document.getElementById('quotation-customer').value.trim();
  const msgEl = getQuotationExportMessage();
  const imageBtn = document.getElementById('quotation-image-btn');

  if (!window._quotationCalculated || !customerName) {
    msgEl.className = 'error';
    msgEl.innerHTML = iconText('x', 'กรุณากรอกข้อมูลและกดคำนวณก่อน');
    msgEl.style.display = 'block';
    return;
  }

  if (imageBtn) imageBtn.disabled = true;

  
  if (typeof window.html2canvas === 'undefined') {
    msgEl.className = 'error';
    msgEl.textContent = 'กำลังโหลดไลบรารี่รูปภาพ...';
    msgEl.style.display = 'block';
    try {
      await loadImageLibrary();
    } catch (err) {
      if (imageBtn) imageBtn.disabled = false;
      msgEl.className = 'error';
      msgEl.innerHTML = iconText('x', 'โหลดไลบรารี่รูปภาพไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ต');
      msgEl.style.display = 'block';
      return;
    }
  }
  
  const element = document.getElementById('quotation-preview');
  try {
    if (imageBtn) imageBtn.disabled = true;
    msgEl.className = '';
    msgEl.textContent = 'กำลังจัดรูปแบบและสร้างไฟล์รูปภาพ...';
    msgEl.style.display = 'block';
    const contentCanvas = await withQuotationExportLayout(element, imageMap => renderQuotationCanvas(element, imageMap));
    const canvas = canvasToA4Image(contentCanvas);
    const blob = await canvasToBlob(canvas, 'image/png');
    downloadBlob(blob, `quotation_${QE().sanitizeFilename(customerName)}_${Date.now()}.png`);

    msgEl.className = 'success';
    msgEl.innerHTML = iconText('check', 'รูปภาพดาวน์โหลดสำเร็จ');
    msgEl.style.display = 'block';
    setTimeout(() => msgEl.style.display = 'none', 3000);
  } catch (err) {
    console.error('สร้างรูปภาพไม่สำเร็จ:', err);
    msgEl.className = 'error';
    msgEl.innerHTML = iconText('x', 'สร้างไฟล์รูปภาพไม่สำเร็จ กรุณาลองใหม่');
    msgEl.style.display = 'block';
  } finally {
    if (imageBtn) imageBtn.disabled = false;
  }
}

async function copyQuotationSummary() {
  const msgEl = getQuotationExportMessage();
  if (!window._quotationCalculated || !window._quotationCopyPayload) {
    msgEl.className = 'error';
    msgEl.innerHTML = iconText('x', 'กรุณากรอกข้อมูลและกดคำนวณก่อน');
    msgEl.style.display = 'block';
    return;
  }
  const text = QE().buildCopySummaryText(window._quotationCopyPayload);
  try {
    await navigator.clipboard.writeText(text);
    msgEl.className = 'success';
    msgEl.innerHTML = iconText('check', 'คัดลอกสรุปแล้ว');
    msgEl.style.display = 'block';
    setTimeout(() => msgEl.style.display = 'none', 2500);
  } catch (err) {
    console.error('คัดลอกไม่สำเร็จ:', err);
    msgEl.className = 'error';
    msgEl.innerHTML = iconText('x', 'คัดลอกไม่สำเร็จ กรุณาลองใหม่');
    msgEl.style.display = 'block';
  }
}

function printQuotation() {
  const msgEl = getQuotationExportMessage();
  if (!window._quotationCalculated) {
    msgEl.className = 'error';
    msgEl.innerHTML = iconText('x', 'กรุณากรอกข้อมูลและกดคำนวณก่อน');
    msgEl.style.display = 'block';
    return;
  }
  switchQuotationMobileTab('preview');
  window.print();
}

// Reset form
function resetQuotationForm(options = {}) {
  const buildingData = Object.prototype.hasOwnProperty.call(options, 'buildingData')
    ? options.buildingData
    : (window.currentBuildingData || {});
  const calculationProfile = getBuildingInstallationProfile(buildingData);
  const baseInstallationCost = calculationProfile.equipment_cost
    + calculationProfile.odf_cost
    + calculationProfile.splice_cost;

  document.getElementById('quotation-customer').value = '';
  document.getElementById('quotation-cust-floor').value = '';
  document.getElementById('quotation-hwire').value = '';
  document.getElementById('quotation-shaft-times').value = '';
  document.getElementById('quotation-circuit-count').value = '';
  document.getElementById('quotation-ot-nights').value = '';
  document.getElementById('quotation-contract-years').value = '';
  document.getElementById('quotation-monthly-revenue').value = '';
  document.getElementById('quotation-annual-revenue').value = '';
  document.getElementById('quotation-remark').value = '';
  document.getElementById('quotation-wm-manual').value = '';
  const wmSelect = document.getElementById('quotation-wm-select');
  if (wmSelect) wmSelect.selectedIndex = 0;
  document.getElementById('quotation-cable-cost').textContent = '0 บาท';
  document.getElementById('quotation-equipment-cost').textContent = formatCurrency(calculationProfile.equipment_cost);
  document.getElementById('quotation-closure-cost').textContent = formatCurrency(calculationProfile.odf_cost);
  document.getElementById('quotation-splice-cost').textContent = formatCurrency(calculationProfile.splice_cost);
  document.getElementById('quotation-installation-subtotal').textContent = formatCurrency(baseInstallationCost);
  document.getElementById('quotation-building-fees').innerHTML = '';
  document.getElementById('quotation-revenue-share-summary').innerHTML = '';
  document.getElementById('quotation-total-label').textContent = 'ยอดรวมที่ต้องชำระ';
  document.getElementById('quotation-total-cost').textContent = formatCurrency(baseInstallationCost);
  document.getElementById('quotation-message').style.display = 'none';
  resetQuotationExportMessage();
  document.getElementById('quotation-distance-summary').style.display = 'none';
  document.getElementById('quotation-shaft-info').style.display = 'none';
  const permissionDurationText = formatPermissionDuration(buildingData?.duration);
  const permissionDurationBlock = document.getElementById('prev-permission-duration-block');
  document.getElementById('prev-customer-name').textContent = '-';
  document.getElementById('prev-building-name').textContent = buildingData?.name_th || buildingData?.name_eng || '-';
  document.getElementById('prev-permission-duration').textContent = permissionDurationText || '-';
  if (permissionDurationBlock) permissionDurationBlock.style.display = permissionDurationText ? '' : 'none';
  document.getElementById('prev-customer-floor').textContent = '-';
  document.getElementById('prev-wm-floor').textContent = '-';
  document.getElementById('prev-expiry-date').textContent = '-';
  document.getElementById('prev-quote-ref').textContent = '-';
  document.getElementById('prev-sales-person').textContent = '-';
  const remarkBlock = document.getElementById('prev-remark-block');
  if (remarkBlock) remarkBlock.hidden = true;
  document.getElementById('prev-remark').textContent = '-';
  document.getElementById('prev-distance').textContent = '-';
  document.getElementById('prev-cable-cost').textContent = '-';
  document.getElementById('prev-equipment-cost').textContent = formatCurrencyNumeric(calculationProfile.equipment_cost) + ' บาท';
  document.getElementById('prev-odf-cost').textContent = formatCurrencyNumeric(calculationProfile.odf_cost) + ' บาท';
  document.getElementById('prev-splice-cost').textContent = formatCurrencyNumeric(calculationProfile.splice_cost) + ' บาท';
  document.getElementById('prev-installation-subtotal').textContent = formatCurrencyNumeric(baseInstallationCost) + ' บาท';
  document.getElementById('prev-building-fees-table').innerHTML = '';
  document.getElementById('prev-cost-breakdown').innerHTML = '';
  document.getElementById('prev-revenue-share-summary').innerHTML = '';
  document.getElementById('prev-total-label').textContent = 'ยอดรวมที่ต้องชำระ';
  document.getElementById('prev-total').textContent = '-';
  window._quotationCalculated = false;
  window.currentQuotationSnapshot = null;
  window._quotationCopyPayload = null;
  window.currentBuildingData = buildingData || {};
  const staleBanner = document.getElementById('quotation-stale-banner');
  if (staleBanner) staleBanner.hidden = true;
  setQuotationExportEnabled(false);
  initializeQuotationMeta(buildingData || {});
  _updateQuotationDynamicInputs();
}

// Quotation button event listener
document.addEventListener('DOMContentLoaded', function() {
  const loginForm = document.getElementById('login-form');
  const logoutBtn = document.getElementById('logout-btn');
  const userManageBtn = document.getElementById('user-manage-btn');
  const exportCsvBtn = document.getElementById('export-csv-btn');
  const syncBoqDbBtn = document.getElementById('sync-boq-db-btn');
  const userAdminModal = document.getElementById('user-admin-modal');
  const userAdminCloseBtn = document.getElementById('user-admin-close-btn');
  const userAdminForm = document.getElementById('user-admin-form');
  const userFormResetBtn = document.getElementById('user-form-reset-btn');
  const userAdminList = document.getElementById('user-admin-list');
  const addBuildingBtn = document.getElementById('add-building-btn');
  const quotationModal = document.getElementById('quotation-modal');
  const buildingEditorModal = document.getElementById('building-editor-modal');
  const buildingEditorForm = document.getElementById('building-editor-form');
  const buildingEditorCloseBtn = document.getElementById('building-editor-close-btn');
  const buildingEditorCancelBtn = document.getElementById('building-editor-cancel-btn');
  const buildingEditorDeleteBtn = document.getElementById('building-editor-delete-btn');
  const otherFeeAddBtn = document.getElementById('other-fee-add-btn');
  document.addEventListener('keydown', trapDialogTabKey);
  applyFieldAriaLabels();

  (function initMobileTopbarActions(){
    const toggle = document.getElementById('mobile-actions-toggle');
    const menu = document.getElementById('topbar-actions');
    if (!toggle || !menu) return;

    function setOpen(open) {
      menu.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    toggle.addEventListener('click', function(e) {
      e.stopPropagation();
      setOpen(!menu.classList.contains('open'));
    });

    menu.addEventListener('click', function(e) {
      if (e.target.closest('button')) setTimeout(() => setOpen(false), 0);
    }, true);

    document.addEventListener('click', function(e) {
      if (!menu.contains(e.target) && e.target !== toggle) setOpen(false);
    });

    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') setOpen(false);
    });
  })();

  /* ---- Auth: Particle Animation ---- */
  (function initAuthParticles(){
    const canvas = document.getElementById('auth-particles');
    if (!canvas) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      canvas.hidden = true;
      return;
    }
    const ctx = canvas.getContext('2d');
    let particles = [];
    const COUNT = 60;
    const CONNECT_DIST = 120;
    function resize(){
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize);
    function createParticle(){
      return {
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        vx: (Math.random() - 0.5) * 0.4,
        vy: (Math.random() - 0.5) * 0.4,
        r: Math.random() * 1.8 + 0.6
      };
    }
    for (let i = 0; i < COUNT; i++) particles.push(createParticle());
    function draw(){
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < particles.length; i++){
        const p = particles[i];
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0) p.x = canvas.width;
        if (p.x > canvas.width) p.x = 0;
        if (p.y < 0) p.y = canvas.height;
        if (p.y > canvas.height) p.y = 0;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(96,165,250,' + (0.35 + p.r * 0.15) + ')';
        ctx.fill();
        for (let j = i + 1; j < particles.length; j++){
          const q = particles[j];
          const dx = p.x - q.x, dy = p.y - q.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < CONNECT_DIST){
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(q.x, q.y);
            ctx.strokeStyle = 'rgba(99,102,241,' + (0.12 * (1 - dist / CONNECT_DIST)) + ')';
            ctx.lineWidth = 0.6;
            ctx.stroke();
          }
        }
      }
      if (document.body.classList.contains('auth-locked')) requestAnimationFrame(draw);
    }
    requestAnimationFrame(draw);
  })();

  /* ---- Auth: 3D Tilt Effect ---- */
  (function initAuthTilt(){
    const card = document.querySelector('.auth-card');
    if (!card) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    let targetRx = 0, targetRy = 0, currentRx = 0, currentRy = 0;
    let angle = 0;
    card.style.animation = 'none';
    card.addEventListener('mousemove', function(e){
      const rect = card.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      targetRy = ((e.clientX - cx) / (rect.width / 2)) * 8;
      targetRx = -((e.clientY - cy) / (rect.height / 2)) * 8;
    });
    card.addEventListener('mouseleave', function(){
      targetRx = 0; targetRy = 0;
    });
    function animate(){
      currentRx += (targetRx - currentRx) * 0.12;
      currentRy += (targetRy - currentRy) * 0.12;
      angle = (angle + 0.8) % 360;
      const floatY = -6 * Math.sin(Date.now() / 1300);
      card.style.transform = 'translateY(' + floatY.toFixed(2) + 'px) rotateX(' + currentRx.toFixed(2) + 'deg) rotateY(' + currentRy.toFixed(2) + 'deg)';
      card.style.setProperty('--auth-angle', angle + 'deg');
      if (document.getElementById('auth-screen') && document.body.classList.contains('auth-locked')){
        requestAnimationFrame(animate);
      }
    }
    requestAnimationFrame(animate);
  })();

  /* ---- Auth: Show/Hide Password ---- */
  (function initPwToggle(){
    const btn = document.querySelector('.auth-toggle-pw');
    const pwInput = document.getElementById('login-password');
    if (!btn || !pwInput) return;
    const eyeOpen = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
    const eyeClosed = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/></svg>';
    btn.addEventListener('click', function(){
      const isPassword = pwInput.type === 'password';
      pwInput.type = isPassword ? 'text' : 'password';
      btn.innerHTML = isPassword ? eyeClosed : eyeOpen;
      btn.setAttribute('aria-label', isPassword ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน');
    });
  })();

  if (loginForm) {
    loginForm.addEventListener('submit', async function(e) {
      e.preventDefault();
      setBoxMessage('login-message', '');
      const email = document.getElementById('login-email')?.value;
      const password = document.getElementById('login-password')?.value;
      try {
        await loginWithPassword(email, password);
        loginForm.reset();
      } catch (err) {
        setBoxMessage('login-message', err.message || 'เข้าสู่ระบบไม่สำเร็จ');
      }
    });
  }

  if (logoutBtn) {
    logoutBtn.addEventListener('click', function() {
      setCurrentUser(null);
      document.getElementById('login-email')?.focus();
    });
  }

  if (userManageBtn) {
    userManageBtn.addEventListener('click', function() {
      if (!canManageUsers()) return;
      renderUserAdminList();
      userAdminModal?.classList.add('open');
      openDialogAccessibility(userAdminModal, userAdminForm?.elements['email']);
      rememberFormState(userAdminForm);
    });
  }

  if (exportCsvBtn) {
    exportCsvBtn.addEventListener('click', exportBuildingsCsv);
  }

  if (syncBoqDbBtn) {
    syncBoqDbBtn.addEventListener('click', event => syncBuildingBoqProfiles({
      skipConfirm: event.shiftKey,
      silent: event.shiftKey,
      refreshCostTypes: event.shiftKey
    }));
  }

  if (userAdminModal) {
    userAdminModal.addEventListener('click', function(e) {
      if (e.target === userAdminModal) e.preventDefault();
    });
  }
  if (userAdminCloseBtn) {
    userAdminCloseBtn.addEventListener('click', function() {
      closeUserAdminModal();
    });
  }
  if (userFormResetBtn) {
    userFormResetBtn.addEventListener('click', resetUserForm);
  }
  if (userAdminForm) {
    userAdminForm.addEventListener('submit', async function(e) {
      e.preventDefault();
      try {
        await saveUserFromForm(userAdminForm);
      } catch (err) {
        setBoxMessage('user-admin-message', err.message || 'บันทึกผู้ใช้ไม่สำเร็จ');
      }
    });
  }
  if (userAdminList) {
    userAdminList.addEventListener('click', async function(e) {
      const editBtn = e.target.closest('[data-user-edit]');
      const deleteBtn = e.target.closest('[data-user-delete]');
      try {
        if (editBtn) editUser(editBtn.dataset.userEdit);
        if (deleteBtn) await deleteUserAccount(deleteBtn.dataset.userDelete);
      } catch (err) {
        setBoxMessage('user-admin-message', err.message || 'จัดการผู้ใช้ไม่สำเร็จ');
      }
    });
  }
  
  if (addBuildingBtn) {
    addBuildingBtn.addEventListener('click', function() {
      openBuildingEditor(null);
    });
  }

  if (buildingEditorModal) {
    buildingEditorModal.addEventListener('click', function(e) {
      if (e.target === buildingEditorModal) e.preventDefault();
    });
  }

  if (buildingEditorCloseBtn) {
    buildingEditorCloseBtn.addEventListener('click', closeBuildingEditor);
  }
  if (buildingEditorCancelBtn) {
    buildingEditorCancelBtn.addEventListener('click', closeBuildingEditor);
  }
  if (buildingEditorDeleteBtn && buildingEditorForm) {
    buildingEditorDeleteBtn.addEventListener('click', function() {
      deleteBuildingFromForm(buildingEditorForm);
    });
  }
  if (otherFeeAddBtn) {
    otherFeeAddBtn.addEventListener('click', function() {
      addOtherFeeRow();
    });
  }

  if (buildingEditorForm) {
    buildingEditorForm.addEventListener('click', function(e) {
      const removeBtn = e.target.closest('.other-fee-remove');
      if (!removeBtn) return;
      removeBtn.closest('.other-fee-row')?.remove();
      clearBuildingEditorInvalidState(buildingEditorForm);
    });
    buildingEditorForm.addEventListener('submit', function(e) {
      e.preventDefault();
      saveBuildingFromForm(buildingEditorForm);
    });
    buildingEditorForm.addEventListener('input', function() {
      clearBuildingEditorInvalidState(buildingEditorForm);
    });
    buildingEditorForm.addEventListener('change', function(e) {
      if (e.target.matches('[name="other_fee_calculation_type"]')) {
        updateOtherFeeRowControls(e.target.closest('.other-fee-row'));
      }
      clearBuildingEditorInvalidState(buildingEditorForm);
    });
  }

  if (quotationModal) {
    quotationModal.addEventListener('click', function(e) {
      if (e.target === quotationModal) e.preventDefault();
    });
  }

  document.addEventListener('keydown', function(e) {
    if (e.key !== 'Escape') return;
    if (userAdminModal?.classList.contains('open')) {
      closeUserAdminModal();
    } else if (buildingEditorModal?.classList.contains('open')) {
      closeBuildingEditor();
    } else if (quotationModal?.classList.contains('open')) {
      closeQuotationModal();
    }
  });

  document.getElementById('quotation-calculate-btn')?.addEventListener('click', () => calculateQuotation());
  document.getElementById('quotation-reset-btn')?.addEventListener('click', () => {
    if (quotationStateChanged() && !confirm(UNSAVED_CHANGES_CONFIRM_MESSAGE)) return;
    resetQuotationForm();
    rememberQuotationState();
  });
  document.getElementById('quotation-close-btn')?.addEventListener('click', closeQuotationModal);
  document.getElementById('quotation-pdf-btn')?.addEventListener('click', generateQuotationPDF);
  document.getElementById('quotation-image-btn')?.addEventListener('click', generateQuotationImage);
  document.getElementById('quotation-print-btn')?.addEventListener('click', printQuotation);
  document.getElementById('quotation-copy-btn')?.addEventListener('click', copyQuotationSummary);
  document.getElementById('quotation-copy-preview-btn')?.addEventListener('click', copyQuotationSummary);
  document.querySelectorAll('.quotation-mobile-tab').forEach(btn => {
    btn.addEventListener('click', () => switchQuotationMobileTab(btn.dataset.quotationTab || 'form'));
  });

  QUOTATION_STATE_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', onQuotationInputChanged);
    el.addEventListener('change', onQuotationInputChanged);
  });
  
  const quotationInputChain = [
    'quotation-customer',
    'quotation-cust-floor',
    () => {
      const wmGroup = document.getElementById('quotation-wm-group');
      return wmGroup && wmGroup.style.display !== 'none'
        ? 'quotation-wm-select'
        : 'quotation-wm-manual';
    },
    'quotation-hwire',
    'quotation-shaft-times',
    'quotation-circuit-count',
    'quotation-ot-nights',
    'quotation-contract-years',
    'quotation-monthly-revenue',
    'quotation-annual-revenue',
    'quotation-remark'
  ];
  const focusNextQuotationField = (fromId, toRef) => {
    const el = document.getElementById(fromId);
    if (!el) return;
    el.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || e.shiftKey) return;
      if (el.tagName === 'TEXTAREA') return;
      e.preventDefault();
      const toId = typeof toRef === 'function' ? toRef() : toRef;
      if (!toId) {
        calculateQuotation();
        return;
      }
      const target = document.getElementById(toId);
      const group = target?.closest('.quotation-form-group, .quotation-permission-panel, .quotation-revenue-panel');
      const hiddenGroup = group && group.style.display === 'none';
      if (!target || hiddenGroup) {
        const idx = quotationInputChain.findIndex(item => item === fromId || (typeof item === 'function' && item() === fromId));
        for (let i = idx + 1; i < quotationInputChain.length; i += 1) {
          const nextRef = quotationInputChain[i];
          const nextId = typeof nextRef === 'function' ? nextRef() : nextRef;
          const nextEl = document.getElementById(nextId);
          const nextGroup = nextEl?.closest('.quotation-form-group, .quotation-permission-panel, .quotation-revenue-panel');
          if (nextEl && nextGroup?.style.display !== 'none') {
            nextEl.focus();
            return;
          }
        }
        calculateQuotation();
        return;
      }
      target.focus();
    });
  };
  for (let i = 0; i < quotationInputChain.length; i += 1) {
    const fromRef = quotationInputChain[i];
    const fromId = typeof fromRef === 'function' ? fromRef() : fromRef;
    const toRef = quotationInputChain[i + 1] ?? null;
    focusNextQuotationField(fromId, toRef);
  }
});
