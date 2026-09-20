const test = require("node:test");
const assert = require("node:assert/strict");
const {
  refreshDueSessionReminder,
  sessionRefreshReminderDue,
} = require("../electron/session-refresh.cjs");

function fixture({ reminderAt, authenticated = true, refreshedAuthenticated = true, refreshError = null }) {
  let state = { sessionRefreshReminderAt: reminderAt };
  let refreshes = 0;
  let updates = 0;
  return {
    browserHost: {
      snapshot: () => ({ authenticated }),
      refreshAuthentication: async () => {
        refreshes += 1;
        if (refreshError) throw refreshError;
        return { authenticated: refreshedAuthenticated };
      },
    },
    stateStore: {
      read: () => ({ ...state }),
      update: (patch) => {
        updates += 1;
        state = { ...state, ...patch };
        return { ...state };
      },
    },
    counts: () => ({ refreshes, updates }),
    state: () => ({ ...state }),
  };
}

test("session reminder due detection is bounded to valid due timestamps", () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  assert.equal(sessionRefreshReminderDue(null, now), false);
  assert.equal(sessionRefreshReminderDue("not-a-date", now), false);
  assert.equal(sessionRefreshReminderDue("2026-09-20T12:00:00.000Z", now), true);
  assert.equal(sessionRefreshReminderDue("2026-09-20T12:00:00.001Z", now), false);
  assert.throws(() => sessionRefreshReminderDue("2026-09-20T12:00:00.000Z", Number.NaN), /must be finite/);
});

test("a due authenticated session is revalidated and advances freshness by 48 hours", async () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const f = fixture({ reminderAt: "2026-09-20T11:59:59.000Z" });
  const result = await refreshDueSessionReminder({
    browserHost: f.browserHost,
    stateStore: f.stateStore,
    now: () => now,
  });

  assert.equal(result.attempted, true);
  assert.equal(result.refreshed, true);
  assert.deepEqual(f.counts(), { refreshes: 1, updates: 1 });
  assert.equal(f.state().sessionRefreshReminderAt, "2026-09-22T12:00:00.000Z");
});

test("a not-yet-due or already-signed-out session is not refreshed", async () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  for (const options of [
    { reminderAt: "2026-09-20T12:00:00.001Z", authenticated: true },
    { reminderAt: "2026-09-20T11:00:00.000Z", authenticated: false },
  ]) {
    const f = fixture(options);
    const result = await refreshDueSessionReminder({
      browserHost: f.browserHost,
      stateStore: f.stateStore,
      now: () => now,
    });
    assert.equal(result.attempted, false);
    assert.equal(result.refreshed, false);
    assert.deepEqual(f.counts(), { refreshes: 0, updates: 0 });
  }
});

test("an unauthenticated refresh result never advances freshness", async () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const f = fixture({
    reminderAt: "2026-09-20T11:00:00.000Z",
    refreshedAuthenticated: false,
  });
  const result = await refreshDueSessionReminder({
    browserHost: f.browserHost,
    stateStore: f.stateStore,
    now: () => now,
  });

  assert.equal(result.attempted, true);
  assert.equal(result.refreshed, false);
  assert.deepEqual(f.counts(), { refreshes: 1, updates: 0 });
  assert.equal(f.state().sessionRefreshReminderAt, "2026-09-20T11:00:00.000Z");
});

test("a refresh failure propagates without advancing freshness", async () => {
  const now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const f = fixture({
    reminderAt: "2026-09-20T11:00:00.000Z",
    refreshError: new Error("network unavailable"),
  });

  await assert.rejects(
    refreshDueSessionReminder({
      browserHost: f.browserHost,
      stateStore: f.stateStore,
      now: () => now,
    }),
    /network unavailable/,
  );
  assert.deepEqual(f.counts(), { refreshes: 1, updates: 0 });
  assert.equal(f.state().sessionRefreshReminderAt, "2026-09-20T11:00:00.000Z");
});
