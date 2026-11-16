import { DEFAULT_ROOT } from "./fixtures";
import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { pageRef, type Frame, type Update } from "../src/model";
import { read, all } from "../src/db";
const event = () => {
  const listeners: Function[] = [];
  return {
    addListener: (fn: Function) => listeners.push(fn),
    fire: (...args: unknown[]) => listeners.forEach((fn) => fn(...args)),
  };
};
const onAlarm = event(),
  onStartup = event();
const alarms = new Map<string, any>();
const tabs = new Map<number, any>();
let counter = 1,
  listener: any,
  editorVersion = 0;
let settings: Record<string, unknown> = {
  root: DEFAULT_ROOT,
  interval: 60,
  enabled: false,
  notify: false,
  concurrency: 1,
};
const root = pageRef(DEFAULT_ROOT)!;
const notices: any[] = [];
const chromeMock = {
  runtime: {
    id: "auto-test",
    getURL: (p: string) => `chrome-extension://auto-test/${p}`,
    onInstalled: event(),
    onStartup,
    onMessage: { addListener: (fn: any) => (listener = fn) },
  },
  action: { onClicked: event() },
  notifications: {
    onClicked: event(),
    create: async (id: string, options: any) => {
      notices.push({ id, ...options });
      return id;
    },
  },
  permissions: { contains: async () => true },
  storage: {
    session: {
      get: async () => ({ ownershipToken: "auto-session" }),
      set: async () => {},
    },
    local: {
      get: async () => ({ settings }),
      set: async (value: any) => {
        settings = value.settings;
      },
    },
  },
  alarms: {
    create: async (name: string, options: any) => {
      alarms.set(name, options);
    },
    clear: async (name: string) => alarms.delete(name),
    onAlarm,
  },
  tabs: {
    create: async (options: any) => {
      const t = {
        id: counter++,
        url: options.url,
        active: false,
        menuOpen: false,
      };
      tabs.set(t.id, t);
      return t;
    },
    get: async (id: number) => tabs.get(id),
    update: async (id: number, o: any) =>
      Object.assign(tabs.get(id), o, { menuOpen: false }),
    remove: async (id: number) => tabs.delete(id),
  },
  scripting: {
    executeScript: async (options: any) => {
      const tab = tabs.get(options.target.tabId);
      const action = options.args[0];
      const f: Frame = {
        id: root.id,
        documentId: root.id,
        title: "周报数据库",
        ready: true,
        children: [],
        warnings: [],
        bottom: true,
        position: 0,
        height: 300,
        observed: Date.now(),
      };
      if (action === "prepare-metadata") tab.menuOpen = true;
      if (action === "metadata" && tab.menuOpen) {
        f.author = editorVersion ? "乙" : "甲";
        f.rawTime = editorVersion ? "今天 14:03" : "今天 14:02";
      }
      return [{ result: f }];
    },
  },
};
Object.assign(globalThis, { chrome: chromeMock });
await import("../src/worker");
const message = (type: string, extra: Record<string, unknown> = {}) =>
  new Promise<any>((resolve) =>
    listener(
      { type, ...extra },
      { id: "auto-test", url: "chrome-extension://auto-test/dashboard.html" },
      resolve,
    ),
  );
const delay = (n: number) => new Promise((r) => setTimeout(r, n));
const waitFor = async (fn: () => Promise<boolean>) => {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    if (await fn()) return;
    await delay(20);
  }
  throw Error("自动检查未在预期时间内收尾");
};
async function tick() {
  const before = (await read<any>("state", "run"))?.runId;
  onAlarm.fire({ name: "periodic" });
  await waitFor(async () => {
    const run = await read<any>("state", "run");
    return (
      run?.runId !== before && run?.status === "done" && !alarms.has("resume")
    );
  });
}
test("自动检查事件、首轮静默、自然变化通知、无变化不重复、关闭后忽略迟到唤醒", async () => {
  const saved = await message("save", {
    settings: { ...settings, enabled: true, notify: true },
  });
  assert.equal(saved.error, undefined);
  assert.equal(alarms.get("periodic")?.periodInMinutes, 60);
  await tick();
  assert.equal(notices.length, 0, "自动建立基线不通知旧内容");
  editorVersion = 1;
  await tick();
  assert.equal(notices.length, 1, "后续变更触发一次桌面通知");
  const updates = await all<Update>("updates");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].notified, true);
  assert.ok(
    !notices[0].message.includes("乙"),
    "桌面摘要不包含具体编辑者或正文",
  );
  await tick();
  assert.equal(notices.length, 1, "未变化轮次不重复通知");
  assert.equal((await all("updates")).length, 1);
  await message("save", { settings: { ...settings, enabled: false } });
  assert.equal(alarms.has("periodic"), false);
  const previous = (await read<any>("state", "run")).runId;
  onAlarm.fire({ name: "periodic" });
  await delay(300);
  assert.equal(
    (await read<any>("state", "run")).runId,
    previous,
    "关闭自动检查后，即使有已排队的旧事件也不能重新扫描",
  );
});
