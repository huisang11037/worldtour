'use strict';
// 초기 데이터: 옵션 가격표, 4개 테마 상품, 기념품 재고, 데모 회원·직원, 예시 예약
// 실행: npm run reset-db  (기존 데이터를 모두 지우고 다시 만든다)
const { openDb, tx } = require('./db');
const { hashPassword } = require('./auth');
const { toKey, addDays, fromKey, today, nowStamp, upcomingSaturdays, pastSaturday } = require('./util');
const rules = require('./rules');

const TABLES = ['sms_log', 'stock_moves', 'booking_addons', 'bookings', 'departures', 'destinations', 'theme_services',
  'themes', 'items', 'tour_styles', 'addons', 'vehicles', 'meals', 'hotels', 'sessions', 'users'];

function seed(db) {
  tx(db, () => {
    TABLES.forEach(t => db.exec(`DELETE FROM ${t}`));
    db.exec("DELETE FROM sqlite_sequence");
    const stamp = nowStamp();

    // 옵션 가격표 (고객 GUI 프로토타입과 같은 값)
    const h = db.prepare('INSERT INTO hotels (grade, name, short, price) VALUES (?, ?, ?, ?)');
    h.run(3, '3성급 호텔', '3성', 60000);
    h.run(4, '4성급 호텔', '4성', 110000);
    h.run(5, '5성급 호텔', '5성', 200000);
    const m = db.prepare('INSERT INTO meals (code, name, short, price, level, includes_champagne, sort) VALUES (?, ?, ?, ?, ?, ?, ?)');
    m.run('lunchbox', '도시락', '도시락', 15000, 3, 0, 1);
    m.run('local', '현지식 레스토랑', '현지식', 40000, 4, 0, 2);
    m.run('fine', '고급 레스토랑 스테이크 + 샴페인', '스테이크+샴페인', 90000, 5, 1, 3);
    const v = db.prepare('INSERT INTO vehicles (code, name, short, capacity, price, sort) VALUES (?, ?, ?, ?, ?, ?)');
    v.run('sedan', '2인 전용 고급차량', '2인 고급차량', 2, 150000, 1);
    v.run('van', '10인 승합 고급차량', '10인 승합', 10, 250000, 2);
    v.run('none', '차량 미이용 (개별 이동)', '차량 미이용', 10, 0, 3);
    const a = db.prepare('INSERT INTO addons (code, name, price, sort) VALUES (?, ?, ?, ?)');
    a.run('champagne', '샴페인', 30000, 1);
    a.run('coffee', '커피', 5000, 2);
    const s = db.prepare('INSERT INTO tour_styles (code, name, en, hotel_grade, meal_code, rank) VALUES (?, ?, ?, ?, ?, ?)');
    s.run('classic', '클래식', 'Classic', 3, 'lunchbox', 1);
    s.run('grand', '그랜드', 'Grand', 4, 'local', 2);
    s.run('premium', '프리미엄', 'Premium', 5, 'fine', 3);

    // 창고 물품 (기념품)
    const it = db.prepare('INSERT INTO items (code, name, unit, stock, safety_stock, created_at) VALUES (?, ?, ?, 0, ?, ?)');
    const itemIds = {};
    [['couple-tee', '커플 기념티', '벌', 40, 10], ['ginseng', '건강 인삼 세트', '세트', 30, 10],
     ['golf-ball', '프리미엄 골프공 (12구)', '박스', 40, 10], ['scarf', '아웃도어 스카프', '개', 16, 10]]
      .forEach(([code, name, unit, stock, safety]) => {
        itemIds[code] = Number(it.run(code, name, unit, safety, stamp).lastInsertRowid);
        rules.moveStock(db, itemIds[code], stock, 'in', { memo: '초기 재고' });
      });

    // 4개 테마 패키지
    const th = db.prepare(`INSERT INTO themes (code, name, en, who, base_price, min_style, fixed_pax, max_pax, default_vehicle,
      confirm_unit, confirm_min, item_id, item_per_person, sort, image_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    // 대표 사진: Unsplash (무료 라이선스) — 직원 화면 '여행 상품 기획'에서 바꿀 수 있다
    const PHOTO = id => `https://images.unsplash.com/photo-${id}?w=960&h=720&fit=crop&q=75&auto=format`;
    const IMAGES = {
      honeymoon: PHOTO('1787142837331-a5804c2a8c31'), // 몰디브 수상 리조트 (Nabit Photos)
      parents: PHOTO('1638964663550-e2123ac8900b'),   // 경복궁 근정전 (Daniel Bernard)
      golf: PHOTO('1776717163992-1919b844d715'),      // 골프 코스 항공 사진 (Bernd Dittrich)
      trekking: PHOTO('1761209844739-ec2c102f2fe7')   // 산 능선 (Wladislaw Sokolowskij)
    };
    const sv = db.prepare('INSERT INTO theme_services (theme_code, sort, text) VALUES (?, ?, ?)');
    const ds = db.prepare('INSERT INTO destinations (theme_code, code, name, region, extra_price, sort) VALUES (?, ?, ?, ?, ?, ?)');
    const THEMES = [
      ['honeymoon', '허니문 낭만 투어', 'Honeymoon Romance Tour', '배우자와 함께', 500000, 'grand', 2, 2, 'sedan', 'team', 2, 'couple-tee',
        ['로맨틱 스페셜 룸 데코레이션', '커플 기념티 제공', '2인 전용 고급차량 서비스'],
        [['jeju', '제주', '국내', 100000], ['maldives', '몰디브', '해외', 1500000], ['hawaii', '하와이', '해외', 1200000]]],
      ['parents', '효도 힐링 투어', 'Parents Healing Tour', '부모님과 함께', 400000, 'grand', 0, 10, 'van', 'person', 3, 'ginseng',
        ['고품격 안마 · 지압 서비스', '건강 인삼 기념품 제공', '10인 승합 고급차량 서비스'],
        [['jeju', '제주', '국내', 100000], ['gyeongju', '경주', '국내', 0], ['oita', '일본 오이타', '해외', 450000]]],
      ['golf', '골프 챌린지 투어', 'Golf Challenge Tour', '친구 · 동료와 함께', 450000, 'classic', 0, 10, 'van', 'person', 3, 'golf-ball',
        ['유명 골프 리조트 테마 연출', '골프 액세서리(골프공) 제공', '10인 승합 고급차량 서비스'],
        [['jeju', '제주', '국내', 100000], ['chiangmai', '태국 치앙마이', '해외', 550000], ['danang', '베트남 다낭', '해외', 450000]]],
      ['trekking', '아웃도어 트레킹 투어', 'Outdoor Trekking Tour', '친구와 함께', 300000, 'classic', 0, 10, 'van', 'person', 3, 'scarf',
        ['트레킹 · 산악 테마 어드벤처 연출', '아웃도어 기념품(스카프) 제공', '10인 승합 고급차량 서비스'],
        [['seorak', '설악산', '국내', 0], ['jiri', '지리산', '국내', 0], ['annapurna', '네팔 안나푸르나', '해외', 1100000]]]
    ];
    THEMES.forEach(([code, name, en, who, base, minStyle, fixedPax, maxPax, veh, unit, min, item, services, dests], i) => {
      th.run(code, name, en, who, base, minStyle, fixedPax, maxPax, veh, unit, min, itemIds[item], 1, i + 1, IMAGES[code] || '');
      services.forEach((t, j) => sv.run(code, j + 1, t));
      dests.forEach(([dc, dn, region, extra], j) => ds.run(code, dc, dn, region, extra, j + 1));
    });

    // 회원 (고객 5명 + 직원 1명) — 비밀번호는 모두 1234
    const u = db.prepare('INSERT INTO users (login_id, pw_hash, name, address, phone, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const users = {};
    [['demo', '김월드', '서울특별시 중구 월드로 12', '010-1234-5678', 'customer', 420],
     ['sky', '이하늘', '경기도 성남시 분당구 하늘로 7', '010-2222-3333', 'customer', 300],
     ['sea', '박바다', '부산광역시 해운대구 바다로 21', '010-3333-4444', 'customer', 200],
     ['forest', '최산들', '강원특별자치도 속초시 설악로 5', '010-4444-5555', 'customer', 90],
     ['joy', '정다정', '대전광역시 유성구 대학로 99', '010-5555-6666', 'customer', 30],
     ['staff', '운영팀 직원', '서울특별시 중구 월드로 1 (본사)', '02-123-4567', 'staff', 500]]
      .forEach(([id, name, addr, phone, role, ago]) => {
        users[id] = { id: Number(u.run(id, hashPassword('1234'), name, addr, phone, role, toKey(addDays(today(), -ago)) + ' 10:00:00').lastInsertRowid), name, phone, role };
      });

    // 지난 여행 (출발 확정 + 여행 완료 상태로 저장) — 데모 계정은 완료 3회 = 단골 고객
    const cat = rules.loadCatalog(db);
    const pastDep = (theme, dest, date) => {
      const destId = cat.themes[theme].dests.find(d => d.id === dest).dbId;
      db.prepare(`INSERT OR IGNORE INTO departures (destination_id, depart_date, status, confirmed_at, created_at)
        VALUES (?, ?, 'confirmed', ?, ?)`).run(destId, date, date + ' 09:00:00', date + ' 09:00:00');
    };
    const past = [
      ['demo', { theme: 'trekking', dest: 'seorak', date: pastSaturday(390), nights: 2, pax: 5, style: 'classic', hotel: 3, meal: 'fine', vehicle: 'van', addons: ['coffee'] }, 0, '01'],
      ['demo', { theme: 'parents', dest: 'gyeongju', date: pastSaturday(190), nights: 2, pax: 3, style: 'premium', hotel: 5, meal: 'fine', vehicle: 'van', addons: ['coffee'] }, 0.05, '02'],
      ['demo', { theme: 'golf', dest: 'jeju', date: pastSaturday(60), nights: 3, pax: 4, style: 'grand', hotel: 4, meal: 'local', vehicle: 'van', addons: ['champagne'] }, 0.05, '03'],
      ['sky', { theme: 'honeymoon', dest: 'hawaii', date: pastSaturday(150), nights: 4, pax: 2, style: 'premium', hotel: 5, meal: 'fine', vehicle: 'sedan', addons: [] }, 0, '04']
    ];
    past.forEach(([uid, b, rate, no]) => {
      pastDep(b.theme, b.dest, b.date);
      rules.createBooking(db, users[uid], b, {
        allowPast: true, silent: true, rate, payment: { method: 'card', info: '신용·체크카드 ****1234 · 일시불' },
        id: `MW-${b.date.replace(/-/g, '').slice(2)}-0${no}`,
        createdAt: toKey(addDays(fromKey(b.date), -21)) + ' 14:00:00'
      });
    });

    // 앞으로의 출발 일정 + 다른 고객들의 신청 (일부는 확정, 일부는 모집 중)
    rules.ensureDepartures(db, true);
    const sat = upcomingSaturdays(8);
    const g = (theme, pax, style = 'grand') => {
      const st = cat.styles[style];
      return { theme, pax, style, hotel: st.hotel, meal: st.meal, vehicle: cat.themes[theme].vehicle, nights: 3, addons: [] };
    };
    const upcoming = [
      ['sky', Object.assign(g('honeymoon', 2), { dest: 'jeju', date: sat[0] }), 5],      // 1/2팀 → 모집 중
      ['sea', Object.assign(g('honeymoon', 2, 'premium'), { dest: 'maldives', date: sat[1] }), 9],
      ['forest', Object.assign(g('honeymoon', 2), { dest: 'maldives', date: sat[1], addons: ['coffee'] }), 4], // 2팀 → 확정
      ['sea', Object.assign(g('parents', 2), { dest: 'jeju', date: sat[0] }), 6],        // 2/3명 → 모집 중
      ['forest', Object.assign(g('golf', 4), { dest: 'jeju', date: sat[0] }), 8],        // 4명 → 확정
      ['joy', Object.assign(g('golf', 1, 'classic'), { dest: 'danang', date: sat[1] }), 2],
      ['joy', Object.assign(g('trekking', 2, 'classic'), { dest: 'seorak', date: sat[0] }), 3], // 2/3명 → 모집 중
      ['sky', Object.assign(g('trekking', 3, 'classic'), { dest: 'seorak', date: sat[2] }), 7], // 확정
      ['forest', Object.assign(g('parents', 3, 'premium'), { dest: 'oita', date: sat[2] }), 5]  // 확정
    ];
    upcoming.forEach(([uid, b, ago]) => rules.createBooking(db, users[uid], b, { createdAt: toKey(addDays(today(), -ago)) + ' 11:00:00', payment: { method: 'transfer', info: '실시간 계좌이체 (국민은행)' } }));
  });
}

// 비어 있는 DB면 자동으로 초기 데이터 생성
function seedIfEmpty(db) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (n === 0) { seed(db); return true; }
  return false;
}

module.exports = { seed, seedIfEmpty };

if (require.main === module) {
  const db = openDb();
  if (process.argv.includes('--reset') || !seedIfEmpty(db)) seed(db);
  console.log(`초기 데이터를 생성했습니다: ${db.file}`);
}
