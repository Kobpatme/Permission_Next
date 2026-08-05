/* eslint-disable no-unused-vars */
/**
 * Quotation calculation helpers — floor parsing, metadata, export utilities.
 * Loaded before app.js; exposed as window.QuotationEngine.
 */
(function initQuotationEngine(global) {
  const FLOOR_GROUND_ALIASES = new Set(['G', 'GF', 'M', 'MEZZ', 'MEZZANINE', 'GROUND', 'LOBBY']);

  function parseFloorInput(raw) {
    const cleaned = String(raw ?? '').trim().replace(/^ชั้น\s*/i, '').toUpperCase();
    if (!cleaned) return null;

    if (FLOOR_GROUND_ALIASES.has(cleaned)) {
      return { numeric: 0, label: 'G' };
    }

    const basementMatch = cleaned.match(/^B(\d+)$/);
    if (basementMatch) {
      const level = Number(basementMatch[1]);
      return { numeric: -level, label: `B${level}` };
    }

    const numericMatch = cleaned.match(/^(\d+)$/);
    if (numericMatch) {
      const level = Number(numericMatch[1]);
      return { numeric: level, label: String(level) };
    }

    return null;
  }

  function formatFloorLabel(numeric, fallback = '-') {
    if (numeric === null || numeric === undefined || Number.isNaN(numeric)) return fallback;
    if (numeric === 0) return 'G';
    if (numeric < 0) return `B${Math.abs(numeric)}`;
    return String(numeric);
  }

  function parseWmFloors(value) {
    const raw = String(value ?? '').trim();
    if (!raw || ['no', 'null', 'none', '-'].includes(raw.toLowerCase())) return [];

    const tokens = raw
      .split(/[,/|]|\s+ชั้น\s*|\s+และ\s+/)
      .map(part => part.trim())
      .filter(Boolean);

    const floors = [];
    const seen = new Set();

    const pushFloor = parsed => {
      if (!parsed || seen.has(parsed.numeric)) return;
      seen.add(parsed.numeric);
      floors.push(parsed);
    };

    tokens.forEach(token => pushFloor(parseFloorInput(token)));

    if (!floors.length) {
      [...raw.matchAll(/\bB(\d+)\b/gi)].forEach(match => pushFloor(parseFloorInput(`B${match[1]}`)));
      [...raw.matchAll(/\b(\d+)\b/g)].forEach(match => pushFloor(parseFloorInput(match[1])));
      if (/\bG\b|\bGF\b|\bชั้น\s*G\b/i.test(raw)) pushFloor(parseFloorInput('G'));
    }

    return floors.sort((a, b) => a.numeric - b.numeric);
  }

  function countVerticalFloors(wmNumeric, custNumeric) {
    return Math.abs(custNumeric - wmNumeric) + 1;
  }

  function formatThaiDate(date, { buddhist = true } = {}) {
    const d = date instanceof Date ? date : new Date(date);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear() + (buddhist ? 543 : 0);
    return `${day}/${month}/${year}`;
  }

  function generateQuotationRef(buildingId) {
    const now = new Date();
    const ymd = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0')
    ].join('');
    const hour = String(now.getHours()).padStart(2, '0');
    const minute = String(now.getMinutes()).padStart(2, '0');
    const buildingPart = String(buildingId ?? '0000').replace(/\D/g, '').slice(-4).padStart(4, '0');
    return `PN-${ymd}-${hour}${minute}-${buildingPart}`;
  }

  function buildQuotationDates(issueDate = new Date(), validDays = 7) {
    const issued = issueDate instanceof Date ? issueDate : new Date(issueDate);
    const expires = new Date(issued);
    expires.setDate(expires.getDate() + validDays);
    return {
      issued,
      expires,
      issuedText: formatThaiDate(issued),
      expiresText: formatThaiDate(expires),
      validDays
    };
  }

  function sanitizeFilename(name, fallback = 'quotation') {
    const ascii = String(name || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\w.-]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 60);
    return ascii || fallback;
  }

  function checkHorizontalDistance(hwire, maxHorizontal) {
    const value = Number(hwire);
    const max = Number(maxHorizontal);
    if (!Number.isFinite(value) || value < 0) {
      return { level: 'error', message: 'ระยะ Horizontal ต้องไม่ติดลบ' };
    }
    if (Number.isFinite(max) && max > 0 && value > max) {
      return {
        level: 'warning',
        message: `เกิน Max H-Wire ของอาคาร (${formatNumber(max)} ม.) — ควรยืนยันกับทีม Permission`
      };
    }
    return { level: 'ok', message: '' };
  }

  function formatNumber(value) {
    return Number(value).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function buildCopySummaryText({
    quoteRef,
    customerName,
    buildingName,
    wmFloorLabel,
    custFloorLabel,
    totalCostText,
    revenueMonthlyText,
    issuedText,
    expiresText,
    salesPerson,
    remark
  }) {
    const lines = [
      `ใบประเมินราคาเบื้องต้น ${quoteRef || ''}`.trim(),
      `ลูกค้า: ${customerName || '-'}`,
      `อาคาร: ${buildingName || '-'}`,
      `ชั้นลูกค้า: ${custFloorLabel || '-'} | ชั้น WM: ${wmFloorLabel || '-'}`,
      `ยอดเริ่มต้น: ${totalCostText || '-'}`,
      revenueMonthlyText ? `ค่าใช้จ่ายต่อเนื่องโดยประมาณ: ${revenueMonthlyText}` : '',
      `วันที่: ${issuedText || '-'} | หมดอายุ: ${expiresText || '-'}`,
      salesPerson ? `ผู้เสนอราคา: ${salesPerson}` : '',
      remark ? `หมายเหตุ: ${remark}` : '',
      '',
      '— ใบประเมินราคาเบื้องต้น ไม่ใช่ใบเสนอราคาสุดท้าย —'
    ];
    return lines.filter(Boolean).join('\n');
  }

  global.QuotationEngine = {
    parseFloorInput,
    formatFloorLabel,
    parseWmFloors,
    countVerticalFloors,
    formatThaiDate,
    generateQuotationRef,
    buildQuotationDates,
    sanitizeFilename,
    checkHorizontalDistance,
    buildCopySummaryText
  };
})(window);
