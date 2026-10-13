'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { CATEGORIES } = require('./calc');

function open(file = process.env.DB_PATH || 'data/trip.db') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company TEXT NOT NULL,
      department TEXT NOT NULL,
      emp_no TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      phone TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('employee','admin')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (company, emp_no)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date_start TEXT NOT NULL,
      time_start TEXT NOT NULL DEFAULT '08:30',
      date_end TEXT NOT NULL,
      time_end TEXT NOT NULL DEFAULT '17:30',
      leave_type TEXT NOT NULL DEFAULT '出差',
      hours REAL NOT NULL DEFAULT 8,
      purpose TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      mileage REAL NOT NULL DEFAULT 0,
      ${CATEGORIES.map((c) => `${c} REAL NOT NULL DEFAULT 0`).join(',\n      ')},
      remark TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_trips_user_date ON trips(user_id, date_start);
    CREATE TABLE IF NOT EXISTS receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      mime TEXT NOT NULL DEFAULT 'image/jpeg',
      image BLOB NOT NULL,
      ocr_engine TEXT,
      ocr_text TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_receipts_trip ON receipts(trip_id);
  `);
  return db;
}

module.exports = { open };
