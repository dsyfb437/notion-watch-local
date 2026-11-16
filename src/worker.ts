import {
  read,
  all,
  write,
  commit,
  checkpointRun,
  patchUpdateFlags,
  activateDatabase,
} from "./db";
import {
  DEFAULT_ROOT,
  pageRef,
  editDate,
  changed,
  inRecentScope,
  type Page,
  type Update,
  type Frame,
  type Child,
} from "./model";
import { readDocument } from "./reader";
type Settings = {
  root: string;
  enabled: boolean;
  interval: number;
  notify: boolean;
  concurrency?: number;
  fastNav?: boolean;
  recentOnly?: boolean;
  incremental?: boolean;
  windowMode?: boolean;
  collapseTabs?: boolean;
  databaseRoot?: string;
};
type Task = Child & { depth: number; parent?: string; tries: number };
type Lane = {
  runId: string;
  tabId?: number;
  ownedPageId?: string;
  current?: string;
  windowId?: number;
};
type Metrics = {
  cacheHits: number;
  fullScans: number;
  fastSuccess: number;
  fastFallback: number;
  menuTimeouts: number;
  navigationMs: number;
  metadataMs: number;
  discoveryMs: number;
};
const emptyMetrics = (): Metrics => ({
  cacheHits: 0,
  fullScans: 0,
  fastSuccess: 0,
  fastFallback: 0,
  menuTimeouts: 0,
  navigationMs: 0,
  metadataMs: 0,
  discoveryMs: 0,
});
type Run = {
  id: "run";
  runId: string;
  status: "running" | "done" | "stopped" | "paused";
  queue: Task[];
  seen: string[];
  done: number;
  failed: number;
  initial: boolean;
  singlePage?: boolean;
  retryOnly?: boolean;
  concurrency?: number;
  fastNav?: boolean;
  fastFails?: number;
  recentOnly?: boolean;
  incremental?: boolean;
  windowMode?: boolean;
  metrics?: Metrics;
  collapseTabs?: boolean;
  tabGroups?: Record<string, number>;
  skipped?: number;
  lanes?: Lane[];
  startedAt: number;
  heartbeat: number;
  errors: string[];
  tabId?: number;
  ownedPageId?: string;
  sessionToken?: string;
  current?: string;
  limited: boolean;
};
let pumping = false;
let starting = false;
let saving = false;
async function sessionToken() {
  const saved = await chrome.storage.session.get("ownershipToken");
  if (typeof saved.ownershipToken === "string") return saved.ownershipToken;
  const value = crypto.randomUUID();
  await chrome.storage.session.set({ ownershipToken: value });
  return value;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// 1-6 lanes. Same-site tabs share one renderer, so the gain tapers off; 6 is the cap.
const lanesOf = (value: unknown) =>
  Math.min(6, Math.max(1, Math.round(Number(value)) || 4));
const waiting = (action: string) =>
  action === "inspect" || action === "inspect-step" || action === "peek";
let inboxMigration: Promise<void> | undefined;
function migrateInbox() {
  if (!inboxMigration)
    inboxMigration = (async () => {
      const stored = await chrome.storage.local.get([
        "settings",
        "inboxUiVersion",
      ]);
      if (stored.inboxUiVersion === 1) return;
      const values: Record<string, unknown> = { inboxUiVersion: 1 };
      if (stored.settings)
        values.settings = {
          ...(stored.settings as Settings),
          windowMode: false,
        };
      await chrome.storage.local.set(values);
    })().catch((error) => {
      inboxMigration = undefined;
      throw error;
    });
  return inboxMigration;
}
async function settings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get("settings");
  const value = (settings as Settings | undefined) || {
    root: DEFAULT_ROOT,
    enabled: false,
    interval: 60,
    notify: false,
  };
  const id = pageRef(value.root)?.id;
  activateDatabase(
    id && value.databaseRoot && id !== value.databaseRoot ? id : "",
  );
  return value;
}
async function syncAlarms() {
  const s = await settings();
  if (s.enabled)
    await chrome.alarms.create("periodic", { periodInMinutes: s.interval });
  else await chrome.alarms.clear("periodic");
  const run = await read<Run>("state", "run");
  if (run?.status === "running")
    await chrome.alarms.create("resume", { periodInMinutes: 0.5 });
  else await chrome.alarms.clear("resume");
}
async function begin(singlePage = false, retryOnly = false) {
  if (saving) throw Error("设置正在保存，请稍后再试");
  if (starting) throw Error("检查正在启动");
  starting = true;
  try {
    await beginUnlocked(singlePage, retryOnly);
  } finally {
    starting = false;
  }
}
async function beginUnlocked(singlePage: boolean, retryOnly: boolean) {
  if (pumping) throw Error("上一轮正在收尾，请稍后再试");
  if ((await read<Run>("state", "run"))?.status === "running") {
    if (singlePage || retryOnly)
      throw Error("请先停止本轮，再启动单页或失败页检查");
    void pump();
    return;
  }
  const s = await settings();
  const ref = pageRef(s.root);
  if (!ref) throw Error("请先在订阅设置中填写并保存 app.notion.com 的页面地址");
  if (
    !(await chrome.permissions.contains({
      origins: ["https://app.notion.com/*"],
    }))
  )
    throw Error("请先授予 Notion 站点读取权限");
  const baseline = await read<{ id: string; done: boolean }>(
    "state",
    "baseline",
  );
  const previous = retryOnly ? await read<Run>("state", "run") : undefined;
  const retryPages = retryOnly
    ? (await all<Page>("pages")).filter(
        (p) =>
          p.error &&
          previous?.seen.includes(p.id) &&
          !!p.lastAttemptAt &&
          p.lastAttemptAt >= previous.startedAt,
      )
    : [];
  if (retryOnly && !retryPages.length)
    throw Error("上一轮没有需要重试的最终失败页面");
  const tasks: Task[] = retryOnly
    ? retryPages.map((p) => ({
        id: p.id,
        url: p.url,
        title: p.title,
        parent: p.parent,
        depth: p.depth,
        tries: 0,
      }))
    : [{ ...ref, title: "周报数据库", depth: 0, tries: 0 }];
  await write("state", {
    id: "run",
    runId: crypto.randomUUID(),
    status: "running",
    queue: tasks,
    seen: tasks.map((task) => task.id),
    done: 0,
    failed: 0,
    initial: !baseline?.done,
    singlePage: singlePage || retryOnly,
    retryOnly,
    concurrency: singlePage || s.windowMode ? 1 : lanesOf(s.concurrency),
    fastNav: !!s.fastNav,
    fastFails: 0,
    recentOnly: s.recentOnly !== false,
    incremental: s.incremental !== false,
    windowMode: !!s.windowMode,
    collapseTabs: !!s.collapseTabs,
    tabGroups: {},
    metrics: emptyMetrics(),
    skipped: 0,
    lanes: [],
    startedAt: Date.now(),
    heartbeat: 0,
    errors: [],
    limited: false,
  } satisfies Run);
  await syncAlarms();
  void pump();
}
async function active(runId: string) {
  const run = await read<Run>("state", "run");
  if (!run || run.runId !== runId || run.status !== "running")
    throw Error("检查已停止");
  return run;
}
async function checkpoint(run: Run) {
  await active(run.runId);
  run.heartbeat = Date.now();
  await checkpointRun(run);
}
async function ownedTab(run: Lane) {
  await active(run.runId);
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(run.tabId!);
  } catch {
    throw Error("检查标签页已关闭，本轮暂停");
  }
  if (run.windowId !== undefined) {
    if (tab.windowId !== run.windowId)
      throw Error("检查窗口中的标签页已被移动，本轮暂停");
    let win: chrome.windows.Window;
    try {
      win = await chrome.windows.get(run.windowId);
    } catch {
      throw Error("检查窗口已关闭，本轮暂停");
    }
    if (win.focused) throw Error("你正在查看检查窗口，本轮暂停");
    if (win.state === "minimized")
      throw Error("检查窗口已最小化，本轮暂停；请保留可见区域");
    if (!tab.active) throw Error("检查窗口中的页面不再是当前标签，本轮暂停");
  } else if (tab.active)
    throw Error("检查标签页已被打开查看，请返回控制台后重新检查");
  return tab;
}
async function guardNavigation(run: Lane, allowTarget = false) {
  const tab = await ownedTab(run);
  const allowed = [run.ownedPageId, ...(allowTarget ? [run.current] : [])];
  if (
    !run.ownedPageId ||
    !pageRef(tab.url || "") ||
    !allowed.includes(pageRef(tab.url || "")?.id) ||
    (tab.pendingUrl && !allowed.includes(pageRef(tab.pendingUrl)?.id))
  )
    throw Error("检查标签页已被用户导航，保留页面并暂停");
  return tab;
}
async function sample(
  tabId: number,
  run: Lane,
  action: Parameters<typeof readDocument>[0],
): Promise<Frame> {
  const tab = await ownedTab({ ...run, tabId });
  if (tab.pendingUrl)
    return {
      id: run.current || null,
      title: "",
      ready: false,
      children: [],
      warnings: [],
      bottom: false,
      position: 0,
      height: 0,
      observed: Date.now(),
      error: "正在导航",
    };
  const ref = pageRef(tab.url || "");
  if (!ref || ref.id !== run.current) {
    if (
      waiting(action) &&
      (tab.status === "loading" ||
        (action === "peek" && ref?.id === run.ownedPageId))
    )
      return {
        id: run.current || null,
        title: "",
        ready: false,
        children: [],
        warnings: [],
        bottom: false,
        position: 0,
        height: 0,
        observed: Date.now(),
        error: "正在等待导航完成",
      };
    throw Error("检查标签页地址变化，已停止操作");
  }
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: readDocument,
    args: [action],
  });
  const frame = results[0]?.result;
  if (!frame) {
    if (waiting(action))
      return {
        id: run.current || null,
        title: "",
        ready: false,
        children: [],
        warnings: [],
        bottom: false,
        position: 0,
        height: 0,
        observed: Date.now(),
        error: "等待页面文档读取结果",
      };
    throw Error("未收到页面读取结果");
  }
  if (frame.id !== run.current) {
    if (waiting(action))
      return { ...frame, ready: false, error: "正在等待目标文档切换" };
    throw Error("页面身份不匹配");
  }
  return frame;
}
async function fastNavigate(tabId: number, url: string) {
  // Notion's own router reacts to popstate. Main-world injection is required:
  // events dispatched from the isolated world never reach the page's listeners.
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (href: string) => {
      history.replaceState(null, "", href);
      window.dispatchEvent(new PopStateEvent("popstate"));
    },
    args: [url],
  });
}
async function waitDocument(
  tabId: number,
  run: Lane,
  id: string,
  timeout: number,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const frame = await sample(tabId, run, "peek");
      if (frame.documentId === id) return true;
    } catch (e) {
      if (!/Frame|Cannot access/.test(String(e))) throw e;
    }
    await sleep(150);
  }
  return false;
}
async function inspect(tabId: number, run: Lane) {
  const deadline = Date.now() + 30000;
  let frame: Frame | undefined;
  while (Date.now() < deadline) {
    try {
      frame = await sample(tabId, run, "inspect-step");
    } catch (e) {
      if (String(e).includes("Frame") || String(e).includes("Cannot access")) {
        await sleep(600);
        continue;
      }
      throw e;
    }
    if (frame.ready) break;
    await sleep(250);
  }
  if (!frame?.ready) throw Error(frame?.error || "页面加载超时");
  // After an in-page jump the old scroll position may persist.
  await sample(tabId, run, "reset-scroll");
  const children = new Map<string, Child>();
  const warnings = new Set<string>();
  let stable = 0,
    signature = "";
  for (let step = 0; step < 90; step++) {
    if (!frame.ready) {
      stable = 0;
      await sleep(300);
      frame = await sample(tabId, run, "inspect-step");
      continue;
    }
    for (const child of frame.children) children.set(child.id, child);
    for (const warning of frame.warnings) warnings.add(warning);
    const next = `${children.size}:${frame.height}:${frame.position}`;
    stable = frame.bottom && next === signature ? stable + 1 : 0;
    signature = next;
    if (stable >= 2)
      return {
        ...frame,
        children: [...children.values()],
        warnings: [...warnings],
      };
    await sleep(280);
    frame = await sample(tabId, run, "inspect-step");
  }
  throw Error("滚动覆盖未完成，未写入本次结果");
}
async function metadata(tabId: number, run: Lane, timeout = 10000) {
  // The topbar renders independently of the body. Poll in short steps instead of
  // paying a fixed 400 ms on every page; re-open the menu only when it is gone.
  const deadline = Date.now() + timeout;
  let reason = "最近编辑信息尚未就绪";
  while (Date.now() < deadline) {
    const prepared = await sample(tabId, run, "prepare-metadata");
    if (prepared.error || !prepared.ready) {
      reason = prepared.error || reason;
      await sleep(250);
      continue;
    }
    if (prepared.author && prepared.rawTime) return prepared;
    for (let attempt = 0; attempt < 8 && Date.now() < deadline; attempt++) {
      await sleep(120);
      const result = await sample(tabId, run, "metadata");
      if (!result.error && result.author && result.rawTime) return result;
      reason = result.error || reason;
    }
    await sleep(150);
  }
  throw Error(`${reason}；等待顶栏与菜单超时，未更新基线`);
}
async function release(run: Lane) {
  if (!run.tabId) return;
  try {
    const tab = await chrome.tabs.get(run.tabId);
    let safe = !tab.active;
    if (run.windowId !== undefined) {
      const win = await chrome.windows.get(run.windowId);
      safe = tab.windowId === run.windowId && !win.focused;
    }
    // Remove only our own tab; never remove a whole window containing user work.
    if (
      safe &&
      pageRef(tab.url || "")?.id === run.ownedPageId &&
      !tab.pendingUrl
    )
      await chrome.tabs.remove(run.tabId);
  } catch {}
  run.tabId = undefined;
  run.ownedPageId = undefined;
  run.windowId = undefined;
}
async function notify() {
  const s = await settings();
  if (
    !s.notify ||
    !(await chrome.permissions.contains({ permissions: ["notifications"] }))
  )
    return;
  const api = chrome.notifications;
  if (!api) throw Error("通知接口尚不可用，请重新加载扩展后重试");
  registerNotificationClick();
  const pending = (await all<Update>("updates")).filter((x) => !x.notified);
  if (!pending.length) return;
  // Stable notification ID replaces any replay after a worker restart.
  await api.create("notion-watch-updates", {
    type: "basic",
    iconUrl: "icon.png",
    title: "Notion 周报有新动态",
    message: `${pending.length} 条新发现或最近编辑信息。点击查看本地记录。`,
  });
  await patchUpdateFlags(
    pending.map((update) => update.id),
    { notified: true },
  );
}
async function pump() {
  if (pumping) return;
  pumping = true;
  let run: Run | undefined;
  // Only persistence and graph changes use this lock; browser reads run concurrently.
  let mutation = Promise.resolve();
  const update = (fn: () => void | Promise<void>) => {
    const result = mutation.then(async () => {
      await active(run!.runId);
      await fn();
      await checkpoint(run!);
    });
    mutation = result.catch(() => {});
    return result;
  };
  try {
    await settings();
    run = await read<Run>("state", "run");
    if (!run || run.status !== "running") return;
    const token = await sessionToken();
    if (!run.lanes)
      run.lanes = run.tabId
        ? [
            {
              runId: run.runId,
              tabId: run.tabId,
              ownedPageId: run.ownedPageId,
              current: run.current,
            },
          ]
        : [];
    if (run.sessionToken !== token) {
      run.lanes = [];
      run.tabGroups = {};
    }
    run.sessionToken = token;
    run.tabId = undefined;
    run.ownedPageId = undefined;
    run.metrics = { ...emptyMetrics(), ...run.metrics };
    run.concurrency =
      run.singlePage || run.windowMode ? 1 : lanesOf(run.concurrency);
    await checkpoint(run);
    const foldOwnedTab = async (lane: Lane) => {
      if (
        !run!.collapseTabs ||
        lane.windowId !== undefined ||
        !chrome.tabGroups ||
        !(await chrome.permissions.contains({ permissions: ["tabGroups"] }))
      )
        return;
      const tab = await ownedTab(lane);
      if (tab.windowId === undefined) return;
      await update(async () => {
        await guardNavigation(lane);
        const key = String(tab.windowId);
        run!.tabGroups ||= {};
        let groupId: number | undefined = run!.tabGroups[key];
        if (groupId !== undefined) {
          try {
            const group = await chrome.tabGroups.get(groupId);
            if (group.windowId !== tab.windowId) groupId = undefined;
          } catch {
            groupId = undefined;
          }
        }
        if (groupId === undefined) {
          groupId = await chrome.tabs.group({
            tabIds: [lane.tabId!],
            createProperties: { windowId: tab.windowId },
          });
          run!.tabGroups[key] = groupId;
          await chrome.tabGroups.update(groupId, {
            title: "周报检查",
            collapsed: true,
            color: "grey",
          });
        } else await chrome.tabs.group({ tabIds: [lane.tabId!], groupId });
      });
    };
    const stopAt = Date.now() + 180000;
    while (run.queue.length && Date.now() < stopAt) {
      await active(run.runId);
      const batch = run.queue.slice(0, run.concurrency);
      const settled = await Promise.allSettled(
        batch.map(async (task, index) => {
          const lane: Lane = {
            ...(run!.lanes![index] || {}),
            runId: run!.runId,
            current: task.id,
          };
          // Persisted lanes are indexed by slot. Lanes start concurrently, so pad the
          // array before writing: a hole must never reach release() after a restart.
          const saveLane = () =>
            update(() => {
              const lanes = run!.lanes!;
              while (lanes.length <= index) lanes.push({ runId: run!.runId });
              lanes[index] = { ...lane };
            });
          let frame: Frame | undefined;
          const stats = emptyMetrics();
          const timed = async <T>(
            key: "navigationMs" | "metadataMs" | "discoveryMs",
            fn: () => Promise<T>,
          ) => {
            const started = Date.now();
            try {
              return await fn();
            } finally {
              stats[key] += Date.now() - started;
            }
          };
          try {
            await timed("navigationMs", async () => {
              if (!lane.tabId) {
                if (run!.windowMode) {
                  const win = await chrome.windows.create({
                    url: task.url,
                    type: "normal",
                    focused: false,
                    width: 720,
                    height: 760,
                  });
                  if (!win) throw Error("检查窗口创建失败");
                  lane.windowId = win.id;
                  lane.tabId = win.tabs?.[0]?.id;
                  if (lane.windowId === undefined || lane.tabId === undefined)
                    throw Error("检查窗口未返回可用标签页");
                } else {
                  const tab = await chrome.tabs.create({
                    url: task.url,
                    active: false,
                  });
                  lane.tabId = tab.id;
                }
                lane.ownedPageId = task.id;
                await saveLane();
              } else {
                await guardNavigation(lane);
                let swapped = false;
                if (run!.fastNav === true) {
                  try {
                    await fastNavigate(lane.tabId, task.url);
                    swapped = await waitDocument(
                      lane.tabId,
                      lane,
                      task.id,
                      3000,
                    );
                  } catch {
                    swapped = false;
                  }
                  // Never swallow stop, focus or ownership changes as a routing failure.
                  await guardNavigation(lane, true);
                  if (swapped) stats.fastSuccess++;
                  else {
                    stats.fastFallback++;
                    await update(() => {
                      run!.fastFails = (run!.fastFails || 0) + 1;
                      if (run!.fastFails >= 2) run!.fastNav = false;
                    });
                  }
                }
                if (!swapped) {
                  await guardNavigation(lane, true);
                  await chrome.tabs.update(lane.tabId, { url: task.url });
                }
                lane.ownedPageId = task.id;
                await saveLane();
              }
            });
            try {
              await foldOwnedTab(lane);
            } catch (error) {
              await update(() => {
                run!.errors.push(`检查标签组未折叠：${String(error)}`);
              });
            }
            // Read the editor first. An unchanged page does not need the expensive
            // full-content scroll; its known children can be replayed from the store.
            let meta: Frame | undefined;
            try {
              meta = await timed("metadataMs", () =>
                metadata(lane.tabId!, lane, 5000),
              );
            } catch {
              stats.menuTimeouts++;
              meta = undefined;
            }
            let old: Page | undefined;
            if (meta) {
              const key = editDate(meta.rawTime!, meta.observed);
              if (!key) throw Error(`不支持的编辑时间格式：${meta.rawTime}`);
              old = await read<Page>("pages", task.id);
              const canSkip =
                task.depth > 0 &&
                run!.incremental !== false &&
                !run!.singlePage &&
                !!old?.lastSuccessfulAt &&
                old.editKey === key &&
                old.author === meta.author &&
                !(old.warnings && old.warnings.length) &&
                Array.isArray(old.children) &&
                typeof old.lastDiscoveryAt === "number" &&
                Date.now() - old.lastDiscoveryAt >= 0 &&
                Date.now() - old.lastDiscoveryAt < 24 * 60 * 60 * 1000;
              if (canSkip) {
                stats.cacheHits++;
                const known = old!.children!;
                await update(() => {
                  for (const child of known) {
                    if (run!.seen.includes(child.id)) continue;
                    if (task.depth >= 8 || run!.seen.length >= 200) {
                      run!.limited = true;
                      run!.errors.push(
                        "达到深度 8 或页面 200 的范围上限；有页面未检查",
                      );
                      continue;
                    }
                    run!.seen.push(child.id);
                    run!.queue.push({
                      id: child.id,
                      url: child.url,
                      title: child.title,
                      parent: task.id,
                      depth: task.depth + 1,
                      tries: 0,
                    });
                  }
                });
                await sample(lane.tabId!, lane, "close-menu");
                const page: Page = {
                  ...old!,
                  title: meta.title || old!.title,
                  parent: task.parent,
                  depth: task.depth,
                  author: meta.author,
                  editKey: key,
                  rawTime: meta.rawTime,
                  lastAttemptAt: Date.now(),
                  lastSuccessfulAt: Date.now(),
                  error: undefined,
                };
                await update(async () => {
                  await commit(page, undefined, run!.runId);
                  run!.done++;
                  run!.queue = run!.queue.filter((q) => q.id !== task.id);
                });
                return { task, lane, index, stats };
              }
              await sample(lane.tabId!, lane, "close-menu");
            }
            stats.fullScans++;
            frame = await timed("discoveryMs", () =>
              inspect(lane.tabId!, lane),
            );
            // Save discoveries even if the metadata read fails.
            const discovered = frame;
            await update(() => {
              if (discovered.warnings.length) run!.limited = true;
              for (const child of discovered.children) {
                if (run!.singlePage || run!.seen.includes(child.id)) continue;
                // Weekly folders accumulate; only the recent window matters for "who edited".
                if (
                  task.depth === 0 &&
                  run!.recentOnly !== false &&
                  !inRecentScope(child.title, Date.now())
                ) {
                  run!.skipped = (run!.skipped || 0) + 1;
                  continue;
                }
                if (task.depth >= 8 || run!.seen.length >= 200) {
                  run!.limited = true;
                  run!.errors.push(
                    "达到深度 8 或页面 200 的范围上限；有页面未检查",
                  );
                  continue;
                }
                run!.seen.push(child.id);
                run!.queue.push({
                  ...child,
                  parent: task.id,
                  depth: task.depth + 1,
                  tries: 0,
                });
              }
            });
            if (!meta)
              meta = await timed("metadataMs", () =>
                metadata(lane.tabId!, lane, 7000),
              );
            const key = editDate(meta.rawTime!, meta.observed);
            if (!key) throw Error(`不支持的编辑时间格式：${meta.rawTime}`);
            if (!old) old = await read<Page>("pages", task.id);
            const page: Page = {
              ...task,
              title: frame.title,
              author: meta.author,
              editKey: key,
              rawTime: meta.rawTime,
              lastAttemptAt: Date.now(),
              lastSuccessfulAt: Date.now(),
              warnings: frame.warnings,
              children: frame.children,
              lastDiscoveryAt: Date.now(),
            };
            let change: Update | undefined;
            if (changed(old, page) || (!old?.lastSuccessfulAt && !run!.initial))
              change = {
                id: `${page.id}:${key}:${page.author}`,
                pageId: page.id,
                url: page.url,
                title: page.title,
                author: page.author!,
                editKey: key,
                detectedAt: Date.now(),
                kind: old?.lastSuccessfulAt ? "updated" : "discovered",
                notified: false,
              };
            await update(async () => {
              await commit(page, change, run!.runId);
              run!.done++;
              run!.queue = run!.queue.filter((q) => q.id !== task.id);
            });
            return { task, lane, index, stats };
          } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            // A stop or another lane's pause invalidates every late result.
            if ((await read<Run>("state", "run"))?.status !== "running")
              return { task, lane, error, index, stats };
            await update(async () => {
              const old = await read<Page>("pages", task.id);
              await commit(
                {
                  ...(old || task),
                  title: frame?.title || task.title,
                  lastAttemptAt: Date.now(),
                  error,
                },
                undefined,
                run!.runId,
              );
              run!.errors.push(`${frame?.title || task.title}：${error}`);
              run!.errors = run!.errors.slice(-80);
              if (
                error.includes("标签页") ||
                error.includes("页面身份") ||
                error.includes("检查窗口")
              ) {
                run!.status = "paused";
                return;
              }
              run!.queue = run!.queue.filter((q) => q.id !== task.id);
              if (task.tries < 1)
                run!.queue.push({ ...task, tries: task.tries + 1 });
              else run!.failed++;
            });
            return { task, lane, error, index, stats };
          }
        }),
      );
      const outcomes = settled.flatMap((item) =>
        item.status === "fulfilled" ? [item.value] : [],
      );
      const rejected = settled.find((item) => item.status === "rejected");
      if (
        rejected?.status === "rejected" &&
        (await read<Run>("state", "run"))?.status === "running"
      )
        throw rejected.reason;
      if (run.status === "running")
        await update(() => {
          for (const outcome of outcomes)
            for (const key of Object.keys(outcome.stats) as (keyof Metrics)[])
              run!.metrics![key] += outcome.stats[key];
        });
      // Close failed owned tabs only after both lanes have settled. Never close a taken-over tab.
      for (let index = 0; index < outcomes.length; index++) {
        const outcome = outcomes[index];
        if (outcome.error) {
          await release(outcome.lane);
          if (run.status === "running")
            await update(() => {
              run!.lanes![outcome.index] = { ...outcome.lane };
            });
        }
      }
      if (run.status !== "running") break;
    }
    if (run.status === "running" && !run.queue.length) {
      for (const lane of (run.lanes || []).filter(Boolean)) await release(lane);
      run.status = "done";
      await checkpointRun(run);
      if (!run.failed && !run.singlePage)
        await write("state", { id: "baseline", done: true });
      await notify();
    }
  } catch (e) {
    const current = await read<Run>("state", "run");
    if (
      current?.status === "running" &&
      (!run || current.runId === run.runId)
    ) {
      current.status = "paused";
      current.errors.push(String(e));
      await checkpointRun(current);
    }
  } finally {
    try {
      const current = await read<Run>("state", "run");
      if (
        run &&
        current?.runId === run.runId &&
        ["stopped", "paused"].includes(current.status) &&
        current.sessionToken === (await sessionToken())
      ) {
        for (const lane of (current.lanes || []).filter(Boolean))
          await release(lane);
        await write("state", current);
      }
    } finally {
      pumping = false;
      await syncAlarms();
    }
  }
}
chrome.runtime.onInstalled.addListener(() => {
  void migrateInbox()
    .then(() => syncAlarms())
    .catch(console.error);
});
chrome.runtime.onStartup.addListener(() => {
  void syncAlarms().then(() => pump());
});
chrome.alarms.onAlarm.addListener((alarm) => {
  void (async () => {
    if (alarm.name === "periodic") {
      if (!(await settings()).enabled) return;
      if ((await read<Run>("state", "run"))?.status !== "running")
        await begin();
    } else if (alarm.name === "resume") await pump();
  })().catch(console.error);
});
chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
});
// Optional APIs may be entirely absent until the permission is granted.
// Register again after grant, without duplicate listeners on the same event.
let notificationClickEvent: typeof chrome.notifications.onClicked | undefined;
function openNotificationDashboard() {
  void chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
}
function registerNotificationClick() {
  const event = chrome.notifications?.onClicked;
  if (!event || event === notificationClickEvent) return;
  event.addListener(openNotificationDashboard);
  notificationClickEvent = event;
}
registerNotificationClick();
chrome.permissions.onAdded?.addListener((permissions) => {
  if (permissions.permissions?.includes("notifications"))
    registerNotificationClick();
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (
    sender.id !== chrome.runtime.id ||
    sender.url?.split("#")[0] !== chrome.runtime.getURL("dashboard.html")
  )
    return;
  void (async () => {
    const currentSettings = await settings();
    if (message.type === "status") {
      await migrateInbox();
      const s = await settings();
      const [run, pages, updates, access] = await Promise.all([
        read("state", "run"),
        all("pages"),
        all("updates"),
        chrome.permissions.contains({ origins: ["https://app.notion.com/*"] }),
      ]);
      return {
        settings: s,
        run,
        pages,
        updates,
        access,
        settling: pumping && (run as Run | undefined)?.status !== "running",
      };
    }
    if (
      message.scope !== undefined &&
      message.scope !== (pageRef(currentSettings.root)?.id || "")
    )
      throw Error("订阅入口已在其他页面变更，请刷新后再操作");
    if (message.type === "read") {
      if (
        !Array.isArray(message.ids) ||
        message.ids.length > 1000 ||
        message.ids.some((id: unknown) => typeof id !== "string")
      )
        throw Error("动态记录参数无效");
      await patchUpdateFlags(message.ids, { read: true });
      return { ok: true };
    }
    if (message.type === "retry") {
      await begin(false, true);
      return { ok: true };
    }
    if (message.type === "start") {
      await begin(!!message.singlePage);
      return { ok: true };
    }
    if (message.type === "stop") {
      const run = await read<Run>("state", "run");
      if (run?.status === "running") {
        run.status = "stopped";
        await write(
          "state",
          run,
        ); /* Do not close a tab while a read task is in flight. */
      }
      await syncAlarms();
      return { ok: true };
    }
    if (message.type === "save") {
      if (saving || starting || pumping)
        throw Error("检查或设置正在处理中，请稍后再保存");
      saving = true;
      try {
        const existing = await settings();
        const root = pageRef(message.settings.root);
        if (!root) throw Error("地址格式不支持");
        if ((await read<Run>("state", "run"))?.status === "running")
          throw Error("请先停止检查再修改设置");
        const s: Settings = {
          databaseRoot:
            existing.databaseRoot || pageRef(existing.root)?.id || root.id,
          root: root.url,
          interval: Math.max(
            15,
            Math.min(1440, Number(message.settings.interval) || 60),
          ),
          enabled: !!message.settings.enabled,
          notify: !!message.settings.notify,
          concurrency: lanesOf(message.settings.concurrency),
          fastNav: !!message.settings.fastNav,
          recentOnly: message.settings.recentOnly !== false,
          incremental: message.settings.incremental !== false,
          windowMode: !!message.settings.windowMode,
          collapseTabs: !!message.settings.collapseTabs,
        };
        if (
          s.enabled &&
          !(await chrome.permissions.contains({
            origins: ["https://app.notion.com/*"],
          }))
        )
          throw Error("尚未授予 Notion 读取权限");
        await chrome.storage.local.set({ settings: s });
        await syncAlarms();
        return { ok: true };
      } finally {
        saving = false;
      }
    }
    throw Error("未知操作");
  })().then(respond, (e) =>
    respond({ error: e instanceof Error ? e.message : String(e) }),
  );
  return true;
});
