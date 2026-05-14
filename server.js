// ============================================
// 셔틀버스 GPS 서버 v2 — busId별 위치 관리
// 실행: node server.js
// ============================================

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = 3000;

// busId별 마지막 위치 저장
const busLocations = {};

// SSE 클라이언트 목록: { res, busId }
const clients = new Set();

const server = http.createServer((req, res) => {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, ngrok-skip-browser-warning');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ① 버스가 위치 전송
  if (req.method === 'POST' && req.url === '/location') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const busId = data.busId || 'BUS-001';
        busLocations[busId] = { ...data, busId, timestamp: Date.now() };

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

    // 연결 즉시 현재 위치 전송
    if (busId && busLocations[busId]) {
      res.write(`data: ${JSON.stringify(busLocations[busId])}\n\n`);
    } else if (!busId) {
      Object.values(busLocations).forEach(loc => {
        res.write(`data: ${JSON.stringify(loc)}\n\n`);
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
  console.log('  셔틀버스 GPS 서버 v2');
  console.log('====================================');
  console.log(`  http://localhost:${PORT}`);
  console.log('  /stream?busId=TEST-001  특정 버스');
  console.log('  /buses                  전체 위치 조회');
  console.log('====================================\n');
});