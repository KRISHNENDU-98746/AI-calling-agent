const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.PORT = '34568';
process.env.NODE_ENV = 'test';
process.env.INTERNAL_AGENT_SECRET = 'test-internal-secret';
process.env.TWILIO_ACCOUNT_SID = 'ACtestaccount';
process.env.TWILIO_AUTH_TOKEN = 'test-auth-token';
process.env.TWILIO_PHONE_NUMBER = '+15551234567';

const twilioRouter = require('../src/routes/twilio');
const { server } = require('../src/server');

function request(port, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/make-call',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

function listen() {
  return new Promise((resolve) => {
    if (server.listening) return resolve(server.address().port);
    server.once('listening', () => resolve(server.address().port));
  });
}

describe('POST /make-call', () => {
  after(async () => {
    twilioRouter.setTwilioClientFactoryForTests((accountSid, authToken) =>
      require('twilio')(accountSid, authToken)
    );
    await new Promise((resolve) => server.close(resolve));
  });

  it('creates a call with the validated destination and configured caller', async () => {
    let received;
    twilioRouter.setTwilioClientFactoryForTests(() => ({
      calls: {
        create: async (params) => {
          received = params;
          return { sid: 'CA_mocked', status: 'queued' };
        },
      },
    }));

    const port = await listen();
    const response = await request(
      port,
      { to: '+919635203250' },
      { 'x-internal-agent-secret': 'test-internal-secret' }
    );

    assert.equal(response.status, 201);
    assert.deepEqual(response.body, { success: true, callSid: 'CA_mocked', status: 'queued' });
    assert.equal(received.to, '+919635203250');
    assert.equal(received.from, '+15551234567');
    assert.match(
      received.twiml,
      /<Gather[^>]*input="speech"[^>]*action="[^"]*\/make-call\/gather"/i
    );
    assert.match(
      received.twiml,
      /Hello, this is the clinic appointment assistant\. How can I help you\?/i
    );
  });

  it('rejects a non-E.164 destination without calling Twilio', async () => {
    let called = false;
    twilioRouter.setTwilioClientFactoryForTests(() => ({
      calls: { create: async () => { called = true; } },
    }));

    const port = await listen();
    const response = await request(
      port,
      { to: '9635203250' },
      { 'x-internal-agent-secret': 'test-internal-secret' }
    );

    assert.equal(response.status, 400);
    assert.equal(called, false);
  });

  it('returns 400 for malformed JSON instead of attempting a call', async () => {
    let called = false;
    twilioRouter.setTwilioClientFactoryForTests(() => ({
      calls: { create: async () => { called = true; } },
    }));

    const port = await listen();
    const payload = Buffer.from('{"to":"+919635203250"');
    const response = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/make-call',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': payload.length,
            'x-internal-agent-secret': 'test-internal-secret',
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
        }
      );
      req.on('error', reject);
      req.end(payload);
    });

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'Invalid JSON request body' });
    assert.equal(called, false);
  });

  it('returns safe Twilio diagnostics without exposing credentials', async () => {
    const originalError = console.error;
    const logs = [];
    console.error = (...args) => logs.push(args);
    try {
      twilioRouter.setTwilioClientFactoryForTests(() => ({
        calls: {
          create: async () => {
            const error = new Error('Request failed with test-auth-token');
            error.code = 21211;
            error.status = 400;
            error.moreInfo = 'https://www.twilio.com/docs/errors/21211';
            throw error;
          },
        },
      }));

      const port = await listen();
      const response = await request(
        port,
        { to: '+919635203250' },
        { 'x-internal-agent-secret': 'test-internal-secret' }
      );

      assert.equal(response.status, 500);
      assert.deepEqual(response.body, {
        success: false,
        error: 'Unable to place call',
        code: '21211',
      });
      assert.match(JSON.stringify(logs), /21211/);
      assert.doesNotMatch(JSON.stringify(logs), /test-auth-token/);
    } finally {
      console.error = originalError;
    }
  });
});
