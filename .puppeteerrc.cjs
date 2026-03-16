const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Download Chrome into .cache/puppeteer
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
