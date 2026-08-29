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

// requestBody に加えて options（第3引数）で挙動を制御する。
//   - maxRetries    : 503/429時の最大リトライ回数（デフォルト3）
//   - useGrounding  : true にすると Google Search によるグラウンディング用の
//                     tools パラメータ（{ google_search: {} }）をリクエスト
//                     ボディへ自動付与する。
// 【重要な制約】Gemini APIは現状、responseSchema（構造化JSON強制 /
// responseMimeType: 'application/json'）と検索ツール（グラウンディング）の
// 併用に制約があるため、useGrounding: true で呼び出す際は
// generationConfig に responseSchema / responseMimeType を含めないこと。
// JSON生成が必要な場合は、①useGrounding:true・スキーマなしで検索結果を
// テキストとして取得 → ②その結果をプロンプトに埋め込み、useGrounding:false・
// スキーマありで通常のJSON生成、という2段階呼び出しに設計すること
// （呼び出し側の runAiGeneration 参照）。
async function fetchGeminiWithRetry(apiKey, requestBody, options = {}) {
  const { maxRetries = 3, useGrounding = false } = options;

  const body = useGrounding
    ? { ...requestBody, tools: [...(requestBody.tools || []), { google_search: {} }] }
    : requestBody;

  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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

// candidates[0].content.parts からプレーンテキストを取り出す共通ヘルパー。
// グラウンディング（Google Search）呼び出しはJSONではなくテキストで
// 返ってくるため、JSON.parseを行わずこちらを直接利用する。
function extractGeminiText(data) {
  if (data.candidates?.[0]?.finishReason === 'MAX_TOKENS') {
    throw new Error('レスポンスがトークン上限に達しました。入力情報を減らすか、しばらく時間をおいて再試行してください。');
  }
  const rawText = (data.candidates?.[0]?.content?.parts || [])
    .map(p => p.text || '')
    .join('')
    .trim();
  if (!rawText) throw new Error('AIからのレスポンスを取得できませんでした。');
  return rawText;
}

function parseGeminiResponse(data) {
  const rawText = extractGeminiText(data);
  try {
    return JSON.parse(rawText);
  } catch (e) {
    throw new Error('AIレスポンスの解析に失敗しました。しばらくしてから再試行してください。');
  }
}

/* ===== 科目別エキスパートペルソナ定義 ===== */

// 科目名 → 専門家ペルソナ文のマッピング。
// splitSubjects() で分割された個々の科目名をキーとして参照する。
// ※ 現状「算数・数学・国語・英語・理科・社会」の6科目のみ定義。
//   フォーム側で選択可能な科目名（表記ゆれ・細分化科目を含む）が
//   このキーと過不足なく対応しているか要確認。getSubjectExpertPersona()
//   側で前方一致・部分一致によるフォールバックは行っているが、
//   フォームにこの6科目に含まれない科目（例："情報"等）が存在する場合は
//   汎用ペルソナに落ちるため、必要に応じてキーを追加すること。
const SUBJECT_EXPERT_PERSONAS = {
  '算数':   '算数教育の専門家（計算・図形・文章題における「つまずきの構造分析」を得意とする）',
  '数学':   '大学受験数学教育の専門家（計算・図形・文章題における「つまずきの構造分析」を得意とする）',
  '国語':   '大学受験国語の読解・記述指導のプロ（文章読解力の分解と記述式解答の添削指導を専門とする）',
  '英語':   '大学受験英語4技能（聞く・話す・読む・書く）指導の専門家',
  '理科':   '理科教育の専門家（実験・観察・原理理解のつながりを丁寧に橋渡しする指導を得意とする）',
  '社会':   '社会科教育の専門家（歴史・地理・公民分野の背景理解と効果的な暗記法指導に強い）',
};

// 科目名からエキスパートペルソナを引く。
// - まず trim + NFKC正規化（全角英数・記号を半角化）した上で完全一致を試みる
// - 「数学(数III)」「英語（リスニング）」のような付加情報付きの科目名や、
//   SUBJECT_EXPERT_PERSONAS のキーとの表記ゆれを吸収するため、
//   完全一致で見つからない場合は前方一致→部分一致の順でフォールバックする
// - マッピングに存在しない科目名の場合は汎用ペルソナ文字列を返す
function getSubjectExpertPersona(subject) {
  const raw = (subject || '').trim();
  if (!raw) return '当該科目指導の専門家';

  const normalized = raw.normalize('NFKC');

  if (SUBJECT_EXPERT_PERSONAS[normalized]) return SUBJECT_EXPERT_PERSONAS[normalized];
  if (SUBJECT_EXPERT_PERSONAS[raw])        return SUBJECT_EXPERT_PERSONAS[raw];

  const keys = Object.keys(SUBJECT_EXPERT_PERSONAS);
  const startsWithKey = keys.find(k => normalized.startsWith(k));
  if (startsWithKey) return SUBJECT_EXPERT_PERSONAS[startsWithKey];

  const includesKey = keys.find(k => normalized.includes(k));
  if (includesKey) return SUBJECT_EXPERT_PERSONAS[includesKey];

  return `${raw}指導の専門家`;
}

/* ===== 目標乖離・逆算コンテキスト生成 ===== */

// 短期目標のテキスト（自由記述）から期限らしき日付表記を抽出する簡易ヘルパー。
// ※ 現状、短期目標データは構造化された「期限」フィールドを持たず自由記述テキストのため、
//   正規表現によるベストエフォートの抽出で代替している。
//   構造化フィールドを追加する場合は、本関数の呼び出し箇所を該当フィールド参照に置き換え、
//   HTML（入力フォーム）／core（app-講師用AI作成.js）側の対応も別途必要になる。
function extractDeadlineFromText(text) {
  if (!text) return null;
  const now = new Date();
  const patterns = [
    { re: /(\d{4})[\/年](\d{1,2})[\/月](\d{1,2})日?/, hasYear: true },  // 2026/6/1, 2026年6月1日
    { re: /(\d{1,2})[\/月](\d{1,2})日/,               hasYear: false }, // 6/1, 6月1日（年省略）
  ];
  for (const { re, hasYear } of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const year  = hasYear ? Number(m[1]) : now.getFullYear();
    const month = hasYear ? Number(m[2]) : Number(m[1]);
    const day   = hasYear ? Number(m[3]) : Number(m[2]);
    const dt = new Date(year, month - 1, day);
    if (isNaN(dt.getTime())) continue;
    // 年省略で既に過ぎた日付になった場合は、来年の日付と解釈する
    if (!hasYear && dt < now) dt.setFullYear(dt.getFullYear() + 1);
    return dt;
  }
  return null;
}

// 授業ログの日付間隔から、直近の平均的な授業頻度（週あたり回数）を推定する
function estimateLessonsPerWeek(lessonLogs) {
  if (!lessonLogs || lessonLogs.length < 2) return null;
  const dates = lessonLogs
    .map(l => new Date(l.date))
    .filter(d => !isNaN(d.getTime()))
    .sort((a, b) => a - b);
  if (dates.length < 2) return null;
  const spanDays = (dates[dates.length - 1] - dates[0]) / (1000 * 60 * 60 * 24);
  if (spanDays <= 0) return null;
  const perWeek = ((dates.length - 1) / spanDays) * 7;
  return perWeek > 0 ? perWeek : null;
}

/**
 * 目標乖離・逆算分析のコンテキストブロックを生成する。
 * 短期目標／長期目標に対する現状（理解度傾向・スコア推移）の乖離と、
 * 残り授業回数・残り期間から逆算した必要ペースの目安をテキスト化し、
 * 診断・授業案いずれの buildPrompt にも差し込めるようにする。
 *
 * @param {object} formData     フォームデータ（goal, shortTermGoals 等を含む）
 * @param {object|null} pastData  getStudentData() の戻り値
 * @param {Array} [relevantLogs] 集計対象とする授業ログ（未指定時は pastData.lessonLogs 全件）
 * @returns {string}
 */
function buildGoalGapContext(formData, pastData, relevantLogs) {
  const logs = relevantLogs || (pastData ? pastData.lessonLogs : []) || [];

  // 理解度の傾向（前半平均 → 後半平均）
  const compValues = logs.map(l => parseComprehension(l.comprehension)).filter(v => v > 0);
  let compTrendText = '記録が少なく傾向を算出できません';
  if (compValues.length >= 2) {
    const half   = Math.ceil(compValues.length / 2);
    const avgOld = (compValues.slice(0, half).reduce((a, b) => a + b, 0) / half).toFixed(1);
    const avgNew = (compValues.slice(-half).reduce((a, b) => a + b, 0) / half).toFixed(1);
    const diff   = (Number(avgNew) - Number(avgOld)).toFixed(1);
    const arrow  = Number(diff) > 0.5 ? '上昇傾向↑' : Number(diff) < -0.5 ? '低下傾向↓' : '横ばい→';
    compTrendText = `${arrow}（前半平均 ${avgOld} → 後半平均 ${avgNew}、全${compValues.length}件）`;
  }

  // AI診断スコアの推移
  const diagnostics = (pastData ? pastData.aiDiagnostics : []) || [];
  let scoreDiffText = '診断履歴なし';
  if (diagnostics.length > 1) {
    const prev = diagnostics[diagnostics.length - 2];
    const last = diagnostics[diagnostics.length - 1];
    const d = num(last.overallScore) - num(prev.overallScore);
    scoreDiffText = `${d >= 0 ? '+' : ''}${d}（前回 ${num(prev.overallScore)} → 直近 ${num(last.overallScore)}）`;
  } else if (diagnostics.length === 1) {
    scoreDiffText = `初回診断のみ（スコア ${num(diagnostics[0].overallScore)}）`;
  }

  // 短期目標テキストからの期限抽出 と 残り授業回数の逆算
  const deadline = extractDeadlineFromText(formData.shortTermGoals);
  const lessonsPerWeek = estimateLessonsPerWeek(logs);

  const lines = [];
  lines.push(`長期目標: ${formData.goal || '（未設定）'}`);
  lines.push(`短期目標（期限・達成基準を含む場合はそのまま記載）: ${formData.shortTermGoals || '（未設定）'}`);
  lines.push(`理解度の傾向: ${compTrendText}`);
  lines.push(`AI診断スコアの推移: ${scoreDiffText}`);

  if (deadline) {
    const remainingDays = Math.ceil((deadline - new Date()) / (1000 * 60 * 60 * 24));
    const deadlineLabel = `${deadline.getFullYear()}/${deadline.getMonth() + 1}/${deadline.getDate()}`;
    lines.push(`短期目標の期限（テキストから自動抽出・目安）: ${deadlineLabel}（残り約${Math.max(remainingDays, 0)}日）`);
    if (lessonsPerWeek) {
      const remainingLessons = Math.max(1, Math.round((remainingDays / 7) * lessonsPerWeek));
      lines.push(`過去の授業頻度（目安）: 週あたり約${lessonsPerWeek.toFixed(1)}回 → 期限までの残り授業回数の目安: 約${remainingLessons}回`);
      lines.push('※上記回数は過去の授業間隔から機械的に算出した目安です。この残り回数で短期目標に到達可能なペースかどうかを判断してください。');
    } else {
      lines.push('残り授業回数: 過去の授業頻度データが不足しているため機械的な算出はできません。理解度傾向・スコア推移をもとに妥当な想定を置いて判断してください。');
    }
  } else {
    lines.push('短期目標の期限: 本文からの自動抽出はできませんでした。短期目標の文中に期限や達成基準の記載があればそれを優先し、なければ理解度傾向・スコア推移から乖離の大小を定性的に判断してください。');
  }

  // ----- 定性データ（所見テキスト）の乖離分析への活用 -----
  // 数値指標（理解度スコア・AI診断スコア）だけでは「なぜ乖離が生じているか」
  // までは見えないため、講師所見（instructorNotes）・現在の課題（concerns）・
  // 学習態度（attitude）・抽象化メモ（takeaways）等の自由記述テキストを
  // 加工・要約せずそのまま渡し、言葉遣いや頻出ワードからの背景推測は
  // 生成AI側（プロンプト指示）に委ねる。
  const qualitativeLogs = logs.slice(-8);
  const qualitativeNotes = qualitativeLogs
    .map(l => {
      const parts = [];
      if (l.instructorNotes) parts.push(`所見: ${l.instructorNotes}`);
      if (l.takeaways)       parts.push(`転用メモ: ${l.takeaways}`);
      return parts.length > 0 ? `[${l.date || '日付不明'}] ${parts.join(' / ')}` : null;
    })
    .filter(Boolean);

  lines.push('--- 定性データ（所見テキスト・乖離の背景推測材料） ---');
  lines.push(`現在の課題（自由記述）: ${formData.concerns || '（記載なし）'}`);
  lines.push(`学習態度・自習状況（自由記述）: ${formData.attitude || '（記載なし）'}`);
  if (qualitativeNotes.length > 0) {
    lines.push(`直近の講師所見・転用メモ（最大8件）:`);
    qualitativeNotes.forEach((note, i) => lines.push(`  ${i + 1}. ${note}`));
  } else {
    lines.push('直近の講師所見・転用メモ: 記録なし');
  }

  return lines.join('\n');
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
// capturedIndex取得→ボタン無効化→ローディング表示→(必要ならグラウンディング検索)→
// fetchGeminiWithRetry→parseGeminiResponse→エラー処理→finallyでボタン復帰、
// という共通の骨格をここに集約する。
// プロンプト組み立て・スキーマ・成功時処理だけを呼び出し側から設定値として渡す。
//
// 【グラウンディング（Web参照）について】
// useGrounding: true を指定すると、本処理は以下の2段階呼び出しを行う。
//   ①buildGroundingQuery() が返すクエリを使い、Google Search ツール付き・
//     responseSchemaなしでGeminiを呼び出し、目標関連情報をテキストとして収集する
//     （responseSchemaと検索ツールは現状併用不可のため、あえて別呼び出しにする）。
//   ②①で得たテキスト（groundingText）を buildPrompt(groundingText) に渡し、
//     通常どおりresponseSchema付き・検索ツールなしでJSON生成を行う。
// buildGroundingQuery が未指定、または呼び出し失敗時は、検索結果なし（空文字）
// のまま②のみで続行する（グラウンディングは通常生成を止めるほど致命的では
// ないため、フォールバックしてでも生成自体は完了させる）。
async function runAiGeneration(apiKey, triggerBtn, {
  loadingTitle, buildPrompt, schema, maxOutputTokens, errorLabel, onSuccess,
  useGrounding = false, buildGroundingQuery, groundingLoadingTitle
}) {
  const capturedIndex = currentIndex; // Race Condition 対策: await 前に currentIndex をキャプチャ
  if (triggerBtn) triggerBtn.disabled = true;
  showState('state-loading');

  try {
    // ①目標関連情報のWeb検索によるグラウンディング（該当する場合のみ）
    let groundingText = '';
    if (useGrounding && typeof buildGroundingQuery === 'function') {
      setLoadingText(groundingLoadingTitle || '目標に関する情報をWebで確認中...');
      const groundingQuery = buildGroundingQuery();
      if (groundingQuery) {
        try {
          const groundingData = await fetchGeminiWithRetry(
            apiKey,
            {
              contents: [{ parts: [{ text: groundingQuery }] }],
              generationConfig: { temperature: 0.2, maxOutputTokens: 2048 }
            },
            { useGrounding: true }
          );
          groundingText = extractGeminiText(groundingData);
        } catch (groundingErr) {
          // Web検索での事前情報収集に失敗しても致命的エラーにはせず、
          // 検索結果なしで通常のJSON生成にフォールバックする。
          console.warn('目標関連情報のWeb検索（グラウンディング）に失敗したため、検索結果なしで続行します:', groundingErr);
          groundingText = '';
        }
      }
    }

    // ②収集結果（groundingText）をプロンプトに埋め込みつつ、通常どおりJSON生成
    setLoadingText(loadingTitle);
    const data = await fetchGeminiWithRetry(apiKey, {
      contents: [{ parts: [{ text: buildPrompt(groundingText) }] }],
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

  const diagnosisSubjects = splitSubjects(formData.subjects);
  const diagnosisPersonaIntro = diagnosisSubjects.length > 0
    ? `あなたは以下の科目別エキスパートから成る診断チームです。\n` +
      diagnosisSubjects.map(s => `・${s}: ${getSubjectExpertPersona(s)}`).join('\n')
    : 'あなたはプロの教育コンサルタント・塾講師です。';

  const goalGapContext = buildGoalGapContext(formData, pastData);

  // 長期・短期目標に含まれる試験名・志望校名・資格名等の実際の特性
  // （出題傾向・配点・合格ライン・出願期限等）、および講師メモ・学習態度欄に
  // 記載された参考書名・教材名や勉強法の一般的な評判・指導知見を、
  // Google検索でまとめて確認するためのクエリ。
  // ※ formData には参考書名・使用教材専用のフィールドが存在しないため、
  //   講師メモ（notes）・学習態度（attitude）の自由記述から該当箇所を
  //   拾う前提とする（5. 参考書・勉強法の欠点と改善点の提示 対応）。
  // 目標・教材関連の手がかりがいずれも見当たらない場合は検索自体を
  // 行わない（null を返す）。
  const buildDiagnosisGroundingQuery = () => {
    const goalText     = [formData.goal, formData.shortTermGoals].filter(Boolean).join('\n');
    const materialText = [formData.notes, formData.attitude].filter(Boolean).join('\n');
    if (!goalText.trim() && !materialText.trim()) return null;

    const goalSection = goalText.trim() ? `
以下は、ある生徒の長期目標・短期目標の記述です。この中に試験名・志望校名（学部・学科含む）・資格名など、具体的に検索可能な固有名詞が含まれている場合、Google検索を用いて、その試験・学校・資格に関する実際の特性を調べてください。
特に、出題傾向、配点、合格ライン（合格最低点・偏差値目安）、出願期限・試験日程、倍率など、指導計画に直結する情報を優先してください。

【長期目標】
${formData.goal || '（未設定）'}

【短期目標】
${formData.shortTermGoals || '（未設定）'}
`.trim() : '';

    const materialSection = materialText.trim() ? `
以下は、ある生徒の講師メモ・学習態度欄の自由記述です。この中に参考書名・問題集名・アプリ名など具体的な教材名、または特定の勉強法・学習方法の記載がある場合、Google検索を用いて、その教材・勉強法についての一般的な評判（レビュー・口コミ）や、指導者・専門家による評価（長所・短所）を調べてください。

【講師メモ】
${formData.notes || '（記載なし）'}

【学習態度・自習状況】
${formData.attitude || '（記載なし）'}
`.trim() : '';

    return `
${[goalSection, materialSection].filter(Boolean).join('\n\n')}

簡潔な日本語の箇条書きで、確認できた情報のみをまとめてください（推測や一般論は書かないこと）。該当する固有名詞・教材名・勉強法が見当たらない場合、またはWeb検索でも情報が確認できない場合は、その旨を一言で述べるだけで構いません。
`.trim();
  };

  const buildPrompt = (groundingInfo) => `
${diagnosisPersonaIntro}
このチームで、生徒の基本情報、過去の学習変化、今回の授業内容を踏まえ、保護者も納得する高品質な診断レポートを作成してください。

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

【目標乖離・逆算分析】
${goalGapContext}
${groundingInfo ? `
【目標関連情報のWeb検索結果（試験・志望校・資格の実際の特性）】
${groundingInfo}
` : ''}
【指示】
- 学習傾向分析の数値（理解度の傾向・スコア変化）を必ず言及し、変化を具体的に評価してください。
- 過去のデータと比較し、「成長できた点」「継続して取り組む課題」を具体的に述べてください。
- 複数の科目が含まれる場合は、全体をぼやかさず「【英語】〇〇」「【数学】〇〇」のように科目ごとに明確に見出しをつけて具体的に診断してください。
- 科目ごとの診断は、その科目の専門家ペルソナの視点・専門用語で記述すること。
- 次回授業プランは今回の課題を踏まえ、科目ごとに単元名・教材名・つまずきやすい箇所を明記してください。
- 保護者向けメッセージは丁寧で前向き、そのまま面談や連絡帳で渡せるクオリティにしてください。
- 短期目標の達成状況・進捗を具体的に評価し、「今すぐ取り組むべきこと」に反映してください。
- 週間プラン・月間プランは、科目ごとのバランスを考慮し、短期目標の達成ステップと長期目標への道筋を構成してください。
- 【目標乖離・逆算分析】の内容をもとに、現ペースで長期目標に到達可能かを判定し、乖離があれば具体的な立て直し策を示すこと。
- 長期・短期目標に含まれる試験名・志望校名・資格名等があれば、上記のWeb検索結果をもとに出題傾向・配点・合格ライン・出願期限等の実際の特性を踏まえて乖離分析・逆算プランに反映すること。検索結果が得られなかった場合は、その旨を踏まえた上で一般的な傾向として妥当な想定を置いて判断すること。
- 講師メモ・学習態度欄に参考書名・問題集名・アプリ名等の具体的な教材名、または特定の勉強法・学習方法の記載がある場合、上記のWeb検索結果（教材・勉強法の評判や指導知見）を踏まえて、その教材・勉強法の長所・短所と具体的な改善提案を materialsFeedback に記載すること（教材・勉強法ごとに1エントリとし、materialName・aiFeedback・improvementSuggestion をそれぞれ具体的に記載する）。該当する記載が無い場合、またはWeb検索結果が得られず言及できる材料がない場合は materialsFeedback を空配列とすること。
- 【目標乖離・逆算分析】内の所見テキスト（現在の課題・学習態度・講師所見・転用メモ）に含まれる言葉遣いや頻出する課題ワードから、生徒の学習習慣・心理状態・つまずきの根本原因を推測し、スコアだけでは見えない現状を言語化すること。推測は断定せず、所見のどの記述から読み取れるかが分かる形で述べること。
- 過去ログ（理解度の推移パターン・講師所見・転用メモ）の傾向から、この生徒に最も当てはまる学習タイプ（例: 視覚型・反復型・対話型など、複数該当する場合はその組み合わせも可）を推定し、判断の根拠となった具体的な記述・パターンとともに learningStyleInsight に記載すること。断定はせず、あくまで推定である旨がわかる書き方にすること。
- 上記で推定した学習タイプを踏まえ、この生徒に効果的な指導アプローチ（説明の仕方・教材の見せ方・演習と対話のバランスなど）を recommendedTeachingApproach に具体的に記載すること。単なる一般論ではなく、この生徒固有の傾向に紐づけて述べること。
- weeklyPlan／monthlyPlanには「講師が授業内で行う指導方針・進め方」のみを記述し、生徒が一人で取り組むべき自習タスクはここに書かないこと。生徒が一人で行う自習タスクは、必ず selfStudyPlan フィールドに分離して記載すること。selfStudyPlan は科目ごとに、優先順位（例:高/中/低）・使用教材・想定所要時間（分）を明記した具体的なタスクリストとすること。
`.trim();

  await runAiGeneration(apiKey, triggerBtn, {
    loadingTitle: 'AIが分析中です...',
    buildPrompt,
    maxOutputTokens: 8192,
    errorLabel: '診断の生成',
    useGrounding: true,
    buildGroundingQuery: buildDiagnosisGroundingQuery,
    groundingLoadingTitle: '目標（試験・志望校等）の情報をWebで確認中...',
    schema: {
      type: 'OBJECT',
      properties: {
        overallScore:    { type: 'INTEGER', minimum: 1, maximum: 5 },
        overallComment:  { type: 'STRING' },
        strengths:       { type: 'ARRAY', items: { type: 'STRING' } },
        improvements:    { type: 'ARRAY', items: { type: 'STRING' } },
        weeklyPlan:      { type: 'STRING' },
        monthlyPlan:     { type: 'STRING' },
        // 生徒が一人で行う自習計画（科目別・優先順位付きタスク）。
        // weeklyPlan/monthlyPlan（講師視点の指導方針）とは明確に分離し、
        // 「講師が行う指導内容」と「生徒が一人で行うべきタスク」を混同しない。
        selfStudyPlan: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              subject: { type: 'STRING' },
              tasks: {
                type: 'ARRAY',
                items: {
                  type: 'OBJECT',
                  properties: {
                    priority:         { type: 'STRING' },
                    task:             { type: 'STRING' },
                    materials:        { type: 'STRING' },
                    estimatedMinutes: { type: 'INTEGER' }
                  },
                  required: ['priority', 'task', 'materials', 'estimatedMinutes']
                }
              }
            },
            required: ['subject', 'tasks']
          }
        },
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
        urgentAction:     { type: 'STRING' },
        goalGapAnalysis:  { type: 'STRING' },
        backwardPlan: {
          type: 'OBJECT',
          properties: {
            milestones:   { type: 'ARRAY', items: { type: 'STRING' } },
            requiredPace: { type: 'STRING' }
          },
          required: ['milestones', 'requiredPace']
        },
        // 生徒ごとの効果的な指導法の提案。
        // learningStyleInsight: 過去ログ（理解度パターン・所見の傾向）から推定した
        //   学習タイプ（視覚型・反復型・対話型など）とその根拠。
        // recommendedTeachingApproach: 推定した学習タイプを踏まえた、この生徒に
        //   効果的な指導アプローチ。
        learningStyleInsight:        { type: 'STRING' },
        recommendedTeachingApproach: { type: 'STRING' },
        // 参考書・使用教材や勉強法に対するAI所見・改善提案（任意項目）。
        // formData には教材名専用のフィールドが無いため、講師メモ（notes）・
        // 学習態度（attitude）等の自由記述に教材名や勉強法の記載がある場合のみ、
        // buildDiagnosisGroundingQuery によるWeb検索結果（評判・指導知見）を
        // 踏まえて生成AI側が判断・記載する。該当する記載が無ければ
        // 空配列を返す想定のため、必須項目（required）には含めない。
        materialsFeedback: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              materialName:          { type: 'STRING' }, // 教材名・勉強法名
              aiFeedback:            { type: 'STRING' }, // AI所見（長所・短所）
              improvementSuggestion: { type: 'STRING' }  // 改善提案
            },
            required: ['materialName', 'aiFeedback', 'improvementSuggestion']
          }
        }
      },
      required: [
        'overallScore', 'overallComment', 'strengths', 'improvements',
        'weeklyPlan', 'monthlyPlan', 'selfStudyPlan', 'nextLessonPlan',
        'instructorAdvice', 'parentMessage', 'urgentAction',
        'goalGapAnalysis', 'backwardPlan',
        'learningStyleInsight', 'recommendedTeachingApproach'
      ]
      // ※ materialsFeedback は任意項目のため required には含めない
      //   （教材名・勉強法への言及が無い場合は空配列が返る想定）。
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
  // ③でボタンの科目に上書き済みの前提だが、その前提が崩れて複数科目文字列が
  // 渡ってきた場合でも科目別エキスパート性が失われないよう、
  // splitSubjects() で単一科目に正規化してから使用する
  const targetSubject = splitSubjects(formData.subjects)[0] || formData.subjects;

  const sameSubjectLogs = pastData
    ? pastData.lessonLogs.filter(log => splitSubjects(log.subject).includes(targetSubject))
    : [];
  const recentLogs = (sameSubjectLogs.length > 0 ? sameSubjectLogs : (pastData?.lessonLogs || [])).slice(-5);

  const lessonPersona = getSubjectExpertPersona(targetSubject);
  const goalGapContext = buildGoalGapContext(
    formData,
    pastData,
    sameSubjectLogs.length > 0 ? sameSubjectLogs : (pastData?.lessonLogs || [])
  );

  const buildPrompt = () => `
あなたは${lessonPersona}であり、経験豊富なベテラン塾講師でもあります。
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

【目標乖離・逆算分析】
${goalGapContext}

【指示】
- 今回作成する授業案は「${formData.subjects}」科目のみを対象とします。今回の授業内容や履歴に他科目の内容が混在していても、次回授業案には対象科目以外の内容を一切含めないでください。
- 今回の理解度・課題を踏まえ、次回の授業目標を2~3文で示してください。
- 重点指導ポイントは具体的に単元名・問題タイプを挙げてください。
- 生徒がつまずきやすい箇所と講師がとるべき対処法を明記してください。
- 指導のヒントとして、この生徒への効果的なアプローチを2〜3文で示してください。
- 短期目標の期限が近い場合は、その達成を最優先した集中指導プランを示してください。
- 今回の授業が目標達成の逆算スケジュール上どの位置づけかを明記し、遅れがあれば優先順位を明示すること。
- objective／keyPoints／pitfalls／teachingTips には「講師が授業内で行う指導内容」のみを記載し、生徒が次回授業までに一人で取り組むべき宿題・自習課題は一切混在させないこと。生徒が一人で行うべきタスクは、必ず assignedSelfStudy フィールドに分離して記載すること。assignedSelfStudy は優先順位（例:高/中/低）・使用教材・想定所要時間（分）を明記した具体的なタスクリストとすること。
`.trim();

  await runAiGeneration(apiKey, triggerBtn, {
    loadingTitle: '次回授業案を作成中...',
    buildPrompt,
    maxOutputTokens: 2560,
    errorLabel: '次回授業案の生成',
    schema: {
      type: 'OBJECT',
      properties: {
        objective:     { type: 'STRING' },
        keyPoints:     { type: 'ARRAY', items: { type: 'STRING' } },
        pitfalls:      { type: 'ARRAY', items: { type: 'STRING' } },
        teachingTips:  { type: 'STRING' },
        goalAlignment: { type: 'STRING' },
        // 次回授業までに生徒が一人で行う宿題・自習課題。
        // 授業計画（講師が授業内で行う指導内容）とは明確に分離する。
        assignedSelfStudy: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              priority:         { type: 'STRING' },
              task:             { type: 'STRING' },
              materials:        { type: 'STRING' },
              estimatedMinutes: { type: 'INTEGER' }
            },
            required: ['priority', 'task', 'materials', 'estimatedMinutes']
          }
        }
      },
      required: ['objective', 'keyPoints', 'pitfalls', 'teachingTips', 'goalAlignment', 'assignedSelfStudy']
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

/* ===== 自習タスク（selfStudyPlan / assignedSelfStudy）共通レンダリングヘルパー ===== */
// 「講師が行う指導内容」と「生徒が一人で行うべきタスク」の混同を防ぐため、
// 自習タスク（{priority, task, materials, estimatedMinutes}）の
// HTML/テキスト整形をここに集約し、renderResult / renderLessonPlanResult
// 双方から共通利用する。

function selfStudyTaskLine(t) {
  const minutes = (t.estimatedMinutes || t.estimatedMinutes === 0) ? `${t.estimatedMinutes}分` : '目安時間未設定';
  return `[${t.priority || '優先度未設定'}] ${t.task || ''}（教材: ${t.materials || '未指定'} / 想定所要時間: ${minutes}）`;
}

function renderSelfStudyTasksHTML(tasks) {
  return (tasks || []).map(t => `<li>${escapeHtml(selfStudyTaskLine(t))}</li>`).join('');
}

function selfStudyTasksToText(tasks) {
  return (tasks || []).map(t => `・${selfStudyTaskLine(t)}`).join('\n');
}

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

    <!-- 目標との関連 -->
    <div class="result-card card-neutral">
      <div class="card-label"><i class="ti ti-flag-3"></i> 目標との関連</div>
      <div class="card-body">${escapeHtml(d.goalAlignment || '')}</div>
    </div>

    <!-- 次回授業までの自習課題（生徒が一人で行うタスク） -->
    ${(d.assignedSelfStudy || []).length > 0 ? `
    <div class="result-card card-improvements">
      <div class="card-label"><i class="ti ti-clipboard-list"></i> 次回授業までの自習課題（生徒が一人で行うタスク）</div>
      <ul class="diag-list">${renderSelfStudyTasksHTML(d.assignedSelfStudy)}</ul>
    </div>` : ''}
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

■ 目標との関連
${d.goalAlignment || ''}

■ 次回授業までの自習課題（生徒が一人で行うタスク）
${(d.assignedSelfStudy || []).length > 0 ? selfStudyTasksToText(d.assignedSelfStudy) : '（なし）'}
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

    <!-- 目標乖離分析 -->
    <div class="result-card card-neutral">
      <div class="card-label"><i class="ti ti-gauge"></i> 目標乖離分析</div>
      <div class="card-body">${escapeHtml(d.goalGapAnalysis || '')}</div>
    </div>

    <!-- 逆算ロードマップ -->
    ${d.backwardPlan ? `
    <div class="result-card card-neutral">
      <div class="card-label"><i class="ti ti-route"></i> 逆算ロードマップ</div>
      <div class="card-body">
        ${(d.backwardPlan.milestones || []).length > 0 ? `
          <div style="margin-bottom:8px">
            <div style="font-size:11px;font-weight:600;color:var(--text-muted,#6b7280);margin-bottom:4px">マイルストーン</div>
            <ul class="diag-list">${(d.backwardPlan.milestones || []).map(m => `<li>${escapeHtml(m)}</li>`).join('')}</ul>
          </div>` : ''}
        <div>
          <div style="font-size:11px;font-weight:600;color:var(--text-muted,#6b7280);margin-bottom:2px">必要ペース</div>
          <div>${escapeHtml(d.backwardPlan.requiredPace || '')}</div>
        </div>
      </div>
    </div>` : ''}

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

    <!-- 参考書・勉強法へのAI所見と改善提案（該当する記載がある場合のみ表示） -->
    ${(d.materialsFeedback || []).length > 0 ? `
    <div class="result-card card-neutral">
      <div class="card-label"><i class="ti ti-books"></i> 参考書・勉強法へのAI所見と改善提案</div>
      <div class="card-body">
        ${d.materialsFeedback.map(mf => `
          <div style="margin-bottom:10px">
            <div style="font-weight:600;margin-bottom:4px">${escapeHtml(mf.materialName || '')}</div>
            <div style="margin-bottom:2px"><span style="font-size:11px;font-weight:600;color:var(--text-muted,#6b7280)">AI所見: </span>${escapeHtml(mf.aiFeedback || '')}</div>
            <div><span style="font-size:11px;font-weight:600;color:var(--text-muted,#6b7280)">改善提案: </span>${escapeHtml(mf.improvementSuggestion || '')}</div>
          </div>
        `).join('')}
      </div>
    </div>` : ''}

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

    <!-- 生徒ごとの効果的な指導法の提案 -->
    <div class="result-card card-neutral">
      <div class="card-label"><i class="ti ti-brain"></i> 学習タイプの推定と効果的な指導アプローチ</div>
      <div class="card-body">
        <div style="margin-bottom:8px">
          <div style="font-size:11px;font-weight:600;color:var(--text-muted,#6b7280);margin-bottom:2px">推定される学習タイプとその根拠</div>
          <div>${escapeHtml(d.learningStyleInsight || '')}</div>
        </div>
        <div>
          <div style="font-size:11px;font-weight:600;color:var(--text-muted,#6b7280);margin-bottom:2px">この生徒に効果的な指導アプローチ</div>
          <div>${escapeHtml(d.recommendedTeachingApproach || '')}</div>
        </div>
      </div>
    </div>

    <!-- 1週間の学習プラン（講師の指導方針） -->
    <div class="result-card card-neutral">
      <div class="card-label"><i class="ti ti-calendar-week"></i> 1週間の推奨学習プラン（講師の指導方針）</div>
      <div class="card-body">${escapeHtml(d.weeklyPlan || '')}</div>
    </div>

    <!-- 1ヶ月の目標（講師の指導方針） -->
    <div class="result-card card-neutral">
      <div class="card-label"><i class="ti ti-calendar-month"></i> 1ヶ月の目標と方針（講師の指導方針）</div>
      <div class="card-body">${escapeHtml(d.monthlyPlan || '')}</div>
    </div>

    <!-- 自習プラン（生徒が一人で行うタスク） -->
    ${(d.selfStudyPlan || []).length > 0 ? `
    <div class="result-card card-improvements">
      <div class="card-label"><i class="ti ti-clipboard-list"></i> 自習プラン（生徒が一人で行うタスク・科目別）</div>
      <div class="card-body">
        ${d.selfStudyPlan.map(sp => `
          <div style="margin-bottom:10px">
            <div style="font-weight:600;margin-bottom:4px">${escapeHtml(sp.subject || '')}</div>
            <ul class="diag-list">${renderSelfStudyTasksHTML(sp.tasks)}</ul>
          </div>
        `).join('')}
      </div>
    </div>` : ''}

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

■ 目標乖離分析
${d.goalGapAnalysis || ''}

■ 逆算ロードマップ
${d.backwardPlan ? `マイルストーン:
${(d.backwardPlan.milestones || []).map(m => `・${m}`).join('\n')}
必要ペース: ${d.backwardPlan.requiredPace || ''}` : '（なし）'}

■ 強み
${(d.strengths || []).map(s => `・${s}`).join('\n')}

■ 改善点
${(d.improvements || []).map(s => `・${s}`).join('\n')}

■ 参考書・勉強法へのAI所見と改善提案
${(d.materialsFeedback || []).length > 0
  ? d.materialsFeedback.map(mf => `【${mf.materialName || ''}】\nAI所見: ${mf.aiFeedback || ''}\n改善提案: ${mf.improvementSuggestion || ''}`).join('\n\n')
  : '（該当する記載なし）'}

■ 学習タイプの推定と効果的な指導アプローチ
推定される学習タイプとその根拠: ${d.learningStyleInsight || ''}
この生徒に効果的な指導アプローチ: ${d.recommendedTeachingApproach || ''}

■ 1週間の推奨学習プラン（講師の指導方針）
${d.weeklyPlan || ''}

■ 1ヶ月の目標と方針（講師の指導方針）
${d.monthlyPlan || ''}

■ 自習プラン（生徒が一人で行うタスク・科目別）
${(d.selfStudyPlan || []).length > 0
  ? d.selfStudyPlan.map(sp => `【${sp.subject || ''}】\n${selfStudyTasksToText(sp.tasks)}`).join('\n\n')
  : '（なし）'}

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
