#!/usr/bin/env node
// CLI wrapper for browser automation — callable from Claude Code sessions
// Usage: node browse.js <command> [args...]
// Commands:
//   goto <url>          — navigate to URL, return title + text preview
//   screenshot [name]   — take screenshot, return file path
//   click <selector>    — click an element
//   type <selector> <text> — type into an element
//   text [selector]     — get text content (whole page if no selector)
//   eval <code>         — evaluate JS in the page
//   close               — close the browser

const browser = require('./browser');

const [,, command, ...args] = process.argv;

(async () => {
  try {
    switch (command) {
      case 'goto': {
        const url = args[0];
        if (!url) { console.error('Usage: node browse.js goto <url>'); process.exit(1); }
        const nav = await browser.navigate(url);
        const text = await browser.getPageText();
        console.log(JSON.stringify({ title: nav.title, url: nav.url, text: text.slice(0, 3000) }, null, 2));
        break;
      }
      case 'screenshot': {
        const name = args[0] || 'page';
        const filepath = await browser.screenshot(name);
        console.log(filepath);
        break;
      }
      case 'click': {
        const selector = args[0];
        if (!selector) { console.error('Usage: node browse.js click <selector>'); process.exit(1); }
        await browser.click(selector);
        console.log(JSON.stringify({ clicked: selector }));
        break;
      }
      case 'type': {
        const selector = args[0];
        const text = args.slice(1).join(' ');
        if (!selector || !text) { console.error('Usage: node browse.js type <selector> <text>'); process.exit(1); }
        await browser.type(selector, text);
        console.log(JSON.stringify({ typed: text, into: selector }));
        break;
      }
      case 'text': {
        if (args[0]) {
          const result = await browser.getText(args[0]);
          console.log(result.text || result.error);
        } else {
          const text = await browser.getPageText();
          console.log(text);
        }
        break;
      }
      case 'eval': {
        const code = args.join(' ');
        const result = await browser.evaluate(code);
        console.log(JSON.stringify(result));
        break;
      }
      case 'close': {
        await browser.closeBrowser();
        console.log('Browser closed.');
        break;
      }
      default:
        console.error('Unknown command. Available: goto, screenshot, click, type, text, eval, close');
        process.exit(1);
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
