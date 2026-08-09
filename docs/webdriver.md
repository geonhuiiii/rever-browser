# Remote control via Selenium / WebDriver

Rever Browser exposes a **W3C WebDriver** endpoint so Selenium (and any other
WebDriver client) can drive the real browser remotely. Unlike a headless
chromedriver, every action runs through Rever's stealthy CDP + human-input
stack — a Selenium `click`/`send_keys` produces the same trusted, human-shaped
mouse and keyboard events the AI tools use, so behaviour-based bot detection
sees a person, not automation.

Works identically on **macOS, Windows and Linux**.

## Enabling it

The endpoint is **off by default** so the automation port never opens unless you
ask for it. Set an environment variable before launching the app:

```bash
# macOS / Linux
REVER_WEBDRIVER=1 npm run dev
# optional fixed port (otherwise the OS assigns one)
REVER_WEBDRIVER=1 REVER_WEBDRIVER_PORT=9515 npm run dev
```

```powershell
# Windows (PowerShell)
$env:REVER_WEBDRIVER = '1'
$env:REVER_WEBDRIVER_PORT = '9515'   # optional
npm run dev
```

For a packaged build, set the same variables in the shell that launches the
installed app.

## Finding the endpoint

When enabled, the server binds to loopback only and publishes its URL to:

```
<userData>/webdriver-endpoint.json
```

- macOS: `~/Library/Application Support/rever-browser/webdriver-endpoint.json`
- Windows: `%APPDATA%\rever-browser\webdriver-endpoint.json`
- Linux: `~/.config/rever-browser/webdriver-endpoint.json`

```json
{ "url": "http://127.0.0.1:9515", "pid": 12345, "startedAt": "..." }
```

If you set `REVER_WEBDRIVER_PORT`, the URL is simply `http://127.0.0.1:<port>`.

## Connecting

The server implements the WebDriver *remote end*. Point Selenium's `Remote`
executor at the URL — no chromedriver, no browser binary path.

### Python

```python
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys

opts = webdriver.ChromeOptions()  # any Options object works; caps are echoed
driver = webdriver.Remote(command_executor="http://127.0.0.1:9515", options=opts)
try:
    driver.get("https://example.com/")
    print(driver.title)
    box = driver.find_element(By.CSS_SELECTOR, "input[name=q]")
    box.send_keys("hello" + Keys.ENTER)
    print(driver.execute_script("return document.title"))
finally:
    driver.quit()
```

### Node.js (`selenium-webdriver`)

```js
const { Builder, By, Key } = require('selenium-webdriver')

;(async () => {
  const driver = await new Builder()
    .usingServer('http://127.0.0.1:9515')
    .forBrowser('chrome')
    .build()
  try {
    await driver.get('https://example.com/')
    console.log(await driver.getTitle())
    const el = await driver.findElement(By.css('input[name=q]'))
    await el.sendKeys('hello', Key.ENTER)
  } finally {
    await driver.quit()
  }
})()
```

Runnable versions of both live in [`docs/examples/`](./examples).

## Supported commands

| Area | Commands |
|------|----------|
| Session | New Session, Delete Session, Status, Get/Set Timeouts |
| Navigation | Navigate To, Get Current URL, Get Title, Back, Forward, Refresh, Get Page Source |
| Windows | Get/Close/Switch Window, Get Window Handles, New Window, Get/Set Window Rect, Maximize/Minimize/Fullscreen |
| Frames | Switch To Frame (index or element), Switch To Parent Frame |
| Elements | Find Element(s), Find Element(s) From Element, Get Active Element |
| State | Get Text, Tag Name, Attribute, Property, CSS Value, Rect, Is Enabled/Selected/Displayed |
| Interaction | Click, Clear, Send Keys (with special keys), Element Screenshot |
| Scripts | Execute Script, Execute Async Script (element args + returns are marshalled) |
| Cookies | Get All, Get Named, Add, Delete, Delete All |
| Misc | Take Screenshot, Perform/Release Actions (pointer + key subset), Alerts |

## Behaviour notes & limitations

- **Drives the active Rever tab.** Window handles are Rever tab ids; switching
  windows switches the active tab.
- **Trusted input.** `click` / `send_keys` dispatch real CDP mouse/keyboard
  events (human-shaped movement + per-keystroke timing), not JS `.click()`.
  This is the whole point — it survives bot detection — but it is marginally
  slower than a synthetic event.
- **Focus.** The endpoint enables Chromium focus emulation before typing, so an
  automated (backgrounded / minimised) window still receives keystrokes.
- **Frames.** Same-origin frame switching is fully supported. Cross-origin
  iframes (separate renderer) cannot be entered; you get `no such frame`.
  `switch_to.parent_frame()` resets to the top document.
- **Alerts.** Rever answers JS dialogs in-page (they never block), so there is
  no live modal to accept. `alert.accept()/dismiss()/send_keys()` *arm* the
  answer the next dialog will receive; `alert.text` returns the most recent
  dialog's message. Trigger the dialog after arming.
- **Security.** Loopback bind only; the port is never exposed off-host. Keep
  `REVER_WEBDRIVER` unset when you don't need remote control.
