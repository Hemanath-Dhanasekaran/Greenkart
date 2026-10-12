const fs = require('fs');
const os = require('os');
const { test: base, expect } = require('@playwright/test');
const { createTestLogger } = require('./logger.js');
const { allure } = require('allure-playwright');

exports.test = base.extend({

  // 🔹 Winston file logger
  testLogger: async ({}, use, testInfo) => {
    const logger = createTestLogger(testInfo.title);
    await use(logger);

    // Attach log file only if test failed
    if (testInfo.status !== testInfo.expectedStatus && fs.existsSync(logger.__logFile)) {

      // Playwright attachment
      await testInfo.attach('execution-log', {
        body: fs.readFileSync(logger.__logFile),
        contentType: 'text/plain'
      });

      // Allure attachment
      await allure.attachment(
        'execution-log.txt',
        fs.readFileSync(logger.__logFile),
        'text/plain'
      );
    }
  },

  // 🔹 Unified logger (log())
  log: async ({ testLogger }, use, testInfo) => {

    const log = async (message) => {
      const ts = new Date().toISOString();
      const formatted = `${ts} - ${message}`;

      // Winston file
      testLogger.info(formatted);

      // Playwright inline
      await testInfo.attach(`LOG: ${formatted}`, {
        body: formatted,
        contentType: "text/plain"
      });

      // Allure
      // await allure.step(formatted, async () => {});
    };

    await use(log);

    // Environment info
    const envInfo = `
Test: ${testInfo.title}
Browser: ${testInfo.project.use.browserName}
OS: ${os.platform()} ${os.release()}
Machine: ${os.hostname()}
Node: ${process.version}
`;

    await testInfo.attach('environment-info', {
      body: envInfo,
      contentType: 'text/plain'
    });

    await allure.attachment('environment-info.txt', envInfo, 'text/plain');
  },

  // 🔥 THIS IS THE FIX
  context: async ({ context }, use, testInfo) => {
    context.testInfo = testInfo;   // 👈 inject Playwright testInfo into context
    await use(context);
  }

});

exports.expect = expect;































// const fs = require('fs');
// const os = require('os');
// const { test: base, expect } = require('@playwright/test');
// const { createTestLogger } = require('./logger.js');
// const { allure } = require('allure-playwright'); // ✅ correct library

// exports.test = base.extend({
//   testLogger: async ({}, use, testInfo) => {
//     const logger = createTestLogger(testInfo.title);
//     await use(logger);

//     // Attach log file only if test failed
//     if (testInfo.status !== testInfo.expectedStatus && fs.existsSync(logger.__logFile)) {
      
//       // Playwright attachment
//       await testInfo.attach('execution-log', {
//         body: fs.readFileSync(logger.__logFile),
//         contentType: 'text/plain'
//       });

//       // Allure attachment
//       await allure.attachment(
//         'execution-log.txt',
//         fs.readFileSync(logger.__logFile),
//         'text/plain'
//       );
//     }
//   },

//   log: async ({ testLogger }, use, testInfo) => {

//     const log = async (message) => {
//       const ts = new Date().toISOString();
//       const formatted = `${ts} - ${message}`;

//       // Write to winston log file
//       testLogger.info(formatted);

//       // Show in Playwright report
//       await testInfo.attach(`LOG: ${formatted}`, {
//         body: formatted,
//         contentType: "text/plain"
//       });

//       // Show in Allure
//       //await allure.step(formatted, async () => {});
//     };

//     await use(log);

//     // Add environment info
//     const envInfo = `
// Test: ${testInfo.title}
// Browser: ${testInfo.project.use.browserName}
// OS: ${os.platform()} ${os.release()}
// Machine: ${os.hostname()}
// Node: ${process.version}
// `;

//     await testInfo.attach('environment-info', {
//       body: envInfo,
//       contentType: 'text/plain'
//     });

//     await allure.attachment('environment-info.txt', envInfo, 'text/plain');
//   }
// });

// exports.expect = expect;
