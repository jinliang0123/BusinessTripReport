'use strict';
const ExcelJS = require('exceljs');
const { ZipArchive } = require('archiver');
const { RATE, CATEGORY_LABELS, computeTrip, sumTrips, hoursLabel, monthOf } = require('./calc');

const HEADERS = ['日期(起)', '日期(迄)', '假別', '時數', '目的', '地點', '里程數', '交通費', '住宿費', '補助款', '誤餐費', '停車費', '過路費', '其他', '合計', '備註'];
const WIDTHS = [19.6, 19.6, 7, 10, 28, 9, 9, 9, 9, 9, 9, 9, 9, 9, 10, 20];
const FONT = { name: '新細明體', size: 11 };
const BORDER = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
const CENTER = { horizontal: 'center', vertical: 'middle', wrapText: true };
const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC0C0C0' } };
const SUB_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
const DT_FMT = 'yyyy/m/d h:mm';

// 本地時間字串 → Excel 日期時間（以 UTC 表示，避免時區位移）
const toDate = (d, t) => new Date(`${d}T${t}:00Z`);
const col = (n) => String.fromCharCode(64 + n);

function styleRow(row, fill) {
  row.eachCell({ includeEmpty: true }, (c) => {
    c.font = { ...FONT, bold: !!fill };
    c.border = BORDER;
    c.alignment = CENTER;
    if (fill) c.fill = fill;
  });
}

function addHeader(ws) {
  const r = ws.addRow(HEADERS);
  styleRow(r, HEADER_FILL);
  return r;
}

// 每月：標題列 → 明細 → 「N月小計」→ 空白列（與範本相同）
function buildSheet(ws, trips, { withGrandTotal }) {
  WIDTHS.forEach((w, i) => (ws.getColumn(i + 1).width = w));
  const byMonth = new Map();
  for (const t of [...trips].sort((a, b) => (a.date_start + a.time_start).localeCompare(b.date_start + b.time_start))) {
    const m = monthOf(t.date_start);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(t);
  }
  const subRows = [];
  for (const [m, list] of byMonth) {
    addHeader(ws);
    const first = ws.rowCount + 1;
    for (const t of list) {
      const c = computeTrip(t);
      const r = ws.rowCount + 1;
      const row = ws.addRow([
        toDate(t.date_start, t.time_start), toDate(t.date_end, t.time_end), t.leave_type, hoursLabel(t.hours),
        t.purpose, t.location, t.mileage || null,
        { formula: `G${r}*${RATE}${t.taxi ? '+' + t.taxi : ''}${t.transit ? '+' + t.transit : ''}`, result: c.transport },
        t.lodging || null, t.allowance || null, t.meal || null, t.parking || null, t.toll || null, t.other || null,
        { formula: `SUM(H${r}:N${r})`, result: c.total },
        t.remark,
      ]);
      row.getCell(1).numFmt = DT_FMT;
      row.getCell(2).numFmt = DT_FMT;
      styleRow(row);
      row.getCell(5).alignment = { vertical: 'middle', wrapText: true };
    }
    const last = ws.rowCount;
    const s = sumTrips(list);
    const sr = ws.rowCount + 1;
    const vals = { 7: s.mileage, 8: s.transport, 9: s.lodging, 10: s.allowance, 11: s.meal, 12: s.parking, 13: s.toll, 14: s.other, 15: s.total };
    const cells = [`${Number(m.slice(5, 7))}月小計`, null, null, hoursLabel(s.hours), null, null];
    for (let n = 7; n <= 15; n++) cells.push({ formula: `SUM(${col(n)}${first}:${col(n)}${last})`, result: vals[n] });
    cells.push(null);
    const row = ws.addRow(cells);
    styleRow(row, SUB_FILL);
    subRows.push({ r: sr, vals });
    ws.addRow([]); // 月與月之間的空白列
  }
  if (withGrandTotal && subRows.length > 1) {
    const g = sumTrips(trips);
    const cells = ['總計', null, null, hoursLabel(g.hours), null, null];
    const gv = { 7: g.mileage, 8: g.transport, 9: g.lodging, 10: g.allowance, 11: g.meal, 12: g.parking, 13: g.toll, 14: g.other, 15: g.total };
    for (let n = 7; n <= 15; n++) cells.push({ formula: subRows.map((s) => `${col(n)}${s.r}`).join('+'), result: gv[n] });
    cells.push(null);
    styleRow(ws.addRow(cells), SUB_FILL);
  }
}

async function buildWorkbook(user, trips, label) {
  const wb = new ExcelJS.Workbook();
  wb.creator = '差旅費報告系統';
  const ws = wb.addWorksheet('工作表1');
  buildSheet(ws, trips, { withGrandTotal: label === 'all' });
  // 附表：交通費組成
  const d = wb.addWorksheet('交通費明細');
  d.addRow(['日期(起)', '地點', '里程數', `里程費(×${RATE})`, '計程車', '公共交通', '交通費']);
  [14, 10, 9, 12, 9, 9, 9].forEach((w, i) => (d.getColumn(i + 1).width = w));
  d.getRow(1).font = { bold: true };
  for (const t of trips) {
    const c = computeTrip(t);
    d.addRow([t.date_start, t.location, t.mileage, Math.round(t.mileage * RATE * 100) / 100, t.taxi, t.transit, c.transport]);
  }
  return wb;
}

const safe = (s) => String(s).replace(/[\\/:*?"<>|\s]+/g, '_');

// 輸出 zip：報表 xlsx + receipts/<月>/<日期>_<序號>_<類別>_<金額>.jpg
async function streamZip(res, { user, trips, receiptsOf, label }) {
  const wb = await buildWorkbook(user, trips, label);
  const xlsx = await wb.xlsx.writeBuffer();
  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.on('error', (e) => { console.error(e); res.destroy(e); });
  const base = `差旅費報告_${safe(user.name)}_${label === 'all' ? '全部月份' : label}`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(base)}.zip`);
  archive.pipe(res);
  archive.append(Buffer.from(xlsx), { name: `${base}.xlsx` });
  let n = 0;
  for (const t of trips) {
    const m = monthOf(t.date_start);
    for (const r of receiptsOf(t.id)) {
      n += 1;
      const ext = r.mime === 'image/png' ? 'png' : 'jpg';
      archive.append(r.image, { name: `receipts/${m}/${t.date_start}_${String(n).padStart(3, '0')}_${CATEGORY_LABELS[r.category] || r.category}_${r.amount}.${ext}` });
    }
  }
  await archive.finalize();
  return base;
}

module.exports = { buildWorkbook, streamZip, safe };
