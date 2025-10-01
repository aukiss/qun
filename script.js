
const qs = (s)=>document.querySelector(s);
const qsa = (s)=>Array.from(document.querySelectorAll(s));

const questionsContainer = qs('#questionsContainer');
const generateBtn = qs('#generateBtn');
const btnGrammar = qs('#btnGrammar');
const btnTenses = qs('#btnTenses');
const exportPaperBtn = qs('#exportPaperBtn');
const exportPaperSolBtn = qs('#exportPaperSolBtn');
const gradeQuizBtn = qs('#gradeQuizBtn');
const gradingBar = qs('#gradingBar');
const statText = qs('#statText');

const viewWrongBtn = qs('#viewWrongBtn');
const exportWrongPdfBtn = qs('#exportWrongPdfBtn');
const clearWrongBtn = qs('#clearWrongBtn');

let currentType = 'grammar'; // grammar | tenses
let currentData = [];
let currentAnswers = []; // {index, choose, correct, answer, student_text?}
let quizMode = true; // 默认允许作答（取消了在线做题按钮）
const WRONG_KEY = 'english_quiz_wrongbook_v4';

// Paper code rotate A->B->C->D for filenames
const CODE_KEY = 'english_quiz_paper_code';
function nextPaperCode(){
  const seq = ['A','B','C','D'];
  let cur = localStorage.getItem(CODE_KEY) || 'A';
  const idx = (seq.indexOf(cur)+1) % seq.length;
  const next = seq[idx];
  localStorage.setItem(CODE_KEY, next);
  return cur;
}

btnGrammar.addEventListener('click', ()=>{
  currentType = 'grammar';
  btnGrammar.classList.add('on');
  btnTenses.classList.remove('on');
});
btnTenses.addEventListener('click', ()=>{
  currentType = 'tenses';
  btnTenses.classList.add('on');
  btnGrammar.classList.remove('on');
});

/** 只保留 参考答案 + 分步讲解 + 提示 */
function slimExplanation(answerLetter, answerText, explanation) {
  const exp = String(explanation || '');
  const body = exp
    .replace(/^.*?(参考答案|正确答案)\s*[:：].*$/m, '')
    .replace(/^\s*(解题思路|思路|温馨鼓励|小贴士)\s*[:：].*$/gmi, '')
    .trim();
  let steps = '';
  const stepsMatch = body.match(/分步讲解\s*[:：]?([\s\S]*?)(?=\n\S|$)/m);
  if (stepsMatch) steps = stepsMatch[1].trim();
  let hint = '';
  const hintMatch = body.match(/提示\s*[:：]?([\s\S]*?)(?=\n\S|$)/m);
  if (hintMatch) hint = hintMatch[1].trim();

  let text = `参考答案： ${answerLetter || answerText}`.trim();
  if (steps) text += `\n分步讲解：\n${steps.trim()}`;
  if (hint)  text += `\n提示：<span class="hint">${hint.trim()}</span>`;
  return text;
}

function stripOptionLabel(s){
  return String(s||'').replace(/^\s*[A-D]\s*[\)\.\u3001、]\s*/i, '').trim();
}

// 轻量级文本规范化（宽松批改）
function normText(s){
  return String(s||'')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^a-z0-9\s']/g, ' ')
    .replace(/\b(a|an|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function lenientMatch(student, correct){
  const s = normText(student);
  const t = normText(correct);
  if (!s || !t) return false;
  if (t.length <= 12) {
    return s === t || s.includes(t) || t.includes(s);
  }
  const sSet = new Set(s.split(' '));
  const tSet = new Set(t.split(' '));
  const inter = new Set([...sSet].filter(x=>tSet.has(x)));
  const jacc = inter.size / new Set([...sSet, ...tSet]).size;
  if (jacc >= 0.7) return true;
  return inter.size >= Math.ceil(tSet.size * 0.7);
}

function saveWrong(item) {
  const book = JSON.parse(localStorage.getItem(WRONG_KEY) || '[]');
  book.push(item);
  localStorage.setItem(WRONG_KEY, JSON.stringify(book));
}

function showWrongBook() {
  const book = JSON.parse(localStorage.getItem(WRONG_KEY) || '[]');
  if (!book.length) {
    questionsContainer.innerHTML = '<p class="muted">暂时没有错题～</p>';
    exportPaperBtn.disabled = true;
    exportPaperSolBtn.disabled = true;
    gradingBar.style.display = 'none';
    return;
  }
  renderQuestions(book, {readonly:true, titlePrefix:'【错题】'});
  gradingBar.style.display = 'none'; // 错题本不需要批改
}

viewWrongBtn.addEventListener('click', showWrongBook);
clearWrongBtn.addEventListener('click', ()=>{
  if (confirm('确定要清空本设备的错题本吗？')){
    localStorage.removeItem(WRONG_KEY);
    showWrongBook();
  }
});
exportWrongPdfBtn.addEventListener('click', ()=>{
  showWrongBook();
  setTimeout(()=>{
    preparePrint('paper_solutions', makeFileName(true, true));
    window.print();
    restoreTitle();
  }, 50);
});

function renderQuestions(questions, opts={}){
  const {readonly=false, titlePrefix=''} = opts;
  currentData = questions;
  currentAnswers = new Array(questions.length).fill(null);
  questionsContainer.innerHTML = '';

  questions.forEach((q, idx) => {
    const qt = (q.question_type || (q.options?.length? 'mcq':'short')).toLowerCase();
    const card = document.createElement('div');
    card.className = 'question-card';

    const meta = document.createElement('div');
    meta.className = 'meta';
    const left = document.createElement('div');
    left.textContent = `${titlePrefix}第 ${idx + 1} 题`;
    const right = document.createElement('div');
    right.className = 'tag';
    right.textContent = currentType==='tenses'?'时态':'语法';
    meta.appendChild(left);
    meta.appendChild(right);

    const qText = document.createElement('div');
    qText.className = 'qtext';
    qText.innerHTML = `${(q.question ?? '').replace(/^【[^】]*】\s*/,'')}`;

    card.appendChild(meta);
    card.appendChild(qText);

    if (qt === 'mcq') {
      const optList = document.createElement('ol');
      optList.className = 'options';
      optList.type = 'A';
      const options = Array.isArray(q.options) ? q.options : [];
      options.forEach((opt, i) => {
        const li = document.createElement('li');
        li.textContent = stripOptionLabel(opt);
        li.classList.add('touch');
        if (!readonly){
          li.addEventListener('click', ()=>{
            // 可以选择（修复不可选）：记录选择并高亮选中（不提示正误）
            qsa('li', optList).forEach(x=>x.classList.remove('selected'));
            li.classList.add('selected');
            currentAnswers[idx] = {index: idx, choose: String.fromCharCode(65+i), correct: false, answer: q.answer_letter||'A'};
          });
        }
        optList.appendChild(li);
      });
      card.appendChild(optList);
    } else {
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = ''; // 不显示提示
      Object.assign(input.style, {
        width:'100%', height:'42px', fontSize:'18px', padding:'6px 10px',
        border:'1px solid #e5e7eb', borderRadius:'10px'
      });
      if (!readonly){
        input.addEventListener('change', ()=>{
          currentAnswers[idx] = {index: idx, choose: input.value, correct: false, answer: q.answer_text||'', student_text: input.value};
        });
      }
      card.appendChild(input);
    }

    const ans = document.createElement('div');
    ans.className = 'answer';
    ans.style.display = 'none';
    ans.style.display = 'none';
    const slim = slimExplanation(q.answer_letter ?? '', q.answer_text ?? '', q.answer_explanation ?? '');
    ans.innerHTML = `<pre>${slim}</pre>`;

    const ctrls = document.createElement('div');
    ctrls.className = 'ctrls-row';
    const toggle = document.createElement('button');
    toggle.className = 'btn';
    toggle.textContent = '显示解析';
    toggle.addEventListener('click', () => {
      const isShow = ans.style.display === 'block';
      ans.style.display = isShow ? 'none' : 'block';
      toggle.textContent = isShow ? '显示解析' : '隐藏解析';
    });

    card.appendChild(ctrls);
    card.appendChild(ans);
    questionsContainer.appendChild(card);
  });

  // 底部批改条
  gradingBar.style.display = opts.readonly ? 'none' : 'flex'; updateStatsText();
  updateStatsText();
}

function updateStatsText(){
  const total = currentAnswers.length;
  if (!total){ statText.textContent=''; return; }
  const correct = currentAnswers.filter(a=>a && a.correct).length;
  statText.textContent = `本次成绩：${Math.round((correct/total)*100)||0}% 正确率；共 ${total} 题， 其中正确 ${correct} 题`;
}

// 批改（底部按钮）
gradeQuizBtn.addEventListener('click', ()=>{
  if (!currentData.length) return;
  let correct = 0;
  currentData.forEach((q, idx)=>{
    const qt = (q.question_type || (q.options?.length? 'mcq':'short')).toLowerCase();
    const rec = currentAnswers[idx] || {};
    let ok = false;

    if (qt === 'mcq') {
      const chosen = rec.choose || '';
      const ansLetter = q.answer_letter || 'A';
      ok = chosen === ansLetter;
      currentAnswers[idx] = {index: idx, choose: chosen, correct: ok, answer: ansLetter};
      if (!ok){
        saveWrong({
          question_type: 'mcq',
          question: q.question,
          options: q.options,
          answer_letter: ansLetter,
          answer_text: q.answer_text || '',
          answer_explanation: q.answer_explanation,
          student_answer: chosen
        });
      }
    } else {
      const stu = rec.student_text || rec.choose || '';
      ok = lenientMatch(stu, q.answer_text || '');
      currentAnswers[idx] = {index: idx, choose: stu, correct: ok, answer: q.answer_text || ''};
      if (!ok){
        saveWrong({
          question_type: 'short',
          question: q.question,
          options: [],
          answer_letter: '',
          answer_text: q.answer_text || '',
          answer_explanation: q.answer_explanation,
          student_answer: stu
        });
      }
    }
    if (ok) correct++;
  });
  updateStatsText();
  
  // 展开所有解析并在每题顶部显示 ✔/✖
  currentData.forEach((q, idx)=>{
    const card = questionsContainer.children[idx];
    const ans = card.querySelector('.answer');
    if (ans){ ans.style.display = 'block'; }
    // 在 meta 左侧附加状态
    const meta = card.querySelector('.meta');
    let mark = meta.querySelector('.result-mark');
    if (!mark){
      mark = document.createElement('span');
      mark.className = 'result-mark';
      mark.style.marginRight = '8px';
      meta.insertBefore(mark, meta.firstChild);
    }
    mark.textContent = (currentAnswers[idx] && currentAnswers[idx].correct) ? '✔' : '✖';
  });
  // 更新底部成绩文字
  updateStatsText();
  alert('批改完成：已显示正确/错误，并展开所有解析。');

});

// 生成题目
generateBtn.addEventListener('click', async () => {
  const questionCount = parseInt(qs('#questionCount').value, 10);
  const difficulty = qs('#difficulty').value;
  const topic = qs('#topic').value;
  const formTypeSel = qs('#formType').value;
  // 将三个“短答类”统一为 short，选择题为 mcq，混合为 mixed
  let formType = 'mixed';
  let subtype = '';
  if (formTypeSel === 'mcq') formType = 'mcq';
  else if (formTypeSel.startsWith('short')) { formType = 'short'; subtype = formTypeSel; }

  questionsContainer.innerHTML = '<p class="muted">正在生成题目，请稍候...</p>';
  gradingBar.style.display='none';

  try {
    const resp = await fetch('/.netlify/functions/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionType: currentType, questionCount, form: formType, subtype })
    });
    if(!resp.ok){
      const detail = await resp.text();
      throw new Error(`API请求失败: ${resp.status}｜${detail.slice(0,200)}`);
    }
    const data = await resp.json();

    data.forEach(d => {
      if (topic) d.question = `[${topic}] ` + d.question;
      if (difficulty==='intermediate') d.question = `【提高】` + d.question;
      if (difficulty==='challenge') d.question = `【挑战】` + d.question;
    });

    renderQuestions(data);
  } catch(err){
    questionsContainer.innerHTML = `<p style="color:#b91c1c">生成题目失败：${err.message}</p>`;
  }
});


// Filename numbering per day
function todayStr(){
  const d = new Date();
  const pad = n=> String(n).padStart(2,'0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`;
}
function getSeqKey(){ return `paper_seq_${todayStr()}`; }
function getCurrentSeq(){ return parseInt(localStorage.getItem(getSeqKey())||'0',10) || 0; }
function incSeq(){ const n = getCurrentSeq()+1; localStorage.setItem(getSeqKey(), String(n)); return n; }
function makeFileName(isSolutions=false, isWrongbook=false, forcedSeq=null){
  const date = todayStr();
  if (isWrongbook) return `${date}-错题本`;
  const seq = forcedSeq ?? (isSolutions ? (getCurrentSeq() || 1) : incSeq());
  return isSolutions ? `${date}-解析-${seq}` : `${date}-试卷-${seq}`;
}
let _origTitle = document.title;
function preparePrint(mode, filename){
  document.body.classList.remove('paper','paper_solutions');
  document.body.classList.add(mode);
  _origTitle = document.title;
  document.title = filename;
}
function restoreTitle(){ document.title = _origTitle; }

exportPaperBtn.addEventListener('click', () => {
  const name = makeFileName(false,false);
  preparePrint('paper', name);
  window.print();
  restoreTitle();
});
exportPaperSolBtn.addEventListener('click', () => {
  const name = makeFileName(true,false);
  preparePrint('paper_solutions', name);
  window.print();
  restoreTitle();
});
exportWrongPdfBtn.addEventListener('click', ()=>{
  showWrongBook();
  setTimeout(()=>{
    const name = makeFileName(true, true, null);
    preparePrint('paper_solutions', name);
    window.print();
    restoreTitle();
  }, 50);
});
('click', () => {
  const name = makeFileName(true,false);
  preparePrint('paper_solutions', name);
  window.print();
  restoreTitle();
});


document.getElementById('showAllExplainBtn')?.addEventListener('click', () => {
  const btn = document.getElementById('showAllExplainBtn');
  const answers = document.querySelectorAll('.answer');
  // If any hidden, show all; else hide all
  let anyHidden = false;
  answers.forEach(a => { if (getComputedStyle(a).display === 'none') anyHidden = true; });
  answers.forEach(a => { a.style.display = anyHidden ? 'block' : 'none'; });
  btn.textContent = anyHidden ? '隐藏全部解析' : '显示全部解析';
});


/** 全局：显示/隐藏全部解析（事件委托，支持多个按钮） */
function toggleAllExplanations(){
  const answers = document.querySelectorAll('.answer');
  let anyHidden = false;
  answers.forEach(a => { if (getComputedStyle(a).display === 'none') anyHidden = true; });
  answers.forEach(a => { a.style.display = anyHidden ? 'block' : 'none'; });
  // 同步所有按钮文案
  document.querySelectorAll('[data-role="toggle-all-explain"]').forEach(btn=>{
    btn.textContent = anyHidden ? '隐藏全部解析' : '显示全部解析';
  });
}
// 事件委托，页面任意地方新增按钮都能生效
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-role="toggle-all-explain"]');
  if (btn) {
    e.preventDefault();
    toggleAllExplanations();
  }
});


function escapeHtml(str){
  return String(str||'')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}
function renderExplanation(ex){
  const text = String(ex||'').replace(/\r/g,'');
  const refMatch = text.match(/参考答案[:：]\s*([^\n]+)/);
  let stepsBlock = '';
  const sp = text.split(/分步讲解[:：]/);
  if (sp.length > 1){
    stepsBlock = sp[1].split(/提示[:：]/)[0] || '';
  }
  const hintMatch = text.match(/提示[:：]\s*([\s\S]*)$/);
  const steps = stepsBlock.split(/\n+/).map(s=>s.trim()).filter(Boolean).map(s=>s.replace(/^\d+\)\s*/,''));
  let html = '<div class="exp">';
  if (refMatch){ html += `<div class="exp-ref"><b>参考答案：</b> ${escapeHtml(refMatch[1].trim())}</div>`; }
  if (steps.length){
    html += '<div class="exp-steps"><b>分步讲解：</b><ol>';
    html += steps.map(s=>`<li>${escapeHtml(s)}</li>`).join('');
    html += '</ol></div>';
  }
  if (hintMatch){ html += `<div class="exp-hint"><b>提示：</b> ${escapeHtml(hintMatch[1].trim())}</div>`; }
  html += '</div>';
  return html;
}
