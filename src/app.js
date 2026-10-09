const express = require('express');
const cors = require('cors');
const config = require('./config');
const routes = require('./routes');
const notFound = require('./middleware/notFound');
const errorHandler = require('./middleware/errorHandler');
const { uploadsDir, ensureUploadsDir } = require('./utils/uploads');

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

ensureUploadsDir();
app.use(
  config.vendor.uploads.publicPath,
  express.static(uploadsDir, { maxAge: '7d', fallthrough: true })
);

app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    console.log(
      `${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - startedAt}ms`
    );
  });
  next();
});

app.use('/api/v1', routes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
