document.addEventListener('DOMContentLoaded', () => {
  // --- 状態管理 ---
  let tabs = [];
  let activeTabId = null;

  // --- DOM要素 ---
  const apiKeyInput = document.getElementById('api-key');
  const tabListEl = document.getElementById('tab-list');
  const addTabBtn = document.getElementById('add-tab-btn');
  const generateBtn = document.getElementById('generate-btn');
  const resultPanel = document.getElementById('state-result');

  // フォーム要素
  const studentNameInput = document.getElementById('student-name');
  const studentGradeSelect = document.getElementById('student-grade');
  const subjectChipsEl = document.getElementById('subject-chips');
  const understandingScaleEl = document.getElementById('understanding-scale');
  const motivationScaleEl = document.getElementById('motivation-scale');
  const testEntriesContainer = document.getElementById('test-entries-container');
  const addTestBtn = document.getElementById('add-test-btn');
  const teacherNotesInput = document.getElementById('teacher-notes');

  // --- 初期化処理 ---
  initAPIKey();
  initScales();
  createNewTab('生徒 1');

  // --- イベントリスナー登録 ---
  addTabBtn.addEventListener('click', () => createNewTab());
  addTestBtn.addEventListener('click', () => addTestEntry());
  generateBtn.addEventListener('click', handleGenerate);

  // APIキーローカルストレージ保持
  apiKeyInput.addEventListener('input', (e) => {
    localStorage.setItem('gemini_api_key', e.target.value.trim());
  });

  // フォーム変更の自動同期（アクティブタブへのデータ保存）
  [studentNameInput, studentGradeSelect, teacherNotesInput].forEach(el => {
    el.addEventListener('input', saveCurrentTabData);
  });

  function initAPIKey() {
    const savedKey = localStorage.getItem('gemini_api_key');
    if (savedKey) {
      apiKeyInput.value = savedKey;
    }
  }

  function initScales() {
    [understandingScaleEl, motivationScaleEl].forEach(container => {
      container.innerHTML = '';
      for (let i = 1; i <= 10; i++) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'scale-btn';
        btn.textContent = i;
        btn.dataset.value = i;
        btn.addEventListener('click', () => {
          container.querySelectorAll('.scale-btn').forEach(b => b.classList.remove('selected'));
          btn.classList.add('selected');
          saveCurrentTabData();
        });
        container.appendChild(btn);
      }
    });

    // 科目チップのクリック設定
    subjectChipsEl.querySelectorAll('.chip').forEach(chip => {
      chip.addEventListener('click', () => {
        chip.classList.toggle('selected');
        saveCurrentTabData();
      });
    });
  }

  // --- タブ管理機能 ---
  function createNewTab(defaultName = '') {
    const tabId = 'tab_' + Date.now();
    const tabName = defaultName || `生徒 ${tabs.length + 1}`;
    
    const newTab = {
      id: tabId,
      name: tabName,
      data: {
        name: '',
        grade: '',
        subjects: [],
        understanding: null,
        motivation: null,
        tests: [],
        notes: '',
        resultHtml: null
      }
    };

    tabs.push(newTab);
    switchTab(tabId);
  }

  function switchTab(tabId) {
    activeTabId = tabId;
    renderTabs();
    loadTabDataToForm();
  }

  function closeTab(tabId, e) {
    e.stopPropagation();
    if (tabs.length <= 1) return; // 最後の1つのタブは削除不可

    tabs = tabs.filter(t => t.id !== tabId);
    if (activeTabId === tabId) {
      activeTabId = tabs[tabs.length - 1].id;
    }
    renderTabs();
    loadTabDataToForm();
  }

  function renderTabs() {
    tabListEl.innerHTML = '';
    tabs.forEach(tab => {
      const tabEl = document.createElement('button');
      tabEl.type = 'button';
      tabEl.className = `tab-item ${tab.id === activeTabId ? 'active' : ''}`;
      
      const displayName = tab.data.name || tab.name;

      tabEl.innerHTML = `
        <i class="ti ti-user-circle"></i>
        <span class="tab-label">${escapeHtml(displayName)}</span>
        ${tabs.length > 1 ? '<button class="tab-close"><i class="ti ti-x"></i></button>' : ''}
      `;

      tabEl.addEventListener('click', () => switchTab(tab.id));
      
      const closeBtn = tabEl.querySelector('.tab-close');
      if (closeBtn) {
        closeBtn.addEventListener('click', (e) => closeTab(tab.id, e));
      }

      tabListEl.appendChild(tabEl);
    });
  }

  // --- フォームデータ ⇄ タブデータ 同期 ---
  function saveCurrentTabData() {
    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab) return;

    tab.data.name = studentNameInput.value.trim();
    tab.data.grade = studentGradeSelect.value;
    
    // 科目
    tab.data.subjects = Array.from(subjectChipsEl.querySelectorAll('.chip.selected'))
      .map(c => c.dataset.value);

    // 評価スケール
    const selectedUnd = understandingScaleEl.querySelector('.scale-btn.selected');
    tab.data.understanding = selectedUnd ? selectedUnd.dataset.value : null;

    const selectedMot = motivationScaleEl.querySelector('.scale-btn.selected');
    tab.data.motivation = selectedMot ? selectedMot.dataset.value : null;

    // テスト結果
    tab.data.tests = [];
    testEntriesContainer.querySelectorAll('.test-entry').forEach(entry => {
      tab.data.tests.push({
        type: entry.querySelector('.test-type-input').value.trim(),
        scores: entry.querySelector('.test-scores').value.trim(),
        isOpen: entry.classList.contains('is-open')
      });
    });

    // 講師メモ
    tab.data.notes = teacherNotesInput.value.trim();

    // タブ名表示更新
    renderTabs();
  }

  function loadTabDataToForm() {
    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab) return;

    studentNameInput.value = tab.data.name || '';
    studentGradeSelect.value = tab.data.grade || '';

    // 科目チップ復元
    subjectChipsEl.querySelectorAll('.chip').forEach(chip => {
      chip.classList.toggle('selected', tab.data.subjects.includes(chip.dataset.value));
    });

    // スケール復元
    understandingScaleEl.querySelectorAll('.scale-btn').forEach(btn => {
      btn.classList.toggle('selected', btn.dataset.value === String(tab.data.understanding));
    });
    motivationScaleEl.querySelectorAll('.scale-btn').forEach(btn => {
      btn.classList.toggle('selected', btn.dataset.value === String(tab.data.motivation));
    });

    // テスト項目復元
    testEntriesContainer.innerHTML = '';
    if (tab.data.tests && tab.data.tests.length > 0) {
      tab.data.tests.forEach(testData => addTestEntry(testData));
    }

    // メモ復元
    teacherNotesInput.value = tab.data.notes || '';

    // 結果表示の復元
    if (tab.data.resultHtml) {
      resultPanel.innerHTML = tab.data.resultHtml;
      attachResultActions();
    } else {
      renderDefaultState();
    }
  }

  // --- テスト結果動的エントリー ---
  function addTestEntry(data = { type: '', scores: '', isOpen: true }) {
    const entryIndex = testEntriesContainer.children.length + 1;
    const entryEl = document.createElement('div');
    entryEl.className = `test-entry ${data.isOpen ? 'is-open' : ''}`;

    entryEl.innerHTML = `
      <div class="test-entry-header">
        <div class="test-header-left">
          <i class="ti ti-chevron-down test-toggle-icon"></i>
          <span class="test-entry-num">テスト結果 #${entryIndex}</span>
          <span class="test-preview">${escapeHtml(data.type || '未入力')}</span>
        </div>
        <button type="button" class="test-remove-btn" title="削除"><i class="ti ti-trash"></i></button>
      </div>
      <div class="test-entry-content">
        <div class="test-field">
          <label class="test-field-label">テスト種別・実施時期</label>
          <input type="text" class="test-type-input" placeholder="例：定期テスト（2学期中間）" value="${escapeHtml(data.type)}">
        </div>
        <div class="test-field">
          <label class="test-field-label">点数・偏差値・結果詳細</label>
          <textarea class="test-scores" placeholder="例：英語 78点, 数学 62点, 国語 85点">${escapeHtml(data.scores)}</textarea>
        </div>
      </div>
    `;

    // アコーディオン開閉
    const header = entryEl.querySelector('.test-entry-header');
    header.addEventListener('click', (e) => {
      if (e.target.closest('.test-remove-btn')) return;
      entryEl.classList.toggle('is-open');
      saveCurrentTabData();
    });

    // 削除ボタン
    entryEl.querySelector('.test-remove-btn').addEventListener('click', () => {
      entryEl.remove();
      updateTestEntryNumbers();
      saveCurrentTabData();
    });

    // 入力同期
    entryEl.querySelectorAll('input, textarea').forEach(input => {
      input.addEventListener('input', () => {
        const preview = entryEl.querySelector('.test-preview');
        const typeVal = entryEl.querySelector('.test-type-input').value;
        preview.textContent = typeVal || '未入力';
        saveCurrentTabData();
      });
    });

    testEntriesContainer.appendChild(entryEl);
    saveCurrentTabData();
  }

  function updateTestEntryNumbers() {
    const entries = testEntriesContainer.querySelectorAll('.test-entry');
    entries.forEach((entry, idx) => {
      entry.querySelector('.test-entry-num').textContent = `テスト結果 #${idx + 1}`;
    });
  }

  // --- API連携 & 生成処理 ---
  async function handleGenerate() {
    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
      alert('Gemini API Keyを入力してください。');
      apiKeyInput.focus();
      return;
    }

    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab || !tab.data.name || !tab.data.grade || tab.data.subjects.length === 0) {
      alert('生徒氏名、学名、指導科目は必須入力です。');
      return;
    }

    // ローディング表示
    renderLoadingState();
    generateBtn.disabled = true;

    try {
      const prompt = buildPrompt(tab.data);
      const responseText = await callGeminiAPI(apiKey, prompt);
      const formattedHtml = parseAIResponseToCards(tab.data, responseText);

      tab.data.resultHtml = formattedHtml;
      resultPanel.innerHTML = formattedHtml;
      attachResultActions();

    } catch (error) {
      console.error(error);
      renderErrorState(error.message);
    } finally {
      generateBtn.disabled = false;
    }
  }

  function buildPrompt(data) {
    return `
あなたは個別指導塾のプロ教室長・講師です。
以下の生徒情報に基づき、保護者・生徒に渡す丁寧で的確な「学習診断レポート」を作成してください。

【生徒情報】
- 生徒氏名: ${data.name}
- 学年: ${data.grade}
- 指導科目: ${data.subjects.join(', ')}
- 授業理解度: ${data.understanding ? data.understanding + '/10' : '未評価'}
- 学習意欲・姿勢: ${data.motivation ? data.motivation + '/10' : '未評価'}
- テスト履歴:
${data.tests.map(t => `  * ${t.type}: ${t.scores}`).join('\n') || '  特になし'}
- 講師所感メモ: ${data.notes || '特になし'}

【出力フォーマット】
以下の5つの項目について、JSON形式で返答してください。Markdownのコードブロック（\`\`\`json）で囲んでください。

{
  "ratingStars": "★★★★☆",
  "overallSummary": "総評・全体的な学習状況のコメント（150文字程度）",
  "urgentPoint": "今すぐ改善・アプローチすべき最優先課題（なければ「特になし」）",
  "strengths": ["強み・褒めるべき点1", "強み・褒めるべき点2", "強み・褒めるべき点3"],
  "improvements": ["課題・伸びしろ1", "課題・伸びしろ2"],
  "parentMessage": "保護者の方へのお礼と今後の方針メッセージ（100〜150文字程度）"
}
    `;
  }

  async function callGeminiAPI(apiKey, prompt) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error?.message || `APIエラー: Status ${response.status}`);
    }

    const json = await response.json();
    return json.candidates[0].content.parts[0].text;
  }

  function parseAIResponseToCards(data, rawText) {
    let parsed = {};
    try {
      const cleanJsonStr = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
      parsed = JSON.parse(cleanJsonStr);
    } catch (e) {
      // JSONパース失敗時のセーフティ
      parsed = {
        ratingStars: "★★★★☆",
        overallSummary: rawText,
        urgentPoint: "",
        strengths: ["日々の指導に真面目に取り組めています"],
        improvements: ["復習習慣の定着を目指します"],
        parentMessage: "引き続き親身にサポートしてまいります。"
      };
    }

    return `
      <div class="result-actions no-print">
        <button type="button" class="action-btn action-btn-primary" onclick="window.print()">
          <i class="ti ti-printer"></i> 印刷 / PDF保存
        </button>
        <button type="button" class="action-btn" id="copy-all-btn">
          <i class="ti ti-copy"></i> テキストを一括コピー
        </button>
      </div>

      <!-- 総合評価 -->
      <div class="result-card card-hero">
        <div class="hero-row">
          <div>
            <div class="hero-name">${escapeHtml(data.name)} 様</div>
            <div class="hero-sub">${escapeHtml(data.grade)} / ${escapeHtml(data.subjects.join('・'))}</div>
          </div>
          <div>
            <div class="score-stars">${parsed.ratingStars || '★★★★☆'}</div>
            <div class="score-label">総合学習評価</div>
          </div>
        </div>
        <div class="card-body">${escapeHtml(parsed.overallSummary)}</div>
      </div>

      <!-- 緊急アプローチ課題（ある場合） -->
      ${parsed.urgentPoint ? `
      <div class="result-card card-urgent">
        <div class="card-label"><i class="ti ti-alert-circle"></i> 優先指導課題</div>
        <div class="card-body">${escapeHtml(parsed.urgentPoint)}</div>
      </div>
      ` : ''}

      <!-- 強み ＆ 改善点 (2カラム) -->
      <div class="two-col">
        <div class="result-card card-strengths">
          <div class="card-label"><i class="ti ti-thumb-up"></i> 伸びている点・強み</div>
          <ul class="diag-list">
            ${(parsed.strengths || []).map(s => `<li>${escapeHtml(s)}</li>`).join('')}
          </ul>
        </div>
        <div class="result-card card-improvements">
          <div class="card-label"><i class="ti ti-trending-up"></i> 今後の課題・伸びしろ</div>
          <ul class="diag-list">
            ${(parsed.improvements || []).map(i => `<li>${escapeHtml(i)}</li>`).join('')}
          </ul>
        </div>
      </div>

      <!-- 保護者メッセージ -->
      <div class="result-card card-neutral">
        <div class="card-label"><i class="ti ti-message-dots"></i> 保護者様へのメッセージ</div>
        <div class="parent-block">${escapeHtml(parsed.parentMessage)}</div>
      </div>
    `;
  }

  function attachResultActions() {
    const copyBtn = document.getElementById('copy-all-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        const textToCopy = resultPanel.innerText.replace(/印刷 \/ PDF保存|テキストを一括コピー/g, '').trim();
        navigator.clipboard.writeText(textToCopy).then(() => {
          copyBtn.innerHTML = '<i class="ti ti-check"></i> コピーしました';
          setTimeout(() => {
            copyBtn.innerHTML = '<i class="ti ti-copy"></i> テキストを一括コピー';
          }, 2000);
        });
      });
    }
  }

  // --- UI状態切り替え ---
  function renderDefaultState() {
    resultPanel.innerHTML = `
      <div class="state">
        <i class="ti ti-notes icon-lg"></i>
        <div class="state-title">診断コメントがここに表示されます</div>
        <div class="state-sub">左側のフォームに必要な情報を入力し、<br>「診断コメントを自動生成」を押してください。</div>
      </div>
    `;
  }

  function renderLoadingState() {
    resultPanel.innerHTML = `
      <div class="state">
        <div class="dots">
          <span></span><span></span><span></span>
        </div>
        <div class="state-title" style="margin-top: 10px;">AIが診断コメントを生成中...</div>
        <div class="state-sub">生徒の学習状況を分析してコメントを作成しています</div>
      </div>
    `;
  }

  function renderErrorState(msg) {
    resultPanel.innerHTML = `
      <div class="error-box">
        <i class="ti ti-alert-triangle icon-lg"></i>
        <div>
          <strong>生成エラーが発生しました</strong><br>
          ${escapeHtml(msg)}
        </div>
      </div>
    `;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
});
