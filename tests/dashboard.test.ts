import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { buildSync } from "esbuild";
import { readFileSync } from "node:fs";
const bundle = buildSync({
  entryPoints: ["src/dashboard.ts"],
  bundle: true,
  write: false,
  format: "iife",
  target: "chrome120",
}).outputFiles[0].text;
const html = readFileSync("dashboard.html", "utf8")
  .split("<body>")[1]
  .split("<script")[0];
const root = "d672e4d709c0f4797530d2636319499a",
  person = "5e4e33127b3d0b180c44beca586fc30b";
const tick = () => new Promise((r) => setTimeout(r, 20));
async function boot(running = false, shared?: any) {
  const w = new Window({ url: "https://preview.test" });
  w.document.body.innerHTML = html;
  const now = Date.now();
  const messages: any[] = [],
    permissions: any[] = [];
  let grant = true;
  const state: any = shared || {
    access: true,
    settings: {
      root: `https://app.notion.com/p/${root}`,
      interval: 60,
      enabled: true,
      notify: false,
      concurrency: 4,
      windowMode: false,
    },
    run: {
      status: running ? "running" : "done",
      done: 3,
      failed: 0,
      queue: running ? [{}] : [],
      startedAt: now - 1000,
      heartbeat: now,
    },
    pages: [
      { id: root, title: "我的周报", depth: 0 },
      { id: "week", title: "本周周报", depth: 1, parent: root },
      { id: person, title: "项目进展", depth: 2, parent: "week" },
    ],
    updates: [
      {
        id: "u1",
        pageId: person,
        title: "项目进展",
        url: `https://app.notion.com/p/${person}`,
        author: "甲",
        editKey: "2026-11-16 20:35",
        detectedAt: now,
        kind: "updated",
        notified: true,
      },
      {
        id: "u2",
        pageId: person,
        title: "旧记录",
        url: `https://app.notion.com/p/${person}`,
        author: "乙",
        editKey: "2026-11-15 12:00",
        detectedAt: now - 10000,
        kind: "discovered",
        notified: true,
        read: true,
      },
      {
        id: "u3",
        pageId: person,
        title: "<img src=x onerror=alert(1)>",
        url: "javascript:alert(1)",
        author: "丙",
        editKey: "2026-11-16 19:00",
        detectedAt: now - 5000,
        kind: "updated",
        notified: false,
      },
    ],
  };
  let intercept: ((m: any) => Promise<any>) | undefined;
  let poll = () => {};
  (w as any).chrome = {
    runtime: {
      getManifest: () => ({ version: "test" }),
      sendMessage: async (m: any) => {
        messages.push(m);
        if (intercept) {
          const value = await intercept(m);
          if (value !== undefined) return value;
        }
        if (m.type === "status") return structuredClone(state);
        if (m.type === "read") {
          for (const u of state.updates)
            if (m.ids.includes(u.id)) u.read = true;
          return { ok: true };
        }
        if (m.type === "save") {
          state.settings = m.settings;
          return { ok: true };
        }
        if (m.type === "start" || m.type === "retry") {
          state.run.status = "running";
          state.run.queue = [{}];
          return { ok: true };
        }
        if (m.type === "stop") {
          state.run.status = "stopped";
          return { ok: true };
        }
        return { ok: true };
      },
    },
    permissions: {
      request: async (p: any) => {
        permissions.push(p);
        if (p.origins && grant) state.access = true;
        return grant;
      },
    },
  };
  (w as any).setInterval = (fn: any) => {
    poll = fn;
    return 1;
  };
  w.eval(bundle);
  await tick();
  return {
    w,
    state,
    messages,
    permissions,
    poll: async () => {
      poll();
      await tick();
    },
    intercept: (fn: any) => {
      intercept = fn;
    },
    setGrant: (value: boolean) => {
      grant = value;
    },
  };
}
test("更新收件箱：默认隐藏诊断，未读/搜索/已读交互使用实际构建脚本", async () => {
  const { w, state, messages } = await boot();
  const d = w.document;
  assert.equal(d.querySelector("#unread-count")?.textContent, "2");
  assert.equal(d.querySelectorAll(".event").length, 2);
  assert.equal((d.querySelector("#logs") as any).open, false);
  assert.equal((d.querySelector("#settings") as any).open, false);
  assert.equal(
    d.querySelector(".feed img"),
    null,
    "标题按纯文本渲染，不能执行 HTML",
  );
  assert.ok(
    ![...d.querySelectorAll(".feed a")].some((a) =>
      a.getAttribute("href")?.startsWith("javascript:"),
    ),
  );
  (d.querySelector('button[aria-label="将 项目进展 标为已读"]') as any).click();
  await tick();
  assert.equal(state.updates[0].read, true);
  assert.equal(d.querySelectorAll(".event").length, 1);
  assert.ok(messages.some((m) => m.type === "read" && m.ids[0] === "u1"));
  (d.querySelector("#filter-all") as any).click();
  assert.equal(d.querySelectorAll(".event").length, 3);
  const search = d.querySelector("#search") as any;
  search.value = "甲";
  search.dispatchEvent(new w.Event("input"));
  assert.equal(d.querySelectorAll(".event").length, 1);
  search.value = "不存在";
  search.dispatchEvent(new w.Event("input"));
  assert.ok(d.querySelector(".empty")?.textContent?.includes("没有找到"));
  (d.querySelector("#logs-link") as any).click();
  assert.equal((d.querySelector("#logs") as any).open, true);
});
test("检查中不能误启动第二轮；可选标签组权限拒绝时不保存设置", async () => {
  const busy = await boot(true);
  assert.equal((busy.w.document.querySelector("#start") as any).disabled, true);
  (busy.w.document.querySelector("#start") as any).click();
  await tick();
  assert.ok(!busy.messages.some((m) => m.type === "start"));
  const app = await boot();
  app.setGrant(false);
  (app.w.document.querySelector("#collapsetabs") as any).checked = true;
  (app.w.document.querySelector("#save") as any).click();
  await tick();
  assert.deepEqual(Array.from(app.permissions[0].permissions), ["tabGroups"]);
  assert.ok(!app.messages.some((m) => m.type === "save"));
  assert.ok(
    app.w.document.querySelector("#message")?.textContent?.includes("未获授予"),
  );
});

const click = (app: any, id: string) =>
  (app.w.document.getElementById(id) as any).click();
function input(app: any, id: string, value: string | boolean) {
  const field = app.w.document.getElementById(id) as any;
  if (typeof value === "boolean") field.checked = value;
  else field.value = value;
  field.dispatchEvent(new app.w.Event("input", { bubbles: true }));
}
function text(app: any, id: string) {
  return app.w.document.getElementById(id)?.textContent || "";
}
function disabled(app: any, id: string) {
  return (app.w.document.getElementById(id) as any).disabled;
}

test("侧栏真正切换页面，支持回到收件箱、URL hash 和活动导航", async () => {
  const app = await boot();
  click(app, "settings-link");
  assert.equal(
    app.w.document.getElementById("settings")!.hasAttribute("hidden"),
    false,
  );
  assert.equal(
    app.w.document.getElementById("inbox-view")!.hasAttribute("hidden"),
    true,
  );
  assert.equal(text(app, "view-title"), "订阅设置");
  assert.equal(app.w.location.hash, "#settings");
  click(app, "logs-link");
  assert.equal(
    app.w.document.getElementById("settings")!.hasAttribute("hidden"),
    true,
  );
  assert.equal(
    app.w.document.getElementById("logs")!.hasAttribute("hidden"),
    false,
  );
  assert.equal(
    app.w.document.getElementById("logs-link")!.getAttribute("aria-current"),
    "page",
  );
  click(app, "inbox-link");
  assert.equal(
    app.w.document.getElementById("logs")!.hasAttribute("hidden"),
    true,
  );
  assert.equal(
    app.w.document.getElementById("inbox-view")!.hasAttribute("hidden"),
    false,
  );
  app.w.location.hash = "#settings";
  await tick();
  assert.equal(text(app, "view-title"), "订阅设置");
});
test("勾选后提示未保存，轮询保留草稿；保存后刷新及重开页面都保留全部选项", async () => {
  const app = await boot();
  click(app, "settings-link");
  for (const id of ["notify", "collapsetabs", "fastnav", "windowmode"])
    input(app, id, true);
  input(app, "enabled", false);
  input(app, "recentonly", false);
  input(app, "incremental", false);
  input(app, "interval", "120");
  input(app, "concurrency", "2");
  assert.match(text(app, "settings-status"), /未保存/);
  await app.poll();
  assert.equal((app.w.document.getElementById("notify") as any).checked, true);
  assert.equal(app.messages.filter((m) => m.type === "save").length, 0);
  click(app, "save");
  await tick();
  assert.match(text(app, "settings-status"), /设置已保存/);
  assert.equal(app.state.settings.interval, 120);
  assert.equal(app.state.settings.concurrency, 2);
  assert.equal(app.state.settings.incremental, false);
  assert.equal(app.state.settings.recentOnly, false);
  assert.equal(app.state.settings.enabled, false);
  assert.equal(app.state.settings.notify, true);
  assert.equal(app.state.settings.collapseTabs, true);
  assert.equal(app.state.settings.windowMode, true);
  assert.equal(app.state.settings.fastNav, true);
  const again = await boot(false, app.state);
  for (const id of ["notify", "collapsetabs", "fastnav", "windowmode"])
    assert.equal(
      (again.w.document.getElementById(id) as any).checked,
      true,
      id,
    );
  for (const id of ["enabled", "recentonly", "incremental"])
    assert.equal(
      (again.w.document.getElementById(id) as any).checked,
      false,
      id,
    );
  input(again, "notify", false);
  click(again, "reset-settings");
  assert.equal(
    (again.w.document.getElementById("notify") as any).checked,
    true,
  );
  assert.equal(disabled(again, "reset-settings"), true);
});
test("保存或开始请求未返回时，轮询不得解除禁用或重复发请求", async () => {
  const app = await boot();
  let resolve!: () => void;
  const hold = new Promise<void>((r) => (resolve = r));
  app.intercept(async (m: any) => {
    if (m.type === "save") await hold;
  });
  input(app, "enabled", false);
  click(app, "save");
  await tick();
  await app.poll();
  assert.equal(disabled(app, "save"), true);
  assert.equal(disabled(app, "start"), true);
  click(app, "save");
  assert.equal(app.messages.filter((m) => m.type === "save").length, 1);
  resolve();
  await tick();
  assert.equal(disabled(app, "save"), false);
  let resolveStart!: () => void;
  const wait = new Promise<void>((r) => (resolveStart = r));
  app.intercept(async (m: any) => {
    if (m.type === "start") await wait;
  });
  click(app, "start");
  await tick();
  await app.poll();
  assert.equal(disabled(app, "start"), true);
  click(app, "start");
  assert.equal(app.messages.filter((m) => m.type === "start").length, 1);
  resolveStart();
  await tick();
  assert.equal(disabled(app, "start"), true);
  assert.equal(
    app.w.document.getElementById("stop")!.hasAttribute("hidden"),
    false,
  );
  click(app, "stop");
  await tick();
  assert.equal(disabled(app, "start"), false);
  assert.equal(
    app.w.document.getElementById("stop")!.hasAttribute("hidden"),
    true,
  );
});
test("未配置/未授权时引导设置；授权按钮与失败页重试有正确可用状态", async () => {
  const state = (await boot()).state;
  state.access = false;
  state.settings.root = "";
  state.pages = [];
  state.updates = [];
  delete state.run;
  const app = await boot(false, state);
  assert.equal(disabled(app, "start"), true);
  assert.equal(disabled(app, "retry"), true);
  assert.equal(
    app.w.document.getElementById("settings")!.hasAttribute("hidden"),
    false,
  );
  input(app, "root", "https://evil.test/page");
  click(app, "save");
  await tick();
  assert.match(text(app, "message"), /app.notion.com/);
  assert.equal(
    app.messages.some((m) => m.type === "save"),
    false,
  );
  input(app, "root", `https://app.notion.com/p/${root}`);
  input(app, "enabled", false);
  click(app, "save");
  await tick();
  assert.equal(disabled(app, "start"), true);
  click(app, "grant");
  await tick();
  assert.equal(disabled(app, "start"), false);
  assert.equal(disabled(app, "grant"), true);
  const now = Date.now();
  state.run = {
    status: "done",
    done: 0,
    failed: 1,
    queue: [],
    seen: [person],
    startedAt: now - 500,
    heartbeat: now,
  };
  state.pages = [
    {
      id: person,
      title: "失败页",
      depth: 1,
      error: "超时",
      lastAttemptAt: now,
    },
  ];
  await app.poll();
  assert.equal(disabled(app, "retry"), false);
  click(app, "logs-link");
  click(app, "retry");
  await tick();
  assert.equal(
    app.messages.some((m) => m.type === "retry"),
    true,
  );
  assert.equal(disabled(app, "retry"), true);
});
test("搜索内批量已读不影响其他作者；写入失败不假报成功且可以重试", async () => {
  const app = await boot();
  input(app, "search", "甲");
  assert.equal(text(app, "read-all"), "筛选结果标为已读");
  click(app, "read-all");
  await tick();
  assert.equal(app.state.updates[0].read, true);
  assert.equal(app.state.updates[2].read, undefined);
  assert.equal(text(app, "unread-count"), "1");
  input(app, "search", "");
  app.intercept(async (m: any) =>
    m.type === "read" ? { error: "磁盘写入失败" } : undefined,
  );
  click(app, "read-all");
  await tick();
  assert.match(text(app, "message"), /磁盘写入失败/);
  assert.equal(text(app, "unread-count"), "1");
  assert.equal(disabled(app, "read-all"), false);
  app.intercept(async () => undefined);
  click(app, "read-all");
  await tick();
  assert.equal(text(app, "unread-count"), "0");
  assert.match(text(app, "updates"), /都看完了/);
});
test("动态分页、键盘筛选与页面索引可用；自定义旧间隔保留", async () => {
  const state = (await boot()).state;
  state.settings.interval = 90;
  state.updates = Array.from({ length: 65 }, (_, i) => ({
    ...state.updates[0],
    id: `many-${i}`,
  }));
  const app = await boot(false, state);
  assert.equal(app.w.document.querySelectorAll(".event").length, 50);
  assert.equal(
    app.w.document.getElementById("more")!.hasAttribute("hidden"),
    false,
  );
  click(app, "more");
  assert.equal(app.w.document.querySelectorAll(".event").length, 65);
  assert.equal(
    app.w.document.getElementById("more")!.hasAttribute("hidden"),
    true,
  );
  app.w.document
    .getElementById("filter-unread")!
    .dispatchEvent(
      new app.w.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
  assert.equal(
    app.w.document.getElementById("filter-all")!.getAttribute("aria-selected"),
    "true",
  );
  click(app, "logs-link");
  const index = app.w.document.getElementById("page-index") as any;
  index.open = true;
  index.dispatchEvent(new app.w.Event("toggle"));
  assert.equal(app.w.document.querySelectorAll("#pages tr").length, 3);
  assert.equal((app.w.document.getElementById("interval") as any).value, "90");
  click(app, "single");
  await tick();
  assert.equal(app.messages.find((m) => m.type === "start")!.singlePage, true);
});
