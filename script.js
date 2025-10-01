const qs = (s)=>document.querySelector(s);
const qsa = (s)=>Array.from(document.querySelectorAll(s));

const questionsContainer = qs('#questionsContainer');
const generateBtn = qs('#generateBtn');
const btnGrammar = qs('#btnGrammar');
const btnTenses = qs('#btnTenses');
const exportPaperBtn = qs('#exportPaperBtn');
const exportPaperSolBtn = qs('#exportPaperSolBtn');

const statBar = qs('#statsBar');
const statAcc = qs('#statAcc');
const statCount = qs('#statCount');
const statTopics = qs('#statTopics');

const viewWrongBtn = qs('#viewWrongBtn');
const exportWrongPdfBtn = qs('#exportWrongPdfBtn');
const clearWrongBtn = qs('#clearWrongBtn');

let currentType = 'grammar'; // grammar | tenses
let currentData = [];
let currentAnswers = []; // 用户作答记录

const WRONG_KEY = 'english_quiz_wrongbook_v1';
const STATS_KEY = 'english_quiz_stats_v1';

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

function cleanExplanation(answerLetter, explanation) {
  const exp = String(explanation || '');
  // 去掉重复的“参考答案：X”开头行
  const lines = exp.split(/\r?\n/);
  const filtered = lines.filter((ln,i)=> !(i===0 && /^\s*参考答案\s*[:：]/.test(ln)));
  let text = filtered.join('\n').trim();
  if (!/^参考答案\s*[:：]/.test(text)) {
    text = `参考答案： ${answerLetter}\n` + text;
  } else {
    // 如果仍然有“参考答案：”但不是我们想要的字母，就替换为标准字母
    text = text.replace(/^参考答案\s*[:：].*$/m, `参考答案： ${answerLetter}`);
  }
  return text.trim();
}

function renderStats() {
  const total = currentAnswers.length;
  if (!total) { statBar.style.display='none'; return; }
  const correct = currentAnswers.filter(a=>a.correct).length;
  const acc = Math.round((correct/total)*100);
  statBar.style.display='flex';
  statAcc.textContent = `${acc}% 正确率`;
  statCount.textContent = `共 ${total} 题，其中正确 ${correct} 题`;

  // 简单统计各知识点（用 currentType + 选中的 topic）
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
  document.body.classList.remove('paper','paper_solutions');
  document.body.classList.add('paper_solutions');
  window.print();
  setTimeout(()=>document.body.classList.remove('paper','paper_solutions'), 300);
});

function renderQuestions(questions, opts={}){
  const {readonly=false, titlePrefix=''} = opts;
  currentData = questions;
  currentAnswers = [];
  questionsContainer.innerHTML = '';

  questions.forEach((q, idx) => {
    const card = document.createElement('div');
    card.className = 'question-card';

    const meta = document.createElement('div');
    meta.className = 'meta';
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = currentType==='tenses'?'时态':'语法';
    meta.innerHTML = `<span>${titlePrefix}题目 ${idx + 1}</span>`;
    meta.appendChild(tag);

    const qText = document.createElement('div');
    qText.className = 'qtext';
    qText.innerHTML = `<strong>题干：</strong>${q.question ?? ''}`;

    const optList = document.createElement('ol');
    optList.className = 'options';
    optList.type = 'A';

    const options = Array.isArray(q.options) ? q.options : [];
    options.forEach((opt, i) => {
      const li = document.createElement('li');
      li.textContent = opt;
      li.classList.add('touch');
      if (!readonly){
        li.addEventListener('click', ()=>{
          // 单选
          qsa('li', optList).forEach(x=>x.classList.remove('correct','wrong'));
          const letter = String.fromCharCode(65+i); // A/B/C/D
          const correct = (letter === (q.answer_letter||'A'));
          li.classList.add(correct? 'correct':'wrong');
          const rec = {index: idx, choose: letter, correct, answer: q.answer_letter||'A'};
          // 记录
          currentAnswers[idx] = rec;
          // 错题加入本地
          if (!correct){
            saveWrong({
              question: q.question,
              options: q.options,
              answer_letter: q.answer_letter,
              answer_explanation: q.answer_explanation
            });
          }
          renderStats();
        });
      }
      optList.appendChild(li);
    });

    const ans = document.createElement('div');
    ans.className = 'answer';
    const explanation = cleanExplanation(q.answer_letter ?? '', q.answer_explanation ?? '');
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

    if (!readonly){
      const addWrongBtn = document.createElement('button');
      addWrongBtn.className = 'btn';
      addWrongBtn.textContent = '加入错题本';
      addWrongBtn.addEventListener('click', ()=>{
        saveWrong({
          question: q.question,
          options: q.options,
          answer_letter: q.answer_letter,
          answer_explanation: q.answer_explanation
        });
        addWrongBtn.textContent = '已加入';
        addWrongBtn.disabled = true;
      });
      ctrls.appendChild(addWrongBtn);
    }
    ctrls.appendChild(toggle);

    card.appendChild(meta);
    card.appendChild(qText);
    card.appendChild(optList);
    card.appendChild(ctrls);
    card.appendChild(ans);
    questionsContainer.appendChild(card);
  });

  exportPaperBtn.disabled = false;
  exportPaperSolBtn.disabled = false;
  renderStats();
}

generateBtn.addEventListener('click', async () => {
  const questionCount = parseInt(qs('#questionCount').value, 10);
  const difficulty = qs('#difficulty').value;
  const topic = qs('#topic').value;

  questionsContainer.innerHTML = '<p class="muted">正在生成题目，请稍候...</p>';
  exportPaperBtn.disabled = true;
  exportPaperSolBtn.disabled = true;
  statBar.style.display='none';

  try {
    const resp = await fetch('/.netlify/functions/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionType: currentType, questionCount })
    });
    if(!resp.ok){
      const detail = await resp.text();
      throw new Error(`API请求失败: ${resp.status}｜${detail.slice(0,200)}`);
    }
    const data = await resp.json();

    // 按难度/知识点在前端做轻度“提示性”过滤/标注，保证可用性（真正的约束在后端可进一步收紧 Prompt）
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

exportPaperBtn.addEventListener('click', () => {
  document.body.classList.remove('paper','paper_solutions');
  document.body.classList.add('paper');
  window.print();
  setTimeout(()=>document.body.classList.remove('paper','paper_solutions'), 300);
});

exportPaperSolBtn.addEventListener('click', () => {
  document.body.classList.remove('paper','paper_solutions');
  document.body.classList.add('paper_solutions');
  window.print();
  setTimeout(()=>document.body.classList.remove('paper','paper_solutions'), 300);
});
