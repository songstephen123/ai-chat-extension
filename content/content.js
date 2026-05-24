// Content script: extracts page content using Readability.js

let pageContent = null;

function extractContent() {
  try {
    const clonedDoc = document.cloneNode(true);
    const reader = new Readability(clonedDoc);
    const article = reader.parse();

    if (article) {
      let text = article.textContent || '';
      // Truncate large content
      const MAX_FRONT = 4000;
      const MAX_END = 1000;
      if (text.length > MAX_FRONT + MAX_END) {
        text = text.slice(0, MAX_FRONT) + '\n\n...[内容已截断]...\n\n' + text.slice(-MAX_END);
      }
      pageContent = {
        title: article.title || document.title,
        text,
        url: window.location.href,
        excerpt: article.excerpt || '',
      };
    } else {
      // Fallback to body text
      pageContent = {
        title: document.title,
        text: document.body.innerText.slice(0, 5000),
        url: window.location.href,
        excerpt: '',
      };
    }
  } catch (e) {
    pageContent = {
      title: document.title,
      text: document.body.innerText.slice(0, 5000),
      url: window.location.href,
      error: e.message,
    };
  }
  return pageContent;
}

// Extract on load
extractContent();

// Re-extract on request
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'get_page_content') {
    // Re-extract in case page changed dynamically
    const content = extractContent();
    sendResponse(content);
  }
  return true; // async response
});
