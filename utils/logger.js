const fs = require('fs');
const path = require('path');
const { createLogger, format, transports } = require('winston');

const { combine, timestamp, printf } = format;

// Where logs will be saved
const LOG_DIR = path.resolve(process.cwd(), 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// Final log format
const logFormat = printf(({ level, message, timestamp }) => {
  return `${timestamp} [${level.toUpperCase()}] ${message}`;
});

function createTestLogger(testName) {
  const sanitized = testName.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
  const logFile = path.join(LOG_DIR, `${sanitized}.log`);

  const logger = createLogger({
    level: 'info',
    format: combine(
      timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
      logFormat
    ),
    transports: [
      new transports.Console(),
      new transports.File({ filename: logFile })
    ]
  });

  logger.__logFile = logFile;
  return logger;
}

module.exports = { createTestLogger };
