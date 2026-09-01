chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "generate-quiz-menu",
    title: "Generate Quiz from Selection",
    contexts: ["selection"]
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "generate-quiz-menu") {
    chrome.storage.local.set({ selectedText: info.selectionText }, () => {
      console.log("Selected text saved to storage.");
      // Optional: Chrome action openPopup to auto-show popup
      if (chrome.action.openPopup) {
        chrome.action.openPopup();
      }
    });
  }
});
