// ============================================
// 셔틀버스 GPS 서버 v4 — JSON 파일 영구 저장
// 실행: node server.js
// ============================================

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = 3000;
const DATA_DIR = path.join(__dirname, 'data');

// data 폴더 없으면 생성
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// ── 날짜 유틸 ────────────────────────────────
function todayStr() {
  return new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
}
function dataFile(date) {
  return path.join(DATA_DIR, `reservations_${date}.json`);
}

// ── JSON 파일 읽기/쓰기 ──────────────────────
function loadReservations(date) {
  const file = dataFile(date);
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch(e) { return {}; }
}
function saveReservations(date, data) {
  fs.writeFileSync(dataFile(date), JSON.stringify(data, null, 2), 'utf-8');
}

// ── 좌석 설정 ────────────────────────────────
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

function getSeatsInfo(busId, date) {
  const d = date || todayStr();
  const data = loadReservations(d);
  const total = TOTAL_SEATS[busId] ?? DEFAULT_SEATS;
  const reserved = (data[busId] || []).length;
  return { busId, date: d, total, reserved, available: total - reserved };
}

// ── SSE 클라이언트 ───────────────────────────
const clients = new Set();

function broadcastSeats(busId) {
  const info = getSeatsInfo(busId);
  const msg = `data: ${JSON.stringify({ type: 'seats', ...info })}\n\n`;
  clients.forEach(client => {
    if (client.busId === null || client.busId === busId) {
      try { client.res.write(msg); } catch (e) { clients.delete(client); }
    }
  });
}

// ── GPS 관련 ─────────────────────────────────
const busLocations = {};
const activeSenders = {};
const SENDER_TIMEOUT_MS = 10000;

// ── HTTP 서버 ────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, ngrok-skip-browser-warning');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, 'http://localhost');

  // ─── 예약 API ────────────────────────────────

  // ⓐ 예약 생성 POST /reserve
  if (req.method === 'POST' && url.pathname === '/reserve') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { busId, studentId, name, stopId, date } = JSON.parse(body);
        if (!busId || !studentId) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'busId, studentId 필수' })); return;
        }

        const d = date || todayStr();
        const data = loadReservations(d);
        if (!data[busId]) data[busId] = [];

        // 중복 예약 방지
        const already = data[busId].find(r => r.studentId === studentId);
        if (already) {
          res.writeHead(409); res.end(JSON.stringify({ error: 'ALREADY_RESERVED', message: '이미 예약된 학생입니다' })); return;
        }

        const { available } = getSeatsInfo(busId, d);
        if (available <= 0) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'NO_SEATS', message: '잔여 좌석이 없습니다' })); return;
        }

        data[busId].push({
          studentId,
          name: name || '학생',
          stopId: stopId || null,   // 세부 정류장
          reservedAt: Date.now()
        });
        saveReservations(d, data);
        broadcastSeats(busId);

        const info = getSeatsInfo(busId, d);
        console.log(`[예약] busId=${busId} studentId=${studentId} stop=${stopId} 잔여=${info.available}/${info.total}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...info }));
      } catch (e) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'invalid JSON' }));
      }
    });
    return;
  }

  // ⓑ 예약 취소 POST /cancel
  if (req.method === 'POST' && url.pathname === '/cancel') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { busId, studentId, date } = JSON.parse(body);
        if (!busId || !studentId) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'busId, studentId 필수' })); return;
        }

        const d = date || todayStr();
        const data = loadReservations(d);
        if (!data[busId]) data[busId] = [];

        const before = data[busId].length;
        data[busId] = data[busId].filter(r => r.studentId !== studentId);

        if (data[busId].length === before) {
          res.writeHead(404); res.end(JSON.stringify({ error: 'NOT_FOUND', message: '예약 내역이 없습니다' })); return;
        }

        saveReservations(d, data);
        broadcastSeats(busId);
        const info = getSeatsInfo(busId, d);
        console.log(`[취소] busId=${busId} studentId=${studentId} 잔여=${info.available}/${info.total}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...info }));
      } catch (e) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'invalid JSON' }));
      }
    });
    return;
  }

  // ⓒ 좌석 현황 조회 GET /seats?busId=BUS-001-GO&date=2026-05-24
  if (req.method === 'GET' && url.pathname === '/seats') {
    const busId = url.searchParams.get('busId');
    const date  = url.searchParams.get('date') || todayStr();
    if (busId) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getSeatsInfo(busId, date)));
    } else {
      const all = {};
      Object.keys(TOTAL_SEATS).forEach(id => { all[id] = getSeatsInfo(id, date); });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(all));
    }
    return;
  }

  // ⓓ 예약 초기화 POST /reset
  if (req.method === 'POST' && url.pathname === '/reset') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { busId, date } = JSON.parse(body || '{}');
        const d = date || todayStr();
        const data = loadReservations(d);

        if (busId) {
          data[busId] = [];
          saveReservations(d, data);
          broadcastSeats(busId);
          console.log(`[초기화] busId=${busId} date=${d}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, reset: busId }));
        } else {
          Object.keys(TOTAL_SEATS).forEach(id => { data[id] = []; });
          saveReservations(d, data);
          Object.keys(TOTAL_SEATS).forEach(id => broadcastSeats(id));
          console.log(`[전체초기화] date=${d}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, reset: 'ALL' }));
        }
      } catch (e) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'invalid JSON' }));
      }
    });
    return;
  }

  // ⓔ 날짜별 예약 상세 조회 GET /reservations?date=2026-05-24
  if (req.method === 'GET' && url.pathname === '/reservations') {
    const date = url.searchParams.get('date') || todayStr();
    const data = loadReservations(date);

    // 노선별 정류장별 집계 추가
    const summary = {};
    Object.entries(data).forEach(([busId, list]) => {
      const stopCounts = {};
      list.forEach(r => {
        const stop = r.stopId || '미지정';
        stopCounts[stop] = (stopCounts[stop] || 0) + 1;
      });
      summary[busId] = { total: list.length, stops: stopCounts, list };
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ date, summary }));
    return;
  }

  // ⓕ 저장된 날짜 목록 GET /dates
  if (req.method === 'GET' && url.pathname === '/dates') {
    const files = fs.readdirSync(DATA_DIR)
      .filter(f => f.startsWith('reservations_') && f.endsWith('.json'))
      .map(f => f.replace('reservations_', '').replace('.json', ''))
      .sort().reverse();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ dates: files }));
    return;
  }

  // ─── GPS 위치 API ─────────────────────────────
  if (req.method === 'POST' && url.pathname === '/location') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const busId = data.busId || 'BUS-001';
        const senderToken = data.senderToken || null;
        const now = Date.now();

        if (activeSenders[busId]) {
          const { token, lastSeen } = activeSenders[busId];
          const isExpired = (now - lastSeen) > SENDER_TIMEOUT_MS;
          if (!isExpired && token !== senderToken) {
            console.warn(`[중복차단] busId=${busId}`);
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'DUPLICATE_SENDER' }));
            return;
          }
        }

        activeSenders[busId] = { token: senderToken, lastSeen: now };
        busLocations[busId] = { ...data, busId, timestamp: now };

        const msg = `data: ${JSON.stringify(busLocations[busId])}\n\n`;
        clients.forEach(client => {
          if (client.busId === null || client.busId === busId) {
            try { client.res.write(msg); } catch (e) { clients.delete(client); }
          }
        });

        console.log(`[위치수신] busId=${busId} lat=${data.lat?.toFixed(5)} lng=${data.lng?.toFixed(5)}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, clients: clients.size }));
      } catch (e) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'invalid JSON' }));
      }
    });
    return;
  }

  // ─── SSE 구독 ─────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/stream') {
    const busId = url.searchParams.get('busId') || null;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('ngrok-skip-browser-warning', 'true');
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.writeHead(200);

    if (busId && busLocations[busId]) {
      res.write(`data: ${JSON.stringify(busLocations[busId])}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'seats', ...getSeatsInfo(busId) })}\n\n`);
    } else if (!busId) {
      Object.values(busLocations).forEach(loc => res.write(`data: ${JSON.stringify(loc)}\n\n`));
      Object.keys(TOTAL_SEATS).forEach(id => res.write(`data: ${JSON.stringify({ type: 'seats', ...getSeatsInfo(id) })}\n\n`));
    }

    const client = { res, busId };
    clients.add(client);
    console.log(`[SSE연결] busId=${busId || '전체'} 구독자=${clients.size}`);
    req.on('close', () => { clients.delete(client); console.log(`[SSE해제] 구독자=${clients.size}`); });
    return;
  }

  // ─── 기타 ─────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/buses') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(busLocations));
    return;
  }

  if (req.method === 'GET') {
    const fileName = url.pathname === '/' ? 'receiver.html' : decodeURIComponent(url.pathname.slice(1));
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
  console.log('  셔틀버스 GPS 서버 v4');
  console.log('====================================');
  console.log(`  http://localhost:${PORT}`);
  console.log('  POST /reserve               예약 생성 (stopId 포함)');
  console.log('  POST /cancel                예약 취소');
  console.log('  POST /reset                 예약 초기화');
  console.log('  GET  /seats?date=           좌석 현황');
  console.log('  GET  /reservations?date=    날짜별 예약 상세');
  console.log('  GET  /dates                 저장된 날짜 목록');
  console.log('  GET  /stream?busId=         SSE 구독');
  console.log('  GET  /buses                 전체 위치');
  console.log('====================================\n');
});
