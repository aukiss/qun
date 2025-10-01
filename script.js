
const qs = (s)=>document.querySelector(s);
const qsa = (s)=>Array.from(document.querySelectorAll(s));

const questionsContainer = qs('#questionsContainer');
const generateBtn = qs('#generateBtn');
const btnGrammar = qs('#btnGrammar');
const btnTenses = qs('#btnTenses');
const exportPaperBtn = qs('#exportPaperBtn');
const exportPaperSolBtn = qs('#exportPaperSolBtn');
const startQuizBtn = qs('#startQuizBtn');
const gradeQuizBtn = qs('#gradeQuizBtn');
const resetBtn = qs('#resetBtn');

const statBar = qs('#statsBar');
const statAcc = qs('#statAcc');
const statCount = qs('#statCount');
const statTopics = qs('#statTopics');

const viewWrongBtn = qs('#viewWrongBtn');
const exportWrongPdfBtn = qs('#exportWrongPdfBtn');
const clearWrongBtn = qs('#clearWrongBtn');

let currentType = 'grammar'; // grammar | tenses
let currentData = [];
let currentAnswers = []; // {index, choose, correct, answer, student_text?}
let quizMode = false; // 在线做题模式

const WRONG_KEY = 'english_quiz_wrongbook_v3';

btnGrammar.addEventListener('click', ()=>{
  currentType = 'grammar';
  btnGrammar.classList.add('primary');
  btnTenses.classList.remove('primary');
});
btnTenses.addEventListener('click', ()=>{
  currentType = 'tenses';
  btnTenses.classList.add('primary');
  btnGrammar.classList.remove('primary');
});

/** 仅保留：参考答案 + 分步讲解 + 提示（提示小字）。 */
function slimExplanation(answerLetter, answerText, explanation) {
  const exp = String(explanation || '');
  // 去头部的“参考答案/正确答案”
  const body = exp
    .replace(/^.*?(参考答案|正确答案)\s*[:：].*$/m, '')
    .replace(/^\s*(解题思路|思路|温馨鼓励|小贴士)\s*[:：].*$/gmi, '')
    .trim();

  // 提取“分步讲解”块
  let steps = '';
  const stepsMatch = body.match(/分步讲解\s*[:：]?([\s\S]*?)(?=\n\S|$)/m);
  if (stepsMatch) steps = stepsMatch[1].trim();

  // 提取“提示”块
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

function renderStats() {
  const total = currentAnswers.length;
  if (!total) { statBar.style.display='none'; return; }
  const correct = currentAnswers.filter(a=>a && a.correct).length;
  const acc = Math.round((correct/total)*100);
  statBar.style.display='flex';
  statAcc.textContent = `${acc}% 正确率`;
  statCount.textContent = `共 ${total} 题，其中正确 ${correct} 题`;

  const tp = qs('#topic')?.value || (currentType==='tenses'?'时态':'语法');
  statTopics.textContent = `知识点：${tp}`;
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
    return;
  }
  renderQuestions(book, {readonly:true, titlePrefix:'【错题】'});
  exportPaperBtn.disabled = false;
  exportPaperSolBtn.disabled = false;
}

viewWrongBtn?.addEventListener('click', showWrongBook);
clearWrongBtn?.addEventListener('click', ()=>{
  if (confirm('确定要清空本设备的错题本吗？')){
    localStorage.removeItem(WRONG_KEY);
    showWrongBook();
  }
});

exportWrongPdfBtn?.addEventListener('click', ()=>{
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
    qText.innerHTML = `${q.question ?? ''}`;

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
            if(!quizMode) return; // 做题时不着色、不提示正误
            currentAnswers[idx] = {index: idx, choose: String.fromCharCode(65+i), correct: false, answer: q.answer_letter||'A'};
          });
        }
        optList.appendChild(li);
      });
      card.appendChild(optList);
    } else {
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = ''; // 取消占位提示
      Object.assign(input.style, {
        width:'100%', height:'42px', fontSize:'18px', padding:'6px 10px',
        border:'1px solid #e5e7eb', borderRadius:'10px'
      });
      if (!readonly){
        input.addEventListener('change', ()=>{
          if (!quizMode) return;
          currentAnswers[idx] = {index: idx, choose: input.value, correct: false, answer: q.answer_text||'', student_text: input.value};
        });
      }
      card.appendChild(input);
    }

    const ans = document.createElement('div');
    ans.className = 'answer';
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

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.style.display = 'none';
    badge.textContent = '未批改';

    ctrls.appendChild(badge);
    ctrls.appendChild(toggle);

    card.appendChild(ctrls);
    card.appendChild(ans);
    questionsContainer.appendChild(card);
  });

  exportPaperBtn.disabled = false;
  exportPaperSolBtn.disabled = false;
  renderStats();
}

// 在线做题 / 批改 / 重置
startQuizBtn?.addEventListener('click', ()=>{
  quizMode = true;
  alert('已进入在线做题：选择答案或填写简答；完成后点“在线批改”。');
});
gradeQuizBtn?.addEventListener('click', ()=>{
  if (!currentData.length) return;
  // 逐题判定（不使用红绿，显示徽标），并自动把错题加入错题本
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

    // 显示徽标
    const card = questionsContainer.children[idx];
    const badge = card.querySelector('.badge');
    if (badge){
      badge.style.display = 'inline-block';
      badge.textContent = ok ? '✔ 正确' : '✖ 再想想';
    }
  });
  renderStats();
  alert('批改完成：已给出判断，并自动加入错题本。');
});
resetBtn?.addEventListener('click', ()=>{
  quizMode = false;
  currentAnswers = [];
  qsa('.badge').forEach(b=>{ b.style.display='none'; b.textContent='未批改'; });
  renderStats();
  alert('已重置：可以重新开始。');
});

// 生成题目
generateBtn?.addEventListener('click', async () => {
  const questionCount = parseInt(qs('#questionCount').value, 10);
  const difficulty = qs('#difficulty').value;
  const topic = qs('#topic').value;
  const formType = qs('#formType').value;

  questionsContainer.innerHTML = '<p class="muted">正在生成题目，请稍候...</p>';
  exportPaperBtn.disabled = true;
  exportPaperSolBtn.disabled = true;
  statBar.style.display='none';
  quizMode = false;

  try {
    const resp = await fetch('/.netlify/functions/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionType: currentType, questionCount, form: formType })
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

// 导出文件名：日期+试卷/解析+编号
function todayStr(){
  const d = new Date();
  const pad = n=> String(n).padStart(2,'0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`;
}
function makeFileName(isSolutions=false, isWrongbook=false){
  const code = qs('#paperCode')?.value || 'A';
  const date = todayStr();
  if (isWrongbook) return `${date}-错题本`;
  return isSolutions ? `${date}-解析-${code}` : `${date}-试卷-${code}`;
}
let _origTitle = document.title;
function preparePrint(mode, filename){
  document.body.classList.remove('paper','paper_solutions');
  document.body.classList.add(mode);
  _origTitle = document.title;
  document.title = filename;
}
function restoreTitle(){
  document.title = _origTitle;
}

exportPaperBtn?.addEventListener('click', () => {
  const name = makeFileName(false,false);
  preparePrint('paper', name);
  window.print();
  restoreTitle();
});
exportPaperSolBtn?.addEventListener('click', () => {
  const name = makeFileName(true,false);
  preparePrint('paper_solutions', name);
  window.print();
  restoreTitle();
});
