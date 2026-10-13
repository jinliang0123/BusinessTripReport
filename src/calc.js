'use strict';

const RATE = Number(process.env.MILEAGE_RATE) || 8;

const CATEGORIES = ['taxi', 'transit', 'lodging', 'allowance', 'meal', 'parking', 'toll', 'other'];
const CATEGORY_LABELS = {
  taxi: '計程車',
  transit: '公共交通',
  lodging: '住宿費',
  allowance: '補助款',
  meal: '誤餐費',
  parking: '停車費',
  toll: '過路費',
  other: '其他',
};

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// 交通費 = 里程數 × 每公里費率 + 計程車費 + 公共交通工具費
function transportFee(t, rate = RATE) {
  return round2((Number(t.mileage) || 0) * rate + (Number(t.taxi) || 0) + (Number(t.transit) || 0));
}

// 合計 = 交通費 + 住宿費 + 補助款 + 誤餐費 + 停車費 + 過路費 + 其他
function computeTrip(t, rate = RATE) {
  const transport = transportFee(t, rate);
  const total = round2(
    transport + ['lodging', 'allowance', 'meal', 'parking', 'toll', 'other'].reduce((s, k) => s + (Number(t[k]) || 0), 0)
  );
  return { transport, total };
}

const SUM_FIELDS = ['hours', 'mileage', 'transport', 'lodging', 'allowance', 'meal', 'parking', 'toll', 'other', 'total'];

function sumTrips(trips, rate = RATE) {
  const acc = Object.fromEntries(SUM_FIELDS.map((k) => [k, 0]));
  for (const t of trips) {
    const c = { ...t, ...computeTrip(t, rate) };
    for (const k of SUM_FIELDS) acc[k] += Number(c[k]) || 0;
  }
  for (const k of SUM_FIELDS) acc[k] = round2(acc[k]);
  return acc;
}

// 預設工時：同日扣除 1 小時午休（超過 5 小時），跨日每日以 8 小時計
function defaultHours(ds, ts, de, te) {
  const start = new Date(`${ds}T${ts}:00`);
  const end = new Date(`${de}T${te}:00`);
  if (isNaN(start) || isNaN(end) || end < start) return 0;
  const days = Math.round((new Date(`${de}T00:00:00`) - new Date(`${ds}T00:00:00`)) / 86400000) + 1;
  if (days > 1) return days * 8;
  const h = (end - start) / 3600000;
  return round2(h > 5 ? h - 1 : h);
}

const monthOf = (dateStr) => String(dateStr).slice(0, 7);

module.exports = { RATE, CATEGORIES, CATEGORY_LABELS, round2, transportFee, computeTrip, sumTrips, defaultHours, monthOf };

// 時數顯示文字，比照範本：8 小時 → 「1天(8h)」，其他 → 「6.5小時」
function hoursLabel(h) {
  h = Number(h) || 0;
  if (h > 0 && h % 8 === 0) return `${h / 8}天(${h}h)`;
  return `${h}小時`;
}
module.exports.hoursLabel = hoursLabel;
