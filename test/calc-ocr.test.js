const test = require('node:test');
const assert = require('node:assert');
const { computeTrip, sumTrips, defaultHours, hoursLabel } = require('../src/calc');
const { guessAmount, guessCategory } = require('../src/ocr');

test('交通費 = 里程×8 + 計程車 + 公共交通；合計為各項加總（範本 3 月資料）', () => {
  const t = { mileage: 24, taxi: 25, transit: 25, meal: 250, parking: 180 };
  assert.deepStrictEqual(computeTrip(t), { transport: 242, total: 672 });
});
test('月小計', () => {
  const s = sumTrips([{ mileage: 10, meal: 100 }, { mileage: 5, taxi: 20, toll: 13.5 }]);
  assert.strictEqual(s.mileage, 15);
  assert.strictEqual(s.transport, 80 + 40 + 20);
  assert.strictEqual(s.total, 80 + 40 + 20 + 100 + 13.5);
});
test('預設時數與顯示', () => {
  assert.strictEqual(defaultHours('2026-01-29', '08:30', '2026-01-29', '17:30'), 8);
  assert.strictEqual(hoursLabel(8), '1天(8h)');
  assert.strictEqual(defaultHours('2026-02-26', '09:00', '2026-02-26', '16:00'), 6);
  assert.strictEqual(hoursLabel(6.5), '6.5小時');
  assert.strictEqual(defaultHours('2026-03-01', '08:30', '2026-03-02', '17:30'), 16);
});
test('OCR 規則：取含稅總額與類別', () => {
  const text = '統一編號 12345678\n品名 便當 x2\n小計 190\n營業稅 9\n總計 199\n';
  assert.strictEqual(guessAmount(text), 199);
  assert.strictEqual(guessAmount('停車費\n應收 1,250 元'), 1250);
  assert.strictEqual(guessCategory('台灣大車隊 乘車證明'), 'taxi');
  assert.strictEqual(guessCategory('高鐵 車票'), 'transit');
  assert.strictEqual(guessCategory('遠通電收 eTag 通行費'), 'toll');
  assert.strictEqual(guessCategory('○○大飯店 房費'), 'lodging');
});
