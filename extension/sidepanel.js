/*
 * Side panel: shows detail for the active tab. The traffic light itself lives on
 * the toolbar icon; clicking the icon opens this panel AND analyzes the page.
 */
"use strict";

const VLABEL = {
  human: "사람 작성 추정",
  maybe: "판단 보류 (혼재)",
  ai: "AI 작성 의심",
  na: "판별 불가 (한국어 문장 부족)",
  idle: "미분석",
  error: "분석할 수 없는 페이지",
};
const SOURCE_NOTE = {
  selection: "선택한 텍스트를 분석했습니다.",
  readability: "본문(Readability)을 추출해 분석했습니다.",
  fallback: "본문 추출에 실패해 페이지 전체 텍스트로 분석했습니다.",
};

let currentTabId = null;
let currentHost = null;

const $ = (id) => document.getElementById(id);

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs && tabs[0];
}
function hostOf(url) { try { return new URL(url).hostname; } catch (e) { return null; } }
function hostMatches(host, allowlist) {
  host = (host || "").toLowerCase();
  return (allowlist || []).some((entry) => {
    entry = String(entry || "").toLowerCase().replace(/^\.+/, "");
    return entry && (host === entry || host.endsWith("." + entry));
  });
}
const originsFor = (host) => [
  `https://${host}/*`, `http://${host}/*`, `https://*.${host}/*`, `http://*.${host}/*`,
];
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function sentClass(votes, threshold) {
  if (votes >= threshold + 1) return "sent strong";
  if (votes >= threshold) return "sent medium";
  return "sent clean";
}

function renderDetail(data) {
  const summary = $("summary"), empty = $("empty"), detail = $("detail");
  if (!data) {
    summary.hidden = true; detail.hidden = true; empty.hidden = false;
    return;
  }
  empty.hidden = true; summary.hidden = false;

  if (data.error) {
    $("dot").className = "dot error";
    $("vlabel").textContent = VLABEL.error;
    $("ratio").innerHTML = `<span class="muted">chrome:// 페이지, 웹스토어, PDF 등 삽입이 제한된 페이지일 수 있습니다.</span>`;
    detail.hidden = true;
    return;
  }

  const v = data.verdict;
  $("dot").className = "dot " + v;
  $("vlabel").textContent = VLABEL[v] || v;

  if (data.hasKo) {
    const pct = (data.aiRatio * 100).toFixed(1);
    const r = data.report;
    const susp = r.sentences.filter((s) => s.suspicious).length;
    const note = SOURCE_NOTE[data.source] || "";
    $("ratio").innerHTML =
      `AI 의심 비율 <b>${pct}%</b> <span class="muted">(글자수 기준)</span><br>` +
      `<span class="muted">문장 ${r.sentences.length}개 중 ${susp}개 의심 ` +
      `(모델 ${r.nModels}개 중 ${r.voteThreshold}표 이상이면 의심)</span>` +
      (note ? `<br><span class="muted">${note}</span>` : "");

    let html = "";
    for (const s of r.sentences) {
      const cls = sentClass(s.votes, r.voteThreshold);
      const per = Object.keys(s.per)
        .map((n) => `${n}=${s.per[n] > 0 ? "+" : ""}${s.per[n].toFixed(2)}`).join("  ");
      html +=
        `<div class="${cls}">` +
        `<span class="txt"><span class="badge">${s.votes}표</span>${escapeHtml(s.text)}</span>` +
        `<span class="meta">${escapeHtml(per)}</span></div>`;
    }
    $("sentences").innerHTML = html;
    detail.hidden = false;
  } else {
    $("ratio").innerHTML = `<span class="muted">분석 가능한 한국어 문장을 찾지 못했습니다.</span>`;
    detail.hidden = true;
  }
}

async function refresh() {
  const tab = await getActiveTab();
  if (!tab) return;
  currentTabId = tab.id;

  const resp = await chrome.runtime.sendMessage({ type: "AIVH_GET_REPORT", tabId: tab.id });
  const data = resp && resp.data;
  const allowlist = (resp && resp.allowlist) || [];

  // We no longer hold the "tabs" permission, so the tab URL is not readable from
  // here. The URL comes back inside the analysis report (extract.js reports its
  // own location). Until a page is analyzed, the host is unknown.
  const url = data && data.url;
  currentHost = url ? hostOf(url) : null;
  $("host").textContent = url || "이 페이지를 분석하면 주소가 표시됩니다.";

  const auto = $("autotoggle");
  auto.checked = hostMatches(currentHost, allowlist);
  auto.disabled = !currentHost;
  $("analyze").disabled = currentTabId == null; // try anyway; SW handles restricted pages

  renderDetail(data);
}

$("analyze").addEventListener("click", async () => {
  if (currentTabId == null) return;
  const btn = $("analyze");
  btn.disabled = true; btn.textContent = "분석 중…";
  try { await chrome.runtime.sendMessage({ type: "AIVH_REQUEST_ANALYZE", tabId: currentTabId }); }
  finally { btn.textContent = "다시 분석"; btn.disabled = false; }
});

$("autotoggle").addEventListener("change", async (e) => {
  if (!currentHost) return;
  const host = currentHost.toLowerCase();
  if (e.target.checked) {
    // needs a granted host permission to auto-run without a click
    const ok = await chrome.permissions.request({ origins: originsFor(host) });
    if (!ok) { e.target.checked = false; return; }
  } else {
    chrome.permissions.remove({ origins: originsFor(host) }).catch(() => {});
  }
  const { allowlist = [] } = await chrome.storage.sync.get("allowlist");
  const set = new Set(allowlist.map((h) => String(h).toLowerCase()));
  if (e.target.checked) set.add(host); else set.delete(host);
  await chrome.storage.sync.set({ allowlist: Array.from(set).sort() });
});

$("openopts").addEventListener("click", () => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "AIVH_REPORT_UPDATED" && msg.tabId === currentTabId) refresh();
});
chrome.tabs.onActivated.addListener(refresh);
if (chrome.windows && chrome.windows.onFocusChanged) chrome.windows.onFocusChanged.addListener(refresh);

refresh();
