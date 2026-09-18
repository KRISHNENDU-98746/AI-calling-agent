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
    const payload = JSON.parse(res.body);
    assert.equal(payload.status, 'ok');
    assert.equal(payload.service, 'ai-appointment-agent');
    assert.equal(payload.endpoints.exotel, '/exotel');
    assert.equal(payload.endpoints.exotelMediaStream, '/exotel-media-stream');
    assert.equal(payload.endpoints.voice, '/voice');
    assert.equal(payload.endpoints.mediaStream, '/media-stream');
    assert.equal(typeof payload.config.sarvamConfigured, 'boolean');
    assert.equal(typeof payload.config.firebaseConfigured, 'boolean');
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

  it('POST /exotel returns Exotel Voicebot WSS url JSON', async () => {
    const port = await listen();
    const res = await request(
      port,
      'POST',
      '/exotel',
      'CallSid=EXOTELTEST&From=%2B919999999999&To=%2B919513886363'
    );

    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'] || '', /json/i);
    const payload = JSON.parse(res.body);
    assert.equal(typeof payload.url, 'string');
    assert.match(payload.url, /^wss:\/\//i);
    assert.match(payload.url, /\/exotel-media-stream/i);
  });

  it('GET /exotel returns Exotel Voicebot WSS url JSON', async () => {
    const port = await listen();
    const res = await request(port, 'GET', '/exotel?CallSid=EXOTELGET&From=%2B919999999999');
    assert.equal(res.status, 200);
    const payload = JSON.parse(res.body);
    assert.match(payload.url, /\/exotel-media-stream/i);
  });

  it('WebSocket /exotel-media-stream stays open after start (no server hangup)', async () => {
    const port = await listen();

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/exotel-media-stream?sample-rate=8000`);
      const timer = setTimeout(() => {
        reject(new Error('Exotel WebSocket connect timed out'));
      }, 8000);
      let closedEarly = false;

      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            event: 'connected',
            protocol: 'Call',
            version: '1.0.0',
          })
        );
        ws.send(
          JSON.stringify({
            event: 'start',
            sequence_number: '1',
            stream_sid: 'MZ_TEST_STREAM',
            start: {
              stream_sid: 'MZ_TEST_STREAM',
              call_sid: 'EXOTEL_TEST_CALL',
              from: '+919999999999',
              to: '+919513886363',
              custom_parameters: {},
            },
          })
        );

        // Server must NOT close the socket on its own after start/greeting attempt.
        setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.close();
            return;
          }
          closedEarly = true;
          clearTimeout(timer);
          reject(new Error('Exotel WebSocket closed by server before client hangup'));
        }, 1200);
      });

      ws.on('close', () => {
        clearTimeout(timer);
        if (closedEarly) return;
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

  it('WebSocket /ws accepts Edesy metadata frame then disconnect', async () => {
    const port = await listen();

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const timer = setTimeout(() => {
        reject(new Error('Edesy WebSocket connect timed out'));
      }, 5000);

      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            call_sid: 'test-call-sid',
            callSid: 'test-call-sid',
            direction: 'inbound',
            from: '919876543210',
            to: '917969002802',
            sampleRate: 16000,
            mixType: 'mono',
            call_status: 'in-progress',
          })
        );
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

describe('Sarvam realtime STT encoding', () => {
  it('maps legacy pcm_s16le to linear16 for realtime API', () => {
    const { normalizeRealtimeEncoding } = require('../src/services/sarvam');
    assert.equal(normalizeRealtimeEncoding('pcm_s16le'), 'linear16');
    assert.equal(normalizeRealtimeEncoding('linear16'), 'linear16');
    assert.equal(normalizeRealtimeEncoding('mulaw'), 'mulaw');
    assert.equal(normalizeRealtimeEncoding('slin'), 'linear16');
  });
});
