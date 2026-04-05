const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const SCREENSHOTS_DIR = path.join(__dirname, '..', 'screenshots');
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR);

let browser = null;
let page = null;

async function ensureBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-gpu']
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    page = await context.newPage();
  }
  return page;
}

async function navigate(url) {
  const p = await ensureBrowser();
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  return { url: p.url(), title: await p.title() };
}

async function screenshot(name) {
  const p = await ensureBrowser();
  const filename = `${name || 'screenshot'}-${Date.now()}.png`;
  const filepath = path.join(SCREENSHOTS_DIR, filename);
  await p.screenshot({ path: filepath, fullPage: false });
  return filepath;
}

async function click(selector) {
  const p = await ensureBrowser();
  await p.click(selector, { timeout: 10000 });
  return { clicked: selector };
}

async function type(selector, text) {
  const p = await ensureBrowser();
  await p.fill(selector, text, { timeout: 10000 });
  return { typed: text, into: selector };
}

async function getText(selector) {
  const p = await ensureBrowser();
  const el = await p.$(selector);
  if (!el) return { text: null, error: 'Element not found' };
  const text = await el.textContent();
  return { text: text.trim() };
}

async function getPageText() {
  const p = await ensureBrowser();
  const text = await p.evaluate(() => document.body.innerText);
  return text.slice(0, 5000);
}

async function evaluate(code) {
  const p = await ensureBrowser();
  const result = await p.evaluate(code);
  return result;
}

async function waitFor(selector, timeout = 10000) {
  const p = await ensureBrowser();
  await p.waitForSelector(selector, { timeout });
  return { found: selector };
}

async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
    page = null;
  }
}

module.exports = {
  navigate,
  screenshot,
  click,
  type,
  getText,
  getPageText,
  evaluate,
  waitFor,
  closeBrowser,
  ensureBrowser
};
