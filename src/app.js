const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const config = require('./config');
const routes = require('./routes');
const notFound = require('./middleware/notFound');
const errorHandler = require('./middleware/errorHandler');
const rejectOperatorKeys = require('./middleware/rejectOperatorKeys');
const redactUrl = require('./utils/redactUrl');
const { uploadsDir, ensureUploadsDir } = require('./utils/uploads');

const app = express();

// Real visitor IPs behind a hosting proxy (see config.trustProxy).
if (config.trustProxy) {
  app.set('trust proxy', /^\d+$/.test(config.trustProxy) ? Number(config.trustProxy) : config.trustProxy);
}

// Security headers (nosniff, no framing, referrer policy, HSTS, ...). The
// website runs on another address and shows the photos in /uploads, so other
// sites may load our files (Cross-Origin-Resource-Policy: cross-origin);
// reading API responses is still limited by CORS below.
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

// Browsers may only call the API from KitchenLink's own website(s). Requests
// without an Origin (server-to-server, Postman, health checks) aren't
// affected: CORS only applies in browsers. Other sites simply get no CORS
// headers, so the browser refuses to give them the response.
const allowedOrigins = new Set(config.allowedOrigins);
app.use(
  cors({
    origin: (origin, callback) => callback(null, !origin || allowedOrigins.has(origin)),
  })
);
app.use(express.json({ limit: '1mb' }));
// Central safety net: no MongoDB operator keys in any body or query string.
app.use(rejectOperatorKeys);

ensureUploadsDir();
app.use(
  config.vendor.uploads.publicPath,
  express.static(uploadsDir, { maxAge: '7d', fallthrough: true })
);

app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    console.log(
      `${req.method} ${redactUrl(req.originalUrl)} ${res.statusCode} ${Date.now() - startedAt}ms`
    );
  });
  next();
});

app.use('/api/v1', routes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
