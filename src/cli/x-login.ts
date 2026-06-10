// Browser-assisted X/Twitter login for `yappr deploy`: opens x.com in a real
// (non-headless) system Chrome via playwright-core, lets the user log in there,
// and polls the session cookies until auth_token + ct0 appear. The password never
// touches us — the user types it into x.com itself; we only read the cookies the
// site sets, exactly the two values the manual path asks the user to paste.

import type { Browser } from "playwright-core";

export type XCredentials = { authToken: string; ct0: string; username?: string };

const LOGIN_TIMEOUT_S = 180;

export async function connectXViaBrowser(): Promise<XCredentials> {
  // Lazy import: only this optional deploy flow needs playwright-core, so the
  // engine (and every other CLI path) never pays for loading it.
  let chromium: (typeof import("playwright-core"))["chromium"];
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    throw new Error("playwright-core is not installed — `npm i playwright-core`, or enter the cookies manually");
  }

  let browser: Browser;
  try {
    browser = await chromium.launch({
      headless: false,
      channel: "chrome", // the user's installed Chrome — no playwright browser download
      args: ["--disable-blink-features=AutomationControlled"],
    });
  } catch (err) {
    throw new Error(`could not launch Chrome — is Google Chrome installed? (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`);
  }

  try {
    const context = await browser.newContext();
    // x.com blocks logins from automated browsers; mask the webdriver flag.
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    const page = await context.newPage();
    await page.goto("https://x.com");

    // Poll for the session cookies while the user logs in.
    for (let i = 0; i < LOGIN_TIMEOUT_S; i++) {
      if (!browser.isConnected()) {
        throw new Error("the browser window was closed before login completed");
      }
      let cookies: Array<{ name: string; value: string }>;
      try {
        cookies = await context.cookies("https://x.com");
      } catch {
        throw new Error("the browser window was closed before login completed");
      }
      const authToken = cookies.find((c) => c.name === "auth_token");
      const ct0 = cookies.find((c) => c.name === "ct0");
      if (authToken && ct0) {
        // The logged-in handle, read off the profile link — a nice-to-have (it
        // pre-fills AGENT_HANDLE), never required.
        let username: string | undefined;
        try {
          const href = await page.$eval('a[data-testid="AppTabBar_Profile_Link"]', (el) => el.getAttribute("href"));
          username = href?.replace("/", "") || undefined;
        } catch { /* optional */ }
        return { authToken: authToken.value, ct0: ct0.value, username };
      }
      // Plain sleep (not page.waitForTimeout): keeps polling even if the user
      // closed the tab but not the browser.
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`timed out waiting for login (${LOGIN_TIMEOUT_S / 60} minutes)`);
  } finally {
    await browser.close().catch(() => { /* already closed */ });
  }
}
