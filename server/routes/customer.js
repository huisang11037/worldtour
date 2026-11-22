'use strict';
// 고객용 API: 상품 카탈로그, 출발일, 회원가입/로그인, 예약, 이전 여행 목록, 문자함
const express = require('express');
const rules = require('../rules');
const { hashPassword, verifyPassword, createSession, destroySession, requireLogin } = require('../auth');
const { HttpError, bad, nowStamp } = require('../util');

const userView = (u, db) => ({
  id: u.login_id, name: u.name, address: u.address, phone: u.phone, role: u.role,
  createdAt: String(u.created_at).slice(0, 10), tier: u.role === 'customer' ? rules.tierOf(db, u.id) : null
});

module.exports = function customerRoutes(db) {
  const r = express.Router();

  /* ---------- 상품 ---------- */
  // 판매 중인 테마·여행지·등급·옵션 가격표
  r.get('/catalog', (req, res) => res.json(Object.assign(rules.loadCatalog(db), { payMethods: rules.PAY_METHODS, banks: rules.BANKS, easypay: rules.EASYPAY })));

  // 테마+여행지의 출발일별 신청 현황
  r.get('/departures', (req, res) => {
    const cat = rules.loadCatalog(db);
    res.json(rules.customerDepartures(db, cat, String(req.query.theme || ''), String(req.query.dest || '')));
  });

  // 가격 견적 (서버 기준 계산, 로그인하면 단골 할인 반영)
  r.post('/quote', (req, res) => {
    const cat = rules.loadCatalog(db);
    const b = rules.validateBookingInput(cat, req.body);
    const tier = req.user && req.user.role === 'customer' ? rules.tierOf(db, req.user.id) : null;
    res.json(Object.assign(rules.calc(cat, b, tier ? tier.rate : 0), { rate: tier ? tier.rate : 0 }));
  });

  /* ---------- 회원 ---------- */
  r.post('/auth/signup', (req, res) => {
    const v = k => String((req.body || {})[k] || '').trim();
    const id = v('uid'), pw = String((req.body || {}).upw || ''), name = v('uname'), addr = v('uaddr');
    const phoneRaw = v('uphone').replace(/[^0-9]/g, '');
    const errs = {};
    if (!/^[A-Za-z0-9_]{3,16}$/.test(id)) errs.uid = '영문, 숫자 3–16자로 입력해 주세요.';
    else if (db.prepare('SELECT 1 FROM users WHERE login_id = ?').get(id)) errs.uid = '이미 사용 중인 아이디입니다.';
    if (pw.length < 4) errs.upw = '비밀번호를 4자 이상 입력해 주세요.';
    if (!name) errs.uname = '성명을 입력해 주세요.';
    if (!addr) errs.uaddr = '주소를 입력해 주세요.';
    if (!/^01\d{8,9}$/.test(phoneRaw)) errs.uphone = '휴대전화 번호를 010-1234-5678 형식으로 입력해 주세요.';
    if (Object.keys(errs).length) throw bad(Object.values(errs)[0], { fields: errs });
    const phone = phoneRaw.length === 11
      ? `${phoneRaw.slice(0, 3)}-${phoneRaw.slice(3, 7)}-${phoneRaw.slice(7)}`
      : `${phoneRaw.slice(0, 3)}-${phoneRaw.slice(3, 6)}-${phoneRaw.slice(6)}`;
    const info = db.prepare(`INSERT INTO users (login_id, pw_hash, name, address, phone, role, created_at)
      VALUES (?, ?, ?, ?, ?, 'customer', ?)`).run(id, hashPassword(pw), name, addr, phone, nowStamp());
    createSession(db, res, Number(info.lastInsertRowid));
    res.status(201).json({ user: userView(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid), db) });
  });

  r.post('/auth/login', (req, res) => {
    const id = String((req.body || {}).uid || '').trim(), pw = String((req.body || {}).upw || '');
    if (!id || !pw) throw bad('아이디와 비밀번호를 입력해 주세요.');
    const u = db.prepare('SELECT * FROM users WHERE login_id = ?').get(id);
    if (!u || !verifyPassword(pw, u.pw_hash)) throw new HttpError(401, '아이디 또는 비밀번호가 맞지 않습니다. 다시 확인해 주세요.');
    createSession(db, res, u.id);
    res.json({ user: userView(u, db) });
  });

  r.post('/auth/logout', (req, res) => { destroySession(db, req, res); res.json({ ok: true }); });

  // 현재 로그인한 회원 (로그인 안 했으면 user: null)
  r.get('/me', (req, res) => {
    res.json({ user: req.user ? userView(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id), db) : null });
  });

  /* ---------- 예약 ---------- */
  // 내 예약·여행 내역 (출발일 최근 순)
  r.get('/me/bookings', requireLogin, (req, res) => {
    const cat = rules.loadCatalog(db, { includeInactive: true });
    const rows = db.prepare(`${rules.BOOKING_SELECT} WHERE b.user_id = ? ORDER BY dp.depart_date DESC, b.id DESC`).all(req.user.id);
    res.json(rows.map(row => rules.toBookingView(db, cat, row)));
  });

  r.post('/bookings', requireLogin, (req, res) => {
    if (req.user.role !== 'customer') throw new HttpError(403, '고객 계정으로만 예약할 수 있습니다.');
    res.status(201).json(rules.createBooking(db, req.user, req.body || {}));
  });

  r.post('/bookings/:id/cancel', requireLogin, (req, res) => {
    res.json(rules.cancelBooking(db, req.user, req.params.id));
  });

  /* ---------- 문자함 (발송 시뮬레이션) ---------- */
  r.get('/me/sms', requireLogin, (req, res) => {
    const unread = req.query.unread === '1' ? 'AND read_at IS NULL' : '';
    res.json(db.prepare(`SELECT id, phone, booking_id AS bookingId, kind, message, created_at AS createdAt, read_at AS readAt
      FROM sms_log WHERE user_id = ? ${unread} ORDER BY id DESC LIMIT 50`).all(req.user.id));
  });
  r.post('/me/sms/read', requireLogin, (req, res) => {
    db.prepare('UPDATE sms_log SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(nowStamp(), req.user.id);
    res.json({ ok: true });
  });

  return r;
};
