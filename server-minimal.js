import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { nanoid } from 'nanoid';

const app = express();
const PORT = process.env.PORT || 8080;

// Environment
const BACKEND_V2_URL = process.env.BACKEND_V2_URL || '';
const PERSONALAI_URL = process.env.PERSONALAI_URL || '';
const PLACES_SERVICE_URL = process.env.PLACES_SERVICE_URL || '';

// Logger
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

function reqId(req) {
  return req.headers['x-request-id'] || `rw_${nanoid(12)}`;
}

// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// Structured logging
app.use(pinoHttp({
  logger,
  genReqId: (req, res) => {
    const id = reqId(req);
    res.setHeader('x-request-id', id);
    return id;
  },
  customProps: (req, res) => ({
    route: req.path,
    tenant_id: req.headers['x-tenant-id'] || undefined,
  })
}));

// Helper to forward requests with request ID
async function forwardRequest(url, options = {}, req, res) {
  const rid = res.getHeader('x-request-id') || req.headers['x-request-id'] || `rw_${nanoid(12)}`;

  const headers = {
    'content-type': 'application/json',
    'x-request-id': rid,
    ...(options.headers || {})
  };

  const r = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  return r;
}

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: {
      backend_v2: !!BACKEND_V2_URL,
      personalai: !!PERSONALAI_URL,
      places: !!PLACES_SERVICE_URL
    }
  });
});

// Backend-v2 pass-through handlers
app.post('/api/route', async (req, res) => {
  if (!BACKEND_V2_URL) {
    return res.status(503).json({ ok: false, code: 'backend_not_configured' });
  }
  try {
    const r = await forwardRequest(
      `${BACKEND_V2_URL}/api/route`,
      { method: 'POST', body: req.body || {} },
      req,
      res
    );
    const txt = await r.text();
    res.status(r.status).set('content-type', r.headers.get('content-type') || 'application/json').send(txt);
  } catch (error) {
    req.log.error({ err: error, endpoint: '/api/route' }, 'Backend-v2 route error');
    res.status(502).json({ ok: false, code: 'backend_error' });
  }
});

app.get('/api/hazards', async (req, res) => {
  if (!BACKEND_V2_URL) {
    return res.status(503).json({ ok: false, code: 'backend_not_configured' });
  }
  try {
    const qs = new URLSearchParams(req.query).toString();
    const r = await forwardRequest(
      `${BACKEND_V2_URL}/api/hazards?${qs}`,
      { method: 'GET' },
      req,
      res
    );
    const txt = await r.text();
    res.status(r.status).set('content-type', r.headers.get('content-type') || 'application/json').send(txt);
  } catch (error) {
    req.log.error({ err: error, endpoint: '/api/hazards' }, 'Backend-v2 hazards error');
    res.status(502).json({ ok: false, code: 'backend_error' });
  }
});

app.all('/api/profile', async (req, res) => {
  if (!BACKEND_V2_URL) {
    return res.status(503).json({ ok: false, code: 'backend_not_configured' });
  }
  try {
    const r = await forwardRequest(
      `${BACKEND_V2_URL}/api/profile`,
      {
        method: req.method,
        headers: { cookie: req.headers.cookie || '' },
        body: req.method === 'PUT' ? req.body || {} : undefined,
      },
      req,
      res
    );
    const setCookie = r.headers.get('set-cookie');
    if (setCookie) res.setHeader('set-cookie', setCookie);
    const txt = await r.text();
    res.status(r.status).set('content-type', r.headers.get('content-type') || 'application/json').send(txt);
  } catch (error) {
    req.log.error({ err: error, endpoint: '/api/profile' }, 'Backend-v2 profile error');
    res.status(502).json({ ok: false, code: 'backend_error' });
  }
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'roamwise-proxy-minimal',
    version: '1.0.0',
    endpoints: ['/health', '/api/route', '/api/hazards', '/api/profile']
  });
});

// Error handler
app.use((err, req, res, next) => {
  const log = req.log || logger;
  log.error({ err }, 'Unhandled error');
  res.status(500).json({ ok: false, error: 'Internal server error' });
});

// Start
app.listen(PORT, () => {
  logger.info({ port: PORT, backend_v2: !!BACKEND_V2_URL }, 'Minimal proxy started');
});
