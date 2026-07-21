/*
 * Background service worker (classic, so importScripts works).
 *
 * No "tabs" permission. Extraction always runs in the page via extract.js:
 *  - manual: chrome.scripting.executeScript on the clicked tab (activeTab grant)
 *  - auto:   extract.js registered as a content script on user-approved domains
 *            (chrome.scripting.registerContentScripts), so page load triggers it
 * Both paths funnel the extracted text back through the AIVH_ANALYZE_TEXT message,
 * and the content script reports its own location — no tab URL reads needed.
 *
 * Per-tab report lives in chrome.storage.session (survives SW restarts).
 */
importScripts("vendor/aivh-core.js"); // -> globalThis.AIVH

let MODEL = null;
async function getModel() {
  if (MODEL) return MODEL;
  const res = await fetch(chrome.runtime.getURL("model.json"));
  MODEL = await res.json();
  return MODEL;
}

// ---- toolbar icon (traffic light) --------------------------------------------
const ICON_COLOR = { human: "green", maybe: "yellow", ai: "red", na: "gray", idle: "gray", error: "gray" };
const BADGE_BG = { human: "#16a34a", maybe: "#d97706", ai: "#dc2626", na: "#6b7280", idle: "#6b7280", error: "#6b7280" };

function iconPaths(color) {
  return {
    16: `icons/tl-${color}-16.png`,
    32: `icons/tl-${color}-32.png`,
    48: `icons/tl-${color}-48.png`,
    128: `icons/tl-${color}-128.png`,
  };
}

async function setAction(tabId, verdict, ratio, title) {
  const color = ICON_COLOR[verdict] || "gray";
  try { await chrome.action.setIcon({ tabId, path: iconPaths(color) }); } catch (e) {}
  try {
    if (verdict !== "na" && verdict !== "idle" && verdict !== "error" && ratio != null) {
      await chrome.action.setBadgeText({ tabId, text: String(Math.round(ratio * 100)) });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_BG[verdict] });
      if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ tabId, color: "#ffffff" });
    } else if (verdict === "na" || verdict === "error") {
      await chrome.action.setBadgeText({ tabId, text: "?" });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_BG.na });
    } else {
      await chrome.action.setBadgeText({ tabId, text: "" });
    }
    if (title) await chrome.action.setTitle({ tabId, title });
  } catch (e) {}
}

// ---- per-tab report store ----------------------------------------------------
const keyFor = (tabId) => "tab_" + tabId;
const storeReport = (tabId, data) => chrome.storage.session.set({ [keyFor(tabId)]: data });
async function loadReport(tabId) {
  const o = await chrome.storage.session.get(keyFor(tabId));
  return o[keyFor(tabId)] || null;
}
const clearReport = (tabId) => chrome.storage.session.remove(keyFor(tabId));

// ---- scoring (shared by manual + auto) ---------------------------------------
async function scoreAndStore(tabId, out) {
  const model = await getModel();
  const report = AIVH.scoreDocument((out && out.text) || "", model);
  const hasKo = report.sentences.length > 0;
  const verdict = hasKo ? report.verdict : "na";
  const pct = Math.round(report.aiRatio * 100);
  await storeReport(tabId, {
    verdict, aiRatio: report.aiRatio, hasKo, report,
    url: out && out.url, title: out && out.title, source: out && out.source, ts: Date.now(),
  });
  await setAction(tabId, verdict, hasKo ? report.aiRatio : null,
    hasKo ? `AI 의심 ${pct}% — 클릭해 상세` : "판별 불가 (한국어 문장 부족) — 클릭해 상세");
  chrome.runtime.sendMessage({ type: "AIVH_REPORT_UPDATED", tabId }).catch(() => {});
}

// manual: inject extractor into a tab; extract.js will send AIVH_ANALYZE_TEXT back
async function runAnalysis(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["vendor/Readability.js", "extract.js"],
    });
  } catch (e) {
    await storeReport(tabId, { error: String((e && e.message) || e), ts: Date.now() });
    await setAction(tabId, "error", null, "이 페이지는 분석할 수 없습니다");
    chrome.runtime.sendMessage({ type: "AIVH_REPORT_UPDATED", tabId }).catch(() => {});
  }
}

// ---- auto domains: dynamic content-script registration -----------------------
const scriptIdFor = (host) => "auto_" + host.replace(/[^a-z0-9.-]/gi, "_");
const matchesFor = (host) => [
  `https://${host}/*`, `http://${host}/*`, `https://*.${host}/*`, `http://*.${host}/*`,
];
const originsFor = (host) => matchesFor(host); // same patterns work as permission origins

function hostMatches(host, allowlist) {
  host = (host || "").toLowerCase();
  return (allowlist || []).some((entry) => {
    entry = String(entry || "").toLowerCase().replace(/^\.+/, "");
    return entry && (host === entry || host.endsWith("." + entry));
  });
}

// register extract.js on every allowlisted domain we hold host permission for,
// and drop registrations that are no longer wanted/permitted.
async function reconcileAutoScripts() {
  const { allowlist = [] } = await chrome.storage.sync.get("allowlist");
  const existing = await chrome.scripting.getRegisteredContentScripts().catch(() => []);
  const existingIds = new Set(existing.map((s) => s.id));

  const wanted = [];
  for (const host of allowlist) {
    const granted = await chrome.permissions.contains({ origins: originsFor(host) }).catch(() => false);
    if (granted) wanted.push(host);
  }
  const wantedIds = new Set(wanted.map(scriptIdFor));

  const stale = existing
    .filter((s) => s.id.startsWith("auto_") && !wantedIds.has(s.id))
    .map((s) => s.id);
  if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale }).catch(() => {});

  const toAdd = wanted
    .filter((h) => !existingIds.has(scriptIdFor(h)))
    .map((h) => ({
      id: scriptIdFor(h),
      matches: matchesFor(h),
      js: ["vendor/Readability.js", "extract.js"],
      runAt: "document_idle",
      allFrames: false,
    }));
  if (toAdd.length) await chrome.scripting.registerContentScripts(toAdd).catch((e) => console.warn("register failed", e));
}

// ---- messages ----------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case "AIVH_ANALYZE_TEXT": {
        const tabId = sender.tab && sender.tab.id;
        if (tabId != null) await scoreAndStore(tabId, msg);
        break;
      }
      case "AIVH_GET_REPORT": {
        const data = await loadReport(msg.tabId);
        const { allowlist = [] } = await chrome.storage.sync.get("allowlist");
        sendResponse({ data, allowlist });
        break;
      }
      case "AIVH_REQUEST_ANALYZE": {
        await runAnalysis(msg.tabId);
        sendResponse({ ok: true });
        break;
      }
      default:
        break;
    }
  })();
  return true; // async sendResponse
});

// open the side panel AND analyze the current tab on toolbar click (no popup).
// activeTab is granted by this click, so executeScript works on any tab.
chrome.action.onClicked.addListener((tab) => {
  if (tab && tab.id != null) {
    chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
    runAnalysis(tab.id);
  }
});

// reset the icon when a tab starts loading a new document (status needs no perms)
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") {
    clearReport(tabId);
    setAction(tabId, "idle", null, "AI 텍스트 판별 — 클릭하면 분석");
  }
});
chrome.tabs.onRemoved.addListener((tabId) => clearReport(tabId));

// keep auto registrations in sync with the allowlist + granted permissions
chrome.runtime.onInstalled.addListener(reconcileAutoScripts);
chrome.runtime.onStartup.addListener(reconcileAutoScripts);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.allowlist) reconcileAutoScripts();
});
if (chrome.permissions.onAdded) chrome.permissions.onAdded.addListener(reconcileAutoScripts);
if (chrome.permissions.onRemoved) chrome.permissions.onRemoved.addListener(reconcileAutoScripts);
