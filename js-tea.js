/* ===========================
   Step 2: localStorage データ管理関数
=========================== */

// 1. 生徒データの読み込み（なければ初期データを生成）
function getStudentData(studentId) {
  const key = `student_data_${studentId}`;
  const jsonStr = localStorage.getItem(key);

  if (!jsonStr) {
    // データが存在しない場合の初期オブジェクト構造
    return {
      studentId: studentId,
      createdAt: new Date().toISOString().split('T')[0],
      updatedAt: new Date().toISOString().split('T')[0],
      basicInfo: {
        name: '',
        grade: '',
        subjects: [],
        goal: '',
        initialConcerns: ''
      },
      lessonLogs: [],
      aiDiagnostics: []
    };
  }

  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error("データのパースエラー:", e);
    return null;
  }
}

// 2. 生徒データの保存
function saveStudentData(studentData) {
  if (!studentData || !studentData.studentId) return;
  
  // 最終更新日を更新
  studentData.updatedAt = new Date().toISOString().split('T')[0];
  
  const key = `student_data_${studentData.studentId}`;
  localStorage.setItem(key, JSON.stringify(studentData));
}

// 3. 授業ログ（日々の指導レポート）を追加して保存する関数
function addLessonLog(studentId, logData) {
  const data = getStudentData(studentId);
  
  const newLog = {
    logId: `log_${Date.now()}`,
    date: logData.date || new Date().toISOString().split('T')[0],
    subject: logData.subject || '',
    unit: logData.unit || '',
    comprehension: Number(logData.comprehension) || 5,
    attitude: logData.attitude || '',
    instructorNotes: logData.instructorNotes || '',
    homeworkStatus: logData.homeworkStatus || ''
  };

  data.lessonLogs.push(newLog);
  saveStudentData(data);
  return data;
}

// 4. 生成されたAI診断結果を履歴に追加して保存する関数
function addAIDiagnostics(studentId, aiResult) {
  const data = getStudentData(studentId);
  
  const newDiag = {
    diagId: `diag_${Date.now()}`,
    date: new Date().toISOString().split('T')[0],
    ...aiResult
  };

  data.aiDiagnostics.push(newDiag);
  saveStudentData(data);
  return data;
}

/* ===========================
   使用モデル
   gemini-3.5-flash（無料枠あり）
   ※ Google AI Studio で取得した APIキーを使用
   https://aistudio.google.com/app/apikey
=========================== */
const GEMINI_MODEL    = 'gemini-3.5-flash';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;


/* ===========================
   フォームフィールド一覧
=========================== */
const FIELD_IDS = [
  'f-name', 'f-grade', 
  'f-comp',
  'f-attitude',
  'f-goal', 'f-concerns', 'f-notes',
];

/* ===========================
   テスト種類の入力サジェスト候補
=========================== */
const TEST_TYPE_SUGGESTIONS = [
  '定期テスト', '実力テスト', '全統記述模試', '全統共通テスト模試', 
  '進研模試', '駿台模試', '駿台ベネッセ共通テスト模試', '全国統一高校生テスト', '全国統一中学生テスト', '共通テスト本番レベル模試', '冠模試', '英検', '漢検', '数検'
];

/* ===========================
   生徒データ管理
=========================== */
let studentCounter = 1;
let currentIndex   = 0;
let students       = [createStudent()];

function createTestEntry() {
  // type(種類)、grade(対応学年)、date(実施日)、scores(点数) に変更
  return { type: '', grade: '', date: '', scores: '' };
}

function createStudent() {
  const num  = studentCounter++;
  const data = {};
  FIELD_IDS.forEach(id => { data[id] = ''; });
  data.subjects = [];
  data.tests    = [createTestEntry()]; // テスト結果を配列で管理
  return {
    id:          Date.now() + Math.random(),
    defaultName: `生徒 ${num}`,
    tabName:     `生徒 ${num}`,
    data,
    result: null,
  };
}

/* ===========================
   フォーム保存・復元
=========================== */
function saveCurrentForm() {
  const s = students[currentIndex];
  FIELD_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (el) s.data[id] = el.value;
  });
  s.data.subjects = [...selectedSubjects];
  s.data.tests    = collectTestEntries();
}

function restoreForm(s) {
  FIELD_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = s.data[id] || '';
  });

  updateScaleUI(s.data['f-comp'] || '');

  selectedSubjects.clear();
  (s.data.subjects || []).forEach(v => selectedSubjects.add(v));
  document.querySelectorAll('#subjects .chip').forEach(chip => {
    chip.classList.toggle('selected', selectedSubjects.has(chip.dataset.val));
  });

  const tests = (s.data.tests && s.data.tests.length > 0)
    ? s.data.tests
    : [createTestEntry()];
  renderTestList(tests);

  if (s.result) {
    renderResult(s.result, buildFormData());
    showState('state-result');
  } else {
    showState('state-empty');
  }
}

/* ===========================
   タブ描画・操作・ユーティリティ等は変更なし
=========================== */
function renderTabs() {
  const list = document.getElementById('tab-list');
  list.innerHTML = '';
  students.forEach((s, i) => {
    const tab = document.createElement('button');
    tab.className = 'tab-item' + (i === currentIndex ? ' active' : '');
    tab.setAttribute('data-idx', i);
    tab.type = 'button';
    tab.innerHTML = `
      <i class="ti ti-user-circle"></i>
      <span class="tab-label">${escapeHtml(s.tabName)}</span>
      ${students.length > 1
        ? `<span class="tab-close" data-idx="${i}" title="削除"><i class="ti ti-x"></i></span>`
        : ''}
    `;
    tab.addEventListener('click', e => {
      if (e.target.closest('.tab-close')) return;
      switchTab(i);
    });
    const closeBtn = tab.querySelector('.tab-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', e => {
        e.stopPropagation();
        removeStudent(i);
      });
    }
    list.appendChild(tab);
  });
  const activeTab = list.querySelector('.tab-item.active');
  if (activeTab) {
    activeTab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }
}

function switchTab(idx) {
  saveCurrentForm();
  currentIndex = idx;
  renderTabs();
  restoreForm(students[currentIndex]);
}

function addStudent() {
  saveCurrentForm();
  students.push(createStudent());
  currentIndex = students.length - 1;
  renderTabs();
  restoreForm(students[currentIndex]);
  const list = document.getElementById('tab-list');
  setTimeout(() => { list.scrollLeft = list.scrollWidth; }, 50);
}

function removeStudent(idx) {
  if (students.length === 1) return;
  students.splice(idx, 1);
  if (currentIndex >= students.length) currentIndex = students.length - 1;
  renderTabs();
  restoreForm(students[currentIndex]);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showInlineError(message) {
  const errEl = document.getElementById('state-error');
  errEl.innerHTML = `
    <div class="error-box">
      <i class="ti ti-alert-triangle"></i>
      <span>${message}</span>
    </div>
  `;
  showState('state-error');
}

function updateScaleUI(val) {
  document.querySelectorAll('#comp-scale .scale-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.val === String(val));
  });
}

document.querySelectorAll('#comp-scale .scale-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const val = btn.dataset.val;
    document.getElementById('f-comp').value = val;
    updateScaleUI(val);
  });
});

const selectedSubjects = new Set();
document.querySelectorAll('#subjects .chip').forEach(chip => {
  chip.addEventListener('click', () => {
    const val = chip.dataset.val;
    if (selectedSubjects.has(val)) {
      selectedSubjects.delete(val);
      chip.classList.remove('selected');
    } else {
      selectedSubjects.add(val);
      chip.classList.add('selected');
    }
  });
});

document.getElementById('f-name').addEventListener('input', e => {
  const name = e.target.value.trim();
  students[currentIndex].tabName = name || students[currentIndex].defaultName;
  const labels = document.querySelectorAll('#tab-list .tab-label');
  if (labels[currentIndex]) {
    labels[currentIndex].textContent = students[currentIndex].tabName;
  }
});

function getVal(id) {
  const el = document.getElementById(id);
  return el ? el.value.trim() : '';
}

function buildFormData() {
  const compVal = getVal('f-comp');

  // テストエントリーをAIプロンプト用テキストに変換
  const tests       = collectTestEntries();
  const filledTests = tests.filter(t => t.scores || t.type);
  let scoresText    = '未入力';

  if (filledTests.length > 0) {
    scoresText = filledTests.map((t, i) => {
      const parts  = [];
      if (t.type) parts.push(t.type);
      if (t.grade) parts.push(`対象: ${t.grade}`);
      if (t.date) parts.push(`実施日: ${t.date}`);
      const label  = parts.length > 0 ? `[${parts.join(' / ')}]` : `[テスト${i + 1}]`;
      return t.scores ? `${label}\n${t.scores}` : label;
    }).join('\n\n');
  }

  return {
    name:     getVal('f-name')     || '未入力',
    grade:    getVal('f-grade')    || '未入力',
    subjects: [...selectedSubjects].join('、') || '未入力',
    scores:   scoresText,
    comp:     compVal ? `${compVal} / 10` : '未入力',
    attitude: getVal('f-attitude') || '未入力',
    goal:     getVal('f-goal')     || '未入力',
    concerns: getVal('f-concerns') || '未入力',
    notes:    getVal('f-notes')    || '未入力',
  };
}

function showState(id) {
  ['state-empty', 'state-loading', 'state-error', 'state-result'].forEach(s => {
    document.getElementById(s).style.display = (s === id) ? '' : 'none';
  });
}

/* ===========================
   テストエントリー管理
=========================== */
/* ===========================
   テストエントリー管理
=========================== */

function renderTestList(tests) {
  const list = document.getElementById('test-list');
  list.innerHTML = '';
  tests.forEach((t, i) => {
    const el = createTestEntryElement(t, i);
    // 最後（最新）のエントリー以外は初期状態で折りたたむ
    if (i !== tests.length - 1) {
      el.classList.remove('is-open');
    }
    list.appendChild(el);
  });
}

/** 1件のテストエントリー要素を生成してイベントをバインドする */
function createTestEntryElement(test, idx) {
  const div      = document.createElement('div');
  // デフォルトで 'is-open' を付与して開いた状態にする
  div.className  = 'test-entry is-open';

  // ヘッダーとコンテンツ（.test-entry-content）に分割
  div.innerHTML = `
    <div class="test-entry-header" title="クリックで開閉">
      <div class="test-header-left">
        <i class="ti ti-chevron-down test-toggle-icon"></i>
        <span class="test-entry-num">テスト ${idx + 1}</span>
        <span class="test-preview"></span>
      </div>
      <button class="test-remove-btn" type="button" title="このテストを削除">
        <i class="ti ti-trash"></i>
      </button>
    </div>

    <div class="test-entry-content">
      <div class="test-field">
        <label class="test-field-label">試験の種類</label>
        <input type="text" class="test-type-input" placeholder="例：全統記述模試、定期テスト" value="${escapeHtml(test.type || '')}" list="test-type-list-${idx}">
        <datalist id="test-type-list-${idx}">
          ${TEST_TYPE_SUGGESTIONS.map(t => `<option value="${escapeHtml(t)}"></option>`).join('')}
        </datalist>
      </div>

      <div class="test-field">
        <label class="test-field-label">模試対応学年</label>
        <select class="test-grade-select">
          <option value="">選択しない</option>
          ${['小1','小2','小3','小4','小5','小6','中1','中2','中3','高1','高2','高3','高卒・浪人'].map(g => 
            `<option value="${g}" ${g === test.grade ? 'selected' : ''}>${g}</option>`
          ).join('')}
        </select>
      </div>

      <div class="test-field">
        <label class="test-field-label">実施日</label>
        <input type="date" class="test-date-input" value="${escapeHtml(test.date || '')}">
      </div>

      <div class="test-field">
        <label class="test-field-label">点数・結果</label>
        <textarea class="test-scores" placeholder="例：数学 75点、偏差値 55.2">${escapeHtml(test.scores || '')}</textarea>
      </div>
    </div>
  `;

  // ── プレビューの更新処理 ──
  const previewSpan = div.querySelector('.test-preview');
  function updatePreview() {
    const type = div.querySelector('.test-type-input').value.trim();
    const scores = div.querySelector('.test-scores').value.trim();
    let previewText = '';
    if (type) previewText += type;
    if (scores) previewText += (previewText ? ' - ' : '') + scores.replace(/\n/g, ' '); // 改行をスペースに
    previewSpan.textContent = previewText || '(未入力)';
  }

  // 各入力項目の変更時にプレビューを更新
  div.querySelectorAll('.test-type-input, .test-scores').forEach(el => {
    el.addEventListener('input', updatePreview);
  });
  updatePreview(); // 初期化時に一度実行

  // ── 開閉処理 ──
  const header = div.querySelector('.test-entry-header');
  header.addEventListener('click', (e) => {
    // 削除ボタンをクリックした場合は開閉させない
    if (e.target.closest('.test-remove-btn')) return;
    div.classList.toggle('is-open');
  });

  // ── 削除ボタン ──
  div.querySelector('.test-remove-btn').addEventListener('click', (e) => {
    e.stopPropagation(); // 開閉イベントの発火を防ぐ
    const list = document.getElementById('test-list');
    div.remove();
    renumberTestEntries();
    // 全件削除された場合は空のエントリーを自動追加
    if (!list.querySelector('.test-entry')) {
      list.appendChild(createTestEntryElement(createTestEntry(), 0));
    }
  });

  return div;
}

/** DOM からテストエントリーデータを収集する */
function collectTestEntries() {
  const entries = [];
  document.querySelectorAll('#test-list .test-entry').forEach(entryEl => {
    const type   = entryEl.querySelector('.test-type-input')?.value.trim() || '';
    const grade  = entryEl.querySelector('.test-grade-select')?.value || '';
    const date   = entryEl.querySelector('.test-date-input')?.value || '';
    const scores = entryEl.querySelector('.test-scores')?.value.trim() || '';
    entries.push({ type, grade, date, scores });
  });
  return entries;
}

function renumberTestEntries() {
  document.querySelectorAll('#test-list .test-entry').forEach((el, i) => {
    const numEl = el.querySelector('.test-entry-num');
    if (numEl) numEl.textContent = `テスト ${i + 1}`;
  });
}

// テスト追加ボタンの処理
document.getElementById('test-add-btn').addEventListener('click', () => {
  const list = document.getElementById('test-list');
  
  // 既存のすべてのテストエントリーを折りたたむ
  list.querySelectorAll('.test-entry').forEach(entry => {
    entry.classList.remove('is-open');
  });

  // 新しいエントリーを追加（デフォルトで開いている）
  const newIdx = list.querySelectorAll('.test-entry').length;
  list.appendChild(createTestEntryElement(createTestEntry(), newIdx));
  
  // スクロール処理
  const panel = document.getElementById('form-panel');
  setTimeout(() => {
    panel.scrollTo({ top: panel.scrollHeight, behavior: 'smooth' });
  }, 50);
});


/* ===========================
   AI診断レポートを生成する（日付選択 ＆ 構造化出力で100%安定化）
=========================== */
document.getElementById('gen-btn').addEventListener('click', async () => {
  const apiKey = document.getElementById('api-key')?.value.trim();
  if (!apiKey) {
    showInlineError(
      'APIキーを入力してください。<br>' +
      '<small><a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer" style="color:inherit;">Google AI Studio で無料取得できます →</a></small>'
    );
    return;
  }

  const btn = document.getElementById('gen-btn');
  btn.disabled = true;
  btn.innerHTML = '<i class="ti ti-loader-2"></i> AIが分析中...';
  showState('state-loading');

  const formData = buildFormData();

  // ----------------------------------------------------
  // 日付の設定（フォームで指定がなければ今日の日付）
  // ----------------------------------------------------
  const lessonDate = formData.date || new Date().toISOString().split('T')[0];
  const studentId  = 'std_' + encodeURIComponent(formData.name || 'default');
  
  // 過去データの取得
  const pastData     = getStudentData(studentId);
  const previousLogs = pastData ? pastData.lessonLogs.slice(-3) : [];
  const lastDiag     = (pastData && pastData.aiDiagnostics.length > 0)
    ? pastData.aiDiagnostics[pastData.aiDiagnostics.length - 1]
    : null;

  // 今回の授業レポートを履歴に追加・保存（指定した授業日を使用）
  addLessonLog(studentId, {
    date: lessonDate,
    subject: formData.subjects,
    unit: formData.scores,
    comprehension: formData.comp,
    attitude: formData.attitude,
    instructorNotes: formData.notes
  });

  // ----------------------------------------------------
  // 高精度プロンプトの構築
  // ----------------------------------------------------
  const prompt = `
あなたはプロの教育コンサルタント・塾講師です。
生徒の基本情報、過去の学習変化、今回の授業内容を踏まえ、保護者も納得する高品質な診断レポートを作成してください。

【生徒情報】
名前: ${formData.name}
学年: ${formData.grade}
担当科目: ${formData.subjects}
目標: ${formData.goal}
現在の課題: ${formData.concerns}

【前回のAI診断結果】
${lastDiag ? `前回の総合スコア: ${lastDiag.overallScore} / 5\n前回の所見: ${lastDiag.overallComment}` : '過去のAI診断履歴はありません（初回診断）'}

【直近の指導経過】
${previousLogs.length > 0 ? previousLogs.map((log, index) => `
${index + 1}. [${log.date}] 科目: ${log.subject} / 理解度: ${log.comprehension}/10
   所見: ${log.instructorNotes}
`).join('') : '過去の授業ログはありません'}

【今回の授業レポート (${lessonDate})】
理解度（10段階）: ${formData.comp}
テスト・単元結果: ${formData.scores}
学習態度・自習状況: ${formData.attitude}
講師メモ: ${formData.notes}

【指示】
- 過去のデータと比較し、「成長できた点」「継続して取り組む課題」を具体的に述べてください。
- 保護者向けメッセージは丁寧で前向き、そのまま面談や連絡帳で渡せるクオリティにしてください。
`.trim();

  try {
    // ----------------------------------------------------
    // API呼び出し（Structured Outputs でJSON型を100%強制）
    // ----------------------------------------------------
    const response = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3, // 揺らぎを抑えてフォーマットを安定化
          maxOutputTokens: 2048,
          responseMimeType: "application/json",
          // ★構造化出力（JSONの型を絶対に崩さない設定）
          responseSchema: {
            type: "OBJECT",
            properties: {
              overallScore: { type: "INTEGER" },
              overallComment: { type: "STRING" },
              strengths: { type: "ARRAY", items: { type: "STRING" } },
              improvements: { type: "ARRAY", items: { type: "STRING" } },
              weeklyPlan: { type: "STRING" },
              monthlyPlan: { type: "STRING" },
              instructorAdvice: { type: "STRING" },
              parentMessage: { type: "STRING" },
              urgentAction: { type: "STRING" }
            },
            required: [
              "overallScore", "overallComment", "strengths", "improvements",
              "weeklyPlan", "monthlyPlan", "instructorAdvice", "parentMessage", "urgentAction"
            ]
          }
        },
      }),
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      const msg = errBody?.error?.message || `${response.status} ${response.statusText}`;
      throw new Error(msg);
    }

    const data    = await response.json();
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // レスポンスのクリーンアップ＆パース
    const clean  = rawText.replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);

    // AI診断結果を保存
    addAIDiagnostics(studentId, result);

    students[currentIndex].result = result;
    renderResult(result, formData);
    showState('state-result');

  } catch (err) {
    showInlineError(
      '診断の生成に失敗しました。APIキーとネットワーク接続を確認してください。<br>' +
      `<small>${escapeHtml(err.message)}</small>`
    );
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="ti ti-sparkles"></i> AI診断レポートを生成する';
  }
});


/* ===========================
   診断結果をHTMLに描画する・初期化
=========================== */
function renderResult(d, formData) {
  const stars  = '★'.repeat(d.overallScore) + '☆'.repeat(5 - d.overallScore);
  const subLine = [formData.grade, formData.subjects]
    .filter(v => v !== '未入力').join(' ／ ');

  const strengthsHTML    = (d.strengths    || []).map(s => `<li>${escapeHtml(s)}</li>`).join('');
  const improvementsHTML = (d.improvements || []).map(s => `<li>${escapeHtml(s)}</li>`).join('');

  const html = `
    <!-- 印刷・共有用アクションバー（画面表示時のみ） -->
    <div class="result-actions no-print">
      <button type="button" class="action-btn action-btn-primary" id="print-btn">
        <i class="ti ti-printer"></i> 印刷 / PDF保存
      </button>
      <button type="button" class="action-btn" id="copy-all-btn">
        <i class="ti ti-copy"></i> レポート全体をコピー
      </button>
    </div>

    <!-- 総合評価 -->
    <div class="result-card card-hero">
      <div class="hero-row">
        <div>
          <div class="hero-name">${escapeHtml(formData.name)} さん — AI診断レポート</div>
          <div class="hero-sub">${escapeHtml(subLine)}</div>
        </div>
        <div>
          <div class="score-stars">${stars}</div>
          <div class="score-label">総合評価 ${d.overallScore} / 5</div>
        </div>
      </div>
      <div class="card-body">${escapeHtml(d.overallComment || '')}</div>
    </div>

    <!-- 今すぐ取り組むべきこと -->
    <div class="result-card card-urgent">
      <div class="card-label">
        <i class="ti ti-alert-circle"></i> 今すぐ取り組むべきこと
      </div>
      <div class="card-body">${escapeHtml(d.urgentAction || '')}</div>
    </div>

    <!-- 強み・改善点 -->
    <div class="two-col">
      <div class="result-card card-strengths">
        <div class="card-label"><i class="ti ti-thumb-up"></i> 強み</div>
        <ul class="diag-list">${strengthsHTML}</ul>
      </div>
      <div class="result-card card-improvements">
        <div class="card-label"><i class="ti ti-trending-up"></i> 改善点</div>
        <ul class="diag-list">${improvementsHTML}</ul>
      </div>
    </div>

    <!-- 1週間の学習プラン -->
    <div class="result-card card-neutral">
      <div class="card-label"><i class="ti ti-calendar-week"></i> 1週間の推奨学習プラン</div>
      <div class="card-body">${escapeHtml(d.weeklyPlan || '')}</div>
    </div>

    <!-- 1ヶ月の目標 -->
    <div class="result-card card-neutral">
      <div class="card-label"><i class="ti ti-calendar-month"></i> 1ヶ月の目標と方針</div>
      <div class="card-body">${escapeHtml(d.monthlyPlan || '')}</div>
    </div>

    <!-- 講師アドバイス -->
    <div class="result-card card-neutral">
      <div class="card-label"><i class="ti ti-bulb"></i> 講師へのアドバイス</div>
      <div class="card-body">${escapeHtml(d.instructorAdvice || '')}</div>
    </div>

    <!-- 保護者向けコメント -->
    <div class="result-card card-neutral">
      <div class="card-label"><i class="ti ti-mail"></i> 保護者向けコメント文案</div>
      <div class="parent-block" id="parent-text">${escapeHtml(d.parentMessage || '')}</div>
      <button type="button" class="copy-btn no-print" id="copy-btn">
        <i class="ti ti-copy"></i> 保護者コメントのみコピー
      </button>
    </div>
  `;

  document.getElementById('state-result').innerHTML = html;

  // --- イベントバインド ---

  // 1. 印刷 / PDF保存ボタン
  document.getElementById('print-btn').addEventListener('click', () => {
    window.print();
  });

  // 2. レポート全体テキストコピー
  document.getElementById('copy-all-btn').addEventListener('click', () => {
    const fullText = `
【生徒診断レポート】${formData.name} さん（${subLine}）
総合評価: ${d.overallScore}/5

■ 総合評価・診断コメント
${d.overallComment || ''}

■ 今すぐ取り組むべきこと
${d.urgentAction || ''}

■ 強み
${(d.strengths || []).map(s => `・${s}`).join('\n')}

■ 改善点
${(d.improvements || []).map(s => `・${s}`).join('\n')}

■ 1週間の推奨学習プラン
${d.weeklyPlan || ''}

■ 1ヶ月の目標と方針
${d.monthlyPlan || ''}

■ 講師へのアドバイス
${d.instructorAdvice || ''}

■ 保護者向けコメント
${d.parentMessage || ''}
`.trim();

    navigator.clipboard.writeText(fullText).then(() => {
      const btn = document.getElementById('copy-all-btn');
      btn.innerHTML = '<i class="ti ti-check"></i> レポート全体をコピーしました';
      setTimeout(() => {
        btn.innerHTML = '<i class="ti ti-copy"></i> レポート全体をコピー';
      }, 2000);
    });
  });

  // 3. 保護者用コメントコピーボタン
  document.getElementById('copy-btn').addEventListener('click', () => {
    const text = document.getElementById('parent-text').innerText;
    navigator.clipboard.writeText(text).then(() => {
      const btn = document.getElementById('copy-btn');
      btn.innerHTML = '<i class="ti ti-check"></i> コピーしました';
      setTimeout(() => {
        btn.innerHTML = '<i class="ti ti-copy"></i> 保護者コメントのみコピー';
      }, 2000);
    });
  });
}


document.getElementById('tab-add-btn').addEventListener('click', addStudent);
renderTabs();
restoreForm(students[currentIndex]);
