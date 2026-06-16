const HOST_NAME = "com.vantyr.agent";

function runtimeApi() {
  return typeof browser !== "undefined" ? browser : chrome;
}

function sendActiveTab(tab) {
  if (!tab || !tab.active || !tab.url) return;
  if (tab.incognito) return;

  const payload = {
    type: "active_tab",
    url: tab.url,
    title: tab.title || "",
    browser: navigator.userAgent,
    ts: Math.floor(Date.now() / 1000),
  };

  try {
    if (typeof browser !== "undefined") {
      browser.runtime.sendNativeMessage(HOST_NAME, payload).catch(() => {});
    } else {
      chrome.runtime.sendNativeMessage(HOST_NAME, payload, () => {
        void chrome.runtime.lastError;
      });
    }
  } catch (_err) {
    // Native host may not be installed yet. Drop silently; the agent capability
    // remains unsupported until packaging wires the host.
  }
}

function queryAndSendActiveTab() {
  runtimeApi().tabs.query({ active: true, currentWindow: true }, tabs => {
    if (runtimeApi().runtime.lastError) return;
    sendActiveTab(tabs && tabs[0]);
  });
}

runtimeApi().tabs.onActivated.addListener(queryAndSendActiveTab);
runtimeApi().tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" || changeInfo.url || changeInfo.title) {
    sendActiveTab(tab);
  }
});
runtimeApi().windows.onFocusChanged.addListener(queryAndSendActiveTab);
