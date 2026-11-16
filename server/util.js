'use strict';
// 날짜·오류 등 공통 유틸

// 배포 서버(Render 등)는 UTC로 동작하므로 날짜 계산을 한국 시간 기준으로 맞춘다.
if (!process.env.TZ) process.env.TZ = 'Asia/Seoul';

const pad = n => String(n).padStart(2, '0');

// Date → 'YYYY-MM-DD'
const toKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// 'YYYY-MM-DD' → Date (현지 자정)
const fromKey = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const isDateKey = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && toKey(fromKey(s)) === s;

// 오늘 날짜 (시간 제외). 테스트·시연용으로 MW_TODAY=YYYY-MM-DD 환경변수로 고정할 수 있다.
function today() {
  if (process.env.MW_TODAY && isDateKey(process.env.MW_TODAY)) return fromKey(process.env.MW_TODAY);
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}
const todayKey = () => toKey(today());

// 'YYYY-MM-DD HH:MM:SS' 현재 시각
function nowStamp() {
  const n = new Date();
  const t = today();
  return `${toKey(t)} ${pad(n.getHours())}:${pad(n.getMinutes())}:${pad(n.getSeconds())}`;
}

// 오늘 이후 첫 토요일부터 N개의 토요일 출발일 (오늘 + startAfterDays 이후)
function upcomingSaturdays(count = 8, startAfterDays = 7) {
  let d = addDays(today(), startAfterDays);
  while (d.getDay() !== 6) d = addDays(d, 1);
  return Array.from({ length: count }, (_, i) => toKey(addDays(d, i * 7)));
}
// N일 전 기준 가장 가까운 지난 토요일
function pastSaturday(daysAgo) {
  let d = addDays(today(), -daysAgo);
  while (d.getDay() !== 6) d = addDays(d, -1);
  return toKey(d);
}

const won = n => Number(n).toLocaleString('ko-KR') + '원';

// API 오류 (status 코드 + 사용자에게 보여줄 메시지)
class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra || null;
  }
}
const bad = (msg, extra) => new HttpError(400, msg, extra);

module.exports = { pad, toKey, fromKey, addDays, isDateKey, today, todayKey, nowStamp, upcomingSaturdays, pastSaturday, won, HttpError, bad };
