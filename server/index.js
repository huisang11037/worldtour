'use strict';
// 미스터 월드 테마 여행 서비스 - 웹 서버
//   고객 화면: http://localhost:3000/          (index.html)
//   직원 화면: http://localhost:3000/staff     (staff.html)
//   API:       http://localhost:3000/api/...
const path = require('node:path');
const express = require('express');
const { openDb } = require('./db');
const { seedIfEmpty } = require('./seed');
const { sessionMiddleware } = require('./auth');
const { HttpError } = require('./util');
const rules = require('./rules');

function createApp(db) {
  const app = express();
  const root = path.join(__dirname, '..');
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Render 등 HTTPS 프록시 뒤에서 req.secure 판별
  app.use(express.json({ limit: '100kb' }));
  app.use(sessionMiddleware(db));

  app.use('/api', require('./routes/customer')(db));
  app.use('/api/staff', require('./routes/staff')(db));
  app.use('/api', (req, res, next) => next(new HttpError(404, '존재하지 않는 API입니다.')));

  // 정적 화면 파일 (저장소 안의 서버 코드·DB 파일은 노출하지 않도록 필요한 파일만 제공)
  app.get(['/', '/index.html'], (req, res) => res.sendFile(path.join(root, 'index.html')));
  app.get(['/staff', '/staff.html'], (req, res) => res.sendFile(path.join(root, 'staff.html')));

  // 오류 응답: { error: '메시지', ...추가정보 }
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err.type === 'entity.parse.failed') err = new HttpError(400, '요청 형식이 올바르지 않습니다.');
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json(Object.assign({ error: status >= 500 ? '서버 오류가 발생했습니다.' : err.message }, err.extra || {}));
  });
  return app;
}

module.exports = { createApp };

if (require.main === module) {
  const db = openDb();
  if (seedIfEmpty(db)) console.log('빈 데이터베이스에 초기 데이터를 넣었습니다.');
  rules.ensureDepartures(db);
  const port = Number(process.env.PORT) || 3000;
  createApp(db).listen(port, () => {
    console.log(`미스터 월드 서버 실행 중`);
    console.log(`  고객 화면  http://localhost:${port}/`);
    console.log(`  직원 화면  http://localhost:${port}/staff   (staff / 1234)`);
    console.log(`  DB 파일    ${db.file}`);
  });
}
