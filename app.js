// 言えた — 画面の担当。計算は logic.js、同期と通知の本体はサーバーに任せる。

const STORE_KEY = "ieta.v1";
const TOKEN_KEY = "ieta.token";
const GEMINI_URL = "https://gemini.google.com/app";
const app = document.getElementById("app");

// ---- データの保存 ----
function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    if (saved && Array.isArray(saved.cards)) return { doneDays: [], deleted: {}, ...saved };
  } catch (e) { /* 壊れていたら空から始める */ }
  return { cards: [], doneDays: [], deleted: {} };
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch (e) {
    toast("保存できませんでした");
  }
  scheduleSnapshot();
}

// ---- 自動バックアップ（アプリの中に、日ごとの控えを残す） ----
// 本体のデータとは別の保存場所（IndexedDB）に置く。操作ミスや不具合で消えたときに戻せる。
const SNAPSHOT_DB = "ieta-backup";

function openSnapshots() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SNAPSHOT_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("days");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function snapshotStore(mode, fn) {
  const db = await openSnapshots();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("days", mode);
      const req = fn(tx.objectStore("days"));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

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
  try {
    const all = await snapshotStore("readonly", (s) => s.getAll());
    return all.sort((a, b) => b.date.localeCompare(a.date));
  } catch (e) {
    return [];
  }
}

function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch (e) {
    return "";
  }
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
  const res = await fetch(`/api/${path}`, {
    ...options,
    headers: { "content-type": "application/json", authorization: `Bearer ${getToken()}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "サーバーにつながりませんでした");
  return body;
}

// サーバー（Cloudflare）があるときだけ、同期と通知を使う。GitHub Pagesにはサーバーがない。
let hasServer = false;
async function detectServer() {
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    hasServer = res.ok && (await res.json()).ok === true;
  } catch (e) {
    hasServer = false;
  }
}

// 手元のデータをサーバーと混ぜ合わせる。失敗しても手元のデータはそのまま残る。
let syncing = false;
async function sync() {
  if (!hasServer || !getToken() || syncing) return;
  syncing = true;
  try {
    const merged = await api("sync", { method: "POST", body: JSON.stringify(state) });
    // 通信している間に手元が変わっていても失わないよう、もう一度混ぜる。
    state = Logic.merge(state, merged);
    save();
    if (onHome) renderHome();
  } catch (e) { /* オフラインなど。次の機会にまた試す */ }
  syncing = false;
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
  flame: "M12 2c1 3.2-.6 5-2.2 6.7C8.2 10.4 6.5 12.2 6.5 15a5.5 5.5 0 0 0 11 0c0-2.1-.9-3.7-2-5 .1 1.6-.5 2.8-1.6 3.4.4-2.9-.6-6.6-1.9-11.4z",
  check: "M5 12.5l4.5 4.5L19 7.5",
  close: "M6 6l12 12M18 6L6 18",
  sound: "M4 9.5h3.5L12 5.5v13l-4.5-4H4zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11",
};

function icon(name, cls = "icon") {
  const filled = name === "flame";
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
  document.onkeydown = null;
  app.replaceChildren(...nodes);
  window.scrollTo(0, 0);
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
  const waiting = state.cards.length - ready;

  // 今日やる分がない日は、開いただけで達成にする（やることがない日に連続を切らない）。
  if (ready > 0 && queue.length === 0) markDone();
  const days = Logic.streak(state.doneDays, date);
  const stats = Logic.progress(state.cards, date);
  const doneToday = state.doneDays.includes(date);

  const header = h("div", { class: "home-top" },
    h("div", { class: `streak-chip${days > 0 ? "" : " off"}` }, icon("flame"), h("span", {}, days > 0 ? `${days}日連続` : "今日から")),
    h("div", { class: "week", "aria-label": "直近7日の記録" }, Logic.week(state.doneDays, date).map((d) =>
      h("div", { class: `day${d.done ? " done" : ""}${d.today ? " today" : ""}` },
        h("span", { class: "dot" }, d.done ? icon("flame", "icon small") : null),
        h("span", { class: "label" }, d.label)))));

  let hero;
  if (state.cards.length === 0) {
    hero = h("div", { class: "hero" },
      h("div", { class: "welcome" }, icon("flame", "icon big")),
      h("p", { class: "hero-text" }, "言えなかった一言を、", h("br"), "明日には言えるようにする。"),
      h("p", { class: "hero-sub" }, "英会話の記録を貼るところから。"));
  } else if (queue.length > 0) {
    hero = h("div", { class: "hero" },
      ring(stats.doneToday, stats.doneToday + queue.length,
        h("div", { class: "count" }, String(queue.length)),
        h("div", { class: "count-label" }, "今日の分")),
      h("p", { class: "hero-sub" }, stats.doneToday > 0 ? "あと少し。続きから始めましょう。" : "今日の英語を、頭の中で作りましょう。"));
  } else {
    hero = h("div", { class: "hero" },
      ring(1, 1, h("div", { class: "ring-check" }, icon("check", "icon big"))),
      h("p", { class: "hero-text" }, "今日の分は終わりです。"),
      h("p", { class: "hero-sub" }, ready > 0 ? (doneToday ? "また明日。" : "また明日。") : "英語を入れると練習に出ます。"));
  }

  const tiles = state.cards.length > 0
    ? h("div", { class: "tiles" },
      h("div", { class: "tile good" }, h("strong", {}, String(stats.mastered)), h("span", {}, "覚えた")),
      h("div", { class: "tile" }, h("strong", {}, String(stats.learning)), h("span", {}, "練習中")),
      h("div", { class: "tile" }, h("strong", {}, String(stats.fresh)), h("span", {}, "これから")))
    : null;

  show(h("div", { class: "home" },
    header,
    hero,
    tiles,
    h("div", { class: "actions" },
      queue.length > 0
        ? h("button", { class: "btn primary", id: "start", onclick: () => startSession(queue) }, "始める")
        : null,
      h("button", {
        class: `btn ${queue.length > 0 ? "secondary" : "primary"}`,
        id: "paste",
        onclick: renderPaste,
      }, "英会話の記録を貼る")),
    h("div", { class: "foot" },
      h("button", { class: "link", id: "add", onclick: () => renderForm() }, "1つ追加"),
      h("button", { class: "link", id: "list", onclick: () => renderList(waiting > 0 ? "todo" : "all") },
        waiting > 0 ? `単語帳（英語待ち ${waiting}）` : "単語帳"),
      h("button", { class: "link", id: "settings", onclick: renderSettings }, "設定"))));
  onHome = true;
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
      h("button", { class: "btn primary", id: "make", onclick: makeCards }, "カードにする"))));
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
    const row = h("div", { class: "result" },
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
  renderQuestion({ pending: [...queue], total: queue.length, cleared: 0, answered: [], firstOk: 0 });
}

const kindChip = (card) => h("span", { class: `chip ${card.kind}` }, card.kind === "word" ? "単語" : "文");

function renderQuestion(session) {
  const card = session.pending[0];
  const reveal = () => renderAnswer(session);
  show(h("div", { class: "study" },
    studyTop(session),
    h("button", { class: "card", id: "reveal", onclick: reveal },
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
    h("div", { class: "card revealed" },
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
  show(h("div", { class: "home finish" },
    confetti(),
    h("div", { class: "hero" },
      h("div", { class: "big-flame" }, icon("flame", "icon huge"), h("div", { class: "count" }, String(days))),
      h("div", { class: "count-label" }, "日連続"),
      h("p", { class: "cheer" }, Logic.cheer(days)),
      h("p", { class: "hero-sub" }, `今日は ${session.total} 問、全部できました。`)),
    h("div", { class: "tiles" },
      h("div", { class: "tile" }, h("strong", {}, String(session.total)), h("span", {}, "練習した")),
      h("div", { class: "tile good" }, h("strong", {}, `${rate}%`), h("span", {}, "1回でできた"))),
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
    h("div", { class: "sheet" }, h("table", {}, h("thead", {}, head), body))));
  app.classList.add("wide");
  fillHead();
  fillRows();
}

// ---- 設定 ----
function renderSettings() {
  const token = h("input", { id: "token", type: "password", value: getToken(), autocomplete: "off", autocapitalize: "off" });
  const saveToken = () => {
    try {
      localStorage.setItem(TOKEN_KEY, token.value.trim());
    } catch (e) {
      toast("保存できませんでした");
      return;
    }
    toast("保存しました");
    sync();
  };

  const hour = h("select", { id: "hour", "aria-label": "通知の時刻" },
    Array.from({ length: 24 }, (_, i) => h("option", { value: String(i) }, `${i}:00`)));
  hour.value = "20";

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
      h("h2", {}, "接続キー"),
      h("p", {}, "同期と通知を使うためのキーです。端末ごとに1回入れます。"),
      h("label", {}, token),
      h("button", { class: "btn secondary", id: "save-token", onclick: saveToken }, "保存")),
    h("div", { class: "section" },
      h("h2", {}, "毎日の通知"),
      h("p", {}, "今日の分が残っている日だけ、この時刻に届きます（日本時間）。"),
      hour,
      h("button", { class: "btn secondary", id: "notify", onclick: () => enablePush(Number(hour.value)) }, "通知をオンにする")),
  ];
  // サーバーがないときは、iPhoneのリマインダーで毎日の通知を代わりにする。
  const reminderSection = h("div", { class: "section" },
    h("h2", {}, "毎日の通知"),
    h("p", {}, "iPhoneのリマインダーで設定します。新規 → 日付と時刻をオン → 繰り返し「毎日」→ URLにこのアプリのアドレスを貼る。"),
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
      h("button", { class: "btn secondary", id: "csv", onclick: exportCSV }, "CSVで書き出す"))));
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

async function enablePush(hour) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    toast("iPhoneはホーム画面に追加してから開いてください");
    return;
  }
  if (!getToken()) {
    toast("先に接続キーを入れてください");
    return;
  }
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      toast("通知が許可されませんでした");
      return;
    }
    const { publicKey } = await api("push/key");
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64ToBytes(publicKey),
    });
    await api("push/subscribe", { method: "POST", body: JSON.stringify({ subscription, hour }) });
    toast(`毎日 ${hour}:00 に通知します`);
  } catch (e) {
    toast(e.message || "通知をオンにできませんでした");
  }
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
writeSnapshot();
detectServer().then(() => {
  if (onHome) renderHome();
  sync();
});
