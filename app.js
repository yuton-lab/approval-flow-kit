/**
 * 承認フロー基盤(approval-flow-kit)
 *
 * 「誰が・どの順で・何を確認して承認するか」だけを扱う、業種非依存の多段承認フローです。
 * 業種ごとの事情は templates/*.json に閉じ込めてあり、エンジン側は業種を一切知りません。
 *
 *   申請 → 形式チェック(テンプレート定義) → 承認ルート判定(テンプレート定義)
 *   → 承認リレー(承認で次工程へ / 差し戻しで前工程へ戻る逆リレー)
 *   → 申請者まで戻ったら 取り下げ か 再申請 を選ぶ → 全工程通過で完了
 *
 * テンプレートが持つもの:
 *   terms   画面に出す呼び名(「推薦文」「施工計画」など)
 *   fields  申請フォームの追加項目(text / number / select)
 *   checks  本文の形式チェック(文数・文長・数字の有無・禁止語・必須語)
 *   routes  条件 → 承認ステップの並び(上から順に判定し、最初に当たったものを採用)
 *   roles   登場する役割。メンバーはこの役割に紐づく
 *
 * 設計方針:
 *   - 単一ファイル・JSONファイル保存・ビルド不要。依存は express のみ
 *   - 業種を増やす作業を「JSONを1枚足す」に閉じる。コードを触らせない
 *   - 判定結果は必ず理由とセットで画面に出す。なぜこのルートなのかが分からないと運用に乗らない
 *   - 外部通信(Slack通知)は try-catch で包み、失敗してもフローを止めない
 */
const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

/* .env の読み込み。dotenv を足さずここで済ませているのは、必要なのが
 * 「KEY=VALUE を1行ずつ読む」だけのため。すでに環境にある値は上書きしない。
 * BOM と CRLF を落とすのは、Windows のメモ帳で保存した .env の先頭キーが
 * ﻿ 付きになり、原因の分かりにくい「効かない」を生むため。 */
(function loadEnvFile() {
  const file = path.join(__dirname, ".env");
  if (!fs.existsSync(file)) return;
  const loaded = [];
  for (const raw of fs.readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    if (process.env[key] !== undefined) continue;
    let val = line.slice(eq + 1).trim();
    if (val.length > 1 && (val[0] === '"' || val[0] === "'") && val[val.length - 1] === val[0]) val = val.slice(1, -1);
    process.env[key] = val;
    loaded.push(key);
  }
  if (loaded.length) console.log("[info] .env を読み込みました: " + loaded.join(", "));
})();

const {
  SLACK_WEBHOOK_URL,
  APP_SECRET = "demo",
  DATA_DIR = "./data",
  BASE_URL = "",
  PORT = 3000,
} = process.env;

if (!SLACK_WEBHOOK_URL) console.log("[info] SLACK_WEBHOOK_URL 未設定のためデモモードで起動します(通知は /inbox/" + APP_SECRET + " に表示)");

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/* ===== 保存(JSONファイル) ===== */
const dir = path.isAbsolute(DATA_DIR) ? DATA_DIR : path.join(__dirname, DATA_DIR);
fs.mkdirSync(dir, { recursive: true });
const jpath = (n) => path.join(dir, n + ".json");
function readJson(n, fallback) {
  try { return JSON.parse(fs.readFileSync(jpath(n), "utf8")); } catch (e) { return fallback; }
}
function writeJson(n, v) {
  try { fs.writeFileSync(jpath(n), JSON.stringify(v, null, 2)); } catch (e) { console.error("[warn] 保存に失敗:", e.message); }
}

const DB = {
  reqs: readJson("requests", []),
  members: readJson("members", {}),   // テンプレートID -> [{id,name,role}]
  inbox: readJson("inbox", []),
  // 起動時に表示する業種。保存先が消える環境(Renderの無料プランなど)では、
  // スリープや再デプロイのたびにこの既定値に戻る。最初に見せたい業種を置く。
  config: readJson("config", { tpl: process.env.DEFAULT_TEMPLATE || "construction" }),
};
const save = (k, n) => writeJson(n || k, DB[k]);

/* ===== テンプレート ===== */
const TPL_DIR = path.join(__dirname, "templates");
const TEMPLATES = {};
for (const f of fs.readdirSync(TPL_DIR).filter(f => f.endsWith(".json"))) {
  try {
    const t = JSON.parse(fs.readFileSync(path.join(TPL_DIR, f), "utf8"));
    TEMPLATES[t.id] = t;
  } catch (e) {
    console.error(`[warn] テンプレートを読めませんでした(${f}):`, e.message);
  }
}
const TPL_IDS = Object.keys(TEMPLATES);
if (!TPL_IDS.length) { console.error("[fatal] templates/ に読めるテンプレートがありません"); process.exit(1); }
if (!TEMPLATES[DB.config.tpl]) DB.config.tpl = TPL_IDS[0];
console.log(`[info] テンプレートを ${TPL_IDS.length} 件読み込みました: ${TPL_IDS.join(", ")}`);

const tpl = () => TEMPLATES[DB.config.tpl];

/* メンバーは役割から機械的に用意する。テンプレートに人名を書かせない作り。
 * 業種を足す人が考えるのは「どんな役割が要るか」だけで済む。 */
const NAME_POOL = ["佐藤", "鈴木", "高橋", "田中", "伊藤", "渡辺", "山本", "中村"];
// 名前に役割を含めない。画面のほとんどが役割名と並べて出すので、
// 名前側にも入れると「工事部長(高橋(工事部長))」のように二重になる
function membersOf(id) {
  if (!DB.members[id]) {
    DB.members[id] = (TEMPLATES[id].roles || []).map((role, i) => ({
      id: `${id}-${i + 1}`, name: NAME_POOL[i % NAME_POOL.length], role,
    }));
    DB.members[id].push({ id: `${id}-0`, name: "山田", role: "__applicant__" });
    save("members");
  }
  return DB.members[id];
}
// 人を指すときは「名前(役割)」。役割名の隣に出す場面では name だけを使う
const roleLabel = (m) => (m.role === "__applicant__" ? "申請者" : m.role);
const whoLabel = (m) => `${m.name}(${roleLabel(m)})`;
const memberById = (id) => membersOf(DB.config.tpl).find(m => m.id === id) || null;
const applicantOf = (id) => membersOf(id).find(m => m.role === "__applicant__");

/* ================= 形式チェック =================
 * テンプレートの checks をそのまま実行する。ここに業種の知識は書かない。
 * 返すのは「人が読んで直せる文言」。どの語が引っかかったかまで出す。
 */
const sentencesOf = (s) => String(s || "").split(/[。！？!?\n]+/).map(x => x.trim()).filter(Boolean);
const bodyLen = (s) => String(s || "").replace(/\s/g, "").length;

function runChecks(body, checks) {
  const text = String(body || "");
  const sents = sentencesOf(text);
  const out = [];
  for (const c of checks || []) {
    const hit = (msg) => out.push(msg);
    if (c.type === "sentences") {
      if (sents.length < (c.min ?? 0) || sents.length > (c.max ?? 999)) hit(`${c.msg}(現在 ${sents.length}文)`);
    } else if (c.type === "sentenceLen") {
      const over = sents.filter(s => s.length > c.max);
      if (over.length) hit(`${c.msg}(${over.length}文)`);
    } else if (c.type === "needNumber") {
      if (!/[0-9０-９]/.test(text)) hit(c.msg);
    } else if (c.type === "banWords") {
      const found = (c.words || []).filter(w => text.includes(w));
      if (found.length) hit(`${c.msg}: ${found.join("・")}`);
    } else if (c.type === "needWords") {
      const found = (c.words || []).filter(w => text.includes(w));
      const ok = c.any ? found.length > 0 : found.length === (c.words || []).length;
      if (!ok) hit(`${c.msg}(${c.any ? "いずれか" : "すべて"}: ${(c.words || []).join("・")})`);
    } else if (c.type === "maxWordCount") {
      let n = 0;
      for (const w of c.words || []) n += text.split(w).length - 1;
      if (n > c.n) hit(`${c.msg}(${n}回)`);
    } else if (c.type === "minLen") {
      if (bodyLen(text) < c.n) hit(`${c.msg}(現在 ${bodyLen(text)}字)`);
    } else if (c.type === "maxLen") {
      if (bodyLen(text) > c.n) hit(`${c.msg}(現在 ${bodyLen(text)}字)`);
    }
  }
  return out;
}

/* ================= 承認ルート判定 =================
 * routes を上から順に見て、最初に条件をすべて満たしたものを採る。
 * when が空の行はフォールバック。テンプレートの最後に必ず置く。
 *
 * 判定結果には「なぜそうなったか」を必ず添える。
 * ルートだけ出しても、運用では「なんでこの人が入るの?」で必ず止まるため。
 */
const OPS = {
  "==": (a, b) => String(a) === String(b),
  "!=": (a, b) => String(a) !== String(b),
  ">=": (a, b) => Number(a) >= Number(b),
  "<=": (a, b) => Number(a) <= Number(b),
  ">":  (a, b) => Number(a) > Number(b),
  "<":  (a, b) => Number(a) < Number(b),
  "contains": (a, b) => String(a).includes(String(b)),
  "empty": (a) => !String(a || "").trim(),
  "notEmpty": (a) => !!String(a || "").trim(),
};
// 判定理由を日本語の文にする。演算子ごとに語順が違うので、記号の置換ではなく文を組む
const OP_PHRASE = {
  "==": (l, v) => `${l}が「${v}」`,
  "!=": (l, v) => `${l}が「${v}」以外`,
  ">=": (l, v) => `${l}が ${v} 以上`,
  "<=": (l, v) => `${l}が ${v} 以下`,
  ">":  (l, v) => `${l}が ${v} を超える`,
  "<":  (l, v) => `${l}が ${v} 未満`,
  "contains": (l, v) => `${l}に「${v}」を含む`,
  "empty": (l) => `${l}が空`,
  "notEmpty": (l) => `${l}が入力済み`,
};

function valueOf(data, key) {
  if (key === "subject") return data.subject;
  if (key === "counterparty") return data.counterparty;
  if (key === "body") return data.body;
  if (key === "bodyLen") return bodyLen(data.body);
  return (data.fields || {})[key];
}
function labelOf(t, key) {
  const f = (t.fields || []).find(f => f.key === key);
  if (f) return f.label;
  const terms = t.terms || {};
  return { subject: terms.subject, counterparty: terms.counterparty, body: terms.body, bodyLen: "本文の字数" }[key] || key;
}

function decideRoute(t, data) {
  for (const r of t.routes || []) {
    const conds = r.when || [];
    if (conds.every(([k, op, v]) => (OPS[op] || (() => false))(valueOf(data, k), v))) {
      const why = conds.length
        ? conds.map(([k, op, v]) => (OP_PHRASE[op] || ((l) => `${l} ${op} ${v}`))(labelOf(t, k), v)).join(" かつ ")
        : "どの条件にも当たらないため既定のルート";
      return { name: r.name, steps: (r.steps || []).slice(), why };
    }
  }
  return { name: "(ルート未定義)", steps: [], why: "テンプレートに当てはまる routes がありません" };
}

/* ================= 承認リレー =================
 * 承認  : 次の工程へ。最後まで通れば完了
 * 差し戻し: ひとつ前の工程へ戻す(逆リレー)。先頭で差し戻すと申請者まで戻る
 *          「否決して終わり」にしないのは、実務では直して通すことがほとんどのため
 */
const nowIso = () => new Date().toISOString();
const stamp = (d) => new Date(d).toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
function buildRequest(t, data, applicantName, at) {
  const ts = at || nowIso();
  return {
    id: nextId(), tpl: t.id, ...data, route: decideRoute(t, data), idx: 0, state: "pending", seals: [],
    applicant: applicantName, createdAt: ts,
    history: [{ at: ts, by: applicantName, role: "申請者", action: "submit", comment: "" }],
    checksAtSubmit: runChecks(data.body, t.checks), returned: null,
  };
}

const nextId = () => "R-" + String(DB.reqs.length + 1).padStart(3, "0") + "-" + Math.random().toString(36).slice(2, 5);

function currentStep(r) { return r.state === "pending" ? r.route.steps[r.idx] : null; }
function canAct(r, m) { return !!m && r.state === "pending" && m.role === currentStep(r); }

// at を渡せるのは初期データを過去日で組み立てるため。通常の操作では省略する
function act(r, m, action, comment, at) {
  const ts = at || nowIso();
  const rec = { at: ts, by: m.name, role: m.role, action, comment: String(comment || "").trim() };
  r.seals = r.seals || [];
  if (action === "approve") {
    r.seals[r.idx] = m.name;           // 押した印は工程の位置に残す
    r.idx += 1;
    if (r.idx >= r.route.steps.length) { r.state = "approved"; r.doneAt = ts; }
    r.returned = null;
  } else if (action === "reject") {
    r.returned = { from: r.route.steps[r.idx], by: m.name, comment: rec.comment };
    r.idx -= 1;
    if (r.idx < 0) { r.idx = 0; r.state = "returned"; }
    r.seals[r.idx] = null;             // 戻された工程は、もう一度押してもらう
  }
  r.history.push(rec);
  save("reqs", "requests");
  notify(r, action, m, ts);
  return r;
}

/* 「いつからこの工程で止まっているか」。
 * 申請日ではなく、最後に誰かが動かした時点から数える。差し戻しで戻った案件を
 * 申請日から数えると、実際より長く滞留しているように見えてしまうため。 */
const DAY = 86400000;
function stuckSince(r) {
  const last = r.history[r.history.length - 1];
  return new Date((last && last.at) || r.createdAt).getTime();
}
const stuckDays = (r) => (Date.now() - stuckSince(r)) / DAY;
const slaOf = (t) => Number((t && t.slaDays) || 3);
const isOverdue = (r, t) => r.state === "pending" && stuckDays(r) > slaOf(t);
const fmtDays = (d) => d < 1 ? `${Math.max(1, Math.round(d * 24))}時間` : `${Math.floor(d)}日`;

/* ===== 通知(Slack Webhook が無ければアプリ内の通知ボックスへ) ===== */
function notify(r, action, m, at) {
  const t = TEMPLATES[r.tpl] || tpl();
  const label = { submit: "申請", approve: "承認", reject: "差し戻し", resubmit: "再申請", withdraw: "取り下げ", nudge: "催促" }[action] || action;
  const to = r.state === "pending" ? `次は ${currentStep(r)}` : r.state === "approved" ? "完了" : r.state === "returned" ? "申請者へ差し戻し" : r.state;
  const text = `【${t.terms.request}】${label}: ${r.subject} × ${r.counterparty}(${m ? m.name : "-"}) → ${to}`;
  const link = (BASE_URL ? BASE_URL : "") + `/my/${APP_SECRET}`;
  DB.inbox.unshift({ at: at || nowIso(), text, link, id: r.id });
  DB.inbox = DB.inbox.slice(0, 100);
  save("inbox");
  if (!SLACK_WEBHOOK_URL) return;
  // 外部通信で承認フローを止めない。落ちても通知ボックスには残っている
  fetch(SLACK_WEBHOOK_URL, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, link }),
  }).catch(e => console.error("[warn] Slack通知に失敗:", e.message));
}

/* ================= 画面(見た目) =================
 * モチーフは稟議書と承認印。やっていることが回覧と押印の電子化なので、
 * SaaS然とした見た目より業務帳票に寄せたほうが中身と一致する。
 * 色は CSS 変数に寄せてあり、社内配色に合わせるときは :root だけ触れば済む。
 */
const FONT_LINKS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=Shippori+Mincho:wght@600&family=Zen+Kaku+Gothic+New:wght@400;500;700&display=swap">`;

const CSS = `
:root{
  --paper:#EBEDE8; --surface:#FFF; --raise:#F6F7F3;
  --ink:#161B21; --sub:#59636E; --line:#D8DCD4; --rule:#C2C8BD;
  --brand:#1E3A52; --brand-soft:#E7ECF0; --brand-line:#C3CFD9;
  --red:#B2382C; --red-soft:#F8E9E5; --red-line:#E1B7AE;
  --green:#1B6B45; --green-soft:#E4EFE8; --green-line:#BCD6C6;
  --amber:#8A6109; --amber-soft:#F7EEDB; --warn-fill:#FFFBEF;
  --sans:"Zen Kaku Gothic New","Hiragino Sans","Yu Gothic UI","Yu Gothic",Meiryo,sans-serif;
  --serif:"Shippori Mincho","Hiragino Mincho ProN","Yu Mincho",serif;
  --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);font-size:15px;line-height:1.8;
  padding:22px 14px 56px}
.wrap{max-width:880px;margin:0 auto}
a{color:var(--brand);text-decoration-color:var(--brand-line);text-underline-offset:3px}
a:hover{color:var(--red)}
.masthead{display:flex;align-items:center;gap:10px;margin:0 2px 12px;padding-bottom:10px;
  border-bottom:1px solid var(--rule);position:relative}
.masthead::after{content:"";position:absolute;left:0;bottom:-3px;width:64px;height:2px;background:var(--red)}
.mark{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;flex:none;
  border:1.5px solid var(--red);border-radius:50%;color:var(--red);background:var(--surface);
  font-family:var(--serif);font-size:14px;font-weight:600;transform:rotate(-7deg)}
.wordmark{font-family:var(--serif);font-weight:600;font-size:16px;letter-spacing:.06em;color:var(--brand)}
.stamp-lbl{margin-left:auto;font-family:var(--mono);font-size:10.5px;letter-spacing:.18em;color:var(--sub)}
.card{background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:26px 28px;
  box-shadow:0 1px 2px rgba(22,27,33,.05),0 14px 32px rgba(22,27,33,.06)}
h1{font-size:21px;margin:.1em 0 .7em;color:var(--brand)}
h2{font-size:19px;color:var(--brand);margin:.1em 0 .8em;padding-bottom:9px;border-bottom:1px solid var(--rule)}
h3{font-size:15px;margin:1.6em 0 .5em;padding-left:9px;border-left:3px solid var(--brand)}
.hint{font-size:12.5px;color:var(--sub);margin:0 0 10px}
.mono{font-family:var(--mono);font-size:12px;color:var(--sub)}
label{display:block;margin:14px 0 4px;font-size:13.5px;font-weight:700}
input,select,textarea{width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:4px;
  font-family:inherit;font-size:15px;background:var(--surface);color:var(--ink)}
textarea{line-height:1.9;resize:vertical}
input:focus,select:focus,textarea:focus{outline:2px solid var(--brand-line);outline-offset:-1px}
button{font-family:inherit;font-size:14.5px;font-weight:700;padding:10px 20px;border-radius:4px;
  border:1px solid var(--brand);background:var(--brand);color:#fff;cursor:pointer}
button:hover{background:#132534}
button.quiet{background:var(--surface);color:var(--brand)}
button.quiet:hover{background:var(--brand-soft)}
button.danger{background:var(--surface);color:var(--red);border-color:var(--red-line)}
button.danger:hover{background:var(--red-soft)}
.row{display:flex;gap:16px;flex-wrap:wrap}
.row>*{flex:1 1 220px;min-width:0}
.sep{display:inline-block;width:1px;height:11px;background:var(--rule);margin:0 10px;vertical-align:-1px}
.badge{display:inline-block;border-radius:3px;padding:3px 10px;font-size:12.5px;font-weight:700;line-height:1.6}
.b-red{background:var(--red-soft);color:var(--red)} .b-green{background:var(--green-soft);color:var(--green)}
.b-amber{background:var(--amber-soft);color:var(--amber)} .b-brand{background:var(--brand-soft);color:var(--brand)}
.rec{background:var(--surface);border:1px solid var(--line);border-left:3px solid var(--line);
  border-radius:4px;padding:12px 15px;margin:10px 0;display:flex;flex-direction:column;gap:6px}
.rec.act{border-left-color:var(--red)} .rec.wait{border-left-color:var(--amber)} .rec.done{border-left-color:var(--green)}
.rec .top{display:flex;justify-content:space-between;flex-wrap:wrap;gap:4px;align-items:baseline}
.note{background:var(--red-soft);border:1px solid var(--red-line);border-radius:4px;padding:9px 12px;
  font-size:13px;color:var(--red)}
.info{background:var(--brand-soft);border:1px solid var(--brand-line);border-radius:4px;padding:9px 12px;font-size:13px}
.warn{background:var(--amber-soft);border:1px solid transparent;border-radius:4px;padding:9px 12px;font-size:13px;color:var(--amber)}
.rail{list-style:none;padding:0;margin:12px 0 0}
.rail li{position:relative;padding:0 0 18px 34px;font-size:13.5px}
.rail li:not(:last-child)::after{content:"";position:absolute;left:12.5px;top:24px;bottom:2px;width:1px;background:var(--rule)}
.rail .dot{position:absolute;left:0;top:1px;width:26px;height:26px;border-radius:50%;display:inline-flex;
  align-items:center;justify-content:center;font-size:12px;font-weight:700;background:var(--surface);
  border:1px solid var(--rule);color:var(--sub)}
.rail .now .dot{background:var(--red);border-color:var(--red);color:#fff}
.rail .seal{position:absolute;left:0;top:1px;width:26px;height:26px;border-radius:50%;display:inline-flex;
  align-items:center;justify-content:center;border:1.5px solid var(--red);color:var(--red);background:var(--surface);
  font-family:var(--serif);font-size:13px;font-weight:600;transform:rotate(-7deg)}
.nm{color:var(--sub);font-size:12.5px}
table{width:100%;border-collapse:collapse;font-size:13.5px;margin:10px 0}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{background:var(--raise);font-size:12.5px;color:var(--sub);font-weight:700;white-space:nowrap}
pre{background:var(--raise);border:1px solid var(--line);border-radius:4px;padding:14px;overflow-x:auto;
  font-family:var(--mono);font-size:12px;line-height:1.7}
.nav{margin-top:26px;padding-top:14px;border-top:1px solid var(--rule)}
.nav a{display:inline-block;font-size:12.5px;text-decoration:none;border:1px solid var(--line);border-radius:3px;
  padding:4px 11px;background:var(--surface);margin:0 6px 6px 0;line-height:1.7}
.tpl-pick{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 0}
.tpl-pick a{display:inline-block;font-size:12.5px;text-decoration:none;border:1px solid var(--line);
  border-radius:3px;padding:5px 12px;background:var(--surface)}
.tpl-pick a.on{background:var(--brand);border-color:var(--brand);color:#fff}
.entry{display:flex;gap:12px;align-items:flex-start;border:1px solid var(--line);border-radius:5px;
  padding:12px 15px;margin:8px 0;background:var(--surface);text-decoration:none;color:inherit}
.entry:hover{background:var(--raise)}
.entry .n{flex:none;width:26px;height:26px;border-radius:50%;border:1px solid var(--rule);color:var(--sub);
  display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-family:var(--mono)}
.entry b{color:var(--brand);display:block}
.entry span{font-size:12.5px;color:var(--sub)}
@media(max-width:600px){.card{padding:18px 16px}body{padding:16px 12px 48px}}
`;

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const S = () => encodeURIComponent(APP_SECRET);

function masthead() {
  const t = tpl();
  return `<header class="masthead"><span class="mark">承</span>
  <span class="wordmark">承認フロー基盤</span>
  <span class="stamp-lbl">${esc(t.name)}</span></header>`;
}

function page(title, inner, links) {
  const nav = (links || []).map(([href, label]) => `<a href="${href}">${esc(label)}</a>`).join("");
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — 承認フロー基盤</title>${FONT_LINKS}<style>${CSS}</style></head>
<body><div class="wrap">${masthead()}<div class="card">${inner}
${nav ? `<nav class="nav"><span class="mono" style="display:block;margin-bottom:8px">この画面から</span>${nav}</nav>` : ""}
</div></div></body></html>`;
}

function guard(req, res) {
  if (req.params.secret !== APP_SECRET) { res.status(404).send(page("見つかりません", "<h1>404</h1><p>URLの合言葉が違います。</p>")); return false; }
  return true;
}

/* ================= トップ ================= */
app.get("/", (req, res) => {
  const t = tpl();
  const picks = TPL_IDS.map(id =>
    `<a class="${id === t.id ? "on" : ""}" href="/tpl/${S()}/${id}">${esc(TEMPLATES[id].name)}</a>`).join("");
  res.send(page("トップ", `
<h1>業種を設定ファイルで切り替える、多段承認フローです。</h1>
<p class="hint">承認フローの骨格(誰が・どの順で・何を確認するか)はどの業種でも同じで、違うのは中身だけです。
そこで骨格をエンジンに、中身を <span class="mono">templates/*.json</span> に分けました。業種を足す作業は、JSONを1枚書くことに閉じます。</p>

<h3>いま効いている業種</h3>
<div class="tpl-pick">${picks}</div>
<p class="hint" style="margin-top:10px">${esc(t.summary)}</p>

<h3>この順に見ると分かります</h3>
<a class="entry" href="/apply/${S()}"><span class="n">1</span><span><b>申請フォーム</b>
<span>項目・形式チェック・承認ルートが、選んだ業種に合わせて変わります</span></span></a>
<a class="entry" href="/queue/${S()}"><span class="n">2</span><span><b>承認待ち一覧</b>
<span>ユーザーを切り替えると「その人の番」の案件だけが並びます</span></span></a>
<a class="entry" href="/my/${S()}"><span class="n">3</span><span><b>申請状況</b>
<span>いま誰で止まっているかを見ます。済んだ工程には承認者の印が押されます</span></span></a>
<a class="entry" href="/stuck/${S()}"><span class="n">4</span><span><b>どこで止まっているか</b>
<span>工程ごとの滞留と、差し戻しがどこで起きているかが出ます</span></span></a>
<a class="entry" href="/template/${S()}"><span class="n">5</span><span><b>テンプレートの中身</b>
<span>上の4画面を動かしているJSONそのものです。ここが業種ごとの差分の全部です</span></span></a>

<h3>差し戻しは「否決」ではありません</h3>
<p class="hint">差し戻すと、ひとつ前の工程に戻ります。実務では差し戻しの多くが「直せば通る」ものなので、
止めるのではなく逆向きに流します。先頭まで戻ると申請者の手元に返り、そこで取り下げるか、直して再申請するかを選びます。</p>
`, [["/queue/" + S(), "承認待ち一覧"], ["/my/" + S(), "申請状況"], ["/inbox/" + S(), "通知ボックス"], ["/template/" + S(), "テンプレート"]]));
});

app.get("/tpl/:secret/:id", (req, res) => {
  if (!guard(req, res)) return;
  if (TEMPLATES[req.params.id]) { DB.config.tpl = req.params.id; save("config"); membersOf(req.params.id); }
  res.redirect("/");
});

/* ================= テンプレートの中身 ================= */
app.get("/template/:secret", (req, res) => {
  if (!guard(req, res)) return;
  const t = tpl();
  const fieldRows = (t.fields || []).map(f =>
    `<tr><td class="mono">${esc(f.key)}</td><td>${esc(f.label)}</td><td>${esc(f.type)}${f.options ? "(" + f.options.map(esc).join(" / ") + ")" : ""}</td></tr>`).join("");
  const routeRows = (t.routes || []).map((r, i) =>
    `<tr><td>${i + 1}</td><td><b>${esc(r.name)}</b></td>
     <td>${(r.when || []).length ? (r.when || []).map(([k, op, v]) => `${esc((OP_PHRASE[op] || ((l) => l + " " + op + " " + v))(labelOf(t, k), v))}`).join("<br>") : "<span class=\"hint\">(条件なし＝フォールバック)</span>"}</td>
     <td>${(r.steps || []).map(esc).join(" → ")}</td></tr>`).join("");
  const checkRows = (t.checks || []).map(c =>
    `<tr><td class="mono">${esc(c.type)}</td><td>${esc(JSON.stringify(Object.fromEntries(Object.entries(c).filter(([k]) => k !== "type" && k !== "msg"))))}</td><td>${esc(c.msg)}</td></tr>`).join("");
  res.send(page("テンプレート", `
<h2>${esc(t.name)}</h2>
<p class="hint">${esc(t.summary)}</p>
<div class="info">この画面に出ているものが、業種ごとの差分の全部です。エンジン側のコードに業種名は1つも出てきません。</div>

<h3>呼び名(terms)</h3>
<table><tr><th>キー</th><th>画面に出る語</th></tr>
${Object.entries(t.terms || {}).map(([k, v]) => `<tr><td class="mono">${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table>

<h3>追加の入力項目(fields)</h3>
<table><tr><th>キー</th><th>ラベル</th><th>型</th></tr>${fieldRows}</table>

<h3>承認ルート(routes)</h3>
<p class="hint">上から順に判定し、条件をすべて満たした最初の行を採用します。</p>
<table><tr><th>#</th><th>名前</th><th>条件</th><th>承認の並び</th></tr>${routeRows}</table>

<h3>形式チェック(checks)</h3>
<table><tr><th>種類</th><th>設定</th><th>引っかかったときの文言</th></tr>${checkRows}</table>

<h3>JSONそのもの</h3>
<pre>${esc(JSON.stringify(t, null, 2))}</pre>
`, [["/", "トップ"], ["/apply/" + S(), "申請フォーム"]]));
});

/* ================= 申請フォーム ================= */
function fieldInput(f, v) {
  const val = v == null ? "" : v;
  if (f.type === "select") {
    return `<select id="f_${esc(f.key)}" name="f_${esc(f.key)}" ${f.required ? "required" : ""}>
      ${(f.options || []).map(o => `<option ${String(val) === o ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
  }
  const type = f.type === "number" ? "number" : "text";
  return `<input id="f_${esc(f.key)}" name="f_${esc(f.key)}" type="${type}" value="${esc(val)}"
    placeholder="${esc(f.placeholder || "")}" ${f.required ? "required" : ""}>`;
}

app.get("/apply/:secret", (req, res) => {
  if (!guard(req, res)) return;
  const t = tpl(), tm = t.terms || {};
  const fields = (t.fields || []).map(f => `<div><label for="f_${esc(f.key)}">${esc(f.label)}</label>${fieldInput(f, "")}</div>`).join("");
  res.send(page(tm.request + "の申請", `
<h2>${esc(tm.request)}の申請</h2>
<p class="hint">項目も、下の形式チェックも、承認ルートも、選んでいる業種のテンプレートから組み立てています。
<a href="/template/${S()}">テンプレートを見る</a></p>

<form method="post" action="/apply/${S()}" id="form">
  <div class="row">
    <div><label for="subject">${esc(tm.subject)}</label><input id="subject" name="subject" required></div>
    <div><label for="counterparty">${esc(tm.counterparty)}</label><input id="counterparty" name="counterparty" required></div>
  </div>
  <div class="row">${fields}</div>
  <label for="body">${esc(tm.body)}</label>
  <textarea id="body" name="body" rows="9" required></textarea>

  <div id="checks" style="margin-top:12px"></div>
  <div id="route" class="info" style="margin-top:10px">承認ルート: 入力すると判定します</div>

  <div style="margin-top:18px;display:flex;gap:10px;flex-wrap:wrap">
    <button type="submit" id="submitBtn">承認を申請する</button>
    <button type="button" class="quiet" id="sample">サンプルを入れる</button>
  </div>
</form>

<script>
const $=(id)=>document.getElementById(id);
const FIELD_KEYS=${JSON.stringify((t.fields || []).map(f => f.key))};
const SAMPLE=${JSON.stringify((t.samples || [])[0] || null)};
function payload(){
 const fields={}; FIELD_KEYS.forEach(k=>fields[k]=$('f_'+k)?$('f_'+k).value:'');
 return {subject:$('subject').value,counterparty:$('counterparty').value,body:$('body').value,fields:fields};
}
let timer=null;
// チェックとルート判定はサーバー側の実装をそのまま呼ぶ。
// 同じ規則を画面側にも書くと、必ず片方だけ直されてズレるため。
async function refresh(){
 try{
  const r=await fetch('/check/'+${JSON.stringify(APP_SECRET)},{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(payload())});
  const j=await r.json();
  $('checks').innerHTML = j.checks.length
    ? '<div class="note">⚠ '+j.checks.map(x=>x.replace(/&/g,'&amp;').replace(/</g,'&lt;')).join('<br>⚠ ')+'</div>'
    : ($('body').value.trim()? '<div class="warn">形式チェックの指摘はありません</div>' : '');
  $('route').innerHTML='承認ルート: <b>'+j.route.name+'</b>('+(j.route.steps.join(' → ')||'-')+')<br>'
    +'<span class="hint">判定の理由: '+j.route.why+'</span>';
 }catch(e){}
}
function schedule(){clearTimeout(timer);timer=setTimeout(refresh,300);}
document.getElementById('form').addEventListener('input',schedule);
$('sample').addEventListener('click',()=>{
 if(!SAMPLE)return;
 $('subject').value=SAMPLE.subject||''; $('counterparty').value=SAMPLE.counterparty||''; $('body').value=SAMPLE.body||'';
 FIELD_KEYS.forEach(k=>{if($('f_'+k)&&SAMPLE.fields&&SAMPLE.fields[k]!=null)$('f_'+k).value=SAMPLE.fields[k];});
 refresh();
});
refresh();
</script>
`, [["/", "トップ"], ["/queue/" + S(), "承認待ち一覧"], ["/my/" + S(), "申請状況"]]));
});

// 形式チェックと承認ルート判定の唯一の入り口。画面側はここを呼ぶだけ
app.post("/check/:secret", (req, res) => {
  if (!guard(req, res)) return;
  const t = tpl();
  const data = { subject: req.body.subject, counterparty: req.body.counterparty, body: req.body.body, fields: req.body.fields || {} };
  res.json({ checks: runChecks(data.body, t.checks), route: decideRoute(t, data) });
});

app.post("/apply/:secret", (req, res) => {
  if (!guard(req, res)) return;
  const t = tpl();
  const fields = {};
  for (const f of t.fields || []) fields[f.key] = String(req.body["f_" + f.key] || "");
  const data = {
    subject: String(req.body.subject || "").trim(),
    counterparty: String(req.body.counterparty || "").trim(),
    body: String(req.body.body || "").trim(),
    fields,
  };
  if (!data.subject || !data.body) return res.status(400).send(page("入力が足りません", "<h1>入力が足りません</h1><p><a href=\"/apply/" + S() + "\">戻る</a></p>"));
  const me = applicantOf(t.id);
  const r = buildRequest(t, data, me.name);
  DB.reqs.unshift(r);
  save("reqs", "requests");
  notify(r, "submit", me);
  res.redirect(`/my/${S()}?hl=${encodeURIComponent(r.id)}`);
});

/* ================= 承認待ち一覧 ================= */
function userSwitch(path, me) {
  const list = membersOf(DB.config.tpl);
  return `<p class="hint">👤 ユーザー切替: ` + list.map(m =>
    `<a href="${path}?me=${encodeURIComponent(m.id)}" ${m.id === (me && me.id) ? 'style="font-weight:700"' : ""}>${esc(whoLabel(m))}</a>`
  ).join('<span class="sep"></span>') + `</p>`;
}

app.get("/queue/:secret", (req, res) => {
  if (!guard(req, res)) return;
  const t = tpl();
  const me = memberById(String(req.query.me || "")) || membersOf(t.id)[0];
  const mine = DB.reqs.filter(r => r.tpl === t.id && canAct(r, me));
  const body = mine.length ? mine.map(r => `
<div class="rec act">
  <div class="top"><b style="color:var(--red)">【${esc(r.route.steps[r.idx])}の番】</b>
    <span class="mono">申請:${esc(r.applicant)}(申請者) / ${esc(stamp(r.createdAt))}</span></div>
  <b style="font-size:15.5px">${esc(r.subject)} × ${esc(r.counterparty)}</b>
  ${(r.checksAtSubmit || []).length ? `<div><span class="badge b-amber">△ 形式チェックの指摘 ${r.checksAtSubmit.length}件</span></div>` : `<div><span class="badge b-green">✓ 形式チェックは通過</span></div>`}
  ${r.returned ? `<div class="note">↩ ${esc(r.returned.from)}(${esc(r.returned.by)})から差し戻し: ${esc(r.returned.comment) || "(コメントなし)"}</div>` : ""}
  <details><summary style="cursor:pointer;font-size:13px;color:var(--brand)">本文と入力値を見る</summary>
    <div style="white-space:pre-wrap;margin:8px 0;font-size:14px">${esc(r.body)}</div>
    <table>${Object.entries(r.fields || {}).map(([k, v]) => `<tr><th>${esc(labelOf(t, k))}</th><td>${esc(v)}</td></tr>`).join("")}</table>
    ${(r.checksAtSubmit || []).length ? `<div class="note">⚠ ${r.checksAtSubmit.map(esc).join("<br>⚠ ")}</div>` : ""}
  </details>
  <form method="post" action="/queue/${S()}/act" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:4px">
    <input type="hidden" name="id" value="${esc(r.id)}"><input type="hidden" name="me" value="${esc(me.id)}">
    <input name="comment" placeholder="差し戻すときは理由を書いてください" style="flex:1 1 260px">
    <button name="action" value="approve">✓ 承認</button>
    <button name="action" value="reject" class="danger">↩ 差し戻し</button>
  </form>
</div>`).join("") : `<p class="hint">いま ${esc(me.name)} さんがアクションすべき案件はありません。ユーザーを切り替えてみてください。</p>`;

  res.send(page("承認待ち一覧", `
<h2>承認待ち一覧(あなたの番:${mine.length}件)</h2>
${userSwitch("/queue/" + S(), me)}
<p class="hint">同じ案件でも、誰で見るかによって並ぶものが変わります。承認ルートは申請時に決まっています。</p>
${body}
`, [["/queue/" + S() + "?me=" + encodeURIComponent(me.id), "更新"], ["/my/" + S(), "申請状況"], ["/stuck/" + S(), "どこで止まっているか"], ["/apply/" + S(), "新規申請"], ["/", "トップ"]]));
});

app.post("/queue/:secret/act", (req, res) => {
  if (!guard(req, res)) return;
  const r = DB.reqs.find(x => x.id === String(req.body.id || ""));
  const me = memberById(String(req.body.me || ""));
  if (!r || !me) return res.status(404).send(page("見つかりません", "<h1>404</h1>"));
  if (!canAct(r, me)) return res.status(409).send(page("順番ではありません", `<h1>いまはこの方の番ではありません</h1>
    <p class="hint">画面を開いたあとに状態が変わった可能性があります。</p><p><a href="/queue/${S()}?me=${encodeURIComponent(me.id)}">一覧へ戻る</a></p>`));
  const action = req.body.action === "reject" ? "reject" : "approve";
  if (action === "reject" && !String(req.body.comment || "").trim()) {
    return res.status(400).send(page("理由が必要です", `<h1>差し戻しには理由が要ります</h1>
      <p class="hint">理由のない差し戻しは、受け取った側が何を直せばよいか分かりません。</p>
      <p><a href="/queue/${S()}?me=${encodeURIComponent(me.id)}">戻る</a></p>`));
  }
  act(r, me, action, req.body.comment);
  res.redirect(`/queue/${S()}?me=${encodeURIComponent(me.id)}`);
});

/* ================= 申請状況 ================= */
function rail(r) {
  return `<ol class="rail">` + r.route.steps.map((step, i) => {
    const sealBy = (r.seals || [])[i];
    const isNow = r.state === "pending" && i === r.idx;
    if (sealBy) return `<li><span class="seal">${esc(String(sealBy).trim()[0])}</span>${esc(step)}<span class="nm"> ／ ${esc(sealBy)} 承認済み</span></li>`;
    return `<li class="${isNow ? "now" : ""}"><span class="dot">${i + 1}</span>${esc(step)}${isNow ? '<span class="nm"> ／ いまここ</span>' : ""}</li>`;
  }).join("") + `</ol>`;
}

app.get("/my/:secret", (req, res) => {
  if (!guard(req, res)) return;
  const t = tpl();
  const hl = String(req.query.hl || "");
  const mine = DB.reqs.filter(r => r.tpl === t.id);
  const body = mine.length ? mine.map(r => {
    const cls = r.state === "approved" ? "done" : r.state === "returned" ? "act" : "wait";
    const badge = { pending: '<span class="badge b-amber">承認待ち</span>', approved: '<span class="badge b-green">✓ 完了</span>',
      returned: '<span class="badge b-red">↩ 差し戻し(あなたの番)</span>', withdrawn: '<span class="badge b-brand">取り下げ</span>' }[r.state] || "";
    return `
<div class="rec ${cls}" ${r.id === hl ? 'style="outline:2px solid var(--brand-line)"' : ""}>
  <div class="top"><b style="font-size:15.5px">${esc(r.subject)} × ${esc(r.counterparty)}</b>
    <span class="mono">${esc(r.id)} / ${esc(stamp(r.createdAt))}</span></div>
  <div>${badge} <span class="badge b-brand">ルート: ${esc(r.route.name)}</span></div>
  <p class="hint" style="margin:0">判定の理由: ${esc(r.route.why)}</p>
  ${r.returned ? `<div class="note">↩ ${esc(r.returned.from)}(${esc(r.returned.by)}): ${esc(r.returned.comment)}</div>` : ""}
  ${rail(r)}
  ${r.state === "returned" ? `
  <form method="post" action="/my/${S()}/back" style="display:flex;gap:8px;flex-wrap:wrap">
    <input type="hidden" name="id" value="${esc(r.id)}">
    <button name="action" value="resubmit" class="quiet">🔁 直して再申請</button>
    <button name="action" value="withdraw" class="danger">🚫 取り下げる</button>
  </form>` : ""}
  <details><summary style="cursor:pointer;font-size:13px;color:var(--brand)">やりとりの記録(${r.history.length})</summary>
    <table><tr><th>日時</th><th>誰が</th><th>何を</th><th>コメント</th></tr>
    ${r.history.map(h => `<tr><td class="mono">${esc(stamp(h.at))}</td><td>${esc(h.by)}</td>
      <td>${esc({ submit: "申請", approve: "承認", reject: "差し戻し", resubmit: "再申請", withdraw: "取り下げ" }[h.action] || h.action)}</td>
      <td>${esc(h.comment)}</td></tr>`).join("")}</table>
  </details>
</div>`;
  }).join("") : `<p class="hint">まだ申請がありません。<a href="/apply/${S()}">申請フォーム</a>から作ってみてください。</p>`;

  res.send(page("申請状況", `
<h2>申請状況(${mine.length}件)</h2>
<p class="hint">済んだ工程には承認者の印が押されます。丸に番号が付いているのが、いま止まっている工程です。</p>
${body}
`, [["/my/" + S(), "更新"], ["/queue/" + S(), "承認待ち一覧"], ["/stuck/" + S(), "どこで止まっているか"], ["/apply/" + S(), "新規申請"], ["/inbox/" + S(), "通知ボックス"], ["/", "トップ"]]));
});

app.post("/my/:secret/back", (req, res) => {
  if (!guard(req, res)) return;
  const r = DB.reqs.find(x => x.id === String(req.body.id || ""));
  if (!r || r.state !== "returned") return res.redirect(`/my/${S()}`);
  const me = applicantOf(r.tpl);
  if (req.body.action === "withdraw") {
    r.state = "withdrawn";
    r.history.push({ at: nowIso(), by: me.name, role: "申請者", action: "withdraw", comment: "" });
  } else {
    r.state = "pending"; r.idx = 0; r.seals = []; r.returned = null;
    r.history.push({ at: nowIso(), by: me.name, role: "申請者", action: "resubmit", comment: "" });
  }
  save("reqs", "requests");
  notify(r, req.body.action === "withdraw" ? "withdraw" : "resubmit", me);
  res.redirect(`/my/${S()}?hl=${encodeURIComponent(r.id)}`);
});

/* ================= 詰まりが見える画面 =================
 * 承認フローを入れる目的は、電子化そのものではなく「止まるのを減らす」ことにある。
 * そこで、いま何がどこで何日止まっているかと、どの工程で差し戻しが起きているかを出す。
 *
 * 差し戻しの発生元を見せているのは、そこが遅い工程だからではなく、
 * その「手前」の書き方に問題があるというサインだから。原因は一段前にある。
 */
app.get("/stuck/:secret", (req, res) => {
  if (!guard(req, res)) return;
  const t = tpl();
  const sla = slaOf(t);
  const mine = DB.reqs.filter(r => r.tpl === t.id);
  const pending = mine.filter(r => r.state === "pending").sort((a, b) => stuckSince(a) - stuckSince(b));
  const overdue = pending.filter(r => isOverdue(r, t));
  const done = mine.filter(r => r.state === "approved" && r.doneAt);
  const avgDone = done.length
    ? done.reduce((n, r) => n + (new Date(r.doneAt) - new Date(r.createdAt)) / DAY, 0) / done.length : null;

  // 工程ごとの滞留と、その工程が出した差し戻しの回数
  const per = new Map();
  for (const role of t.roles || []) per.set(role, { role, n: 0, days: 0, rejects: 0, last: "" });
  for (const r of pending) {
    const st = r.route.steps[r.idx];
    if (!per.has(st)) per.set(st, { role: st, n: 0, days: 0, rejects: 0, last: "" });
    const x = per.get(st); x.n += 1; x.days += stuckDays(r);
  }
  for (const r of mine) for (const h of r.history) {
    if (h.action !== "reject") continue;
    if (!per.has(h.role)) per.set(h.role, { role: h.role, n: 0, days: 0, rejects: 0, last: "" });
    const x = per.get(h.role); x.rejects += 1; if (h.comment) x.last = h.comment;
  }
  const rows = [...per.values()].filter(x => x.n || x.rejects);

  const summary = `
<div class="row" style="margin:0 0 6px">
  <div class="rec ${overdue.length ? "act" : "done"}" style="margin:0">
    <span class="mono">止まっている</span>
    <b style="font-size:27px">${pending.length}件</b>
    <span class="hint" style="margin:0">うち ${overdue.length}件 が ${sla}日 を超えています</span></div>
  <div class="rec" style="margin:0">
    <span class="mono">完了までの平均</span>
    <b style="font-size:27px">${avgDone == null ? "—" : fmtDays(avgDone)}</b>
    <span class="hint" style="margin:0">${done.length}件の実績から</span></div>
  <div class="rec" style="margin:0">
    <span class="mono">この業種の目安</span>
    <b style="font-size:27px">${sla}日</b>
    <span class="hint" style="margin:0">テンプレートの slaDays で設定します</span></div>
</div>`;

  const list = pending.length ? `<table>
  <tr><th>件名</th><th>いまの工程</th><th>止まっている</th><th></th></tr>
  ${pending.map(r => {
    const od = isOverdue(r, t);
    return `<tr>
      <td><b>${esc(r.subject)}</b><br><span class="hint" style="margin:0">${esc(r.counterparty)}</span></td>
      <td>${esc(r.route.steps[r.idx])}</td>
      <td class="mono" style="color:${od ? "var(--red)" : "var(--sub)"};font-weight:${od ? 700 : 400}">
        ${esc(fmtDays(stuckDays(r)))}${od ? " ⚠" : ""}</td>
      <td>${r.nudgedAt
        ? `<span class="badge b-brand">催促済み</span>`
        : `<form method="post" action="/stuck/${S()}/nudge" style="margin:0">
             <input type="hidden" name="id" value="${esc(r.id)}">
             <button class="quiet" style="padding:6px 14px;font-size:13px">催促する</button></form>`}</td>
    </tr>`;
  }).join("")}</table>` : `<p class="hint">止まっている案件はありません。</p>`;

  const table = rows.length ? `<table>
  <tr><th>工程</th><th>滞留中</th><th>平均</th><th>差し戻した回数</th><th>直近の差し戻し理由</th></tr>
  ${rows.map(x => `<tr>
    <td><b>${esc(x.role)}</b></td>
    <td class="mono">${x.n}件</td>
    <td class="mono">${x.n ? esc(fmtDays(x.days / x.n)) : "—"}</td>
    <td class="mono" style="color:${x.rejects ? "var(--red)" : "var(--sub)"}">${x.rejects}回</td>
    <td class="hint" style="margin:0">${esc(x.last) || "—"}</td></tr>`).join("")}</table>` : "";

  res.send(page("詰まり", `
<h2>どこで止まっているか</h2>
<p class="hint">承認フローを入れる目的は、電子化そのものではなく、止まるのを減らすことです。この画面がその答え合わせになります。</p>
${summary}

<h3>いま止まっている案件</h3>
<p class="hint">止まっている時間が長い順です。${sla}日を超えたものに ⚠ が付きます。</p>
${list}

<h3>工程ごとの状況</h3>
<p class="hint">差し戻しが多い工程は、その工程が遅いのではなく、<b>ひとつ手前の書き方に問題がある</b>というサインです。原因は一段前にあります。</p>
${table}
`, [["/stuck/" + S(), "更新"], ["/queue/" + S(), "承認待ち一覧"], ["/my/" + S(), "申請状況"], ["/", "トップ"]]));
});

app.post("/stuck/:secret/nudge", (req, res) => {
  if (!guard(req, res)) return;
  const r = DB.reqs.find(x => x.id === String(req.body.id || ""));
  if (r && r.state === "pending") {
    r.nudgedAt = nowIso();
    save("reqs", "requests");
    // 催促は通知として残す。口頭で急かすと記録が残らず、同じ催促が繰り返される
    notify(r, "nudge", { name: applicantOf(r.tpl).name, role: "申請者" });
  }
  res.redirect(`/stuck/${S()}`);
});

/* ================= 通知ボックス ================= */
app.get("/inbox/:secret", (req, res) => {
  if (!guard(req, res)) return;
  res.send(page("通知ボックス", `
<h2>通知ボックス</h2>
<p class="hint">SLACK_WEBHOOK_URL を設定すると Slack へ飛びます。未設定のあいだは、送ろうとした通知がここに残ります。
外部通信が落ちてもフローを止めない作りなので、確認先としてこの画面を残しています。</p>
${DB.inbox.length ? DB.inbox.map(n => `<div class="rec"><div class="top"><span>${esc(n.text)}</span>
  <span class="mono">${esc(stamp(n.at))}</span></div></div>`).join("")
  : '<p class="hint">まだ通知はありません。</p>'}
`, [["/inbox/" + S(), "更新"], ["/my/" + S(), "申請状況"], ["/", "トップ"]]));
});

/* ===== デモ用の初期データ =====
 * 全業種ぶんを入れる。業種を切り替えた先が空だと、切り替えられること自体が伝わらないため。
 * 時刻を過去にずらしているのは、滞留の日数が出ないと「詰まりが見える」画面が意味を持たないため。 */
const REJECT_REASON = {
  construction: "足場の分離発注先と、保安要員の手配先が未記載です。決まり次第追記してください。",
  manufacturing: "強度計算の根拠が添付されていません。安全率の数値だけでは判断できません。",
  care: "ご本人の意向は書かれていますが、ご家族と合意が取れているかが読み取れません。担当者会議の記録を添えてください。",
  agency: "No.1表示の根拠となる調査の出典が必要です。調査年と対象を明記してください。",
  recruiting: "実績を裏付ける数字が足りません。担当件数か達成率を追記してください。",
};

if (!DB.reqs.length) {
  const ago = (d) => new Date(Date.now() - d * DAY).toISOString();
  for (const id of TPL_IDS) {
    const t = TEMPLATES[id];
    const ms = membersOf(id);
    const applicant = applicantOf(id);
    const byRole = (role) => ms.find(m => m.role === role);
    const samples = t.samples || [];
    const sla = slaOf(t);
    const pick = (i) => {
      const x = samples[i];
      return x && { subject: x.subject, counterparty: x.counterparty, body: x.body, fields: x.fields || {} };
    };

    // ① 全工程を通って完了したもの
    const a = pick(0);
    if (a) {
      const r = buildRequest(t, a, applicant.name, ago(sla + 6));
      DB.reqs.push(r);
      r.route.steps.forEach((step, i) => {
        const m = byRole(step);
        if (m && r.state === "pending") act(r, m, "approve", "", ago(sla + 5 - i * 0.6));
      });
    }

    // ② 差し戻されて、前の工程で止まっているもの(期限超過)
    const b = pick(1);
    if (b) {
      const r = buildRequest(t, b, applicant.name, ago(sla + 4));
      DB.reqs.push(r);
      const first = byRole(r.route.steps[0]);
      const second = byRole(r.route.steps[1]);
      if (first) act(r, first, "approve", "", ago(sla + 3.5));
      if (second) act(r, second, "reject", REJECT_REASON[id] || "追記をお願いします。", ago(sla + 2));
    }

    // ③ 出したばかりのもの
    const c = pick(2);
    if (c) DB.reqs.push(buildRequest(t, c, applicant.name, ago(0.25)));
  }
  DB.reqs.sort((x, y) => new Date(y.createdAt) - new Date(x.createdAt));
  DB.inbox.sort((x, y) => new Date(y.at) - new Date(x.at));
  DB.inbox = DB.inbox.slice(0, 100);
  save("reqs", "requests");
  save("inbox");
  console.log(`[info] デモ用の初期データを ${DB.reqs.length} 件つくりました`);
}

app.listen(PORT, () => console.log(`[info] http://localhost:${PORT}/ で起動しました(合言葉: ${APP_SECRET})`));
