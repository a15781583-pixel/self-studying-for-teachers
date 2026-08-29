/**
 * js-tea-ai.js
 * ------------------------------------------------------------
 * AI（Gemini）連携まわりを app-講師用AI作成.js（core）から分離したファイル。
 *
 * 【このファイルが持つもの】
 *   - Gemini API 呼び出し（fetchGeminiWithRetry / parseGeminiResponse）
 *   - AI生成の実行フロー（runAiGeneration / runDiagnosisGeneration / runLessonPlanGeneration）
 *   - AI結果の描画（renderResult / renderLessonPlanResult）
 *   - AI診断データの永続化（addAIDiagnostics）
 *   - APIキー関連UI（showApiKeyError、表示トグル、永続化）
 *   - 上記でのみ使うコピー系ヘルパー（copyToClipboard / bindCopyButton）と
 *     エラー表示ヘルパー（showInlineError）
 *
 * 【core（app-講師用AI作成.js）に依存している点】
 *   - データ層: getStudentData, mutateStudentData
 *   - 状態: students, currentIndex, _editingLogId 等のグローバル
 *   - 共通ヘルパー: getLocalDate, escapeHtml, renderStars, num,
 *     parseComprehension, splitSubjects, showState, setLoadingText,
 *     buildFormData, showToast
 *
 * 【読み込み順について】
 *   本ファイルと app-講師用AI作成.js は互いの関数をグローバルスコープ経由で
 *   参照し合うが、実際の呼び出しはすべて DOMContentLoaded 以降（イベント
 *   ハンドラ内）に発生するため、<script> タグの読み込み順はどちらが先でも
 *   問題ない（両ファイルとも通常の非モジュールスクリプトであること）。
 * ------------------------------------------------------------
 */

/* ===== Gemini API 設定・通信 ===== */

const GEMINI_MODEL    = 'gemini-3.6-flash';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1/models/${GEMINI_MODEL}:generateContent`;

async function fetchGeminiWithRetry(apiKey, requestBody, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        const msg = errBody?.error?.message || `${response.status} ${response.statusText}`;
        
        // 503(サーバー高負荷) または 429(リクエスト過多) の場合のみリトライ
        if (response.status === 503 || response.status === 429) {
          if (i < maxRetries - 1) {
            console.warn(`API高負荷のため再試行します（${i + 1}回目）...`);
            // 待機時間を徐々に長くする (2秒 → 4秒)
            const waitTime = (i + 1) * 2000;
            await new Promise(resolve => setTimeout(resolve, waitTime));
            continue; // ループの最初に戻って再リクエスト
          }
        }
        // リトライ対象外のエラーにはフラグを付けて投げる
        const error = new Error(msg);
        error.isFatal = true;
        throw error;
      }

      return await response.json();
      
    } catch (err) {
      if (err.isFatal || i === maxRetries - 1) throw err;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

function parseGeminiResponse(data) {
  if (data.candidates?.[0]?.finishReason === 'MAX_TOKENS') {
    throw new Error('レスポンスがトークン上限に達しました。入力情報を減らすか、しばらく時間をおいて再試行してください。');
  }
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) throw new Error('AIからのレスポンスを取得できませんでした。');
  try {
    return JSON.parse(rawText.trim());
  } catch (e) {
    throw new Error('AIレスポンスの解析に失敗しました。しばらくしてから再試行してください。');
  }
}

/* ===== コピー系ヘルパー（AI結果表示でのみ使用） ===== */

function copyToClipboard(text, btnId, originalHTML) {
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.innerHTML = '<i class="ti ti-check"></i> コピーしました';
    setTimeout(() => { btn.innerHTML = originalHTML; }, 2000);
  }).catch(() => showToast('コピーに失敗しました', 'error'));
}

/* ===========================
   コピーボタン共通バインドヘルパー
   - originalHTML をバインド時に DOM から自動取得するため、
     ハードコード文字列と HTML 側の表記がズレるリスクを解消
=========================== */
function bindCopyButton(id, textBuilder) {
  const btn = document.getElementById(id);
  if (!btn) return;
  const originalHTML = btn.innerHTML;
  btn.addEventListener('click', () => copyToClipboard(textBuilder(), id, originalHTML));
}

/* ===== エラー表示（AI関連） ===== */

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

function showApiKeyError() {
  showInlineError(
    'APIキーを入力してください。<br>' +
    '<small><a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer" style="color:inherit;">Google AI Studio で無料取得できます →</a></small>'
  );
}

/* ===== AI診断データの永続化 ===== */

function addAIDiagnostics(studentId, aiResult) {
  const newDiag = {
    ...aiResult,
    diagId: `diag_${crypto.randomUUID()}`,
    date: getLocalDate(),
  };
  return mutateStudentData(studentId, d => d.aiDiagnostics.push(newDiag));
}

/* ===== AI生成の実行フロー ===== */

// AI生成処理（診断／次回授業案）の共通ラッパー
// capturedIndex取得→ボタン無効化→ローディング表示→fetchGeminiWithRetry→
// parseGeminiResponse→エラー処理→finallyでボタン復帰、という共通の骨格をここに集約する。
// プロンプト組み立て・スキーマ・成功時処理だけを呼び出し側から設定値として渡す。
async function runAiGeneration(apiKey, triggerBtn, { loadingTitle, buildPrompt, schema, maxOutputTokens, errorLabel, onSuccess }) {
  const capturedIndex = currentIndex; // Race Condition 対策: await 前に currentIndex をキャプチャ
  if (triggerBtn) triggerBtn.disabled = true;
  setLoadingText(loadingTitle);
  showState('state-loading');

  try {
    const data = await fetchGeminiWithRetry(apiKey, {
      contents: [{ parts: [{ text: buildPrompt() }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens,
        responseMimeType: 'application/json',
        responseSchema: schema
      }
    });

    const result = parseGeminiResponse(data);
    onSuccess(result, capturedIndex);

    // Race Condition 対策: AI生成中にタブが切り替わっていた場合、
    // 画面表示（state-result への遷移）はスキップする。
    // データ自体は onSuccess 内で capturedIndex を使って正しい生徒に保存済み。
    if (capturedIndex === currentIndex) {
      showState('state-result');
    }

  } catch (err) {
    showInlineError(
      `${errorLabel}に失敗しました。APIキーとネットワーク接続を確認してください。<br>` +
      `<small>${escapeHtml(err.message)}</small>`
    );
  } finally {
    if (triggerBtn) triggerBtn.disabled = false;
  }
}

async function runDiagnosisGeneration(apiKey, formData, lessonDate, studentId, triggerBtn) {
  const pastData     = getStudentData(studentId);
  const previousLogs = pastData ? pastData.lessonLogs.slice(-10) : [];
  const lastDiag     = (pastData && pastData.aiDiagnostics.length > 0)
    ? pastData.aiDiagnostics[pastData.aiDiagnostics.length - 1] : null;

  const compValues = (pastData ? pastData.lessonLogs : [])
    .map(l => parseComprehension(l.comprehension)).filter(v => v > 0);
  let compTrendText = '記録なし';
  if (compValues.length >= 2) {
    const half   = Math.ceil(compValues.length / 2);
    const avgOld = (compValues.slice(0, half).reduce((a, b) => a + b, 0) / half).toFixed(1);
    const avgNew = (compValues.slice(-half).reduce((a, b) => a + b, 0) / half).toFixed(1);
    const diff   = (Number(avgNew) - Number(avgOld)).toFixed(1);
    const arrow  = Number(diff) > 0.5 ? '上昇傾向↑' : Number(diff) < -0.5 ? '低下傾向↓' : '横ばい→';
    compTrendText = `${arrow}（前半平均 ${avgOld} → 後半平均 ${avgNew}、変化 ${Number(diff) >= 0 ? '+' : ''}${diff}、全${compValues.length}件）`;
  }

  const scoreDiffText = (pastData && pastData.aiDiagnostics.length > 1 && lastDiag)
    ? (() => {
        const prev = pastData.aiDiagnostics[pastData.aiDiagnostics.length - 2];
        const d = num(lastDiag.overallScore) - num(prev?.overallScore);
        return `${d >= 0 ? '+' : ''}${d}（前回 ${num(prev?.overallScore)} → 直近 ${num(lastDiag.overallScore)}）`;
      })()
    : '初回診断のため比較なし';

  const buildPrompt = () => `
あなたはプロの教育コンサルタント・塾講師です。
生徒の基本情報、過去の学習変化、今回の授業内容を踏まえ、保護者も納得する高品質な診断レポートを作成してください。

【生徒情報】
名前: ${formData.name}
学年: ${formData.grade}
担当科目: ${formData.subjects}
【目標】
長期目標: ${formData.goal}
短期目標:
${formData.shortTermGoals}
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
   転用メモ: ${log.takeaways || 'なし'}
`).join('') : '過去の授業ログはありません'}

【今回の授業レポート (${lessonDate})】
実施授業内容: ${formData.lessonContent}
理解度（10段階）: ${formData.comp}
テスト・単元結果: ${formData.scores}
学習態度・自習状況: ${formData.attitude}
講師メモ: ${formData.notes}
抽象化・転用メモ: ${formData.takeaways}

【指示】
- 学習傾向分析の数値（理解度の傾向・スコア変化）を必ず言及し、変化を具体的に評価してください。
- 過去のデータと比較し、「成長できた点」「継続して取り組む課題」を具体的に述べてください。
- 複数の科目が含まれる場合は、全体をぼやかさず「【英語】〇〇」「【数学】〇〇」のように科目ごとに明確に見出しをつけて具体的に診断してください。
- 次回授業プランは今回の課題を踏まえ、科目ごとに単元名・教材名・つまずきやすい箇所を明記してください。
- 保護者向けメッセージは丁寧で前向き、そのまま面談や連絡帳で渡せるクオリティにしてください。
- 短期目標の達成状況・進捗を具体的に評価し、「今すぐ取り組むべきこと」に反映してください。
- 週間プラン・月間プランは、科目ごとのバランスを考慮し、短期目標の達成ステップと長期目標への道筋を構成してください。
`.trim();

  await runAiGeneration(apiKey, triggerBtn, {
    loadingTitle: 'AIが分析中です...',
    buildPrompt,
    maxOutputTokens: 8192,
    errorLabel: '診断の生成',
    schema: {
      type: 'OBJECT',
      properties: {
        overallScore:    { type: 'INTEGER', minimum: 1, maximum: 5 },
        overallComment:  { type: 'STRING' },
        strengths:       { type: 'ARRAY', items: { type: 'STRING' } },
        improvements:    { type: 'ARRAY', items: { type: 'STRING' } },
        weeklyPlan:      { type: 'STRING' },
        monthlyPlan:     { type: 'STRING' },
        nextLessonPlan: {
          type: 'OBJECT',
          properties: {
            objective: { type: 'STRING' },
            keyPoints: { type: 'ARRAY', items: { type: 'STRING' } },
            materials: { type: 'STRING' },
            pitfalls:  { type: 'ARRAY', items: { type: 'STRING' } }
          },
          required: ['objective', 'keyPoints', 'materials', 'pitfalls']
        },
        instructorAdvice: { type: 'STRING' },
        parentMessage:    { type: 'STRING' },
        urgentAction:     { type: 'STRING' }
      },
      required: [
        'overallScore', 'overallComment', 'strengths', 'improvements',
        'weeklyPlan', 'monthlyPlan', 'nextLessonPlan',
        'instructorAdvice', 'parentMessage', 'urgentAction'
      ]
    },
    onSuccess: (result, capturedIndex) => {
      addAIDiagnostics(studentId, result);
      students[capturedIndex].result         = result;
      students[capturedIndex].lastResultType = 'diagnosis';

      // Race Condition 対策: 生成中に別の生徒タブへ切り替わっていた場合、
      // 元のタブの結果を今表示中の画面へ描画してしまわないようにスキップする。
      if (capturedIndex === currentIndex) {
        renderResult(result, formData);
      }
    }
  });
}

async function runLessonPlanGeneration(apiKey, formData, lessonDate, studentId, triggerBtn) {
  const pastData      = getStudentData(studentId);
  const targetSubject = formData.subjects; // ③でボタンの科目に上書き済み

  const sameSubjectLogs = pastData
    ? pastData.lessonLogs.filter(log => splitSubjects(log.subject).includes(targetSubject))
    : [];
  const recentLogs = (sameSubjectLogs.length > 0 ? sameSubjectLogs : (pastData?.lessonLogs || [])).slice(-5);

  const buildPrompt = () => `
あなたはベテラン塾講師です。
以下の授業履歴と今回の指導記録をもとに、次回授業の具体的な指導案を作成してください。
総合診断・保護者向けコメント・月間計画は不要です。授業計画のみに特化して回答してください。

【生徒情報】
名前: ${formData.name}
学年: ${formData.grade}
担当科目: ${formData.subjects}
【目標】
長期目標: ${formData.goal}
短期目標:
${formData.shortTermGoals}
現在の課題: ${formData.concerns}

【直近の授業履歴（最大5件）】
${recentLogs.length > 0
  ? recentLogs.map((log, i) =>
      `${i + 1}. [${log.date}] 科目: ${log.subject} / 理解度: ${parseComprehension(log.comprehension)}/10\n   メモ: ${log.instructorNotes}\n   転用メモ: ${log.takeaways || 'なし'}`
    ).join('\n')
  : '過去の授業ログはありません'}

【今回の授業（${lessonDate}）】
実施授業内容: ${formData.lessonContent}
理解度（10段階）: ${formData.comp}
テスト・単元結果: ${formData.scores}
学習態度: ${formData.attitude}
講師メモ: ${formData.notes}
抽象化・転用メモ: ${formData.takeaways}

【指示】
- 今回作成する授業案は「${formData.subjects}」科目のみを対象とします。今回の授業内容や履歴に他科目の内容が混在していても、次回授業案には対象科目以外の内容を一切含めないでください。
- 今回の理解度・課題を踏まえ、次回の授業目標を1文で端的に示してください。
- 重点指導ポイントは具体的に単元名・問題タイプを挙げてください。
- 生徒がつまずきやすい箇所と講師がとるべき対処法を明記してください。
- 指導のヒントとして、この生徒への効果的なアプローチを1〜2文で示してください。
- 短期目標の期限が近い場合は、その達成を最優先した集中指導プランを示してください。
`.trim();

  await runAiGeneration(apiKey, triggerBtn, {
    loadingTitle: '次回授業案を作成中...',
    buildPrompt,
    maxOutputTokens: 2048,
    errorLabel: '次回授業案の生成',
    schema: {
      type: 'OBJECT',
      properties: {
        objective:    { type: 'STRING' },
        keyPoints:    { type: 'ARRAY', items: { type: 'STRING' } },
        pitfalls:     { type: 'ARRAY', items: { type: 'STRING' } },
        teachingTips: { type: 'STRING' }
      },
      required: ['objective', 'keyPoints', 'pitfalls', 'teachingTips']
    },
    onSuccess: (result, capturedIndex) => {
      students[capturedIndex].lessonPlanResult  = result;
      students[capturedIndex].lessonPlanSubject = formData.subjects; // 追加：生成時の対象科目を保持
      students[capturedIndex].lastResultType    = 'lessonplan';

      // Race Condition 対策: 生成中に別の生徒タブへ切り替わっていた場合、
      // 元のタブの結果を今表示中の画面へ描画してしまわないようにスキップする。
      if (capturedIndex === currentIndex) {
        renderLessonPlanResult(result, formData);
      }
    }
  });
}

/* ===== AI結果の描画 ===== */

function renderLessonPlanResult(d, formData) {
  const subLine = [formData.grade, formData.subjects]
    .filter(v => v !== '未入力').join(' ／ ');

  const keyPointsHTML = (d.keyPoints || []).map(p => `<li>${escapeHtml(p)}</li>`).join('');
  const pitfallsHTML  = (d.pitfalls  || []).map(p => `<li>${escapeHtml(p)}</li>`).join('');

  const html = `
    <!-- アクションバー -->
    <div class="result-actions no-print">
      <button type="button" class="action-btn action-btn-teal" id="lesson-copy-btn">
        <i class="ti ti-copy"></i> 授業案をコピー
      </button>
      ${students[currentIndex]?.result ? `
      <button type="button" class="action-btn action-btn-primary" id="switch-to-diagnosis-btn">
        <i class="ti ti-report-analytics"></i> 診断レポートを表示
      </button>` : ''}
    </div>

    <!-- ヘッダー：授業目標 -->
    <div class="result-card card-lesson">
      <div class="hero-row">
        <div>
          <div class="hero-name" style="color:#0f766e">${escapeHtml(formData.name)} さん — 次回授業案</div>
          <div class="hero-sub" style="color:#14b8a6">${escapeHtml(subLine)}</div>
        </div>
        <i class="ti ti-calendar-event" style="font-size:30px;color:#14b8a6;opacity:0.55;flex-shrink:0"></i>
      </div>
      <div class="card-body" style="color:#134e4a;font-weight:600">${escapeHtml(d.objective || '')}</div>
    </div>

    <!-- 重点指導ポイント -->
    <div class="result-card card-neutral">
      <div class="card-label"><i class="ti ti-target"></i> 重点指導ポイント</div>
      <ul class="diag-list">${keyPointsHTML}</ul>
    </div>

    <!-- つまずきポイントと対処法 -->
    <div class="result-card card-improvements">
      <div class="card-label"><i class="ti ti-alert-triangle"></i> つまずきやすい箇所と対処法</div>
      <ul class="diag-list">${pitfallsHTML}</ul>
    </div>

    <!-- 指導のヒント -->
    <div class="result-card card-lesson">
      <div class="card-label"><i class="ti ti-bulb"></i> 指導のヒント</div>
      <div class="card-body">${escapeHtml(d.teachingTips || '')}</div>
    </div>
  `;

  document.getElementById('state-result').innerHTML = html;

  bindCopyButton('lesson-copy-btn', () => `
【次回授業案】${formData.name} さん（${subLine}）

■ 授業目標
${d.objective || ''}

■ 重点指導ポイント
${(d.keyPoints || []).map(p => `・${p}`).join('\n')}

■ つまずきやすい箇所と対処法
${(d.pitfalls || []).map(p => `・${p}`).join('\n')}

■ 指導のヒント
${d.teachingTips || ''}
`.trim());

  const switchBtn = document.getElementById('switch-to-diagnosis-btn');
  if (switchBtn) {
    switchBtn.addEventListener('click', () => {
      const s = students[currentIndex];
      if (s.result) {
        s.lastResultType = 'diagnosis';
        renderResult(s.result, buildFormData());
        showState('state-result');
      }
    });
  }
}

function renderResult(d, formData) {
  const { score: clampedScore, stars } = renderStars(d.overallScore);
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
      ${students[currentIndex]?.lessonPlanResult ? `
      <button type="button" class="action-btn action-btn-teal-outline" id="switch-to-lesson-btn">
        <i class="ti ti-calendar-event"></i> 授業案を表示
      </button>` : ''}
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
          <div class="score-label">総合評価 ${clampedScore} / 5</div>
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

  document.getElementById('print-btn').addEventListener('click', () => {
    window.print();
  });

  bindCopyButton('copy-all-btn', () => `
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
`.trim());

  bindCopyButton('copy-btn', () => document.getElementById('parent-text').innerText);

  const switchToLessonBtn = document.getElementById('switch-to-lesson-btn');
  if (switchToLessonBtn) {
    switchToLessonBtn.addEventListener('click', () => {
      const s = students[currentIndex];
      if (s.lessonPlanResult) {
        s.lastResultType = 'lessonplan';
        const fd = buildFormData();
        if (s.lessonPlanSubject) fd.subjects = s.lessonPlanSubject;
        renderLessonPlanResult(s.lessonPlanResult, fd);
        showState('state-result');
      }
    });
  }
}

/* ===== APIキー表示トグル・永続化の初期化 ===== */
document.addEventListener('DOMContentLoaded', () => {
  /* APIキー 表示/非表示トグル */
  on('api-key-toggle', 'click', () => {
    const input   = document.getElementById('api-key');
    const icon    = document.querySelector('#api-key-toggle .ti');
    const isHidden = input.type === 'password';
    input.type    = isHidden ? 'text' : 'password';
    icon.className = `ti ${isHidden ? 'ti-eye-off' : 'ti-eye'}`;
  });

  /* APIキーの永続化
     - ページ読み込み時に localStorage から自動復元
     - 入力変更のたびに localStorage へ保存（空の場合は削除） */
  (function initApiKeyPersistence() {
    const apiKeyEl = document.getElementById('api-key');
    if (!apiKeyEl) return;

    const saved = localStorage.getItem('gemini_api_key');
    if (saved) apiKeyEl.value = saved;

    apiKeyEl.addEventListener('input', () => {
      const val = apiKeyEl.value.trim();
      if (val) {
        localStorage.setItem('gemini_api_key', val);
      } else {
        localStorage.removeItem('gemini_api_key');
      }
    });
  })();
});
