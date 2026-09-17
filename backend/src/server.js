const http = require('http');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { WebSocketServer } = require('ws');

const { env, validateEnv } = require('./config/env');
const { hasFirebaseCredentials } = require('./config/firebase');
const healthRouter = require('./routes/health');
const twilioRouter = require('./routes/twilio');
const { attachMediaStreamServer } = require('./websocket/mediaStream');

const app = express();

app.set('trust proxy', 1);

app.use(helmet());
app.use(
  cors({
    origin: false, // API is server-to-server (Twilio); browser CORS not required
  })
);

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
  })
);

app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '100kb' }));

// Register API routes before the 404 handler.
app.use(healthRouter);
app.use(twilioRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, _req, res, _next) => {
  console.error('[server] Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

const server = http.createServer(app);

const wss = new WebSocketServer({
  server,
  path: '/media-stream',
});

attachMediaStreamServer(wss);

const envStatus = validateEnv({ strict: false });
const port = Number(process.env.PORT) || env.port || 3000;

server.listen(port, '0.0.0.0', () => {
  console.log(`[server] Appointment Voice Agent listening on port ${port}`);
  console.log(`[server] Health check: GET /health`);
  console.log(`[server] Twilio voice webhook: POST /voice`);
  console.log(`[server] Media stream WebSocket: /media-stream`);
  console.log(`[server] Firebase configured: ${hasFirebaseCredentials()}`);
  console.log(`[server] Call-ready env: ${envStatus.ok}`);
});

function shutdown(signal) {
  console.log(`[server] Received ${signal}, shutting down`);
  wss.clients.forEach((client) => {
    try {
      client.close();
    } catch {
      // ignore
    }
  });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { app, server };
