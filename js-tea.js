/** 数値変換ヘルパー: 数値化できない値は 0 として扱う（スコア差分計算などで使用） */
function num(v) {
  return Number(v) || 0;
}

/** 共通ヘルパー: id指定要素へのイベント登録（要素が存在しない場合は何もしない） */
function on(id, event, fn) {
  document.getElementById(id)?.addEventListener(event, fn);
}

function renderStars(rawScore) {
  const score = Math.min(Math.max(Number(rawScore) || 0, 0), 5);
  return { score, stars: '★'.repeat(score) + '☆'.repeat(5 - score) };
}

function getLocalDate() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().split('T')[0];
}

function createDefaultStudentData(studentId) {
  const today = getLocalDate();
  return {
    studentId,
    createdAt: today,
    updatedAt: today,
    basicInfo: { name: '', grade: '', subjects: [], goal: '', initialConcerns: '' },
    lessonLogs: [],
    aiDiagnostics: [],
  };
}

function getStudentData(studentId) {
  const key = studentKey(studentId);
  const jsonStr = localStorage.getItem(key);

  if (!jsonStr) return createDefaultStudentData(studentId);

  try {
    const data = JSON.parse(jsonStr);
    data.lessonLogs = Array.isArray(data.lessonLogs) ? data.lessonLogs : [];
    data.aiDiagnostics = Array.isArray(data.aiDiagnostics) ? data.aiDiagnostics : [];
    return data;
  } catch (e) {
    console.error("データのパースエラー:", e);
    // 返すだけにして保存はしない（既存データを壊さない）
    // _parseError フラグにより呼び出し側・saveStudentData 側で保存をスキップできる
    return { ...createDefaultStudentData(studentId), _parseError: true };
  }
}  

function saveStudentData(studentData) {
  if (!studentData || !studentData.studentId) return;
  // パースエラー由来の空データが流れ込んでも既存データを上書きしない
  if (studentData._parseError) return;
  
  studentData.updatedAt = getLocalDate();
  
  const key = studentKey(studentData.studentId);
  localStorage.setItem(key, JSON.stringify(studentData));
}

function mutateStudentData(studentId, fn) {
  const data = getStudentData(studentId);
  fn(data);
  saveStudentData(data);
  return data;
}

// ※ AI診断データの永続化（addAIDiagnostics）は js-tea-ai.js に移動
function addLessonLog(studentId, logData) {
  const newLog = {
    logId: `log_${crypto.randomUUID()}`,
    date: logData.date || getLocalDate(),
    subject: logData.subject || '',
    unit: logData.unit || '',
    comprehension: parseComprehension(logData.comprehension),
    attitude: logData.attitude || '',
    instructorNotes: logData.instructorNotes || '',
    takeaways: logData.takeaways || '',
    lessonContent: logData.lessonContent || ''
  };
  return mutateStudentData(studentId, d => d.lessonLogs.push(newLog));
}

function deleteLessonLog(studentId, logId) {
  return mutateStudentData(studentId, d => {
    d.lessonLogs = d.lessonLogs.filter(l => l.logId !== logId);
  });
}

function updateLessonLog(studentId, logId, updatedFields) {
  const data = getStudentData(studentId);
  const idx  = data.lessonLogs.findIndex(l => l.logId === logId);
  if (idx === -1) return data;

  // updatedFields.comprehension が未入力・空・null の場合は既存の理解度を保持する。
  // parseComprehension は '未入力' / null / '' に対して 0 を返すため、
  // 無条件に呼び出すと既存ログの理解度データが消えてしまう。
  const existing = data.lessonLogs[idx];
  const hasComprehension =
    updatedFields.comprehension != null &&
    updatedFields.comprehension !== '' &&
    updatedFields.comprehension !== '未入力';
  const comprehension = hasComprehension
    ? parseComprehension(updatedFields.comprehension)
    : existing.comprehension;

  data.lessonLogs[idx] = {
    ...existing,        // logId などを保持
    ...updatedFields,
    comprehension,      // 条件分岐済みの値で確実に上書き
  };
  saveStudentData(data);
  return data;
}

function buildLessonLogPayload(formData, lessonDate) {
  return {
    date:            lessonDate,
    subject:         formData.subjects,
    unit:            formData.scores,
    comprehension:   formData.comp,
    attitude:        formData.attitude,
    instructorNotes: formData.notes,
    takeaways:       formData.takeaways,
    lessonContent:   formData.lessonContent
  };
}

function saveOrUpdateLessonLog(studentId, formData, lessonDate) {
  const payload = buildLessonLogPayload(formData, lessonDate);
  if (_editingLogId) {
    // 修正⑦: updateLessonLog を try-catch で保護。
    // 失敗時は _editingLogId をクリアせず編集状態を維持したまま
    // エラーを呼び出し元へ再スローする（成功時のみクリアする）。
    try {
      updateLessonLog(studentId, _editingLogId, payload);
    } catch (err) {
      console.error('授業記録の更新に失敗しました:', err);
      throw err;
    }
    _editingLogId = null;
    return 'updated';
  } else {
    addLessonLog(studentId, payload);
    return 'added';
  }
}

// ※ GEMINI_MODEL / GEMINI_ENDPOINT / fetchGeminiWithRetry / parseGeminiResponse は js-tea-ai.js に移動
const studentKey         = id => `student_data_${id}`;
const STUDENTS_TABS_KEY  = 'app_students_tabs';
const STUDENTS_INDEX_KEY = 'app_students_index';

const FIELD_IDS = [
  'f-name', 'f-grade',
  'lesson-date',
  'f-comp',
  'f-attitude',
  'f-goal', 'f-concerns', 'f-notes', 'f-takeaways',
  'f-lesson-content',
];

const TEST_TYPE_SUGGESTIONS = [
  '定期テスト', '実力テスト', '全統記述模試', '全統共通テスト模試', 
  '進研模試', '駿台模試', '駿台ベネッセ共通テスト模試', '全国統一高校生テスト', '全国統一中学生テスト', '共通テスト本番レベル模試', '冠模試', '英検', '漢検', '数検'
];

let _chartLogs = null;
/** リサイズタイマーID（デバウンス用） */
let _chartResizeTimer = null;

let _editingLogId  = null;
let studentCounter = 1;
let currentIndex   = 0;
let students       = [];

function createTestEntry() {
  return { type: '', grade: '', date: '', scores: '' };
}

function createShortTermGoalEntry() {
  return { text: '', deadline: '' };
}

/**
 * students 配列の defaultName から最大番号を求め、
 * studentCounter を「最大番号 + 1」にリセットする共通ヘルパー。
 * initStudents / removeStudent / importData の3箇所で使用する。
 */
function resetStudentCounter() {
  const max = students.reduce((m, s) => {
    const match = (s.defaultName || '').match(/生徒\s*(\d+)/);
    return match ? Math.max(m, parseInt(match[1], 10)) : m;
  }, 0);
  studentCounter = max + 1;
}

function createStudent() {
  const num  = studentCounter++;
  const data = {};
  FIELD_IDS.forEach(id => { data[id] = ''; });
  data.subjects        = [];
  data.tests           = [createTestEntry()];
  data.shortTermGoals  = [createShortTermGoalEntry()];
  return {
    id:               Date.now() + Math.random(),
    defaultName:      `生徒 ${num}`,
    tabName:          `生徒 ${num}`,
    data,
    result:           null,          // AI診断レポート結果
    lessonPlanResult: null,          // 次回授業案の結果
    lastResultType:   'diagnosis',   // 'diagnosis' | 'lessonplan' — 右パネルに最後に表示した種類
    mode:             'profile',     // 'profile' | 'report' | 'history'
    modeInitialized:  false,         // 初回タブ表示時に detectMode() で上書きするフラグ
  };
}

/**
 * students 配列と currentIndex を localStorage に保存する。
 * saveCurrentForm() やタブ操作のたびに呼び出すことで
 * ページリロード後もタブ一覧・入力内容を復元できる。
 * result / lessonPlanResult は容量節約のため保存しない
 * （AI診断の生ログは lessonLogs / aiDiagnostics に別途保存済み）。
 */
function saveStudentsTabs() {
  try {
    const toSave = students.map(s => ({
      id:              s.id,
      defaultName:     s.defaultName,
      tabName:         s.tabName,
      data:            s.data,
      mode:            s.mode,
      modeInitialized: s.modeInitialized,
      lastResultType:  s.lastResultType,
    }));
    localStorage.setItem(STUDENTS_TABS_KEY,  JSON.stringify(toSave));
    localStorage.setItem(STUDENTS_INDEX_KEY, String(currentIndex));
  } catch (e) {
    console.warn('タブ情報の保存に失敗しました:', e);
  }
}

/**
 * ページロード時に students 配列を localStorage から復元する。
 * 保存データがない場合は初期状態（「生徒 1」タブのみ）を生成する。
 */
function initStudents() {
  const saved = localStorage.getItem(STUDENTS_TABS_KEY);
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length > 0) {
        students = parsed.map(t => ({
          id:              t.id !== undefined ? t.id : Date.now() + Math.random(),
          defaultName:     t.defaultName    || '生徒',
          tabName:         t.tabName        || t.defaultName || '生徒',
          data:            t.data           || {},
          result:          null,
          lessonPlanResult: null,
          lastResultType:  t.lastResultType || 'diagnosis',
          mode:            t.mode           || 'profile',
          modeInitialized: typeof t.modeInitialized === 'boolean' ? t.modeInitialized : false,
        }));
        // studentCounter を復元した生徒数より大きい値に設定し、番号重複を防ぐ
        resetStudentCounter();
        // currentIndex を復元（範囲外の場合は 0 にフォールバック）
        const savedIdx = parseInt(localStorage.getItem(STUDENTS_INDEX_KEY) || '0', 10);
        currentIndex = (Number.isFinite(savedIdx) && savedIdx >= 0 && savedIdx < students.length)
          ? savedIdx : 0;
        return;
      }
    } catch (e) {
      console.warn('タブ情報の復元に失敗しました:', e);
    }
  }
  students     = [createStudent()];
  currentIndex = 0;
}

/**
 * localStorageの授業ログ有無でモードを自動判別する。
 * lessonLogs が 1 件以上あれば 'report'、なければ 'profile' を返す。
 */
function detectMode(studentId) {
  const data = getStudentData(studentId);
  return (data && data.lessonLogs.length > 0) ? 'report' : 'profile';
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

  if (!document.getElementById('section-history')) {
    const historySec = document.createElement('div');
    historySec.id = 'section-history';
    historySec.className = 'mode-section';
    panel.appendChild(historySec);
  }
}

/** mode に応じて form-panel 内のセクションを表示 / 非表示にする */
function showModeSection(mode) {
  const panel = document.getElementById('form-panel');
  if (!panel) return;

  [...panel.children].forEach(child => {
    if (child.id === 'sub-nav') return;

    if (child.id === 'section-history') {
      child.style.display = (mode === 'history') ? '' : 'none';
    } else if (mode === 'history') {
      child.style.display = 'none';
    } else if (mode === 'profile' && child.dataset.section === 'report') {
      // 基本情報タブでは report 専用要素を非表示
      child.style.display = 'none';
    } else if (mode === 'report' && child.dataset.section === 'profile') {
      // 【追加】授業記録タブでは profile 専用要素を非表示
      child.style.display = 'none';
    } else {
      child.style.display = '';
    }
  });

  if (mode === 'history') renderHistoryView();
}

/**
 * 生徒名が設定済みの場合、「生徒名」「学年」フィールドをロック（入力不可）にする。
 * 「授業日」「担当科目」は常に入力可能なまま維持する。
 * ロック解除は「変更」ボタンで一時的に可能。
 */
function updateBasicInfoLock(s) {
  const hasName   = (s.data['f-name'] || '').trim().length > 0;
  const nameInput   = document.getElementById('f-name');
  const gradeSelect = document.getElementById('f-grade');
  const unlockBtn   = document.getElementById('basic-info-unlock-btn');

  if (nameInput) {
    nameInput.disabled = hasName;
    nameInput.closest('.field')?.classList.toggle('field-locked', hasName);
  }
  if (gradeSelect) {
    gradeSelect.disabled = hasName;
    gradeSelect.closest('.field')?.classList.toggle('field-locked', hasName);
  }

  // 「変更」ボタンは生徒名が設定済みのときのみ表示
  if (unlockBtn) {
    unlockBtn.style.display = hasName ? '' : 'none';
  }
}

/** サブナビボタン押下時: フォームを保存してモードを切り替える */
function switchMode(mode) {
  // 同一モードへの再クリック時は何もしない。
  // これにより、ログ編集中（_editingLogId 設定済み）に「授業記録」タブを
  // 再クリックしても saveCurrentForm() が走らず、s.data がログ値で
  // 上書きされる汚染を防ぐ。
  if (mode === students[currentIndex].mode) return;

  // 編集中に report 以外へ切替する場合は確認を取る
  if (mode !== 'report' && _editingLogId) {
    if (!confirm('編集中の内容は保存されません。移動しますか？')) return;
    // 編集状態を解除し、フォームを生徒の基本データに戻してから保存する
    // （ログ編集中のデータ date/comp/attitude/notes が student.data に上書きされるのを防ぐ）
    _editingLogId = null;
    restoreForm(students[currentIndex]);
  }
  saveCurrentForm();
  students[currentIndex].mode = mode;
  updateSubNavActive(mode);
  showModeSection(mode);
  updateEditModeUI(); 
}

/**
 * log.unit のテキスト表現（buildFormData() が生成するフォーマット）を
 * テストエントリーの配列 { type, grade, date, scores }[] に変換する。
 * 復元できない場合は空エントリー1件を返す。
 *
 * 想定フォーマット（buildFormData の scoresText）:
 *   [定期テスト / 対象: 高2 / 実施日: 2024-06-01]
 *   数学 75点、英語 80点
 *
 *   [全統記述模試]
 *   英語 偏差値 55.2
 */
function parseUnitToTestEntries(unitText) {
  if (!unitText || unitText === '未入力') {
    return [createTestEntry()];
  }

  const blocks  = unitText.split(/\n\n+/);
  const entries = blocks.map(block => {
    const trimmed = block.trim();
    if (!trimmed) return null;

    const lines     = trimmed.split('\n');
    const firstLine = lines[0] || '';

    const headerMatch = firstLine.match(/^\[(.+)\]$/);
    let type = '', grade = '', date = '';

    if (headerMatch) {
      headerMatch[1].split('/').map(p => p.trim()).forEach(part => {
        if (part.startsWith('対象:')) {
          grade = part.slice(3).trim();
        } else if (part.startsWith('実施日:')) {
          date = part.slice(4).trim();
        } else if (!type && !/^テスト\d+$/.test(part)) {
          type = part;
        }
      });
      const scores = lines.slice(1).join('\n').trim();
      return { type, grade, date, scores };
    }

    return { type: '', grade: '', date: '', scores: trimmed };
  }).filter(Boolean);

  return entries.length > 0 ? entries : [createTestEntry()];
}

function syncSubjectChips() {
  document.querySelectorAll('#subjects .chip').forEach(chip => {
    chip.classList.toggle('selected', selectedSubjects.has(chip.dataset.val));
  });
}

// 科目文字列（例: "算数/数学、英語"）を単一科目の配列に分割する共通ヘルパー
function splitSubjects(subjectStr) {
  return (subjectStr || '').split(/[、,，]/).map(s => s.trim()).filter(Boolean);
}

function loadLogIntoReportForm(log) {
  const dateEl = document.getElementById('lesson-date');
  if (dateEl) dateEl.value = log.date || '';

  selectedSubjects.clear();
  splitSubjects(log.subject)
    .forEach(v => selectedSubjects.add(v));
  syncSubjectChips();

  const comp = parseComprehension(log.comprehension);
  const compVal = comp ? String(comp) : '';
  const compEl = document.getElementById('f-comp');
  if (compEl) compEl.value = compVal;
  updateScaleUI(compVal);

  const attitudeEl = document.getElementById('f-attitude');
  if (attitudeEl) attitudeEl.value = log.attitude || '';

  const notesEl = document.getElementById('f-notes');
  if (notesEl) notesEl.value = log.instructorNotes || '';

  const takeawaysEl = document.getElementById('f-takeaways');
  if (takeawaysEl) takeawaysEl.value = log.takeaways || '';

  // テスト・単元結果を復元（バグ修正①）
  // log.unit は保存時に buildFormData().scores として記録されたテキスト。
  // parseUnitToTestEntries でテストエントリー配列に変換してから renderTestList で描画する。
  renderTestList(parseUnitToTestEntries(log.unit));
  // 実施授業内容を復元
  const lessonContentEl = document.getElementById('f-lesson-content');
  if (lessonContentEl) lessonContentEl.value = log.lessonContent || '';
}

/**
 * 授業ログの1フィールド分のアコーディオン表示HTMLを生成する。
 * value が空（未入力）の場合は何も出力しない。
 */
function renderField(label, value) {
  if (!value) return '';
  return `<div class="accordion-field"><span class="accordion-field-label">${label}：</span>${escapeHtml(value).replace(/\n/g, '<br>')}</div>`;
}

function renderHistoryView() {
  const historySec = document.getElementById('section-history');
  if (!historySec) return;

  const s    = students[currentIndex];
  const name = (s.data['f-name'] || '').trim();

  if (!name) {
    historySec.innerHTML = '<p class="history-empty">生徒名を入力すると履歴が表示されます。</p>';
    return;
  }

  const studentId = 'std_' + students[currentIndex].id;
  const pastData  = getStudentData(studentId);

  if (!pastData ||
      (pastData.lessonLogs.length === 0 && pastData.aiDiagnostics.length === 0)) {
    historySec.innerHTML = '<p class="history-empty">まだ履歴はありません。</p>';
    return;
  }

  let html = '';

  if (pastData.aiDiagnostics.length > 0) {
    const lastDiag = pastData.aiDiagnostics[pastData.aiDiagnostics.length - 1];
    const prevDiag = pastData.aiDiagnostics.length > 1
      ? pastData.aiDiagnostics[pastData.aiDiagnostics.length - 2]
      : null;
    const { score, stars } = renderStars(lastDiag.overallScore);
    const pScore = prevDiag ? num(prevDiag.overallScore) : null;
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

  const logsWithComp = pastData.lessonLogs.filter(l =>
    parseComprehension(l.comprehension) > 0
  );
  if (logsWithComp.length > 0) {
    html += `
      <h3 class="history-section-title"><i class="ti ti-chart-line"></i> 理解度の推移</h3>
      <div class="chart-container">
        <canvas id="comp-chart"></canvas>
      </div>
    `;
  }

  if (pastData.lessonLogs.length > 0) {
    html += '<h3 class="history-section-title"><i class="ti ti-book"></i> 授業ログ</h3>';
    html += '<div class="accordion-list">';
    [...pastData.lessonLogs].reverse().forEach((log, idx) => {
      const comp  = parseComprehension(log.comprehension);
      const logId = escapeHtml(log.logId || '');
      html += `
        <div class="accordion-item${idx === 0 ? ' is-open' : ''}">
          <div class="accordion-header">
            <div class="accordion-header-left">
              <i class="ti ti-chevron-right accordion-icon"></i>
              <span class="history-date">${escapeHtml(log.date || '')}</span>
              ${log.subject ? `<span class="history-subject">${escapeHtml(log.subject)}</span>` : ''}
            </div>
            <div class="log-action-row">
              ${comp ? `<span class="history-comp">理解度 ${comp}/10</span>` : ''}
              <button type="button" class="log-action-btn edit-log-btn" data-logid="${logId}">
                <i class="ti ti-edit"></i> 編集
              </button>
              <button type="button" class="log-action-btn delete-btn delete-log-btn" data-logid="${logId}">
                <i class="ti ti-trash"></i> 削除
              </button>
            </div>
          </div>
          <div class="accordion-body">
            <div class="log-view">
              ${comp ? `
                <div class="accordion-comp-row">
                  <span class="mini-bar"><span class="mini-bar-fill" style="width:${Math.round(comp / 10 * 100)}%"></span></span>
                  <span class="accordion-comp-num">${comp} / 10</span>
                </div>` : ''}
              ${renderField('講師メモ', log.instructorNotes)}
              ${renderField('抽象化・転用メモ', log.takeaways)}
              ${renderField('学習態度', log.attitude)}
              ${renderField('宿題状況', log.homeworkStatus)}
              ${renderField('単元/結果', log.unit)}
            </div>
            <div class="log-ai-actions">
              <button type="button" class="log-action-btn ai-diag-btn" data-logid="${logId}">
                <i class="ti ti-sparkles"></i> AI診断
              </button>
              ${(() => {
                const subjectList = splitSubjects(log.subject);
                if (subjectList.length === 0) {
                  return `
                    <button type="button" class="log-action-btn ai-lesson-btn" data-logid="${logId}">
                      <i class="ti ti-calendar-event"></i> 次回授業案
                    </button>`;
                }
                return subjectList.map(sub => `
                  <button type="button" class="log-action-btn ai-lesson-btn" data-logid="${logId}" data-subject="${escapeHtml(sub)}">
                    <i class="ti ti-calendar-event"></i> 次回授業案（${escapeHtml(sub)}）
                  </button>
                `).join('');
              })()}
            </div>

          </div>
        </div>
      `;
    });
    html += '</div>';
  }

  if (pastData.aiDiagnostics.length > 0) {
    html += '<h3 class="history-section-title"><i class="ti ti-sparkles"></i> AI診断履歴</h3>';
    html += '<div class="accordion-list">';
    [...pastData.aiDiagnostics].reverse().forEach((diag, idx) => {
      const { score, stars } = renderStars(diag.overallScore);
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

  historySec.querySelectorAll('.accordion-header').forEach(header => {
    header.addEventListener('click', (e) => {
      if (e.target.closest('.log-action-btn')) return;
      header.closest('.accordion-item').classList.toggle('is-open');
    });
  });

  // ── AI系ボタン共通ハンドラ ──
  // 修正: renderHistoryView のスコープで生徒を固定する
  // クリックイベントは描画後に評価されるため、students[currentIndex] をクロージャ内で
  // 直接参照すると、クリック時点の currentIndex（別生徒）を参照するリスクがある。
  // 描画時にキャプチャ済みの s を使うことで、意図した生徒のデータを確実に渡す。
  const currentStudent = s; // ← 描画時にキャプチャ（s は L.914 で固定済み）
  function bindAiLogBtn(selector, runFn) {
    historySec.querySelectorAll(selector).forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const apiKey = document.getElementById('api-key')?.value.trim();
        if (!apiKey) { showApiKeyError(); return; }
        const log = pastData.lessonLogs.find(l => l.logId === btn.dataset.logid);
        if (!log) return;

        const formData = buildFormDataFromLog(log, currentStudent);
        // 科目別ボタン（data-subject付き）が押された場合、その科目のみに絞り込む
        if (btn.dataset.subject) formData.subjects = btn.dataset.subject;

        runFn(apiKey, formData, log.date, studentId, btn);
      });
    });
  }

  bindAiLogBtn('.ai-diag-btn',   runDiagnosisGeneration);
  bindAiLogBtn('.ai-lesson-btn', runLessonPlanGeneration);

  historySec.querySelectorAll('.delete-log-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const logId = btn.dataset.logid;
      if (!logId) return;
      if (confirm('この授業ログを削除しますか？')) {
        deleteLessonLog(studentId, logId);
        renderHistoryView();
      }
    });
  });
  historySec.querySelectorAll('.edit-log-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const logId = btn.dataset.logid;
      if (!logId) return;
      const log = pastData.lessonLogs.find(l => l.logId === logId);
      if (!log) return;

      // 編集対象ログIDを記憶し、授業記録タブへ遷移してからフォームへ値をセット
      // ※ switchMode を先に呼ぶことで saveCurrentForm() が実行される時点では
      //   DOM にはまだログ値が入っておらず、プロフィールデータの汚染を防ぐ（バグ④修正）
      _editingLogId = logId;
      switchMode('report');
      loadLogIntoReportForm(log);
      showToast('授業記録を編集中です。');
    });
  });

  if (logsWithComp.length > 0) {
    drawComprehensionChart(logsWithComp);
  }
}

function parseComprehension(val) {
  if (val == null || val === '' || val === '未入力') return 0;
  if (typeof val === 'number') return val;
  const m = String(val).match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}

function drawComprehensionChart(logs) {
  const canvas = document.getElementById('comp-chart');
  if (!canvas || !canvas.getContext) return;

  _chartLogs = logs;

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

function saveCurrentForm() {
  const s = students[currentIndex];
  FIELD_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (el) s.data[id] = el.value;
  });
  s.data.subjects       = [...selectedSubjects];
  s.data.tests          = collectTestEntries();
  s.data.shortTermGoals = collectGoalEntries();
  saveStudentsTabs(); // フォーム内容の変更を即時永続化
}

function restoreForm(s) {
  FIELD_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = s.data[id] || '';
  });

  const lessonDateEl = document.getElementById('lesson-date');
  if (lessonDateEl && !s.data['lesson-date']) {
    lessonDateEl.value = getLocalDate();
  }

  updateScaleUI(s.data['f-comp'] || '');

  selectedSubjects.clear();
  (s.data.subjects || []).forEach(v => selectedSubjects.add(v));
  syncSubjectChips();

  const tests = (s.data.tests && s.data.tests.length > 0)
    ? s.data.tests
    : [createTestEntry()];
  renderTestList(tests);

  const goals = (s.data.shortTermGoals?.length > 0)
    ? s.data.shortTermGoals
    : [createShortTermGoalEntry()];
  renderGoalList(goals);

  if (!s.modeInitialized) {
    s.mode = detectMode('std_' + s.id);
    s.modeInitialized = true;
  }

  updateSubNavActive(s.mode);
  showModeSection(s.mode);

  updateBasicInfoLock(s);

  if (s.lastResultType === 'lessonplan' && s.lessonPlanResult) {
    const fd = buildFormData();
    if (s.lessonPlanSubject) fd.subjects = s.lessonPlanSubject; // 生成時の科目で上書き
    renderLessonPlanResult(s.lessonPlanResult, fd);
    showState('state-result');
  } else if (s.result) {
    s.lastResultType = 'diagnosis';
    renderResult(s.result, buildFormData());
    showState('state-result');
  } else {
    showState('state-empty');
  }
}

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
        const name = students[i].data?.['f-name']?.trim() || students[i].tabName;
        if (!confirm(`「${name}」のデータを削除しますか？\nこの操作は元に戻せません。`)) return;
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

/**
 * ログ編集中（_editingLogId 設定済み）にタブ切替・生徒追加・生徒削除が
 * 行われた場合の保護処理。
 *
 * 背景（バグ修正）：switchMode() は編集中に「授業記録」以外へ移動する際、
 * 確認ダイアログ→編集状態解除→restoreForm() でフォームを元に戻す、という
 * 保護を行っていたが、switchTab / addStudent / removeStudent はこの保護を
 * 経由せず無条件に saveCurrentForm() を呼んでいたため、
 *   1) 編集中のログ値（f-comp/f-attitude/f-notes/f-takeaways/lesson-date等）が
 *      現在の生徒の基本データとしてそのまま上書き保存されてしまう（データ汚染）
 *   2) _editingLogId がグローバルなためタブを跨いでも保持され続け、
 *      別生徒側で保存すると存在しない logId を更新しようとして何も保存されない
 *      まま「更新しました」と表示される（サイレントなデータ消失）
 * という問題が起きていた。
 *
 * このヘルパーを各操作の先頭で呼び、編集中であれば確認の上で編集状態を破棄・
 * リセットしてから処理を続行することで、上記の汚染・消失を防ぐ。
 *
 * @returns {boolean} true: 処理を続行してよい / false: ユーザーがキャンセルしたため中断すべき
 */
function guardUnsavedLogEdit() {
  if (!_editingLogId) return true;
  if (!confirm('編集中の内容は保存されません。移動しますか？')) return false;
  // 編集状態を解除し、フォームを生徒の基本データに戻してから saveCurrentForm() を呼ぶ
  // （ログ編集中のデータが student.data に上書きされるのを防ぐ）
  _editingLogId = null;
  restoreForm(students[currentIndex]);
  updateEditModeUI();
  return true;
}

function switchTab(idx) {
  if (!guardUnsavedLogEdit()) return;
  saveCurrentForm();
  currentIndex = idx;
  saveStudentsTabs(); // currentIndex の変更を永続化
  renderTabs();
  restoreForm(students[currentIndex]);
}

function addStudent() {
  if (!guardUnsavedLogEdit()) return;
  saveCurrentForm();
  students.push(createStudent());
  currentIndex = students.length - 1;
  saveStudentsTabs(); // 新規タブを永続化（saveCurrentForm()はpush前に呼ばれているため別途保存）
  renderTabs();
  restoreForm(students[currentIndex]);
  const list = document.getElementById('tab-list');
  setTimeout(() => { list.scrollLeft = list.scrollWidth; }, 50);
}

function removeStudent(idx) {
  if (students.length === 1) return;
  if (!guardUnsavedLogEdit()) return;
  saveCurrentForm();
  const removedKey = studentKey('std_' + students[idx].id);
  localStorage.removeItem(removedKey);
  students.splice(idx, 1);
  // 残存する最大番号+1 に studentCounter をリセット
  resetStudentCounter();
  if (idx < currentIndex || currentIndex >= students.length) {
    currentIndex = Math.max(0, currentIndex - 1);
  }
  saveStudentsTabs(); // タブ削除後の状態を永続化（splice後に呼ぶ必要がある）
  renderTabs();
  restoreForm(students[currentIndex]);
}

// ※ showInlineError / showApiKeyError は js-tea-ai.js に移動
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function updateScaleUI(val) {
  document.querySelectorAll('#comp-scale .scale-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.val === String(val));
  });
}

const selectedSubjects = new Set();

function getVal(id) {
  const el = document.getElementById(id);
  return el ? el.value.trim() : '';
}

function formatShortTermGoals(goals) {
  const filled = goals.filter(g => g.text);
  return filled.length > 0
    ? filled.map((g, i) => `${i + 1}. ${g.text}${g.deadline ? `（期限: ${g.deadline}）` : ''}`).join('\n')
    : '未設定';
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

  const shortTermGoalsText = formatShortTermGoals(collectGoalEntries());

  return {
    name:           getVal('f-name')     || '未入力',
    grade:          getVal('f-grade')    || '未入力',
    subjects:       [...selectedSubjects].join('、') || '未入力',
    scores:         scoresText,
    comp:           compVal ? `${compVal} / 10` : '未入力',
    attitude:       getVal('f-attitude') || '未入力',
    goal:           getVal('f-goal')     || '未入力',
    shortTermGoals: shortTermGoalsText,
    concerns:       getVal('f-concerns') || '未入力',
    notes:          getVal('f-notes')    || '未入力',
    takeaways:      getVal('f-takeaways')  || '未入力',
    lessonContent:  getVal('f-lesson-content') || '未入力',
  };
}

function buildFormDataFromLog(log, student) {
  const shortTermGoalsText = formatShortTermGoals(student.data.shortTermGoals || []);

  const comp = parseComprehension(log.comprehension);

  return {
    name:           (student.data['f-name']  || '').trim() || student.defaultName || '未入力',
    grade:          student.data['f-grade']   || '未入力',
    subjects:       log.subject               || '未入力',
    scores:         log.unit                  || '未入力',
    comp:           comp ? `${comp} / 10`     : '未入力',
    attitude:       log.attitude              || '未入力',
    goal:           student.data['f-goal']    || '未入力',
    shortTermGoals: shortTermGoalsText,
    concerns:       student.data['f-concerns']|| '未入力',
    notes:          log.instructorNotes       || '未入力',
    takeaways:      log.takeaways             || '未入力',
    lessonContent:  log.lessonContent         || '未入力',
  };
}

// ※ AI生成の共通ラッパー・実行処理（runAiGeneration / runDiagnosisGeneration /
//   runLessonPlanGeneration）は js-tea-ai.js に移動。
//   ここでは AI側の関数を呼び出すだけ（gen-btn の onclick 等、下記 injectSaveLogButton 参照）。
function resetLessonContentField() {
  ['f-lesson-content', 'f-comp', 'f-attitude', 'f-notes', 'f-takeaways'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  updateScaleUI(''); // 理解度スケールボタンの選択状態もリセット

  selectedSubjects.clear();
  syncSubjectChips();
}

function showState(id) {
  ['state-empty', 'state-loading', 'state-error', 'state-result', 'state-summary'].forEach(s => {
    const el = document.getElementById(s);
    if (el) el.style.display = (s === id) ? '' : 'none';
  });
}

function setLoadingText(title, sub) {
  const titleEl = document.querySelector('#state-loading .state-title');
  const subEl   = document.querySelector('#state-loading .state-sub');
  if (titleEl) titleEl.textContent = title;
  if (subEl)   subEl.textContent   = sub || 'しばらくお待ちください';
}

/** エントリー削除→再採番→空なら1件補充、の共通処理（テスト／短期目標で共用） */
function removeEntryAndRefill(div, listId, itemSelector, renumberFn, refillElFn) {
  const list = document.getElementById(listId);
  div.remove();
  renumberFn();
  if (!list.querySelector(itemSelector)) {
    list.appendChild(refillElFn());
  }
}

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

  const header = div.querySelector('.test-entry-header');
  header.addEventListener('click', (e) => {
    if (e.target.closest('.test-remove-btn')) return;
    div.classList.toggle('is-open');
  });

  div.querySelector('.test-remove-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    removeEntryAndRefill(div, 'test-list', '.test-entry', renumberTestEntries, () => createTestEntryElement(createTestEntry(), 0));
  });

  return div;
}

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

    const input = el.querySelector('.test-type-input');
    const datalist = el.querySelector('datalist');
    if (input && datalist) {
      const listId = `test-type-list-${i}`;
      input.setAttribute('list', listId);
      datalist.id = listId;
    }
  });
}

function renderGoalList(goals) {
  const list = document.getElementById('short-goal-list');
  list.innerHTML = '';
  goals.forEach((g, i) => {
    list.appendChild(createGoalEntryElement(g, i));
  });
}

function createGoalEntryElement(g, idx) {
  const div     = document.createElement('div');
  div.className = 'goal-entry';

  div.innerHTML = `
    <span class="goal-entry-num">${idx + 1}</span>
    <input
      type="text"
      class="goal-text-input"
      placeholder="例：連立方程式を解けるようにする"
      value="${escapeHtml(g.text || '')}"
    >
    <input
      type="date"
      class="goal-deadline-input"
      value="${escapeHtml(g.deadline || '')}"
      title="達成期限"
    >
    <button class="goal-remove-btn" type="button" title="この目標を削除">
      <i class="ti ti-trash"></i>
    </button>
  `;

  div.querySelector('.goal-remove-btn').addEventListener('click', () => {
    removeEntryAndRefill(div, 'short-goal-list', '.goal-entry', renumberGoalEntries, () => createGoalEntryElement(createShortTermGoalEntry(), 0));
  });

  return div;
}

function collectGoalEntries() {
  const entries = [];
  document.querySelectorAll('#short-goal-list .goal-entry').forEach(entryEl => {
    const text     = entryEl.querySelector('.goal-text-input')?.value.trim()     || '';
    const deadline = entryEl.querySelector('.goal-deadline-input')?.value        || '';
    entries.push({ text, deadline });
  });
  return entries;
}

function renumberGoalEntries() {
  document.querySelectorAll('#short-goal-list .goal-entry').forEach((el, i) => {
    const numEl = el.querySelector('.goal-entry-num');
    if (numEl) numEl.textContent = i + 1;
  });
}

// ※ renderResult / renderLessonPlanResult（および copyToClipboard / bindCopyButton）
//   は js-tea-ai.js に移動
function exportAllData() {
  saveCurrentForm();

  const exportObj = {
    exportedAt:     new Date().toISOString(),
    appVersion:     'step6',
    tabs:           students.map(s => ({
      id:          s.id,
      tabName:     s.tabName,
      defaultName: s.defaultName,
      data:        s.data,
    })),
    studentRecords: {}
  };

  students.forEach(s => {
    const sid    = 'std_' + s.id;
    const record = getStudentData(sid);
    if (record) exportObj.studentRecords[sid] = record;
  });

  const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `生徒データ_${new Date().toISOString().split('T')[0]}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);
  showToast('エクスポートが完了しました ✓');
}

function importData(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const parsed = JSON.parse(e.target.result);
      const hasTabs = Array.isArray(parsed.tabs) && parsed.tabs.length > 0;

      // ① タブ一覧も上書きするか確認する（studentRecords への書き込みより前に判定）
      //    キャンセルした場合はここで処理を打ち切り、以降の書き込みを一切行わない
      let overwriteTabs = false;
      if (hasTabs) {
        overwriteTabs = confirm('タブ（生徒一覧）も上書きしますか？\nキャンセルするとインポートを中止します。');
        if (!overwriteTabs) {
          showToast('インポートをキャンセルしました');
          return;
        }
      }

      // ② localStorageへ生徒記録を保存
      //    ①でキャンセルされていた場合は return 済みのためここには到達しない
      if (parsed.studentRecords && typeof parsed.studentRecords === 'object') {
        Object.entries(parsed.studentRecords).forEach(([sid, record]) => {
          saveStudentData({ ...record, studentId: sid });
        });
      }

      if (overwriteTabs) {
        students = parsed.tabs.map(t => ({
          ...createStudent(),
          id:               t.id           || Date.now() + Math.random(),
          tabName:          t.tabName      || t.defaultName || '生徒',
          defaultName:      t.defaultName  || '生徒',
          data:             t.data         || {},
          result:           null,
          lessonPlanResult: null,
          lastResultType:   'diagnosis',
          mode:             'profile',
          modeInitialized:  false,
        }));
        // ④ studentCounter リセット（initStudents と同じロジック）
        // createStudent() の呼び出し回数分だけ余計に加算されたカウンタを
        // インポートデータの最大番号 + 1 に揃え直す
        resetStudentCounter();
        currentIndex = 0;
        saveStudentsTabs(); // インポートしたタブ一覧を永続化
        renderTabs();
        restoreForm(students[currentIndex]);
      }

      showToast('インポートが完了しました ✓');
    } catch (err) {
      showToast('インポートに失敗: ' + err.message, 'error');
    }
  };
  reader.readAsText(file);
}

function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `data-toast data-toast-${type}`;
  const icon = type === 'success' ? 'ti-circle-check' : 'ti-alert-triangle';
  toast.innerHTML = `<i class="ti ${icon}"></i> ${escapeHtml(message)}`;
  document.body.appendChild(toast);
  requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('show')));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function renderSummaryPanel() {
  saveCurrentForm();

  const TODAY      = new Date();
  const DANGER_COMP  = 4;   // 理解度 ≤ この値でフラグ（赤）
  const ABSENT_DAYS  = 14;  // この日数以上授業なしでフラグ（黄）

  const rows = students.map((s, idx) => {
    const name  = (s.data['f-name'] || '').trim() || s.defaultName;
    const grade = s.data['f-grade'] || '—';

    const record  = getStudentData('std_' + s.id);
    const logs    = record ? record.lessonLogs : [];

    const logsWithComp = logs.filter(l => parseComprehension(l.comprehension) > 0);
    const lastComp = logsWithComp.length > 0
      ? parseComprehension(logsWithComp[logsWithComp.length - 1].comprehension)
      : null;

    const lastLog  = logs.length > 0 ? logs[logs.length - 1] : null;
    const lastDate = lastLog ? lastLog.date : null;
    const daysAgo  = lastDate
      ? Math.floor((TODAY - new Date(lastDate + 'T00:00:00')) / 86400000)
      : null;

    const flags = [];
    if (lastComp !== null && lastComp <= DANGER_COMP) {
      flags.push({ type: 'danger',  icon: 'ti-alert-circle', label: `理解度 ${lastComp}/10` });
    }
    if (daysAgo !== null && daysAgo >= ABSENT_DAYS) {
      flags.push({ type: 'warning', icon: 'ti-clock',        label: `${daysAgo}日授業なし` });
    }
    if (flags.length === 0 && lastDate === null) {
      flags.push({ type: 'muted',   icon: 'ti-pencil-off',   label: '授業記録なし' });
    }

    return { idx, name, grade, lastDate, daysAgo, lastComp, flags };
  });

  const dangerCount  = rows.filter(r => r.flags.some(f => f.type === 'danger')).length;
  const warningCount = rows.filter(r => r.flags.some(f => f.type === 'warning')).length;

  let html = `
    <div class="summary-header">
      <div class="summary-title"><i class="ti ti-users"></i> 全生徒サマリー</div>
      <div class="summary-meta">${students.length} 名登録中</div>
    </div>

    <div class="summary-kpi-row">
      <div class="summary-kpi ${dangerCount  > 0 ? 'kpi-danger'  : 'kpi-ok'}">
        <div class="kpi-num">${dangerCount}</div>
        <div class="kpi-label">理解度が低い生徒</div>
      </div>
      <div class="summary-kpi ${warningCount > 0 ? 'kpi-warning' : 'kpi-ok'}">
        <div class="kpi-num">${warningCount}</div>
        <div class="kpi-label">2週間以上授業なし</div>
      </div>
      <div class="summary-kpi kpi-neutral">
        <div class="kpi-num">${students.length}</div>
        <div class="kpi-label">総生徒数</div>
      </div>
    </div>

    <div class="summary-table-wrap">
      <table class="summary-table">
        <thead>
          <tr>
            <th>生徒名</th>
            <th>学年</th>
            <th>直近理解度</th>
            <th>最終授業日</th>
            <th>ステータス</th>
          </tr>
        </thead>
        <tbody>
  `;

  rows.forEach(r => {
    const hasDanger  = r.flags.some(f => f.type === 'danger');
    const hasWarning = r.flags.some(f => f.type === 'warning');
    const rowClass   = hasDanger ? 'row-danger' : hasWarning ? 'row-warning' : '';

    const flagsHTML = r.flags.map(f =>
      `<span class="flag-badge flag-${f.type}"><i class="ti ${f.icon}"></i> ${escapeHtml(f.label)}</span>`
    ).join('');

    const compCell = r.lastComp !== null
      ? `<div class="comp-mini">
           <span class="mini-bar"><span class="mini-bar-fill" style="width:${Math.round(r.lastComp / 10 * 100)}%"></span></span>
           <span>${r.lastComp}/10</span>
         </div>`
      : '<span class="summary-text-muted">—</span>';

    const dateCell = r.lastDate
      ? `${escapeHtml(r.lastDate)}<br><span class="summary-text-muted" style="font-size:10px">${r.daysAgo}日前</span>`
      : '<span class="summary-text-muted">記録なし</span>';

    html += `
      <tr class="${rowClass}" data-student-idx="${r.idx}" title="${escapeHtml(r.name)} のタブへ移動">
        <td><span class="student-name-cell"><i class="ti ti-user-circle"></i> ${escapeHtml(r.name)}</span></td>
        <td>${escapeHtml(r.grade)}</td>
        <td>${compCell}</td>
        <td>${dateCell}</td>
        <td>${flagsHTML}</td>
      </tr>
    `;
  });

  html += `
        </tbody>
      </table>
    </div>

    <div class="summary-actions">
      <button type="button" class="action-btn action-btn-primary" id="summary-export-btn">
        <i class="ti ti-download"></i> 全データをエクスポート
      </button>
      <label class="action-btn summary-import-label">
        <i class="ti ti-upload"></i> データをインポート
        <input type="file" id="summary-import-input" accept=".json" style="display:none">
      </label>
    </div>
    <p class="summary-hint">
      <i class="ti ti-info-circle"></i>
      生徒の行をクリックするとそのタブへ切り替わります
    </p>
  `;

  const summaryEl = document.getElementById('state-summary');
  summaryEl.innerHTML = html;
  showState('state-summary');

  summaryEl.querySelectorAll('tr[data-student-idx]').forEach(row => {
    row.style.cursor = 'pointer';
    row.addEventListener('click', () => switchTab(Number(row.dataset.studentIdx)));
  });

  document.getElementById('summary-export-btn').addEventListener('click', exportAllData);

  const summaryImportInput = document.getElementById('summary-import-input');
  summaryImportInput.addEventListener('change', e => {
    if (e.target.files[0]) importData(e.target.files[0]);
    e.target.value = '';
  });
}

function updateEditModeUI() {
  const isEditing = !!_editingLogId;
  const saveBtn   = document.getElementById('save-log-btn');
  const cancelBtn = document.getElementById('cancel-edit-btn');
  if (cancelBtn) cancelBtn.style.display = isEditing ? '' : 'none';
  if (saveBtn) {
    saveBtn.innerHTML = isEditing
      ? '<i class="ti ti-device-floppy"></i> 編集内容を保存'
      : '<i class="ti ti-save"></i> 授業記録のみ保存する';
    saveBtn.classList.toggle('save-log-btn--editing', isEditing);
  }
}

// 「履歴モードへ戻る」定型処理の共通化
// cancelEditMode と save-log-btn.onclick の wasEditing分岐で重複していた
// 「フォーム復元→履歴モードへ遷移（saveCurrentForm をスキップ）」を1箇所にまとめる。
// showToast は呼び出し元ごとにメッセージが異なるため、この関数の外で個別に呼ぶ。
function returnToHistoryMode() {
  // フォームを編集開始前の状態（student.data）に復元
  restoreForm(students[currentIndex]);
  // 履歴タブへ直接遷移（saveCurrentForm をスキップ）
  students[currentIndex].mode = 'history';
  saveStudentsTabs();
  updateSubNavActive('history');
  showModeSection('history');
  updateEditModeUI();
}

function cancelEditMode() {
  _editingLogId = null;
  returnToHistoryMode();
  showToast('編集をキャンセルしました');
}

// フォーム検証＋コンテキスト取得の共通化
// gen-btn.onclick と save-log-btn.onclick の冒頭で重複していた
// 「buildFormData()取得→lessonDate算出→氏名未入力チェック→studentId算出」を1箇所にまとめる。
// currentIndex は呼び出し時点（各onclick発火時）で評価されるため、既存の挙動と同一。
function getValidatedFormContext() {
  const formData   = buildFormData();
  const lessonDate = getVal('lesson-date') || getLocalDate();

  if (!formData.name || formData.name === '未入力') {
    showToast('生徒名を入力してください', 'error');
    return null;
  }

  return { formData, lessonDate, studentId: 'std_' + students[currentIndex].id };
}

// 授業記録の保存処理の共通化
// gen-btn.onclick と save-log-btn.onclick で完全に重複していた
// 「saveOrUpdateLessonLog の呼び出し→失敗時のエラーログ＋トースト表示」を1箇所にまとめる。
// 成功時は saveOrUpdateLessonLog の戻り値（action）をそのまま返し、
// 失敗（例外）時は console.error + showToast のみ行い null を返す。
// 呼び出し側は戻り値が null かどうかで成功/失敗を判定し、以降の処理を分岐させる。
function trySaveLessonLog(studentId, formData, lessonDate) {
  try {
    return saveOrUpdateLessonLog(studentId, formData, lessonDate);
  } catch (err) {
    console.error('授業記録の保存に失敗しました:', err);
    showToast('授業記録の保存に失敗しました。時間をおいて再度お試しください', 'error');
    return null;
  }
}

function injectSaveLogButton() {
  // HTML に既存のボタンがあればそのまま使い、なければ動的生成して gen-btn の直後に挿入
  let btn = document.getElementById('save-log-btn');
  let cancelBtn = document.getElementById('cancel-edit-btn');

  // gen-btn は位置参照と onclick 設定の両方で使うため if(!btn) ブロックの外で取得する
  const genBtn = document.getElementById('gen-btn');

  // ── gen-btn のクリックハンドラを設定する ──
  // HTML 側に onclick 属性が存在しない場合でも診断生成が動作するよう JS 側で必ず登録する
  if (genBtn) {
    genBtn.onclick = () => {
      const apiKey = document.getElementById('api-key')?.value.trim();
      if (!apiKey) { showApiKeyError(); return; }

      const ctx = getValidatedFormContext();
      if (!ctx) return;
      const { formData, lessonDate, studentId } = ctx;

      // バグ⑤修正: 診断実行前に授業ログを保存する
      // 「授業記録のみ保存する」ボタンの押し忘れでログが消失するのを防ぐため、
      // runDiagnosisGeneration を呼ぶ前に必ず saveOrUpdateLessonLog を実行する。
      // （runDiagnosisGeneration 側は「ログは保存済み」前提で実装されているため、
      //   ここで保存しておかないと診断結果だけが残りログが残らない状態になる）
      // 修正②: trySaveLessonLog が失敗（例外）した場合は null が返る。
      // 未処理のまま診断生成に進んでしまうと
      // ログが保存されていないのに診断結果だけが残る不整合が起きるため、
      // 失敗時はここで処理を中断する（エラーログ・トースト表示は trySaveLessonLog 内で実施済み）。
      const action = trySaveLessonLog(studentId, formData, lessonDate);
      if (action === null) return;
      showToast(action === 'updated' ? '授業記録を更新しました ✓' : '授業記録を保存しました ✓');
      // saveOrUpdateLessonLog 内で _editingLogId がクリアされるため、
      // 保存/更新ボタンの表示（編集中ラベル・キャンセルボタン）を最新状態に同期する
      updateEditModeUI();

      runDiagnosisGeneration(apiKey, formData, lessonDate, studentId, genBtn);
    };
  }

  if (!btn) {
    if (!genBtn) return;

    btn = document.createElement('button');
    btn.type      = 'button';
    btn.className = 'action-btn';
    btn.id        = 'save-log-btn';
    btn.innerHTML = '<i class="ti ti-save"></i> 授業記録のみ保存する';

    genBtn.insertAdjacentElement('afterend', btn);
  }

  // ── HTML既存ボタン・動的生成ボタンどちらにも必ず onclick を設定する ──
  btn.onclick = () => {
    const ctx = getValidatedFormContext();
    if (!ctx) return;
    const { formData, lessonDate, studentId } = ctx;

    const wasEditing = !!_editingLogId; // 保存前に編集モードを記憶

    // 修正②: trySaveLessonLog が失敗（例外）した場合は null が返る。
    // 未処理のまま以降のフォームリセットや履歴モードへの遷移が走ると、
    // 保存に失敗したことにユーザーが気づけない（エラーログ・トースト表示は
    // trySaveLessonLog 内で実施済み）。
    const action = trySaveLessonLog(studentId, formData, lessonDate);
    if (action === null) return;
    showToast(action === 'updated' ? '授業記録を更新しました ✓' : '授業記録を保存しました ✓');
    resetLessonContentField();   // switchMode/restoreForm の前に実行

    // lesson-date を今日の日付にリセット
    // 新規保存後に switchMode('history') が saveCurrentForm() を呼ぶ時点で
    // 古い日付が s.data['lesson-date'] に残るのを防ぐ。
    // 編集時は直後の restoreForm() が s.data の値で上書きするため影響なし。
    const lessonDateEl = document.getElementById('lesson-date');
    if (lessonDateEl) lessonDateEl.value = getLocalDate();

    if (wasEditing) {
      // 編集時: saveCurrentForm() をスキップして s.data を汚染しない
      // saveOrUpdateLessonLog 内で _editingLogId はクリア済み
      returnToHistoryMode();
    } else {
      switchMode('history'); // 新規保存時は従来通り
    }
  };

  if (!cancelBtn) {
    cancelBtn = document.createElement('button');
    cancelBtn.type      = 'button';
    cancelBtn.className = 'action-btn action-btn-danger';
    cancelBtn.id        = 'cancel-edit-btn';
    cancelBtn.style.display = 'none'; // 通常時は非表示
    cancelBtn.innerHTML = '<i class="ti ti-x"></i> 編集をキャンセル';
    btn.insertAdjacentElement('afterend', cancelBtn);
  }

  cancelBtn.onclick = cancelEditMode;
}

document.addEventListener('DOMContentLoaded', () => {

  const scrollPanelToBottom = () =>
    setTimeout(() => document.getElementById('form-panel')
      ?.scrollTo({ top: Infinity, behavior: 'smooth' }), 50);

  document.querySelectorAll('#comp-scale .scale-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.val;
      document.getElementById('f-comp').value = val;
      updateScaleUI(val);
    });
  });

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

  on('f-name', 'input', e => {
    const name = e.target.value.trim();
    students[currentIndex].tabName = name || students[currentIndex].defaultName;
    const labels = document.querySelectorAll('#tab-list .tab-label');
    if (labels[currentIndex]) {
      labels[currentIndex].textContent = students[currentIndex].tabName;
    }
    saveStudentsTabs(); // タブ名（生徒名）の変更を即時永続化
  });

  on('test-add-btn', 'click', () => {
    const list = document.getElementById('test-list');
  
    list.querySelectorAll('.test-entry').forEach(entry => {
      entry.classList.remove('is-open');
    });

    const newIdx = list.querySelectorAll('.test-entry').length;
    list.appendChild(createTestEntryElement(createTestEntry(), newIdx));
  
    scrollPanelToBottom();
  });

  on('goal-add-btn', 'click', () => {
    const list   = document.getElementById('short-goal-list');
    const newIdx = list.querySelectorAll('.goal-entry').length;
    list.appendChild(createGoalEntryElement(createShortTermGoalEntry(), newIdx));

    scrollPanelToBottom();
  });

  // ── テスト結果の変更を即時永続化 ──
  // change を追加しているのは、test-grade-select（学年セレクト）と
  // test-date-input（日付入力）がブラウザによっては input だけでは捕捉できないケースがあるため。
  ['input', 'change'].forEach(evt => {
    on('test-list', evt, () => {
      students[currentIndex].data.tests = collectTestEntries();
      saveStudentsTabs();
    });
  });

  on('short-goal-list', 'input', () => {
    students[currentIndex].data.shortTermGoals = collectGoalEntries();
    saveStudentsTabs();
  });

  /* タブ・データ管理ボタン */
  on('tab-add-btn', 'click', addStudent);

  on('tab-summary-btn', 'click', renderSummaryPanel);
  on('tab-export-btn', 'click', exportAllData);
  on('tab-import-btn', 'click', () => {
    document.getElementById('import-file-input')?.click();
  });
  on('import-file-input', 'change', e => {
    if (e.target.files[0]) importData(e.target.files[0]);
    e.target.value = '';
  });

  on('basic-info-unlock-btn', 'click', () => {
    // updateBasicInfoLock を「常にロック解除扱い」で呼び出すことで、
    // f-name/f-grade の disabled解除・.field-locked除去・unlockBtn非表示を一括反映する
    updateBasicInfoLock({ data: {} });
    document.getElementById('f-name')?.focus();
  });

  renderSubNav();
  initSections();
  initStudents(); // localStorage からタブ一覧・基本情報を復元（ページリロード対策）
  renderTabs();
  restoreForm(students[currentIndex]);
  injectSaveLogButton();

  // ※ APIキー表示トグル（api-key-toggle）・APIキー永続化（initApiKeyPersistence）の
  //   初期化は js-tea-ai.js 側の DOMContentLoaded ハンドラで行う

  /* 理解度グラフのリサイズ対応
     - ウィンドウ幅が変わったとき、グラフが表示中であれば再描画する
     - デバウンス 150ms でパフォーマンスを確保 */
  window.addEventListener('resize', () => {
    clearTimeout(_chartResizeTimer);
    _chartResizeTimer = setTimeout(() => {
      const canvas = document.getElementById('comp-chart');
      // Canvasが表示されている（幅を持っている）場合のみ再描画する
      if (canvas && canvas.offsetWidth > 0 && _chartLogs) {
        drawComprehensionChart(_chartLogs);
      }
    }, 150);
  });

}); // end DOMContentLoaded
