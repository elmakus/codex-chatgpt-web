const test = require("node:test");
const assert = require("node:assert/strict");
const { createUpdateController } = require("../electron/update.cjs");

test("CODEX_WEB_GPT_DISABLE_UPDATES disables release checks for image-managed installs", async () => {
  const previous = process.env.CODEX_WEB_GPT_DISABLE_UPDATES;
  process.env.CODEX_WEB_GPT_DISABLE_UPDATES = "1";
  let calls = 0;
  try {
    const controller = createUpdateController({
      currentVersion: "1.1.4",
      platform: "linux",
      arch: "x64",
      packaged: true,
      executablePath: "/tmp/launcher",
      runtimeExecutable: "/tmp/bun",
      logsDirectory: "/tmp/logs",
      dependencies: {
        fetchRelease: async () => {
          calls += 1;
          throw new Error("release lookup must stay disabled");
        },
      },
    });

    assert.deepEqual(controller.getState(), { status: "disabled" });
    assert.deepEqual(await controller.checkOnce(), { status: "disabled" });
    assert.equal(calls, 0);
    await assert.rejects(controller.beginInstall(), /No launcher update is available/);
  } finally {
    if (previous === undefined) delete process.env.CODEX_WEB_GPT_DISABLE_UPDATES;
    else process.env.CODEX_WEB_GPT_DISABLE_UPDATES = previous;
  }
});
