chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'copy') return;
  const t = document.getElementById('t');
  t.value = msg.text;
  t.select();
  document.execCommand('copy');
});
