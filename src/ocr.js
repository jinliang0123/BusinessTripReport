'use strict';
// 收據辨識：回傳 { category, amount, text, engine }
// 1) 設定 ANTHROPIC_API_KEY 時使用 Claude 視覺模型（可同時判斷費用類別與含稅總額）
// 2) 否則使用 Tesseract.js（繁中＋英文）並以關鍵字規則判斷
const { CATEGORIES } = require('./calc');

const KEYWORDS = [
  ['taxi', /計程車|台灣大車隊|大都會|55688|Uber|LINE\s*TAXI|乘車證明|車資|上車|下車|跳表/i],
  ['toll', /eTag|遠通|通行費|過路費|國道|高速公路|ETC/i],
  ['parking', /停車|車位|Parking|場站/i],
  ['transit', /高鐵|台鐵|臺鐵|火車|捷運|悠遊卡|客運|公車|車票|乘車券|HSR|MRT|機場捷運/i],
  ['lodging', /旅館|飯店|酒店|住宿|民宿|Hotel|Inn|房費|入住|Check-?in/i],
  ['meal', /餐|便當|麵|飯|飲|咖啡|超商|7-?ELEVEN|全家|萊爾富|Restaurant|Cafe|小吃|早餐|午餐|晚餐/i],
];

function guessCategory(text) {
  for (const [cat, re] of KEYWORDS) if (re.test(text)) return cat;
  return 'other';
}

const TOTAL_RE = /(總\s*計|合\s*計|總\s*額|總\s*金\s*額|應\s*收|應\s*付|實\s*收|含\s*稅|Total|TOTAL|AMOUNT|金\s*額|車\s*資|小\s*計)/;
const toNum = (s) => Number(String(s).replace(/[,，\s]/g, ''));

// 從 OCR 文字找「含稅總額」：優先取帶有總計類關鍵字那一行（或其下一行）的數字，否則取最大的合理數字
function guessAmount(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const numRe = /(?<![\d.])(\d{1,3}(?:[,，]\d{3})+|\d+)(?:\.(\d{1,2}))?(?![\d])/g;
  const numsOf = (line) => {
    const out = [];
    // 排除統編、電話、日期等長數字：僅接受 1~7 位
    for (const m of line.matchAll(numRe)) {
      const v = toNum(m[1] + (m[2] ? '.' + m[2] : ''));
      if (v > 0 && v < 10000000 && String(m[1]).replace(/\D/g, '').length <= 7) out.push(v);
    }
    return out;
  };
  const keyed = [];
  lines.forEach((l, i) => {
    if (TOTAL_RE.test(l)) {
      let n = numsOf(l);
      if (!n.length && lines[i + 1]) n = numsOf(lines[i + 1]);
      if (n.length) keyed.push({ v: n[n.length - 1], strong: /總\s*計|合\s*計|Total|應\s*收|實\s*收|含\s*稅/i.test(l) });
    }
  });
  if (keyed.length) {
    const strong = keyed.filter((k) => k.strong);
    const pool = strong.length ? strong : keyed;
    return Math.max(...pool.map((k) => k.v));
  }
  const all = lines.filter((l) => !/統一編號|統編|電話|Tel|發票號碼|日期|\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(l)).flatMap(numsOf);
  return all.length ? Math.max(...all) : 0;
}

async function viaClaude(buf, mime, apiKey) {
  const model = process.env.OCR_MODEL || 'claude-haiku-5-5';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mime, data: buf.toString('base64') } },
          { type: 'text', text:
            '這是一張出差費用收據/發票/車票（台灣）。請只輸出一行 JSON，不要其他文字：' +
            '{"category":"taxi|transit|lodging|meal|parking|toll|other","amount":數字,"summary":"簡短說明"}。' +
            'amount 為整張單據的「含稅總金額」(實付總額，不是單價或稅額)，無法判讀時填 0。' +
            'category：計程車→taxi；高鐵/台鐵/捷運/客運→transit；旅館→lodging；餐飲→meal；停車→parking；eTag/國道通行費→toll；其他→other。' },
        ],
      }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}`);
  const data = await res.json();
  const txt = (data.content || []).map((c) => c.text || '').join('');
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no json');
  const j = JSON.parse(m[0]);
  return {
    category: CATEGORIES.includes(j.category) ? j.category : 'other',
    amount: Math.max(0, Number(j.amount) || 0),
    text: String(j.summary || ''),
    engine: `claude:${model}`,
  };
}

let worker;
async function viaTesseract(buf) {
  const { createWorker } = require('tesseract.js');
  if (!worker) worker = createWorker(['chi_tra', 'eng'], 1, { langPath: process.env.TESSDATA_PATH || undefined });
  const w = await worker;
  const { data } = await w.recognize(buf);
  const text = data.text || '';
  return { category: guessCategory(text), amount: guessAmount(text), text, engine: 'tesseract' };
}

async function recognize(buf, mime = 'image/jpeg') {
  const key = process.env.ANTHROPIC_API_KEY;
  if (key) {
    try { return await viaClaude(buf, mime, key); } catch (e) { console.warn('[ocr] Claude 辨識失敗，改用 Tesseract：', e.message); }
  }
  try { return await viaTesseract(buf); } catch (e) {
    console.warn('[ocr] Tesseract 失敗：', e.message);
    return { category: 'other', amount: 0, text: '', engine: 'none' };
  }
}

module.exports = { recognize, guessAmount, guessCategory };
