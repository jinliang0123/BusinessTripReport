'use strict';
const $ = (s, r = document) => r.querySelector(s);
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => (Number(n) || 0).toLocaleString('zh-TW', { maximumFractionDigits: 2 });

const S = { me: null, cfg: null, viewUid: null, viewUser: null };
const FEES = ['taxi', 'transit', 'lodging', 'allowance', 'meal', 'parking', 'toll', 'other'];
const PHOTO_FEES = FEES.filter((c) => c !== 'allowance');

let toastT;
function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg; t.className = err ? 'err' : ''; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), err ? 4500 : 2200);
}

async function api(path, opts = {}) {
  const o = { credentials: 'same-origin', ...opts };
  if (opts.json !== undefined) { o.method = o.method || 'POST'; o.headers = { 'Content-Type': 'application/json' }; o.body = JSON.stringify(opts.json); }
  const r = await fetch(path, o);
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && S.me) { S.me = null; render(); }
  if (!r.ok) throw new Error(d.error || `錯誤 ${r.status}`);
  return d;
}
const uq = () => (S.viewUid && S.me?.role === 'admin' ? `userId=${S.viewUid}` : '');
const q = () => (uq() ? '?' + uq() : '');

// ---------------- 登入 / 註冊 ----------------
function viewAuth(mode = 'login') {
  const app = $('#app');
  const reg = mode === 'register';
  app.innerHTML = `
  <div class="card" style="max-width:460px;margin:24px auto">
    <h1>差旅費報告</h1>
    <div class="tabs"><button class="${reg ? 'sec' : ''}" data-m="login">登入</button><button class="${reg ? '' : 'sec'}" data-m="register">註冊會員</button></div>
    <form id="f" autocomplete="on">
      ${reg ? `
      <label>公司名稱</label><input name="company" required autocomplete="organization">
      <label>部門</label><input name="department" required>
      <label>員工編號</label><input name="emp_no" required>
      <label>姓名</label><input name="name" required autocomplete="name">
      <label>手機號</label><input name="phone" type="tel" required autocomplete="tel">` : ''}
      <label>EMAIL</label><input name="email" type="email" required autocomplete="email">
      <label>密碼${reg ? '（至少 8 碼）' : ''}</label><input name="password" type="password" required minlength="${reg ? 8 : 1}" autocomplete="${reg ? 'new-password' : 'current-password'}">
      <p class="err" id="e"></p>
      <button class="big">${reg ? '註冊並登入' : '登入'}</button>
    </form>
  </div>`;
  app.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => viewAuth(b.dataset.m)));
  $('#f').onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      const body = Object.fromEntries(new FormData(ev.target));
      const d = await api(reg ? '/api/register' : '/api/login', { json: body });
      S.me = d.user; S.viewUid = null; render();
    } catch (e) { $('#e').textContent = e.message; }
  };
}

// ---------------- 差勤清單 ----------------
async function viewHome() {
  const d = await api('/api/trips' + q());
  S.viewUser = d.user;
  const months = d.months;
  const app = $('#app');
  const dl = (m) => `/api/export?month=${m}&${uq()}`;
  app.innerHTML = `
    <div class="row sp" style="margin-bottom:12px">
      <h2 style="margin:0">${esc(d.user.name)} 的差勤${S.viewUid ? `<span class="mut">（${esc(d.user.company)} / ${esc(d.user.department)} / ${esc(d.user.emp_no)}）</span>` : ''}</h2>
      <button id="add">＋ 新增差勤</button>
    </div>
    <div class="card row">
      <select id="mon" style="flex:1;min-width:140px">${months.map((m) => `<option>${m.month}</option>`).join('') || '<option value="">（無資料）</option>'}</select>
      <button class="sec" id="dlm" ${months.length ? '' : 'disabled'}>下載該月 ZIP</button>
      <button class="sec" id="dla" ${months.length ? '' : 'disabled'}>下載全部月份 ZIP</button>
    </div>
    ${months.length ? '' : '<p class="mut">尚無差勤資料，按「新增差勤」開始。</p>'}
    ${months.slice().reverse().map((m) => `
      <section class="month">
        <h3>${m.month}</h3>
        ${m.trips.map((t) => `
          <button class="trip" data-id="${t.id}">
            <div class="t1"><span>${t.date_start} ${t.time_start} → ${t.date_end !== t.date_start ? t.date_end + ' ' : ''}${t.time_end}</span><span>$${money(t.total)}</span></div>
            <div class="mut">${esc(t.leave_type)}・${esc(t.hours_label)}・${esc(t.purpose || '（未填目的）')}${t.location ? '・' + esc(t.location) : ''}・📷${t.receipt_count}</div>
          </button>`).join('')}
        <div class="subtotal">${Number(m.month.slice(5))}月小計　里程 ${money(m.subtotal.mileage)} km｜交通 ${money(m.subtotal.transport)}｜住宿 ${money(m.subtotal.lodging)}｜補助 ${money(m.subtotal.allowance)}｜誤餐 ${money(m.subtotal.meal)}｜停車 ${money(m.subtotal.parking)}｜過路 ${money(m.subtotal.toll)}｜其他 ${money(m.subtotal.other)}｜合計 <b>$${money(m.subtotal.total)}</b></div>
      </section>`).join('')}`;
  $('#add').onclick = async () => { const r = await api('/api/trips' + q(), { method: 'POST' }); viewTrip(r.id); };
  $('#dlm').onclick = () => { if ($('#mon').value) location.href = dl($('#mon').value); };
  $('#dla').onclick = () => (location.href = dl('all'));
  app.querySelectorAll('.trip').forEach((b) => (b.onclick = () => viewTrip(b.dataset.id)));
}

// ---------------- 單筆差勤 ----------------
async function viewTrip(id) {
  let { trip, receipts } = await api(`/api/trips/${id}`);
  const app = $('#app');
  const L = S.cfg.labels;
  const fld = (name, label, type = 'text', extra = '') => `<div><label for="f_${name}">${label}</label><input id="f_${name}" name="${name}" type="${type}" value="${esc(trip[name])}" ${extra}></div>`;
  const feeBlock = (c) => `
    <div class="fee" data-cat="${c}">
      <div class="head">
        <label for="f_${c}">${L[c]}</label>
        <input id="f_${c}" name="${c}" type="number" inputmode="decimal" min="0" step="any" value="${trip[c] || ''}" placeholder="0">
        ${c === 'allowance' ? '' : `<label class="cam camlabel">📷 拍照<input type="file" accept="image/*" capture="environment" data-cat="${c}" multiple></label>`}
      </div>
      <div class="thumbs" data-thumbs="${c}"></div>
    </div>`;
  app.innerHTML = `
  <button class="sec" id="back">← 返回清單</button>
  <form id="f" class="card" style="margin-top:12px">
    <h2>差勤資料</h2>
    <div class="grid">
      ${fld('date_start', '日期(起)', 'date', 'required')}${fld('time_start', '時間(起)', 'time', 'required')}
      ${fld('date_end', '日期(迄)', 'date', 'required')}${fld('time_end', '時間(迄)', 'time', 'required')}
    </div>
    <div class="grid">
      <div><label>假別</label><select name="leave_type">${['出差', '公出', '外勤', '其他'].map((o) => `<option ${o === trip.leave_type ? 'selected' : ''}>${o}</option>`).join('')}</select></div>
      <div><label for="f_hours">時數（依起迄自動計算，可修改）</label><input id="f_hours" name="hours" type="number" step="any" min="0" value="${trip.hours}"></div>
      ${fld('location', '地點')}
    </div>
    ${fld('purpose', '目的')}
    <h2 style="margin-top:20px">費用</h2>
    <button type="button" class="big" id="auto"><span id="autoLbl">📷 拍收據（自動判斷費用類別）</span><input type="file" id="autoFile" accept="image/*" capture="environment" hidden multiple></button>
    <p class="mut">${S.cfg.ocr === 'claude' ? '使用 AI 辨識收據類別與含稅金額。' : '使用 OCR 辨識；準確度有限，請核對金額。'}同類別可拍多張，金額自動加總；辨識有誤可直接修改照片下方的金額或類別。</p>
    <div class="fee"><div class="head"><label for="f_mileage">里程數</label><input id="f_mileage" name="mileage" type="number" inputmode="decimal" min="0" step="any" value="${trip.mileage || ''}" placeholder="公里"></div>
      <div class="mut">里程費 = 里程數 × ${S.cfg.rate} 元/公里 = $<span id="mileFee">0</span></div></div>
    ${['taxi', 'transit'].map(feeBlock).join('')}
    <div class="subtotal" style="margin:8px 0">交通費 = 里程費 + 計程車 + 公共交通 = <b>$<span id="transport">0</span></b></div>
    ${['lodging', 'allowance', 'meal', 'parking', 'toll', 'other'].map(feeBlock).join('')}
    ${fld('remark', '備註')}
    <div class="total"><span>合計</span><b>$<span id="total">0</span></b></div>
    <div class="row" style="margin-top:16px"><button id="save" style="flex:1">儲存</button><button type="button" class="bad" id="del">刪除此筆</button></div>
  </form>`;

  const form = $('#f');
  const val = (n) => Number(form.elements[n].value) || 0;
  const recalc = () => {
    const fee = val('mileage') * S.cfg.rate;
    const transport = Math.round((fee + val('taxi') + val('transit')) * 100) / 100;
    const total = Math.round((transport + ['lodging', 'allowance', 'meal', 'parking', 'toll', 'other'].reduce((s, k) => s + val(k), 0)) * 100) / 100;
    $('#mileFee').textContent = money(fee); $('#transport').textContent = money(transport); $('#total').textContent = money(total);
  };
  const fillFields = (t) => { for (const k of ['mileage', ...FEES]) form.elements[k].value = t[k] || ''; form.elements.hours.value = t.hours; recalc(); };

  const renderThumbs = () => {
    for (const c of FEES) {
      const box = app.querySelector(`[data-thumbs="${c}"]`);
      box.innerHTML = receipts.filter((r) => r.category === c).map((r) => `
        <div class="thumb" data-rid="${r.id}">
          <img src="/api/receipts/${r.id}/image" alt="收據">
          <input type="number" min="0" step="any" inputmode="decimal" value="${r.amount}" aria-label="收據金額">
          <select aria-label="費用類別">${PHOTO_FEES.concat('allowance').map((k) => `<option value="${k}" ${k === r.category ? 'selected' : ''}>${L[k]}</option>`).join('')}</select>
          <button type="button" class="sec" style="padding:4px;width:100%;margin-top:4px">刪除</button>
        </div>`).join('');
    }
    app.querySelectorAll('.thumb').forEach((th) => {
      const rid = th.dataset.rid;
      th.querySelector('img').onclick = (e) => { const lb = el(`<div class="lightbox"><img src="${e.target.src}"></div>`); lb.onclick = () => lb.remove(); document.body.append(lb); };
      const upd = async (body) => { try { const d = await api(`/api/receipts/${rid}`, { method: 'PATCH', json: body }); receipts = d.receipts; fillFields(d.trip); renderThumbs(); } catch (e) { toast(e.message, true); } };
      th.querySelector('input').onchange = (e) => upd({ amount: e.target.value });
      th.querySelector('select').onchange = (e) => upd({ category: e.target.value });
      th.querySelector('button').onclick = async () => {
        if (!confirm('刪除這張收據？')) return;
        try { const d = await api(`/api/receipts/${rid}`, { method: 'DELETE' }); receipts = d.receipts; fillFields(d.trip); renderThumbs(); } catch (e) { toast(e.message, true); }
      };
    }
    );
  };

  const body = () => Object.fromEntries(new FormData(form));
  const save = async (extra = {}) => {
    const d = await api(`/api/trips/${id}`, { method: 'PUT', json: { ...body(), ...extra } });
    trip = d.trip; receipts = d.receipts; return d;
  };

  // 起迄變動時自動重算時數
  ['date_start', 'time_start', 'date_end', 'time_end'].forEach((n) => (form.elements[n].onchange = async () => {
    try { const d = await save({ autoHours: true, hours: undefined }); form.elements.hours.value = d.trip.hours; } catch (e) { toast(e.message, true); }
  }));
  form.addEventListener('input', recalc);

  async function upload(files, cat) {
    if (!files.length) return;
    try {
      await save();
      for (const f of files) {
        toast(`辨識中… ${f.name || ''}`);
        const fd = new FormData(); fd.append('image', f); if (cat) fd.append('category', cat);
        const d = await api(`/api/trips/${id}/receipts`, { method: 'POST', body: fd });
        trip = d.trip; receipts = d.receipts; fillFields(d.trip); renderThumbs();
        const r = d.receipt;
        toast(d.recognized ? `${L[r.category]} 含稅 $${money(r.amount)} 已填入` : `已存照片，但無法判讀金額，請手動輸入（${L[r.category]}）`, !d.recognized);
      }
    } catch (e) { toast(e.message, true); }
  }
  app.querySelectorAll('input[type=file][data-cat]').forEach((inp) => (inp.onchange = async () => { await upload([...inp.files], inp.dataset.cat); inp.value = ''; }));
  $('#auto').onclick = () => $('#autoFile').click();
  $('#autoFile').onclick = (e) => e.stopPropagation();
  $('#autoFile').onchange = async (e) => { await upload([...e.target.files], null); e.target.value = ''; };

  form.onsubmit = async (ev) => {
    ev.preventDefault();
    try { await save(); toast('已儲存'); viewHome(); } catch (e) { toast(e.message, true); }
  };
  $('#back').onclick = async () => { try { await save(); } catch { /* 忽略；回清單 */ } viewHome(); };
  $('#del').onclick = async () => { if (!confirm('確定刪除此筆差勤與其所有收據照片？')) return; await api(`/api/trips/${id}`, { method: 'DELETE' }); viewHome(); };
  recalc(); renderThumbs();
}

// ---------------- 管理者 ----------------
async function viewAdmin() {
  const { users } = await api('/api/admin/users');
  $('#app').innerHTML = `
  <h2>員工列表</h2>
  <div class="card" style="overflow-x:auto"><table>
    <tr><th>公司</th><th>部門</th><th>編號</th><th>姓名</th><th>EMAIL</th><th>手機</th><th>筆數</th><th></th></tr>
    ${users.map((u) => `<tr><td>${esc(u.company)}</td><td>${esc(u.department)}</td><td>${esc(u.emp_no)}</td><td>${esc(u.name)}${u.role === 'admin' ? ' 🛡' : ''}</td><td>${esc(u.email)}</td><td>${esc(u.phone)}</td><td>${u.trip_count}</td>
      <td style="white-space:nowrap"><button data-view="${u.id}">差勤</button> <button class="sec" data-edit="${u.id}">資料</button></td></tr>`).join('')}
  </table></div>`;
  document.querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => { S.viewUid = Number(b.dataset.view); render(); }));
  document.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => editUser(users.find((u) => u.id == b.dataset.edit))));
}
function editUser(u) {
  $('#app').innerHTML = `
  <button class="sec" id="back">← 返回</button>
  <form id="f" class="card" style="margin-top:12px"><h2>修改員工資料</h2>
    ${['company:公司名稱', 'department:部門', 'emp_no:員工編號', 'name:姓名', 'email:EMAIL', 'phone:手機號'].map((s) => { const [k, l] = s.split(':'); return `<label>${l}</label><input name="${k}" value="${esc(u[k])}" required>`; }).join('')}
    <label>角色</label><select name="role"><option value="employee" ${u.role === 'employee' ? 'selected' : ''}>員工</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>管理者</option></select>
    <label>重設密碼（留空則不變，至少 8 碼）</label><input name="password" type="password" autocomplete="new-password">
    <p class="err" id="e"></p><button class="big">儲存</button></form>`;
  $('#back').onclick = viewAdmin;
  $('#f').onsubmit = async (ev) => {
    ev.preventDefault();
    const b = Object.fromEntries(new FormData(ev.target)); if (!b.password) delete b.password;
    try { await api(`/api/admin/users/${u.id}`, { method: 'PUT', json: b }); toast('已儲存'); viewAdmin(); } catch (e) { $('#e').textContent = e.message; }
  };
}

// ---------------- 框架 ----------------
async function render() {
  const top = $('#top'), banner = $('#banner');
  if (!S.me) { top.hidden = true; banner.hidden = true; return viewAuth(); }
  top.hidden = false;
  $('#who').textContent = `${S.me.name}（${S.me.company}）`;
  $('#navAdmin').hidden = S.me.role !== 'admin';
  banner.hidden = !S.viewUid;
  if (S.viewUid) banner.innerHTML = `管理者模式：正在檢視／修正員工資料 <button class="link" id="exit" style="color:inherit;text-decoration:underline">離開</button>`;
  if (S.viewUid) $('#exit').onclick = () => { S.viewUid = null; $('#navAdmin').click(); };
  try { await viewHome(); } catch (e) { toast(e.message, true); }
}
$('#navHome').onclick = () => { S.viewUid = null; render(); };
$('#navAdmin').onclick = async () => { S.viewUid = null; $('#banner').hidden = true; try { await viewAdmin(); } catch (e) { toast(e.message, true); } };
$('#navOut').onclick = async () => { await api('/api/logout', { method: 'POST' }); S.me = null; S.viewUid = null; render(); };

(async () => {
  S.cfg = await api('/api/config');
  try { S.me = (await api('/api/me')).user; } catch { S.me = null; }
  render();
})();
