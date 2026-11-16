import { pageRef, type Page, type Update } from "./model";
const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const el = (tag: string, text = "", className = "") => {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
};
const when = (n?: number) =>
  n
    ? new Date(n).toLocaleString("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "尚未检查";
const duration = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
};
const sameDay = (a: number, b: number) =>
  new Date(a).toDateString() === new Date(b).toDateString();
function msg(text: string, success = false) {
  const node = $("message");
  node.textContent = text;
  node.hidden = !text;
  node.className = success ? "message success" : "message";
}
async function send(type: string, extra: Record<string, unknown> = {}) {
  const value = await chrome.runtime.sendMessage({
    type,
    ...(type === "status"
      ? {}
      : { scope: pageRef(data?.settings.root || "")?.id || "" }),
    ...extra,
  });
  if (!value) throw Error("无法连接扩展后台，请重新加载扩展并重新打开此页面。");
  if (value?.error) throw Error(value.error);
  return value;
}
function link(title: string, url: string) {
  const a = el("a", title) as HTMLAnchorElement;
  const ref = pageRef(url);
  if (ref) {
    a.href = ref.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  } else {
    a.setAttribute("aria-disabled", "true");
    a.title = "页面地址不可用";
  }
  return a;
}
type ViewData = {
  settings: any;
  run?: any;
  pages: Page[];
  updates: Update[];
  access?: boolean;
  settling?: boolean;
};
let dirty = false,
  savedForm = "",
  currentView = "inbox";
let data: ViewData | undefined,
  loaded = false,
  view: "unread" | "all" = "unread",
  query = "",
  limit = 50,
  feedSignature = "",
  refreshVersion = 0;
const pending = new Set<string>();
const pendingReads = new Set<string>();
const commands = ["start", "single", "retry", "stop", "save", "grant"];
function retryableCount() {
  const run = data?.run;
  return run
    ? data!.pages.filter(
        (p) =>
          p.error &&
          run.seen?.includes(p.id) &&
          p.lastAttemptAt &&
          p.lastAttemptAt >= run.startedAt,
      ).length
    : 0;
}
function updateControls() {
  const running = data?.run?.status === "running";
  const changing = !!data?.settling || commands.some((id) => pending.has(id));
  const connected =
    !!data && data.access !== false && !!pageRef(data.settings.root);
  for (const id of ["start", "single"])
    $<HTMLButtonElement>(id).disabled =
      !connected || running || changing || dirty;
  $<HTMLButtonElement>("save").disabled = !data || running || changing;
  $<HTMLButtonElement>("retry").disabled =
    !connected || running || changing || dirty || !retryableCount();
  $<HTMLButtonElement>("stop").disabled = !running || changing;
  $("stop").hidden = !running;
  $<HTMLButtonElement>("grant").disabled =
    !data || changing || data.access === true;
  $("grant").textContent =
    data?.access === true ? "Notion 已授权" : "授权读取 Notion";
  $<HTMLButtonElement>("refresh").disabled = pending.has("refresh");
  $<HTMLButtonElement>("read-all").disabled =
    !data ||
    !!pendingReads.size ||
    pending.has("read-all") ||
    !matchingUpdates().some((u) => !u.read);
  $("read-all").textContent = query ? "筛选结果标为已读" : "全部标为已读";
  for (const input of document.querySelectorAll<
    HTMLInputElement | HTMLSelectElement
  >("#settings input,#settings select"))
    input.disabled = running || pending.has("save");
  $<HTMLButtonElement>("reset-settings").disabled =
    !dirty || running || pending.has("save");
  $("retry").title = retryableCount()
    ? `仅重试上一轮的 ${retryableCount()} 个失败页面`
    : "上一轮没有可重试的失败页面";
}
function matchingUpdates() {
  if (!data) return [];
  const byId = new Map(data.pages.map((p) => [p.id, p]));
  return data.updates.filter(
    (u) =>
      (view === "all" || !u.read) &&
      (!query ||
        [u.title, u.author, weekOf(byId.get(u.pageId), byId)].some((text) =>
          text.toLocaleLowerCase().includes(query),
        )),
  );
}

$("version").textContent =
  `v${chrome.runtime.getManifest().version} · 本地只读`;
function weekOf(page: Page | undefined, byId: Map<string, Page>) {
  if (!page || page.depth < 2) return "";
  let current = byId.get(page.parent || "");
  const visited = new Set<string>();
  while (current && current.depth > 1 && !visited.has(current.id)) {
    visited.add(current.id);
    current = byId.get(current.parent || "");
  }
  return current?.depth === 1 ? current.title : "";
}
function reveal(id: string) {
  currentView = ["settings", "logs"].includes(id) ? id : "inbox";
  $("inbox-view").hidden = currentView !== "inbox";
  for (const viewId of ["settings", "logs"]) {
    const details = $<HTMLDetailsElement>(viewId);
    details.hidden = currentView !== viewId;
    if (!details.hidden) details.open = true;
  }
  for (const viewId of ["inbox", "settings", "logs"]) {
    const nav = $(viewId + "-link");
    nav.classList.toggle("nav-active", viewId === currentView);
    if (viewId === currentView) nav.setAttribute("aria-current", "page");
    else nav.removeAttribute("aria-current");
  }
  const copy: Record<string, string[]> = {
    inbox: ["更新收件箱", "你关注的页面，有新动静了。"],
    settings: ["订阅设置", "设置入口页面、检查频率和提醒方式。"],
    logs: ["运行日志", "查看检查进度、失败原因和页面索引。"],
  };
  $("view-title").textContent = copy[currentView][0];
  $("view-description").textContent = copy[currentView][1];
  if (location.hash !== "#" + currentView) location.hash = currentView;
  $("inbox").scrollIntoView?.({ block: "start" });
}
const formFlags = [
  ["enabled", "enabled", false],
  ["notify", "notify", false],
  ["collapsetabs", "collapseTabs", false],
  ["fastnav", "fastNav", false],
  ["windowmode", "windowMode", false],
  ["recentonly", "recentOnly", true],
  ["incremental", "incremental", true],
] as const;
function formSettings(): {
  root: string;
  interval: number;
  concurrency: number;
} & Record<(typeof formFlags)[number][1], boolean> {
  return {
    root: $<HTMLInputElement>("root").value.trim(),
    interval: Number($<HTMLSelectElement>("interval").value),
    concurrency: Number($<HTMLSelectElement>("concurrency").value),
    ...Object.fromEntries(
      formFlags.map(([id, key]) => [key, $<HTMLInputElement>(id).checked]),
    ),
  } as { root: string; interval: number; concurrency: number } & Record<
    (typeof formFlags)[number][1],
    boolean
  >;
}
function settingsStatus() {
  const status = $("settings-status");
  status.textContent =
    !dirty && !pageRef(data?.settings.root || "")
      ? "填写入口并保存后开始使用。"
      : dirty
        ? "有未保存的更改，点击“保存设置”后生效。"
        : "设置已保存，重新打开或刷新后仍然保留。";
  status.classList.toggle("dirty", dirty);
  updateControls();
}
function hydrateSettings() {
  if (!data) return;
  const s = data.settings;
  $<HTMLInputElement>("root").value = s.root;
  const interval = $<HTMLSelectElement>("interval");
  if (
    !Array.from(interval.options).some(
      (option) => option.value === String(s.interval),
    )
  ) {
    const option = el("option", `每 ${s.interval} 分钟`) as HTMLOptionElement;
    option.value = String(s.interval);
    interval.append(option);
  }
  interval.value = String(s.interval);
  $<HTMLSelectElement>("concurrency").value = String(s.concurrency || 4);
  for (const [id, key, defaultOn] of formFlags)
    $<HTMLInputElement>(id).checked = defaultOn ? s[key] !== false : !!s[key];
  savedForm = JSON.stringify(formSettings());
  dirty = false;
  settingsStatus();
}

function renderFeed() {
  if (!data) return;
  const byId = new Map(data.pages.map((p) => [p.id, p]));
  const all = [...data.updates].sort((a, b) => b.detectedAt - a.detectedAt);
  const unread = all.filter((u) => !u.read);
  $("unread-count").textContent = String(unread.length);
  $("nav-unread").textContent = String(unread.length);
  $("filter-count").textContent = String(unread.length);
  $("today-count").textContent = String(
    all.filter((u) => sameDay(u.detectedAt, Date.now())).length,
  );
  $("filter-unread").setAttribute("aria-selected", String(view === "unread"));
  $("filter-all").setAttribute("aria-selected", String(view === "all"));
  updateControls();
  const filtered = all.filter(
    (u) =>
      (view === "all" || !u.read) &&
      (!query ||
        [u.title, u.author, weekOf(byId.get(u.pageId), byId)].some((text) =>
          text.toLocaleLowerCase().includes(query),
        )),
  );
  const visible = filtered.slice(0, limit);
  const signature = JSON.stringify([
    new Date().toDateString(),
    view,
    query,
    limit,
    filtered.length,
    all.length,
    data.run?.initial,
    visible.map((u) => [
      u.id,
      u.read,
      u.url,
      u.title,
      u.author,
      u.editKey,
      u.detectedAt,
      weekOf(byId.get(u.pageId), byId),
    ]),
  ]);
  $("more").hidden = filtered.length <= limit;
  $("updates").setAttribute(
    "aria-labelledby",
    view === "unread" ? "filter-unread" : "filter-all",
  );
  if (signature === feedSignature) return;
  feedSignature = signature;
  const feed = $("updates");
  feed.replaceChildren();
  if (!visible.length) {
    const empty = el("div", "", "empty");
    empty.append(
      el("div", query ? "⌕" : "✓", "empty-icon"),
      el(
        "h3",
        query
          ? "没有找到相关动态"
          : all.length && view === "unread"
            ? "都看完了，暂时没有未读动态"
            : "还没有新的页面动态",
      ),
      el(
        "p",
        query
          ? "试试页面名称、作者或所属周报。"
          : all.length
            ? "下次有页面更新，会出现在这里。"
            : "首次检查建立记录，之后发现的变化会出现在这里。",
      ),
    );
    feed.append(empty);
    return;
  }
  let currentDay = "";
  let section: HTMLElement | undefined;
  for (const update of visible) {
    const d = new Date(update.detectedAt);
    const key = d.toDateString();
    if (key !== currentDay) {
      currentDay = key;
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const label = sameDay(update.detectedAt, Date.now())
        ? "今天"
        : sameDay(update.detectedAt, yesterday.getTime())
          ? "昨天"
          : d.toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
      section = el("section", "", "day-group");
      const heading = el("h2", label, "day-label");
      heading.append(
        el(
          "span",
          `${filtered.filter((u) => new Date(u.detectedAt).toDateString() === key).length} 条动态`,
        ),
      );
      section.append(heading);
      feed.append(section);
    }
    const item = el("article", "", `event ${update.read ? "read" : "unread"}`);
    item.setAttribute(
      "aria-label",
      `${update.title}，${update.author}，${update.read ? "已读" : "未读"}`,
    );
    const avatar = el(
      "div",
      Array.from(update.author.trim())[0]?.toLocaleUpperCase() || "N",
      "avatar",
    );
    avatar.setAttribute("aria-hidden", "true");
    const body = el("div", "", "event-body"),
      title = el("h3"),
      anchor = link(update.title, update.url);
    if (anchor.hasAttribute("href")) {
      anchor.title = "打开 Notion 原页面";
      anchor.addEventListener("click", () => {
        if (!update.read) void markRead([update.id]).catch(() => {});
      });
    }
    title.append(anchor);
    if (!update.read) {
      const dot = el("span", "", "unread-dot");
      dot.setAttribute("aria-hidden", "true");
      title.append(dot);
    }
    const meta = el("div", "", "event-meta");
    meta.append(
      el("span", update.author, "actor"),
      el(
        "span",
        update.kind === "discovered" ? "首次发现" : "页面更新",
        `kind ${update.kind}`,
      ),
    );
    const week = weekOf(byId.get(update.pageId), byId);
    if (week) meta.append(el("span", "·"), el("span", week));
    body.append(title, meta);
    const side = el("div", "", "event-side"),
      time = el(
        "time",
        update.editKey.startsWith(String(new Date().getFullYear()))
          ? update.editKey.slice(5)
          : update.editKey,
      ) as HTMLTimeElement;
    time.dateTime = update.editKey.replace(" ", "T");
    time.title = `页面编辑时间：${update.editKey}\n检测于：${new Date(update.detectedAt).toLocaleString("zh-CN")}`;
    side.append(time);
    if (!update.read) {
      const button = el("button", "✓", "mark-read") as HTMLButtonElement;
      button.type = "button";
      button.disabled = pendingReads.has(update.id);
      button.title = "标为已读";
      button.setAttribute("aria-label", `将 ${update.title} 标为已读`);
      button.addEventListener("click", () => {
        button.disabled = true;
        void markRead([update.id])
          .catch(() => {})
          .finally(() => {
            button.disabled = pendingReads.has(update.id);
          });
      });
      side.append(button);
    } else side.append(el("span", "已读", "read-label"));
    item.append(avatar, body, side);
    section!.append(item);
  }
}
function renderLogs() {
  if (!data) return;
  const run = data.run,
    box = $("run");
  box.replaceChildren();
  if (run) {
    const statuses: Record<string, string> = {
      running: "检查中",
      done: "本轮结束",
      stopped: "已停止",
      paused: "已暂停",
    };
    const elapsed =
      (run.status === "running" ? Date.now() : run.heartbeat || run.startedAt) -
      run.startedAt;
    box.append(
      el(
        "strong",
        `${statuses[run.status] || run.status} · 成功 ${run.done} 页 · 失败 ${run.failed} 页 · 待检查 ${run.queue.length} 页`,
      ),
      el(
        "small",
        `开始：${when(run.startedAt)} · 用时 ${duration(elapsed)}${run.initial ? " · 首次基线" : ""}${run.retryOnly ? " · 失败页重试" : ""}${run.singlePage && !run.retryOnly ? " · 仅入口页" : ""}${run.limited ? " · 存在覆盖限制" : ""}${run.skipped ? ` · 跳过旧周报 ${run.skipped} 个` : ""}`,
      ),
    );
    if (run.metrics) {
      const m = run.metrics;
      box.append(
        el(
          "div",
          `缓存跳过滚动 ${m.cacheHits} 次 · 完整滚动 ${m.fullScans} 次 · 快速切换 ${m.fastSuccess} 次 / 回退 ${m.fastFallback} 次 · 菜单首次超时 ${m.menuTimeouts} 次`,
        ),
        el(
          "small",
          `累计任务耗时（并行会重叠）：导航 ${duration(m.navigationMs)} · 页面/菜单 ${duration(m.metadataMs)} · 滚动 ${duration(m.discoveryMs)}${run.windowMode ? " · 独立窗口，实际单路" : ""}${run.fastFails >= 2 && !run.fastNav ? " · 快速切换本轮已停用" : ""}`,
        ),
      );
    }
    $("errors").textContent = (run.errors || []).join("\n") || "本轮暂无错误。";
    $("log-caption").textContent =
      `${run.failed ? `${run.failed} 页未读到最新状态` : "检查进度与诊断记录"}`;
  } else {
    $("errors").textContent = "暂无运行记录。";
    box.textContent = "还没有运行过检查。";
  }
  $("page-count").textContent = String(data.pages.length);
  if ($<HTMLDetailsElement>("page-index").open) renderPages();
}
function renderPages() {
  if (!data) return;
  const run = data.run,
    rows = $("pages"),
    byId = new Map(data.pages.map((p) => [p.id, p]));
  rows.replaceChildren();
  for (const page of [...data.pages].sort(
    (a, b) => a.depth - b.depth || a.title.localeCompare(b.title),
  )) {
    const row = el("tr"),
      name = el("td");
    name.append(link(page.title, page.url));
    const week = weekOf(page, byId);
    if (week) name.append(el("small", week));
    const author = el("td", page.author || "—");
    author.append(el("small", page.editKey || "尚未成功读取"));
    const status =
      run && (!page.lastAttemptAt || page.lastAttemptAt < run.startedAt)
        ? "本轮未检查，保留历史记录"
        : page.error || "已读取";
    const state = el("td", status, page.error ? "bad" : "");
    state.append(
      el(
        "small",
        `尝试 ${when(page.lastAttemptAt)} · 成功 ${when(page.lastSuccessfulAt)}`,
      ),
    );
    if (page.warnings?.length)
      state.append(el("small", page.warnings.join("；")));
    row.append(name, author, state);
    rows.append(row);
  }
}
function render() {
  if (!data) return;
  const run = data.run,
    busy = run?.status === "running";
  updateControls();
  const last = run?.status === "running" ? run.startedAt : run?.heartbeat;
  $("last-check").textContent = when(last);
  $("schedule").textContent = data.settings.enabled
    ? `${data.settings.interval === 60 ? "每小时" : `每 ${data.settings.interval} 分钟`}自动检查`
    : "手动检查";
  const rootPage = data.pages.find((p) => p.depth === 0);
  $("source-name").textContent = rootPage?.title || "我的周报订阅";
  const source = $<HTMLAnchorElement>("source-link");
  const sourceRef = pageRef(data.settings.root);
  if (sourceRef) {
    source.href = sourceRef.url;
    source.removeAttribute("aria-disabled");
  } else {
    source.removeAttribute("href");
    source.setAttribute("aria-disabled", "true");
  }
  const summaries: Record<string, string> = {
    running: `正在检查，已完成 ${run?.done || 0} 页，动态会陆续显示。`,
    done: run?.failed
      ? `${run.failed} 个页面暂未读到最新状态，已有动态仍可查看。`
      : `已完成检查，成功读取 ${run?.done || 0} 个页面。`,
    stopped: "本轮已停止，已读到的记录会保留。",
    paused: "检查已暂停，可在运行日志中查看原因。",
  };
  $("start").title = dirty
    ? "请先保存或撤销设置更改"
    : data.settling
      ? "正在关闭检查页，请稍候"
      : "";
  $("summary").textContent = data.settling
    ? "正在关闭检查页，请稍候。"
    : !pageRef(data.settings.root)
      ? "请先在订阅设置中填写入口页面。"
      : data.access === false
        ? "请先在订阅设置中授权读取 Notion。"
        : run
          ? summaries[run.status] || "等待检查。"
          : "还没有检查过，点击“检查更新”开始。";
  $("status-dot").className = busy
    ? "status-dot busy"
    : run?.failed || run?.status === "paused"
      ? "status-dot warning"
      : "status-dot";
  renderFeed();
  renderLogs();
}
async function refresh() {
  const version = ++refreshVersion;
  const value = await send("status");
  if (version !== refreshVersion) return;
  data = value;
  const first = !loaded;
  if (first || !dirty) hydrateSettings();
  loaded = true;
  if (first && (value.access === false || !pageRef(value.settings.root)))
    reveal("settings");
  render();
}

async function markRead(ids: string[]) {
  const selected = ids.filter((id) => !pendingReads.has(id));
  if (!selected.length) return;
  selected.forEach((id) => pendingReads.add(id));
  updateControls();
  try {
    for (let i = 0; i < selected.length; i += 1000)
      await send("read", { ids: selected.slice(i, i + 1000) });
    await refresh();
  } catch (e) {
    msg(e instanceof Error ? e.message : String(e));
    throw e;
  } finally {
    selected.forEach((id) => pendingReads.delete(id));
    updateControls();
  }
}
function bind(id: string, fn: () => Promise<void>) {
  $(id).addEventListener("click", () => {
    if (pending.has(id)) return;
    pending.add(id);
    updateControls();
    msg("");
    void fn()
      .catch((e) => {
        msg(e instanceof Error ? e.message : String(e));
        $("message").scrollIntoView?.({ block: "nearest" });
      })
      .finally(() => {
        pending.delete(id);
        updateControls();
      });
  });
}
$("inbox-link").addEventListener("click", (event) => {
  event.preventDefault();
  reveal("inbox");
});
document.querySelector(".brand")!.addEventListener("click", (event) => {
  event.preventDefault();
  reveal("inbox");
});
window.addEventListener("hashchange", () => {
  const next = location.hash.slice(1);
  if (next !== currentView) reveal(next);
});
window.addEventListener("beforeunload", (event) => {
  if (dirty) {
    event.preventDefault();
    event.returnValue = true;
  }
});
for (const input of document.querySelectorAll(
  "#settings input,#settings select",
)) {
  input.addEventListener("input", () => {
    dirty = JSON.stringify(formSettings()) !== savedForm;
    settingsStatus();
  });
  input.addEventListener("change", () => {
    dirty = JSON.stringify(formSettings()) !== savedForm;
    settingsStatus();
  });
}
$("reset-settings").addEventListener("click", hydrateSettings);
$("settings-link").addEventListener("click", () => reveal("settings"));
$("logs-link").addEventListener("click", () => reveal("logs"));
$("filter-unread").addEventListener("click", () => {
  view = "unread";
  limit = 50;
  renderFeed();
});
$("filter-all").addEventListener("click", () => {
  view = "all";
  limit = 50;
  renderFeed();
});
for (const id of ["filter-unread", "filter-all"])
  $(id).addEventListener("keydown", (event) => {
    const e = event as KeyboardEvent;
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      const target =
        e.key === "Home"
          ? "filter-unread"
          : e.key === "End"
            ? "filter-all"
            : id === "filter-unread"
              ? "filter-all"
              : "filter-unread";
      $(target).click();
      $(target).focus();
    }
  });
$("search").addEventListener("input", () => {
  query = $<HTMLInputElement>("search").value.trim().toLocaleLowerCase();
  limit = 50;
  renderFeed();
});
$("more").addEventListener("click", () => {
  limit += 50;
  renderFeed();
});
$("page-index").addEventListener("toggle", () => {
  if ($<HTMLDetailsElement>("page-index").open) renderPages();
});
bind("read-all", async () => {
  await markRead(
    matchingUpdates()
      .filter((u) => !u.read)
      .map((u) => u.id),
  );
  msg(query ? "筛选结果已标为已读。" : "已全部标为已读。", true);
});
bind("grant", async () => {
  const granted = await chrome.permissions.request({
    origins: ["https://app.notion.com/*"],
  });
  msg(
    granted ? "已连接 Notion，可以开始检查。" : "尚未授权，页面内容未被读取。",
    granted,
  );
  await refresh();
});
bind("save", async () => {
  const desired = formSettings();
  if (!pageRef(desired.root))
    throw Error("请输入 https://app.notion.com 的页面或数据库地址。");
  const permissions: ("notifications" | "tabGroups")[] = [];
  if (desired.notify) permissions.push("notifications");
  if (desired.collapseTabs) permissions.push("tabGroups");
  if (
    permissions.length &&
    !(await chrome.permissions.request({ permissions }))
  )
    throw Error("相关权限未获授予，请取消对应选项或重新授权。");
  await send("save", { settings: desired });
  dirty = false;
  loaded = false;
  msg("订阅设置已保存。", true);
  await refresh();
});
bind("single", async () => {
  await send("start", { singlePage: true });
  msg("正在检查入口页。", true);
  await refresh();
});
bind("retry", async () => {
  await send("retry");
  msg("正在重试未成功的页面。", true);
  await refresh();
});
bind("start", async () => {
  await send("start");
  await refresh();
});
bind("stop", async () => {
  await send("stop");
  msg("本轮已停止。自动检查若开启，会在下个周期继续。", true);
  await refresh();
});
bind("refresh", refresh);
reveal(location.hash.slice(1));
updateControls();
void refresh().catch((e) => msg(e instanceof Error ? e.message : String(e)));
setInterval(() => {
  void refresh().catch((e) => msg(e instanceof Error ? e.message : String(e)));
}, 5000);
