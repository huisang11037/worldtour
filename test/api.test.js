'use strict';
// API 통합 테스트: npm test
// 날짜를 2026-11-16(월)로 고정하고 메모리 DB에서 실행한다.
process.env.MW_TODAY = '2026-11-16';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../server/db');
const { seed } = require('../server/seed');
const { createApp } = require('../server/index');
const rules = require('../server/rules');
const { upcomingSaturdays } = require('../server/util');

let server, base, db;
const PAY = { method: 'card', last4: '4242', installment: 0, agree: true };
const SAT = upcomingSaturdays(8); // 2026-11-28 부터

test.before(async () => {
  db = openDb(':memory:');
  seed(db);
  server = createApp(db).listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(() => server.close());

// 쿠키를 기억하는 간단한 클라이언트
function client() {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(base + url, {
      method, headers: Object.assign({ 'Content-Type': 'application/json' }, cookie ? { Cookie: cookie } : {}),
      body: body ? JSON.stringify(body) : undefined
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
}
const login = async (id) => { const c = client(); const r = await c('POST', '/auth/login', { uid: id, upw: '1234' }); assert.equal(r.status, 200); return c; };
const stockOf = name => db.prepare('SELECT stock FROM items WHERE name LIKE ?').get(name + '%').stock;
const draft = (theme, extra) => {
  const cat = rules.loadCatalog(db), t = cat.themes[theme];
  return Object.assign({ theme, dest: t.dests[0].id, date: SAT[0], nights: 3, pax: t.fixedPax || 2, style: 'grand', hotel: 4, meal: 'local', vehicle: t.vehicle, addons: [], payment: PAY }, extra);
};

test('카탈로그: 4개 테마와 등급·옵션 가격표', async () => {
  const { body } = await client()('GET', '/catalog');
  assert.deepEqual(Object.keys(body.themes), ['honeymoon', 'parents', 'golf', 'trekking']);
  assert.equal(body.themes.honeymoon.confirmUnit, 'team');
  assert.equal(body.themes.honeymoon.confirmMin, 2);
  assert.equal(body.themes.golf.confirmMin, 3);
  assert.deepEqual(body.styleOrder, ['classic', 'grand', 'premium']);
});

test('로그인: 잘못된 비밀번호는 401, 데모 계정은 단골 고객(10%)', async () => {
  const c = client();
  assert.equal((await c('POST', '/auth/login', { uid: 'demo', upw: 'x' })).status, 401);
  const r = await c('POST', '/auth/login', { uid: 'demo', upw: '1234' });
  assert.equal(r.body.user.tier.name, '단골 고객');
  assert.equal(r.body.user.tier.rate, 0.1);
  const me = await c('GET', '/me');
  assert.equal(me.body.user.name, '김월드');
});

test('회원가입: 입력값 검사와 중복 아이디', async () => {
  const c = client();
  const bad = await c('POST', '/auth/signup', { uid: 'a', upw: '1', uname: '', uaddr: '', uphone: '123' });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.fields.uid && bad.body.fields.uphone);
  const dup = await c('POST', '/auth/signup', { uid: 'DEMO', upw: '1234', uname: '홍길동', uaddr: '서울', uphone: '01099998888' });
  assert.equal(dup.body.fields.uid, '이미 사용 중인 아이디입니다.');
  const ok = await c('POST', '/auth/signup', { uid: 'newbie', upw: '1234', uname: '홍길동', uaddr: '서울', uphone: '01099998888' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.user.phone, '010-9999-8888');
  assert.equal(ok.body.user.tier.name, '일반 고객');
});

test('예약 검증: 등급 제한·고정 인원·차량 정원', async () => {
  const c = await login('demo');
  let r = await c('POST', '/bookings', draft('parents', { style: 'classic', hotel: 3, meal: 'lunchbox' }));
  assert.equal(r.status, 400);
  r = await c('POST', '/bookings', draft('parents', { hotel: 3 }));
  assert.equal(r.status, 400);
  r = await c('POST', '/bookings', draft('honeymoon', { pax: 3 }));
  assert.equal(r.status, 400);
  r = await c('POST', '/bookings', draft('golf', { pax: 3, vehicle: 'sedan' }));
  assert.equal(r.status, 400);
  r = await c('POST', '/bookings', draft('golf', { date: '2026-11-17' }));
  assert.equal(r.status, 400);
});

test('가격: 서버 계산과 화면 금액이 다르면 409', async () => {
  const c = await login('demo');
  const q = await c('POST', '/quote', draft('golf', { dest: 'danang', date: SAT[1] }));
  assert.equal(q.body.rate, 0.1);
  const r = await c('POST', '/bookings', Object.assign(draft('golf', { dest: 'danang', date: SAT[1] }), { expectedTotal: q.body.total + 100 }));
  assert.equal(r.status, 409);
  assert.equal(r.body.total, q.body.total);
});

test('허니문: 2팀이 모이면 출발 확정 + 문자 + 커플티 출고', async () => {
  const before = stockOf('커플');
  const c = await login('demo');
  const deps = await c('GET', `/departures?theme=honeymoon&dest=jeju`);
  const d0 = deps.body.find(d => d.date === SAT[0]);
  assert.equal(d0.progress, 1); assert.equal(d0.min, 2); assert.equal(d0.unit, 'team');
  const q = await c('POST', '/quote', draft('honeymoon'));
  const r = await c('POST', '/bookings', Object.assign(draft('honeymoon'), { expectedTotal: q.body.total }));
  assert.equal(r.status, 201);
  assert.equal(r.body.confirmedNow, true);
  assert.equal(r.body.booking.status.key, 'ok');
  assert.equal(r.body.sms.length, 1);
  assert.match(r.body.sms[0].message, /2팀 이상/);
  assert.equal(stockOf('커플'), before - 4); // 기존 1팀 2벌 + 내 2벌
  // 함께 확정된 다른 고객(이하늘)도 문자를 받는다
  const sky = await login('sky');
  const inbox = await sky('GET', '/me/sms?unread=1');
  assert.ok(inbox.body.some(s => s.kind === 'confirm'));
});

test('일반 테마: 인원 3명 미만이면 모집 중, 3명 이상이면 확정', async () => {
  const c = await login('demo');
  // 골프 다낭: 기존 1명 + 1명 = 2명 → 모집 중
  let r = await c('POST', '/bookings', draft('golf', { dest: 'danang', date: SAT[1], pax: 1 }));
  assert.equal(r.status, 201);
  assert.equal(r.body.confirmedNow, false);
  assert.equal(r.body.booking.status.label, '모집 중 2/3명');
  // 트레킹 설악산: 기존 2명 + 1명 = 3명 → 확정
  const before = stockOf('아웃도어');
  r = await c('POST', '/bookings', draft('trekking', { pax: 1, style: 'classic', hotel: 3, meal: 'fine', addons: ['champagne', 'coffee'] }));
  assert.equal(r.body.confirmedNow, true);
  assert.deepEqual(r.body.booking.addons, ['coffee']); // 샴페인 포함 식사 → 샴페인 추가 제외
  assert.equal(stockOf('아웃도어'), before - 3);
});

test('예약 취소: 기념품 반납, 확정 일정은 확정 유지', async () => {
  const c = await login('demo');
  const list = (await c('GET', '/me/bookings')).body;
  const b = list.find(x => x.theme === 'trekking' && x.status.key === 'ok');
  const before = stockOf('아웃도어');
  const r = await c('POST', `/bookings/${b.id}/cancel`);
  assert.equal(r.body.returned, 1);
  assert.equal(stockOf('아웃도어'), before + 1);
  const dep = (await c('GET', '/departures?theme=trekking&dest=seorak')).body.find(d => d.date === SAT[0]);
  assert.equal(dep.status, 'confirmed');
  assert.equal((await c('POST', `/bookings/${b.id}/cancel`)).status, 400);
  // 다른 사람 예약은 취소 불가
  const sky = await login('sky');
  assert.equal((await sky('POST', `/bookings/${list[0].id}/cancel`)).status, 404);
});

test('이전 여행 목록: 최근 출발일 순', async () => {
  const c = await login('demo');
  const list = (await c('GET', '/me/bookings')).body;
  const dates = list.map(b => b.date);
  assert.deepEqual(dates, [...dates].sort().reverse());
  assert.equal(list.filter(b => b.status.key === 'done').length, 3);
});

test('직원 API: 고객 계정은 403, 비로그인은 401', async () => {
  assert.equal((await client()('GET', '/staff/summary')).status, 401);
  assert.equal((await (await login('demo'))('GET', '/staff/summary')).status, 403);
  const s = await login('staff');
  const r = await s('GET', '/staff/summary');
  assert.equal(r.status, 200);
  assert.ok(r.body.departures.active > 0);
  assert.ok(r.body.lowStock.some(i => i.name === '아웃도어 스카프'));
});

test('직원: 재고 입고·조정', async () => {
  const s = await login('staff');
  const items = (await s('GET', '/staff/items')).body;
  const scarf = items.find(i => i.name === '아웃도어 스카프');
  let r = await s('POST', `/staff/items/${scarf.id}/moves`, { kind: 'in', qty: 30, memo: '11월 입고' });
  assert.equal(r.body.stock, scarf.stock + 30);
  r = await s('POST', `/staff/items/${scarf.id}/moves`, { kind: 'adjust', qty: -1000, memo: '분실' });
  assert.equal(r.status, 400);
  r = await s('POST', '/staff/items', { name: '여행용 파우치', unit: '개', stock: 20, safety: 5 });
  assert.equal(r.status, 201);
  const moves = (await s('GET', `/staff/stock-moves?item=${r.body.id}`)).body;
  assert.equal(moves[0].qty, 20);
});

test('직원: 출발 확정 기준 변경 시 모집 중 일정 재검사', async () => {
  const s = await login('staff');
  // 효도 제주 SAT[0]: 2명 모집 중 → 기준을 2명으로 낮추면 바로 확정
  const r = await s('PATCH', '/staff/themes/parents', { confirmMin: 2 });
  assert.ok(r.body.newlyConfirmed >= 1);
  const deps = (await s('GET', '/staff/departures?theme=parents&booked=1')).body;
  assert.equal(deps.find(d => d.dest === 'jeju' && d.date === SAT[0]).status, 'confirmed');
  await s('PATCH', '/staff/themes/parents', { confirmMin: 3 });
});

test('직원: 상품 기획 - 새 여행지·출발일 추가', async () => {
  const s = await login('staff');
  let r = await s('POST', '/staff/themes/golf/destinations', { code: 'guam', name: '괌', region: '해외', extra: 600000 });
  assert.equal(r.status, 201);
  r = await s('POST', '/staff/departures', { theme: 'golf', dest: 'guam', date: '2026-12-24', memo: '크리스마스 특가' });
  assert.equal(r.status, 201);
  const c = await login('demo');
  const deps = (await c('GET', '/departures?theme=golf&dest=guam')).body;
  assert.ok(deps.some(d => d.date === '2026-12-24'));
});

test('직원: 출발 일정 운영 취소 → 예약 취소 + 문자 + 기념품 반납', async () => {
  const s = await login('staff');
  const dep = (await s('GET', '/staff/departures?theme=honeymoon&status=confirmed')).body.find(d => d.dest === 'maldives');
  const before = stockOf('커플');
  const r = await s('POST', `/staff/departures/${dep.id}/close`, { memo: '현지 기상 악화' });
  assert.equal(r.body.cancelled, 2);
  assert.equal(stockOf('커플'), before + 4);
  const sms = (await s('GET', '/staff/sms')).body.filter(x => x.kind === 'closed');
  assert.equal(sms.length, 2);
  assert.match(sms[0].message, /현지 기상 악화/);
});

test('모의 결제: 결제 정보 검증, 결제 내역 저장, 취소 시 환불', async () => {
  const c = await login('joy');
  let r = await c('POST', '/bookings', draft('golf', { dest: 'chiangmai', pax: 1, payment: undefined }));
  assert.equal(r.status, 400);
  r = await c('POST', '/bookings', draft('golf', { dest: 'chiangmai', pax: 1, payment: { method: 'card', last4: '12', agree: true } }));
  assert.equal(r.status, 400);
  r = await c('POST', '/bookings', draft('golf', { dest: 'chiangmai', pax: 1, payment: { method: 'card', last4: '4242', agree: false } }));
  assert.equal(r.status, 400);
  r = await c('POST', '/bookings', draft('golf', { dest: 'chiangmai', pax: 1, payment: { method: 'transfer', bank: '신한은행', agree: true } }));
  assert.equal(r.status, 201);
  assert.equal(r.body.booking.payment.status, '결제 완료');
  assert.match(r.body.booking.payment.approval, /^MOCK-[0-9]{8}$/);
  assert.equal(r.body.booking.payment.info, '실시간 계좌이체 (신한은행)');
  await c('POST', `/bookings/${r.body.booking.id}/cancel`);
  const b = (await c('GET', '/me/bookings')).body.find(x => x.id === r.body.booking.id);
  assert.equal(b.payment.status, '환불 완료');
  // DB에는 카드 번호 전체가 저장되지 않는다
  const card = await c('POST', '/bookings', draft('golf', { dest: 'chiangmai', pax: 1, payment: { method: 'card', last4: '4242', installment: 3, agree: true, number: '4242424242424242' } }));
  assert.equal(card.body.booking.payment.info, '신용·체크카드 ****4242 · 3개월 할부');
  const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(card.body.booking.id);
  assert.ok(!JSON.stringify(row).includes('4242424242424242'));
});
