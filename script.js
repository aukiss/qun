const questionsContainer = document.getElementById('questionsContainer');
const generateBtn = document.getElementById('generateBtn');
const exportBtn = document.getElementById('exportPdfBtn');
const btnGrammar = document.getElementById('btnGrammar');
const btnTenses = document.getElementById('btnTenses');
const countSel = document.getElementById('questionCount');

let currentType = 'grammar'; // grammar | tenses
let currentData = [];

// Switch type buttons
btnGrammar.addEventListener('click', () => {
  currentType = 'grammar';
  btnGrammar.classList.add('primary');
  btnTenses.classList.remove('primary');
});
btnTenses.addEventListener('click', () => {
  currentType = 'tenses';
  btnTenses.classList.add('primary');
  btnGrammar.classList.remove('primary');
});

function renderQuestions(questions){
  questionsContainer.innerHTML = '';
  questions.forEach((q, idx) => {
    const card = document.createElement('div');
    card.className = 'question-card';

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `题目 ${idx + 1}`;

    const qText = document.createElement('div');
    qText.className = 'qtext';
    qText.innerHTML = `<strong>题干：</strong>${q.question ?? ''}`;

    const optList = document.createElement('ol');
    optList.className = 'options';
    optList.type = 'A';

    const options = Array.isArray(q.options) ? q.options : [];
    options.forEach(opt => {
      const li = document.createElement('li');
      li.textContent = opt;
      optList.appendChild(li);
    });

    const ans = document.createElement('div');
    ans.className = 'answer';
    const answerLetter = q.answer_letter ?? '';
    const explanation = q.answer_explanation ?? '';
    ans.innerHTML = `<pre>参考答案： ${answerLetter}\n${explanation}</pre>`;

    const toggle = document.createElement('button');
    toggle.className = 'btn toggle';
    toggle.textContent = '显示解析';
    toggle.addEventListener('click', () => {
      const isShow = ans.style.display === 'block';
      ans.style.display = isShow ? 'none' : 'block';
      toggle.textContent = isShow ? '显示解析' : '隐藏解析';
    });

    card.appendChild(meta);
    card.appendChild(qText);
    card.appendChild(optList);
    card.appendChild(toggle);
    card.appendChild(ans);
    questionsContainer.appendChild(card);
  });
}

generateBtn.addEventListener('click', async () => {
  const questionCount = parseInt(countSel.value, 10);
  questionsContainer.innerHTML = '<p class="muted">正在生成题目，请稍候...</p>';
  exportBtn.disabled = true;
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
    currentData = data;
    renderQuestions(data);
    exportBtn.disabled = false;
  } catch(err){
    questionsContainer.innerHTML = `<p style="color:#b91c1c">生成题目失败：${err.message}</p>`;
  }
});

exportBtn.addEventListener('click', () => {
  // read export mode
  const mode = document.querySelector('input[name="exportMode"]:checked')?.value || 'paper';
  document.body.classList.remove('paper','paper_solutions');
  document.body.classList.add(mode);
  window.print();
  // optional: revert class after print
  setTimeout(() => {
    document.body.classList.remove('paper','paper_solutions');
  }, 300);
});
