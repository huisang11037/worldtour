'use strict';
// 비밀번호 해시, 로그인 세션(쿠키), 권한 검사 미들웨어
const crypto = require('node:crypto');
const { HttpError, nowStamp, toKey, addDays, today } = require('./util');

const COOKIE = 'mw_sid';
// HTTPS(배포 환경)로 접속했으면 Secure 쿠키
const secure = res => (res.req && res.req.secure ? '; Secure' : '');
const SESSION_DAYS = 7;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex');
  const b = crypto.scryptSync(String(pw), salt, 32);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function createSession(db, res, userId) {
  const token = crypto.randomBytes(24).toString('hex');
  const expires = toKey(addDays(today(), SESSION_DAYS));
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(token, userId, nowStamp(), expires);
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure(res)}`);
  return token;
}
function destroySession(db, req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure(res)}`);
}

// 모든 요청에 req.user 채우기 (로그인 안 했으면 null)
function sessionMiddleware(db) {
  const find = db.prepare(`SELECT u.id, u.login_id, u.name, u.address, u.phone, u.role, u.created_at
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at >= ?`);
  return (req, res, next) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    req.user = token ? find.get(token, toKey(today())) || null : null;
    next();
  };
}

const requireLogin = (req, res, next) => next(req.user ? undefined : new HttpError(401, '로그인이 필요합니다.'));
const requireStaff = (req, res, next) => {
  if (!req.user) return next(new HttpError(401, '직원 로그인이 필요합니다.'));
  if (req.user.role !== 'staff') return next(new HttpError(403, '직원만 이용할 수 있습니다.'));
  next();
};

module.exports = { hashPassword, verifyPassword, createSession, destroySession, sessionMiddleware, requireLogin, requireStaff };
