const http = require('http');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { WebSocketServer } = require('ws');

const { env, validateEnv, reportTwilioEnvStatus } = require('./config/env');
const { hasFirebaseCredentials } = require('./config/firebase');
const healthRouter = require('./routes/health');
const twilioRouter = require('./routes/twilio');
const exotelRouter = require('./routes/exotel');
const internalRouter = require('./routes/internal');
const { attachMediaStreamServer } = require('./websocket/mediaStream');
const { attachExotelMediaStreamServer } = require('./websocket/exotelMediaStream');
const { attachEdesyMediaStreamServer } = require('./websocket/edesyMediaStream');

const app = express();

app.set('trust proxy', 1);

app.use(helmet());
app.use(
  cors({
    origin: false, // API is server-to-server (Twilio/Exotel); browser CORS not required
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
app.use(express.json());

// Register API routes before the 404 handler.
app.use(healthRouter);
app.use(twilioRouter);
app.use(exotelRouter);
app.use(internalRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, _req, res, _next) => {
  console.error('[server] Unhandled error:', err.message);
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON request body' });
  }
  res.status(500).json({ error: 'Internal server error' });
});

const server = http.createServer(app);

const twilioMediaWss = new WebSocketServer({ noServer: true });
attachMediaStreamServer(twilioMediaWss);

const exotelMediaWss = new WebSocketServer({ noServer: true });
attachExotelMediaStreamServer(exotelMediaWss);

// Edesy custom agent: same HTTP server, path /ws per platform docs.
const edesyMediaWss = new WebSocketServer({ noServer: true });
attachEdesyMediaStreamServer(edesyMediaWss);

server.on('upgrade', (request, socket, head) => {
  let pathname = '/';
  try {
    pathname = new URL(request.url || '/', 'http://localhost').pathname;
  } catch {
    socket.destroy();
    return;
  }

  if (pathname === '/media-stream') {
    twilioMediaWss.handleUpgrade(request, socket, head, (ws) => {
      twilioMediaWss.emit('connection', ws, request);
    });
    return;
  }

  if (pathname === '/exotel-media-stream') {
    exotelMediaWss.handleUpgrade(request, socket, head, (ws) => {
      exotelMediaWss.emit('connection', ws, request);
    });
    return;
  }

  if (pathname === '/ws') {
    edesyMediaWss.handleUpgrade(request, socket, head, (ws) => {
      edesyMediaWss.emit('connection', ws, request);
    });
    return;
  }

  socket.destroy();
});

const envStatus = validateEnv({ strict: false });
reportTwilioEnvStatus(envStatus.twilio);
const port = Number(process.env.PORT) || env.port || 3000;

server.listen(port, '0.0.0.0', () => {
  console.log(`[server] Appointment Voice Agent listening on port ${port}`);
  console.log(`[server] Health check: GET /health`);
  console.log(`[server] Twilio voice webhook: POST /voice`);
  console.log(`[server] Exotel voicebot webhook: GET|POST /exotel`);
  console.log(`[server] Twilio media stream WebSocket: /media-stream`);
  console.log(`[server] Exotel media stream WebSocket: /exotel-media-stream`);
  console.log(`[server] Edesy custom agent WebSocket: /ws`);
  console.log(`[server] Firebase configured: ${hasFirebaseCredentials()}`);
  console.log(`[server] Call-ready env: ${envStatus.ok}`);
});

function shutdown(signal) {
  console.log(`[server] Received ${signal}, shutting down`);
  for (const wss of [twilioMediaWss, exotelMediaWss, edesyMediaWss]) {
    wss.clients.forEach((client) => {
      try {
        client.close();
      } catch {
        // ignore
      }
    });
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { app, server };
