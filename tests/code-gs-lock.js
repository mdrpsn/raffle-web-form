// Runs backend/Code.gs outside Google with stubbed Apps Script services and checks run_()'s PIN/lock ordering.
// Usage: node tests/code-gs-lock.js  (no install needed)
const vm = require('vm'), fs = require('fs');
const log = [];
const ctx = {
  Utilities: { sleep: ms => log.push('sleep'), getUuid: () => 'x' },
  LockService: { getScriptLock: () => ({ waitLock: () => log.push('lock'), releaseLock: () => log.push('unlock') }) },
  CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {} }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => k === 'ADMIN_PIN' ? '654321' : null }) },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ t, setMimeType() { return this; }, getContent() { return this.t; } }) },
  console,
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(require('path').join(__dirname, '..', 'backend', 'Code.gs'), 'utf8'), ctx);
// Replace the sheet-touching actions with markers; run_/pinOk_/lock logic stays the real code.
vm.runInContext(`
  publicActions_ = function () { return { board: function () { log.push('board'); return { ok: true }; }, reserve: function () { log.push('reserve'); return { ok: true }; } }; };
  adminActions_  = function () { return { approve: function () { log.push('approve'); return { ok: true }; } }; };
`, Object.assign(ctx, { log }));
const run = (a, p) => { log.length = 0; const r = JSON.parse(ctx.run_(a, p).getContent()); return { r, log: log.join(',') }; };
let fail = 0;
const check = (name, cond, got) => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : '  -> ' + JSON.stringify(got))); if (!cond) fail = 1; };

let x = run('approve', { pin: 'wrong' });
check('wrong PIN is refused', x.r.ok === false && x.r.error === 'Wrong PIN', x);
check('wrong PIN never takes the lock', !x.log.includes('lock'), x);
check('wrong PIN is slowed down (outside the lock)', x.log === 'sleep', x);
x = run('approve', {});
check('missing PIN is refused without the lock', x.r.error === 'Wrong PIN' && !x.log.includes('lock'), x);
x = run('approve', { pin: '654321' });
check('correct PIN runs the admin action under the lock', x.r.ok === true && x.log === 'lock,approve,unlock', x);
x = run('reserve', {});
check('public action needs no PIN, runs under the lock', x.r.ok === true && x.log === 'lock,reserve,unlock', x);
x = run('nope', {});
check('unknown action still answers "Unknown action"', x.r.error === 'Unknown action', x);
process.exit(fail);
