'use strict';
// 직원용 API: 운영 현황, 출발 일정·예약 관리, 여행 상품 기획, 가격표, 창고 물품(재고), 고객, 문자 기록
const express = require('express');
const rules = require('../rules');
const { tx } = require('../db');
const { requireStaff } = require('../auth');
const { HttpError, bad, nowStamp, todayKey, toKey, addDays, today, isDateKey } = require('../util');
const { seed } = require('../seed');

const int = (v, name, { min = 0, max = 1e9 } = {}) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${name} 값을 확인해 주세요. (${min} ~ ${max.toLocaleString('ko-KR')})`);
  return n;
};
const text = (v, name, { max = 100, required = true } = {}) => {
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (required && !s) throw bad(`${name}을(를) 입력해 주세요.`);
  if (s.length > max) throw bad(`${name}은(는) ${max}자 이내로 입력해 주세요.`);
  return s;
};
const slug = (v, name) => {
  const s = String(v || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{1,23}$/.test(s)) throw bad(`${name}는 영문 소문자로 시작하는 2–24자(영문·숫자·-)로 입력해 주세요.`);
  return s;
};

module.exports = function staffRoutes(db) {
  const r = express.Router();
  r.use(requireStaff);

  // 출발 일정 행 → 화면용 객체
  const depView = (cat, row) => {
    const t = cat.themes[row.theme_code];
    const s = rules.departureStats(db, row.id);
    const money = db.prepare("SELECT COALESCE(SUM(total), 0) AS revenue FROM bookings WHERE departure_id = ? AND status = 'booked'").get(row.id);
    return {
      id: row.id, theme: row.theme_code, themeName: t ? t.name : row.theme_code, dest: row.dest_code, destName: row.dest_name, region: row.region,
      date: row.depart_date, status: row.status, confirmedAt: row.confirmed_at, memo: row.memo,
      count: s.count, teams: s.teams, progress: t ? rules.progressOf(t, s) : s.count, min: t ? t.confirmMin : 0, unit: t ? t.confirmUnit : 'person',
      revenue: money.revenue,
      item: t && t.item ? { name: t.item.name, unit: t.item.unit, need: s.count * t.item.perPerson } : null
    };
  };
  const DEP_SELECT = `SELECT dp.*, d.code AS dest_code, d.name AS dest_name, d.region, d.theme_code
    FROM departures dp JOIN destinations d ON d.id = dp.destination_id`;

  /* ---------- 운영 현황 대시보드 ---------- */
  r.get('/summary', (req, res) => {
    rules.ensureDepartures(db);
    const cat = rules.loadCatalog(db, { includeInactive: true });
    const tk = todayKey(), week = toKey(addDays(today(), 7));
    const active = db.prepare(`${DEP_SELECT} WHERE dp.depart_date >= ? AND dp.status != 'closed'
      AND EXISTS (SELECT 1 FROM bookings b WHERE b.departure_id = dp.id AND b.status = 'booked') ORDER BY dp.depart_date`).all(tk)
      .map(row => depView(cat, row));
    const items = db.prepare('SELECT * FROM items ORDER BY id').all();
    const reserved = db.prepare(`SELECT t.item_id, COALESCE(SUM(b.pax * t.item_per_person), 0) AS qty
      FROM bookings b JOIN departures dp ON dp.id = b.departure_id JOIN destinations d ON d.id = dp.destination_id JOIN themes t ON t.code = d.theme_code
      WHERE b.status = 'booked' AND dp.status = 'open' AND dp.depart_date >= ? AND t.item_id IS NOT NULL GROUP BY t.item_id`).all(tk);
    const pending = Object.fromEntries(reserved.map(x => [x.item_id, x.qty]));
    res.json({
      today: tk,
      departures: {
        active: active.length,
        confirmed: active.filter(d => d.status === 'confirmed').length,
        waiting: active.filter(d => d.status === 'open').length,
        pax: active.reduce((s, d) => s + d.count, 0),
        revenue: active.reduce((s, d) => s + d.revenue, 0)
      },
      // 7일 이내 출발인데 아직 인원 미달인 일정
      urgent: active.filter(d => d.status === 'open' && d.date <= week),
      upcoming: active.slice(0, 8),
      customers: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'customer'").get().n,
      newBookings7d: db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE created_at >= ?").get(toKey(addDays(today(), -7))).n,
      lowStock: items.filter(i => i.stock - (pending[i.id] || 0) <= i.safety_stock)
        .map(i => ({ id: i.id, name: i.name, unit: i.unit, stock: i.stock, safety: i.safety_stock, pending: pending[i.id] || 0 }))
    });
  });

  /* ---------- 출발 일정 ---------- */
  // ?scope=upcoming|past|all & status=open|confirmed|closed & theme=code & booked=1(신청 있는 일정만)
  r.get('/departures', (req, res) => {
    rules.ensureDepartures(db);
    const cat = rules.loadCatalog(db, { includeInactive: true });
    const where = [], args = [];
    const scope = req.query.scope || 'upcoming';
    if (scope === 'upcoming') { where.push('dp.depart_date >= ?'); args.push(todayKey()); }
    if (scope === 'past') { where.push('dp.depart_date < ?'); args.push(todayKey()); }
    if (['open', 'confirmed', 'closed'].includes(req.query.status)) { where.push('dp.status = ?'); args.push(req.query.status); }
    if (req.query.theme) { where.push('d.theme_code = ?'); args.push(String(req.query.theme)); }
    if (req.query.booked === '1') where.push("EXISTS (SELECT 1 FROM bookings b WHERE b.departure_id = dp.id AND b.status = 'booked')");
    const order = scope === 'past' ? 'DESC' : 'ASC';
    const rows = db.prepare(`${DEP_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY dp.depart_date ${order}, d.theme_code, d.sort LIMIT 300`).all(...args);
    res.json(rows.map(row => depView(cat, row)));
  });

  // 출발 일정 상세 + 예약자 명단
  r.get('/departures/:id', (req, res) => {
    const cat = rules.loadCatalog(db, { includeInactive: true });
    const row = db.prepare(`${DEP_SELECT} WHERE dp.id = ?`).get(Number(req.params.id));
    if (!row) throw new HttpError(404, '출발 일정을 찾을 수 없습니다.');
    const bookings = db.prepare(`${rules.BOOKING_SELECT} WHERE b.departure_id = ? ORDER BY b.status, b.created_at`).all(row.id)
      .map(b => {
        const u = db.prepare('SELECT login_id, name, phone FROM users WHERE id = ?').get(b.user_id);
        return Object.assign(rules.toBookingView(db, cat, b), { customer: { id: u.login_id, name: u.name, phone: u.phone } });
      });
    res.json(Object.assign(depView(cat, row), { bookings }));
  });

  // 상품 기획: 출발일 추가 (정기 토요일 외 특별 출발)
  r.post('/departures', (req, res) => {
    const cat = rules.loadCatalog(db, { includeInactive: true });
    const b = req.body || {};
    const t = cat.themes[b.theme];
    if (!t) throw bad('테마를 선택해 주세요.');
    const dest = t.dests.find(d => d.id === b.dest);
    if (!dest) throw bad('여행지를 선택해 주세요.');
    if (!isDateKey(b.date)) throw bad('출발일을 YYYY-MM-DD 형식으로 입력해 주세요.');
    if (b.date <= todayKey()) throw bad('출발일은 내일 이후로 지정해 주세요.');
    const exists = db.prepare('SELECT id, status FROM departures WHERE destination_id = ? AND depart_date = ?').get(dest.dbId, b.date);
    if (exists && exists.status !== 'closed') throw bad('이미 같은 날짜의 출발 일정이 있습니다.');
    if (exists) {
      db.prepare("UPDATE departures SET status = 'open', memo = ?, confirmed_at = NULL WHERE id = ?").run(text(b.memo, '메모', { required: false }), exists.id);
      return res.status(201).json({ id: exists.id, reopened: true });
    }
    const info = db.prepare('INSERT INTO departures (destination_id, depart_date, memo, created_at) VALUES (?, ?, ?, ?)')
      .run(dest.dbId, b.date, text(b.memo, '메모', { required: false }), nowStamp());
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  });

  // 출발 일정 운영 취소 (예약 전부 취소 + 문자 + 기념품 반납)
  r.post('/departures/:id/close', (req, res) => {
    const cat = rules.loadCatalog(db, { includeInactive: true });
    res.json(rules.closeDeparture(db, cat, Number(req.params.id), text((req.body || {}).memo, '취소 사유', { required: false })));
  });

  // 개별 예약 취소 (고객 요청 대행)
  r.post('/bookings/:id/cancel', (req, res) => res.json(rules.cancelBooking(db, req.user, req.params.id)));

  /* ---------- 여행 상품 기획 (테마·여행지) ---------- */
  r.get('/themes', (req, res) => {
    const cat = rules.loadCatalog(db, { includeInactive: true });
    const cnt = db.prepare(`SELECT COUNT(*) AS n FROM bookings b JOIN departures dp ON dp.id = b.departure_id
      JOIN destinations d ON d.id = dp.destination_id WHERE d.theme_code = ? AND b.status = 'booked' AND dp.depart_date >= ?`);
    res.json({
      themes: Object.values(cat.themes).map(t => Object.assign({}, t, { activeBookings: cnt.get(t.id, todayKey()).n })),
      styles: cat.styles, styleOrder: cat.styleOrder, vehicles: cat.vehicles, vehicleOrder: cat.vehicleOrder,
      items: db.prepare('SELECT id, name, unit FROM items ORDER BY id').all()
    });
  });

  // 테마 입력값 검사 (생성·수정 공통)
  function themeFields(cat, b, partial) {
    const out = {};
    const has = k => !partial || b[k] !== undefined;
    if (has('name')) out.name = text(b.name, '상품명', { max: 40 });
    if (has('en')) out.en = text(b.en, '영문명', { max: 60 });
    if (has('who')) out.who = text(b.who, '동행 대상', { max: 40, required: false });
    if (has('base')) out.base_price = int(b.base, '1인 기본가', { max: 100000000 });
    if (has('minStyle')) { if (!cat.styles[b.minStyle]) throw bad('최소 등급을 선택해 주세요.'); out.min_style = b.minStyle; }
    if (has('fixedPax')) out.fixed_pax = int(b.fixedPax, '고정 인원', { max: 10 });
    if (has('maxPax')) out.max_pax = int(b.maxPax, '최대 인원', { min: 1, max: 30 });
    if (has('vehicle')) { if (!cat.vehicles[b.vehicle]) throw bad('기본 차량을 선택해 주세요.'); out.default_vehicle = b.vehicle; }
    if (has('confirmUnit')) { if (!['person', 'team'].includes(b.confirmUnit)) throw bad('출발 확정 기준을 선택해 주세요.'); out.confirm_unit = b.confirmUnit; }
    if (has('confirmMin')) out.confirm_min = int(b.confirmMin, '출발 확정 최소 인원/팀', { min: 1, max: 50 });
    if (has('itemId')) {
      if (b.itemId === null || b.itemId === '') out.item_id = null;
      else if (!db.prepare('SELECT 1 FROM items WHERE id = ?').get(Number(b.itemId))) throw bad('기념품을 선택해 주세요.');
      else out.item_id = Number(b.itemId);
    }
    if (has('itemPerPerson')) out.item_per_person = int(b.itemPerPerson, '1인당 기념품 수량', { max: 10 });
    if (has('active')) out.active = b.active ? 1 : 0;
    if (has('sort')) out.sort = int(b.sort, '정렬 순서', { max: 999 });
    return out;
  }
  function saveServices(code, services) {
    if (services === undefined) return;
    if (!Array.isArray(services)) throw bad('제공 서비스 목록을 확인해 주세요.');
    const list = services.map(s => text(s, '제공 서비스', { max: 60, required: false })).filter(Boolean);
    db.prepare('DELETE FROM theme_services WHERE theme_code = ?').run(code);
    const ins = db.prepare('INSERT INTO theme_services (theme_code, sort, text) VALUES (?, ?, ?)');
    list.forEach((s, i) => ins.run(code, i + 1, s));
  }
  // 확정 기준이 바뀌면 모집 중인 일정을 다시 검사해 조건을 만족한 일정은 바로 확정
  function recheckTheme(code) {
    const cat = rules.loadCatalog(db, { includeInactive: true });
    const ids = db.prepare(`SELECT dp.id FROM departures dp JOIN destinations d ON d.id = dp.destination_id
      WHERE d.theme_code = ? AND dp.status = 'open' AND dp.depart_date > ?`).all(code, todayKey());
    return ids.map(x => rules.confirmIfReady(db, cat, x.id)).filter(Boolean).length;
  }

  r.post('/themes', (req, res) => {
    const b = req.body || {};
    const out = tx(db, () => {
      const cat = rules.loadCatalog(db, { includeInactive: true });
      const code = slug(b.code, '상품 코드');
      if (db.prepare('SELECT 1 FROM themes WHERE code = ?').get(code)) throw bad('이미 사용 중인 상품 코드입니다.');
      const f = Object.assign({ who: '', fixed_pax: 0, max_pax: 10, confirm_unit: 'person', confirm_min: 3, item_id: null, item_per_person: 1, active: 1,
        sort: db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM themes').get().n }, themeFields(cat, b, false));
      const cols = Object.keys(f);
      db.prepare(`INSERT INTO themes (code, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`).run(code, ...cols.map(c => f[c]));
      saveServices(code, b.services || []);
      return { code };
    });
    rules.resetEnsureCache();
    res.status(201).json(out);
  });

  r.patch('/themes/:code', (req, res) => {
    const code = req.params.code;
    const out = tx(db, () => {
      const cat = rules.loadCatalog(db, { includeInactive: true });
      if (!cat.themes[code]) throw new HttpError(404, '상품을 찾을 수 없습니다.');
      const f = themeFields(cat, req.body || {}, true);
      const cols = Object.keys(f);
      if (cols.length) db.prepare(`UPDATE themes SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE code = ?`).run(...cols.map(c => f[c]), code);
      saveServices(code, (req.body || {}).services);
      return { code, newlyConfirmed: recheckTheme(code) };
    });
    rules.resetEnsureCache();
    res.json(out);
  });

  r.post('/themes/:code/destinations', (req, res) => {
    const code = req.params.code, b = req.body || {};
    if (!db.prepare('SELECT 1 FROM themes WHERE code = ?').get(code)) throw new HttpError(404, '상품을 찾을 수 없습니다.');
    const dc = slug(b.code, '여행지 코드');
    if (db.prepare('SELECT 1 FROM destinations WHERE theme_code = ? AND code = ?').get(code, dc)) throw bad('이 상품에 이미 있는 여행지 코드입니다.');
    if (!['국내', '해외'].includes(b.region)) throw bad('지역(국내/해외)을 선택해 주세요.');
    const info = db.prepare(`INSERT INTO destinations (theme_code, code, name, region, extra_price, sort)
      VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM destinations WHERE theme_code = ?))`)
      .run(code, dc, text(b.name, '여행지 이름', { max: 30 }), b.region, int(b.extra, '여행지 추가요금', { max: 100000000 }), code);
    rules.resetEnsureCache();
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  });

  r.patch('/destinations/:id', (req, res) => {
    const b = req.body || {}, id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM destinations WHERE id = ?').get(id)) throw new HttpError(404, '여행지를 찾을 수 없습니다.');
    const f = {};
    if (b.name !== undefined) f.name = text(b.name, '여행지 이름', { max: 30 });
    if (b.region !== undefined) { if (!['국내', '해외'].includes(b.region)) throw bad('지역(국내/해외)을 선택해 주세요.'); f.region = b.region; }
    if (b.extra !== undefined) f.extra_price = int(b.extra, '여행지 추가요금', { max: 100000000 });
    if (b.active !== undefined) f.active = b.active ? 1 : 0;
    const cols = Object.keys(f);
    if (cols.length) db.prepare(`UPDATE destinations SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map(c => f[c]), id);
    rules.resetEnsureCache();
    res.json({ id });
  });

  /* ---------- 옵션 가격표 ---------- */
  r.get('/prices', (req, res) => {
    res.json({
      hotels: db.prepare('SELECT grade AS code, name, price FROM hotels ORDER BY grade').all(),
      meals: db.prepare('SELECT code, name, price FROM meals ORDER BY sort').all(),
      vehicles: db.prepare('SELECT code, name, price, capacity FROM vehicles ORDER BY sort').all(),
      addons: db.prepare('SELECT code, name, price FROM addons ORDER BY sort').all()
    });
  });
  // body: { hotels: { "3": 60000 }, meals: { local: 40000 }, vehicles: {...}, addons: {...} }
  r.put('/prices', (req, res) => {
    const b = req.body || {};
    const TABLE = { hotels: ['hotels', 'grade'], meals: ['meals', 'code'], vehicles: ['vehicles', 'code'], addons: ['addons', 'code'] };
    let n = 0;
    tx(db, () => Object.entries(TABLE).forEach(([k, [table, key]]) => {
      Object.entries(b[k] || {}).forEach(([code, price]) => {
        const r2 = db.prepare(`UPDATE ${table} SET price = ? WHERE ${key} = ?`).run(int(price, '가격', { max: 100000000 }), key === 'grade' ? Number(code) : code);
        if (!r2.changes) throw bad(`알 수 없는 옵션입니다: ${code}`);
        n += 1;
      });
    }));
    res.json({ updated: n });
  });

  /* ---------- 창고 물품 (기념품 재고) ---------- */
  r.get('/items', (req, res) => {
    const tk = todayKey();
    const items = db.prepare('SELECT * FROM items ORDER BY id').all();
    const themes = db.prepare('SELECT code, name, item_id FROM themes').all();
    const pending = db.prepare(`SELECT COALESCE(SUM(b.pax * t.item_per_person), 0) AS qty FROM bookings b
      JOIN departures dp ON dp.id = b.departure_id JOIN destinations d ON d.id = dp.destination_id JOIN themes t ON t.code = d.theme_code
      WHERE t.item_id = ? AND b.status = 'booked' AND dp.status = 'open' AND dp.depart_date >= ?`);
    res.json(items.map(i => ({
      id: i.id, code: i.code, name: i.name, unit: i.unit, stock: i.stock, safety: i.safety_stock, createdAt: i.created_at,
      themes: themes.filter(t => t.item_id === i.id).map(t => t.name),
      pending: pending.get(i.id, tk).qty  // 모집 중 예약이 확정되면 출고될 예정 수량
    })));
  });

  r.post('/items', (req, res) => {
    const b = req.body || {};
    const code = b.code ? slug(b.code, '물품 코드') : `item-${Date.now().toString(36)}`;
    if (db.prepare('SELECT 1 FROM items WHERE code = ?').get(code)) throw bad('이미 사용 중인 물품 코드입니다.');
    const out = tx(db, () => {
      const info = db.prepare('INSERT INTO items (code, name, unit, stock, safety_stock, created_at) VALUES (?, ?, ?, 0, ?, ?)')
        .run(code, text(b.name, '물품명', { max: 40 }), text(b.unit || '개', '단위', { max: 10 }), int(b.safety === undefined ? 10 : b.safety, '안전 재고', { max: 100000 }), nowStamp());
      const id = Number(info.lastInsertRowid);
      const qty = int(b.stock || 0, '초기 수량', { max: 100000 });
      if (qty > 0) rules.moveStock(db, id, qty, 'in', { staffId: req.user.id, memo: '신규 등록 입고' });
      return { id };
    });
    res.status(201).json(out);
  });

  r.patch('/items/:id', (req, res) => {
    const b = req.body || {}, id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM items WHERE id = ?').get(id)) throw new HttpError(404, '물품을 찾을 수 없습니다.');
    const f = {};
    if (b.name !== undefined) f.name = text(b.name, '물품명', { max: 40 });
    if (b.unit !== undefined) f.unit = text(b.unit, '단위', { max: 10 });
    if (b.safety !== undefined) f.safety_stock = int(b.safety, '안전 재고', { max: 100000 });
    const cols = Object.keys(f);
    if (cols.length) db.prepare(`UPDATE items SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map(c => f[c]), id);
    res.json({ id });
  });

  // 입고(kind=in, qty>0) 또는 재고 조정(kind=adjust, qty ±)
  r.post('/items/:id/moves', (req, res) => {
    const b = req.body || {}, id = Number(req.params.id);
    const item = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
    if (!item) throw new HttpError(404, '물품을 찾을 수 없습니다.');
    const kind = b.kind === 'adjust' ? 'adjust' : 'in';
    const qty = kind === 'in' ? int(b.qty, '입고 수량', { min: 1, max: 100000 }) : int(b.qty, '조정 수량', { min: -100000, max: 100000 });
    if (qty === 0) throw bad('조정 수량을 입력해 주세요.');
    if (kind === 'adjust' && item.stock + qty < 0) throw bad(`현재 재고(${item.stock}${item.unit})보다 많이 줄일 수 없습니다.`);
    const memo = text(b.memo, '메모', { max: 100, required: kind === 'adjust' });
    tx(db, () => rules.moveStock(db, id, qty, kind, { staffId: req.user.id, memo: memo || '입고' }));
    res.status(201).json({ id, stock: db.prepare('SELECT stock FROM items WHERE id = ?').get(id).stock });
  });

  r.get('/stock-moves', (req, res) => {
    const where = req.query.item ? 'WHERE m.item_id = ?' : '';
    const args = req.query.item ? [Number(req.query.item)] : [];
    res.json(db.prepare(`SELECT m.id, m.item_id AS itemId, i.name AS itemName, i.unit, m.qty, m.kind, m.booking_id AS bookingId,
      m.memo, m.created_at AS createdAt, u.name AS staffName
      FROM stock_moves m JOIN items i ON i.id = m.item_id LEFT JOIN users u ON u.id = m.staff_id ${where}
      ORDER BY m.id DESC LIMIT 200`).all(...args));
  });

  /* ---------- 고객 ---------- */
  r.get('/customers', (req, res) => {
    const rows = db.prepare(`SELECT u.id, u.login_id, u.name, u.address, u.phone, u.created_at,
      (SELECT COUNT(*) FROM bookings b WHERE b.user_id = u.id AND b.status = 'booked') AS bookings,
      (SELECT COALESCE(SUM(total), 0) FROM bookings b WHERE b.user_id = u.id AND b.status = 'booked') AS spent,
      (SELECT MAX(dp.depart_date) FROM bookings b JOIN departures dp ON dp.id = b.departure_id WHERE b.user_id = u.id AND b.status = 'booked') AS lastTrip
      FROM users u WHERE u.role = 'customer' ORDER BY u.created_at`).all();
    res.json(rows.map(u => ({
      id: u.login_id, name: u.name, address: u.address, phone: u.phone, createdAt: u.created_at.slice(0, 10),
      bookings: u.bookings, spent: u.spent, lastTrip: u.lastTrip, tier: rules.tierOf(db, u.id)
    })));
  });

  r.get('/customers/:loginId/bookings', (req, res) => {
    const u = db.prepare("SELECT id FROM users WHERE login_id = ? AND role = 'customer'").get(req.params.loginId);
    if (!u) throw new HttpError(404, '고객을 찾을 수 없습니다.');
    const cat = rules.loadCatalog(db, { includeInactive: true });
    res.json(db.prepare(`${rules.BOOKING_SELECT} WHERE b.user_id = ? ORDER BY dp.depart_date DESC`).all(u.id).map(b => rules.toBookingView(db, cat, b)));
  });

  /* ---------- 문자 발송 기록 ---------- */
  r.get('/sms', (req, res) => {
    res.json(db.prepare(`SELECT s.id, s.phone, s.booking_id AS bookingId, s.kind, s.message, s.created_at AS createdAt, s.read_at AS readAt, u.name
      FROM sms_log s JOIN users u ON u.id = s.user_id ORDER BY s.id DESC LIMIT 200`).all());
  });

  /* ---------- 데모 데이터 초기화 ---------- */
  r.post('/reset', (req, res) => {
    seed(db);
    rules.resetEnsureCache();
    res.json({ ok: true });
  });

  return r;
};
