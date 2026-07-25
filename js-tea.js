/* ===========================
   Step 2: localStorage データ管理関数
=========================== */

// 1. 生徒データの読み込み（なければ初期データを生成）
function getStudentData(studentId) {
  const key = `student_data_${studentId}`;
  const jsonStr = localStorage.getItem(key);

  if (!jsonStr) {
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
  return { type: '', grade: '', date: '', scores: '' };
}

function createStudent() {
  const num  = studentCounter++;
  const data = {};
  FIELD_IDS.forEach(id => { data[id] = ''; });
  data.subjects = [];
  data.tests    = [createTestEntry()];
  return {
    id:              Date.now() + Math.random(),
    defaultName:     `生徒 ${num}`,
    tabName:         `生徒 ${num}`,
    data,
    result:          null,
    mode:            'profile',   // 'profile' | 'report' | 'history'
    modeInitialized: false,       // 初回タブ表示時に detectMode() で上書きするフラグ
  };
}

/* ===========================
   Step 1: モード管理（フロー分岐）
=========================== */

/**
 * localStorageの授業ログ有無でモードを自動判別する。
 * lessonLogs が 1 件以上あれば 'report'、なければ 'profile' を返す。
 */
function detectMode(studentId) {
  const data = getStudentData(studentId);
  return (data && data.lessonLogs.length > 0) ? 'report' : 'profile';
}

/** サブナビゲーション用スタイルを <head> に一度だけ注入する */
function injectSubNavStyles() {
  if (document.getElementById('sub-nav-styles')) return;
  const style = document.createElement('style');
  style.id = 'sub-nav-styles';
  style.textContent = `
    .sub-nav {
      display: flex;
      gap: 4px;
      padding: 10px 12px 8px;
      border-bottom: 1px solid var(--border, #e5e7eb);
      background: var(--bg, #fff);
      position: sticky;
      top: 0;
      z-index: 10;
    }
    .sub-nav-btn {
      flex: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      padding: 7px 4px;
      border: 1px solid var(--border, #d1d5db);
      border-radius: 8px;
      background: transparent;
      color: var(--text-muted, #6b7280);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s, color 0.15s, border-color 0.15s;
      white-space: nowrap;
    }
    .sub-nav-btn:hover {
      background: var(--surface-hover, #f3f4f6);
      color: var(--text, #111827);
    }
    .sub-nav-btn.active {
      background: var(--primary, #4f46e5);
      border-color: var(--primary, #4f46e5);
      color: #fff;
    }
    .history-empty {
      padding: 40px 16px;
      text-align: center;
      color: var(--text-muted, #9ca3af);
      font-size: 14px;
    }
    .history-section-title {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 14px 16px 8px;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-muted, #6b7280);
      border-bottom: 1px solid var(--border, #e5e7eb);
      margin: 0;
    }
    .history-card {
      padding: 10px 16px;
      border-bottom: 1px solid var(--border, #f3f4f6);
    }
    .history-card-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
      flex-wrap: wrap;
    }
    .history-date {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted, #6b7280);
    }
    .history-score {
      font-size: 12px;
      font-weight: 600;
      color: var(--primary, #4f46e5);
    }
    .history-subject {
      font-size: 11px;
      color: var(--text-muted, #6b7280);
      background: var(--surface-hover, #f3f4f6);
      padding: 2px 8px;
      border-radius: 12px;
    }
    .history-comp {
      font-size: 11px;
      color: var(--text-muted, #6b7280);
    }
    .history-card-body {
      font-size: 12px;
      color: var(--text, #374151);
      line-height: 1.5;
    }
    #section-history {
      overflow-y: auto;
    }

    /* ── アコーディオン ── */
    .accordion-list {
      border-top: 1px solid var(--border, #e5e7eb);
    }
    .accordion-item {
      border-bottom: 1px solid var(--border, #e5e7eb);
    }
    .accordion-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 16px;
      cursor: pointer;
      gap: 8px;
      user-select: none;
      transition: background 0.15s;
    }
    .accordion-header:hover {
      background: var(--surface-hover, #f9fafb);
    }
    .accordion-header-left {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      min-width: 0;
      flex: 1;
    }
    .accordion-icon {
      font-size: 13px;
      color: var(--text-muted, #9ca3af);
      transition: transform 0.2s;
      flex-shrink: 0;
    }
    .accordion-item.is-open .accordion-icon {
      transform: rotate(90deg);
    }
    .accordion-body {
      display: none;
      padding: 4px 16px 12px 36px;
      font-size: 12px;
      color: var(--text, #374151);
      line-height: 1.6;
    }
    .accordion-item.is-open .accordion-body {
      display: block;
    }
    .accordion-field {
      margin-bottom: 4px;
    }
    .accordion-field-label {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted, #6b7280);
    }
    .accordion-comp-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    .accordion-comp-num {
      font-size: 11px;
      font-weight: 600;
      color: var(--primary, #4f46e5);
      white-space: nowrap;
    }
    .mini-bar {
      display: inline-block;
      width: 80px;
      height: 6px;
      background: var(--border, #e5e7eb);
      border-radius: 3px;
      overflow: hidden;
      vertical-align: middle;
    }
    .mini-bar-fill {
      display: block;
      height: 100%;
      background: var(--primary, #4f46e5);
      border-radius: 3px;
    }

    /* ── 直近AI診断バッジ ── */
    .diag-badge-wrapper {
      padding: 14px 16px 4px;
    }
    .diag-badge-label {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted, #6b7280);
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .diag-badge {
      background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
      border-radius: 12px;
      padding: 14px 16px;
      color: #fff;
      margin-bottom: 4px;
    }
    .diag-badge-score {
      display: flex;
      align-items: baseline;
      gap: 8px;
      margin-bottom: 8px;
    }
    .diag-badge-stars {
      font-size: 15px;
      letter-spacing: 2px;
      opacity: 0.95;
    }
    .diag-badge-num {
      font-size: 26px;
      font-weight: 700;
      line-height: 1;
    }
    .diag-badge-num small {
      font-size: 12px;
      font-weight: 400;
      opacity: 0.75;
    }
    .diag-badge-diff {
      font-size: 11px;
      font-weight: 700;
      padding: 2px 7px;
      border-radius: 20px;
      background: rgba(255,255,255,0.2);
    }
    .diag-badge-diff.down {
      background: rgba(0,0,0,0.18);
    }
    .diag-badge-comment {
      font-size: 12px;
      opacity: 0.9;
      line-height: 1.55;
      margin-bottom: 6px;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .diag-badge-date {
      font-size: 10px;
      opacity: 0.65;
    }
    .diag-score-badge {
      font-size: 11px;
      font-weight: 600;
      background: var(--primary, #4f46e5);
      color: #fff;
      padding: 2px 8px;
      border-radius: 20px;
      flex-shrink: 0;
    }

    /* ── 理解度グラフ ── */
    .chart-container {
      padding: 4px 16px 8px;
    }
    #comp-chart {
      display: block;
      width: 100%;
    }
  `;
  document.head.appendChild(style);
}

/** form-panel 上部にサブナビゲーションを挿入する */
function renderSubNav() {
  const panel = document.getElementById('form-panel');
  if (!panel) return;

  const existing = document.getElementById('sub-nav');
  if (existing) existing.remove();

  const nav = document.createElement('div');
  nav.id = 'sub-nav';
  nav.className = 'sub-nav';
  nav.innerHTML = `
    <button type="button" class="sub-nav-btn" data-mode="profile">
      <i class="ti ti-user"></i> 基本情報
    </button>
    <button type="button" class="sub-nav-btn" data-mode="report">
      <i class="ti ti-book"></i> 授業記録
    </button>
    <button type="button" class="sub-nav-btn" data-mode="history">
      <i class="ti ti-history"></i> 履歴
    </button>
  `;

  panel.insertBefore(nav, panel.firstChild);

  nav.querySelectorAll('.sub-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchMode(btn.dataset.mode));
  });

  updateSubNavActive(students[currentIndex]?.mode || 'profile');
}

/** サブナビのアクティブ状態を現在の mode に合わせて同期する */
function updateSubNavActive(mode) {
  document.querySelectorAll('#sub-nav .sub-nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
}

/**
 * form-panel の直下子要素に data-section 属性を付与してセクションを分割する。
 * 初回のみ実行（data-sections-init 属性で二重実行を防止）。
 *
 * 基本情報（profile）: f-name / f-grade / f-goal / f-concerns / subjects
 * 授業記録（report） : f-comp / comp-scale / f-attitude / f-notes /
 *                     test-list / test-add-btn / gen-btn / api-key
 * 未分類の子要素は report に振り分ける。
 */
function initSections() {
  const panel = document.getElementById('form-panel');
  if (!panel || panel.hasAttribute('data-sections-init')) return;
  panel.setAttribute('data-sections-init', '1');

  const PROFILE_IDS = ['f-name', 'f-grade', 'f-goal', 'f-concerns', 'subjects'];
  const REPORT_IDS  = ['f-comp', 'comp-scale', 'f-attitude', 'f-notes',
                       'test-list', 'test-add-btn', 'gen-btn', 'api-key'];

  /** 指定 ID を含む form-panel 直下の子要素を返す */
  function findPanelDirectChild(id) {
    const el = document.getElementById(id);
    if (!el) return null;
    let node = el;
    while (node.parentElement && node.parentElement !== panel) {
      node = node.parentElement;
    }
    return node.parentElement === panel ? node : null;
  }

  const profileSet = new Set();
  const reportSet  = new Set();

  PROFILE_IDS.forEach(id => {
    const el = findPanelDirectChild(id);
    if (el && el.id !== 'sub-nav') profileSet.add(el);
  });

  REPORT_IDS.forEach(id => {
    const el = findPanelDirectChild(id);
    if (el && el.id !== 'sub-nav') reportSet.add(el);
  });

  // 両方に含まれる要素は report 優先
  profileSet.forEach(el => {
    el.setAttribute('data-section', reportSet.has(el) ? 'report' : 'profile');
  });
  reportSet.forEach(el => {
    if (!el.hasAttribute('data-section')) el.setAttribute('data-section', 'report');
  });

  // 未分類の子要素は report に振り分け
  [...panel.children].forEach(child => {
    if (child.id !== 'sub-nav' && !child.hasAttribute('data-section')) {
      child.setAttribute('data-section', 'report');
    }
  });

  // 履歴セクションを動的に追加
  if (!document.getElementById('section-history')) {
    const historySec = document.createElement('div');
    historySec.id = 'section-history';
    historySec.className = 'mode-section';
    historySec.setAttribute('data-section', 'history');
    panel.appendChild(historySec);
  }
}

/** mode に応じて form-panel 内のセクションを表示 / 非表示にする */
function showModeSection(mode) {
  const panel = document.getElementById('form-panel');
  if (!panel) return;

  [...panel.children].forEach(child => {
    if (child.id === 'sub-nav') return;
    const section = child.getAttribute('data-section');
    if (section) child.style.display = (section === mode) ? '' : 'none';
  });

  if (mode === 'history') renderHistoryView();
}

/** サブナビボタン押下時: フォームを保存してモードを切り替える */
function switchMode(mode) {
  saveCurrentForm();
  students[currentIndex].mode = mode;
  updateSubNavActive(mode);
  showModeSection(mode);
}

/** 履歴セクションに localStorage の過去データを描画する */
function renderHistoryView() {
  const historySec = document.getElementById('section-history');
  if (!historySec) return;

  const s    = students[currentIndex];
  const name = (s.data['f-name'] || '').trim();

  if (!name) {
    historySec.innerHTML = '<p class="history-empty">生徒名を入力すると履歴が表示されます。</p>';
    return;
  }

  const studentId = 'std_' + encodeURIComponent(name);
  const pastData  = getStudentData(studentId);

  if (!pastData ||
      (pastData.lessonLogs.length === 0 && pastData.aiDiagnostics.length === 0)) {
    historySec.innerHTML = '<p class="history-empty">まだ履歴はありません。</p>';
    return;
  }

  let html = '';

  // ① 直近AI診断バッジ
  if (pastData.aiDiagnostics.length > 0) {
    const lastDiag = pastData.aiDiagnostics[pastData.aiDiagnostics.length - 1];
    const prevDiag = pastData.aiDiagnostics.length > 1
      ? pastData.aiDiagnostics[pastData.aiDiagnostics.length - 2]
      : null;
    const score  = Number(lastDiag.overallScore) || 0;
    const stars  = '★'.repeat(Math.min(score, 5)) + '☆'.repeat(Math.max(5 - score, 0));
    const pScore = prevDiag ? (Number(prevDiag.overallScore) || 0) : null;
    const diff   = pScore !== null ? score - pScore : null;

    html += `
      <div class="diag-badge-wrapper">
        <div class="diag-badge-label"><i class="ti ti-sparkles"></i> 直近のAI診断</div>
        <div class="diag-badge">
          <div class="diag-badge-score">
            <span class="diag-badge-stars">${stars}</span>
            <span class="diag-badge-num">${score}<small>/5</small></span>
            ${diff !== null
              ? `<span class="diag-badge-diff ${diff >= 0 ? 'up' : 'down'}">${diff >= 0 ? '▲' : '▼'}${Math.abs(diff)}</span>`
              : ''}
          </div>
          <div class="diag-badge-comment">${escapeHtml(lastDiag.overallComment || '')}</div>
          <div class="diag-badge-date">${escapeHtml(lastDiag.date || '')}</div>
        </div>
      </div>
    `;
  }

  // ② 理解度推移グラフ（Canvas）
  const logsWithComp = pastData.lessonLogs.filter(l =>
    l.comprehension != null && l.comprehension !== '' && l.comprehension !== '未入力'
  );
  if (logsWithComp.length > 0) {
    html += `
      <h3 class="history-section-title"><i class="ti ti-chart-line"></i> 理解度の推移</h3>
      <div class="chart-container">
        <canvas id="comp-chart"></canvas>
      </div>
    `;
  }

  // ③ 授業ログ（アコーディオン）
  if (pastData.lessonLogs.length > 0) {
    html += '<h3 class="history-section-title"><i class="ti ti-book"></i> 授業ログ</h3>';
    html += '<div class="accordion-list">';
    [...pastData.lessonLogs].reverse().forEach((log, idx) => {
      const comp = parseComprehension(log.comprehension);
      html += `
        <div class="accordion-item${idx === 0 ? ' is-open' : ''}">
          <div class="accordion-header">
            <div class="accordion-header-left">
              <i class="ti ti-chevron-right accordion-icon"></i>
              <span class="history-date">${escapeHtml(log.date || '')}</span>
              ${log.subject ? `<span class="history-subject">${escapeHtml(log.subject)}</span>` : ''}
            </div>
            ${comp ? `<span class="history-comp">理解度 ${comp}/10</span>` : ''}
          </div>
          <div class="accordion-body">
            ${comp ? `
              <div class="accordion-comp-row">
                <span class="mini-bar"><span class="mini-bar-fill" style="width:${Math.round(comp / 10 * 100)}%"></span></span>
                <span class="accordion-comp-num">${comp} / 10</span>
              </div>` : ''}
            ${log.instructorNotes ? `<div class="accordion-field"><span class="accordion-field-label">講師メモ：</span>${escapeHtml(log.instructorNotes)}</div>` : ''}
            ${log.attitude        ? `<div class="accordion-field"><span class="accordion-field-label">学習態度：</span>${escapeHtml(log.attitude)}</div>` : ''}
            ${log.homeworkStatus  ? `<div class="accordion-field"><span class="accordion-field-label">宿題状況：</span>${escapeHtml(log.homeworkStatus)}</div>` : ''}
            ${log.unit            ? `<div class="accordion-field"><span class="accordion-field-label">単元/結果：</span>${escapeHtml(log.unit)}</div>` : ''}
          </div>
        </div>
      `;
    });
    html += '</div>';
  }

  // ④ AI診断履歴（アコーディオン）
  if (pastData.aiDiagnostics.length > 0) {
    html += '<h3 class="history-section-title"><i class="ti ti-sparkles"></i> AI診断履歴</h3>';
    html += '<div class="accordion-list">';
    [...pastData.aiDiagnostics].reverse().forEach((diag, idx) => {
      const score = Number(diag.overallScore) || 0;
      const stars = '★'.repeat(Math.min(score, 5)) + '☆'.repeat(Math.max(5 - score, 0));
      html += `
        <div class="accordion-item${idx === 0 ? ' is-open' : ''}">
          <div class="accordion-header">
            <div class="accordion-header-left">
              <i class="ti ti-chevron-right accordion-icon"></i>
              <span class="history-date">${escapeHtml(diag.date || '')}</span>
              <span class="history-score">${stars}</span>
            </div>
            <span class="diag-score-badge">${score}/5</span>
          </div>
          <div class="accordion-body">
            <div class="accordion-field">${escapeHtml(diag.overallComment || '')}</div>
          </div>
        </div>
      `;
    });
    html += '</div>';
  }

  historySec.innerHTML = html;

  // アコーディオン開閉イベントを登録
  historySec.querySelectorAll('.accordion-header').forEach(header => {
    header.addEventListener('click', () => {
      header.closest('.accordion-item').classList.toggle('is-open');
    });
  });

  // Canvas グラフ描画
  if (logsWithComp.length > 0) {
    drawComprehensionChart(logsWithComp);
  }
}

/** 理解度の値を数値にパースする（"7 / 10" → 7 など） */
function parseComprehension(val) {
  if (val == null || val === '' || val === '未入力') return 0;
  if (typeof val === 'number') return val;
  const m = String(val).match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}

/** Canvas に理解度推移グラフを描画する */
function drawComprehensionChart(logs) {
  const canvas = document.getElementById('comp-chart');
  if (!canvas || !canvas.getContext) return;

  const data = logs.slice(-10);

  const wrapper = canvas.parentElement;
  const W = Math.max(wrapper.clientWidth || 320, 200);
  const H = 160;
  canvas.width  = W;
  canvas.height = H;
  canvas.style.width  = '100%';
  canvas.style.height = H + 'px';

  const ctx = canvas.getContext('2d');
  const PAD = { top: 20, right: 20, bottom: 38, left: 36 };
  const cW  = W - PAD.left - PAD.right;
  const cH  = H - PAD.top  - PAD.bottom;

  const primary = '#4f46e5';
  const muted   = '#9ca3af';
  const border  = '#e5e7eb';

  ctx.clearRect(0, 0, W, H);

  function getX(i) {
    return PAD.left + (data.length > 1 ? (i / (data.length - 1)) * cW : cW / 2);
  }
  function getY(v) {
    return PAD.top + cH - (v / 10) * cH;
  }

  // グリッド線と Y ラベル
  [2, 4, 6, 8, 10].forEach(v => {
    const y = getY(v);
    ctx.beginPath();
    ctx.strokeStyle = border;
    ctx.lineWidth   = 1;
    ctx.moveTo(PAD.left, y);
    ctx.lineTo(W - PAD.right, y);
    ctx.stroke();
    ctx.fillStyle    = muted;
    ctx.font         = '10px system-ui,sans-serif';
    ctx.textAlign    = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(v), PAD.left - 5, y);
  });

  // グラデーション塗りつぶし
  if (data.length > 1) {
    const grad = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + cH);
    grad.addColorStop(0, 'rgba(79,70,229,0.22)');
    grad.addColorStop(1, 'rgba(79,70,229,0)');
    ctx.beginPath();
    ctx.moveTo(getX(0), getY(parseComprehension(data[0].comprehension)));
    for (let i = 1; i < data.length; i++) {
      ctx.lineTo(getX(i), getY(parseComprehension(data[i].comprehension)));
    }
    ctx.lineTo(getX(data.length - 1), PAD.top + cH);
    ctx.lineTo(getX(0), PAD.top + cH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
  }

  // 折れ線
  if (data.length > 1) {
    ctx.beginPath();
    ctx.strokeStyle = primary;
    ctx.lineWidth   = 2;
    ctx.lineJoin    = 'round';
    ctx.moveTo(getX(0), getY(parseComprehension(data[0].comprehension)));
    for (let i = 1; i < data.length; i++) {
      ctx.lineTo(getX(i), getY(parseComprehension(data[i].comprehension)));
    }
    ctx.stroke();
  }

  // ドット・値ラベル・日付ラベル
  data.forEach((log, i) => {
    const x   = getX(i);
    const val = parseComprehension(log.comprehension);
    const y   = getY(val);

    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle   = '#fff';
    ctx.strokeStyle = primary;
    ctx.lineWidth   = 2;
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle    = primary;
    ctx.font         = 'bold 10px system-ui,sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(String(val), x, y - 6);

    const dateLabel = (log.date || '').replace(/^\d{4}-/, '').replace('-', '/');
    ctx.fillStyle    = muted;
    ctx.font         = '9px system-ui,sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(dateLabel, x, H - PAD.bottom + 6);
  });
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

  // モード自動判別（生徒タブ初回表示時のみ実行）
  if (!s.modeInitialized) {
    const name = (s.data['f-name'] || '').trim();
    s.mode = name
      ? detectMode('std_' + encodeURIComponent(name))
      : 'profile';
    s.modeInitialized = true;
  }

  updateSubNavActive(s.mode);
  showModeSection(s.mode);

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

function renderTestList(tests) {
  const list = document.getElementById('test-list');
  list.innerHTML = '';
  tests.forEach((t, i) => {
    const el = createTestEntryElement(t, i);
    if (i !== tests.length - 1) {
      el.classList.remove('is-open');
    }
    list.appendChild(el);
  });
}

/** 1件のテストエントリー要素を生成してイベントをバインドする */
function createTestEntryElement(test, idx) {
  const div      = document.createElement('div');
  div.className  = 'test-entry is-open';

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
    if (scores) previewText += (previewText ? ' - ' : '') + scores.replace(/\n/g, ' ');
    previewSpan.textContent = previewText || '(未入力)';
  }

  div.querySelectorAll('.test-type-input, .test-scores').forEach(el => {
    el.addEventListener('input', updatePreview);
  });
  updatePreview();

  // ── 開閉処理 ──
  const header = div.querySelector('.test-entry-header');
  header.addEventListener('click', (e) => {
    if (e.target.closest('.test-remove-btn')) return;
    div.classList.toggle('is-open');
  });

  // ── 削除ボタン ──
  div.querySelector('.test-remove-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const list = document.getElementById('test-list');
    div.remove();
    renumberTestEntries();
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
  
  list.querySelectorAll('.test-entry').forEach(entry => {
    entry.classList.remove('is-open');
  });

  const newIdx = list.querySelectorAll('.test-entry').length;
  list.appendChild(createTestEntryElement(createTestEntry(), newIdx));
  
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

  const lessonDate = formData.date || new Date().toISOString().split('T')[0];
  const studentId  = 'std_' + encodeURIComponent(formData.name || 'default');
  
  const pastData     = getStudentData(studentId);
  const previousLogs = pastData ? pastData.lessonLogs.slice(-10) : [];
  const lastDiag     = (pastData && pastData.aiDiagnostics.length > 0)
    ? pastData.aiDiagnostics[pastData.aiDiagnostics.length - 1]
    : null;

  // 理解度の傾向を数値計算（全ログの前半平均 vs 後半平均で比較）
  const compValues = (pastData ? pastData.lessonLogs : [])
    .map(l => parseComprehension(l.comprehension))
    .filter(v => v > 0);
  let compTrendText = '記録なし';
  if (compValues.length >= 2) {
    const half   = Math.ceil(compValues.length / 2);
    const avgOld = (compValues.slice(0, half).reduce((a, b) => a + b, 0) / half).toFixed(1);
    const avgNew = (compValues.slice(-half).reduce((a, b) => a + b, 0) / half).toFixed(1);
    const diff   = (Number(avgNew) - Number(avgOld)).toFixed(1);
    const arrow  = Number(diff) > 0.5 ? '上昇傾向↑' : Number(diff) < -0.5 ? '低下傾向↓' : '横ばい→';
    compTrendText = `${arrow}（前半平均 ${avgOld} → 後半平均 ${avgNew}、変化 ${Number(diff) >= 0 ? '+' : ''}${diff}、全${compValues.length}件）`;
  }

  // AI診断スコアの前回比
  const scoreDiffText = (pastData && pastData.aiDiagnostics.length > 1 && lastDiag)
    ? (() => {
        const prev = pastData.aiDiagnostics[pastData.aiDiagnostics.length - 2];
        const d    = Number(lastDiag.overallScore) - Number(prev.overallScore);
        return `${d >= 0 ? '+' : ''}${d}（前回 ${prev.overallScore} → 直近 ${lastDiag.overallScore}）`;
      })()
    : '初回診断のため比較なし';

  addLessonLog(studentId, {
    date: lessonDate,
    subject: formData.subjects,
    unit: formData.scores,
    comprehension: formData.comp,
    attitude: formData.attitude,
    instructorNotes: formData.notes
  });

  const prompt = `
あなたはプロの教育コンサルタント・塾講師です。
生徒の基本情報、過去の学習変化、今回の授業内容を踏まえ、保護者も納得する高品質な診断レポートを作成してください。

【生徒情報】
名前: ${formData.name}
学年: ${formData.grade}
担当科目: ${formData.subjects}
目標: ${formData.goal}
現在の課題: ${formData.concerns}

【学習傾向分析（数値）】
理解度の傾向: ${compTrendText}
AI診断スコアの変化: ${scoreDiffText}

【前回のAI診断結果】
${lastDiag ? `前回の総合スコア: ${lastDiag.overallScore} / 5\n前回の所見: ${lastDiag.overallComment}` : '過去のAI診断履歴はありません（初回診断）'}

【直近の指導経過（最大10件）】
${previousLogs.length > 0 ? previousLogs.map((log, index) => `
${index + 1}. [${log.date}] 科目: ${log.subject} / 理解度: ${parseComprehension(log.comprehension)}/10
   所見: ${log.instructorNotes}
`).join('') : '過去の授業ログはありません'}

【今回の授業レポート (${lessonDate})】
理解度（10段階）: ${formData.comp}
テスト・単元結果: ${formData.scores}
学習態度・自習状況: ${formData.attitude}
講師メモ: ${formData.notes}

【指示】
- 学習傾向分析の数値（理解度の傾向・スコア変化）を必ず言及し、変化を具体的に評価してください。
- 過去のデータと比較し、「成長できた点」「継続して取り組む課題」を具体的に述べてください。
- 次回授業プランは今回の課題を踏まえ、単元名・教材名・つまずきやすい箇所を明記してください。
- 保護者向けメッセージは丁寧で前向き、そのまま面談や連絡帳で渡せるクオリティにしてください。
`.trim();

  try {
    const response = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 3000,
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              overallScore: { type: "INTEGER" },
              overallComment: { type: "STRING" },
              strengths: { type: "ARRAY", items: { type: "STRING" } },
              improvements: { type: "ARRAY", items: { type: "STRING" } },
              weeklyPlan: { type: "STRING" },
              monthlyPlan: { type: "STRING" },
              nextLessonPlan: {
                type: "OBJECT",
                properties: {
                  objective: { type: "STRING" },
                  keyPoints: { type: "ARRAY", items: { type: "STRING" } },
                  materials: { type: "STRING" },
                  pitfalls:  { type: "ARRAY", items: { type: "STRING" } }
                },
                required: ["objective", "keyPoints", "materials", "pitfalls"]
              },
              instructorAdvice: { type: "STRING" },
              parentMessage: { type: "STRING" },
              urgentAction: { type: "STRING" }
            },
            required: [
              "overallScore", "overallComment", "strengths", "improvements",
              "weeklyPlan", "monthlyPlan", "nextLessonPlan",
              "instructorAdvice", "parentMessage", "urgentAction"
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

    const clean  = rawText.replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);

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

    <!-- 次回授業プラン -->
    ${d.nextLessonPlan ? `
    <div class="result-card card-neutral">
      <div class="card-label"><i class="ti ti-calendar-event"></i> 次回授業プラン</div>
      <div class="card-body">
        <div style="font-weight:600;margin-bottom:8px">${escapeHtml(d.nextLessonPlan.objective || '')}</div>
        ${(d.nextLessonPlan.keyPoints || []).length > 0 ? `
          <div style="margin-bottom:8px">
            <div style="font-size:11px;font-weight:600;color:var(--text-muted,#6b7280);margin-bottom:4px">重点ポイント</div>
            <ul class="diag-list">${(d.nextLessonPlan.keyPoints || []).map(p => `<li>${escapeHtml(p)}</li>`).join('')}</ul>
          </div>` : ''}
        ${d.nextLessonPlan.materials ? `
          <div style="margin-bottom:8px">
            <div style="font-size:11px;font-weight:600;color:var(--text-muted,#6b7280);margin-bottom:2px">教材・準備物</div>
            <div>${escapeHtml(d.nextLessonPlan.materials)}</div>
          </div>` : ''}
        ${(d.nextLessonPlan.pitfalls || []).length > 0 ? `
          <div>
            <div style="font-size:11px;font-weight:600;color:var(--text-muted,#6b7280);margin-bottom:4px">注意点・つまずきやすい箇所</div>
            <ul class="diag-list">${(d.nextLessonPlan.pitfalls || []).map(p => `<li>${escapeHtml(p)}</li>`).join('')}</ul>
          </div>` : ''}
      </div>
    </div>` : ''}

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

■ 次回授業プラン
${d.nextLessonPlan ? `目標: ${d.nextLessonPlan.objective || ''}
重点ポイント:
${(d.nextLessonPlan.keyPoints || []).map(p => `・${p}`).join('\n')}
教材・準備物: ${d.nextLessonPlan.materials || ''}
注意点:
${(d.nextLessonPlan.pitfalls || []).map(p => `・${p}`).join('\n')}` : '（なし）'}

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
injectSubNavStyles();
renderSubNav();
initSections();
renderTabs();
restoreForm(students[currentIndex]);
