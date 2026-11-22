'use strict';
// SQLite 연결 (Node.js 내장 node:sqlite 사용, 별도 DB 서버 불필요)
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_PATH = path.join(__dirname, '..', 'data', 'worldtour.db');

function openDb(file = process.env.DB_PATH || DEFAULT_PATH) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  db.file = file;
  return db;
}

// 이전 버전으로 만든 DB 파일에 새 컬럼 추가 (CREATE TABLE IF NOT EXISTS는 기존 테이블을 바꾸지 않으므로)
function migrate(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(bookings)').all().map(c => c.name));
  [['pay_method', 'TEXT'], ['pay_info', 'TEXT'], ['pay_approval', 'TEXT'], ['paid_at', 'TEXT'], ['refunded_at', 'TEXT']]
    .forEach(([c, t]) => { if (!cols.has(c)) db.exec(`ALTER TABLE bookings ADD COLUMN ${c} ${t}`); });
  const smsCols = new Set(db.prepare('PRAGMA table_info(sms_log)').all().map(c => c.name));
  [['status', "TEXT NOT NULL DEFAULT 'simulated'"], ['provider_id', 'TEXT'], ['error', 'TEXT'], ['sent_at', 'TEXT']]
    .forEach(([c, t]) => { if (!smsCols.has(c)) db.exec(`ALTER TABLE sms_log ADD COLUMN ${c} ${t}`); });
}

// 트랜잭션: fn 안에서 오류가 나면 전부 되돌린다. (중첩 호출 시 바깥 트랜잭션에 합류)
function tx(db, fn) {
  if (db.inTx) return fn();
  db.exec('BEGIN IMMEDIATE');
  db.inTx = true;
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.inTx = false;
  }
}

module.exports = { openDb, tx, DEFAULT_PATH };
