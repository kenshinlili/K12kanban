/* 李迦一 · 学习看板 */
const API = '/api';
let STATE = { date: '', member: 'dad', data: null };
let CURRENT_BOARD = null;   // 当前抽屉里的板块
let CURRENT_CHECKIN = null; // 当前抽屉里的打卡详情
let REJECT_INPUT = {};      // 错题驳回意见暂存

const SUBJECT_ORDER = ['语文', '数学', '英语'];
const SUBJECT_CLASS = { '语文': 'cn', '数学': 'math', '英语': 'en' };
const STATUS_TEXT = {
  pending_ai: '待识别',
  pending_review: '待审核',
  rerun_requested: '待重跑',
  transferred: '已流转',
  confirmed: '已完成',
  skipped: '今日无任务',
};

/* ---------- utils ---------- */
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}
function esc(s) {
  return (s == null ? '' : String(s)).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
async function get(url) {
  const r = await fetch(API + url);
  return r.json();
}
async function post(url, body) {
  const r = await fetch(API + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return r.json();
}
async function del(url) {
  const r = await fetch(API + url, { method: 'DELETE' });
  return r.json();
}
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* ---------- 数据 ---------- */
async function loadState() {
  const d = await get(`/state?date=${STATE.date}&member=${STATE.member}`);
  if (d.ok) STATE.data = d;
  render();
}
async function loadCheckin(cid) {
  const d = await get(`/checkin/${cid}`);
  if (d.ok) CURRENT_CHECKIN = d.checkin;
  return d.ok;
}
async function loadBoardHistory(boardId) {
  const d = await get(`/board/${boardId}/history`);
  return d.ok ? d.items : [];
}

/* ---------- 渲染 ---------- */
function render() {
  if (!STATE.data) return;
  renderMembers();
  renderKanban();
  renderTodo();
  renderReview();
  renderWrongbook();
  renderKnowledge();
}

function renderMembers() {
  const el = document.getElementById('memberSwitch');
  el.innerHTML = STATE.data.members.map(m =>
    `<button class="member-btn ${m.id === STATE.member ? 'active' : ''}" data-member="${m.id}">
      ${m.avatar} ${esc(m.name)}
    </button>`).join('');
  el.querySelectorAll('.member-btn').forEach(b => {
    b.onclick = () => { STATE.member = b.dataset.member; render(); };
  });
  // 仅家长（爸爸/妈妈）可见「同步最新版」按钮
  const syncBtn = document.getElementById('syncBtn');
  if (syncBtn) syncBtn.style.display = (STATE.member === 'dad' || STATE.member === 'mom') ? '' : 'none';
}

function renderKanban() {
  const container = document.getElementById('view-kanban');
  const groups = {};
  STATE.data.boards.forEach(b => {
    (groups[b.subject] = groups[b.subject] || []).push(b);
  });
  let html = '';
  SUBJECT_ORDER.forEach(sub => {
    if (!groups[sub]) return;
    html += `<div class="subject-group">
      <div class="subject-title"><span class="dot ${SUBJECT_CLASS[sub]}"></span>${sub}</div>
      <div class="board-grid">${groups[sub].map(boardCard).join('')}</div>
    </div>`;
  });
  container.innerHTML = html;
  container.querySelectorAll('.board-card').forEach(card => {
    card.onclick = e => {
      if (e.target.closest('button')) return;
      openBoard(card.dataset.board);
    };
  });
  container.querySelectorAll('[data-act]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const boardId = btn.closest('.board-card').dataset.board;
      const act = btn.dataset.act;
      if (act === 'checkin') openBoard(boardId, true);
      else if (act === 'skip') skipBoard(boardId);
      else if (act === 'open') openBoard(boardId);
      else if (act === 'undo') undoCheckin(boardId);
      else if (act === 'review') openBoard(boardId);
    };
  });
}

async function skipBoard(boardId) {
  const r = await post('/checkin', {
    board_id: boardId, member_id: STATE.member, date: STATE.date,
    duration_min: null, note: '今日无此任务',
  });
  if (!r.ok) { toast(r.error || '操作失败'); return; }
  await post(`/checkin/${r.checkin_id}/skip`, { member_id: STATE.member });
  toast('已标记今日无任务（点 ↩ 返回 可撤销）');
  await loadState();
}

function boardCard(b) {
  const ci = b.checkin;
  const kpTag = `<span class="tag ${b.track_mode === '单元' ? 'unit' : 'topic'}">${b.track_mode}</span>`;
  const orgTag = `<span class="tag ${b.org_type === '校内' ? 'school' : 'outside'}">${b.org_type}</span>`;

  // ---------- 未打卡：显示空心 ☑ + 「今日无任务」 ----------
  if (!ci) {
    return `<div class="board-card" data-board="${b.id}">
      <div class="bc-head">
        <div class="bc-name">${esc(b.name)}</div>
        <div class="bc-tags">${orgTag}${kpTag}</div>
      </div>
      <div class="bc-meta"><span>— 今日未打卡</span></div>
      <div class="bc-actions">
        <button class="btn btn-check" data-act="checkin">☐ 今日完成</button>
        <button class="btn btn-skip btn-sm" data-act="skip">— 今日无任务</button>
      </div>
    </div>`;
  }

  const st = ci.status;
  const needAttention = ['pending_review', 'rerun_requested', 'transferred'].includes(st);
  let meta = `<span>⏱ ${ci.duration_min ? ci.duration_min + ' 分钟' : '未填时长'}</span>`;
  meta += `<span>📷 ${b.photo_count} 张</span>`;
  if (b.wrong_count > 0) meta += `<span>❌ ${b.wrong_count} 题</span>`;
  if (ci.note && st !== 'skipped') meta += `<span>📝 ${esc(ci.note)}</span>`;

  // ---------- 已打卡：绿勾或灰底"无任务" ----------
  let statusBadge = '';
  let actions = '';
  if (st === 'skipped') {
    // 今日无任务：灰色勾 + 撤销
    statusBadge = `<span class="status-pill sp-skipped">— 今日无任务</span>`;
    actions = `<button class="btn btn-danger btn-sm" data-act="undo">↩ 返回</button>`;
  } else {
    const pill = `<span class="status-pill sp-${st}">${STATUS_TEXT[st] || st}</span>`;
    statusBadge = `<div class="done-row">
      <span class="check-done">✓</span>
      <span>已完成</span>
    </div>`;
    actions = `<button class="btn btn-sm" data-act="open">查看详情</button>`;
    if (needAttention) actions = `<button class="btn btn-warn btn-sm" data-act="review">去处理</button>` + actions;
    actions += `<button class="btn btn-danger btn-sm" data-act="undo">↩ 返回</button>`;
  }

  return `<div class="board-card ${st === 'skipped' ? 'skipped' : (needAttention ? 'attention' : 'done')}" data-board="${b.id}">
    <div class="bc-head">
      <div class="bc-name">${esc(b.name)}</div>
      <div class="bc-tags">${orgTag}${kpTag}</div>
    </div>
    <div class="bc-meta">${meta}</div>
    <div>${statusBadge}</div>
    <div class="bc-actions">${actions}</div>
  </div>`;
}

async function renderTodo() {
  const container = document.getElementById('view-todo');
  const badge = document.getElementById('todoBadge');
  const todo = (STATE.data.todo || []).filter(t => {
    if (t.status === 'transferred') return t.assigned_to === STATE.member;
    return true;
  });
  badge.textContent = todo.length;
  badge.classList.toggle('zero', todo.length === 0);

  if (!todo.length) {
    // 0 项时：把空态变成"今日还该做什么"的快捷入口
    const [stats, todayR, hm] = await Promise.all([
      get('/review/stats'),
      get('/review/today'),
      get('/knowledge-heatmap'),
    ]);
    const due = (todayR.items || []).length;
    const weak = hm.totals ? Object.values(hm.totals.by_subject || {})
      .filter(s => s.weakest_kp && s.weakest_count >= 2) : [];

    container.innerHTML = `<div class="empty"><div class="emoji">🎉</div>
      <div>当前没有待处理的事项</div>
      <div style="font-size:12px;color:var(--text-soft);margin-top:6px">
        全部已处理完毕 / 没有流转 / 没有待审的题
      </div></div>
      <div class="empty-todo-hint">
        <div class="eth-row">
          <span class="eth-label">📅 今日待复习</span>
          <span class="eth-num" style="color:${due ? 'var(--danger)' : 'var(--text-soft)'}">${due} 题</span>
          <button class="btn btn-sm" data-gotab="review">去复习</button>
        </div>
        ${weak.length ? `<div class="eth-row">
          <span class="eth-label">🔥 薄弱知识点</span>
          <span class="eth-num" style="color:var(--warn)">${weak.length} 处</span>
          <button class="btn btn-sm" data-gotab="knowledge">看热力图</button>
        </div>` : ''}
        <div class="eth-row" style="background:#f9fafb">
          <span class="eth-label" style="color:var(--text-soft)">💡 提示</span>
          <span style="font-size:12px;color:var(--text-soft)">流转给妈妈的任务、待审的题、被打回的题都会出现在这里</span>
        </div>
      </div>`;
    container.querySelectorAll('[data-gotab]').forEach(b => {
      b.onclick = () => document.querySelector(`[data-view="${b.dataset.gotab}"]`).click();
    });
    return;
  }
  container.innerHTML = todo.map(t => {
    const board = STATE.data.boards.find(b => b.id === t.board_id) || {};
    let actionBtn = '';
    if (t.status === 'transferred') {
      actionBtn = `<button class="btn btn-primary btn-sm" data-todo="take" data-cid="${t.id}">接手处理</button>`;
    } else if (t.status === 'pending_review') {
      actionBtn = `<button class="btn btn-warn btn-sm" data-todo="review" data-cid="${t.id}">去审核</button>`;
    } else if (t.status === 'rerun_requested') {
      actionBtn = `<button class="btn btn-sm" data-todo="review" data-cid="${t.id}">查看</button>`;
    }
    return `<div class="todo-item">
      <div class="todo-left">
        <div class="todo-title">${esc(t.subject)} · ${esc(t.board_name)}</div>
        <div class="todo-meta">
          <span class="status-pill sp-${t.status}">${STATUS_TEXT[t.status]}</span>
          <span>📅 ${t.checkin_date}</span>
          <span>📷 ${t.photo_count} 张</span>
        </div>
      </div>
      <div class="bc-actions">${actionBtn}</div>
    </div>`;
  }).join('');

  container.querySelectorAll('[data-todo]').forEach(btn => {
    btn.onclick = async () => {
      const cid = btn.dataset.cid;
      if (btn.dataset.todo === 'take') {
        await post(`/checkin/${cid}/take-back`, { member_id: STATE.member });
        toast('已接手');
      }
      await loadState();
      await openCheckin(cid);
    };
  });
}


async function renderReview() {
  const container = document.getElementById('view-review');
  const badge = document.getElementById('reviewBadge');
  const [statsR, dueR, doneR] = await Promise.all([
    get('/review/stats'),
    get('/review/today'),
    get('/review/today-done'),
  ]);
  if (!statsR.ok || !dueR.ok) return;
  const stats = statsR;
  const due = dueR.items;
  const done = doneR.items || [];
  badge.textContent = stats.due;
  badge.classList.toggle('zero', stats.due === 0);

  let html = `<div class="review-stats">
    <div class="stat-card">
      <div class="stat-num due">${stats.due}</div>
      <div class="stat-label">📅 今日待复习</div>
    </div>
    <div class="stat-card">
      <div class="stat-num upcoming">${stats.upcoming}</div>
      <div class="stat-label">⏳ 未来待复习</div>
    </div>
    <div class="stat-card">
      <div class="stat-num mastered">${stats.mastered}</div>
      <div class="stat-label">✅ 已掌握</div>
    </div>
    <div class="stat-card">
      <div class="stat-num" style="color:var(--primary)">${stats.total_wrong}</div>
      <div class="stat-label">📚 错题积累</div>
    </div>
  </div>`;

  if (Object.keys(stats.per_subject).length) {
    html += `<div class="section"><h3>按科目</h3>
      <div style="display:flex;gap:11px;flex-wrap:wrap">
        ${Object.entries(stats.per_subject).map(([sub, s]) => `
          <div style="flex:1;min-width:180px;background:#f9fafb;border-radius:9px;padding:9px 12px">
            <div style="font-weight:700;margin-bottom:5px">${esc(sub)}</div>
            <div style="font-size:12px;color:var(--text-soft)">
              待复习 <b style="color:var(--danger)">${s.due}</b> · 已掌握 <b style="color:#16a34a">${s.mastered}</b>
            </div>
          </div>`).join('')}
      </div>
    </div>`;
  }

  html += `<h3 style="margin:14px 0 9px">🔁 今日待复习 (${due.length})</h3>`;
  if (!due.length) {
    html += `<div class="empty" style="padding:24px 14px"><div class="emoji" style="font-size:28px">✨</div>
      <div style="font-size:13px">今天没有需要复习的错题</div></div>`;
  } else {
    html += due.map(r => reviewCard(r)).join('');
  }

  // 今日已复习区
  html += `<h3 style="margin:18px 0 9px">📝 今日已复习 (${done.length})</h3>`;
  if (!done.length) {
    html += `<div class="empty" style="padding:18px 14px"><div style="font-size:13px;color:var(--text-soft)">今天还没复习过</div></div>`;
  } else {
    html += done.map(r => reviewDoneCard(r)).join('');
  }

  container.innerHTML = html;
  bindReviewEvents();
}

function reviewDoneCard(r) {
  const stageDots = [];
  for (let i = 0; i < 4; i++) {
    stageDots.push(`<span class="stage-dot ${i < r.current_stage ? 'done' : ''}"></span>`);
  }
  // 找今天最后一条记录的结果
  const todayRecords = r.today_records || [];
  const lastResult = todayRecords[todayRecords.length - 1];
  const isCorrect = lastResult && lastResult.result === 'correct';
  const isMastered = r.status === 'mastered';
  const resultBadge = isMastered
    ? '<span class="status-pill sp-confirmed">🎉 已掌握</span>'
    : (isCorrect
      ? '<span class="status-pill sp-confirmed">✓ 答对</span>'
      : '<span class="status-pill sp-rerun_requested">✗ 答错（已重置）</span>');
  const stageBadge = r.status === 'pending' ? `下次 ${r.next_review_date}` : '';
  const doneTimes = todayRecords.length;
  const doneLabel = lastResult
    ? `本次第 ${lastResult.stage} 次${doneTimes > 1 ? `（今天练了 ${doneTimes} 轮）` : ''}`
    : `第 ${r.current_stage + 1} 次`;
  return `<div class="review-card" style="border-left-color:#e5e7eb;background:#f9fafb">
    <div class="review-stage">
      <span>${r.subject} · ${esc(r.board_name)}</span>
      <span class="stage-dots">${stageDots.join('')}</span>
      <span style="margin-left:auto">${doneLabel}</span>
    </div>
    <div class="review-content">${formatAnswer(r.content)}</div>
    <div class="review-meta">
      ${r.knowledge_point ? `<span>📍 ${esc(r.knowledge_point)}</span>` : ''}
      ${r.error_type ? `<span>🏷 ${esc(r.error_type)}</span>` : ''}
      ${stageBadge ? `<span>📅 ${stageBadge}</span>` : ''}
    </div>
    <div style="margin-top:6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">
      ${resultBadge}
      <button class="btn btn-danger btn-sm" style="margin-left:auto"
        data-rundo="${r.id}">↩ 撤销本次</button>
    </div>
  </div>`;
}

function reviewCard(r) {
  const overdue = r.overdue_days > 0;
  const stageDots = [];
  for (let i = 0; i < 4; i++) {
    stageDots.push(`<span class="stage-dot ${i < r.current_stage ? 'done' : ''}"></span>`);
  }
  const historyHtml = (r.history || []).map(h =>
    `<span class="hh-item ${h.result === 'correct' ? 'hh-c' : 'hh-w'}">第${h.stage}次 ${h.date}</span>`
  ).join(' ');
  return `<div class="review-card ${overdue ? 'overdue' : ''}" data-schedule="${r.id}" data-wq="${r.wrong_question_id}">
    <div class="review-stage">
      <span>${r.subject} · ${esc(r.board_name)}</span>
      <span class="stage-dots">${stageDots.join('')}</span>
      <span style="margin-left:auto">第 ${r.current_stage + 1} 次复习</span>
    </div>
    <div class="review-content">${formatAnswer(r.content)}</div>
    <div class="review-meta">
      ${r.knowledge_point ? `<span>📍 ${esc(r.knowledge_point)}</span>` : ''}
      ${r.error_type ? `<span>🏷 ${esc(r.error_type)}</span>` : ''}
      <span>📅 计划 ${r.next_review_date}${overdue ? ` · 欠${r.overdue_days}天` : ''}</span>
      <span>来源 ${r.checkin_date}</span>
    </div>
    <div class="review-tip">💡 让孩子口头/笔头重做这一题，不要让他看答案。完成后家长判对/错。</div>
    <div class="review-actions" style="margin-top:11px">
      <button class="btn btn-success btn-sm" data-review="correct" data-rid="${r.id}">✓ 答对了</button>
      <button class="btn btn-danger btn-sm" data-review="wrong" data-rid="${r.id}">✗ 答错了</button>
      <button class="btn btn-sm" data-answer="${r.id}">👁 看答案</button>
    </div>
    <div class="review-answer" id="rwa-${r.id}" style="display:none">
      <div>上次错答：<span class="wrong">${formatAnswer(r.student_answer)}</span></div>
      <div>正确答案：<span class="right">${formatAnswer(r.correct_answer)}</span></div>
    </div>
    ${historyHtml ? `<div class="review-history">历史：${historyHtml}</div>` : ''}
  </div>`;
}

function bindReviewEvents() {
  document.querySelectorAll('[data-answer]').forEach(btn => {
    btn.onclick = () => {
      const box = document.getElementById('rwa-' + btn.dataset.answer);
      if (!box) return;
      const show = box.style.display === 'none';
      box.style.display = show ? 'block' : 'none';
      btn.textContent = show ? '🙈 收起答案' : '👁 看答案';
    };
  });
  document.querySelectorAll('[data-rundo]').forEach(btn => {
    btn.onclick = async () => {
      const rid = btn.dataset.rundo;
      const r = await post(`/review/${rid}/undo`, { member_id: STATE.member });
      if (!r.ok) { toast(r.error || '无法撤销'); return; }
      toast('↩ 已撤销本次答题，题回到待复习');
      await loadState();
      renderReview();
    };
  });
  document.querySelectorAll('[data-review]').forEach(btn => {
    btn.onclick = async () => {
      const rid = btn.dataset.rid;
      const result = btn.dataset.review;
      const r = await post(`/review/${rid}/answer`, { result, member_id: STATE.member });
      if (!r.ok) { toast(r.error); return; }
      if (r.new_status === 'mastered') {
        toast('🎉 已掌握！从复习列表移除');
      } else if (result === 'correct') {
        toast(`✓ 答对！下次复习 ${r.next_review_date}`);
      } else {
        toast('✗ 答错，已重置复习节奏。换个时间再过一遍');
      }
      await loadState();
      renderReview();
    };
  });
}

/** 把「风平浪静（fēng píng làng jìng）」里的拼音渲染成小字号弱色 */
function formatAnswer(text) {
  if (!text) return '—';
  return esc(text).replace(/[（(]([^）)]*)[）)]/g,
    '<span class="pinyin">（$1）</span>');
}

const REVIEW_STATE_TEXT = {
  due: '待复习', learning: '复习中', mastered: '已掌握', new: '未排期',
};
const REVIEW_STATE_CLASS = {
  due: 'sp-rerun_requested', learning: 'sp-pending_ai',
  mastered: 'sp-confirmed', new: 'sp-skipped',
};

async function renderWrongbook() {
  const container = document.getElementById('view-wrongbook');
  const d = await get('/wrong-questions');
  if (!d.ok) return;
  const items = d.items;
  if (!items.length) {
    container.innerHTML = `<div class="empty"><div class="emoji">📖</div>
      <div>还没有已确认的错题</div></div>`;
    return;
  }
  const s = d.summary || {};
  const st = s.by_state || {};

  // ---- 概览：本阶段错误全景 ----
  let html = `<div class="review-stats">
    <div class="stat-card"><div class="stat-num">${s.total || 0}</div><div class="stat-label">错题总数</div></div>
    <div class="stat-card"><div class="stat-num due">${st.due || 0}</div><div class="stat-label">待复习</div></div>
    <div class="stat-card"><div class="stat-num upcoming">${st.learning || 0}</div><div class="stat-label">复习中</div></div>
    <div class="stat-card"><div class="stat-num mastered">${st.mastered || 0}</div><div class="stat-label">已掌握</div></div>
  </div>`;

  // 按科目 × 知识点（单元）归类
  if (s.by_knowledge_point) {
    html += `<div class="wb-section-title">按单元 / 知识点归类</div><div class="wb-group">`;
    Object.keys(s.by_knowledge_point).forEach(sub => {
      const kps = s.by_knowledge_point[sub];
      const total = Object.values(kps).reduce((a, b) => a + b, 0);
      html += `<div class="wb-kp-card">
        <div class="wb-kp-head"><span class="dot ${SUBJECT_CLASS[sub]}"></span>
          <b>${esc(sub)}</b><span class="wb-kp-count">${total} 题</span></div>
        <div class="wb-kp-list">`;
      Object.entries(kps).sort((a, b) => b[1] - a[1]).forEach(([kp, n]) => {
        html += `<button class="kp-chip" data-wbkp="${esc(kp)}">${esc(kp)} <span class="kp-n">${n}</span></button>`;
      });
      html += `</div></div>`;
    });
    html += `</div>`;
  }

  // 错误类型分布
  if (s.by_error_type && Object.keys(s.by_error_type).length) {
    html += `<div class="wb-section-title">错误类型分布</div><div class="wb-errbar">`;
    const max = Math.max(...Object.values(s.by_error_type));
    Object.entries(s.by_error_type).sort((a, b) => b[1] - a[1]).forEach(([et, n]) => {
      html += `<div class="wb-errrow">
        <span class="wb-errname">${esc(et)}</span>
        <span class="wb-errtrack"><i style="width:${Math.round(n / max * 100)}%"></i></span>
        <span class="wb-errn">${n}</span></div>`;
    });
    html += `</div>`;
  }

  // ---- 检索区 ----
  const subjects = [...new Set(items.map(i => i.subject))];
  html += `<div class="wb-section-title">全部错题检索
    ${s.date_range ? `<span class="wb-range">${s.date_range[0]} ~ ${s.date_range[1]}</span>` : ''}</div>
    <div class="wb-filter">
    <button class="btn btn-sm wb-f on" data-wb="all">全部 (${items.length})</button>
    ${subjects.map(sub => `<button class="btn btn-sm wb-f" data-wb="${esc(sub)}">${esc(sub)} (${items.filter(i => i.subject === sub).length})</button>`).join('')}
    <span class="wb-sep"></span>
    <button class="btn btn-sm wb-s on" data-wbs="all">不限状态</button>
    <button class="btn btn-sm wb-s" data-wbs="due">⏰ 待复习</button>
    <button class="btn btn-sm wb-s" data-wbs="learning">复习中</button>
    <button class="btn btn-sm wb-s" data-wbs="mastered">✓ 已掌握</button>
  </div><div id="wbList"></div>`;
  container.innerHTML = html;

  const list = document.getElementById('wbList');
  let fSub = 'all', fState = 'all', fKp = null;

  function show() {
    let arr = items.slice();
    if (fSub !== 'all') arr = arr.filter(i => i.subject === fSub);
    if (fState !== 'all') arr = arr.filter(i => i.review_state === fState);
    if (fKp) arr = arr.filter(i => (i.knowledge_point || '未归类') === fKp);
    const tip = fKp ? `<div class="wb-tip">筛选：知识点「${esc(fKp)}」
      <button class="btn btn-sm" id="wbClearKp">清除</button></div>` : '';
    list.innerHTML = tip + (arr.length ? arr.map(q => `
      <div class="wb-item">
        <div class="wb-head">
          <div class="wb-title">${formatAnswer(q.content)}</div>
          <div class="wb-date">${q.checkin_date} · v${q.version}</div>
        </div>
        <div class="wq-answers">
          <div>错答：<span class="wrong">${formatAnswer(q.student_answer)}</span></div>
          <div>正解：<span class="right">${formatAnswer(q.correct_answer)}</span></div>
        </div>
        <div class="wq-tags">
          <span class="tag school">${esc(q.subject)} · ${esc(q.board_name)}</span>
          ${q.error_type ? `<span class="tag">${esc(q.error_type)}</span>` : ''}
          ${q.knowledge_point ? `<span class="tag unit">${esc(q.knowledge_point)}</span>` : ''}
          <span class="status-pill ${REVIEW_STATE_CLASS[q.review_state] || ''}">${REVIEW_STATE_TEXT[q.review_state] || ''}</span>
          ${q.review_times ? `<span class="tag">复习 ${q.review_times} 次${q.wrong_times ? ` · 又错 ${q.wrong_times} 次` : ''}</span>` : ''}
        </div>
      </div>`).join('')
      : `<div class="empty" style="padding:22px"><div>没有符合条件的错题</div></div>`);
    const clr = document.getElementById('wbClearKp');
    if (clr) clr.onclick = () => { fKp = null; show(); };
  }
  show();

  function mark(els, el) {
    els.forEach(x => x.classList.remove('on'));
    el.classList.add('on');
  }
  const fs = [...container.querySelectorAll('[data-wb]')];
  fs.forEach(b => b.onclick = () => { fSub = b.dataset.wb; mark(fs, b); show(); });
  const ss = [...container.querySelectorAll('[data-wbs]')];
  ss.forEach(b => b.onclick = () => { fState = b.dataset.wbs; mark(ss, b); show(); });
  container.querySelectorAll('[data-wbkp]').forEach(b => b.onclick = () => {
    fKp = b.dataset.wbkp; show();
    document.getElementById('wbList').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

async function renderKnowledge() {
  const container = document.getElementById('view-knowledge');
  const boards = STATE.data.boards;

  // 顶部模式切换
  let html = `<div class="kp-tabs">
    <button class="btn kp-tab on" data-kpmode="manage">🔧 知识点台账</button>
    <button class="btn kp-tab" data-kpmode="heatmap">🔥 知识点热力图</button>
    <button class="btn kp-tab" data-kpmode="plan">🗓 学习计划</button>
  </div><div id="kpBody"></div>`;
  container.innerHTML = html;

  function showManage() {
    let h = '';
    SUBJECT_ORDER.forEach(sub => {
      const bs = boards.filter(b => b.subject === sub);
      if (!bs.length) return;
      h += `<div class="subject-group"><div class="subject-title">
        <span class="dot ${SUBJECT_CLASS[sub]}"></span>${sub}</div>`;
      bs.forEach(b => {
        const kps = STATE.data.knowledge_points[b.id] || [];
        h += `<div class="kp-board">
          <div class="kp-title">${esc(b.name)}
            <span class="tag ${b.org_type === '校内' ? 'school' : 'outside'}">${b.org_type}</span>
            <span class="tag ${b.track_mode === '单元' ? 'unit' : 'topic'}">按${b.track_mode}</span>
          </div>
          <div class="kp-list" data-kpboard="${b.id}">
            ${kps.map(k => `<div class="kp-chip">${esc(k.name)}
              <button class="del" data-kpdel="${k.id}" title="删除">×</button></div>`).join('')}
            <button class="kp-add" data-kpadd="${b.id}">+ 新增${b.track_mode}</button>
          </div>
        </div>`;
      });
      h += `</div>`;
    });
    document.getElementById('kpBody').innerHTML = h;
    bindKpManageEvents();
  }

  async function showHeatmap() {
    const r = await get('/knowledge-heatmap');
    if (!r.ok) return;
    const { subjects, totals } = r;
    const t = totals || {};
    let h = `<div class="review-stats">
      <div class="stat-card"><div class="stat-num">${t.total||0}</div><div class="stat-label">错题总数</div></div>
      <div class="stat-card"><div class="stat-num due">${t.due||0}</div><div class="stat-label">待复习</div></div>
      <div class="stat-card"><div class="stat-num upcoming">${t.learning||0}</div><div class="stat-label">复习中</div></div>
      <div class="stat-card"><div class="stat-num mastered">${t.mastered||0}</div><div class="stat-label">已掌握</div></div>
    </div>`;

    if (!subjects.length) {
      h += `<div class="empty" style="padding:24px">还没有错题数据</div>`;
      document.getElementById('kpBody').innerHTML = h;
      return;
    }
    h += `<div class="wb-section-title">按科目看薄弱点（深红=严重薄弱）</div>`;
    subjects.forEach(s => {
      const st = (t.by_subject || {})[s.subject] || {};
      h += `<div class="hm-subject">
        <div class="hm-subject-head">
          <span class="dot ${SUBJECT_CLASS[s.subject]}"></span>
          <b>${esc(s.subject)}</b>
          <span class="wb-kp-count">${st.total||0} 题</span>
          ${st.weakest_kp && st.weakest_count >= 2
            ? `<span class="hm-weak">⚠ 薄弱：${esc(st.weakest_kp)} (${st.weakest_count}题)</span>` : ''}
        </div>
        <div class="hm-board-list">`;
      s.boards.forEach(b => {
        if (!b.kps.some(k => k.total)) return;  // 只展示有错题的板块
        h += `<div class="hm-board">
          <div class="hm-board-name">${esc(b.board_name)}</div>
          <div class="hm-kp-grid">`;
        b.kps.forEach(k => {
          if (!k.total) return;
          // 强度 0~1：max(待复习+复习中) / total
          const intensity = k.total > 0 ? (k.due + k.learning * 0.5) / k.total : 0;
          const hue = Math.round(120 * (1 - Math.min(1, intensity * 1.5)));  // 120=绿, 0=红
          const color = k.mastered === k.total && k.total > 0
            ? '#d1fae5' : `hsl(${hue}, 75%, 88%)`;
          const border = k.due > 0 ? 'var(--danger)' : (k.learning > 0 ? 'var(--warn)' : '#e5e7eb');
          const topErr = Object.entries(k.error_types).sort((a,b)=>b[1]-a[1])[0];
          h += `<div class="hm-kp" style="background:${color};border-color:${border}"
                data-wbkp-board="${b.board_id}" data-wbkp-name="${esc(k.name)}"
                title="${esc(k.name)} · 待复习${k.due} · 复习中${k.learning} · 已掌握${k.mastered}">
            <div class="hm-kp-name">${esc(k.name)}</div>
            <div class="hm-kp-num">${k.total}</div>
            <div class="hm-kp-meta">
              ${k.due ? `<span style="color:var(--danger);font-weight:700">⏰${k.due}</span>` : ''}
              ${k.learning ? `<span style="color:var(--warn)">📚${k.learning}</span>` : ''}
              ${k.mastered ? `<span style="color:#16a34a">✓${k.mastered}</span>` : ''}
            </div>
            ${topErr ? `<div class="hm-kp-err">${esc(topErr[0])}</div>` : ''}
          </div>`;
        });
        h += `</div></div>`;
      });
      h += `</div></div>`;
    });
    h += `<div class="hm-legend">
      <span>色块颜色：</span>
      <span style="background:#d1fae5;border:1px solid #16a34a">✓ 全部掌握</span>
      <span style="background:hsl(120,75%,88%);border:1px solid #16a34a">轻度</span>
      <span style="background:hsl(60,75%,88%);border:1px solid #d97706">中度</span>
      <span style="background:hsl(0,75%,88%);border:1px solid #dc2626">严重薄弱</span>
      <span style="margin-left:auto">点击色块 = 跳到错题本看详情</span>
    </div>`;
    document.getElementById('kpBody').innerHTML = h;
    document.querySelectorAll('[data-wbkp-board]').forEach(el => {
      el.onclick = () => {
        const b = el.dataset.wbkpBoard;
        const n = el.dataset.wbkpName;
        STATE.data._kp_filter = { board: b, name: n };
        document.querySelector('[data-tab="wrongbook"]').click();
        setTimeout(() => {
          const btn = document.querySelector(`[data-wb="${b}"]`) || document.querySelector('[data-wb="all"]');
          if (btn) btn.click();
        }, 300);
      };
    });
  }

  async function showPlan() {
    const r = await get('/study-plan');
    if (!r.ok) return;
    let h = `<div class="wb-section-title">薄弱知识点 TOP${(r.weak_points||[]).length}（按错题数排）</div>`;
    if (!r.weak_points || !r.weak_points.length) {
      h += `<div class="empty" style="padding:24px"><div class="emoji">✨</div>
        <div>还没错题数据，等孩子做作业后这里会有薄弱点定位</div></div>`;
    } else {
      h += `<div class="plan-weak">`;
      r.weak_points.forEach((w, i) => {
        h += `<div class="plan-weak-card">
          <span class="plan-rank">#${i+1}</span>
          <div>
            <div style="font-weight:700">${esc(w.subject)} · ${esc(w.board_name)} · ${esc(w.knowledge_point)}</div>
            <div style="font-size:12px;color:var(--text-soft)">本学期已错 <b style="color:var(--danger)">${w.cnt}</b> 题</div>
          </div>
          <button class="btn btn-sm" data-plan-go="${esc(w.board_id)}">做几道试试</button>
        </div>`;
      });
      h += `</div>`;
    }

    h += `<div class="wb-section-title">未来 7 天复习计划
      <span class="wb-range">共 ${r.total_pending||0} 道待复习</span></div>`;
    h += `<div class="plan-week">`;
    r.plan.forEach(p => {
      const isToday = p.tip === '今天';
      h += `<div class="plan-day ${isToday?'today':''}">
        <div class="plan-day-head">
          <div>${esc(p.date)}</div>
          <div class="plan-tip">${esc(p.tip)}</div>
        </div>
        ${p.count ? `<div class="plan-count">${p.count} 题</div>
          <ul class="plan-list">
            ${p.items.map(it => `<li>${esc(it.subject)}·${esc(it.board)}<br>
              <span class="plan-item-c">${esc(it.content)}</span>
              ${it.kp ? `<br><span class="plan-item-k">📍 ${esc(it.kp)}</span>` : ''}
            </li>`).join('')}
          </ul>`
          : `<div class="plan-rest">📭 无任务</div>`}
      </div>`;
    });
    h += `</div>`;
    h += `<div class="wb-section-title">📚 学习建议</div>
      <div class="plan-tips">
        <div>• 期末/单元考前 2 周，重点看 <b>薄弱点 TOP 5</b> 里的错题，重做 + 找人讲解</div>
        <div>• <b>今天 3 道题</b>是优先项，做完后第二天会再来一次（间隔重复）</div>
        <div>• 错题答对 4 次后自动从复习列表移除，但仍在错题本可查</div>
        <div>• 每周末花 5 分钟看本周错题分布，识别是否在某个单元反复出错</div>
      </div>`;
    document.getElementById('kpBody').innerHTML = h;
  }

  function bindKpManageEvents() {
    const boards = STATE.data.boards;
    document.querySelectorAll('[data-kpadd]').forEach(btn => {
      btn.onclick = async () => {
        const board = boards.find(b => b.id === btn.dataset.kpadd);
        const name = prompt(`新增${board.track_mode}名称（如：${board.track_mode === '单元' ? '第九单元' : '行程问题'}）`);
        if (!name || !name.trim()) return;
        const r = await post(`/board/${board.id}/knowledge-points`, { name: name.trim() });
        if (r.ok) { toast('已添加'); await loadState(); }
        else toast(r.error || '添加失败');
      };
    });
    document.querySelectorAll('[data-kpdel]').forEach(btn => {
      btn.onclick = async e => {
        e.stopPropagation();
        if (!confirm('确定删除这个知识点/单元？')) return;
        await del(`/knowledge-point/${btn.dataset.kpdel}`);
        await loadState();
        toast('已删除');
      };
    });
  }

  // tab 切换
  const tabs = container.querySelectorAll('.kp-tab');
  tabs.forEach(t => t.onclick = () => {
    tabs.forEach(x => x.classList.remove('on'));
    t.classList.add('on');
    const mode = t.dataset.kpmode;
    if (mode === 'manage') showManage();
    else if (mode === 'heatmap') showHeatmap();
    else if (mode === 'plan') showPlan();
  });

  showManage();
}

/* ---------- 抽屉：板块 ---------- */
function openDrawer() {
  document.getElementById('drawer').classList.add('show');
  document.getElementById('drawerMask').classList.add('show');
}
function closeDrawer() {
  document.getElementById('drawer').classList.remove('show');
  document.getElementById('drawerMask').classList.remove('show');
  CURRENT_BOARD = null;
  CURRENT_CHECKIN = null;
}

async function openBoard(boardId, startCheckin) {
  const b = STATE.data.boards.find(x => x.id === boardId);
  if (!b) return;
  CURRENT_BOARD = b;
  document.getElementById('drawerTitle').textContent = `${b.subject} · ${b.name}`;
  openDrawer();

  if (b.checkin) {
    await loadCheckin(b.checkin.id);
    renderDrawer();
  } else {
    CURRENT_CHECKIN = null;
    renderCheckinForm();
  }
}

async function openCheckin(cid) {
  const d = await get(`/checkin/${cid}`);
  if (!d.ok) return;
  CURRENT_CHECKIN = d.checkin;
  CURRENT_BOARD = d.checkin.board;
  document.getElementById('drawerTitle').textContent =
    `${CURRENT_BOARD.subject} · ${CURRENT_BOARD.name}`;
  openDrawer();
  renderDrawer();
}

function renderCheckinForm() {
  const b = CURRENT_BOARD;
  const kps = STATE.data.knowledge_points[b.id] || [];
  document.getElementById('drawerBody').innerHTML = `
    <div class="section">
      <h3>✅ 今日打卡 <span class="sub">${STATE.date}</span></h3>
      <div class="field">
        <label>完成时长（分钟）</label>
        <input type="number" id="fDuration" placeholder="如 20" min="0" max="600">
      </div>
      <div class="field">
        <label>${b.track_mode}（本次内容）</label>
        <select id="fKp">
          <option value="">未指定</option>
          ${kps.map(k => `<option value="${k.id}">${esc(k.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>备注（可选）</label>
        <textarea id="fNote" placeholder="如：第2课词语，状态不错"></textarea>
      </div>
      <button class="btn btn-primary" id="btnSaveCheckin" style="width:100%">确认打卡</button>
      <p style="font-size:12px;color:var(--text-soft);margin-top:9px;text-align:center">
        打卡后可上传作业照片，系统会自动排队等待识别
      </p>
    </div>`;
  document.getElementById('btnSaveCheckin').onclick = saveCheckin;
}

async function saveCheckin() {
  const b = CURRENT_BOARD;
  const duration = document.getElementById('fDuration').value;
  const kpId = document.getElementById('fKp').value;
  const note = document.getElementById('fNote').value;
  const r = await post('/checkin', {
    board_id: b.id, member_id: STATE.member, date: STATE.date,
    duration_min: duration ? parseInt(duration) : null,
    knowledge_point_id: kpId || null, note,
  });
  if (!r.ok) { toast(r.error || '打卡失败'); return; }
  toast('打卡成功');
  await loadState();
  await loadCheckin(r.checkin_id);
  renderDrawer();
}

async function renderDrawer() {
  const ci = CURRENT_CHECKIN;
  if (!ci) { renderCheckinForm(); return; }
  const b = CURRENT_BOARD;
  const kps = STATE.data.knowledge_points[b.id] || [];
  const latestRun = (ci.runs || [])[0];
  const pendingQ = latestRun ? latestRun.questions.filter(q => q.status === 'pending') : [];
  const hasPendingReview = ci.status === 'pending_review' && pendingQ.length > 0;

  let html = '';

  /* 打卡信息 */
  html += `<div class="section">
    <h3>✅ 今日打卡 <span class="sub">${ci.checkin_date} · ${esc(ci.member?.name || '')}</span></h3>
    <div class="field">
      <label>完成时长（分钟）</label>
      <input type="number" id="dDuration" value="${ci.duration_min ?? ''}" min="0" max="600">
    </div>
    <div class="field">
      <label>${b.track_mode}</label>
      <select id="dKp">
        <option value="">未指定</option>
        ${kps.map(k => `<option value="${k.id}" ${ci.note && ci.note.includes('[' + k.name + ']') ? 'selected' : ''}>${esc(k.name)}</option>`).join('')}
      </select>
    </div>
    <div class="field">
      <label>备注</label>
      <textarea id="dNote">${esc((ci.note || '').replace(/^\[[^\]]*\]\s*/, ''))}</textarea>
    </div>
    <div style="display:flex;gap:7px">
      <button class="btn btn-sm" id="btnUpdateCI">保存修改</button>
      <button class="btn btn-danger btn-sm" id="btnUndoCI">↩ 返回（撤销打卡）</button>
    </div>
  </div>`;

  /* 照片 */
  html += `<div class="section">
    <h3>📷 作业照片 <span class="sub">${ci.photos.length} 张</span></h3>
    <div class="photo-grid">
      ${ci.photos.map(p => `<div class="photo-item">
        <img src="/uploads/${p.filename}" onclick="window.open('/uploads/${p.filename}','_blank')">
        <button class="photo-del" data-photodel="${p.id}">×</button>
      </div>`).join('')}
      <div class="photo-add" id="photoAdd">
        <span class="plus">＋</span><span>拍照上传</span>
      </div>
    </div>
    <input type="file" id="photoInput" accept="image/*" multiple capture="environment" style="display:none">
    <p style="font-size:12px;color:var(--text-soft);margin-top:9px">
      上传后进入「待识别」队列，AI 识别完成会出现在下方错题区等你审核
    </p>
  </div>`;

  /* AI 状态 + 版本 */
  const statusPill = `<span class="status-pill sp-${ci.status}">${STATUS_TEXT[ci.status]}</span>`;
  html += `<div class="section">
    <h3>🤖 识别状态 ${statusPill}</h3>
    ${ci.status === 'pending_ai' ? `<p style="font-size:13px;color:var(--text-soft)">
      已排队，等待 AI 识别。你可以在 WorkBuddy 对话里 @助手 触发识别。</p>` : ''}
    ${ci.status === 'rerun_requested' ? `<p style="font-size:13px;color:var(--danger)">
      已打回，等待重新识别。${latestRun && latestRun.comment ? `<br>你的意见：${esc(latestRun.comment)}` : ''}</p>` : ''}
    ${ci.status === 'transferred' ? `<p style="font-size:13px;color:var(--purple)">已流转，等待对方接手。</p>` : ''}
    <h3 style="margin-top:14px">🗂 版本历史</h3>
    ${(ci.runs || []).length ? ci.runs.map((r, i) => `
      <div class="run-item ${i === 0 ? 'current' : ''}">
        <span class="rv">v${r.version}</span>
        <span class="rmeta">${r.status === 'done' ? `识别完成 · ${r.questions.length} 题 · ${esc(r.operator || '')} · ${r.created_at}` : '等待识别'}</span>
        ${r.summary ? `<div class="rmeta">${esc(r.summary)}</div>` : ''}
        ${r.comment ? `<div class="rmeta" style="color:var(--danger)">打回意见：${esc(r.comment)}</div>` : ''}
      </div>`).join('') : '<p style="font-size:13px;color:var(--text-soft)">暂无识别记录</p>'}
  </div>`;

  /* 错题审核 */
  if (latestRun && latestRun.questions.length) {
    html += `<div class="section">
      <h3>❌ 识别出的错题 <span class="sub">共 ${latestRun.questions.length} 题 · 待审 ${pendingQ.length}</span></h3>
      ${latestRun.questions.map(q => wrongQuestionCard(q)).join('')}
    </div>`;
  } else if (ci.status === 'confirmed') {
    html += `<div class="section"><h3>❌ 错题</h3>
      <p style="font-size:13px;color:var(--text-soft)">本次作业没有错题，或错题已全部处理完毕 🎉</p></div>`;
  }

  /* 操作区 */
  if (hasPendingReview || ci.status === 'pending_review' || ci.status === 'transferred') {
    html += `<div class="section">
      <h3>⚙️ 处理动作</h3>
      ${ci.status === 'transferred' ? `<button class="btn btn-primary" id="btnTakeBack" style="width:100%;margin-bottom:8px">接手处理</button>` : ''}
      ${hasPendingReview ? `<button class="btn btn-success" id="btnFinalize" style="width:100%;margin-bottom:8px"
        ${pendingQ.length ? 'disabled' : ''}>✓ 审核完成并入库${pendingQ.length ? `（还有 ${pendingQ.length} 题未审）` : ''}</button>` : ''}
      <div class="field" style="margin-top:${hasPendingReview ? '4px' : '0'}">
        <label>识别不准确？填写意见后打回重跑</label>
        <textarea id="rerunComment" placeholder="如：第3题其实是对的，AI 误判了；还有第5题漏了"></textarea>
      </div>
      <div style="display:flex;gap:7px;flex-wrap:wrap">
        <button class="btn btn-warn btn-sm" id="btnRerun">🔄 打回重跑</button>
        <button class="btn btn-sm" id="btnTransfer">➡️ 流转给妈妈</button>
        <button class="btn btn-danger btn-sm" id="btnUndoAction" style="margin-left:auto">↩ 撤回最近动作</button>
      </div>
    </div>`;
  }

  /* 时间线 */
  html += `<div class="section">
    <h3>📜 操作记录</h3>
    <div class="timeline">
      ${(ci.actions || []).map(a => `<div class="tl-item">
        <b>${esc(a.actor_id)}</b> ${actionText(a)} <span style="float:right">${a.created_at}</span>
      </div>`).join('') || '<div class="tl-item">暂无记录</div>'}
    </div>
  </div>`;

  /* 历史打卡 */
  const history = await loadBoardHistory(b.id);
  const past = history.filter(h => h.id !== ci.id).slice(0, 10);
  if (past.length) {
    html += `<div class="section">
      <h3>📅 历史打卡</h3>
      ${past.map(h => `<div class="tl-item">
        ${h.checkin_date} · ${h.duration_min ? h.duration_min + '分钟' : '未填时长'} ·
        错题 ${h.wrong_count} 题 ${h.summary ? '· ' + esc(h.summary) : ''}
      </div>`).join('')}
    </div>`;
  }

  document.getElementById('drawerBody').innerHTML = html;
  bindDrawerEvents();
}

function wrongQuestionCard(q) {
  const stateCls = q.status === 'confirmed' ? 'confirmed' : q.status === 'rejected' ? 'rejected' : '';
  const isPending = q.status === 'pending';
  return `<div class="wq-card ${stateCls}" data-q="${q.id}">
    <div class="wq-top">
      <div class="wq-content">${esc(q.content)}</div>
      <span class="tag">${q.reviewed_at ? (q.status === 'confirmed' ? '✓ 已确认' : '✗ 已驳回') : '待审'}</span>
    </div>
    <div class="wq-answers">
      <div>错答：<span class="wrong">${esc(q.student_answer || '—')}</span></div>
      <div>正解：<span class="right">${esc(q.correct_answer || '—')}</span></div>
    </div>
    <div class="wq-tags">
      ${q.error_type ? `<span class="tag">${esc(q.error_type)}</span>` : ''}
      ${q.knowledge_point ? `<span class="tag unit">${esc(q.knowledge_point)}</span>` : ''}
      <span class="tag">置信度 ${Math.round((q.confidence ?? 1) * 100)}%</span>
    </div>
    ${isPending ? `<div class="wq-actions">
      <button class="btn btn-success btn-sm" data-qact="confirm" data-qid="${q.id}">✓ 正确</button>
      <button class="btn btn-danger btn-sm" data-qact="reject" data-qid="${q.id}">✗ 识别有误</button>
    </div>
    <div id="rejectBox-${q.id}" style="display:none;margin-top:8px">
      <textarea id="rejectText-${q.id}" placeholder="说明哪里识别错了" style="width:100%;border:1px solid var(--border);border-radius:8px;padding:7px 10px;font-size:13px;min-height:56px;font-family:inherit"></textarea>
      <button class="btn btn-danger btn-sm" style="margin-top:6px" data-qact="rejectSubmit" data-qid="${q.id}">提交驳回</button>
    </div>` : `<div class="wq-actions" style="margin-top:6px">
      <button class="btn btn-danger btn-sm" data-qact="undoReview" data-qid="${q.id}">↩ 撤回审核</button>
    </div>`}
    ${q.review_comment ? `<div class="wq-comment">💬 ${esc(q.review_comment)}</div>` : ''}
  </div>`;
}

function actionText(a) {
  const map = {
    checkin: '完成打卡',
    ai_result: 'AI 识别完成',
    question_confirm: '确认了一道错题',
    question_reject: '驳回了一道错题',
    request_rerun: '打回要求重跑',
    transfer: '流转任务',
    take_back: '接手任务',
    finalize: '审核完成',
  };
  let t = map[a.action] || a.action;
  if (a.action === 'transfer' && a.to_member_id) t += ` 给 ${a.to_member_id}`;
  if (a.comment) t += `：${esc(a.comment)}`;
  return t;
}

function bindDrawerEvents() {
  const ci = CURRENT_CHECKIN;
  const body = document.getElementById('drawerBody');

  const btnUpdate = document.getElementById('btnUpdateCI');
  if (btnUpdate) btnUpdate.onclick = async () => {
    const kpSel = document.getElementById('dKp');
    const kpName = kpSel && kpSel.selectedOptions[0] && kpSel.value ? kpSel.selectedOptions[0].text : '';
    const note = document.getElementById('dNote').value;
    await fetch(`${API}/checkin/${ci.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        duration_min: document.getElementById('dDuration').value || null,
        note: kpName ? `[${kpName}] ${note}` : note,
      }),
    });
    toast('已保存');
    await loadState();
    await loadCheckin(ci.id);
    renderDrawer();
  };

  const btnUndo = document.getElementById('btnUndoCI');
  if (btnUndo) btnUndo.onclick = () => undoCheckin(ci.board_id, ci.id);

  /* 照片上传 */
  const photoAdd = document.getElementById('photoAdd');
  const photoInput = document.getElementById('photoInput');
  if (photoAdd && photoInput) {
    photoAdd.onclick = () => photoInput.click();
    photoInput.onchange = async () => {
      if (!photoInput.files.length) return;
      const fd = new FormData();
      for (const f of photoInput.files) fd.append('files', f);
      await fetch(`${API}/checkin/${ci.id}/photos`, { method: 'POST', body: fd });
      toast('照片已上传');
      await loadState();
      await loadCheckin(ci.id);
      renderDrawer();
    };
  }
  body.querySelectorAll('[data-photodel]').forEach(btn => {
    btn.onclick = async e => {
      e.stopPropagation();
      if (!confirm('删除这张照片？')) return;
      await del(`/photo/${btn.dataset.photodel}`);
      await loadCheckin(ci.id);
      renderDrawer();
      toast('已删除');
    };
  });

  /* 错题审核 */
  body.querySelectorAll('[data-qact]').forEach(btn => {
    btn.onclick = async () => {
      const qid = btn.dataset.qid;
      const act = btn.dataset.qact;
      if (act === 'confirm') {
        await post(`/question/${qid}/review`, {
          action: 'confirm', member_id: STATE.member,
        });
        toast('已确认');
      } else if (act === 'reject') {
        document.getElementById(`rejectBox-${qid}`).style.display = 'block';
        return;
      } else if (act === 'rejectSubmit') {
        const txt = document.getElementById(`rejectText-${qid}`).value.trim();
        await post(`/question/${qid}/review`, {
          action: 'reject', comment: txt, member_id: STATE.member,
        });
        toast('已驳回');
      } else if (act === 'undoReview') {
        await post(`/question/${qid}/undo-review`, { member_id: STATE.member });
        toast('↩ 已撤回这条审核');
      }
      await loadState();
      await loadCheckin(ci.id);
      renderDrawer();
    };
  });

  /* 审核完成 */
  const btnFinalize = document.getElementById('btnFinalize');
  if (btnFinalize) btnFinalize.onclick = async () => {
    const r = await post(`/checkin/${ci.id}/finalize`, { member_id: STATE.member });
    if (!r.ok) { toast(r.error); return; }
    toast('审核完成，错题已入库');
    await loadState();
    await loadCheckin(ci.id);
    renderDrawer();
  };

  /* 打回重跑 */
  const btnRerun = document.getElementById('btnRerun');
  if (btnRerun) btnRerun.onclick = async () => {
    const c = (document.getElementById('rerunComment').value || '').trim();
    if (!c) { toast('请先填写打回意见'); return; }
    await post(`/checkin/${ci.id}/request-rerun`, { comment: c, member_id: STATE.member });
    toast('已打回，等待重新识别');
    await loadState();
    await loadCheckin(ci.id);
    renderDrawer();
  };

  /* 流转 */
  const btnTransfer = document.getElementById('btnTransfer');
  if (btnTransfer) btnTransfer.onclick = async () => {
    const c = (document.getElementById('rerunComment').value || '').trim();
    await post(`/checkin/${ci.id}/transfer`, {
      to_member_id: 'mom', comment: c, member_id: STATE.member,
    });
    toast('已流转给妈妈');
    await loadState();
    await loadCheckin(ci.id);
    renderDrawer();
  };

  /* 接手 */
  const btnTake = document.getElementById('btnTakeBack');
  if (btnTake) btnTake.onclick = async () => {
    await post(`/checkin/${ci.id}/take-back`, { member_id: STATE.member });
    toast('已接手');
    await loadState();
    await loadCheckin(ci.id);
    renderDrawer();
  };

  /* 撤回最近一个任务级动作 */
  const btnUndoAction = document.getElementById('btnUndoAction');
  if (btnUndoAction) btnUndoAction.onclick = async () => {
    const r = await post(`/checkin/${ci.id}/undo-action`, { member_id: STATE.member });
    if (!r.ok) { toast(r.error || '无法撤回'); return; }
    toast('↩ ' + (r.message || '已撤回'));
    await loadState();
    await loadCheckin(ci.id);
    renderDrawer();
  };
}

async function undoCheckin(boardId, cid) {
  if (!confirm('确定撤销今日打卡？照片和识别记录会一并删除。')) return;
  const target = cid || (STATE.data.boards.find(b => b.id === boardId)?.checkin?.id);
  if (!target) return;
  await del(`/checkin/${target}?member_id=${STATE.member}`);
  toast('已撤销打卡');
  closeDrawer();
  await loadState();
}

/* ---------- 初始化 ---------- */
document.addEventListener('DOMContentLoaded', () => {
  STATE.date = todayStr();
  const dp = document.getElementById('datePicker');
  dp.value = STATE.date;
  dp.onchange = () => { STATE.date = dp.value; loadState(); };

  function shiftDate(delta) {
    const d = new Date(STATE.date);
    d.setDate(d.getDate() + delta);
    const s = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    dp.value = s;
    STATE.date = s;
    loadState();
  }
  document.getElementById('datePrev').onclick = () => shiftDate(-1);
  document.getElementById('dateNext').onclick = () => shiftDate(1);
  document.getElementById('dateToday').onclick = () => {
    dp.value = todayStr();
    STATE.date = todayStr();
    loadState();
  };

  document.querySelectorAll('.tab').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const view = tab.dataset.view;
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      document.getElementById('view-' + view).classList.add('active');
    };
  });

  document.getElementById('drawerClose').onclick = closeDrawer;
  document.getElementById('drawerMask').onclick = closeDrawer;

  // 「同步最新版」按钮：家长触发云端从 GitHub 拉取最新代码并重启
  const syncBtn = document.getElementById('syncBtn');
  if (syncBtn) {
    syncBtn.onclick = async () => {
      if (!confirm('确认从 GitHub 拉取最新代码并重启看板？\n（重启期间约 10 秒不可用，刷新即可）')) return;
      syncBtn.disabled = true;
      syncBtn.textContent = '同步中…';
      try {
        const r = await post('/sync', { member: STATE.member });
        if (r && r.ok) {
          alert('已触发同步，数秒后自动重启，请刷新页面。');
        } else {
          alert('同步失败：' + ((r && r.error) || '未知错误'));
        }
      } catch (e) {
        alert('同步请求异常：' + e);
      } finally {
        syncBtn.disabled = false;
        syncBtn.textContent = '⟳ 同步最新版';
      }
    };
  }

  loadState();
});
