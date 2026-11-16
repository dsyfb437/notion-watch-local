import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { buildSync } from "esbuild";
import { IDBFactory } from "fake-indexeddb";
const code = buildSync({
  entryPoints: ["src/worker.ts"],
  bundle: true,
  write: false,
  format: "iife",
  target: "chrome120",
}).outputFiles[0].text;
function event() {
  const listeners = new Set<Function>();
  return {
    listeners,
    addListener: (fn: Function) => listeners.add(fn),
    fire: (...args: unknown[]) => {
      for (const fn of listeners) fn(...args);
    },
  };
}
function boot(notifications?: unknown) {
  const onMessage = event(),
    onAdded = event(),
    action = event();
  const opened: string[] = [];
  const chrome: any = {
    runtime: {
      id: "test",
      getURL: (p: string) => `chrome-extension://test/${p}`,
      onInstalled: event(),
      onStartup: event(),
      onMessage,
    },
    action: { onClicked: action },
    alarms: { onAlarm: event() },
    permissions: { onAdded },
    tabs: {
      create: async ({ url }: { url: string }) => {
        opened.push(url);
      },
    },
    notifications,
  };
  const context = vm.createContext({
    chrome,
    indexedDB: new IDBFactory(),
    console,
    URL,
    Date,
    setTimeout,
    clearTimeout,
    crypto,
  });
  new vm.Script(code).runInContext(context);
  return { chrome, onMessage, onAdded, action, opened };
}
test("构建产物在通知 API 完全缺失时仍启动，控制台通信及图标入口注册成功", () => {
  const app = boot();
  assert.equal(app.onMessage.listeners.size, 1);
  assert.equal(app.action.listeners.size, 1);
  app.action.fire();
  assert.deepEqual(app.opened, ["chrome-extension://test/dashboard.html"]);
});
test("运行中授予可选通知权限后注册点击处理，重复授权事件不重复打开页面", () => {
  const app = boot();
  const click = event();
  app.chrome.notifications = { onClicked: click };
  app.onAdded.fire({ permissions: ["notifications"] });
  app.onAdded.fire({ permissions: ["notifications"] });
  assert.equal(click.listeners.size, 1);
  click.fire("notification-id");
  assert.equal(app.opened.length, 1);
});
test("已有通知权限时启动注册成功，撤销后事件不会使后台崩溃，重新授予可恢复", () => {
  const first = event();
  const app = boot({ onClicked: first });
  assert.equal(first.listeners.size, 1);
  app.chrome.notifications = undefined;
  assert.doesNotThrow(() =>
    app.onAdded.fire({ permissions: ["notifications"] }),
  );
  const second = event();
  app.chrome.notifications = { onClicked: second };
  app.onAdded.fire({ permissions: ["notifications"] });
  assert.equal(second.listeners.size, 1);
});
