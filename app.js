// 言えた — 画面の担当。計算は logic.js、同期と通知の本体はサーバーに任せる。

const STORE_KEY = "ieta.v1";
const TOKEN_KEY = "ieta.token";
const PUSH_KEY = "ieta.push";
const GEMINI_URL = "https://gemini.google.com/app";
const REMINDER_FILE = "reminder.ics";
const ONBOARD_KEY = "ieta.onboarded";
const app = document.getElementById("app");

// ---- データの保存 ----
// 2か所に保存する。iPhoneはアプリを閉じたとき、localStorage への書き込みを終える前に
// 止めてしまうことがある。そこで、書き込みの完了を確かめられる IndexedDB にも毎回すぐ保存し、
// 起動時は両方を合わせて読む。
const DATA_DB = "ieta-data";
const DRAFT_KEY = "ieta.draft";
const SNAPSHOT_DB = "ieta-backup";

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    if (saved && Array.isArray(saved.cards)) return { doneDays: [], deleted: {}, ...saved };
  } catch (e) { /* 壊れていたら空から始める */ }
  return { cards: [], doneDays: [], deleted: {} };
}

function openDB(name, storeName) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(storeName);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// 書き込みは、端末に書き終わったことを確かめてから完了にする（durability: "strict"）。
async function useStore(name, storeName, mode, fn) {
  const db = await openDB(name, storeName);
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode, { durability: "strict" });
      const req = fn(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

const dataStore = (mode, fn) => useStore(DATA_DB, "kv", mode, fn);
const snapshotStore = (mode, fn) => useStore(SNAPSHOT_DB, "days", mode, fn);

function save() {
  const text = JSON.stringify(state);
  let quick = true;
  try {
    localStorage.setItem(STORE_KEY, text);
  } catch (e) {
    quick = false;
  }
  if ("indexedDB" in window) {
    dataStore("readwrite", (s) => s.put(JSON.parse(text), "state"))
      .catch(() => { if (!quick) toast("保存できませんでした"); });
  } else if (!quick) {
    toast("保存できませんでした");
  }
  scheduleSnapshot();
}

// 起動時に、2か所の保存と自動の控えから、データを取り戻す。
async function recover() {
  if (!("indexedDB" in window)) return;
  const before = JSON.stringify(state);
  try {
    const stored = await dataStore("readonly", (s) => s.get("state"));
    if (stored && Array.isArray(stored.cards)) {
      state = Logic.merge(state, { deleted: {}, doneDays: [], ...stored });
    }
  } catch (e) { /* 読めなければ、手元の分だけで続ける */ }
  // 本体が空なのに控えが残っていれば、確認せずに戻す。
  if (state.cards.length === 0) {
    const [latest] = await listSnapshots();
    if (latest && latest.state.cards.length > 0) {
      state = Logic.merge(state, { deleted: {}, doneDays: [], ...latest.state });
      toast("前回のデータを戻しました");
    }
  }
  if (JSON.stringify(state) !== before) {
    save();
    if (onHome) renderHome();
  }
}

// 貼り付けの途中の文章。Geminiへ切り替えている間にアプリが閉じても残す。
function loadDraft() {
  try {
    return { transcript: "", reply: "", ...JSON.parse(localStorage.getItem(DRAFT_KEY)) };
  } catch (e) {
    return { transcript: "", reply: "" };
  }
}

function saveDraft(draft) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch (e) { /* 下書きは失っても大きな問題ではない */ }
  if ("indexedDB" in window) dataStore("readwrite", (s) => s.put(draft, "draft")).catch(() => {});
}

async function loadDraftDurable() {
  try {
    return (await dataStore("readonly", (s) => s.get("draft"))) || null;
  } catch (e) {
    return null;
  }
}

// ---- 自動バックアップ（アプリの中に、日ごとの控えを残す） ----
// 本体のデータとは別の保存場所に置く。操作ミスや不具合で消えたときに戻せる。
async function writeSnapshot() {
  clearTimeout(snapshotTimer);
  // 空の状態で上書きすると、戻したい控えを失うので残さない。
  if (!("indexedDB" in window) || state.cards.length === 0) return;
  try {
    const date = Logic.today();
    const copy = JSON.parse(JSON.stringify(state));
    await snapshotStore("readwrite", (s) => s.put({ date, savedAt: Date.now(), state: copy }, date));
    const old = Logic.oldSnapshots(await snapshotStore("readonly", (s) => s.getAllKeys()));
    if (old.length > 0) await snapshotStore("readwrite", (s) => { old.forEach((d) => s.delete(d)); });
  } catch (e) { /* 控えが作れなくても、本体のデータは保存済み */ }
}

let snapshotTimer;
function scheduleSnapshot() {
  clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(writeSnapshot, 1000);
}

async function listSnapshots() {
  if (!("indexedDB" in window)) return [];
  try {
    const all = await snapshotStore("readonly", (s) => s.getAll());
    return all.sort((a, b) => b.date.localeCompare(a.date));
  } catch (e) {
    return [];
  }
}

// iPhoneで、ホーム画面のアイコンではなくSafariで開いているか。データの保存場所が別になる。
const inSafariTab = /iPhone|iPad/.test(navigator.userAgent) && navigator.standalone === false;

function getLocal(key) {
  try {
    return localStorage.getItem(key) || "";
  } catch (e) {
    return "";
  }
}

function setLocal(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch (e) { /* 保存できない環境 */ }
}

// この端末の通知の鍵。サーバーが端末ごとに発行する。消えないよう2か所に保存する。
const getToken = () => getLocal(TOKEN_KEY);
function setToken(key) {
  setLocal(TOKEN_KEY, key);
  if ("indexedDB" in window) dataStore("readwrite", (s) => s.put(key, "token")).catch(() => {});
}

async function recoverToken() {
  if (getToken() || !("indexedDB" in window)) return;
  try {
    const key = await dataStore("readonly", (s) => s.get("token"));
    if (key) setLocal(TOKEN_KEY, key);
  } catch (e) { /* なければ、通知をオンにし直せばよい */ }
}

let state = load();

function markDone() {
  const date = Logic.today();
  if (!state.doneDays.includes(date)) {
    state.doneDays.push(date);
    save();
  }
}

// ---- サーバーとのやりとり ----
async function api(path, options = {}) {
  const token = getToken();
  const res = await fetch(`${API_BASE}/api/${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "サーバーにつながりませんでした");
  return body;
}

// 通知サーバーにつながるときだけ、通知を使う。つながらなければカレンダーで代わりにする。
let hasServer = false;
async function detectServer() {
  try {
    const res = await fetch(`${API_BASE}/api/health`, { cache: "no-store" });
    hasServer = res.ok && (await res.json()).ok === true;
  } catch (e) {
    hasServer = false;
  }
}

// 通知を送るかの判断のために、練習した日と出題日だけをサーバーへ知らせる。
// カードの文章はiPhoneの外に出さない。失敗しても、アプリの動きには影響しない。
async function sync() {
  if (!hasServer || !getToken()) return;
  try {
    await api("status", { method: "POST", body: JSON.stringify(Logic.statusForServer(state, Logic.today())) });
  } catch (e) { /* オフラインなど。次の機会にまた送る */ }
}

// ---- 部品 ----
// 入力された文字は必ず textContent で入れる（HTMLとして解釈させない）。
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "class") el.className = value;
    else if (key === "value") el.value = value;
    else el.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child !== null && child !== undefined) el.append(child);
  }
  return el;
}

// SVG（炎や円のグラフ）を作る。HTMLとは作り方が違う。
function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  for (const child of children) el.append(child);
  return el;
}

const ICONS = {
  home: "M3.5 10.5L12 4l8.5 6.5V20a1 1 0 0 1-1 1H15v-6H9v6H4.5a1 1 0 0 1-1-1z",
  paste: "M9 3.5h6v3H9zM7.5 5H5.5v15.5h13V5h-2M8.5 11.5h7M8.5 15.5h4.5",
  book: "M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5zM5 19.5A1.5 1.5 0 0 0 6.5 21H19M9 7.5h6",
  gear: "M12 8.8a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4zM12 2.5v2.6M12 18.9v2.6M2.5 12h2.6M18.9 12h2.6M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8",
  bolt: "M13.5 2L4.5 13.5h6.5l-1 8.5 9-11.5h-6.5z",
  flame: "M12 2c1 3.2-.6 5-2.2 6.7C8.2 10.4 6.5 12.2 6.5 15a5.5 5.5 0 0 0 11 0c0-2.1-.9-3.7-2-5 .1 1.6-.5 2.8-1.6 3.4.4-2.9-.6-6.6-1.9-11.4z",
  check: "M5 12.5l4.5 4.5L19 7.5",
  close: "M6 6l12 12M18 6L6 18",
  sound: "M4 9.5h3.5L12 5.5v13l-4.5-4H4zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11",
};

function icon(name, cls = "icon") {
  const filled = name === "flame" || name === "bolt";
  return svg("svg", { class: cls, viewBox: "0 0 24 24", "aria-hidden": "true" },
    svg("path", filled
      ? { d: ICONS[name], fill: "currentColor" }
      : { d: ICONS[name], fill: "none", stroke: "currentColor", "stroke-width": "2.2", "stroke-linecap": "round", "stroke-linejoin": "round" }));
}

// 今日の進み具合の円。part / whole を塗る。
function ring(part, whole, ...center) {
  const r = 54;
  const length = 2 * Math.PI * r;
  const ratio = whole > 0 ? part / whole : 1;
  return h("div", { class: "ring" },
    svg("svg", { viewBox: "0 0 128 128", "aria-hidden": "true" },
      svg("defs", {},
        svg("linearGradient", { id: "fire", x1: "0", y1: "0", x2: "1", y2: "1" },
          svg("stop", { offset: "0", "stop-color": "#ffb23f" }),
          svg("stop", { offset: "0.5", "stop-color": "#ff6a2c" }),
          svg("stop", { offset: "1", "stop-color": "#ff3d77" })),
        svg("linearGradient", { id: "fresh", x1: "0", y1: "0", x2: "1", y2: "1" },
          svg("stop", { offset: "0", "stop-color": "#2ee59d" }),
          svg("stop", { offset: "1", "stop-color": "#12c2e9" }))),
      svg("circle", { class: "ring-track", cx: "64", cy: "64", r: String(r) }),
      svg("circle", {
        class: `ring-fill${ratio >= 1 ? " full" : ""}${ratio <= 0 ? " empty" : ""}`,
        cx: "64", cy: "64", r: String(r),
        "stroke-dasharray": `${length * ratio} ${length}`,
        transform: "rotate(-90 64 64)",
      })),
    h("div", { class: "ring-center" }, ...center));
}

let onHome = false;
function show(...nodes) {
  onHome = false;
  app.classList.remove("wide");
  app.classList.toggle("with-tabs", nodes.some((n) => n && n.classList && n.classList.contains("tabbar")));
  document.onkeydown = null;
  app.replaceChildren(...nodes.filter(Boolean));
  window.scrollTo(0, 0);
}

// 画面の下のタブ。ホーム・貼る・単語帳・設定を1タップで切り替える。
function tabBar(active) {
  const waiting = state.cards.filter((c) => !Logic.isReady(c)).length;
  const tab = (id, key, name, label, onclick, badge) => h("button", {
    class: `tab${active === key ? " on" : ""}`,
    id,
    "aria-current": active === key ? "page" : "false",
    onclick,
  }, icon(name), h("span", {}, label), badge ? h("span", { class: "badge" }, String(badge)) : null);
  return h("nav", { class: "tabbar", "aria-label": "メニュー" },
    tab("tab-home", "home", "home", "ホーム", renderHome),
    tab("paste", "paste", "paste", "貼る", renderPaste),
    tab("list", "list", "book", "単語帳", () => renderList(waiting > 0 ? "todo" : "all"), waiting),
    tab("settings", "settings", "gear", "設定", renderSettings));
}

function greeting() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 11) return "おはようございます";
  if (hour >= 11 && hour < 18) return "こんにちは";
  return "こんばんは";
}

function levelCard(lv, ratio = lv.into / lv.need) {
  const fill = h("i");
  fill.style.width = `${Math.round(ratio * 100)}%`;
  return h("div", { class: "level glass" },
    h("span", { class: "lv" }, icon("bolt", "icon small"), `Lv.${lv.level}`),
    h("div", { class: "xpbar" }, fill),
    h("span", { class: "xp" }, `${lv.into}/${lv.need} XP`));
}

function topBar(title, back = renderHome) {
  return h("div", { class: "bar-top" },
    h("button", { class: "link", id: "back", onclick: () => back() }, "戻る"),
    h("h1", {}, title),
    h("span", { class: "spacer" }));
}

let toastTimer;
function toast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

function speak(text) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-US";
  speechSynthesis.speak(u);
}

// ---- ホーム ----
function renderHome() {
  const date = Logic.today();
  const queue = Logic.buildQueue(state.cards, date);
  const ready = state.cards.filter(Logic.isReady).length;

  // 今日やる分がない日は、開いただけで達成にする（やることがない日に連続を切らない）。
  if (ready > 0 && queue.length === 0) markDone();
  const days = Logic.streak(state.doneDays, date);
  const stats = Logic.progress(state.cards, date);

  let title = "今日の英語、始めよう。";
  if (state.cards.length === 0) title = "最初の1枚を作ろう。";
  else if (queue.length === 0) title = "今日はクリア！";
  else if (stats.doneToday > 0) title = "あと少し、いける。";

  const header = h("div", { class: "home-top" },
    h("div", { class: "greet" }, h("small", {}, greeting()), h("strong", {}, title)),
    h("div", { class: `streak-chip${days > 0 ? "" : " off"}` }, icon("flame"), h("span", {}, days > 0 ? `${days}日連続` : "0日")));

  const start = h("button", { class: "btn primary", id: "start", onclick: () => startSession(queue) }, "始める");
  const pasteCta = h("button", { class: "btn primary", id: "paste-cta", onclick: renderPaste }, "英会話の記録を貼る");

  let hero;
  if (state.cards.length === 0) {
    hero = h("div", { class: "hero-card glass" },
      h("div", { class: "welcome" }, icon("flame", "icon big")),
      h("p", { class: "hero-text" }, "言えなかった一言を、", h("br"), "明日には言えるようにする。"),
      h("p", { class: "hero-sub" }, "英会話の記録を貼るところから。"),
      pasteCta);
  } else if (queue.length > 0) {
    hero = h("div", { class: "hero-card glass" },
      ring(stats.doneToday, stats.doneToday + queue.length,
        h("div", { class: "count" }, String(queue.length)),
        h("div", { class: "count-label" }, "今日の分")),
      h("p", { class: "hero-sub" }, `約${Math.max(1, Math.round(queue.length * 0.25))}分。頭の中で英文を作ろう。`),
      start);
  } else {
    hero = h("div", { class: "hero-card glass" },
      ring(1, 1, h("div", { class: "ring-check" }, icon("check", "icon big"))),
      h("p", { class: "hero-text" }, "今日の分は終わりです。"),
      h("p", { class: "hero-sub" }, ready > 0 ? "また明日。次の英会話の記録も貼っておこう。" : "英語を入れると練習に出ます。"),
      h("button", { class: "btn secondary", id: "paste-cta", onclick: renderPaste }, "英会話の記録を貼る"));
  }

  const week = h("div", { class: "week glass", "aria-label": "直近7日の記録" }, Logic.week(state.doneDays, date).map((d) =>
    h("div", { class: `day${d.done ? " done" : ""}${d.today ? " today" : ""}` },
      h("span", { class: "dot" }, d.done ? icon("flame", "icon small") : null),
      h("span", { class: "label" }, d.label))));

  const tiles = state.cards.length > 0
    ? h("div", { class: "tiles" },
      h("div", { class: "tile glass good" }, h("strong", {}, String(stats.mastered)), h("span", {}, "覚えた")),
      h("div", { class: "tile glass fire" }, h("strong", {}, String(stats.learning)), h("span", {}, "練習中")),
      h("div", { class: "tile glass" }, h("strong", {}, String(stats.fresh)), h("span", {}, "これから")))
    : null;

  show(h("div", { class: "home" },
    inSafariTab
      ? h("p", { class: "warn", id: "safari-warn" }, "Safariで開いています。ホーム画面の「言えた」のアイコンから開いてください。ここで入れたカードは、アイコンから開いたアプリには出ません。")
      : null,
    header,
    state.cards.length > 0 ? levelCard(Logic.level(state.cards)) : null,
    hero,
    week,
    tiles,
    h("div", { class: "quick" },
      h("button", { class: "link", id: "add", onclick: () => renderForm() }, "＋ 1つ手で追加"))),
  tabBar("home"));
  onHome = true;
}

// ---- 最初の案内 ----
function onboarded() {
  try {
    return localStorage.getItem(ONBOARD_KEY) === "1";
  } catch (e) {
    return true;
  }
}

function reminderButton(id, cls = "btn primary") {
  return h("a", { class: cls, id, href: REMINDER_FILE, target: "_blank", rel: "noopener noreferrer" }, "毎晩11時の通知を追加");
}

function renderOnboarding() {
  const finish = () => {
    try {
      localStorage.setItem(ONBOARD_KEY, "1");
    } catch (e) { /* 次に開いたときにもう一度出るだけ */ }
    renderHome();
  };
  const notify = hasServer
    ? h("button", { class: "btn primary", id: "enable-push" }, "通知をオンにする")
    : reminderButton("add-reminder");
  const notifyStep = h("div", { class: "step glass", id: "step-notify" },
    h("span", { class: "step-no" }, "2"),
    h("div", {},
      h("h2", {}, "毎晩11時に通知を受け取る"),
      h("p", {}, hasServer
        ? "その日の練習が終わっていないときだけ、23時に届きます。やった日は届きません。"
        : "カレンダーに毎日の予定を入れます。開いた画面で「追加」を押すと、毎晩23時に届きます。"),
      notify));
  notify.addEventListener("click", async () => {
    if (!hasServer) {
      notifyStep.classList.add("done");
      return;
    }
    if (await enablePush(23)) {
      notifyStep.classList.add("done");
      notify.textContent = "オンになりました";
    }
  });

  show(h("div", { class: "onboard" },
    h("div", { class: "hero-card glass" },
      h("div", { class: "welcome" }, icon("flame", "icon big")),
      h("p", { class: "hero-text" }, "言えなかった一言を、", h("br"), "明日には言えるようにする。"),
      h("p", { class: "hero-sub" }, "はじめに、2つだけ設定します。")),
    h("div", { class: "steps" },
      h("div", { class: `step glass${inSafariTab ? "" : " done"}` },
        h("span", { class: "step-no" }, "1"),
        h("div", {},
          h("h2", {}, "ホーム画面から開く"),
          h("p", {}, inSafariTab
            ? "いまはSafariで開いています。共有ボタン →「ホーム画面に追加」で追加し、アイコンから開き直してください。"
            : "OK。ホーム画面のアプリとして開いています。"))),
      notifyStep),
    h("button", { class: "btn secondary", id: "onboard-done", onclick: finish }, "はじめる")));
}

// ---- 会話を貼る → Geminiの答えからカードを作る ----
// iPhoneはアプリを切り替えると画面が閉じることがあるので、2つの手順を同じ画面に置く。
function renderPaste() {
  const transcript = h("textarea", {
    class: "paste",
    id: "transcript",
    lang: "en",
    autocapitalize: "off",
    placeholder: "Teacher: How was your weekend?\nMe: I go to mountain with my friend...",
    "aria-label": "英会話の記録",
  });
  const reply = h("textarea", {
    class: "paste",
    id: "reply",
    autocapitalize: "off",
    placeholder: "Geminiの答えをここに貼る",
    "aria-label": "Geminiの答え",
  });

  const draft = loadDraft();
  transcript.value = draft.transcript;
  reply.value = draft.reply;
  const keepDraft = () => saveDraft({ transcript: transcript.value, reply: reply.value });
  transcript.addEventListener("input", keepDraft);
  reply.addEventListener("input", keepDraft);
  // localStorage が消えていても、もう1か所に残っていれば戻す。
  if (!draft.transcript && !draft.reply) {
    loadDraftDurable().then((d) => {
      if (d && !transcript.value && !reply.value) {
        transcript.value = d.transcript || "";
        reply.value = d.reply || "";
      }
    });
  }

  const copyPrompt = async () => {
    if (!transcript.value.trim()) {
      toast("記録を貼ってください");
      return;
    }
    const prompt = Logic.buildPrompt(transcript.value.trim());
    try {
      await navigator.clipboard.writeText(prompt);
      toast("コピーしました。Geminiに貼って送信してください");
    } catch (e) {
      // 自動コピーできない環境では、依頼文を見せて手でコピーしてもらう。
      transcript.value = prompt;
      transcript.select();
      toast("自動でコピーできませんでした。この文をコピーしてください");
    }
  };

  const makeCards = () => {
    try {
      const result = Logic.parseReply(reply.value);
      const date = Logic.today();
      const added = Logic.pickNew(state.cards, result.cards).map((d) => Logic.newCard(d, date));
      state.cards.push(...added);
      save();
      saveDraft({ transcript: "", reply: "" });
      sync();
      renderResult(result, added);
    } catch (e) {
      toast(e.message);
    }
  };

  show(h("div", {},
    topBar("記録を貼る"),
    h("div", { class: "section" },
      h("h2", {}, "1. 記録を貼ってコピー"),
      transcript,
      h("button", { class: "btn secondary", id: "copy", onclick: copyPrompt }, "Gemini用にコピー")),
    h("div", { class: "section" },
      h("h2", {}, "2. Geminiに貼って送信"),
      h("a", { class: "btn secondary", id: "gemini", href: GEMINI_URL, target: "_blank", rel: "noopener noreferrer" }, "Geminiを開く")),
    h("div", { class: "section" },
      h("h2", {}, "3. 答えをコピーして、ここに貼る"),
      reply,
      h("button", { class: "btn primary", id: "make", onclick: makeCards }, "カードにする"))),
  tabBar("paste"));
}

function renderResult(result, added) {
  const removeCard = (card, row) => {
    deleteCard(card);
    added = added.filter((c) => c !== card);
    row.remove();
    heading.textContent = `${added.length}枚 追加しました`;
    sync();
  };

  const heading = h("h1", {}, `${added.length}枚 追加しました`);
  const rows = added.map((card) => {
    const row = h("div", { class: "result glass" },
      card.said ? h("div", { class: "said", lang: "en" }, h("s", {}, card.said)) : null,
      h("div", { class: "en", lang: "en" }, card.en),
      h("div", { class: "ja" }, card.ja),
      card.why ? h("div", { class: "why" }, card.why) : null,
      h("button", { class: "link", onclick: () => removeCard(card, row) }, "このカードは外す"));
    return row;
  });

  show(h("div", {},
    h("div", { class: "bar-top" }, heading),
    result.summary ? h("p", { class: "lead" }, result.summary) : null,
    rows.length === 0 ? h("p", { class: "empty" }, "新しく覚えるものはありませんでした。") : rows,
    h("div", { class: "sticky" },
      h("button", { class: "btn primary", id: "done", onclick: renderHome }, "完了"))));
}

// ---- 練習 ----
function startSession(queue) {
  renderQuestion({ pending: [...queue], total: queue.length, cleared: 0, answered: [], firstOk: 0, combo: 0 });
}

const kindChip = (card) => h("span", { class: `chip ${card.kind}` }, card.kind === "word" ? "単語" : "文");

// 3問続けてできると、コンボを出す。
const comboBadge = (session) => (session.combo >= 3
  ? h("div", { class: "combo", id: "combo" }, icon("flame", "icon small"), `${session.combo}連続！`)
  : null);

function renderQuestion(session) {
  const card = session.pending[0];
  const reveal = () => renderAnswer(session);
  show(h("div", { class: "study" },
    studyTop(session),
    comboBadge(session),
    h("button", { class: "card glass", id: "reveal", onclick: reveal },
      kindChip(card),
      h("div", { class: "q" }, card.ja),
      h("div", { class: "hint" }, "頭の中で英文を作ってから、タップ"))));
  document.onkeydown = (e) => {
    if (e.key === " " || e.key === "Enter") { e.preventDefault(); reveal(); }
  };
}

function renderAnswer(session) {
  const card = session.pending[0];
  const answer = (ok) => gradeCard(session, ok);
  show(h("div", { class: "study" },
    studyTop(session),
    comboBadge(session),
    h("div", { class: "card glass revealed" },
      kindChip(card),
      h("div", { class: "q" }, card.ja),
      h("div", { class: "a", lang: "en" }, card.en),
      h("button", { class: "sound", onclick: () => speak(card.en) }, icon("sound"), "音声を聞く"),
      card.said || card.why || card.example
        ? h("div", { class: "notes" },
          card.said ? h("div", { class: "said", lang: "en" }, h("span", { class: "tag" }, "自分"), h("s", {}, card.said)) : null,
          card.why ? h("div", { class: "why" }, card.why) : null,
          card.example ? h("div", { class: "ex", lang: "en" }, h("span", { class: "tag" }, "例文"), card.example) : null)
        : null),
    h("div", { class: "grade" },
      h("button", { class: "btn secondary", id: "miss", onclick: () => answer(false) }, "まだ"),
      h("button", { class: "btn success", id: "ok", onclick: () => answer(true) }, "☑ できた"))));
  document.onkeydown = (e) => {
    if (e.key === "1") answer(false);
    if (e.key === "2") answer(true);
  };
}

function studyTop(session) {
  const fill = h("i");
  fill.style.width = `${Math.round((session.cleared / session.total) * 100)}%`;
  return h("div", { class: "study-top" },
    h("button", { class: "icon-btn", id: "quit", "aria-label": "やめる", onclick: () => { sync(); renderHome(); } }, icon("close")),
    h("div", { class: "bar" }, fill),
    h("span", { class: "tally" }, `${session.cleared}/${session.total}`));
}

function gradeCard(session, ok) {
  const [card, ...rest] = session.pending;
  const first = !session.answered.includes(card.id);

  // 記憶の計算に入れるのは、その日の最初の答えだけ。やり直しは同じ日の練習として扱う。
  if (first) {
    const updated = Logic.grade(card, ok, Logic.today());
    state.cards = state.cards.map((c) => (c.id === card.id ? updated : c));
    save();
  }

  // 「まだ」のカードは列の最後に回し、できるまで今日のうちに繰り返す。
  const next = {
    ...session,
    pending: ok ? rest : [...rest, card],
    cleared: session.cleared + (ok ? 1 : 0),
    answered: [...session.answered, card.id],
    firstOk: session.firstOk + (first && ok ? 1 : 0),
    combo: ok ? session.combo + 1 : 0,
  };
  if (next.pending.length > 0) renderQuestion(next);
  else finishSession(next);
}

// 紙吹雪。動きを減らす設定の人には出さない。
function confetti() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return null;
  const colors = ["var(--accent)", "var(--good)", "var(--gold)", "var(--sky)"];
  return h("div", { class: "confetti", "aria-hidden": "true" }, Array.from({ length: 28 }, (_, i) => {
    const bit = h("i");
    bit.style.setProperty("--x", `${(i * 37) % 100}%`);
    bit.style.setProperty("--d", `${(i % 7) * 0.12}s`);
    bit.style.setProperty("--r", `${(i * 53) % 360}deg`);
    bit.style.background = colors[i % colors.length];
    return bit;
  }));
}

function finishSession(session) {
  markDone();
  sync();
  const days = Logic.streak(state.doneDays, Logic.today());
  const rate = Math.round((session.firstOk / session.total) * 100);
  const gained = session.total * Logic.XP_PER_REVIEW;
  const after = Logic.level(state.cards);
  const before = Logic.levelFromXp(Math.max(0, after.xp - gained));
  const leveledUp = after.level > before.level;

  // レベルのゲージを、練習前の位置から今の位置まで伸ばす。
  const bar = levelCard(after, leveledUp ? 0 : before.into / before.need);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    bar.querySelector(".xpbar i").style.width = `${Math.round((after.into / after.need) * 100)}%`;
  }));

  show(h("div", { class: "home finish" },
    confetti(),
    h("div", { class: "hero" },
      h("div", { class: "big-flame" }, icon("flame", "icon huge"), h("div", { class: "count" }, String(days))),
      h("div", { class: "count-label" }, "日連続"),
      h("p", { class: "cheer" }, leveledUp ? `レベルアップ！ Lv.${after.level}` : Logic.cheer(days)),
      h("p", { class: "hero-sub" }, `今日は ${session.total} 問、全部できました。`),
      h("span", { class: "gain" }, icon("bolt", "icon small"), `+${gained} XP`)),
    bar,
    h("div", { class: "tiles" },
      h("div", { class: "tile glass" }, h("strong", {}, String(session.total)), h("span", {}, "練習した")),
      h("div", { class: "tile glass good" }, h("strong", {}, `${rate}%`), h("span", {}, "1回でできた"))),
    h("div", { class: "actions" },
      h("button", { class: "btn primary", id: "home", onclick: renderHome }, "閉じる"))));
}

// ---- 追加・編集 ----
function deleteCard(card) {
  state.cards = state.cards.filter((c) => c.id !== card.id);
  state.deleted[card.id] = Date.now();
  save();
}

function renderForm(card = null, returnTo = renderHome) {
  let kind = card ? card.kind : "speak";
  const ja = h("input", { id: "ja", value: card ? card.ja : "", autocomplete: "off", enterkeyhint: "next" });
  const en = h("input", { id: "en", value: card ? card.en : "", lang: "en", autocomplete: "off", autocapitalize: "off", enterkeyhint: "next" });
  const example = h("textarea", { id: "example", lang: "en", autocapitalize: "off" });
  example.value = card ? card.example : "";

  const segButton = (value, label) => h("button", {
    type: "button",
    "aria-pressed": String(kind === value),
    onclick: (e) => {
      kind = value;
      for (const b of e.target.parentNode.children) b.setAttribute("aria-pressed", String(b === e.target));
    },
  }, label);

  const submit = (e) => {
    e.preventDefault();
    if (!ja.value.trim() && !en.value.trim()) {
      toast("日本語か英語を入れてください");
      return;
    }
    if (card) {
      const updated = {
        ...card, ja: ja.value.trim(), en: en.value.trim(), example: example.value.trim(), kind, updatedAt: Date.now(),
      };
      state.cards = state.cards.map((c) => (c.id === card.id ? updated : c));
      save();
      sync();
      returnTo();
      toast("保存しました");
      return;
    }
    const added = Logic.newCard({ ja: ja.value, en: en.value, example: example.value, kind }, Logic.today());
    state.cards.push(added);
    save();
    sync();
    ja.value = "";
    en.value = "";
    example.value = "";
    ja.focus();
    toast(Logic.isReady(added) ? "追加しました" : "英語待ちに入れました");
  };

  const remove = () => {
    if (!confirm("このカードを消しますか？")) return;
    deleteCard(card);
    sync();
    returnTo();
    toast("消しました");
  };

  show(h("div", {},
    topBar(card ? "編集" : "追加", returnTo),
    h("form", { onsubmit: submit },
      h("div", { class: "seg" }, segButton("speak", "言えなかった"), segButton("word", "単語")),
      h("label", {}, "日本語", ja),
      h("label", {}, "英語", en),
      h("p", { class: "note" }, "わからなければ空でOK。英語待ちに入ります。"),
      h("label", {}, "例文（なくてもOK）", example),
      h("button", { class: "btn primary", id: "save", type: "submit" }, card ? "保存" : "追加する")),
    card ? h("button", { class: "btn danger", id: "delete", onclick: remove }, "このカードを消す") : null));
  if (!card) ja.focus();
}

// ---- 単語帳（全カードの表） ----
const KIND_LABELS = { speak: "言えなかった", word: "単語" };
const COLUMNS = [
  ["ja", "日本語"], ["en", "英語"], ["example", "例文"], ["said", "自分の英語"],
  ["why", "直した理由"], ["kind", "種類"], ["createdAt", "追加日"], ["due", "次の復習"],
];

function cellText(card, key) {
  if (key === "kind") return KIND_LABELS[card.kind] || "";
  if (key === "due") return Logic.isReady(card) ? card.due : "";
  return card[key] || "";
}

function renderList(filter = "all", query = "", sort = { key: "createdAt", dir: "desc" }) {
  const filters = [["all", "すべて"], ["speak", "言えなかった"], ["word", "単語"], ["todo", "英語待ち"]];
  const search = h("input", { id: "search", type: "search", placeholder: "全部の列から検索", value: query, "aria-label": "検索" });
  const head = h("tr");
  const body = h("tbody");
  const count = h("span", { id: "count" });

  const fillHead = () => {
    head.replaceChildren(...COLUMNS.map(([key, label]) => {
      const active = sort.key === key;
      const mark = active ? (sort.dir === "asc" ? " ▲" : " ▼") : "";
      return h("th", { scope: "col", "aria-sort": active ? (sort.dir === "asc" ? "ascending" : "descending") : "none" },
        h("button", {
          "data-sort": key,
          onclick: () => {
            sort = { key, dir: active && sort.dir === "asc" ? "desc" : "asc" };
            fillHead();
            fillRows();
          },
        }, label + mark));
    }));
  };

  const fillRows = () => {
    const picked = state.cards.filter((c) => filter === "all"
      || (filter === "todo" ? !Logic.isReady(c) : c.kind === filter));
    // 同じ日に追加したカードは、後から入れたものを上にする。
    const hits = Logic.sortCards(Logic.searchCards(picked, search.value).reverse(), sort.key, sort.dir);
    count.textContent = `${hits.length}件`;
    body.replaceChildren(...hits.map((c) => h("tr", {
      onclick: () => renderForm(c, () => renderList(filter, search.value, sort)),
    }, COLUMNS.map(([key]) => {
      const text = cellText(c, key);
      if (key === "ja") return h("th", { scope: "row" }, h("button", {}, text || "（日本語なし）"));
      if (key === "en" && !text) return h("td", { class: "todo" }, "英語待ち");
      return h("td", { lang: ["en", "example", "said"].includes(key) ? "en" : "ja" }, text);
    }))));
    if (hits.length === 0) {
      body.replaceChildren(h("tr", {}, h("td", { class: "empty", colspan: String(COLUMNS.length) }, "カードはありません")));
    }
  };
  search.addEventListener("input", fillRows);

  show(h("div", { class: "fill" },
    topBar("単語帳"),
    search,
    h("div", { class: "chips" }, filters.map(([value, label]) => h("button", {
      "aria-pressed": String(filter === value),
      onclick: () => renderList(value, search.value, sort),
    }, label)), count),
    h("div", { class: "sheet" }, h("table", {}, h("thead", {}, head), body))),
  tabBar("list"));
  app.classList.add("wide");
  fillHead();
  fillRows();
}

// ---- 設定 ----
function renderSettings() {
  const pushOn = getLocal(PUSH_KEY) !== "";
  const hour = h("select", { id: "hour", "aria-label": "通知の時刻" },
    Array.from({ length: 24 }, (_, i) => h("option", { value: String(i) }, `${i}:00`)));
  hour.value = getLocal(PUSH_KEY) || "23";

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(location.origin + location.pathname);
      toast("コピーしました");
    } catch (e) {
      toast(location.origin + location.pathname);
    }
  };

  const serverSections = [
    h("div", { class: "section" },
      h("h2", {}, "毎日の通知"),
      h("p", {}, "その日の練習が終わっていないときだけ、この時刻に届きます。やった日は届きません（日本時間）。"),
      h("p", { id: "push-state" }, pushOn ? `いまはオンです（${getLocal(PUSH_KEY)}:00）。` : "いまはオフです。"),
      hour,
      h("button", {
        class: "btn primary",
        id: "notify",
        onclick: async () => { if (await enablePush(Number(hour.value))) renderSettings(); },
      }, pushOn ? "時刻を変える" : "通知をオンにする"),
      pushOn ? h("button", { class: "btn secondary", id: "notify-off", onclick: disablePush }, "通知をオフにする") : null),
  ];
  // サーバーがないときは、iPhoneのリマインダーで毎日の通知を代わりにする。
  const reminderSection = h("div", { class: "section" },
    h("h2", {}, "毎日の通知"),
    h("p", {}, "カレンダーに毎晩23時の予定を入れて、通知を届けます。時刻を変えたいときは、カレンダーの予定を開いて変えてください。"),
    reminderButton("add-reminder-settings", "btn secondary"),
    h("p", {}, "リマインダーを使う場合は、アプリのアドレスをURLの欄に貼ってください。"),
    h("button", { class: "btn secondary", id: "copy-url", onclick: copyUrl }, "アプリのアドレスをコピー"));

  const snapshots = h("div", { id: "snapshots", class: "stack" });

  show(h("div", {},
    topBar("設定"),
    hasServer ? serverSections : reminderSection,
    h("div", { class: "section" },
      h("h2", {}, "バックアップ"),
      h("p", {}, "アプリの中に、毎日自動で控えを残しています（14日分）。カードが消えたときは、日付を選んで戻せます。"),
      snapshots),
    h("div", { class: "section" },
      h("h2", {}, "機種変更のとき"),
      h("p", {}, "新しいiPhoneへ移すときだけ使います。"),
      h("button", { class: "btn secondary", id: "export", onclick: exportFile }, "ファイルに書き出す"),
      h("button", { class: "btn secondary", id: "import", onclick: importFile }, "ファイルから読み込む"),
      h("button", { class: "btn secondary", id: "csv", onclick: exportCSV }, "CSVで書き出す"))),
  tabBar("settings"));
  fillSnapshots();
}

function fillSnapshots() {
  listSnapshots().then((list) => {
    if (list.length === 0) {
      snapshots.replaceChildren(h("p", {}, "まだ控えはありません。カードを入れると自動で作られます。"));
      return;
    }
    snapshots.replaceChildren(...list.map((snap) => {
      const [, m, d] = snap.date.split("-").map(Number);
      return h("button", {
        class: "btn secondary",
        "data-snapshot": snap.date,
        onclick: () => {
          if (!confirm(`${m}月${d}日の状態（${snap.state.cards.length}枚）に戻しますか？`)) return;
          state = Logic.restoreSnapshot(state, snap.state, Date.now());
          save();
          sync();
          toast("戻しました");
          renderSettings();
        },
      }, `${m}月${d}日の状態に戻す（${snap.state.cards.length}枚）`);
    }));
  });
}

const base64ToBytes = (s) => {
  const raw = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

// 通知の許可は、本人がボタンを押したときにだけ求める。
async function enablePush(hour) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    toast("iPhoneはホーム画面に追加してから開いてください");
    return false;
  }
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      toast("通知が許可されませんでした。iPhoneの設定 → 通知 から許可できます");
      return false;
    }
    const { publicKey } = await api("push/key");
    const registration = await navigator.serviceWorker.ready;
    const subscription = (await registration.pushManager.getSubscription())
      || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64ToBytes(publicKey) });
    const res = await api("push/subscribe", { method: "POST", body: JSON.stringify({ subscription, hour }) });
    if (res.key) setToken(res.key);
    setLocal(PUSH_KEY, String(hour));
    await sync();
    toast(`練習が残っている日だけ、毎日 ${hour}:00 に通知します`);
    return true;
  } catch (e) {
    toast(e.message || "通知をオンにできませんでした");
    return false;
  }
}

// 通知をやめる。この端末の登録を解除すると、サーバーも次から送らなくなる。
async function disablePush() {
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) await subscription.unsubscribe();
  } catch (e) { /* 解除できなくても、iPhoneの設定から止められる */ }
  setLocal(PUSH_KEY, null);
  toast("通知をオフにしました");
  renderSettings();
}

// ---- バックアップ ----
async function saveFile(name, text, type) {
  const file = new File([text], name, { type });
  // iPhoneのホーム画面アプリではダウンロードが効かないことがあるので、共有シートを優先する。
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
    } catch (e) { /* 共有シートを閉じただけ */ }
    return;
  }
  const url = URL.createObjectURL(file);
  h("a", { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// 機種変更のときだけ使う。ふだんのバックアップはアプリが自動で行う。
function exportFile() {
  saveFile(`ieta-${Logic.today()}.json`, JSON.stringify(state, null, 2), "application/json");
}

function exportCSV() {
  // 先頭のBOMは、Excelで文字化けさせないため。
  saveFile(`ieta-cards-${Logic.today()}.csv`, `﻿${Logic.toCSV(state.cards)}`, "text/csv");
}

function importFile() {
  const input = h("input", { type: "file", accept: ".json,application/json" });
  input.addEventListener("change", async () => {
    try {
      const file = input.files[0];
      if (file.size > 20 * 1024 * 1024) throw new Error("大きすぎます");
      const data = Logic.parseBackup(await file.text(), Logic.today());
      if (!confirm(`ファイルの${data.cards.length}枚を、今のデータに合流させますか？`)) return;
      state = Logic.merge(state, data);
      save();
      sync();
      toast("戻しました");
    } catch (e) {
      toast("読み込めませんでした");
    }
  });
  input.click();
}

// ---- 起動 ----
if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") sync();
  // iPhoneは裏に回ったアプリをすぐ止めることがあるので、その前に控えを残す。
  else writeSnapshot();
});
renderHome();
Promise.all([recover(), recoverToken(), detectServer()]).then(() => {
  if (onHome && !onboarded() && state.cards.length === 0) renderOnboarding();
  else if (onHome) renderHome();
  writeSnapshot();
  sync();
});
window.addEventListener("pagehide", () => {
  save();
  writeSnapshot();
});
