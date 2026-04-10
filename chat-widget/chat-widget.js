(function () {
  'use strict';

  const API_URL = window.LEGEND_CHAT_API_URL || 'https://legend-chat-api-936239225906.asia-northeast1.run.app';

  // CSS定義
  const CSS = `
    #legend-chat-btn {
      position: fixed;
      bottom: 24px;
      right: 24px;
      width: 56px;
      height: 56px;
      background: #2563eb;
      color: white;
      border: none;
      border-radius: 50%;
      font-size: 24px;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(37,99,235,0.4);
      z-index: 9998;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    #legend-chat-btn:hover {
      transform: scale(1.1);
      box-shadow: 0 6px 16px rgba(37,99,235,0.5);
    }
    #legend-chat-panel {
      position: fixed;
      bottom: 92px;
      right: 24px;
      width: 400px;
      height: 600px;
      background: #ffffff;
      border-radius: 16px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.18);
      z-index: 9999;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 14px;
      transition: opacity 0.2s, transform 0.2s;
    }
    #legend-chat-panel.hidden {
      opacity: 0;
      transform: translateY(16px);
      pointer-events: none;
    }
    #legend-chat-header {
      background: #2563eb;
      color: white;
      padding: 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
    }
    #legend-chat-header h3 {
      margin: 0;
      font-size: 15px;
      font-weight: 600;
    }
    #legend-chat-header span {
      font-size: 11px;
      opacity: 0.8;
      margin-top: 2px;
      display: block;
    }
    #legend-chat-close {
      background: none;
      border: none;
      color: white;
      cursor: pointer;
      font-size: 20px;
      line-height: 1;
      padding: 0;
      opacity: 0.8;
    }
    #legend-chat-close:hover { opacity: 1; }
    #legend-chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      background: #f8fafc;
    }
    .legend-msg {
      max-width: 85%;
      line-height: 1.5;
    }
    .legend-msg-user {
      align-self: flex-end;
      background: #2563eb;
      color: white;
      padding: 10px 14px;
      border-radius: 16px 16px 4px 16px;
    }
    .legend-msg-ai {
      align-self: flex-start;
      background: #ffffff;
      color: #1e293b;
      padding: 10px 14px;
      border-radius: 16px 16px 16px 4px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.08);
    }
    .legend-source-card {
      margin-top: 8px;
      padding: 8px 10px;
      border-left: 4px solid #2563eb;
      background: #eff6ff;
      border-radius: 0 8px 8px 0;
      font-size: 12px;
      color: #1e40af;
    }
    .legend-source-card a {
      color: #1d4ed8;
      text-decoration: underline;
    }
    .legend-source-card .source-title {
      font-weight: 600;
      margin-bottom: 2px;
    }
    .legend-source-card .source-summary {
      color: #374151;
      font-size: 11px;
      margin-top: 2px;
    }
    .legend-loading {
      align-self: flex-start;
      display: flex;
      gap: 4px;
      padding: 10px 14px;
      background: white;
      border-radius: 16px 16px 16px 4px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.08);
    }
    .legend-loading span {
      width: 7px;
      height: 7px;
      background: #94a3b8;
      border-radius: 50%;
      animation: legend-bounce 1.2s infinite;
    }
    .legend-loading span:nth-child(2) { animation-delay: 0.2s; }
    .legend-loading span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes legend-bounce {
      0%, 80%, 100% { transform: translateY(0); }
      40% { transform: translateY(-6px); }
    }
    #legend-chat-input-area {
      display: flex;
      gap: 8px;
      padding: 12px;
      border-top: 1px solid #e2e8f0;
      background: white;
      flex-shrink: 0;
    }
    #legend-chat-input {
      flex: 1;
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      padding: 8px 12px;
      font-size: 14px;
      outline: none;
      resize: none;
      font-family: inherit;
      line-height: 1.4;
      max-height: 80px;
      overflow-y: auto;
    }
    #legend-chat-input:focus { border-color: #2563eb; }
    #legend-chat-send {
      background: #2563eb;
      color: white;
      border: none;
      border-radius: 8px;
      padding: 8px 14px;
      cursor: pointer;
      font-size: 18px;
      flex-shrink: 0;
      transition: background 0.15s;
    }
    #legend-chat-send:hover { background: #1d4ed8; }
    #legend-chat-send:disabled { background: #93c5fd; cursor: not-allowed; }
    @media (max-width: 480px) {
      #legend-chat-panel {
        width: calc(100vw - 16px);
        right: 8px;
        bottom: 80px;
        height: 70vh;
      }
    }
  `;

  // スタイル注入
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  // DOM生成
  const btn = document.createElement('button');
  btn.id = 'legend-chat-btn';
  btn.innerHTML = '💬';
  btn.title = '介護制度AIチャット';

  const panel = document.createElement('div');
  panel.id = 'legend-chat-panel';
  panel.className = 'hidden';
  panel.innerHTML = `
    <div id="legend-chat-header">
      <div>
        <h3>介護制度 AIアシスタント</h3>
        <span>レジェンドケアマネ powered by Gemini</span>
      </div>
      <button id="legend-chat-close">✕</button>
    </div>
    <div id="legend-chat-messages">
      <div class="legend-msg legend-msg-ai">こんにちは！介護保険制度や加算・算定要件についてご質問ください。最新の通知・審議会資料をもとに回答します。</div>
    </div>
    <div id="legend-chat-input-area">
      <textarea id="legend-chat-input" placeholder="質問を入力（Shift+Enterで改行）" rows="1"></textarea>
      <button id="legend-chat-send">➤</button>
    </div>
  `;

  document.body.appendChild(btn);
  document.body.appendChild(panel);

  // 参照
  const messagesEl = document.getElementById('legend-chat-messages');
  const inputEl = document.getElementById('legend-chat-input');
  const sendBtn = document.getElementById('legend-chat-send');
  const closeBtn = document.getElementById('legend-chat-close');

  // パネル開閉
  btn.addEventListener('click', () => {
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) {
      inputEl.focus();
    }
  });
  closeBtn.addEventListener('click', () => panel.classList.add('hidden'));

  // メッセージ追加
  function addMessage(type, content) {
    const div = document.createElement('div');
    div.className = `legend-msg legend-msg-${type}`;
    if (typeof content === 'string') {
      div.textContent = content;
    } else {
      div.appendChild(content);
    }
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  // ローディング表示
  function showLoading() {
    const div = document.createElement('div');
    div.className = 'legend-loading';
    div.innerHTML = '<span></span><span></span><span></span>';
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  // AIメッセージ（引用元付き）
  function addAiMessage(answer, sources) {
    const wrapper = document.createElement('div');

    const textDiv = document.createElement('div');
    textDiv.style.whiteSpace = 'pre-wrap';
    textDiv.textContent = answer;
    wrapper.appendChild(textDiv);

    if (sources && sources.length > 0) {
      const sourcesTitle = document.createElement('div');
      sourcesTitle.style.cssText = 'margin-top:10px;font-size:11px;color:#64748b;font-weight:600;';
      sourcesTitle.textContent = `参考資料 (${sources.length}件)`;
      wrapper.appendChild(sourcesTitle);

      sources.forEach(src => {
        const card = document.createElement('div');
        card.className = 'legend-source-card';
        const titleLine = src.url
          ? `<div class="source-title"><a href="${src.url}" target="_blank" rel="noopener">${src.title}${src.vol ? ` Vol.${src.vol}` : ''}</a></div>`
          : `<div class="source-title">${src.title}${src.vol ? ` Vol.${src.vol}` : ''}</div>`;
        card.innerHTML = titleLine;
        if (src.summary) {
          const sum = document.createElement('div');
          sum.className = 'source-summary';
          sum.textContent = src.summary.length > 80 ? src.summary.slice(0, 80) + '…' : src.summary;
          card.appendChild(sum);
        }
        wrapper.appendChild(card);
      });
    }

    addMessage('ai', wrapper);
  }

  // 送信処理
  async function sendMessage() {
    const question = inputEl.value.trim();
    if (!question) return;

    inputEl.value = '';
    inputEl.style.height = 'auto';
    sendBtn.disabled = true;

    addMessage('user', question);
    const loadingEl = showLoading();

    try {
      const res = await fetch(`${API_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: question }),
      });
      const data = await res.json();
      loadingEl.remove();

      if (data.error) {
        addMessage('ai', `エラー: ${data.error}`);
      } else {
        addAiMessage(data.answer, data.sources);
      }
    } catch (e) {
      loadingEl.remove();
      addMessage('ai', 'ネットワークエラーが発生しました。しばらくしてから再試行してください。');
    }

    sendBtn.disabled = false;
    inputEl.focus();
  }

  sendBtn.addEventListener('click', sendMessage);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // テキストエリア自動高さ調整
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 80) + 'px';
  });
})();
