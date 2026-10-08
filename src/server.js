const mongoose = require('mongoose');
const config = require('./config');
const app = require('./app');

const start = async () => {
  try {
    await mongoose.connect(config.mongoUri);
    console.log(`MongoDB connected: ${config.mongoUri}`);

    app.listen(config.port, () => {
      console.log(`API listening on http://localhost:${config.port}/api/v1`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

start();
