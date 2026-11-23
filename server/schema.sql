-- 미스터 월드 테마 여행 서비스 데이터베이스 스키마 (SQLite)
-- 날짜는 'YYYY-MM-DD', 일시는 'YYYY-MM-DD HH:MM:SS' (서버 현지 시각) 문자열로 저장한다.
-- 금액 단위는 원(KRW) 정수.

PRAGMA foreign_keys = ON;

-- ───────────── 회원 (고객 & 직원) ─────────────
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  login_id    TEXT    NOT NULL UNIQUE COLLATE NOCASE,          -- 로그인 아이디
  pw_hash     TEXT    NOT NULL,                                -- scrypt 해시 (salt:hash)
  name        TEXT    NOT NULL,                                -- 성명
  address     TEXT    NOT NULL,                                -- 주소
  phone       TEXT    NOT NULL,                                -- 연락처 (문자 알림 수신)
  role        TEXT    NOT NULL DEFAULT 'customer' CHECK (role IN ('customer', 'staff')),
  created_at  TEXT    NOT NULL
);

-- 로그인 세션 (쿠키 토큰)
CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT    PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT    NOT NULL,
  expires_at  TEXT    NOT NULL
);

-- ───────────── 옵션 가격표 ─────────────
-- 호텔 등급 (1인 1박 가격)
CREATE TABLE IF NOT EXISTS hotels (
  grade       INTEGER PRIMARY KEY CHECK (grade BETWEEN 1 AND 5),
  name        TEXT    NOT NULL,
  short       TEXT    NOT NULL,
  price       INTEGER NOT NULL CHECK (price >= 0)
);

-- 식사 종류 (1인 1일 가격, level 은 등급 제한 비교용: 3=도시락, 4=현지식, 5=고급)
CREATE TABLE IF NOT EXISTS meals (
  code        TEXT    PRIMARY KEY,
  name        TEXT    NOT NULL,
  short       TEXT    NOT NULL,
  price       INTEGER NOT NULL CHECK (price >= 0),
  level       INTEGER NOT NULL,
  includes_champagne INTEGER NOT NULL DEFAULT 0,               -- 샴페인 포함 여부
  sort        INTEGER NOT NULL DEFAULT 0
);

-- 차량 (1일 가격, capacity = 탑승 정원)
CREATE TABLE IF NOT EXISTS vehicles (
  code        TEXT    PRIMARY KEY,
  name        TEXT    NOT NULL,
  short       TEXT    NOT NULL,
  capacity    INTEGER NOT NULL CHECK (capacity > 0),
  price       INTEGER NOT NULL CHECK (price >= 0),
  sort        INTEGER NOT NULL DEFAULT 0
);

-- 식사 추가 메뉴 (샴페인, 커피 / 1인 1일 가격)
CREATE TABLE IF NOT EXISTS addons (
  code        TEXT    PRIMARY KEY,
  name        TEXT    NOT NULL,
  price       INTEGER NOT NULL CHECK (price >= 0),
  sort        INTEGER NOT NULL DEFAULT 0
);

-- 투어 등급 스타일 (classic / grand / premium) → 기본 호텔·식사
CREATE TABLE IF NOT EXISTS tour_styles (
  code        TEXT    PRIMARY KEY,
  name        TEXT    NOT NULL,
  en          TEXT    NOT NULL,
  hotel_grade INTEGER NOT NULL REFERENCES hotels(grade),
  meal_code   TEXT    NOT NULL REFERENCES meals(code),
  rank        INTEGER NOT NULL UNIQUE                          -- 등급 비교용 (1 < 2 < 3)
);

-- ───────────── 창고 물품 (기념품) ─────────────
CREATE TABLE IF NOT EXISTS items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT    NOT NULL UNIQUE,
  name         TEXT    NOT NULL,
  unit         TEXT    NOT NULL DEFAULT '개',
  stock        INTEGER NOT NULL DEFAULT 0,                      -- 현재 재고 (음수 = 부족분)
  safety_stock INTEGER NOT NULL DEFAULT 10 CHECK (safety_stock >= 0),
  created_at   TEXT    NOT NULL
);

-- ───────────── 여행 상품 ─────────────
-- 테마 패키지
CREATE TABLE IF NOT EXISTS themes (
  code            TEXT    PRIMARY KEY,                          -- honeymoon, parents, golf, trekking ...
  name            TEXT    NOT NULL,
  en              TEXT    NOT NULL,
  who             TEXT    NOT NULL DEFAULT '',                  -- 동행 대상 문구
  base_price      INTEGER NOT NULL CHECK (base_price >= 0),     -- 1인 테마 패키지 기본가
  min_style       TEXT    NOT NULL REFERENCES tour_styles(code),-- 선택 가능한 최소 등급
  fixed_pax       INTEGER NOT NULL DEFAULT 0,                   -- 0 = 인원 자유, 2 = 2인 전용
  max_pax         INTEGER NOT NULL DEFAULT 10,
  default_vehicle TEXT    NOT NULL REFERENCES vehicles(code),
  confirm_unit    TEXT    NOT NULL DEFAULT 'person' CHECK (confirm_unit IN ('person', 'team')),
  confirm_min     INTEGER NOT NULL DEFAULT 3 CHECK (confirm_min >= 1), -- 출발 확정 최소 인원/팀
  item_id         INTEGER REFERENCES items(id),                 -- 제공 기념품
  item_per_person INTEGER NOT NULL DEFAULT 1 CHECK (item_per_person >= 0),
  image_url       TEXT    NOT NULL DEFAULT '',                  -- 상품 대표 사진 (https 주소)
  sort            INTEGER NOT NULL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1
);

-- 테마별 제공 서비스 문구
CREATE TABLE IF NOT EXISTS theme_services (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  theme_code  TEXT    NOT NULL REFERENCES themes(code) ON DELETE CASCADE,
  sort        INTEGER NOT NULL DEFAULT 0,
  text        TEXT    NOT NULL
);

-- 테마별 여행지
CREATE TABLE IF NOT EXISTS destinations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  theme_code  TEXT    NOT NULL REFERENCES themes(code) ON DELETE CASCADE,
  code        TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  region      TEXT    NOT NULL CHECK (region IN ('국내', '해외')),
  extra_price INTEGER NOT NULL DEFAULT 0 CHECK (extra_price >= 0), -- 1인 여행지 추가요금
  sort        INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  UNIQUE (theme_code, code)
);

-- 출발 일정 (테마+여행지+출발일 단위로 인원을 모아 출발 확정)
CREATE TABLE IF NOT EXISTS departures (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  destination_id INTEGER NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
  depart_date    TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'confirmed', 'closed')),
  confirmed_at   TEXT,
  departed_at    TEXT,                                          -- 직원 출발 처리 (기념품 출고)
  completed_at   TEXT,                                          -- 직원 여행 완료 처리
  memo           TEXT    NOT NULL DEFAULT '',
  created_at     TEXT    NOT NULL,
  UNIQUE (destination_id, depart_date)
);

-- ───────────── 예약 ─────────────
CREATE TABLE IF NOT EXISTS bookings (
  id             TEXT    PRIMARY KEY,                           -- MW-YYMMDD-NNN
  user_id        INTEGER NOT NULL REFERENCES users(id),
  departure_id   INTEGER NOT NULL REFERENCES departures(id),
  nights         INTEGER NOT NULL CHECK (nights BETWEEN 1 AND 14),
  pax            INTEGER NOT NULL CHECK (pax >= 1),
  style_code     TEXT    NOT NULL REFERENCES tour_styles(code),
  hotel_grade    INTEGER NOT NULL REFERENCES hotels(grade),
  meal_code      TEXT    NOT NULL REFERENCES meals(code),
  vehicle_code   TEXT    NOT NULL REFERENCES vehicles(code),
  subtotal       INTEGER NOT NULL,
  discount_rate  REAL    NOT NULL DEFAULT 0,
  discount       INTEGER NOT NULL DEFAULT 0,
  total          INTEGER NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'cancelled')),
  pay_method     TEXT,                                          -- card / transfer / easypay (모의 결제)
  pay_info       TEXT,                                          -- 표시용 결제 정보 (예: 신용카드 ****4242) — 카드 번호 전체는 저장하지 않음
  pay_approval   TEXT,                                          -- 모의 승인번호
  paid_at        TEXT,
  refunded_at    TEXT,
  item_id       INTEGER REFERENCES items(id),                  -- 출고된 기념품 (출발 처리 시 출고)
  items_allocated INTEGER NOT NULL DEFAULT 0,                   -- 기념품 출고 수량
  created_at     TEXT    NOT NULL,
  cancelled_at   TEXT
);

-- 예약별 식사 추가 메뉴
CREATE TABLE IF NOT EXISTS booking_addons (
  booking_id  TEXT    NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  addon_code  TEXT    NOT NULL REFERENCES addons(code),
  PRIMARY KEY (booking_id, addon_code)
);

-- 예약 변경 이력 (옵션 변경 → 차액 추가 결제 또는 부분 환불)
CREATE TABLE IF NOT EXISTS booking_changes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id  TEXT    NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  summary     TEXT    NOT NULL,                                 -- 바뀐 항목 (예: 등급 프리미엄 → 그랜드)
  before_total INTEGER NOT NULL,
  after_total INTEGER NOT NULL,
  diff        INTEGER NOT NULL,                                 -- +추가 결제 / -부분 환불
  approval    TEXT,                                             -- 차액 모의 승인번호
  created_at  TEXT    NOT NULL
);

-- 재고 입출고 이력
CREATE TABLE IF NOT EXISTS stock_moves (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     INTEGER NOT NULL REFERENCES items(id),
  qty         INTEGER NOT NULL,                                 -- +입고 / -출고
  kind        TEXT    NOT NULL CHECK (kind IN ('in', 'out', 'return', 'adjust')),
  booking_id  TEXT    REFERENCES bookings(id),
  staff_id    INTEGER REFERENCES users(id),
  memo        TEXT    NOT NULL DEFAULT '',
  created_at  TEXT    NOT NULL
);

-- 문자 발송 기록 (실제 발송 대신 시뮬레이션)
CREATE TABLE IF NOT EXISTS sms_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  phone       TEXT    NOT NULL,
  booking_id  TEXT    REFERENCES bookings(id),
  kind        TEXT    NOT NULL CHECK (kind IN ('confirm', 'booking', 'cancel', 'closed')),
  message     TEXT    NOT NULL,
  created_at  TEXT    NOT NULL,
  read_at     TEXT,
  status      TEXT    NOT NULL DEFAULT 'simulated',             -- simulated 기록만 · sending · sent 실제 발송 · failed 실패 · skipped 안전장치로 건너뜀
  provider_id TEXT,                                             -- SOLAPI 그룹 ID
  error       TEXT,                                             -- 실패·건너뜀 사유
  sent_at     TEXT
);

-- 서비스 설정 (예: sms_real = 1 실제 문자 발송 켜짐)
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT    PRIMARY KEY,
  value       TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bookings_user      ON bookings(user_id);
CREATE INDEX IF NOT EXISTS idx_bookings_departure ON bookings(departure_id);
CREATE INDEX IF NOT EXISTS idx_departures_date    ON departures(depart_date);
CREATE INDEX IF NOT EXISTS idx_stock_moves_item   ON stock_moves(item_id);
CREATE INDEX IF NOT EXISTS idx_sms_user           ON sms_log(user_id);
