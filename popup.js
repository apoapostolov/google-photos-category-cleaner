const status = document.getElementById('status');

document.getElementById('show').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    status.textContent = 'No active tab.';
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'pbt-show-panel' });
    status.textContent = 'Panel shown.';
    setTimeout(() => window.close(), 400);
  } catch (e) {
    status.textContent = 'Not a Google Photos page — open photos.google.com first.';
  }
});
