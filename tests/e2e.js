// End-to-end test of the front end in demo mode. Usage: node e2e.js [baseUrl]
// Needs `playwright` installed and the web/ folder served (e.g. python3 -m http.server 8765 --directory ../web).
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:8765';
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exitCode = 1; } else console.log('ok  ', m); };
// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });  // phone size
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.error('PAGE ERROR', e.message); process.exitCode = 1; });
  page.on('dialog', d => d.accept());

  // --- customer A buys 3 slots
  await page.goto(BASE + '/index.html');
  await page.waitForSelector('.slot');
  assert(await page.locator('.slot').count() === 100, '100 slots rendered');
  for (const n of [18, 36, 77]) await page.click(`.slot[data-n="${n}"]`);
  assert((await page.textContent('#selCount')).includes('₱450'), 'total shows ₱450 for 3 slots');
  await page.click('#goDetails');
  await page.fill('#name', 'Arlene Roma'); await page.fill('#mobile', '0917 123 4567'); await page.fill('#fb', 'Arlene R');
  await page.click('#reserveBtn');
  await page.waitForSelector('#stepPay:not(.hide)');
  assert((await page.textContent('#payAmount')).includes('₱450'), 'pay screen shows ₱450');
  const orderA = await page.textContent('#payOrderId');

  // --- validation: bad mobile rejected
  const page2 = await ctx.newPage(); page2.on('dialog', d => d.accept());
  await page2.goto(BASE + '/index.html'); await page2.waitForSelector('.slot', { state: 'attached' });
  await page2.evaluate(() => localStorage.removeItem('raffle-order'));
  await page2.reload(); await page2.waitForSelector('.slot');
  assert(await page2.locator('.slot.PENDING').count() === 3, 'other visitor sees 3 pending slots');
  assert(await page2.locator('.slot[data-n="18"]').isDisabled(), 'pending slot cannot be clicked');
  await page2.click('.slot[data-n="5"]'); await page2.click('#goDetails');
  await page2.fill('#name', 'Bad Mobile'); await page2.fill('#mobile', '12345'); await page2.fill('#fb', 'x y');
  await page2.click('#reserveBtn');
  assert((await page2.textContent('#detailsErr')).includes('valid PH mobile'), 'invalid mobile rejected');

  // --- double booking: slot 5 grabbed by someone else after page2 selected it
  await page.evaluate(() => {});  // page A flow continues; simulate race through API directly
  const race = await page2.evaluate(async () => {
    const a = await RaffleAPI.call('reserve', { name: 'Racer One', mobile: '09171111111', facebook: 'r1', slots: [5] });
    const b = await RaffleAPI.call('reserve', { name: 'Racer Two', mobile: '09172222222', facebook: 'r2', slots: [5] });
    return [a.ok, b.ok, b.error];
  });
  assert(race[0] === true && race[1] === false && /taken/.test(race[2]), 'second reservation of same slot refused');

  // --- A uploads proof
  await page.setInputFiles('#proof', { name: 'shot.png', mimeType: 'image/png', buffer: PNG });
  await page.click('#sendProof');
  await page.waitForSelector('#stepDone:not(.hide)');
  assert((await page.textContent('#doneTitle')).includes('waiting for verification'), 'status = submitted');

  // --- admin approves
  const admin = await ctx.newPage(); admin.on('dialog', d => d.accept());
  await admin.goto(BASE + '/admin.html');
  await admin.fill('#pin', 'wrong'); await admin.click('#loginBtn');
  assert((await admin.textContent('#loginErr')).includes('Wrong PIN'), 'wrong PIN refused');
  await admin.fill('#pin', '1234'); await admin.click('#loginBtn');
  await admin.waitForSelector('#panel:not(.hide)');
  assert((await admin.textContent('#orders')).includes('Arlene Roma'), 'order in admin queue');
  await admin.click(`button[data-a="approve"][data-id="${orderA}"]`);
  await admin.waitForSelector(`button[data-a="copy"]`, { state: 'attached' }).catch(() => {});
  await admin.click('[data-tab="all"]');
  assert(await admin.locator(`button[data-a="copy"][data-id="${orderA}"]`).count() === 1, 'order now PAID');
  assert((await admin.textContent('#stats')).includes('₱450'), 'collected = ₱450');

  // --- customer sees secured, board shows PAID with public name
  await page.goto(BASE + '/index.html?order=' + orderA); await page.waitForSelector('#stepDone:not(.hide)');
  assert((await page.textContent('#doneTitle')).includes('Payment confirmed'), 'customer sees confirmation');
  await page.click('#doneAgain'); await page.waitForSelector('.slot.PAID');
  assert(await page.locator('.slot.PAID').count() === 3, 'board shows 3 secured');
  assert((await page.textContent('.slot[data-n="18"]')).includes('Arlene R.'), 'public label is first name + last initial');
  assert(!(await page.content()).includes('0917'), 'no mobile number on public page');

  // --- reject frees numbers; freeze; draw excludes previous winners
  await admin.click('[data-tab="review"]');
  await admin.click(`button[data-a="reject"]`); // Racer's pending order
  await admin.waitForTimeout(100);
  await admin.click('#freezeBtn'); await admin.waitForTimeout(100);
  assert((await admin.textContent('#drawInfo')).includes('frozen'), 'entries frozen');
  await admin.click('#drawBtn'); await admin.waitForTimeout(100);
  await admin.click('#drawBtn'); await admin.waitForTimeout(100);
  await admin.click('#drawBtn'); await admin.waitForTimeout(100);
  const w = await admin.locator('#winnersList .win').allTextContents();
  assert(w.length === 3, '3 prizes drawn');
  const slots = w.map(t => t.match(/#(\d+)/)[1]);
  assert(new Set(slots).size === 3, 'no slot wins twice: ' + slots);
  assert(await admin.locator('#drawBtn').isDisabled(), 'draw disabled after last prize');

  // --- registration closed on public page
  await page.reload(); await page.waitForSelector('#doneAgain'); await page.click('#doneAgain'); await page.waitForSelector('.slot');
  assert(await page.locator('.slot.AVAILABLE:not([disabled])').count() === 0, 'no slot selectable once closed');
  await page.screenshot({ path: 'board.png' });
  await browser.close();
})();
