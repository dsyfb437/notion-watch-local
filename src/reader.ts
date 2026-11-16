import type { Frame } from "./model";
// This function is serialized by chrome.scripting. Keep every helper inside it.
// Only open-menu clicks a strictly allowlisted read-only UI control; no editor events.
export function readDocument(
  action:
    | "inspect"
    | "scroll"
    | "reset-scroll"
    | "open-menu"
    | "close-menu"
    | "metadata"
    | "prepare-metadata"
    | "inspect-step"
    | "peek",
): Frame {
  const observed = Date.now();
  const idOf = (s: string) =>
    s
      .match(
        /([a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i,
      )?.[1]
      ?.replaceAll("-", "")
      .toLowerCase() || null;
  const id = idOf(location.pathname);
  const text = (node: Node): string => {
    if (node.nodeType === 3) return node.textContent || "";
    if (!(node instanceof Element)) return "";
    if (node.tagName === "IMG")
      return node.classList.contains("notion-emoji")
        ? node.getAttribute("alt") || ""
        : "";
    if (node.tagName === "STYLE" || node.tagName === "SCRIPT") return "";
    return [...node.childNodes].map(text).join("");
  };
  const main = document.querySelector("main");
  const heading = main?.querySelector("h1");
  const title =
    text(heading || document.createTextNode(""))
      .replaceAll("\u200b", "")
      .trim() || (heading ? "未命名页面" : "");
  const scroller = main?.querySelector<HTMLElement>(
    ".notion-scroller.vertical",
  );
  const body = main?.querySelector(".notion-page-content");
  const db = !body && !!main?.querySelector(".notion-collection_view-block");
  const documentId = (
    main
      ?.querySelector("h1")
      ?.closest("[data-block-id]")
      ?.getAttribute("data-block-id") || ""
  )
    .replaceAll("-", "")
    .toLowerCase();
  const ready = !!(
    id &&
    documentId === id &&
    main &&
    title &&
    scroller &&
    (body || db) &&
    !main.querySelector('[role="progressbar"]')
  );
  const result: Frame = {
    id,
    documentId: documentId || null,
    title,
    ready,
    children: [],
    warnings: [],
    bottom:
      !!scroller &&
      scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 3,
    position: scroller?.scrollTop || 0,
    height: scroller?.scrollHeight || 0,
    observed,
  };
  if (!ready) {
    result.error =
      documentId && documentId !== id
        ? "目标页面正文仍在切换"
        : "页面未就绪、未登录、无权限或布局不支持";
    return result;
  }
  // Cheap identity probe used while an in-page route change settles; never scrolls.
  if (action === "peek") return result;
  if (action === "reset-scroll") {
    scroller!.scrollTo({ top: 0, behavior: "instant" });
    return result;
  }
  if (action === "scroll") {
    scroller!.scrollBy({
      top: Math.max(150, scroller!.clientHeight * 0.85),
      behavior: "instant",
    });
    return result;
  }
  const openMenu = (): Frame => {
    const structural = [
      ...document.querySelectorAll<HTMLElement>(".notion-topbar-more-button"),
    ].filter(
      (e) =>
        !main!.contains(e) &&
        !e.closest('nav,[role="navigation"],[aria-hidden="true"]'),
    );
    const options = structural.length
      ? structural
      : [
          ...document.querySelectorAll<HTMLElement>(
            'header [role="button"], [role="banner"] [role="button"]',
          ),
        ].filter((e) =>
          ["操作", "Actions"].includes(
            e.getAttribute("aria-label") || text(e).trim(),
          ),
        );
    if (options.length !== 1) {
      result.error = `无法唯一定位页面操作菜单（匹配 ${options.length} 个；原始顶栏 ${document.querySelectorAll(".notion-topbar-more-button").length} 个；页头 ${document.querySelectorAll('header,[role=\"banner\"]').length} 个；${document.visibilityState}）`;
      return result;
    }
    if (options[0].getAttribute("aria-expanded") !== "true") options[0].click();
    return result;
  };
  const readMeta = (): Frame => {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')];
    const labels = dialogs
      .flatMap((el) => [...el.querySelectorAll("div")])
      .filter(
        (el) =>
          el.children.length === 0 &&
          ["上次编辑日期", "Last edited by", "Last edited"].includes(
            text(el).trim(),
          ),
      );
    if (labels.length !== 1) {
      result.error = "未找到最近编辑信息";
      return result;
    }
    const values = labels[0].nextElementSibling;
    const author = values?.children[0],
      time = values?.children[1];
    result.author = author ? (author.textContent || "").trim() : "";
    result.rawTime = time ? text(time).trim() : "";
    if (!result.author || !result.rawTime)
      result.error = "最近编辑者或时间字段不完整";
    return result;
  };
  const closeMenu = (): Frame => {
    const options = [
      ...document.querySelectorAll<HTMLElement>(".notion-topbar-more-button"),
    ].filter(
      (e) =>
        !main!.contains(e) &&
        !e.closest('nav,[role="navigation"],[aria-hidden="true"]'),
    );
    if (options[0]?.getAttribute("aria-expanded") === "true")
      options[0].click();
    return result;
  };
  if (action === "open-menu") return openMenu();
  if (action === "close-menu") return closeMenu();
  if (action === "metadata") return readMeta();
  if (action === "prepare-metadata") {
    scroller!.scrollTo({ top: 0, behavior: "instant" });
    const existing = readMeta();
    if (!existing.error && existing.author && existing.rawTime) return existing;
    delete result.error;
    delete result.author;
    delete result.rawTime;
    return openMenu();
  }
  const scope = db ? main! : body!;
  const blocks = [
    ...scope.querySelectorAll(
      db
        ? ".notion-collection-item[data-block-id]"
        : ".notion-page-block[data-block-id]",
    ),
  ];
  const seen = new Set<string>();
  for (const block of blocks) {
    if (db && block.parentElement?.closest(".notion-collection-item")) continue;
    const blockId = (block.getAttribute("data-block-id") || "")
      .replaceAll("-", "")
      .toLowerCase();
    for (const a of block.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      let u: URL;
      try {
        u = new URL(a.getAttribute("href")!, location.href);
      } catch {
        continue;
      }
      const childId = idOf(u.pathname);
      if (
        u.origin !== location.origin ||
        u.username ||
        u.password ||
        u.hash ||
        !childId ||
        childId !== blockId ||
        childId === id ||
        seen.has(childId)
      )
        continue;
      // Collection previews may contain other pages. Match the link's nearest page block.
      if (a.closest(".notion-page-block") !== block) continue;
      const clone = block.cloneNode(true) as Element;
      for (const nested of clone.querySelectorAll(
        '[data-block-id],button,[role="button"],style,script',
      ))
        nested.remove();
      const childTitle =
        text(clone).replaceAll("\u200b", "").trim() || "未命名页面";
      u.hash = "";
      u.search = "";
      seen.add(childId);
      result.children.push({ id: childId, url: u.href, title: childTitle });
    }
  }
  if (scope.querySelector('.notion-toggle-block [aria-expanded="false"]'))
    result.warnings.push("存在折叠内容，子页面发现可能不完整");
  if (body?.querySelector(".notion-collection_view-block"))
    result.warnings.push("含内嵌数据库：仅发现当前已渲染的页面条目");
  if (db) result.warnings.push("数据库仅覆盖当前视图可见的条目；不会更改筛选");
  if (action === "inspect-step" && !result.bottom)
    scroller!.scrollBy({
      top: Math.max(150, scroller!.clientHeight * 0.85),
      behavior: "instant",
    });
  return result;
}
