const HOST_NAME = "com.vantyr.agent";

function sendActiveTab(tab) {
  if (!tab || !tab.active || !tab.url || tab.incognito) return;
  browser.runtime
    .sendNativeMessage(HOST_NAME, {
      type: "active_tab",
      url: tab.url,
      title: tab.title || "",
      browser: navigator.userAgent,
      ts: Math.floor(Date.now() / 1000),
    })
    .catch(() => {
      // Native host may not be installed yet.
    });
}

function queryAndSendActiveTab() {
  browser.tabs.query({ active: true, currentWindow: true }).then(tabs => {
    sendActiveTab(tabs && tabs[0]);
  });
}

browser.tabs.onActivated.addListener(queryAndSendActiveTab);
browser.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" || changeInfo.url || changeInfo.title) {
    sendActiveTab(tab);
  }
});
browser.windows.onFocusChanged.addListener(queryAndSendActiveTab);
