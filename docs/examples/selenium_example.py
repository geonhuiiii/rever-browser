#!/usr/bin/env python3
"""Drive Rever Browser over its WebDriver endpoint with Selenium.

Prerequisites:
  1. Launch Rever with the endpoint enabled:
       REVER_WEBDRIVER=1 REVER_WEBDRIVER_PORT=9515 npm run dev
     (Windows PowerShell:
       $env:REVER_WEBDRIVER='1'; $env:REVER_WEBDRIVER_PORT='9515'; npm run dev)
  2. pip install selenium
  3. python docs/examples/selenium_example.py

If you omit REVER_WEBDRIVER_PORT, read the URL from
  <userData>/webdriver-endpoint.json
and pass it below.
"""

import json
import os
import sys
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys


def endpoint_url() -> str:
    # Prefer an explicit port; else read the published endpoint file.
    port = os.environ.get("REVER_WEBDRIVER_PORT")
    if port:
        return f"http://127.0.0.1:{port}"

    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support" / "rever-browser"
    elif sys.platform.startswith("win"):
        base = Path(os.environ["APPDATA"]) / "rever-browser"
    else:
        base = Path.home() / ".config" / "rever-browser"
    data = json.loads((base / "webdriver-endpoint.json").read_text())
    return data["url"]


def main() -> None:
    opts = webdriver.ChromeOptions()  # any Options object; Rever echoes caps
    driver = webdriver.Remote(command_executor=endpoint_url(), options=opts)
    try:
        driver.get("https://example.com/")
        print("title:", driver.title)

        heading = driver.find_element(By.TAG_NAME, "h1")
        print("h1 text:", heading.text)

        # Trusted typing (human-shaped keystrokes) + a special key.
        # example.com has no input; show it on a data: page instead.
        driver.get("data:text/html,<input id='q'><p id='out'></p>")
        box = driver.find_element(By.ID, "q")
        box.send_keys("hello world" + Keys.BACKSPACE)  # -> "hello worl"
        print("typed value:", box.get_attribute("value"))

        print("execute_script:", driver.execute_script("return navigator.userAgent"))
    finally:
        driver.quit()


if __name__ == "__main__":
    main()
