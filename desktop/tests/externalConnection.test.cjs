const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const config = require("../electron-builder.config.cjs");

function loadRuntime(name, options = {}) {
  const filename = path.join(__dirname, "../dist/runtime", `${name}.js`);
  const localRequire = createRequire(filename);
  const exports = {};
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    exports,
    __dirname: path.dirname(filename),
    process: { env: options.env ?? { ...config.mac.extendInfo.LSEnvironment }, platform: "darwin" },
    fetch: options.fetch,
    Date: options.Date ?? Date,
    AbortSignal,
    setTimeout: options.setTimeout ?? setTimeout,
    require: name => {
      if (name === "electron" || name === "node:child_process") {
        return new Proxy({}, { get: () => () => { throw new Error("External mode must not start a local process"); } });
      }
      if (name === "node:net") return { createServer() { throw new Error("External mode must not allocate a local server port"); } };
      if (name === "./logging") return {};
      return localRequire(name);
    },
  }, { filename });
  return exports;
}

test("Mac launch defaults connect to 15173 without starting a backend or creating an access token", async () => {
  const env = { ...config.mac.extendInfo.LSEnvironment };
  const requests = [];
  const server = loadRuntime("server", {
    env,
    fetch: async (url, options) => {
      requests.push(url);
      assert.ok(options.signal instanceof AbortSignal);
      return { ok: true };
    },
  });
  const port = await server.resolveDesktopServerPort({ isPackaged: true });
  assert.equal(port, 15173);
  const handle = await server.startDesktopServer({ isPackaged: true, port });
  assert.equal(handle.mode, "external");
  assert.deepEqual(requests, ["http://127.0.0.1:15173/api/health"]);
  await handle.stop();
  assert.equal(loadRuntime("access", { env }).configureDesktopAccessToken(true), undefined);
  assert.equal(env.AI_NOVEL_ACCESS_TOKEN, undefined);
  env.AI_NOVEL_ACCESS_TOKEN = "configured-server-token";
  assert.equal(loadRuntime("access", { env }).configureDesktopAccessToken(true), "configured-server-token");
});

test("external connection failure explains how to reconnect without falling back to a local backend", async () => {
  let now = 0;
  let requests = 0;
  const server = loadRuntime("server", {
    Date: { now: () => now },
    fetch: async () => { requests += 1; throw new Error("ECONNREFUSED"); },
    setTimeout: callback => { now += 45_000; callback(); },
  });
  await assert.rejects(server.startDesktopServer({ isPackaged: true }), /15173.*Web 服务或 SSH 通道/);
  assert.equal(requests, 1);
});

function loadMain({ serverError, rendererError } = {}) {
  const events = [];
  const ipc = new Map();
  const state = { snapshot: {}, getSnapshot() { return this.snapshot; }, setSnapshot(value) { this.snapshot = value; }, subscribe() {} };
  let start;
  class Window {
    webContents = { on() {}, send() {}, session: { webRequest: { onBeforeSendHeaders() {} } } };
    constructor(options) { this.isMain = Boolean(options.webPreferences); }
    loadURL(url) {
      if (this.isMain) {
        events.push(["loadURL", url]);
        return rendererError ? Promise.reject(rendererError) : Promise.resolve();
      }
      return Promise.resolve();
    }
    loadFile() { throw new Error("Mac external mode must load the server's Web page"); }
    on() {}
    close() {}
    isDestroyed() { return false; }
  }
  const electron = {
    app: {
      isPackaged: true, setPath() {}, setAppUserModelId() {}, on() {}, requestSingleInstanceLock: () => true,
      getVersion: () => "0.7.5", whenReady: () => ({ then: callback => { start = callback; return { catch() {} }; } }),
      exit: code => events.push(["exit", code]),
    },
    BrowserWindow: Window,
    ipcMain: { handle: (name, callback) => ipc.set(name, callback), on() {} },
    dialog: { showMessageBox: async options => { events.push(["dialog", options.detail]); return { response: 2 }; } },
  };
  const filename = path.join(__dirname, "../dist/main.js");
  const env = { ...config.mac.extendInfo.LSEnvironment };
  const overrides = {
    electron,
    "./runtime/server": {
      resolveServerMode: () => "external",
      resolveDesktopServerPort: async () => 15173,
      startDesktopServer: async () => {
        events.push(["connect"]);
        if (serverError) throw serverError;
        events.push(["healthy"]);
        return { mode: "external", port: 15173, stop: async () => undefined };
      },
    },
    "./runtime/access": loadRuntime("access", { env }),
    "./runtime/dataImport": { extractPendingDatabaseImportPath: () => undefined },
    "./runtime/paths": {
      resolveDesktopRuntimeConfig: ({ port }) => ({ apiBaseUrl: `http://127.0.0.1:${port}/api` }),
      resolveDesktopUpdateChannel: () => "beta", isPortableDesktopRuntime: () => false,
      resolveDesktopWindowIcon: () => "fixture.icns", resolveDesktopAppDataDir: () => "/fixture/data",
      resolveDesktopLogsDir: () => "/fixture/logs",
    },
    "./runtime/logging": { appendDesktopLog() {}, cleanupDesktopLogs() {}, logDesktopError: () => "/fixture/logs/main.log" },
    "./runtime/state": { createBootstrapSnapshot: value => value, desktopBootstrapStore: state, desktopUpdaterStore: state },
    "./runtime/updater": { initializeDesktopUpdater: () => ({ scheduleInitialCheck() {} }) },
    "./runtime/logBundle": {},
  };
  const sandbox = {
    exports: {}, __dirname: path.dirname(filename), process: { env, argv: [], platform: "darwin" },
    require: name => overrides[name] ?? require(name),
  };
  vm.runInNewContext(`${fs.readFileSync(filename, "utf8")}\nglobalThis.failBootstrap = handleBootstrapFailure;`, sandbox, { filename });
  return { events, env, run: async () => { try { await start(); } catch (error) { await sandbox.failBootstrap(error); } } };
}

test("Mac startup loads the Web page after health succeeds and injects the matching API address", async () => {
  const main = loadMain();
  await main.run();
  assert.deepEqual(main.events, [["connect"], ["healthy"], ["loadURL", "http://127.0.0.1:15173"]]);
  const runtime = JSON.parse(main.env.AI_NOVEL_DESKTOP_RUNTIME);
  assert.equal(runtime.apiBaseUrl, "http://127.0.0.1:15173/api");
  assert.equal(runtime.accessToken, undefined);
});

test("unavailable Web service leaves a connection error instead of an empty window", async () => {
  const main = loadMain({ serverError: new Error("无法连接写作服务（http://127.0.0.1:15173）。请先启动 Web 服务或 SSH 通道。") });
  await main.run();
  assert.equal(main.events.some(event => event[0] === "loadURL"), false);
  assert.match(main.events.find(event => event[0] === "dialog")[1], /15173.*SSH 通道/);
  assert.deepEqual(main.events.at(-1), ["exit", 1]);
});

test("Web page load rejection is handled with a readable error", async () => {
  const main = loadMain({ rendererError: new Error("ERR_CONNECTION_RESET") });
  await main.run();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(main.events.find(event => event[0] === "dialog")[1], /无法加载写作页面.*15173/);
  assert.deepEqual(main.events.at(-1), ["exit", 1]);
});
