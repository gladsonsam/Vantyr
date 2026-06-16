const HOST_NAME = "com.vantyr.agent";

function sendActiveTab(tab) {
  if (!tab || !tab.active || !tab.url || tab.incognito) return;
  chrome.runtime.sendNativeMessage(
    HOST_NAME,
    {
      type: "active_tab",
      url: tab.url,
      title: tab.title || "",
      browser: navigator.userAgent,
      ts: Math.floor(Date.now() / 1000),
    },
    () => {
      // The native host is optional until Linux packaging installs it. Reading
      // lastError prevents Chrome from surfacing an unchecked runtime error.
      void chrome.runtime.lastError;
    },
  );
}

function queryAndSendActiveTab() {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (chrome.runtime.lastError) return;
    sendActiveTab(tabs && tabs[0]);
  });
}

chrome.tabs.onActivated.addListener(queryAndSendActiveTab);
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" || changeInfo.url || changeInfo.title) {
    sendActiveTab(tab);
  }
});
chrome.windows.onFocusChanged.addListener(queryAndSendActiveTab);
