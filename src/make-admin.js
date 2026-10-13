'use strict';
// 用法：npm run make-admin -- someone@example.com
const { open } = require('./db');
const email = process.argv[2];
if (!email) { console.error('用法：npm run make-admin -- <email>'); process.exit(1); }
const r = open().prepare("UPDATE users SET role='admin' WHERE email=?").run(email);
console.log(r.changes ? `${email} 已設為管理者` : '找不到該 EMAIL');
