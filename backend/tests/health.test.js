const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { WebSocket } = require('ws');

// Load server after setting a test PORT so listen does not clash.
process.env.PORT = process.env.PORT || '34567';
process.env.NODE_ENV = 'test';

const { server } = require('../src/server');

function listen() {
  return new Promise((resolve) => {
    if (server.listening) {
      resolve(server.address().port);
      return;
    }
    server.once('listening', () => resolve(server.address().port));
  });
}

function request(port, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(body) : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          ...(payload
            ? {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': payload.length,
              }
            : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('Appointment Voice Agent backend', () => {
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('GET /health returns ok payload', async () => {
    const port = await listen();
    const res = await request(port, 'GET', '/health');
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), {
      status: 'ok',
      service: 'appointment-voice-agent',
    });
  });

  it('POST /voice returns valid TwiML with Media Stream', async () => {
    const port = await listen();
    const res = await request(
      port,
      'POST',
      '/voice',
      'CallSid=CAtest123&From=%2B919999999999&To=%2B911111111111'
    );

    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'] || '', /xml/i);
    assert.match(res.body, /<Connect>/i);
    assert.match(res.body, /<Stream /i);
    assert.match(res.body, /\/media-stream/i);
  });

  it('WebSocket /media-stream survives client disconnect', async () => {
    const port = await listen();

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/media-stream`);
      const timer = setTimeout(() => {
        reject(new Error('WebSocket connect timed out'));
      }, 5000);

      ws.on('open', () => {
        ws.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
        ws.close();
      });

      ws.on('close', () => {
        clearTimeout(timer);
        resolve();
      });

      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    const res = await request(port, 'GET', '/health');
    assert.equal(res.status, 200);
  });
});

describe('env private key normalization', () => {
  it('converts escaped newlines', () => {
    process.env.FIREBASE_PRIVATE_KEY =
      '-----BEGIN PRIVATE KEY-----\\nABC\\n-----END PRIVATE KEY-----\\n';
    delete require.cache[require.resolve('../src/config/env')];
    const { env } = require('../src/config/env');
    assert.match(env.firebase.privateKey, /BEGIN PRIVATE KEY-----\nABC\n-----END/);
  });
});
