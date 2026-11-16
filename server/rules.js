'use strict';
// 업무 규칙: 상품 카탈로그, 가격 계산, 예약 검증, 출발 확정, 기념품 재고 배정, 단골 할인
const { tx } = require('./db');
const { toKey, fromKey, addDays, today, todayKey, nowStamp, upcomingSaturdays, won, HttpError, bad } = require('./util');

const NIGHTS = [2, 3, 4, 5];       // 선택 가능한 여행 기간 (박)
const LEAD_DAYS = 3;               // 출발 N일 전까지 예약 가능
const AUTO_DEPARTURE_WEEKS = 8;    // 자동 생성하는 토요일 출발 일정 수

/* ───────────── 카탈로그 (DB → 고객 화면용 구조) ───────────── */
// 고객 GUI 프로토타입이 쓰던 THEMES/STYLES/HOTELS/... 구조와 같은 모양으로 돌려준다.
function loadCatalog(db, { includeInactive = false } = {}) {
  const hotels = {}, meals = {}, vehicles = {}, addons = {}, styles = {};
  db.prepare('SELECT * FROM hotels ORDER BY grade').all()
    .forEach(h => { hotels[h.grade] = { name: h.name, short: h.short, price: h.price }; });
  const mealRows = db.prepare('SELECT * FROM meals ORDER BY sort, level').all();
  mealRows.forEach(m => { meals[m.code] = { name: m.name, short: m.short, price: m.price, lv: m.level, champagne: !!m.includes_champagne }; });
  const vehRows = db.prepare('SELECT * FROM vehicles ORDER BY sort').all();
  vehRows.forEach(v => { vehicles[v.code] = { name: v.name, short: v.short, cap: v.capacity, price: v.price }; });
  db.prepare('SELECT * FROM addons ORDER BY sort').all()
    .forEach(a => { addons[a.code] = { name: a.name, price: a.price }; });
  const styleRows = db.prepare('SELECT * FROM tour_styles ORDER BY rank').all();
  styleRows.forEach(s => { styles[s.code] = { name: s.name, en: s.en, hotel: s.hotel_grade, meal: s.meal_code, rank: s.rank }; });

  const themes = {};
  const themeRows = db.prepare(`SELECT t.*, i.name AS item_name, i.unit AS item_unit
    FROM themes t LEFT JOIN items i ON i.id = t.item_id ${includeInactive ? '' : 'WHERE t.active = 1'} ORDER BY t.sort, t.code`).all();
  const svc = db.prepare('SELECT text FROM theme_services WHERE theme_code = ? ORDER BY sort, id');
  const dst = db.prepare(`SELECT * FROM destinations WHERE theme_code = ? ${includeInactive ? '' : 'AND active = 1'} ORDER BY sort, id`);
  themeRows.forEach(t => {
    themes[t.code] = {
      id: t.code, name: t.name, en: t.en, who: t.who, base: t.base_price,
      minStyle: t.min_style, fixedPax: t.fixed_pax, maxPax: t.max_pax, vehicle: t.default_vehicle,
      confirmUnit: t.confirm_unit, confirmMin: t.confirm_min,
      item: t.item_id ? { id: t.item_id, name: t.item_name, unit: t.item_unit, perPerson: t.item_per_person } : null,
      active: !!t.active, sort: t.sort,
      services: svc.all(t.code).map(r => r.text),
      dests: dst.all(t.code).map(d => ({ id: d.code, dbId: d.id, name: d.name, region: d.region, extra: d.extra_price, active: !!d.active }))
    };
  });
  return {
    themes, styles, hotels, meals, vehicles, addons,
    styleOrder: styleRows.map(s => s.code),
    mealOrder: mealRows.map(m => m.code),
    vehicleOrder: vehRows.map(v => v.code),
    nights: NIGHTS, leadDays: LEAD_DAYS
  };
}

/* ───────────── 가격 계산 ───────────── */
// 실제 과금되는 추가 메뉴 (샴페인이 포함된 식사면 샴페인 제외)
function activeAddons(cat, b) {
  return Object.keys(cat.addons).filter(k => b.addons.includes(k) && !(k === 'champagne' && cat.meals[b.meal].champagne));
}
// 할인 금액은 100원 단위 반올림
function calc(cat, b, rate) {
  const t = cat.themes[b.theme], dest = t.dests.find(x => x.id === b.dest), days = b.nights + 1, p = b.pax;
  const H = cat.hotels[b.hotel], M = cat.meals[b.meal], V = cat.vehicles[b.vehicle];
  const lines = [];
  const add = (name, amount, formula) => { if (amount > 0) lines.push({ name, amount, formula }); };
  add('테마 패키지', t.base * p, `${won(t.base)} × ${p}명`);
  add(`여행지 추가요금 (${dest.name})`, dest.extra * p, `${won(dest.extra)} × ${p}명`);
  add(`호텔 · ${H.name}`, H.price * b.nights * p, `${won(H.price)} × ${b.nights}박 × ${p}명`);
  add(`식사 · ${M.name}`, M.price * days * p, `${won(M.price)} × ${days}일 × ${p}명`);
  add(`교통 · ${V.name}`, V.price * days, `${won(V.price)} × ${days}일`);
  activeAddons(cat, b).forEach(k => {
    const A = cat.addons[k];
    add(`추가 · ${A.name}`, A.price * days * p, `${won(A.price)} × ${days}일 × ${p}명`);
  });
  const subtotal = lines.reduce((s, l) => s + l.amount, 0);
  const discount = Math.round((subtotal * rate) / 100) * 100;
  return { lines, subtotal, discount, total: subtotal - discount };
}

/* ───────────── 예약 입력 검증 ───────────── */
// 고객 화면은 규칙에 맞게 보정해서 보내지만, 서버는 잘못된 값을 보정하지 않고 거절한다.
function validateBookingInput(cat, input) {
  const b = input || {};
  const t = cat.themes[b.theme];
  if (!t) throw bad('존재하지 않거나 판매 중지된 테마입니다.');
  const dest = t.dests.find(x => x.id === b.dest);
  if (!dest) throw bad('이 테마에서 선택할 수 없는 여행지입니다.');
  const nights = Number(b.nights);
  if (!cat.nights.includes(nights)) throw bad(`여행 기간은 ${cat.nights.join('/')}박 중에서 선택해 주세요.`);
  const pax = Number(b.pax);
  if (!Number.isInteger(pax) || pax < 1) throw bad('인원을 확인해 주세요.');
  if (t.fixedPax && pax !== t.fixedPax) throw bad(`${t.name}은(는) ${t.fixedPax}인 전용 상품입니다.`);
  if (!t.fixedPax && pax > t.maxPax) throw bad(`최대 ${t.maxPax}명까지 신청할 수 있습니다.`);
  const style = cat.styles[b.style];
  if (!style) throw bad('투어 등급을 확인해 주세요.');
  const minStyle = cat.styles[t.minStyle];
  if (style.rank < minStyle.rank) throw bad(`${t.name}은(는) ${minStyle.name} 스타일 이상부터 선택할 수 있습니다.`);
  const hotel = Number(b.hotel);
  if (!cat.hotels[hotel]) throw bad('호텔 등급을 확인해 주세요.');
  if (hotel < minStyle.hotel) throw bad(`이 상품은 ${cat.hotels[minStyle.hotel].name} 이상만 선택할 수 있습니다.`);
  const meal = cat.meals[b.meal];
  if (!meal) throw bad('식사 종류를 확인해 주세요.');
  if (meal.lv < cat.meals[minStyle.meal].lv) throw bad(`이 상품은 ${cat.meals[minStyle.meal].name} 이상만 선택할 수 있습니다.`);
  const veh = cat.vehicles[b.vehicle];
  if (!veh) throw bad('교통수단을 확인해 주세요.');
  if (veh.cap < pax) throw bad(`${veh.name}은(는) ${veh.cap}명까지 탑승할 수 있습니다.`);
  const addons = Array.isArray(b.addons) ? [...new Set(b.addons.map(String))] : [];
  if (addons.some(a => !cat.addons[a])) throw bad('추가 메뉴를 확인해 주세요.');
  return {
    theme: t.id, dest: dest.id, destDbId: dest.dbId, date: String(b.date || ''), nights, pax,
    style: b.style, hotel, meal: b.meal, vehicle: b.vehicle,
    addons: addons.filter(a => !(a === 'champagne' && meal.champagne))
  };
}

/* ───────────── 출발 일정 ───────────── */
let ensuredFor = null;
// 판매 중인 모든 여행지에 대해 앞으로 8주간의 토요일 출발 일정을 만들어 둔다 (하루 한 번)
function ensureDepartures(db, force = false) {
  const key = todayKey();
  if (!force && ensuredFor === key) return;
  const dates = upcomingSaturdays(AUTO_DEPARTURE_WEEKS);
  const dests = db.prepare(`SELECT d.id FROM destinations d JOIN themes t ON t.code = d.theme_code
    WHERE d.active = 1 AND t.active = 1`).all();
  const ins = db.prepare('INSERT OR IGNORE INTO departures (destination_id, depart_date, created_at) VALUES (?, ?, ?)');
  tx(db, () => dests.forEach(d => dates.forEach(ds => ins.run(d.id, ds, nowStamp()))));
  ensuredFor = key;
}
const resetEnsureCache = () => { ensuredFor = null; };

// 출발 일정의 신청 현황 (취소 제외): 인원 수, 팀(예약) 수
function departureStats(db, departureId) {
  const r = db.prepare(`SELECT COALESCE(SUM(pax), 0) AS count, COUNT(*) AS teams
    FROM bookings WHERE departure_id = ? AND status = 'booked'`).get(departureId);
  return { count: r.count, teams: r.teams };
}
// 확정 규칙: 허니문은 '팀' 단위(2팀 이상), 그 외는 '인원' 단위(3명 이상)
const progressOf = (theme, stats) => (theme.confirmUnit === 'team' ? stats.teams : stats.count);
const unitLabel = theme => (theme.confirmUnit === 'team' ? '팀' : '명');
const ruleText = theme => `신청 ${theme.confirmMin}${unitLabel(theme)} 이상`;
const isConfirmable = (theme, stats) => progressOf(theme, stats) >= theme.confirmMin;

// 출발 일정 + 테마 정보 한 번에 읽기
function getDeparture(db, departureId) {
  return db.prepare(`SELECT dp.*, d.code AS dest_code, d.name AS dest_name, d.region, d.theme_code
    FROM departures dp JOIN destinations d ON d.id = dp.destination_id WHERE dp.id = ?`).get(departureId);
}

// 고객 화면용: 특정 테마·여행지의 예약 가능한 출발일 목록
function customerDepartures(db, cat, themeCode, destCode) {
  ensureDepartures(db);
  const t = cat.themes[themeCode];
  if (!t) throw new HttpError(404, '존재하지 않는 테마입니다.');
  const dest = t.dests.find(d => d.id === destCode);
  if (!dest) throw new HttpError(404, '존재하지 않는 여행지입니다.');
  const minDate = toKey(addDays(today(), LEAD_DAYS));
  const rows = db.prepare(`SELECT * FROM departures WHERE destination_id = ? AND status != 'closed' AND depart_date >= ?
    ORDER BY depart_date LIMIT 10`).all(dest.dbId, minDate);
  return rows.map(r => {
    const s = departureStats(db, r.id);
    return {
      id: r.id, date: r.depart_date, status: r.status, count: s.count, teams: s.teams,
      progress: progressOf(t, s), min: t.confirmMin, unit: t.confirmUnit, confirmed: r.status === 'confirmed'
    };
  });
}

/* ───────────── 기념품 재고 ───────────── */
// 재고 변동 기록 + 수량 반영
function moveStock(db, itemId, qty, kind, { bookingId = null, staffId = null, memo = '' } = {}) {
  db.prepare('UPDATE items SET stock = stock + ? WHERE id = ?').run(qty, itemId);
  db.prepare(`INSERT INTO stock_moves (item_id, qty, kind, booking_id, staff_id, memo, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(itemId, qty, kind, bookingId, staffId, memo, nowStamp());
}
// 출발이 확정된 예약에 기념품 출고 (인원 × 1인당 수량)
function allocateItems(db, theme, booking) {
  if (!theme.item || booking.items_allocated > 0) return 0;
  const qty = booking.pax * theme.item.perPerson;
  if (qty <= 0) return 0;
  moveStock(db, theme.item.id, -qty, 'out', { bookingId: booking.id, memo: `출발 확정 출고 (${theme.name})` });
  db.prepare('UPDATE bookings SET item_id = ?, items_allocated = ? WHERE id = ?').run(theme.item.id, qty, booking.id);
  return qty;
}
// 취소된 예약의 기념품 반납
function returnItems(db, booking) {
  if (!booking.item_id || booking.items_allocated <= 0) return 0;
  moveStock(db, booking.item_id, booking.items_allocated, 'return', { bookingId: booking.id, memo: '예약 취소 반납' });
  db.prepare('UPDATE bookings SET items_allocated = 0 WHERE id = ?').run(booking.id);
  return booking.items_allocated;
}

/* ───────────── 문자 (발송 시뮬레이션) ───────────── */
function sendSms(db, user, bookingId, kind, message) {
  db.prepare(`INSERT INTO sms_log (user_id, phone, booking_id, kind, message, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(user.id, user.phone, bookingId, kind, message, nowStamp());
  return { phone: user.phone, kind, message };
}
const md = ds => { const d = fromKey(ds); return `${d.getMonth() + 1}/${d.getDate()}`; };
const confirmMsg = (u, t, dep, bookingId) =>
  `[미스터월드] ${u.name}님, ${t.name}(${dep.dest_name}, ${md(dep.depart_date)} 출발) 일정의 ${ruleText(t)}이 모여 출발이 확정되었습니다. 예약번호 ${bookingId}`;
const closedMsg = (u, t, dep, bookingId, memo) =>
  `[미스터월드] ${u.name}님, ${t.name}(${dep.dest_name}, ${md(dep.depart_date)} 출발) 일정이 운영 사정으로 취소되었습니다${memo ? ` (${memo})` : ''}. 예약번호 ${bookingId} 결제 금액은 전액 환불됩니다.`;

/* ───────────── 출발 확정 처리 ───────────── */
// 확정 조건을 만족하면 출발 확정 → 모든 예약자에게 문자 + 기념품 출고
function confirmIfReady(db, cat, departureId) {
  const dep = getDeparture(db, departureId);
  if (!dep || dep.status !== 'open') return null;
  const t = cat.themes[dep.theme_code];
  if (!t || !isConfirmable(t, departureStats(db, departureId))) return null;
  db.prepare("UPDATE departures SET status = 'confirmed', confirmed_at = ? WHERE id = ?").run(nowStamp(), departureId);
  const list = db.prepare(`SELECT b.*, u.name, u.phone FROM bookings b JOIN users u ON u.id = b.user_id
    WHERE b.departure_id = ? AND b.status = 'booked' ORDER BY b.created_at`).all(departureId);
  const sms = list.map(b => {
    allocateItems(db, t, b);
    return Object.assign(sendSms(db, { id: b.user_id, name: b.name, phone: b.phone }, b.id, 'confirm', confirmMsg(b, t, dep, b.id)), { userId: b.user_id, bookingId: b.id });
  });
  return { departureId, sms };
}

/* ───────────── 단골 고객 할인 ───────────── */
// 완료된 여행(출발 확정 + 여행 종료) 수: 1–2회 5%, 3회 이상 10%
function completedTrips(db, userId) {
  const rows = db.prepare(`SELECT dp.depart_date, b.nights FROM bookings b JOIN departures dp ON dp.id = b.departure_id
    WHERE b.user_id = ? AND b.status = 'booked' AND dp.status = 'confirmed'`).all(userId);
  const t = today();
  return rows.filter(r => addDays(fromKey(r.depart_date), r.nights) < t).length;
}
function tierOf(db, userId) {
  const n = completedTrips(db, userId);
  if (n >= 3) return { name: '단골 고객', rate: 0.10, n, next: null };
  if (n >= 1) return { name: '우수 고객', rate: 0.05, n, next: 3 - n };
  return { name: '일반 고객', rate: 0, n, next: 1 };
}

/* ───────────── 예약 상태 ───────────── */
function bookingStatus(theme, b, dep, stats) {
  if (b.status === 'cancelled') return { key: 'cancel', label: dep.status === 'closed' ? '출발 취소' : '예약 취소' };
  const start = fromKey(dep.depart_date), end = addDays(start, b.nights), t = today();
  if (dep.status !== 'confirmed') {
    if (start <= t) return { key: 'cancel', label: '출발 무산 (인원 미달)' };
    return { key: 'wait', label: `모집 중 ${progressOf(theme, stats)}/${theme.confirmMin}${unitLabel(theme)}` };
  }
  if (end < t) return { key: 'done', label: '여행 완료' };
  if (start <= t) return { key: 'ongoing', label: '여행 중' };
  return { key: 'ok', label: '출발 확정' };
}

const BOOKING_SELECT = `SELECT b.*, dp.depart_date, dp.status AS dep_status, dp.id AS dep_id, d.code AS dest_code, d.name AS dest_name,
  d.region, d.theme_code, t.name AS theme_name, t.confirm_unit, t.confirm_min,
  (SELECT GROUP_CONCAT(addon_code) FROM booking_addons a WHERE a.booking_id = b.id) AS addon_list
  FROM bookings b JOIN departures dp ON dp.id = b.departure_id JOIN destinations d ON d.id = dp.destination_id
  JOIN themes t ON t.code = d.theme_code`;

// DB 행 → 고객 화면용 예약 객체 (프로토타입의 booking 모양 + 상태)
function toBookingView(db, cat, r) {
  const theme = cat.themes[r.theme_code] || { confirmUnit: r.confirm_unit, confirmMin: r.confirm_min, name: r.theme_name };
  const stats = departureStats(db, r.departure_id);
  return {
    id: r.id, userId: r.user_id, theme: r.theme_code, themeName: r.theme_name, dest: r.dest_code, destName: r.dest_name, region: r.region,
    departureId: r.departure_id, date: r.depart_date, nights: r.nights, pax: r.pax,
    style: r.style_code, hotel: r.hotel_grade, meal: r.meal_code, vehicle: r.vehicle_code,
    addons: r.addon_list ? r.addon_list.split(',') : [],
    subtotal: r.subtotal, discountRate: r.discount_rate, discount: r.discount, total: r.total,
    createdAt: r.created_at.slice(0, 10), cancelled: r.status === 'cancelled',
    itemsAllocated: r.items_allocated,
    payment: r.paid_at ? {
      method: r.pay_method, info: r.pay_info, approval: r.pay_approval, paidAt: r.paid_at, refundedAt: r.refunded_at,
      status: r.refunded_at ? '환불 완료' : '결제 완료'
    } : null,
    labels: {
      style: cat.styles[r.style_code] ? cat.styles[r.style_code].name : r.style_code,
      hotel: cat.hotels[r.hotel_grade] ? cat.hotels[r.hotel_grade].short : `${r.hotel_grade}성`,
      meal: cat.meals[r.meal_code] ? cat.meals[r.meal_code].short : r.meal_code,
      vehicle: cat.vehicles[r.vehicle_code] ? cat.vehicles[r.vehicle_code].short : r.vehicle_code,
      addons: (r.addon_list ? r.addon_list.split(',') : []).map(a => (cat.addons[a] ? cat.addons[a].name : a))
    },
    departure: { status: r.dep_status, count: stats.count, teams: stats.teams, progress: progressOf(theme, stats), min: theme.confirmMin, unit: theme.confirmUnit },
    status: bookingStatus(theme, r, { depart_date: r.depart_date, status: r.dep_status }, stats)
  };
}

/* ───────────── 모의 결제 ───────────── */
// 실제 결제 대행사(PG)를 연결하지 않은 시뮬레이션. 화면에서 입력한 카드 번호는 브라우저에서만 검사하고
// 서버에는 결제 수단과 끝 4자리만 보낸다.
const PAY_METHODS = { card: '신용·체크카드', transfer: '실시간 계좌이체', easypay: '간편결제' };
const BANKS = ['국민은행', '신한은행', '우리은행', '하나은행', '농협은행', '기업은행', '카카오뱅크', '토스뱅크'];
function validatePayment(p) {
  p = p || {};
  if (!PAY_METHODS[p.method]) throw bad('결제 수단을 선택해 주세요.');
  if (p.agree !== true) throw bad('결제 진행 및 취소·환불 규정에 동의해 주세요.');
  if (p.method === 'card') {
    if (!/^[0-9]{4}$/.test(String(p.last4 || ''))) throw bad('카드 정보를 확인해 주세요.');
    const inst = Number(p.installment || 0);
    if (![0, 2, 3, 6, 12].includes(inst)) throw bad('할부 개월 수를 확인해 주세요.');
    return { method: 'card', info: `${PAY_METHODS.card} ****${p.last4} · ${inst ? inst + '개월 할부' : '일시불'}` };
  }
  if (p.method === 'transfer') {
    if (!BANKS.includes(p.bank)) throw bad('은행을 선택해 주세요.');
    return { method: 'transfer', info: `${PAY_METHODS.transfer} (${p.bank})` };
  }
  return { method: 'easypay', info: PAY_METHODS.easypay };
}
const mockApproval = () => 'MOCK-' + String(Math.floor(10000000 + Math.random() * 90000000));

/* ───────────── 예약 생성 / 취소 ───────────── */
function newBookingId(db) {
  const d = today();
  const base = `MW-${String(d.getFullYear()).slice(2)}${toKey(d).slice(5).replace('-', '')}-`;
  const exists = db.prepare('SELECT 1 FROM bookings WHERE id = ?');
  for (let i = 0; i < 1000; i++) {
    const id = base + String(Math.floor(100 + Math.random() * 900));
    if (!exists.get(id)) return id;
  }
  throw new HttpError(500, '예약번호를 만들 수 없습니다. 잠시 후 다시 시도해 주세요.');
}

// 예약 신청: 검증 → 가격 계산(서버 기준) → 저장 → 출발 확정 검사
function createBooking(db, user, input, opts = {}) {
  ensureDepartures(db);
  return tx(db, () => {
    const cat = loadCatalog(db);
    const b = validateBookingInput(cat, input);
    const t = cat.themes[b.theme];
    const dep = db.prepare('SELECT * FROM departures WHERE destination_id = ? AND depart_date = ?').get(b.destDbId, b.date);
    if (!dep || dep.status === 'closed') throw bad('선택한 출발일은 예약할 수 없습니다. 다른 출발일을 선택해 주세요.');
    if (!opts.allowPast && dep.depart_date < toKey(addDays(today(), LEAD_DAYS))) throw bad(`출발 ${LEAD_DAYS}일 전까지만 예약할 수 있습니다.`);

    // 모의 결제: 결제 정보 검증 (카드 번호 전체는 서버로 보내지도, 저장하지도 않는다)
    const pay = opts.payment || validatePayment(input.payment);
    const tier = tierOf(db, user.id);
    const rate = opts.rate !== undefined ? opts.rate : tier.rate;
    const p = calc(cat, b, rate);
    // 고객 화면에 보였던 금액과 서버 계산이 다르면 (그 사이 가격표 변경 등) 다시 확인하도록 한다
    if (input.expectedTotal !== undefined && Number(input.expectedTotal) !== p.total) {
      throw new HttpError(409, `가격 정보가 변경되었습니다. 결제 예정 금액 ${won(p.total)}을 확인한 뒤 다시 신청해 주세요.`, { total: p.total });
    }
    const id = opts.id || newBookingId(db);
    db.prepare(`INSERT INTO bookings (id, user_id, departure_id, nights, pax, style_code, hotel_grade, meal_code, vehicle_code,
      subtotal, discount_rate, discount, total, created_at, pay_method, pay_info, pay_approval, paid_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, user.id, dep.id, b.nights, b.pax, b.style, b.hotel, b.meal, b.vehicle, p.subtotal, rate, p.discount, p.total,
        opts.createdAt || nowStamp(), pay.method, pay.info, mockApproval(), opts.createdAt || nowStamp());
    const addAddon = db.prepare('INSERT INTO booking_addons (booking_id, addon_code) VALUES (?, ?)');
    b.addons.forEach(a => addAddon.run(id, a));

    let mySms = [];
    let confirmedNow = false;
    if (dep.status === 'confirmed') {
      // 이미 확정된 일정에 합류: 이 예약만 기념품 출고 + 확정 문자
      const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
      allocateItems(db, t, row);
      const full = getDeparture(db, dep.id);
      const u = db.prepare('SELECT id, name, phone FROM users WHERE id = ?').get(user.id);
      if (!opts.silent) mySms = [sendSms(db, u, id, 'confirm', confirmMsg(u, t, full, id))];
    } else {
      const r = confirmIfReady(db, cat, dep.id);
      if (r) { confirmedNow = true; mySms = r.sms.filter(s => s.userId === user.id && s.bookingId === id); }
    }
    const view = toBookingView(db, cat, db.prepare(`${BOOKING_SELECT} WHERE b.id = ?`).get(id));
    return { booking: view, confirmedNow, sms: mySms.map(s => ({ phone: s.phone, message: s.message })) };
  });
}

// 예약 취소 (고객 본인 또는 직원). 출발 확정 일정은 취소가 생겨도 확정 상태를 유지한다.
function cancelBooking(db, actor, bookingId) {
  return tx(db, () => {
    const b = db.prepare('SELECT b.*, dp.depart_date FROM bookings b JOIN departures dp ON dp.id = b.departure_id WHERE b.id = ?').get(bookingId);
    if (!b || (actor.role !== 'staff' && b.user_id !== actor.id)) throw new HttpError(404, '예약을 찾을 수 없습니다.');
    if (b.status === 'cancelled') throw bad('이미 취소된 예약입니다.');
    if (b.depart_date <= todayKey()) throw bad('출발일 이후에는 취소할 수 없습니다.');
    db.prepare("UPDATE bookings SET status = 'cancelled', cancelled_at = ?, refunded_at = CASE WHEN paid_at IS NOT NULL THEN ? END WHERE id = ?").run(nowStamp(), nowStamp(), bookingId);
    const returned = returnItems(db, b);
    return { id: bookingId, returned };
  });
}

// 직원: 출발 일정 운영 취소 → 모든 예약 취소 + 기념품 반납 + 고객 문자
function closeDeparture(db, cat, departureId, memo = '') {
  return tx(db, () => {
    const dep = getDeparture(db, departureId);
    if (!dep) throw new HttpError(404, '출발 일정을 찾을 수 없습니다.');
    if (dep.status === 'closed') throw bad('이미 취소된 출발 일정입니다.');
    if (dep.depart_date <= todayKey()) throw bad('이미 출발한 일정은 취소할 수 없습니다.');
    const t = cat.themes[dep.theme_code] || { name: dep.theme_code };
    db.prepare("UPDATE departures SET status = 'closed', memo = ? WHERE id = ?").run(String(memo || ''), departureId);
    const list = db.prepare(`SELECT b.*, u.name, u.phone FROM bookings b JOIN users u ON u.id = b.user_id
      WHERE b.departure_id = ? AND b.status = 'booked'`).all(departureId);
    list.forEach(b => {
      db.prepare("UPDATE bookings SET status = 'cancelled', cancelled_at = ?, refunded_at = CASE WHEN paid_at IS NOT NULL THEN ? END WHERE id = ?").run(nowStamp(), nowStamp(), b.id);
      returnItems(db, b);
      sendSms(db, { id: b.user_id, phone: b.phone }, b.id, 'closed', closedMsg(b, t, dep, b.id, memo));
    });
    return { id: departureId, cancelled: list.length };
  });
}

module.exports = {
  NIGHTS, LEAD_DAYS, loadCatalog, calc, activeAddons, validateBookingInput,
  ensureDepartures, resetEnsureCache, departureStats, progressOf, unitLabel, ruleText, isConfirmable, getDeparture, customerDepartures,
  moveStock, allocateItems, returnItems, sendSms, confirmIfReady,
  completedTrips, tierOf, bookingStatus, BOOKING_SELECT, toBookingView,
  createBooking, cancelBooking, closeDeparture, validatePayment, PAY_METHODS, BANKS
};
