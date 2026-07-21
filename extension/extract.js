/*
 * Unified page extractor. Runs in the page's isolated world for BOTH paths:
 *  - manual: injected on demand via chrome.scripting.executeScript (with activeTab)
 *  - auto:   registered as a content script on user-approved domains
 * Readability is injected/registered right before this file.
 *
 * It reads the article text (selection first, then Readability, then a body
 * fallback) and hands it to the service worker. The content script knows its own
 * location, so no "tabs" permission is needed to learn the URL.
 */
(function () {
  "use strict";

  function pick(text, title, url, source) {
    return { text: text || "", title: title || document.title, url: url || location.href, source: source };
  }

  function extract() {
    try {
      var sel = (window.getSelection && window.getSelection().toString()) || "";
      sel = sel.trim();
      if (sel.length >= 40) return pick(sel, document.title, location.href, "selection");

      if (typeof Readability === "function") {
        var art = new Readability(document.cloneNode(true)).parse();
        if (art && art.textContent && art.textContent.trim().length >= 40) {
          return pick(art.textContent, art.title, location.href, "readability");
        }
      }
      return pick(document.body ? document.body.innerText : "", document.title, location.href, "fallback");
    } catch (e) {
      return pick(document.body ? document.body.innerText : "", document.title, location.href, "error:" + String(e));
    }
  }

  var out = extract();
  chrome.runtime.sendMessage({
    type: "AIVH_ANALYZE_TEXT",
    text: out.text,
    title: out.title,
    url: out.url,
    source: out.source,
  });
})();
