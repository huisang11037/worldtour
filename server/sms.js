'use strict';
// 실제 문자 발송 (SOLAPI). sms_log에 기록된 문자를 조건이 맞을 때만 실제로 보낸다.
//
// 환경변수 (Render → Environment):
//   SOLAPI_API_KEY, SOLAPI_API_SECRET  SOLAPI 콘솔에서 발급한 API 키
//   SMS_SENDER                         SOLAPI에 등록한 발신번호 (예: 01012345678)
//   SMS_DAILY_LIMIT                    하루 실제 발송 최대 건수 (기본 30)
//   SMS_ENABLED=1                      직원 화면에서 따로 켜지 않아도 실제 발송 (기본은 꺼짐)
//   SMS_ALLOWLIST                      (선택) 이 번호들로만 실제 발송. 쉼표로 구분
//
// 안전장치: 키가 없거나 꺼져 있으면 지금처럼 기록만(시뮬레이션). 데모 계정에는 절대 실제 발송하지 않는다.
const { todayKey, nowStamp } = require('./util');

// 시드 데이터의 데모 계정 — 전화번호가 가짜이므로 실제로 보내면 모르는 사람에게 간다
const DEMO_LOGIN_IDS = new Set(['demo', 'sky', 'sea', 'forest', 'joy', 'staff']);
const SUBJECT = { booking: '[미스터월드] 결제 완료 안내', confirm: '[미스터월드] 출발 확정 안내', closed: '[미스터월드] 출발 취소 안내', cancel: '[미스터월드] 예약 취소 안내' };

const digits = s => String(s || '').replace(/[^0-9]/g, '');
const mask = s => { const d = digits(s); return d.length >= 8 ? `${d.slice(0, 3)}-****-${d.slice(-4)}` : d; };

function config() {
  const env = process.env;
  const allow = env.SMS_ALLOWLIST ? new Set(env.SMS_ALLOWLIST.split(',').map(digits).filter(Boolean)) : null;
  return {
    configured: !!(env.SOLAPI_API_KEY && env.SOLAPI_API_SECRET && digits(env.SMS_SENDER)),
    sender: digits(env.SMS_SENDER),
    dailyLimit: Number(env.SMS_DAILY_LIMIT) > 0 ? Number(env.SMS_DAILY_LIMIT) : 30,
    allow
  };
}

// 실제 발송 켜짐 여부: 직원 화면 설정(settings 테이블)이 우선, 없으면 SMS_ENABLED 환경변수
function isEnabled(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'sms_real'").get();
  return row ? row.value === '1' : process.env.SMS_ENABLED === '1';
}
function setEnabled(db, on) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('sms_real', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(on ? '1' : '0');
}
const sentToday = db => db.prepare("SELECT COUNT(*) AS n FROM sms_log WHERE status IN ('sending', 'sent') AND created_at >= ?").get(todayKey()).n;

function status(db) {
  const c = config();
  return {
    configured: c.configured, sender: c.configured ? mask(c.sender) : null, enabled: isEnabled(db),
    active: c.configured && isEnabled(db), dailyLimit: c.dailyLimit, sentToday: sentToday(db),
    allowlist: c.allow ? [...c.allow].map(mask) : null
  };
}

// 실제 전송 함수 (테스트에서 setTransport로 바꿔 끼운다)
let service = null;
let transport = async ({ to, from, text, subject }) => {
  if (!service) {
    const { SolapiMessageService } = require('solapi');
    service = new SolapiMessageService(process.env.SOLAPI_API_KEY, process.env.SOLAPI_API_SECRET);
  }
  const res = await service.send({ to, from, text, subject });
  const failed = res && res.failedMessageList && res.failedMessageList.length;
  if (failed) throw new Error(res.failedMessageList[0].statusMessage || '발송 접수 실패');
  return { id: res && res.groupInfo ? res.groupInfo.groupId || res.groupInfo._id || null : null };
};
const setTransport = fn => { transport = fn; service = null; };

const update = (db, id, fields) => {
  const cols = Object.keys(fields);
  db.prepare(`UPDATE sms_log SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map(c => fields[c]), id);
};

// sms_log 한 건을 실제로 보낼지 판단하고 보낸다. 결과는 sms_log.status 에 남긴다.
async function dispatch(db, smsId) {
  const row = db.prepare('SELECT s.*, u.login_id FROM sms_log s JOIN users u ON u.id = s.user_id WHERE s.id = ?').get(smsId);
  if (!row || row.status !== 'simulated') return null; // 트랜잭션이 취소돼 기록이 없거나 이미 처리됨
  const c = config();
  if (!c.configured || !isEnabled(db)) return 'simulated';
  const to = digits(row.phone);
  let skip = null;
  if (DEMO_LOGIN_IDS.has(row.login_id)) skip = '데모 계정 (가짜 번호라 실제 발송 안 함)';
  else if (!/^01\d{8,9}$/.test(to)) skip = '휴대폰 번호 형식 아님';
  else if (c.allow && !c.allow.has(to)) skip = '허용 번호 목록에 없음';
  else if (sentToday(db) >= c.dailyLimit) skip = `하루 발송 한도(${c.dailyLimit}건) 초과`;
  if (skip) { update(db, smsId, { status: 'skipped', error: skip }); return 'skipped'; }

  update(db, smsId, { status: 'sending' }); // 한도 계산에 바로 포함되도록 먼저 표시
  try {
    const r = await transport({ to, from: c.sender, text: row.message, subject: SUBJECT[row.kind] });
    update(db, smsId, { status: 'sent', provider_id: (r && r.id) || null, sent_at: nowStamp(), error: null });
    return 'sent';
  } catch (e) {
    const msg = String((e && (e.message || e.errorMessage)) || e).slice(0, 200);
    console.error(`[SMS] 발송 실패 #${smsId}: ${msg}`);
    update(db, smsId, { status: 'failed', error: msg });
    return 'failed';
  }
}

// 트랜잭션이 끝난 뒤(같은 요청 처리 직후) 비동기로 발송 — 발송이 실패해도 예약은 그대로 처리된다
const pending = new Set();
function schedule(db, smsId) {
  process.nextTick(() => {
    const p = dispatch(db, smsId).catch(e => console.error('[SMS]', e)).finally(() => pending.delete(p));
    pending.add(p);
  });
}
const flush = async () => { await new Promise(r => setImmediate(r)); await Promise.all([...pending]); };

module.exports = { config, status, isEnabled, setEnabled, dispatch, schedule, setTransport, flush, DEMO_LOGIN_IDS, mask };
