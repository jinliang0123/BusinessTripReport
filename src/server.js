'use strict';
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const sharp = require('sharp');
const { open } = require('./db');
const calc = require('./calc');
const { recognize } = require('./ocr');
const { streamZip } = require('./export');

const { CATEGORIES, CATEGORY_LABELS, RATE } = calc;
const SESSION_DAYS = 14;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const num = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? calc.round2(n) : 0; };

function createApp(db = open(), opts = {}) {
  const doRecognize = opts.recognize || recognize;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

  // ---------- 管理者種子 ----------
  if (!db.prepare("SELECT 1 FROM users WHERE role='admin'").get()) {
    const email = process.env.ADMIN_EMAIL || 'admin@example.com';
    let pw = process.env.ADMIN_PASSWORD;
    if (!pw) { pw = crypto.randomBytes(6).toString('hex'); console.log(`[init] 已建立管理者 ${email}，一次性密碼：${pw}`); }
    db.prepare(`INSERT OR IGNORE INTO users (company,department,emp_no,name,email,phone,password_hash,role) VALUES ('-','-','admin','系統管理者',?,'-',?,'admin')`)
      .run(email, bcrypt.hashSync(pw, 10));
  }

  // ---------- 驗證 ----------
  const cookieOf = (req, k) => (req.headers.cookie || '').split(/;\s*/).map((c) => c.split('=')).find(([n]) => n === k)?.[1];
  const publicUser = (u) => u && { id: u.id, company: u.company, department: u.department, emp_no: u.emp_no, name: u.name, email: u.email, phone: u.phone, role: u.role };

  function auth(req, res, next) {
    const tok = cookieOf(req, 'sid');
    const row = tok && db.prepare('SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?').get(sha(tok));
    if (!row || row.expires_at < Date.now()) return res.status(401).json({ error: '請先登入' });
    req.user = row;
    next();
  }
  const adminOnly = (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: '需要管理者權限' }));

  function startSession(res, userId) {
    const tok = crypto.randomBytes(32).toString('hex');
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').run(sha(tok), userId, Date.now() + SESSION_DAYS * 864e5);
    res.setHeader('Set-Cookie', `sid=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  }

  const fails = new Map();
  app.post('/api/register', (req, res) => {
    const b = req.body || {};
    const f = Object.fromEntries(['company', 'department', 'emp_no', 'name', 'email', 'phone', 'password'].map((k) => [k, String(b[k] ?? '').trim()]));
    for (const [k, v] of Object.entries(f)) if (!v) return res.status(400).json({ error: `請填寫：${{ company: '公司名稱', department: '部門', emp_no: '員工編號', name: '姓名', email: 'EMAIL', phone: '手機號', password: '密碼' }[k]}` });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email)) return res.status(400).json({ error: 'EMAIL 格式不正確' });
    if (!/^[0-9+\-\s()]{8,20}$/.test(f.phone)) return res.status(400).json({ error: '手機號格式不正確' });
    if (f.password.length < 8) return res.status(400).json({ error: '密碼至少 8 碼' });
    try {
      const r = db.prepare('INSERT INTO users (company,department,emp_no,name,email,phone,password_hash) VALUES (?,?,?,?,?,?,?)')
        .run(f.company, f.department, f.emp_no, f.name, f.email, f.phone, bcrypt.hashSync(f.password, 10));
      startSession(res, r.lastInsertRowid);
      res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid)) });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'EMAIL 或該公司員工編號已註冊' });
      throw e;
    }
  });

  app.post('/api/login', (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const key = `${req.ip}|${email}`;
    const f = fails.get(key);
    if (f && f.n >= 8 && Date.now() - f.t < 15 * 60e3) return res.status(429).json({ error: '嘗試次數過多，請 15 分鐘後再試' });
    const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (!u || !bcrypt.compareSync(String(req.body?.password || ''), u.password_hash)) {
      fails.set(key, { n: (f?.n || 0) + 1, t: Date.now() });
      return res.status(401).json({ error: 'EMAIL 或密碼錯誤' });
    }
    fails.delete(key);
    startSession(res, u.id);
    res.json({ user: publicUser(u) });
  });

  app.post('/api/logout', (req, res) => {
    const tok = cookieOf(req, 'sid');
    if (tok) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(tok));
    res.setHeader('Set-Cookie', 'sid=; Max-Age=0; Path=/');
    res.json({ ok: true });
  });

  app.get('/api/config', (req, res) => res.json({ rate: RATE, categories: CATEGORIES, labels: CATEGORY_LABELS, ocr: process.env.ANTHROPIC_API_KEY ? 'claude' : 'tesseract' }));
  app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

  // ---------- 差勤 ----------
  const present = (t) => ({ ...t, ...calc.computeTrip(t), hours_label: calc.hoursLabel(t.hours) });
  const targetUserId = (req) => (req.user.role === 'admin' && req.query.userId ? Number(req.query.userId) : req.user.id);

  function tripFor(req, res) {
    const t = db.prepare('SELECT * FROM trips WHERE id=?').get(Number(req.params.id));
    if (!t || (t.user_id !== req.user.id && req.user.role !== 'admin')) { res.status(404).json({ error: '找不到差勤資料' }); return null; }
    return t;
  }
  const receiptMeta = (tripId) => db.prepare('SELECT id,trip_id,category,amount,ocr_engine,created_at FROM receipts WHERE trip_id=? ORDER BY id').all(tripId);

  // 有收據的類別 → 欄位 = 收據金額加總；收據全刪除則歸零
  function syncCategory(tripId, cat) {
    if (!CATEGORIES.includes(cat)) return;
    const s = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM receipts WHERE trip_id=? AND category=?').get(tripId, cat).s;
    db.prepare(`UPDATE trips SET ${cat}=?, updated_at=datetime('now') WHERE id=?`).run(calc.round2(s), tripId);
  }

  app.get('/api/trips', auth, (req, res) => {
    const uid = targetUserId(req);
    const rows = db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM receipts r WHERE r.trip_id=t.id) AS receipt_count FROM trips t WHERE user_id=? ORDER BY date_start, time_start`).all(uid);
    const user = publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(uid));
    if (!user) return res.status(404).json({ error: '找不到員工' });
    const months = {};
    for (const t of rows) (months[calc.monthOf(t.date_start)] ||= []).push(present(t));
    res.json({
      user,
      months: Object.entries(months).sort(([a], [b]) => a.localeCompare(b)).map(([month, trips]) => ({ month, trips, subtotal: calc.sumTrips(trips) })),
    });
  });

  app.post('/api/trips', auth, (req, res) => {
    const uid = targetUserId(req);
    const now = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); // 台北時間今天
    const r = db.prepare('INSERT INTO trips (user_id,date_start,time_start,date_end,time_end,hours) VALUES (?,?,?,?,?,?)')
      .run(uid, now, '08:30', now, '17:30', calc.defaultHours(now, '08:30', now, '17:30'));
    res.status(201).json({ id: r.lastInsertRowid });
  });

  app.get('/api/trips/:id', auth, (req, res) => {
    const t = tripFor(req, res);
    if (t) res.json({ trip: present(t), receipts: receiptMeta(t.id) });
  });

  app.put('/api/trips/:id', auth, (req, res) => {
    const t = tripFor(req, res);
    if (!t) return;
    const b = req.body || {};
    const d = { ...t };
    for (const k of ['date_start', 'date_end']) if (b[k] !== undefined) { if (!DATE_RE.test(b[k])) return res.status(400).json({ error: '日期格式錯誤' }); d[k] = b[k]; }
    for (const k of ['time_start', 'time_end']) if (b[k] !== undefined) { if (!TIME_RE.test(b[k])) return res.status(400).json({ error: '時間格式錯誤' }); d[k] = b[k]; }
    if (d.date_end + d.time_end < d.date_start + d.time_start) return res.status(400).json({ error: '迄日期時間不可早於起日期時間' });
    for (const k of ['leave_type', 'purpose', 'location', 'remark']) if (b[k] !== undefined) d[k] = String(b[k]).slice(0, 500);
    for (const k of ['mileage', ...CATEGORIES]) if (b[k] !== undefined) d[k] = num(b[k]);
    d.hours = b.hours !== undefined ? num(b.hours) : (b.autoHours ? calc.defaultHours(d.date_start, d.time_start, d.date_end, d.time_end) : t.hours);
    db.prepare(`UPDATE trips SET date_start=@date_start,time_start=@time_start,date_end=@date_end,time_end=@time_end,leave_type=@leave_type,hours=@hours,
      purpose=@purpose,location=@location,mileage=@mileage,${CATEGORIES.map((c) => `${c}=@${c}`).join(',')},remark=@remark,updated_at=datetime('now') WHERE id=@id`).run(d);
    res.json({ trip: present(db.prepare('SELECT * FROM trips WHERE id=?').get(t.id)), receipts: receiptMeta(t.id) });
  });

  app.delete('/api/trips/:id', auth, (req, res) => {
    const t = tripFor(req, res);
    if (t) { db.prepare('DELETE FROM trips WHERE id=?').run(t.id); res.json({ ok: true }); }
  });

  // ---------- 收據 ----------
  app.post('/api/trips/:id/receipts', auth, upload.single('image'), async (req, res) => {
    const t = tripFor(req, res);
    if (!t) return;
    if (!req.file) return res.status(400).json({ error: '請選擇照片' });
    let jpeg;
    try { jpeg = await sharp(req.file.buffer).rotate().resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer(); }
    catch { return res.status(400).json({ error: '無法讀取此圖片格式，請改用 JPG/PNG' }); }
    const hinted = CATEGORIES.includes(req.body?.category) ? req.body.category : null;
    const ocr = await doRecognize(jpeg, 'image/jpeg');
    const category = hinted || ocr.category;
    const r = db.prepare('INSERT INTO receipts (trip_id,category,amount,mime,image,ocr_engine,ocr_text) VALUES (?,?,?,?,?,?,?)')
      .run(t.id, category, calc.round2(ocr.amount), 'image/jpeg', jpeg, ocr.engine, (ocr.text || '').slice(0, 4000));
    syncCategory(t.id, category);
    res.status(201).json({
      receipt: receiptMeta(t.id).find((x) => x.id === r.lastInsertRowid),
      recognized: ocr.amount > 0,
      trip: present(db.prepare('SELECT * FROM trips WHERE id=?').get(t.id)),
      receipts: receiptMeta(t.id),
    });
  });

  function receiptFor(req, res) {
    const r = db.prepare('SELECT r.*, t.user_id FROM receipts r JOIN trips t ON t.id=r.trip_id WHERE r.id=?').get(Number(req.params.id));
    if (!r || (r.user_id !== req.user.id && req.user.role !== 'admin')) { res.status(404).json({ error: '找不到收據' }); return null; }
    return r;
  }

  app.get('/api/receipts/:id/image', auth, (req, res) => {
    const r = receiptFor(req, res);
    if (r) { res.type(r.mime).set('Cache-Control', 'private, max-age=3600').send(r.image); }
  });

  app.patch('/api/receipts/:id', auth, (req, res) => {
    const r = receiptFor(req, res);
    if (!r) return;
    const cat = req.body?.category ?? r.category;
    if (!CATEGORIES.includes(cat)) return res.status(400).json({ error: '費用類別錯誤' });
    const amount = req.body?.amount !== undefined ? num(req.body.amount) : r.amount;
    db.prepare('UPDATE receipts SET category=?, amount=? WHERE id=?').run(cat, amount, r.id);
    syncCategory(r.trip_id, cat);
    if (cat !== r.category) syncCategory(r.trip_id, r.category);
    res.json({ trip: present(db.prepare('SELECT * FROM trips WHERE id=?').get(r.trip_id)), receipts: receiptMeta(r.trip_id) });
  });

  app.delete('/api/receipts/:id', auth, (req, res) => {
    const r = receiptFor(req, res);
    if (!r) return;
    db.prepare('DELETE FROM receipts WHERE id=?').run(r.id);
    syncCategory(r.trip_id, r.category);
    res.json({ trip: present(db.prepare('SELECT * FROM trips WHERE id=?').get(r.trip_id)), receipts: receiptMeta(r.trip_id) });
  });

  // ---------- 下載 ----------
  app.get('/api/export', auth, async (req, res, next) => {
    try {
      const uid = targetUserId(req);
      const user = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
      if (!user) return res.status(404).json({ error: '找不到員工' });
      const month = String(req.query.month || 'all');
      if (month !== 'all' && !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month 格式應為 YYYY-MM 或 all' });
      const trips = db.prepare('SELECT * FROM trips WHERE user_id=? AND (?=\'all\' OR substr(date_start,1,7)=?) ORDER BY date_start,time_start').all(uid, month, month);
      if (!trips.length) return res.status(404).json({ error: '該期間沒有資料' });
      const stmt = db.prepare('SELECT * FROM receipts WHERE trip_id=? ORDER BY id');
      await streamZip(res, { user, trips, receiptsOf: (id) => stmt.all(id), label: month });
    } catch (e) { next(e); }
  });

  // ---------- 管理者 ----------
  app.get('/api/admin/users', auth, adminOnly, (req, res) => {
    res.json({ users: db.prepare(`SELECT id,company,department,emp_no,name,email,phone,role,created_at,
      (SELECT COUNT(*) FROM trips WHERE user_id=users.id) AS trip_count FROM users ORDER BY company,department,emp_no`).all() });
  });

  app.put('/api/admin/users/:id', auth, adminOnly, (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(Number(req.params.id));
    if (!u) return res.status(404).json({ error: '找不到員工' });
    const b = req.body || {};
    const d = { ...u };
    for (const k of ['company', 'department', 'emp_no', 'name', 'email', 'phone']) if (b[k] !== undefined) { d[k] = String(b[k]).trim(); if (!d[k]) return res.status(400).json({ error: `${k} 不可空白` }); }
    if (b.role !== undefined && ['employee', 'admin'].includes(b.role) && u.id !== req.user.id) d.role = b.role;
    if (b.password) { if (String(b.password).length < 8) return res.status(400).json({ error: '密碼至少 8 碼' }); d.password_hash = bcrypt.hashSync(String(b.password), 10); }
    try {
      db.prepare('UPDATE users SET company=@company,department=@department,emp_no=@emp_no,name=@name,email=@email,phone=@phone,role=@role,password_hash=@password_hash WHERE id=@id').run(d);
    } catch (e) { if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'EMAIL 或員工編號重複' }); throw e; }
    if (b.password) db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
    res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(u.id)) });
  });

  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: '照片過大（上限 20MB）' });
    res.status(500).json({ error: '伺服器錯誤' });
  });
  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => console.log(`差旅費報告系統已啟動：http://localhost:${port}`));
}

module.exports = { createApp };
