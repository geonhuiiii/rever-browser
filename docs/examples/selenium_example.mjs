// Drive Rever Browser over its WebDriver endpoint with selenium-webdriver (Node).
//
// Prerequisites:
//   1. Launch Rever with the endpoint enabled:
//        REVER_WEBDRIVER=1 REVER_WEBDRIVER_PORT=9515 npm run dev
//      (Windows PowerShell:
//        $env:REVER_WEBDRIVER='1'; $env:REVER_WEBDRIVER_PORT='9515'; npm run dev)
//   2. npm install selenium-webdriver
//   3. node docs/examples/selenium_example.mjs
//
// If you omit REVER_WEBDRIVER_PORT, read the URL from
//   <userData>/webdriver-endpoint.json  and set SERVER below.

import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Builder, By, Key } from 'selenium-webdriver'

function endpointUrl() {
  const port = process.env.REVER_WEBDRIVER_PORT
  if (port) return `http://127.0.0.1:${port}`
  const base =
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'rever-browser')
      : process.platform === 'win32'
        ? join(process.env.APPDATA, 'rever-browser')
        : join(homedir(), '.config', 'rever-browser')
  return JSON.parse(readFileSync(join(base, 'webdriver-endpoint.json'), 'utf8')).url
}

const driver = await new Builder()
  .usingServer(endpointUrl())
  .forBrowser('chrome')
  .build()

try {
  await driver.get('https://example.com/')
  console.log('title:', await driver.getTitle())

  await driver.get("data:text/html,<input id='q'>")
  const box = await driver.findElement(By.id('q'))
  await box.sendKeys('hello world', Key.BACKSPACE) // -> "hello worl"
  console.log('typed value:', await box.getAttribute('value'))

  console.log('userAgent:', await driver.executeScript('return navigator.userAgent'))
} finally {
  await driver.quit()
}
