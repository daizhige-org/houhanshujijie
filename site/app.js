/* 後漢書集解 閱讀前端。無依賴、無構建；數據由 tools/build.py 生成在 data/ 下。
   路由： #/                首頁（卷目）
          #/j/<卷>/<頁>/<段>  閱讀（頁 = 該冊 PDF 頁序，段 = 該頁第幾塊）
          #/s/<檢索詞>         全文檢索 */
(() => {
"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const el = (tag, props, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k in e && k !== "list") e[k] = v;
    else e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid);
  return e;
};
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const wide = () => window.matchMedia("(min-width: 1000px)").matches;

const LS_SET = "hhsjj.settings", LS_LAST = "hhsjj.last";
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 隱私模式 */ } },
};

const S = {
  toc: null,
  byId: new Map(),
  docs: new Map(),
  doc: null,          // 當前卷
  rendered: "",       // 當前已渲染的卷
  curP: null,
  idx: null,          // 檢索索引 Map<卷, [{p,i,t}]>，一行是某頁的一塊
  idxPromise: null,
  vmap: null,         // 字 -> 異體字組
  scan: null,
  set: Object.assign({ fs: 19, theme: "auto", notes: true, side: true, caveat: true, scan: true }, store.get(LS_SET, {})),
};
const main = $("#main");

/* ------------------------------------------------------------ 數據 */

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}：${r.status}`);
  return r.json();
}
async function loadDoc(id) {
  if (!S.docs.has(id)) S.docs.set(id, await getJSON(`data/j/${id}.json`));
  return S.docs.get(id);
}
function loadVariants() {
  // 記住的是 Promise：啟動時就開始載入，稍後的調用者要等它真正載完
  S.vmapPromise ??= (async () => {
    const map = new Map();
    try {
      for (const g of await getJSON("data/variants.json")) for (const c of g) map.set(c, g);
    } catch { /* 沒有異體表也能檢索，只是不互通 */ }
    S.vmap = map;
  })();
  return S.vmapPromise;
}

/* ------------------------------------------------------------ 路由 */

function parseHash() {
  const [path, query = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const parts = path.split("/").map(decodeURIComponent);
  const q = new URLSearchParams(query).get("q") || "";
  if (parts[0] === "j" && parts[1]) {
    return { view: "j", id: parts[1], p: parts[2] ? +parts[2] : null, s: parts[3] != null ? +parts[3] : null, q };
  }
  if (parts[0] === "s") return { view: "s", q: parts.slice(1).join("/") };
  return { view: "home" };
}

async function route() {
  const r = parseHash();
  closePopover();
  document.body.classList.toggle("is-home", r.view === "home");
  document.body.classList.toggle("is-search", r.view === "s");
  // 掃描圖默認打開；屏幕不夠寬時三欄太擠，目錄先收起（按 T 或點左上角仍可打開）
  const crowded = S.set.scan && innerWidth < 1500;
  setSide(r.view !== "home" && wide() && S.set.side && !crowded, false);
  try {
    if (r.view === "j") await showJuan(r);
    else if (r.view === "s") await showSearch(r.q);
    else showHome();
  } catch (e) {
    console.error(e);
    S.rendered = "";
    main.replaceChildren(el("div", { class: "msg" },
      el("p", { text: "這一頁沒能載入。" }),
      el("p", { text: String(e.message || e) }),
      el("p", {}, el("a", { href: "#/", text: "回到卷目" }))));
  }
}

/* ------------------------------------------------------------ 首頁 */

function showHome() {
  S.doc = null; S.rendered = "home"; closeScan();
  document.title = "後漢書集解";
  $("#where").replaceChildren();
  setProgress(0);
  markCurrentJuan(null);
  setOutline(null);

  const juan = S.toc.juan;
  const pages = juan.reduce((n, j) => n + j.to - j.from + 1, 0);
  const proof = juan.reduce((n, j) => n + j.proof, 0);
  const chars = juan.reduce((n, j) => n + j.chars, 0);
  const last = store.get(LS_LAST, null);
  const lastJ = last && S.byId.get(last.id);

  const parts = [];
  for (const j of juan) {
    if (!parts.length || parts.at(-1).name !== j.part) parts.push({ name: j.part, list: [] });
    parts.at(-1).list.push(j);
  }

  main.replaceChildren(el("div", { class: "home" },
    el("div", { class: "slip" }, "後漢書集解", el("small", { text: "長沙王氏虛受堂刻本" })),
    el("div", { class: "home-body" },
      el("p", { class: "lede" },
        "清王先謙撰。彙集惠棟、錢大昕、錢大昭、沈欽韓、周壽昌諸家之說，為范曄《後漢書》和李賢注作集解，凡九十卷；",
        "附司馬彪《續漢志》劉昭注集解三十卷，各卷之後有黃山《校補》。",
        "這裡按原書分頁排印維基文庫的整理本：大字是正文，小字是注和集解；點頁碼看掃描原圖。"),
      lastJ && el("a", { class: "resume", href: `#/j/${last.id}/${last.p}` },
        `接著讀 ${lastJ.label}`, el("span", { text: `第 ${last.p} 頁` })),
      el("ul", { class: "eras", "aria-label": "按部類跳轉" },
        parts.map((e, i) => el("li", {}, el("a", { href: `#part-${i}`, text: e.name, onclick: (ev) => {
          ev.preventDefault(); $(`#part-${i}`).scrollIntoView({ behavior: "smooth" });
        } })))),
      parts.map((e, i) => el("section", { class: "era", id: `part-${i}` },
        el("h2", {}, e.name, el("small", { text: `${e.list.length} ${e.name === "卷首" ? "篇" : "卷"}` })),
        e.list.map((j) => el("a", { href: `#/j/${j.id}` },
          el("b", { text: j.label }),
          el("span", { class: "d", text: j.desc }),
          el("span", { class: "m" }, `第 ${j.vol} 冊　${j.to - j.from + 1} 頁`,
            j.proof ? el("span", { class: "ok", text: `　已校 ${j.proof}` }) : null))))),
      el("div", { class: "about" },
        el("h2", { text: "文本來源與可靠程度" },),
        el("p", {},
          "卷次與文字取自", el("a", { href: "https://zh.wikisource.org/wiki/" + encodeURIComponent(S.toc.work), target: "_blank", rel: "noopener", text: "維基文庫《後漢書集解》" }),
          `的整理本（底稿於 ${S.toc.imported} 導入），底本是慶應義塾大學圖書館藏長沙王氏虛受堂刻本，乙卯（1915）開雕，癸亥（1924 年初）畢工。`,
          `全書 ${pages.toLocaleString()} 頁中只有 ${proof} 頁已對照原圖校對（頁碼旁標「校」）；`,
          "其餘頁面是把電子文本按頁對位而成的初稿，錯字、脫文、斷句和分頁錯位都可能有，引用前請核對掃描原圖。",
          "卷首各篇和一部分卷原文沒有句讀。",
          `全書約 ${Math.round(chars / 10000)} 萬字。`),
        el("p", {},
          el("a", { href: "full-site-download.zip", download: "", text: "下載整站離線包（zip）" }),
          "，內含本站全部頁面和各卷正文的數據，解壓後按包內 README.txt 的說明即可離線閱讀；掃描原圖不在包內。"),
        el("h2", { text: "版權說明", style: "margin-top:18px" }),
        el("p", { text: "《後漢書集解》原書（王先謙集解，黃山校補，1915–1924 年刻）已進入公有領域。掃描圖為慶應義塾大學圖書館藏本，載於維基共享資源。" }),
        el("p", {}, "本站文本的底稿由殆知閣整理並上傳至維基文庫，依維基文庫的 ",
          el("a", { href: "https://creativecommons.org/licenses/by-sa/4.0/deed.zh-hant", target: "_blank", rel: "noopener", text: "CC BY-SA 4.0" }),
          " 協議發佈；維基文庫用戶其後所作的修訂同樣依該協議授權。原書文字屬公有領域的部分，殆知閣不主張任何版權，CC BY-SA 僅及於整理、校訂中可能產生權利的部分。"),
        el("p", {}, "網站本身（程序與界面設計）版權歸殆知閣所有，依 GNU Affero 通用公共許可證第 3 版或其後版本（AGPL-3.0-or-later）發佈，",
          el("a", { href: "https://github.com/daizhige-org/houhanshujijie", target: "_blank", rel: "noopener", text: "源代碼在 GitHub" }), "。")))));
  window.scrollTo(0, 0);
}

/* ------------------------------------------------------------ 閱讀 */

const segKey = (p, i) => `${p}-${i}`;
const PROOFREAD = 3; // 維基文庫校對等級：3 已校對，4 已核對
const BLOCK = { h: "wh", c: "wc", r: "wr", p: "wp", l1: "wl l1", l2: "wl l2", l3: "wl l3" };

const pageTitle = (doc, pg) => `第 ${doc.vol} 冊第 ${pg.p} 頁，` +
  (!pg.b.length ? "空白頁或尚未錄入" : (pg.q || 0) >= PROOFREAD ? "維基文庫已校對" : "尚未校對") +
  (pg.a ? "；底本這一頁掃描有誤，圖換用他本" : "") + "。點按看掃描原圖";

function pageMarker(doc, pg) {
  const cls = "pm" + ((pg.q || 0) >= PROOFREAD && pg.b.length ? " ws" : "") + (pg.b.length ? "" : " blank") + (pg.a ? " alt" : "");
  return el("div", { class: cls, id: "p" + pg.p },
    el("button", { "data-scan": pg.p, text: String(pg.p), title: pageTitle(doc, pg) }));
}

/* 一頁是若干塊，一塊是若干段文字 [文字, 是否小注]。數據只當文本用，不當 HTML 解釋。
   段落跨頁時，下一頁的文字接在上一頁的段落後面，頁碼標在行內。 */
function buildText(doc) {
  const frag = document.createDocumentFragment();
  let open = null; // 上一頁末尾未結束的段落
  for (const pg of doc.pages) {
    if (!pg.b.length) { frag.append(pageMarker(doc, pg)); open = null; continue; }
    pg.b.forEach(([kind, runs], bi) => {
      const part = el("span", { class: "pp", id: "s" + segKey(pg.p, bi) },
        runs.map(([t, note]) => (note ? el("small", { class: "n", text: t }) : t)));
      let para = open;
      if (bi === 0 && pg.c && open) {
        const proof = (pg.q || 0) >= PROOFREAD;
        para.append(el("button", { class: "pmi" + (proof ? " ws" : "") + (pg.a ? " alt" : ""), id: "p" + pg.p, "data-scan": pg.p,
          text: String(pg.p), title: pageTitle(doc, pg) }), part);
      } else {
        if (bi === 0) frag.append(pageMarker(doc, pg));
        para = el(kind === "h" ? "h3" : "p", { class: BLOCK[kind] || "wp" }, part);
        frag.append(para);
      }
      open = kind === "p" ? para : null;
    });
  }
  return frag;
}

async function showJuan(r) {
  const meta = S.byId.get(r.id);
  if (!meta) throw new Error(`沒有「${r.id}」這一卷`);
  if (S.rendered !== r.id) {
    // 先放下舊卷的狀態：載入期間的滾動事件不該再按舊卷改寫地址
    S.doc = null; S.markers = []; S.curP = null;
    main.replaceChildren(el("div", { class: "msg", text: `正在載入${meta.label}…` }));
    closeScan();
    const doc = await loadDoc(r.id);
    if (parseHash().id !== r.id) return; // 載入期間用戶已經去了別處
    S.doc = doc; S.rendered = r.id; S.curP = null;
    document.title = `${doc.label} ${doc.desc} － 後漢書集解`.replace("  ", " ");

    const wsUrl = `https://zh.wikisource.org/wiki/${encodeURIComponent(S.toc.work + "/" + doc.sub)}`;
    const text = el("div", { class: "text" }, buildText(doc));
    main.replaceChildren(el("article", { class: "col" },
      el("header", { class: "j-head" },
        el("h1", { text: doc.label }),
        doc.desc && el("p", { class: "desc", text: doc.desc }),
        el("p", { class: "meta" }, `第 ${doc.vol} 冊第 ${doc.from}–${doc.to} 頁　`,
          meta.proof ? `已校對 ${meta.proof} 頁　` : "尚未校對　",
          el("a", { href: wsUrl, target: "_blank", rel: "noopener", text: "在維基文庫查看本卷" }))),
      S.set.caveat && el("div", { class: "caveat" },
        el("p", { text: "大字是正文，小字是李賢注和集解；點頁碼看掃描原圖。文本大多還沒有對照原圖校對，引用前請核對。" }),
        el("button", { text: "知道了", onclick: (e) => { e.target.closest(".caveat").remove(); saveSet({ caveat: false }); } })),
      text,
      el("nav", { class: "j-foot", "aria-label": "相鄰各卷" },
        doc.prev && el("a", { class: "prev", href: `#/j/${doc.prev.id}` }, el("small", { text: "上一卷" }), el("b", { text: doc.prev.label })),
        doc.next && el("a", { class: "next", href: `#/j/${doc.next.id}` }, el("small", { text: "下一卷" }), el("b", { text: doc.next.label })))));

    markCurrentJuan(r.id);
    setOutline(doc);
    S.markers = $$("[id^='p']", text).filter((e) => /^p\d+$/.test(e.id));
  }

  if (S.set.scan && wide() && !S.scan) openScan(r.p ?? S.doc.from, { auto: true });

  // 定位
  clearMarks();
  let target = null;
  if (r.p != null && r.s != null) target = $(`#s${segKey(r.p, r.s)}`);
  const seg = target;
  if (!target && r.p != null) target = $(`#p${r.p}`);
  if (seg && r.q) {
    // 檢索命中：隱藏注文時命中的字可能看不見，先把注文打開；一段可能很長，滾到第一處命中
    if (!S.set.notes) { saveSet({ notes: true }); applySet(); }
    target = (await markMatches(seg, r.q)) || seg;
    if (parseHash().id !== r.id) return;
  }
  if (target) {
    target.scrollIntoView({ block: target === seg || target.id ? "start" : "center" });
    if (seg) { seg.classList.remove("flash"); void seg.offsetWidth; seg.classList.add("flash"); }
  } else {
    window.scrollTo(0, 0);
  }
  if (r.p != null && target && S.scan) { openScan(r.p, { auto: true }); pinScan(); }
  onScroll();
}

function clearMarks() {
  for (const m of $$("mark", main)) { const p = m.parentNode; m.replaceWith(m.textContent); p.normalize(); }
}
/* 在一塊文字裡標出檢索詞。正文和小注是不同的節點，命中可以跨過它們的邊界，
   所以先把所有文本節點連起來匹配，再按節點切開。返回第一處命中。 */
async function markMatches(node, q) {
  await loadVariants();
  const re = buildRe(q);
  if (!re) return null;
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const texts = [], starts = [];
  let full = "";
  while (walker.nextNode()) { texts.push(walker.currentNode); starts.push(full.length); full += walker.currentNode.nodeValue; }
  const ranges = [...full.matchAll(re)].filter((m) => m[0]).map((m) => [m.index, m.index + m[0].length]);
  let first = null, ri = 0;
  texts.forEach((tn, k) => {
    const t = tn.nodeValue, a0 = starts[k], b0 = a0 + t.length, parts = [];
    let last = 0;
    while (ri < ranges.length && ranges[ri][1] <= a0) ri++;
    for (let i = ri; i < ranges.length && ranges[i][0] < b0; i++) {
      const x = Math.max(ranges[i][0], a0) - a0, y = Math.min(ranges[i][1], b0) - a0;
      if (x > last) parts.push(t.slice(last, x));
      const mark = el("mark", { text: t.slice(x, y) });
      first ??= mark;
      parts.push(mark);
      last = y;
    }
    if (!parts.length) return;
    if (last < t.length) parts.push(t.slice(last));
    tn.replaceWith(...parts);
  });
  return first;
}

/* 點頁碼看掃描原圖 */
main.addEventListener("click", (e) => {
  const scanBtn = e.target.closest("[data-scan]");
  if (scanBtn) { saveSet({ scan: true }); openScan(+scanBtn.dataset.scan); }
});

/* 滾動時更新當前頁、進度、綱目高亮，並記住位置 */
let ticking = false;
function onScroll() {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    ticking = false;
    const doc = S.doc;
    if (!doc || parseHash().view !== "j" || !S.markers?.length) return;
    const line = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) + 40;
    let lo = 0, hi = S.markers.length - 1, cur = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (S.markers[mid].getBoundingClientRect().top <= line) { cur = mid; lo = mid + 1; } else hi = mid - 1;
    }
    const m = S.markers[cur], p = +m.id.slice(1);
    if (p !== S.curP) {
      S.curP = p;
      if (S.scan && wide() && S.scan.p !== p && !pinned()) followScan(p);
      $$(".pm.cur", main).forEach((n) => n.classList.remove("cur"));
      m.classList.add("cur");
      $("#where").replaceChildren(el("b", { text: doc.label }), el("span", { class: "d", text: doc.desc }),
        el("span", { class: "pg", text: `第 ${doc.vol} 冊 ${p} 頁` }));
      store.set(LS_LAST, { id: doc.id, p });
      const r = parseHash();
      if (r.p !== p && (r.p != null || scrollY > 200)) {
        history.replaceState(null, "", `#/j/${doc.id}/${p}`);
      }
    }
    const total = document.documentElement.scrollHeight - innerHeight;
    setProgress(total > 0 ? scrollY / total : 0);
    spyOutline(line);
  });
}
addEventListener("scroll", onScroll, { passive: true });
addEventListener("resize", onScroll, { passive: true });
const setProgress = (f) => { $("#progress").style.width = (f * 100).toFixed(2) + "%"; };

/* ------------------------------------------------------------ 側欄：卷目與綱目 */

function buildJuanList() {
  const pane = $("#pane-juan");
  let part = null;
  for (const j of S.toc.juan) {
    if (j.part !== part) { part = j.part; pane.append(el("h2", { text: part })); }
    pane.append(el("a", { class: "j", href: `#/j/${j.id}`, "data-id": j.id },
      el("b", { text: j.label }), el("span", { text: j.desc })));
  }
}
// 只滾動側欄自己（scrollIntoView 會連帶滾動整個頁面，打斷閱讀位置）
function revealCurrentJuan() {
  const pane = $("#pane-juan"), a = $("a[aria-current]", pane);
  if (!a || pane.hidden) return;
  const r = a.getBoundingClientRect(), pr = pane.getBoundingClientRect();
  if (r.top < pr.top + 40 || r.bottom > pr.bottom - 10) pane.scrollTop += r.top - pr.top - pr.height / 3;
}
function markCurrentJuan(id) {
  for (const a of $$("#pane-juan a.j")) {
    if (a.dataset.id === id) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  revealCurrentJuan();
}
function selectTab(name) {
  for (const n of ["juan", "outline"]) {
    $(`#tab-${n}`).setAttribute("aria-selected", String(n === name));
    $(`#pane-${n}`).hidden = n !== name;
  }
  if (name === "juan") revealCurrentJuan(); else onScroll();
}
$("#tab-juan").onclick = () => selectTab("juan");
$("#tab-outline").onclick = () => selectTab("outline");

let outlineLinks = [];
function setOutline(doc) {
  const list = $("#outline-list"), tab = $("#tab-outline");
  $("#outline-filter").value = "";
  outlineLinks = [];
  tab.disabled = !doc;
  if (!doc) { list.replaceChildren(); selectTab("juan"); return; }
  if (!doc.outline.length) {
    list.replaceChildren(el("p", { class: "none", text: "這一卷沒有綱目。" }));
    selectTab("juan");
    return;
  }
  list.replaceChildren(...doc.outline.map(([lv, title, p, i]) => {
    const a = el("a", { class: "l" + lv, href: `#/j/${doc.id}/${p}` + (i >= 0 ? `/${i}` : ""), text: title });
    const target = (i >= 0 && $(`#s${segKey(p, i)}`)) || $(`#p${p}`);
    outlineLinks.push({ a, target, text: title });
    return a;
  }));
  selectTab("outline");
}
function spyOutline(line) {
  if (!outlineLinks.length || $("#pane-outline").hidden || !document.body.classList.contains("side-open")) return;
  let lo = 0, hi = outlineLinks.length - 1, cur = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, t = outlineLinks[mid].target;
    if (t && t.getBoundingClientRect().top <= line + 60) { cur = mid; lo = mid + 1; } else hi = mid - 1;
  }
  const now = cur >= 0 ? outlineLinks[cur].a : null;
  const old = $("#outline-list a.cur");
  if (old === now) return;
  old?.classList.remove("cur");
  if (now) {
    now.classList.add("cur");
    const pane = $("#pane-outline"), r = now.getBoundingClientRect(), pr = pane.getBoundingClientRect();
    if (r.top < pr.top + 50 || r.bottom > pr.bottom - 20) pane.scrollTop += r.top - pr.top - pr.height / 3;
  }
}
$("#outline-filter").addEventListener("input", (e) => {
  const re = buildRe(e.target.value);
  for (const { a, text } of outlineLinks) a.hidden = !!re && !(re.lastIndex = 0, re.test(text));
});

function setSide(open, remember = true) {
  document.body.classList.toggle("side-open", !!open);
  $("#btn-side").setAttribute("aria-expanded", String(!!open));
  $("#scrim").hidden = !open || wide();
  if (remember && wide() && parseHash().view !== "home") saveSet({ side: !!open });
  if (open) { revealCurrentJuan(); onScroll(); }
}
$("#btn-side").onclick = () => setSide(!document.body.classList.contains("side-open"));
$("#scrim").onclick = () => setSide(false, false);
$("#side").addEventListener("click", (e) => { if (e.target.closest("a") && !wide()) setSide(false, false); });

/* ------------------------------------------------------------ 檢索 */

const GAP = "[^\\p{L}\\p{N}]{0,3}"; // 允許中間夾標點：原書句讀只有「。、」，各卷有無也不一致
function buildRe(q) {
  const chars = [...(q || "")].filter((c) => /[\p{L}\p{N}]/u.test(c));
  if (!chars.length) return null;
  const cls = (c) => {
    const g = S.vmap?.get(c);
    return g ? `[${g}]` : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  };
  return new RegExp(chars.map(cls).join(GAP), "gu");
}

function loadIndex(onProgress) {
  if (S.idx) return Promise.resolve();
  if (!S.idxPromise) {
    const idx = new Map(), queue = S.toc.juan.map((j) => j.id);
    let done = 0;
    const total = queue.length;
    const worker = async () => {
      while (queue.length) {
        const id = queue.shift();
        const text = await (await fetch(`data/s/${id}.txt`)).text();
        idx.set(id, text ? text.split("\n").map((l) => {
          const a = l.indexOf("\t"), b = l.indexOf("\t", a + 1);
          return { p: +l.slice(0, a), i: +l.slice(a + 1, b), t: l.slice(b + 1) };
        }) : []);
        S.onIdxProgress?.(++done / total);
      }
    };
    S.idxPromise = Promise.all([loadVariants(), ...Array.from({ length: 8 }, worker)])
      .then(() => { S.idx = idx; })
      .catch((e) => { S.idxPromise = null; throw e; });
  }
  S.onIdxProgress = onProgress;
  return S.idxPromise;
}

let searchSeq = 0;
async function showSearch(q) {
  const seq = ++searchSeq;
  S.doc = null; S.rendered = "search"; closeScan();
  markCurrentJuan(null); setOutline(null); setProgress(0);
  document.title = `檢索「${q}」－ 後漢書集解`;
  $("#where").replaceChildren(el("b", { text: "全文檢索" }));
  if ($("#q").value !== q && document.activeElement !== $("#q")) $("#q").value = q;

  const info = el("p", { text: q ? "正在載入全書索引…" : "輸入要找的字句，正文、注文一併檢索。繁體、簡體、異體字都能互相匹配，標點可以不管。" });
  const bar = el("div", { class: "s-bar" }, el("i"));
  const jump = el("div", { class: "s-jump" });
  const out = el("div");
  main.replaceChildren(el("div", { class: "col" },
    el("header", { class: "s-head" }, el("h1", { text: q ? `「${q}」` : "全文檢索" }), info, S.idx || !q ? null : bar, jump),
    out));
  window.scrollTo(0, 0);
  if (!q) return;

  await loadIndex((f) => { bar.firstChild.style.width = f * 100 + "%"; });
  if (seq !== searchSeq) return;
  bar.remove();

  const re = buildRe(q);
  if (!re) { info.textContent = "檢索詞裡沒有可以查找的文字。"; return; }
  const groups = [];
  let lines = 0, hits = 0;
  for (const j of S.toc.juan) {
    const g = [];
    for (const row of S.idx.get(j.id) || []) {
      re.lastIndex = 0;
      const m = re.exec(row.t);
      if (!m) continue;
      let n = 1;
      while (re.exec(row.t)) n++;
      hits += n;
      g.push({ row, at: m.index, len: m[0].length });
    }
    if (g.length) { groups.push({ j, g }); lines += g.length; }
  }
  if (!lines) {
    info.textContent = "全書沒有找到。可以試試縮短檢索詞；底稿裡的錯字也可能讓原文對不上。";
    return;
  }
  info.textContent = `${groups.length} 卷、${lines.toLocaleString()} 段中出現 ${hits.toLocaleString()} 次。`;

  const BATCH = 300;
  let gi = 0, shown = 0;
  const more = el("button", { class: "more", text: "顯示更多" });
  const snippet = ({ row, at, len }) => {
    const t = row.t;
    let a = Math.max(0, at - 26), b = Math.min(t.length, at + len + 44);
    if (a > 0 && t.charCodeAt(a) >= 0xdc00 && t.charCodeAt(a) <= 0xdfff) a--;
    if (b < t.length && t.charCodeAt(b) >= 0xdc00 && t.charCodeAt(b) <= 0xdfff) b++;
    re.lastIndex = 0;
    return (a > 0 ? "…" : "") + esc(t.slice(a, b)).replace(re, (m) => `<mark>${m}</mark>`) + (b < t.length ? "…" : "");
  };
  const renderMore = (untilGroup = -1) => {
    const stop = shown + BATCH;
    while (gi < groups.length && (shown < stop || gi <= untilGroup)) {
      const { j, g } = groups[gi];
      out.append(el("section", { class: "s-group", id: `g-${j.id}` },
        el("h2", {}, el("a", { href: `#/j/${j.id}`, text: j.label, style: "color:inherit;text-decoration:none" }),
          el("small", { text: `${j.desc}　${g.length} 段` })),
        g.map((h) => {
          const a = el("a", { class: "s-hit", href: `#/j/${j.id}/${h.row.p}/${h.row.i}?q=${encodeURIComponent(q)}` });
          a.innerHTML = `<span>${snippet(h)}</span><span class="at">${h.row.p} 頁</span>`;
          return a;
        })));
      shown += g.length; gi++;
    }
    more.hidden = gi >= groups.length;
    more.textContent = `顯示更多（還有 ${(lines - shown).toLocaleString()} 段）`;
  };
  more.onclick = () => renderMore();
  if (groups.length > 1) {
    // 命中的卷很多時按紀、列傳、志歸併，免得跳轉鏈接本身成了一堵牆
    const chips = [];
    groups.forEach(({ j, g }, k) => {
      const name = groups.length > 24 ? j.part : j.label;
      if (chips.at(-1)?.name === name) chips.at(-1).n += g.length;
      else chips.push({ name, n: g.length, k, id: j.id });
    });
    jump.replaceChildren(...chips.map((c) => el("a", {
      href: `#g-${c.id}`, text: `${c.name} ${c.n}`,
      onclick: (e) => { e.preventDefault(); renderMore(c.k); $(`#g-${c.id}`).scrollIntoView(); },
    })));
  }
  renderMore();
  main.firstChild.append(more);
}

let typing = 0;
$("#q").addEventListener("input", (e) => {
  clearTimeout(typing);
  typing = setTimeout(() => {
    const q = e.target.value.trim();
    if (parseHash().view === "s") { history.replaceState(null, "", "#/s/" + encodeURIComponent(q)); showSearch(q); }
    else if (q) location.hash = "#/s/" + encodeURIComponent(q);
  }, 350);
});
$("#search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  clearTimeout(typing);
  const q = $("#q").value.trim(), h = "#/s/" + encodeURIComponent(q);
  if (location.hash !== h) location.hash = h; else showSearch(q);
  if (!wide()) $("#q").blur();
});

/* ------------------------------------------------------------ 掃描原圖 */

let followTimer = 0;
/* 用戶指定了某一頁（點頁碼、在圖上翻頁、打開帶頁碼的鏈接）時把圖「釘」在那一頁，
   直到他自己滾動正文為止。卷末幾頁滾不到頂，不釘住的話圖會被拉回前一頁。 */
let pin = null;
function pinScan() { pin = { y: scrollY }; clearTimeout(followTimer); }
function pinned() {
  if (pin && Math.abs(scrollY - pin.y) > innerHeight * 0.5) pin = null; // 拖動滾動條也算
  return !!pin;
}
for (const type of ["wheel", "touchmove", "keydown"]) {
  addEventListener(type, (e) => {
    if (type !== "keydown" || ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(e.key)) pin = null;
  }, { passive: true });
}
function followScan(p) {
  // 快速滾動時不必每一頁都載入圖片，停下來再換
  clearTimeout(followTimer);
  followTimer = setTimeout(() => { if (S.scan && S.doc && S.curP === p) openScan(p, { auto: true }); }, 220);
}
function openScan(p, { auto = false } = {}) {
  const doc = S.doc;
  if (!doc) return;
  if (!auto) requestAnimationFrame(pinScan); // 等這次定位滾動完成後再記位置
  if (S.scan && S.scan.vol === doc.vol && S.scan.p === p && !$("#scan").hidden) return;
  const prev = S.scan;
  S.scan = { vol: doc.vol, p };
  const pg = doc.pages.find((x) => x.p === p);
  // 底本個別頁掃描有誤，維基文庫的索引頁把它換成他本的頁；圖和鏈接跟著換
  const alt = S.toc.alt?.[doc.vol]?.[p];
  const file = alt || S.toc.files[doc.vol];
  const index = alt ? alt.index : S.toc.index[doc.vol];
  const wsPage = index && `https://zh.wikisource.org/wiki/${encodeURIComponent(`Page:${index}/${alt ? alt.page : p}`)}`;
  $("#scan-title").textContent = `第 ${doc.vol} 冊第 ${p} 頁` + (alt ? "（他本）" : "");
  $("#scan-prev").disabled = p <= 1;
  const count = S.toc.files[doc.vol]?.pagecount;
  $("#scan-next").disabled = count ? p >= count : false;
  const status = pg && pg.q != null ? ["沒有文字", "未校對", "有問題", "已校對", "已核對"][pg.q] || "" : "";
  $("#scan-links").replaceChildren(
    pg ? el("a", { href: `#/j/${doc.id}/${p}`, text: "回到正文這一頁" }) : null,
    wsPage ? el("a", { href: wsPage, target: "_blank", rel: "noopener",
      text: status ? `在維基文庫校對（${status}）` : "在維基文庫查看這一頁" }) : null,
    alt ? el("span", { class: "pnote", text: `底本（慶應本）這一頁掃描有誤，圖換用他本：${alt.index} 第 ${alt.page} 頁。` }) : null);
  const body = $("#scan-body"), panel = $("#scan");
  if (file) {
    // 新圖載入完成前，舊圖留在原處（變淡）並顯示載入動畫，載好再替換
    const img = el("img", { alt: `第 ${doc.vol} 冊第 ${p} 頁掃描圖` });
    const current = () => S.scan && S.scan.vol === doc.vol && S.scan.p === p;
    const show = (node) => {
      if (!current()) return; // 已經翻到別的頁了
      panel.classList.remove("loading");
      body.classList.remove("zoom");
      body.replaceChildren(node);
      body.scrollTop = 0;
    };
    img.onclick = () => body.classList.toggle("zoom");
    img.onload = () => show(img);
    img.onerror = () => show(el("p", { text: "掃描圖沒能載入，可能是網絡不通，或維基共享資源暫時不可用。" }));
    if (!(prev && prev.vol === doc.vol && body.querySelector("img"))) body.replaceChildren();
    panel.classList.add("loading");
    img.src = file.thumb.replace("{p}", alt ? alt.page : p);
  } else {
    panel.classList.remove("loading");
    body.classList.remove("zoom");
    body.replaceChildren(el("p", { text: `沒有第 ${doc.vol} 冊掃描本的地址。重新運行 tools/import_drafts.py 和 build.py 後再試。` }));
  }
  if ($("#scan").hidden) {
    // 版面變窄會讓正文重排：打開後把點的那一頁留在視野裡
    $("#scan").hidden = false;
    document.body.classList.add("scan-open");
    if (wide() && !auto) $(`#p${p}`)?.scrollIntoView({ block: "start" });
  }
  $("#btn-scan").setAttribute("aria-pressed", "true");
}
function closeScan() {
  $("#btn-scan").setAttribute("aria-pressed", "false");
  clearTimeout(followTimer);
  if (!S.scan) return;
  S.scan = null;
  const p = S.doc && S.curP;
  $("#scan").hidden = true;
  document.body.classList.remove("scan-open");
  if (p != null && wide()) $(`#p${p}`)?.scrollIntoView({ block: "start" });
}
// 用戶主動開關才記住偏好；換卷、回首頁時的自動關閉不算
function toggleScan(open = !S.scan) {
  saveSet({ scan: open });
  if (!open) closeScan();
  else if (S.doc) openScan(S.curP ?? S.doc.from);
}
$("#scan-close").onclick = () => toggleScan(false);
$("#btn-scan").onclick = () => toggleScan();
// 在掃描圖上翻頁：正文跟著跳到那一頁；翻出本卷範圍就進入同一冊裡相鄰的卷
function flipScan(step) {
  if (!S.scan || !S.doc) return;
  const p = S.scan.p + step, doc = S.doc;
  if (p >= doc.from && p <= doc.to) {
    openScan(p, { auto: true });
    $(`#p${p}`)?.scrollIntoView({ block: "start" });
    pinScan();
    return;
  }
  const other = S.toc.juan.find((j) => j.vol === doc.vol && p >= j.from && p <= j.to);
  if (other) location.hash = `#/j/${other.id}/${p}`;
  else openScan(p, { auto: true }); // 封面、空白頁等不屬於任何卷，只換圖
}
$("#scan-prev").onclick = () => flipScan(-1);
$("#scan-next").onclick = () => flipScan(1);

/* ------------------------------------------------------------ 設置 */

function saveSet(patch) {
  Object.assign(S.set, patch);
  store.set(LS_SET, S.set);
}
function applySet() {
  const root = document.documentElement;
  if (S.set.theme === "auto") delete root.dataset.theme; else root.dataset.theme = S.set.theme;
  root.style.setProperty("--fs", S.set.fs + "px");
  document.body.classList.toggle("no-notes", !S.set.notes);
  $("#fs-out").textContent = S.set.fs;
  $("#btn-note").setAttribute("aria-pressed", String(!!S.set.notes));
  $("#btn-note").title = S.set.notes ? "隱藏注文，只看正文（N）" : "顯示注文（N）";
  for (const b of $$("#theme-ctl button")) b.setAttribute("aria-pressed", String(b.dataset.theme === S.set.theme));
  for (const b of $$("#note-ctl button")) b.setAttribute("aria-pressed", String(!!+b.dataset.notes === !!S.set.notes));
}
/* 版面會變動的設置：改完後回到原來讀到的那一頁 */
function keepPlace(fn) {
  const p = S.doc && S.curP;
  fn();
  if (p != null) requestAnimationFrame(() => { $(`#p${p}`)?.scrollIntoView({ block: "start" }); onScroll(); });
}
function toggleNotes(v = !S.set.notes) { keepPlace(() => { saveSet({ notes: v }); applySet(); }); }

function closePopover() { $("#settings").hidden = true; $("#btn-set").setAttribute("aria-expanded", "false"); }
$("#btn-set").onclick = (e) => {
  e.stopPropagation();
  const pop = $("#settings");
  pop.hidden = !pop.hidden;
  $("#btn-set").setAttribute("aria-expanded", String(!pop.hidden));
};
document.addEventListener("click", (e) => { if (!e.target.closest("#settings")) closePopover(); });
$("#btn-note").onclick = () => toggleNotes();
$("#settings").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.fs) keepPlace(() => { saveSet({ fs: Math.min(30, Math.max(14, S.set.fs + +b.dataset.fs)) }); applySet(); });
  else if (b.dataset.theme) { saveSet({ theme: b.dataset.theme }); applySet(); }
  else if (b.dataset.notes) toggleNotes(!!+b.dataset.notes);
});

/* ------------------------------------------------------------ 鍵盤 */

addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!$("#settings").hidden) closePopover();
    else if (S.scan) toggleScan(false);
    else if (document.activeElement === $("#q")) $("#q").blur();
    else if (!wide()) setSide(false, false);
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest("input, textarea, select")) return;
  if (e.key === "/") { e.preventDefault(); $("#q").focus(); $("#q").select(); }
  else if (e.key === "n" || e.key === "N") toggleNotes();
  else if (e.key === "t" || e.key === "T") $("#btn-side").click();
  else if ((e.key === "i" || e.key === "I") && S.doc) toggleScan();
  else if (S.doc && e.key === "ArrowLeft" && S.doc.prev) location.hash = `#/j/${S.doc.prev.id}`;
  else if (S.doc && e.key === "ArrowRight" && S.doc.next) location.hash = `#/j/${S.doc.next.id}`;
});

/* ------------------------------------------------------------ 啟動 */

(async () => {
  applySet();
  try {
    S.toc = await getJSON("data/toc.json");
  } catch (e) {
    main.replaceChildren(el("div", { class: "msg" },
      el("p", { text: "沒有找到數據文件。請先在項目根目錄運行 python3 tools/build.py，再用本地服務器打開（python3 -m http.server -d site）。" })));
    return;
  }
  for (const j of S.toc.juan) S.byId.set(j.id, j);
  buildJuanList();
  loadVariants();
  addEventListener("hashchange", route);
  route();
})();
})();
