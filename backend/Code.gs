/**
 * Raffle slot backend — Google Apps Script bound to a Google Sheet.
 * Run setup() once from the editor, then Deploy > Web app (see ../README.md).
 *
 * Slot lifecycle:  AVAILABLE -> PENDING (reserved) -> PAID (secured)
 * Order lifecycle: PENDING -> SUBMITTED (proof uploaded) -> PAID
 *                  PENDING -> EXPIRED (no proof within holdMinutes) | REJECTED | RELEASED
 */

var ORDER_COLS = ['OrderId', 'CreatedAt', 'Name', 'Mobile', 'Facebook', 'Slots', 'Amount',
  'Status', 'ExpiresAt', 'ProofUrl', 'ProofAt', 'PaidAt', 'Note'];
var OC = {}; ORDER_COLS.forEach(function (c, i) { OC[c] = i; });

var DEFAULTS = [
  ['clubName', 'Got Cha Dink Club'],
  ['raffleName', 'Kamito Alpha X Her Purple'],
  ['prize1', '1st Prize: Kamito Alpha X Her Purple'],
  ['prize2', '2nd Prize: Free Open Play + edge guard + grip tape'],
  ['prize3', '3rd Prize: Free Open Play'],
  ['price', 150],
  ['totalSlots', 100],
  ['holdMinutes', 30],
  ['maxSlotsPerOrder', 20],
  ['status', 'OPEN'],
  ['paymentInstructions', 'GCash: 09XX XXX XXXX (Account Name)\nMaya: 09XX XXX XXXX (Account Name)\nGoTyme: XXXX XXXX XXXX'],
];

// ---------- one-time setup (run from the editor) ----------

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var cfg = sheet_('Config', ['Key', 'Value']);
  if (cfg.getLastRow() < 2) cfg.getRange(2, 1, DEFAULTS.length, 2).setValues(DEFAULTS);
  // Text format on Name/Mobile/Facebook: keeps leading zeros and stops typed text from running as a formula.
  sheet_('Orders', ORDER_COLS).getRange('C:E').setNumberFormat('@');
  var slots = sheet_('Slots', ['Slot', 'Status', 'OrderId']);
  var total = Number(getConfig_().totalSlots);
  if (slots.getLastRow() < 2) {
    var rows = [];
    for (var n = 1; n <= total; n++) rows.push([n, 'AVAILABLE', '']);
    slots.getRange(2, 1, rows.length, 3).setValues(rows);
  }
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('ADMIN_PIN')) {
    props.setProperty('ADMIN_PIN', String(Math.floor(100000 + Math.random() * 900000)));
  }
  if (!props.getProperty('PROOF_FOLDER_ID')) {
    props.setProperty('PROOF_FOLDER_ID', DriveApp.createFolder('Raffle payment proofs').getId());
  }
  Logger.log('Setup done. Admin PIN = ' + props.getProperty('ADMIN_PIN') +
    '  (change it: Project Settings > Script properties > ADMIN_PIN)');
}

function sheet_(name, header) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  return sh;
}

// ---------- HTTP entry points ----------

function doGet(e) {
  var p = (e && e.parameter) || {};
  return run_(p.action || 'board', p);
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'Bad request' }); }
  return run_(body.action, body);
}

// Looked up at call time (not load time) so a half-pasted file still lets setup() run.
function publicActions_() { return { board: board_, order: orderStatus_, reserve: reserve_, proof: proof_ }; }
function adminActions_() { return { adminList: adminList_, approve: approve_, reject: reject_, release: release_, freeze: freeze_, draw: draw_ }; }

function run_(action, p) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    return json_({ ok: false, error: 'Server busy, please try again.' });
  }
  try {
    var pub = publicActions_(), adm = adminActions_();
    if (pub[action]) return json_(pub[action](p));
    if (adm[action]) {
      if (!pinOk_(p.pin)) { Utilities.sleep(700); return json_({ ok: false, error: 'Wrong PIN' }); }
      return json_(adm[action](p));
    }
    return json_({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function pinOk_(pin) {
  var real = PropertiesService.getScriptProperties().getProperty('ADMIN_PIN');
  return !!real && String(pin || '') === real;
}

// ---------- data access ----------

function getConfig_() {
  var rows = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Config').getDataRange().getValues();
  var c = {};
  rows.slice(1).forEach(function (r) { if (r[0] !== '') c[r[0]] = r[1]; });
  return c;
}

function setConfig_(key, value) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Config');
  var rows = sh.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (rows[i][0] === key) { sh.getRange(i + 1, 2).setValue(value); return; }
  }
  sh.appendRow([key, value]);
}

function slotsSheet_() { return SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Slots'); }
function ordersSheet_() { return SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Orders'); }

function readOrders_() {
  var vals = ordersSheet_().getDataRange().getValues().slice(1);
  return vals.map(function (r, i) {
    var o = { row: i + 2 };
    ORDER_COLS.forEach(function (c, j) { o[c] = r[j]; });
    o.slotList = String(o.Slots).split(',').map(Number).filter(Boolean);
    return o;
  }).filter(function (o) { return o.OrderId; });
}

function findOrder_(id) {
  var list = readOrders_();
  for (var i = 0; i < list.length; i++) if (list[i].OrderId === String(id)) return list[i];
  return null;
}

function setOrder_(o, fields) {
  var sh = ordersSheet_();
  Object.keys(fields).forEach(function (k) {
    o[k] = fields[k];
    sh.getRange(o.row, OC[k] + 1).setValue(fields[k]);
  });
}

function setSlots_(slotList, status, orderId) {
  var sh = slotsSheet_();
  slotList.forEach(function (n) { sh.getRange(n + 1, 2, 1, 2).setValues([[status, orderId || '']]); });
}

function readSlots_() {
  return slotsSheet_().getDataRange().getValues().slice(1).map(function (r) {
    return { n: Number(r[0]), status: r[1], orderId: r[2] };
  });
}

/** Free slots held by reservations that never uploaded proof in time. Call under lock. */
function sweepExpired_() {
  var now = Date.now();
  readOrders_().forEach(function (o) {
    if (o.Status === 'PENDING' && Date.parse(o.ExpiresAt) < now) {
      setSlots_(o.slotList, 'AVAILABLE', '');
      setOrder_(o, { Status: 'EXPIRED' });
    }
  });
}

// ---------- helpers ----------

function clean_(s, max) {
  return String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

function publicName_(full) {
  var parts = String(full).trim().split(/\s+/);
  return parts.length > 1 ? parts[0] + ' ' + parts[parts.length - 1][0].toUpperCase() + '.' : parts[0];
}

function normMobile_(m) {
  var d = String(m || '').replace(/[\s\-()]/g, '');
  if (/^\+639\d{9}$/.test(d)) return '0' + d.slice(3);
  if (/^639\d{9}$/.test(d)) return '0' + d.slice(2);
  if (/^09\d{9}$/.test(d)) return d;
  return null;
}

// ---------- public actions ----------

function board_() {
  sweepExpired_();
  var cfg = getConfig_();
  var orders = readOrders_();
  var byId = {};
  orders.forEach(function (o) { byId[o.OrderId] = o; });
  var slots = readSlots_().map(function (s) {
    var o = s.orderId && byId[s.orderId];
    return { n: s.n, status: s.status, label: o ? publicName_(o.Name) : '' };
  });
  return {
    ok: true,
    raffle: {
      clubName: cfg.clubName, name: cfg.raffleName, price: Number(cfg.price), total: Number(cfg.totalSlots),
      status: cfg.status, prizes: [cfg.prize1, cfg.prize2, cfg.prize3].filter(Boolean),
      holdMinutes: Number(cfg.holdMinutes), maxSlotsPerOrder: Number(cfg.maxSlotsPerOrder),
    },
    slots: slots,
    winners: readWinners_(),
  };
}

function reserve_(p) {
  sweepExpired_();
  var cfg = getConfig_();
  if (cfg.status !== 'OPEN') throw new Error('Registration is closed.');

  var name = clean_(p.name, 60), fb = clean_(p.facebook, 80), mobile = normMobile_(p.mobile);
  if (name.length < 2) throw new Error('Please enter your name.');
  if (!mobile) throw new Error('Enter a valid PH mobile number (09XXXXXXXXX).');
  if (fb.length < 2) throw new Error('Please enter your Facebook name.');

  var want = (p.slots || []).map(Number);
  var uniq = want.filter(function (n, i) { return want.indexOf(n) === i; });
  var total = Number(cfg.totalSlots);
  if (!uniq.length) throw new Error('Pick at least one number.');
  if (uniq.length > Number(cfg.maxSlotsPerOrder)) throw new Error('Maximum ' + cfg.maxSlotsPerOrder + ' slots per order.');
  uniq.forEach(function (n) { if (n % 1 || n < 1 || n > total) throw new Error('Invalid slot number.'); });

  var open = readOrders_().filter(function (o) {
    return o.Mobile === mobile && (o.Status === 'PENDING' || o.Status === 'SUBMITTED');
  });
  if (open.length >= 3) throw new Error('You already have 3 unpaid reservations. Please pay or wait for them to expire.');

  var slots = readSlots_();
  var taken = uniq.filter(function (n) { return slots[n - 1].status !== 'AVAILABLE'; });
  if (taken.length) {
    return { ok: false, error: 'Sorry, just taken: #' + taken.join(', #') + '. Please pick others.', taken: taken };
  }

  // Leading letter: an all-digit id (or 1234E5678) would be stored by Sheets as a number and never match on lookup.
  var id = 'R' + Utilities.getUuid().replace(/-/g, '').slice(0, 9).toUpperCase();
  uniq.sort(function (a, b) { return a - b; });
  var amount = uniq.length * Number(cfg.price);
  var expires = new Date(Date.now() + Number(cfg.holdMinutes) * 60000).toISOString();
  var sh = ordersSheet_(), row = sh.getLastRow() + 1;
  // Set text format on this row's Name/Mobile/Facebook before writing, or Sheets turns 0917... into the number 917...
  sh.getRange(row, OC.Name + 1, 1, 3).setNumberFormat('@');
  sh.getRange(row, 1, 1, ORDER_COLS.length).setValues([[id, new Date().toISOString(), name, mobile, fb, uniq.join(','), amount,
    'PENDING', expires, '', '', '', '']]);
  setSlots_(uniq, 'PENDING', id);
  return { ok: true, orderId: id, slots: uniq, amount: amount, expiresAt: expires,
    paymentInstructions: cfg.paymentInstructions };
}

function proof_(p) {
  sweepExpired_();
  var o = findOrder_(p.orderId);
  if (!o) throw new Error('Order not found.');
  if (o.Status === 'EXPIRED') throw new Error('This reservation expired. Please pick your numbers again.');
  if (o.Status !== 'PENDING' && o.Status !== 'SUBMITTED') throw new Error('This order is already ' + o.Status + '.');

  var mime = String(p.mime || '');
  if (['image/jpeg', 'image/png', 'image/webp'].indexOf(mime) < 0) throw new Error('Upload a JPG, PNG or WEBP image.');
  var bytes = Utilities.base64Decode(String(p.data || ''));
  if (bytes.length > 4 * 1024 * 1024) throw new Error('Image too large (max 4 MB).');

  var folder = DriveApp.getFolderById(PropertiesService.getScriptProperties().getProperty('PROOF_FOLDER_ID'));
  var ext = mime.split('/')[1].replace('jpeg', 'jpg');
  var file = folder.createFile(Utilities.newBlob(bytes, mime, o.OrderId + '-' + Date.now() + '.' + ext));
  setOrder_(o, { Status: 'SUBMITTED', ProofUrl: file.getUrl(), ProofAt: new Date().toISOString() });
  return { ok: true, status: 'SUBMITTED' };
}

function orderStatus_(p) {
  sweepExpired_();
  var o = findOrder_(p.orderId);
  if (!o) throw new Error('Order not found.');
  var cfg = getConfig_();
  return { ok: true, order: {
    orderId: o.OrderId, name: publicName_(o.Name), slots: o.slotList, amount: o.Amount, status: o.Status,
    expiresAt: o.ExpiresAt, raffleName: cfg.raffleName, paymentInstructions: cfg.paymentInstructions,
  } };
}

// ---------- admin actions ----------

function adminList_() {
  sweepExpired_();
  var cfg = getConfig_();
  var slots = readSlots_();
  var count = function (s) { return slots.filter(function (x) { return x.status === s; }).length; };
  var price = Number(cfg.price);
  var orders = readOrders_().reverse().map(function (o) {
    return { orderId: o.OrderId, createdAt: o.CreatedAt, name: String(o.Name),
      mobile: String(o.Mobile), facebook: String(o.Facebook),
      slots: o.slotList, amount: o.Amount, status: o.Status, expiresAt: o.ExpiresAt, proofUrl: o.ProofUrl,
      raffleName: cfg.raffleName };
  });
  return { ok: true, raffleStatus: cfg.status, frozen: !!SpreadsheetApp.getActiveSpreadsheet().getSheetByName('FinalEntries'),
    stats: { total: slots.length, paid: count('PAID'), pending: count('PENDING'), available: count('AVAILABLE'),
      collected: count('PAID') * price, potential: (count('AVAILABLE') + count('PENDING')) * price },
    orders: orders, winners: readWinners_(), prizes: [cfg.prize1, cfg.prize2, cfg.prize3].filter(Boolean) };
}

function approve_(p) {
  sweepExpired_();
  var o = findOrder_(p.orderId);
  if (!o) throw new Error('Order not found.');
  if (o.Status === 'PAID') return { ok: true };
  if (['PENDING', 'SUBMITTED', 'EXPIRED'].indexOf(o.Status) < 0) throw new Error('Cannot approve an order that is ' + o.Status + '.');
  if (o.Status === 'EXPIRED') { // late payment: only OK if nobody else took the numbers
    var slots = readSlots_();
    var gone = o.slotList.filter(function (n) { return slots[n - 1].status !== 'AVAILABLE'; });
    if (gone.length) throw new Error('Slots #' + gone.join(', #') + ' were taken by someone else after expiry.');
  }
  setSlots_(o.slotList, 'PAID', o.OrderId);
  setOrder_(o, { Status: 'PAID', PaidAt: new Date().toISOString() });
  return { ok: true };
}

function reject_(p) { return freeOrder_(p.orderId, 'REJECTED', ['PENDING', 'SUBMITTED']); }
function release_(p) { return freeOrder_(p.orderId, 'RELEASED', ['PAID']); }

function freeOrder_(id, newStatus, allowed) {
  var o = findOrder_(id);
  if (!o) throw new Error('Order not found.');
  if (allowed.indexOf(o.Status) < 0) throw new Error('Cannot do that to an order that is ' + o.Status + '.');
  if (SpreadsheetApp.getActiveSpreadsheet().getSheetByName('FinalEntries')) throw new Error('Entries are frozen.');
  setSlots_(o.slotList, 'AVAILABLE', '');
  setOrder_(o, { Status: newStatus });
  return { ok: true };
}

// ---------- freeze + draw ----------

function freeze_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName('FinalEntries')) throw new Error('Already frozen.');
  var byId = {};
  readOrders_().forEach(function (o) { byId[o.OrderId] = o; });
  var rows = readSlots_().filter(function (s) { return s.status === 'PAID'; }).map(function (s) {
    return [s.n, String(byId[s.orderId].Name), s.orderId];
  });
  if (!rows.length) throw new Error('No paid entries to freeze.');
  // Release unpaid holds so nothing changes after the freeze.
  readOrders_().forEach(function (o) {
    if (o.Status === 'PENDING' || o.Status === 'SUBMITTED') {
      setSlots_(o.slotList, 'AVAILABLE', ''); setOrder_(o, { Status: 'REJECTED', Note: 'Not paid at freeze' });
    }
  });
  var sh = sheet_('FinalEntries', ['Slot', 'Name', 'OrderId']);
  sh.getRange(2, 1, rows.length, 3).setValues(rows);
  sheet_('Draws', ['Prize', 'Slot', 'Name', 'DrawnAt']);
  setConfig_('status', 'CLOSED');
  return { ok: true, entries: rows.length };
}

function readWinners_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Draws');
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues().map(function (r) {
    return { prize: r[0], slot: r[1], name: publicName_(r[2]) };
  });
}

function draw_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var fe = ss.getSheetByName('FinalEntries'), dr = ss.getSheetByName('Draws');
  if (!fe) throw new Error('Freeze the entries first.');
  var cfg = getConfig_();
  var prizes = [cfg.prize1, cfg.prize2, cfg.prize3].filter(Boolean);
  var done = dr.getLastRow() - 1;
  if (done >= prizes.length) throw new Error('All prizes have been drawn.');
  var won = {};
  if (done > 0) dr.getRange(2, 2, done, 1).getValues().forEach(function (r) { won[r[0]] = true; });
  var pool = fe.getRange(2, 1, fe.getLastRow() - 1, 3).getValues().filter(function (r) { return !won[r[0]]; });
  if (!pool.length) throw new Error('No entries left to draw.');
  var pick = pool[Math.floor(Math.random() * pool.length)];
  dr.appendRow([prizes[done], pick[0], pick[1], new Date().toISOString()]);
  return { ok: true, prize: prizes[done], slot: pick[0], name: pick[1], remaining: pool.length - 1 };
}
