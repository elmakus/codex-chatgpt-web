const { nextSessionRefreshReminderAt } = require("./state.cjs");

function sessionRefreshReminderDue(reminderAt, now = Date.now()) {
  if (!Number.isFinite(now)) throw new Error("Session refresh reminder time must be finite");
  if (reminderAt === null || typeof reminderAt !== "string") return false;
  const reminderTime = Date.parse(reminderAt);
  return Number.isFinite(reminderTime) && reminderTime <= now;
}

async function refreshDueSessionReminder({ browserHost, stateStore, now = Date.now }) {
  if (!browserHost || typeof browserHost.snapshot !== "function"
    || typeof browserHost.refreshAuthentication !== "function") {
    throw new Error("ChatGPT browser host cannot refresh the saved session");
  }
  if (!stateStore || typeof stateStore.read !== "function" || typeof stateStore.update !== "function") {
    throw new Error("Launcher state store cannot persist session freshness");
  }
  if (typeof now !== "function") throw new Error("Session refresh clock must be callable");

  const state = stateStore.read();
  const browser = browserHost.snapshot();
  const checkedAt = now();
  if (!browser.authenticated || !sessionRefreshReminderDue(state.sessionRefreshReminderAt, checkedAt)) {
    return { attempted: false, refreshed: false, browser, state };
  }

  const refreshedBrowser = await browserHost.refreshAuthentication();
  if (!refreshedBrowser.authenticated) {
    return { attempted: true, refreshed: false, browser: refreshedBrowser, state: stateStore.read() };
  }

  const verifiedAt = now();
  if (!Number.isFinite(verifiedAt)) throw new Error("Session refresh verification time must be finite");
  const refreshedState = stateStore.update({
    sessionRefreshReminderAt: nextSessionRefreshReminderAt(verifiedAt),
  });
  return { attempted: true, refreshed: true, browser: refreshedBrowser, state: refreshedState };
}

module.exports = {
  refreshDueSessionReminder,
  sessionRefreshReminderDue,
};
