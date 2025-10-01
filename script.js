
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

const WRONG_KEY = 'english_quiz_wrongbook_v2';

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

function gentleExplanation(answerLetter, answerText, explanation) {
  const exp = String(explanation || '');
  const lines = exp.split(/\r?\n/);
  const filtered = lines.filter((ln,i)=> !(i===0 && /^\s*参考答案|^\s*正确答案/.test(ln)));
  let text = filtered.join('\n').trim();
  text = text.replace(/^参考答案\s*[:：].*$/m, '').replace(/^正确答案\s*[:：].*$/m, '').trim();
  const head = answerLetter ? `参考答案： ${answerLetter}` : `正确答案： ${answerText}`;
  return `${head}\n${text}`.trim();
}

function stripOptionLabel(s){
  return String(s||'').replace(/^\s*[A-D]\s*[\)\.\u3001、]\s*/i, '').trim();
}

// 轻量级文本规范化（宽松批改）：小写、去标点、去冠词、压缩空格
function normText(s){
  return String(s||'')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^a-z0-9\s']/g, ' ')
    .replace(/\b(a|an|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 关键词/相似度混合：
// - 若正确答案 <= 3 个词：直接比较规范化后是否相等（或包含关系）
// - 若 >3 个词：做 token 级 Jaccard，相似度 >= 0.7 视为通过；同时允许关键词全包含（不计顺序）。
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
  // 关键词覆盖（tSet 中高频关键词）
  // 简化：若 tSet 的 70% 词汇被覆盖，也判定通过
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

  const tp = qs('#topic').value || (currentType==='tenses'?'时态':'语法');
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
    const qt = (q.question_type || 'mcq').toLowerCase();
    const card = document.createElement('div');
    card.className = 'question-card';

    const meta = document.createElement('div');
    meta.className = 'meta';
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = currentType==='tenses'?'时态':'语法';
    meta.innerHTML = `<span>${titlePrefix}第 ${idx + 1} 题</span>`;
    meta.appendChild(tag);

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
            if(!quizMode) return;
            qsa('li', optList).forEach(x=>x.classList.remove('correct','wrong'));
            const letter = String.fromCharCode(65+i);
            const correct = (letter === (q.answer_letter||'A'));
            li.classList.add(correct? 'correct':'wrong');
            currentAnswers[idx] = {index: idx, choose: letter, correct, answer: q.answer_letter||'A'};
            if (!correct){
              saveWrong({
                question_type: 'mcq',
                question: q.question,
                options: q.options,
                answer_letter: q.answer_letter,
                answer_text: q.answer_text || '',
                answer_explanation: q.answer_explanation,
                student_answer: letter
              });
            }
            renderStats();
          });
        }
        optList.appendChild(li);
      });
      card.appendChild(optList);
    } else {
      // short
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = '请输入答案（英文）';
      input.style.width = '100%';
      input.style.height = '42px';
      input.style.fontSize = '18px';
      input.style.padding = '6px 10px';
      input.style.border = '1px solid #e5e7eb';
      input.style.borderRadius = '10px';
      if (!readonly){
        input.addEventListener('change', ()=>{
          if (!quizMode) return;
          const ok = lenientMatch(input.value, q.answer_text||'');
          input.classList.remove('correct','wrong');
          input.classList.add(ok?'correct':'wrong');
          currentAnswers[idx] = {index: idx, choose: input.value, correct: ok, answer: q.answer_text||'', student_text: input.value};
          if (!ok){
            saveWrong({
              question_type: 'short',
              question: q.question,
              options: [],
              answer_letter: '',
              answer_text: q.answer_text || '',
              answer_explanation: q.answer_explanation,
              student_answer: input.value
            });
          }
          renderStats();
        });
      }
      card.appendChild(input);
    }

    const ans = document.createElement('div');
    ans.className = 'answer';
    const explanation = gentleExplanation(q.answer_letter ?? '', q.answer_text ?? '', q.answer_explanation ?? '');
    ans.innerHTML = `<pre>${explanation}</pre>`;

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

    const addWrongBtn = document.createElement('button');
    addWrongBtn.className = 'btn';
    addWrongBtn.textContent = '加入错题本';
    addWrongBtn.addEventListener('click', ()=>{
      saveWrong({
        question_type: qt,
        question: q.question,
        options: q.options || [],
        answer_letter: q.answer_letter || '',
        answer_text: q.answer_text || '',
        answer_explanation: q.answer_explanation,
        student_answer: ''
      });
      addWrongBtn.textContent = '已加入';
      addWrongBtn.disabled = true;
    });

    if (!readonly){
      ctrls.appendChild(addWrongBtn);
    }
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
startQuizBtn.addEventListener('click', ()=>{
  quizMode = true;
  alert('已进入在线做题：选择题点击选项，简答题输入后回车或切换焦点即可。完成后点“在线批改”。');
});
gradeQuizBtn.addEventListener('click', ()=>{
  if (!currentData.length) return;
  currentData.forEach((q, idx)=>{
    const rec = currentAnswers[idx];
    if (!rec){
      // 未作答：加入错题本
      const qt = (q.question_type || 'mcq').toLowerCase();
      saveWrong({
        question_type: qt,
        question: q.question,
        options: q.options || [],
        answer_letter: q.answer_letter || '',
        answer_text: q.answer_text || '',
        answer_explanation: q.answer_explanation,
        student_answer: ''
      });
      currentAnswers[idx] = {index: idx, choose: '', correct: false, answer: (qt==='mcq'?(q.answer_letter||'A'):(q.answer_text||''))};
    } else if (q.question_type === 'short' && rec.student_text!=null) {
      // 再次宽松判定（防止孩子后来又改了）
      const ok = lenientMatch(rec.student_text, q.answer_text||'');
      rec.correct = ok;
      if (!ok){
        saveWrong({
          question_type: 'short',
          question: q.question,
          options: [],
          answer_letter: '',
          answer_text: q.answer_text || '',
          answer_explanation: q.answer_explanation,
          student_answer: rec.student_text
        });
      }
    }
  });
  renderStats();
  alert('批改完成：统计栏已更新。');
});
resetBtn.addEventListener('click', ()=>{
  quizMode = false;
  currentAnswers = [];
  qsa('.options').forEach(ol=> qsa('li', ol).forEach(li=> li.classList.remove('correct','wrong')));
  qsa('input[type="text"]').forEach(inp=> inp.classList.remove('correct','wrong'));
  renderStats();
  alert('已重置：可以重新开始或继续练习。');
});

// 生成题目
generateBtn.addEventListener('click', async () => {
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

    // 前端轻度标注
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

// 导出文件名
function todayStr(){
  const d = new Date();
  const pad = n=> String(n).padStart(2,'0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`;
}
function makeFileName(isSolutions=false, isWrongbook=false){
  const code = qs('#paperCode').value || 'A';
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
