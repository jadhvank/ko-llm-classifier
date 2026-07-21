"use strict";

function $(id) { return document.getElementById(id); }

function normalizeHost(raw) {
  let h = String(raw || "").trim().toLowerCase();
  if (!h) return "";
  // accept a pasted URL too
  if (h.includes("://")) {
    try { h = new URL(h).hostname; } catch (e) { /* keep as-is */ }
  }
  h = h.replace(/^\.+/, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
  return h;
}

const originsFor = (host) => [
  `https://${host}/*`, `http://${host}/*`, `https://*.${host}/*`, `http://*.${host}/*`,
];

async function getList() {
  const { allowlist = [] } = await chrome.storage.sync.get("allowlist");
  return allowlist;
}
async function setList(list) {
  await chrome.storage.sync.set({ allowlist: Array.from(new Set(list)).sort() });
}

function render(list) {
  const ul = $("list");
  ul.innerHTML = "";
  if (!list.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "등록된 도메인이 없습니다.";
    ul.appendChild(li);
    return;
  }
  for (const host of list) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.className = "h";
    span.textContent = host;
    const btn = document.createElement("button");
    btn.className = "ghost";
    btn.textContent = "삭제";
    btn.addEventListener("click", async () => {
      chrome.permissions.remove({ origins: originsFor(host) }).catch(() => {});
      const next = (await getList()).filter((h) => h !== host);
      await setList(next);
      render(next);
    });
    li.appendChild(span);
    li.appendChild(btn);
    ul.appendChild(li);
  }
}

async function add() {
  const host = normalizeHost($("host").value);
  if (!host) return;
  // auto-run needs a granted host permission (requested in this user gesture)
  const ok = await chrome.permissions.request({ origins: originsFor(host) });
  if (!ok) return;
  const list = await getList();
  if (!list.includes(host)) list.push(host);
  await setList(list);
  $("host").value = "";
  render(await getList());
}

$("add").addEventListener("click", add);
$("host").addEventListener("keydown", (e) => { if (e.key === "Enter") add(); });

getList().then(render);
