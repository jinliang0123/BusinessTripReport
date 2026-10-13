const test = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const ExcelJS = require('exceljs');
const { open } = require('../src/db');
const { createApp } = require('../src/server');

process.env.ADMIN_EMAIL = 'boss@x.com';
process.env.ADMIN_PASSWORD = 'adminpass1';

let server, base;
const fakeOcr = async () => ({ category: 'taxi', amount: 285, text: 'fake', engine: 'test' });
test.before(async () => {
  server = createApp(open(':memory:'), { recognize: fakeOcr }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

async function call(cookie, method, path, body) {
  const isForm = body instanceof FormData;
  const r = await fetch(base + path, { method, headers: { ...(cookie && { cookie }), ...(body && !isForm && { 'content-type': 'application/json' }) }, body: body && (isForm ? body : JSON.stringify(body)) });
  const ck = r.headers.get('set-cookie')?.split(';')[0];
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, ck, data: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
}

test('完整流程：註冊→新增→拍照→加總→匯出→管理者修正', async () => {
  const reg = await call(null, 'POST', '/api/register', { company: 'ACME', department: 'RD', emp_no: 'E001', name: '王小明', email: 'a@x.com', phone: '0912345678', password: 'password1' });
  assert.strictEqual(reg.status, 200);
  const ck = reg.ck;
  assert.strictEqual((await call(null, 'POST', '/api/register', { company: 'ACME', department: 'RD', emp_no: 'E001', name: 'x', email: 'b@x.com', phone: '0912345678', password: 'password1' })).status, 409);
  assert.strictEqual((await call(null, 'GET', '/api/trips')).status, 401);

  const { data: { id } } = await call(ck, 'POST', '/api/trips');
  let tr = (await call(ck, 'GET', `/api/trips/${id}`)).data.trip;
  assert.strictEqual(tr.time_start, '08:30'); assert.strictEqual(tr.time_end, '17:30'); assert.strictEqual(tr.hours, 8);

  await call(ck, 'PUT', `/api/trips/${id}`, { date_start: '2026-01-29', date_end: '2026-01-29', purpose: '客訪', location: '新北', mileage: 75, meal: 400 });
  const png = await sharp({ create: { width: 200, height: 300, channels: 3, background: '#fff' } }).png().toBuffer();
  const up = async (cat) => { const fd = new FormData(); fd.append('image', new Blob([png], { type: 'image/png' }), 'r.png'); if (cat) fd.append('category', cat); return call(ck, 'POST', `/api/trips/${id}/receipts`, fd); };
  let r = await up(); // 自動歸類 taxi
  assert.strictEqual(r.status, 201); assert.strictEqual(r.data.trip.taxi, 285);
  r = await up(); // 第二張 → 加總
  assert.strictEqual(r.data.trip.taxi, 570);
  assert.strictEqual(r.data.trip.transport, 75 * 8 + 570);
  r = await up('parking'); assert.strictEqual(r.data.trip.parking, 285);
  assert.strictEqual(r.data.trip.total, 600 + 570 + 400 + 285);

  // 改金額、改類別、刪除
  const [a, b] = r.data.receipts;
  let p = await call(ck, 'PATCH', `/api/receipts/${a.id}`, { amount: 300 });
  assert.strictEqual(p.data.trip.taxi, 585);
  p = await call(ck, 'PATCH', `/api/receipts/${b.id}`, { category: 'transit' });
  assert.strictEqual(p.data.trip.taxi, 300); assert.strictEqual(p.data.trip.transit, 285);
  p = await call(ck, 'DELETE', `/api/receipts/${a.id}`);
  assert.strictEqual(p.data.trip.taxi, 0);
  const img = await call(ck, 'GET', `/api/receipts/${b.id}/image`);
  assert.strictEqual(img.status, 200);

  // 第二個月
  const t2 = (await call(ck, 'POST', '/api/trips')).data.id;
  await call(ck, 'PUT', `/api/trips/${t2}`, { date_start: '2026-02-26', date_end: '2026-02-26', time_start: '09:00', time_end: '16:00', autoHours: true, mileage: 70, toll: 20.1 });
  const list = (await call(ck, 'GET', '/api/trips')).data;
  assert.deepStrictEqual(list.months.map((m) => m.month), ['2026-01', '2026-02']);
  assert.strictEqual(list.months[1].trips[0].hours, 6);

  // 匯出 xlsx 結構
  const one = await call(ck, 'GET', '/api/export?month=2026-01');
  assert.strictEqual(one.status, 200);
  assert.strictEqual(one.data.slice(0, 2).toString(), 'PK');
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(one.data);
  const names = Object.keys(zip.files);
  assert.ok(names.some((n) => n.endsWith('.xlsx')));
  assert.ok(names.some((n) => n.startsWith('receipts/2026-01/')), names.join());
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await zip.files[names.find((n) => n.endsWith('.xlsx'))].async('nodebuffer'));
  const ws = wb.worksheets[0];
  assert.strictEqual(ws.getCell('A1').value, '日期(起)');
  assert.strictEqual(ws.getCell('A3').value, '1月小計');
  assert.strictEqual(ws.getCell('H3').value.result, 600 + 285);
  const all = await call(ck, 'GET', '/api/export?month=all');
  const wb2 = new ExcelJS.Workbook();
  const z2 = await JSZip.loadAsync(all.data);
  await wb2.xlsx.load(await z2.files[Object.keys(z2.files).find((n) => n.endsWith('.xlsx'))].async('nodebuffer'));
  const w2 = wb2.worksheets[0];
  const col1 = []; w2.eachRow({ includeEmpty: true }, (row, n) => col1.push(row.getCell(1).value));
  // 標題、明細、小計、空白、標題、明細、小計、空白、總計
  assert.deepStrictEqual(col1.map((v) => (v instanceof Date ? 'D' : v ?? null)), ['日期(起)', 'D', '1月小計', null, '日期(起)', 'D', '2月小計', null, '總計']);

  // 管理者
  const adm = await call(null, 'POST', '/api/login', { email: 'boss@x.com', password: 'adminpass1' });
  assert.strictEqual(adm.status, 200);
  assert.strictEqual((await call(ck, 'GET', '/api/admin/users')).status, 403);
  const users = (await call(adm.ck, 'GET', '/api/admin/users')).data.users;
  const emp = users.find((u) => u.email === 'a@x.com');
  const viewed = (await call(adm.ck, 'GET', `/api/trips?userId=${emp.id}`)).data;
  assert.strictEqual(viewed.months.length, 2);
  const fix = await call(adm.ck, 'PUT', `/api/trips/${id}`, { meal: 450 });
  assert.strictEqual(fix.data.trip.meal, 450);
  assert.strictEqual((await call(adm.ck, 'PUT', `/api/admin/users/${emp.id}`, { name: '王大明' })).data.user.name, '王大明');

  // 其他員工無法存取
  const other = await call(null, 'POST', '/api/register', { company: 'ACME', department: 'RD', emp_no: 'E002', name: '李', email: 'c@x.com', phone: '0912345678', password: 'password1' });
  assert.strictEqual((await call(other.ck, 'GET', `/api/trips/${id}`)).status, 404);
  assert.strictEqual((await call(other.ck, 'GET', `/api/receipts/${b.id}/image`)).status, 404);
});
