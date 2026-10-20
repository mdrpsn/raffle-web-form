// Runs backend/Code.gs outside Google against an in-memory fake of the Apps Script services it uses.
// Usage: node tests/backend.test.js        (no dependencies; needs Node 18+)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exitCode = 1; } else console.log('ok  ', m); };

// ---------- fake Google services ----------
class FakeSheet {
  constructor(name) { this.name = name; this.rows = []; }
  getLastRow() { return this.rows.length; }
  getDataRange() { const rows = this.rows; return { getValues: () => rows.map(r => r.slice()) }; }
  getRange(r, c, nr = 1, nc = 1) {
    const sh = this;
    return {
      setValues(v) { v.forEach((row, i) => row.forEach((x, j) => { (sh.rows[r - 1 + i] = sh.rows[r - 1 + i] || [])[c - 1 + j] = x; })); return this; },
      setValue(x) { (sh.rows[r - 1] = sh.rows[r - 1] || [])[c - 1] = x; return this; },
      getValue() { return (sh.rows[r - 1] || [])[c - 1]; },
      setNumberFormat() { return this; },
      setFontWeight() { return this; },
      getValues() { const out = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) row.push((sh.rows[r - 1 + i] || [])[c - 1 + j]); out.push(row); } return out; },
    };
  }
  appendRow(row) { this.rows.push(row); }
  deleteRow(n) { this.rows.splice(n - 1, 1); }
}

function loadBackend(codePath) {
  let now = Date.parse('2026-10-20T00:00:00Z');
  const sheets = {};
  const props = {};
  const ss = {
    getSheetByName: n => sheets[n] || null,
    insertSheet: n => (sheets[n] = new FakeSheet(n)),
  };
  const out = (text) => ({ text, setMimeType() { return this; } });
  class FakeDate extends Date { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } }
  const ctx = {
    console, Date: FakeDate, Math, JSON, String, Number, Object, Array, Error, parseInt, parseFloat,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k], setProperty: (k, v) => { props[k] = v; } }) },
    ContentService: { createTextOutput: out, MimeType: { JSON: 'json' } },
    Utilities: {
      getUuid: () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, () => ((Math.random() * 16) | 0).toString(16)),
      sleep() {}, base64Decode: s => Buffer.from(s, 'base64'), newBlob: b => b,
    },
    DriveApp: { createFolder: () => ({ getId: () => 'F1' }), getFolderById: () => ({ createFile: () => ({ getUrl: () => 'https://drive.example/proof' }) }) },
    Logger: { log() {} },
    ScriptApp: {},
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(codePath, 'utf8'), ctx);
  ctx.setup();
  return {
    call: (action, payload = {}) => JSON.parse(vm.runInContext('doPost', ctx)({ postData: { contents: JSON.stringify({ action, pin: props.ADMIN_PIN, ...payload }) } }).text),
    advance: minutes => { now += minutes * 60000; },
    slot: n => sheets.Slots.rows[n][1],
    orderRows: () => sheets.Orders.rows.length - 1,
  };
}

const PNG = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
const who = (n, mobile) => ({ name: 'Person ' + n, mobile, facebook: 'fb ' + n });

const b = loadBackend(path.join(__dirname, '..', 'backend', 'Code.gs'));

// 1. Unchanged rule: an unpaid hold expires and the slot opens again.
let a = b.call('reserve', { ...who('A', '09170000001'), slots: [10], token: 'Ta' });
assert(a.ok && b.slot(10) === 'PENDING', 'reserve holds slot 10');
b.advance(31);
b.call('board');
assert(b.slot(10) === 'AVAILABLE', 'an unclaimed hold expires after holdMinutes and frees the slot');

// 2. The reported bug: customer paid but could not upload the screenshot.
a = b.call('reserve', { ...who('A', '09170000001'), slots: [27], token: 'Tb' });
const claim = b.call('claim', { orderId: a.orderId });
assert(claim.ok && claim.status === 'CLAIMED', 'customer can say "I have paid" before uploading proof');
b.advance(31);
const stolen = b.call('reserve', { ...who('B', '09170000002'), slots: [27], token: 'Tc' });
assert(!stolen.ok && /taken/.test(stolen.error), 'after holdMinutes, a claimed slot is NOT given to someone else');
assert(b.slot(27) === 'PENDING', 'claimed slot stays held');

// 3. Proof can still be uploaded after the original hold would have expired.
const proof = b.call('proof', { orderId: a.orderId, mime: 'image/jpeg', data: PNG });
assert(proof.ok && proof.status === 'SUBMITTED', 'late proof upload accepted for a claimed order');

// 4. A claim is not a permanent hold: it expires after claimHoldMinutes with no proof.
const c = b.call('reserve', { ...who('C', '09170000003'), slots: [40], token: 'Td' });
b.call('claim', { orderId: c.orderId });
b.advance(60 * 24 - 1);
b.call('board');
assert(b.slot(40) === 'PENDING', 'claimed hold still there just before the claim window ends');
b.advance(2);
b.call('board');
assert(b.slot(40) === 'AVAILABLE', 'claimed hold with no proof is released after the claim window');

// 5. Admin can approve a claimed order after checking the wallet, with or without proof.
const d = b.call('reserve', { ...who('D', '09170000004'), slots: [50], token: 'Te' });
b.call('claim', { orderId: d.orderId });
const list = b.call('adminList');
assert(list.orders.some(o => o.orderId === d.orderId && o.status === 'CLAIMED'), 'claimed order shows in admin list');
assert(b.call('approve', { orderId: d.orderId }).ok && b.slot(50) === 'PAID', 'admin can approve a claimed order');

// 6. A claim is not a way around the 3-open-orders-per-mobile limit.
const m = '09170000009';
for (const n of [61, 62, 63]) { const r = b.call('reserve', { ...who('M', m), slots: [n], token: 'Tm' + n }); b.call('claim', { orderId: r.orderId }); }
const fourth = b.call('reserve', { ...who('M', m), slots: [64], token: 'Tm64' });
assert(!fourth.ok && /3 unpaid/.test(fourth.error), 'claimed orders count toward the 3-open limit');

// 7. Claiming twice, or after proof, is harmless.
const e = b.call('reserve', { ...who('E', '09170000005'), slots: [70], token: 'Tf' });
b.call('proof', { orderId: e.orderId, mime: 'image/jpeg', data: PNG });
const late = b.call('claim', { orderId: e.orderId });
assert(late.ok && late.status === 'SUBMITTED', 'claim after proof leaves the order SUBMITTED');
const f = b.call('reserve', { ...who('F', '09170000006'), slots: [71], token: 'Tg' });
b.call('claim', { orderId: f.orderId });
assert(b.call('claim', { orderId: f.orderId }).status === 'CLAIMED', 'claiming twice is a no-op');

// 8. Claiming an expired reservation fails clearly.
const g = b.call('reserve', { ...who('G', '09170000007'), slots: [80], token: 'Th' });
b.advance(31);
const gone = b.call('claim', { orderId: g.orderId });
assert(!gone.ok && /expired/.test(gone.error), 'claim after the hold expired is refused with a clear message');
