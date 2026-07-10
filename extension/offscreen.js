chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'offscreen:copy' && message.text) {
    const textarea = document.createElement('textarea');
    textarea.value = message.text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }
});
