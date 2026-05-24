// ============================================
// 셔틀버스 GPS 서버 v3 — busId별 위치 관리
// 실행: node server.js
// ============================================

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = 3000;

// busId별 마지막 위치 저장
const busLocations = {};

// busId별 활성 송신 토큰 (중복 방지)
// 같은 busId로 두 번째 송신 시도 시 경고 반환
const activeSenders = {}; // busId → { token, lastSeen }
const SENDER_TIMEOUT_MS = 10000; // 10초 이상 미전송 시 자동 해제

// ── 좌석 관리 ──────────────────────────────
const TOTAL_SEATS = {
  'BUS-001-GO': 45, 'BUS-001-BACK': 45,
  'BUS-002-GO': 45, 'BUS-002-BACK': 45,
  'BUS-003-GO': 45, 'BUS-003-BACK': 45,
  'BUS-004-GO': 45, 'BUS-004-BACK': 45,
  'BUS-005-GO': 45, 'BUS-005-BACK': 45,
  'BUS-006-GO': 45, 'BUS-006-BACK': 45,
  'TEST-001-GO': 10, 'TEST-001-BACK': 10,
};
const DEFAULT_SEATS = 45;

// busId → [{ studentId, name, reservedAt }]
const reservations = {};

function getSeatsInfo(busId) {
  const total = TOTAL_SEATS[busId] ?? DEFAULT_SEATS;
  const reserved = (reservations[busId] || []).length;
  return { busId, total, reserved, available: total - reserved };
}

// 좌석 변경을 SSE로 브로드캐스트
function broadcastSeats(busId) {
  const info = getSeatsInfo(busId);
  const msg = `data: ${JSON.stringify({ type: 'seats', ...info })}\n\n`;
  clients.forEach(client => {
    if (client.busId === null || client.busId === busId) {
      try { client.res.write(msg); } catch (e) { clients.delete(client); }
    }
  });
}
// ────────────────────────────────────────────

// SSE 클라이언트 목록: { res, busId }
const clients = new Set();

const server = http.createServer((req, res) => {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, ngrok-skip-browser-warning');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ─── 예약 API ────────────────────────────────

  // ⓐ 예약 생성 POST /reserve
  if (req.method === 'POST' && req.url === '/reserve') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { busId, studentId, name } = JSON.parse(body);
        if (!busId || !studentId) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'busId, studentId 필수' })); return;
        }

        if (!reservations[busId]) reservations[busId] = [];

        // 중복 예약 방지
        const already = reservations[busId].find(r => r.studentId === studentId);
        if (already) {
          res.writeHead(409); res.end(JSON.stringify({ error: 'ALREADY_RESERVED', message: '이미 예약된 학생입니다' })); return;
        }

        const { available } = getSeatsInfo(busId);
        if (available <= 0) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'NO_SEATS', message: '잔여 좌석이 없습니다' })); return;
        }

        reservations[busId].push({ studentId, name: name || '학생', reservedAt: Date.now() });
        broadcastSeats(busId);

        const info = getSeatsInfo(busId);
        console.log(`[예약] busId=${busId} studentId=${studentId} 잔여=${info.available}/${info.total}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...info }));
      } catch (e) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'invalid JSON' }));
      }
    });
    return;
  }

  // ⓑ 예약 취소 POST /cancel
  if (req.method === 'POST' && req.url === '/cancel') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { busId, studentId } = JSON.parse(body);
        if (!busId || !studentId) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'busId, studentId 필수' })); return;
        }

        if (!reservations[busId]) reservations[busId] = [];
        const before = reservations[busId].length;
        reservations[busId] = reservations[busId].filter(r => r.studentId !== studentId);

        if (reservations[busId].length === before) {
          res.writeHead(404); res.end(JSON.stringify({ error: 'NOT_FOUND', message: '예약 내역이 없습니다' })); return;
        }

        broadcastSeats(busId);
        const info = getSeatsInfo(busId);
        console.log(`[취소] busId=${busId} studentId=${studentId} 잔여=${info.available}/${info.total}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...info }));
      } catch (e) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'invalid JSON' }));
      }
    });
    return;
  }

  // ⓒ 좌석 현황 조회 GET /seats?busId=BUS-001-GO
  if (req.method === 'GET' && req.url.startsWith('/seats')) {
    const busId = new URL(req.url, 'http://localhost').searchParams.get('busId');
    if (busId) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getSeatsInfo(busId)));
    } else {
      // 전체 노선 좌석 현황
      const all = {};
      Object.keys(TOTAL_SEATS).forEach(id => { all[id] = getSeatsInfo(id); });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(all));
    }
    return;
  }

  // ⓓ 예약 초기화 POST /reset
  // body: { busId: 'BUS-001-GO' } 또는 {} (전체)
  if (req.method === 'POST' && req.url === '/reset') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { busId } = JSON.parse(body || '{}');
        if (busId) {
          // 특정 노선 초기화
          reservations[busId] = [];
          broadcastSeats(busId);
          console.log(`[초기화] busId=${busId}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, reset: busId }));
        } else {
          // 전체 초기화
          Object.keys(reservations).forEach(id => { reservations[id] = []; });
          Object.keys(TOTAL_SEATS).forEach(id => broadcastSeats(id));
          console.log(`[전체초기화]`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, reset: 'ALL' }));
        }
      } catch (e) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'invalid JSON' }));
      }
    });
    return;
  }

  // ─── GPS 위치 API ─────────────────────────────
  if (req.method === 'POST' && req.url === '/location') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const busId = data.busId || 'BUS-001';
        const senderToken = data.senderToken || null; // 송신자 고유 토큰

        const now = Date.now();

        // 중복 송신 방지
        if (activeSenders[busId]) {
          const { token, lastSeen } = activeSenders[busId];
          const isExpired = (now - lastSeen) > SENDER_TIMEOUT_MS;

          if (!isExpired && token !== senderToken) {
            // 다른 기기가 이미 이 busId로 송신 중
            console.warn(`[중복차단] busId=${busId} 이미 활성 송신자 있음`);
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'DUPLICATE_SENDER', message: '이미 다른 기기가 이 노선을 송신 중입니다' }));
            return;
          }
        }

        // 송신자 등록/갱신
        activeSenders[busId] = { token: senderToken, lastSeen: now };

        busLocations[busId] = { ...data, busId, timestamp: now };

        const msg = `data: ${JSON.stringify(busLocations[busId])}\n\n`;
        clients.forEach(client => {
          if (client.busId === null || client.busId === busId) {
            try { client.res.write(msg); } catch (e) { clients.delete(client); }
          }
        });

        console.log(`[위치수신] busId=${busId} lat=${data.lat?.toFixed(5)} lng=${data.lng?.toFixed(5)} 구독자=${clients.size}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, clients: clients.size }));
      } catch (e) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'invalid JSON' }));
      }
    });
    return;
  }

  // ② SSE 구독 (/stream 또는 /stream?busId=TEST-001)
  if (req.method === 'GET' && req.url.startsWith('/stream')) {
    const busId = new URL(req.url, 'http://localhost').searchParams.get('busId') || null;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('ngrok-skip-browser-warning', 'true');
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.writeHead(200);

    // 연결 즉시 현재 위치 + 좌석 정보 전송
    if (busId && busLocations[busId]) {
      res.write(`data: ${JSON.stringify(busLocations[busId])}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'seats', ...getSeatsInfo(busId) })}\n\n`);
    } else if (!busId) {
      Object.values(busLocations).forEach(loc => {
        res.write(`data: ${JSON.stringify(loc)}\n\n`);
      });
      // 전체 좌석 현황도 전송
      Object.keys(TOTAL_SEATS).forEach(id => {
        res.write(`data: ${JSON.stringify({ type: 'seats', ...getSeatsInfo(id) })}\n\n`);
      });
    }

    const client = { res, busId };
    clients.add(client);
    console.log(`[SSE연결] busId=${busId || '전체'} 구독자=${clients.size}`);

    req.on('close', () => {
      clients.delete(client);
      console.log(`[SSE해제] 구독자=${clients.size}`);
    });
    return;
  }

  // ③ 현재 모든 버스 위치 조회
  if (req.method === 'GET' && req.url === '/buses') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(busLocations));
    return;
  }

  // ④ 정적 HTML 서빙
  if (req.method === 'GET') {
    const fileName = req.url === '/' ? 'receiver.html' : decodeURIComponent(req.url.slice(1));
    const filePath = path.join(__dirname, fileName);
    if (fs.existsSync(filePath) && filePath.endsWith('.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(filePath));
      return;
    }
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log('\n====================================');
  console.log('  셔틀버스 GPS 서버 v3');
  console.log('====================================');
  console.log(`  http://localhost:${PORT}`);
  console.log('  POST /reserve               예약 생성');
  console.log('  POST /cancel                예약 취소');
  console.log('  GET  /seats?busId=BUS-001-GO 좌석 조회');
  console.log('  GET  /seats                  전체 조회');
  console.log('  GET  /stream?busId=...       SSE 구독');
  console.log('  GET  /buses                  전체 위치');
  console.log('====================================\n');
});
