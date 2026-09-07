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
  // 注意：/api/status（GitHub 对齐查询）**不再**默认跑。沙箱到 GitHub 不通，每次 deploy
  // 后首次访问仍要 1.5s（治标已缩短）+ 仍占首屏带宽。只在用户主动点「同步」按钮时才查。
  const [d, v] = await Promise.all([
    get(`/state?date=${STATE.date}&member=${STATE.member}`),
    get('/version').catch(() => ({ ok: false })),
  ]);
  if (d.ok) STATE.data = d;
  if (v.ok && v.version) STATE.version = v.version;
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
  // 仅家长（爸爸/妈妈）可见「同步最新版」「恢复数据」按钮
  const syncBtn = document.getElementById('syncBtn');
  if (syncBtn) syncBtn.style.display = (STATE.member === 'dad' || STATE.member === 'mom') ? '' : 'none';
  const restoreBtn = document.getElementById('restoreBtn');
  if (restoreBtn) restoreBtn.style.display = (STATE.member === 'dad' || STATE.member === 'mom') ? '' : 'none';
  // 显示当前版本号（任何身份）：语义化版本 + commit hash 前缀
  const verEl = document.getElementById('versionInfo');
  if (verEl && STATE.version) {
    const sem = STATE.version.semantic || ('v' + (STATE.version.short || '?'));
    const hash = STATE.version.short ? STATE.version.short.slice(0, 7) : '';
    verEl.textContent = hash ? `${sem} · ${hash}` : sem;
    verEl.title = `commit: ${STATE.version.commit || '?'}\nbranch: ${STATE.version.branch || '?'}\nbuilt: ${STATE.version.built_at || '?'}`;
    verEl.style.display = '';
  }
  renderStatus();
}

function renderStatus() {
  const el = document.getElementById('statusInfo');
  const syncBtn = document.getElementById('syncBtn');
  if (!el || !STATE.status) return;
  const s = STATE.status;
  const cloud = s.cloud && s.cloud.short ? s.cloud.short : '?';
  const github = s.github && s.github.short ? s.github.short : '?';
  if (s.status === 'synced') {
    el.textContent = `已对齐 GitHub=${github}`;
    el.className = 'status-info synced';
  } else if (s.status === 'diverged') {
    if (s.can_sync) {
      el.textContent = `GitHub(${github}) 领先，可同步`;
      el.className = 'status-info diverged';
    } else {
      el.textContent = `GitHub(${github}) 未领先云端(${cloud})`;
      el.className = 'status-info unknown';
    }
  } else {
    el.textContent = '版本状态未知';
    el.className = 'status-info unknown';
  }
  el.style.display = '';
  // sync 按钮：只有 GitHub 领先才可点，否则禁用（防止误操作回退）
  // 必须强制同步 textContent，否则 sync 流程设的「同步中…」会残留
  if (syncBtn) {
    const parentOnly = STATE.member === 'dad' || STATE.member === 'mom';
    const canSync = parentOnly && s.can_sync === true;
    syncBtn.disabled = !canSync;
    syncBtn.textContent = canSync ? '⟳ 同步最新版' : '✓ 已对齐';
    syncBtn.title = canSync ? '从 GitHub 拉取最新代码并重启' : (s.warning || '当前无需同步');
  }
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
  // 作业区：独立于每日打卡，按知识点上传（可滞后补交）
  html += renderHomeworkZone();
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
      const boardId = btn.closest('.board-card')?.dataset.board;
      const act = btn.dataset.act;
      if (act === 'checkin') quickCheckin(boardId);
      else if (act === 'skip') skipBoard(boardId);
      else if (act === 'open') openBoard(boardId);
      else if (act === 'undo') undoCheckin(boardId);
      else if (act === 'review') openBoard(boardId);
      else if (act === 'upload-hw') openHomeworkModal(boardId);
    };
  });
  // 作业列表按钮
  container.querySelectorAll('[data-hw]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const cid = btn.dataset.hw;
      if (btn.dataset.hwAct === 'open') openCheckin(cid);
      else if (btn.dataset.hwAct === 'del') delHomework(cid);
    };
  });
  const hwUploadBtn = container.querySelector('#btnUploadHomework');
  if (hwUploadBtn) hwUploadBtn.onclick = () => openHomeworkModal(null);
}

/* 每日打卡：只记录完成时间，不强制选知识点/照片 */
async function quickCheckin(boardId) {
  const r = await post('/checkin', {
    board_id: boardId, member_id: STATE.member, date: STATE.date,
    entry_type: 'daily', duration_min: null, note: '',
  });
  if (!r.ok) { toast(r.error || '打卡失败'); return; }
  toast('✓ 已完成（' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) + '）');
  await loadState();
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
  const noCheckin = b.no_checkin;

  // ---------- 未打卡 ----------
  if (!ci) {
    return `<div class="board-card" data-board="${b.id}">
      <div class="bc-head">
        <div class="bc-name">${esc(b.name)}</div>
        <div class="bc-tags">${orgTag}${kpTag}</div>
      </div>
      <div class="bc-meta"><span>${noCheckin ? '— 无需打卡 · 直接传作业' : '— 今日未打卡'}</span></div>
      ${noCheckin ? '' : `<div class="bc-actions">
        <button class="btn btn-check" data-act="checkin">☐ 今日完成</button>
        <button class="btn btn-skip btn-sm" data-act="skip">— 今日无任务</button>
      </div>`}
      <div class="bc-actions" style="margin-top:6px">
        <button class="btn btn-sm" data-act="upload-hw" title="创建一条独立作业记录（拍照给 AI 识别错题）。作业与今日打卡互相独立，取消打卡不会删作业">📚 传作业</button>
      </div>
    </div>`;
  }

  const st = ci.status;
  const needAttention = ['pending_review', 'rerun_requested', 'transferred'].includes(st);
  let meta = `<span>✓ ${ci.updated_at ? ci.updated_at.slice(11, 16) : ''}</span>`;
  if (ci.duration_min) meta += `<span>⏱ ${ci.duration_min} 分钟</span>`;
  if (b.photo_count > 0) meta += `<span>📷 ${b.photo_count} 张</span>`;
  if (b.wrong_count > 0) meta += `<span>❌ ${b.wrong_count} 题</span>`;
  if (ci.note && st !== 'skipped') meta += `<span>📝 ${esc(ci.note)}</span>`;

  // ---------- 已打卡：绿勾或灰底"无任务" ----------
  let statusBadge = '';
  let actions = '';
  if (st === 'skipped') {
    statusBadge = `<span class="status-pill sp-skipped">— 今日无任务</span>`;
    actions = `<button class="btn btn-sm" data-act="upload-hw" title="创建一条独立作业记录，与今日打卡互不影响">📚 传作业</button>`
      + `<button class="btn btn-danger btn-sm" data-act="undo">↩ 返回</button>`;
  } else {
    const pill = `<span class="status-pill sp-${st}">${STATUS_TEXT[st] || st}</span>`;
    statusBadge = `<div class="done-row">
      <span class="check-done">✓</span>
      <span>已完成</span>
    </div>`;
    actions = `<button class="btn btn-sm" data-act="open">查看详情</button>`;
    if (needAttention) actions = `<button class="btn btn-warn btn-sm" data-act="review">去处理</button>` + actions;
    actions += `<button class="btn btn-sm" data-act="upload-hw" title="再传一次作业（可反复提交，如单元考考几次）">📚 传作业</button>`;
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

/* ---------- 作业区（独立于每日打卡） ---------- */
function renderHomeworkZone() {
  const hws = STATE.data.homeworks || [];
  const hwMap = {
    pending_ai: '待识别', pending_review: '待审核', rerun_requested: '待重跑',
    confirmed: '已入库', skipped: '已跳过',
  };
  let html = `<div class="subject-group">
    <div class="subject-title" style="margin-top:10px">
      <span class="dot" style="background:#CC6600"></span>📚 作业（按知识点上传 · 可滞后补交）
      <button class="btn btn-sm" id="btnUploadHomework" style="margin-left:auto">＋ 上传作业</button>
    </div>`;

  if (!hws.length) {
    html += `<div class="hw-empty">还没有上传作业。孩子做完交给老师批改后，可在这里按知识点补传作业照片，AI 会自动识别错题。</div>`;
  } else {
    html += `<div class="hw-list">`;
    hws.forEach(h => {
      const st = h.status;
      const pillCls = st === 'confirmed' ? 'sp-confirmed' : st === 'pending_review' ? 'sp-pending_review' : st === 'pending_ai' ? 'sp-pending_ai' : 'sp-rerun_requested';
      html += `<div class="hw-item">
        <div class="hw-item-main">
          <div class="hw-item-title">${esc(h.subject)} · ${esc(h.board_name)}${h.kp_name ? ' · <b>' + esc(h.kp_name) + '</b>' : ''}</div>
          <div class="hw-item-meta">
            <span>📅 ${h.checkin_date}</span>
            <span>📷 ${h.photo_count} 张</span>
            ${h.wrong_count ? `<span>❌ ${h.wrong_count} 题</span>` : ''}
            <span class="status-pill ${pillCls}">${hwMap[st] || st}</span>
          </div>
          ${h.note ? `<div class="hw-item-note">📝 ${esc(h.note)}</div>` : ''}
        </div>
        <div class="hw-item-actions">
          <button class="btn btn-sm" data-hw="${h.id}" data-hw-act="open">查看</button>
          <button class="btn btn-danger btn-sm" data-hw="${h.id}" data-hw-act="del">删除</button>
        </div>
      </div>`;
    });
    html += `</div>`;
  }
  html += `</div>`;
  return html;
}

async function delHomework(cid) {
  if (!confirm('确定删除这条作业记录？照片和识别结果会一并删除。')) return;
  const r = await del(`/checkin/${cid}?member_id=${STATE.member}`);
  if (r.ok) { toast('已删除'); await loadState(); }
  else toast(r.error || '删除失败');
}

/* ---------- 作业上传弹窗 ---------- */
let HW_PHOTOS = [];   // 待上传的 File 列表

// presetKpId：从知识点「作业历史」弹层进来时预选知识点，免得再选一遍
function openHomeworkModal(boardId, presetKpId) {
  HW_PHOTOS = [];
  const boardSel = document.getElementById('hwBoard');
  const kpSel = document.getElementById('hwKp');
  // 板块选项
  const groups = {};
  STATE.data.boards.forEach(b => (groups[b.subject] = groups[b.subject] || []).push(b));
  boardSel.innerHTML = `<option value="">选择板块</option>` + SUBJECT_ORDER.map(sub =>
    groups[sub] ? `<optgroup label="${sub}">${groups[sub].map(b =>
      `<option value="${b.id}" ${b.id === boardId ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</optgroup>` : ''
  ).join('');

  // 知识点联动
  function fillKp(boardId) {
    const b = STATE.data.boards.find(x => x.id === boardId);
    if (!b) { kpSel.innerHTML = '<option value="">未指定</option>'; return; }
    const kps = STATE.data.knowledge_points[b.id] || [];
    const parents = kps.filter(k => !k.parent_id);
    kpSel.innerHTML = `<option value="">未指定</option>` + parents.map(p => {
      const kids = kps.filter(k => k.parent_id === p.id);
      if (!kids.length) return `<option value="${p.id}">${esc(p.name)}</option>`;
      return `<optgroup label="${esc(p.name)}">${kids.map(k =>
        `<option value="${k.id}">${esc(k.name)}</option>`).join('')}</optgroup>`;
    }).join('');
  }
  boardSel.onchange = () => fillKp(boardSel.value);
  fillKp(boardId || boardSel.value);
  // 从知识点作业历史进来：直接预选该知识点（父级「单元」或子级「课文」都已在选项里）
  if (presetKpId) kpSel.value = String(presetKpId);

  // 日期默认今天
  document.getElementById('hwDate').value = STATE.date || todayStr();
  document.getElementById('hwNote').value = '';
  renderHwPhotoPreview();

  document.getElementById('hwModal').classList.add('show');
  document.getElementById('hwModalMask').classList.add('show');
}

function renderHwPhotoPreview() {
  const box = document.getElementById('hwPhotoPreview');
  box.innerHTML = HW_PHOTOS.map((f, i) => `<div class="photo-item">
    <img src="${URL.createObjectURL(f)}">
    <button class="photo-del" data-hwdel="${i}">×</button>
  </div>`).join('');
  box.querySelectorAll('[data-hwdel]').forEach(btn => {
    btn.onclick = () => { HW_PHOTOS.splice(parseInt(btn.dataset.hwdel), 1); renderHwPhotoPreview(); };
  });
}

function closeHomeworkModal() {
  document.getElementById('hwModal').classList.remove('show');
  document.getElementById('hwModalMask').classList.remove('show');
  HW_PHOTOS = [];
}

/* ---------- 知识点作业历史弹层（V1.21）----------
   从知识点全景图的 chip 点进来：看这个知识点下每一次作业。
   同一课可以反复提交（单元考考几次是常态），每次一条记录、各自独立状态。
   状态：待识别 → 待审核 → 已完成；不满意可打回重跑（待重跑）。 */
let KPHW_CTX = null;   // 当前弹层的知识点上下文，供「上传新作业」预填
// V1.22：知识点全景图默认「浏览模式」，不显示任何删除按钮（防误删）；
// 只有点顶部「⚙ 目录管理」进入编辑模式后，才出现新增 / 删除入口。
let KP_EDIT_MODE = false;

async function openKpHwModal(kpIdOrIds) {
  // V1.22：传进来的可能是单个 id，也可能是 "1,2,3"（同一课跨板块聚合）
  const ids = String(kpIdOrIds).split(',').map(s => s.trim()).filter(Boolean);
  const r = ids.length > 1
    ? await get(`/knowledge-points/homeworks?ids=${ids.join(',')}`)
    : await get(`/knowledge-point/${ids[0]}/homeworks`);
  if (!r.ok) { toast(r.error || '加载作业历史失败'); return; }
  const { kp, board, homeworks, kps } = r;

  let head, ctxBoardId, ctxKpId, ctxKpName;
  if (kp) {
    head = [board ? `${esc(board.subject)} · ${esc(board.name)}` : '',
            esc(kp.name)].filter(Boolean).join(' · ');
    ctxBoardId = board ? board.id : null;
    ctxKpId = kp.id;
    ctxKpName = kp.name;
  } else {
    // 聚合视图：这一课在多个板块各有一份，标题只显示课文名
    const first = (kps || [])[0] || {};
    const b0 = (STATE.data.boards || []).find(x => x.id === first.board_id);
    head = [b0 ? esc(b0.subject) : '', esc(first.name || '作业历史')]
      .filter(Boolean).join(' · ');
    ctxBoardId = first.board_id || null;
    ctxKpId = first.id || null;
    ctxKpName = first.name || '';
  }
  KPHW_CTX = {
    kp_id: ctxKpId,
    board_id: ctxBoardId,
    kp_name: ctxKpName,
    board_name: board ? board.name : '',
    // 聚合时记下每个板块对应的知识点，供「上传新作业」精确预选
    options: (kps || []).map(k => ({ kp_id: k.id, board_id: k.board_id })),
  };

  let h = `<div class="kphw-head">
    <div style="font-weight:700;font-size:15px">${head}</div>
    <span class="kphw-count">共 ${homeworks.length} 次作业</span>
  </div>`;

  if (!homeworks.length) {
    h += `<div class="empty" style="padding:26px"><div class="emoji">📭</div>
      <div>这个知识点还没有作业记录</div>
      <div style="font-size:12px;color:var(--text-soft);margin-top:6px">
        点下面「📤 上传新作业」交第一次；同一课考几次就传几次，每次都留痕</div></div>`;
  } else {
    h += homeworks.map(hw => {
      const stText = STATUS_TEXT[hw.status] || hw.status;
      return `<div class="kphw-item">
        <div class="kphw-item-main">
          <div class="kphw-item-date">📅 ${hw.checkin_date}
            ${ids.length > 1 && hw.board_name
              ? `<span class="kphw-type">${esc(hw.board_name)}</span>` : ''}</div>
          <div class="kphw-item-meta">
            <span class="status-pill sp-${hw.status}">${esc(stText)}</span>
            ${hw.photo_count ? `<span>📷 ${hw.photo_count} 张</span>` : ''}
            ${hw.wrong_count ? `<span>❌ ${hw.wrong_count} 题</span>` : ''}
            ${hw.pending_count ? `<span style="color:var(--warn)">⏳ ${hw.pending_count} 题待审</span>` : ''}
            ${hw.note ? `<span>📝 ${esc(hw.note)}</span>` : ''}
          </div>
        </div>
        <div class="kphw-item-acts">
          <button class="btn btn-sm" data-kphw-open="${hw.id}"
            title="打开这次作业：可改照片 / 改错题 / 打回重跑">📂 打开</button>
          <button class="btn btn-danger btn-sm" data-kphw-del="${hw.id}">🗑</button>
        </div>
      </div>`;
    }).join('');
  }

  document.getElementById('kpHwBody').innerHTML = h;
  document.getElementById('kpHwModal').classList.add('show');
  document.getElementById('kpHwMask').classList.add('show');

  document.querySelectorAll('[data-kphw-open]').forEach(btn => {
    btn.onclick = async () => {
      // 先关弹层：否则抽屉被弹层遮住，看起来像"点了没反应"（V1.22）
      closeKpHwModal();
      await openCheckin(parseInt(btn.dataset.kphwOpen));
    };
  });
  document.querySelectorAll('[data-kphw-del]').forEach(btn => {
    btn.onclick = async () => {
      if (!confirm('确定删除这次作业？\n照片和识别结果会一并删除（不可恢复）。')) return;
      const rr = await del(`/checkin/${btn.dataset.kphwDel}?member_id=${STATE.member}&kind=homework`);
      if (!rr.ok) { toast(rr.error || '删除失败'); return; }
      toast('已删除这次作业');
      await loadState();
      await openKpHwModal(kpId);   // 刷新弹层内容
    };
  });
}

function closeKpHwModal() {
  document.getElementById('kpHwModal').classList.remove('show');
  document.getElementById('kpHwMask').classList.remove('show');
}

async function submitHomework() {
  const boardId = document.getElementById('hwBoard').value;
  const kpId = document.getElementById('hwKp').value;
  const date = document.getElementById('hwDate').value;
  const note = document.getElementById('hwNote').value;
  if (!boardId) { toast('请选择板块'); return; }
  if (!date) { toast('请选择完成日期'); return; }

  const r = await post('/checkin', {
    board_id: boardId, member_id: STATE.member, date,
    entry_type: 'homework', knowledge_point_id: kpId || null,
    duration_min: null, note,
  });
  if (!r.ok) { toast(r.error || '创建作业失败'); return; }
  const cid = r.checkin_id;

  // 上传照片（如有）
  if (HW_PHOTOS.length) {
    const fd = new FormData();
    HW_PHOTOS.forEach(f => fd.append('files', f));
    await fetch(`${API}/checkin/${cid}/photos`, { method: 'POST', body: fd });
  }
  closeHomeworkModal();
  toast(HW_PHOTOS.length ? '作业已上传，AI 将识别错题' : '作业已记录');
  await loadState();
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
          <span class="todo-type ${t.entry_type === 'homework' ? 'hw' : 'daily'}">${t.entry_type === 'homework' ? '📚 作业' : '📋 打卡'}</span>
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
      // 防双击：禁用按钮 + 改文字，直到 openCheckin 给出结果
      if (btn.disabled) return;
      btn.disabled = true;
      const orig = btn.textContent;
      btn.textContent = '加载中…';
      try {
        if (btn.dataset.todo === 'take') {
          await post(`/checkin/${cid}/take-back`, { member_id: STATE.member });
          toast('已接手');
        }
        await loadState();
        await openCheckin(cid);
      } finally {
        btn.disabled = false;
        btn.textContent = orig;
      }
    };
  });
}


// 复习板块当前渲染的题目列表缓存（供"🖨 打印这题"按 schedule id 反查完整题目对象）
let REVIEW_ITEMS_CACHE = [];

/* ---------- 打印队列（全局，localStorage 持久化） ---------- */
// 每项结构：{ key, subject, board_name, kp_name, content, correct_answer, student_answer, error_type }
// 同一道题（用 key 去重）加第二次会自动从队列移除（toggle 行为）。
const PRINT_QUEUE_KEY = 'kb_print_queue_v1';
let PRINT_QUEUE = [];
function loadPrintQueue() {
  try {
    const raw = localStorage.getItem(PRINT_QUEUE_KEY);
    PRINT_QUEUE = raw ? JSON.parse(raw) : [];
  } catch (e) { PRINT_QUEUE = []; }
}
function savePrintQueue() {
  try { localStorage.setItem(PRINT_QUEUE_KEY, JSON.stringify(PRINT_QUEUE)); } catch (e) {}
}
function printQueueKeyOf(item) {
  // 复习：schedule_id + wrong_question_id；审核：question id
  return `${item.subject || '?'}#${item.board_name || '?'}#${item.wq_id || item.q_id || ''}`;
}
function addToPrintQueue(item) {
  loadPrintQueue();
  const k = printQueueKeyOf(item);
  const existing = PRINT_QUEUE.findIndex(x => printQueueKeyOf(x) === k);
  if (existing >= 0) {
    PRINT_QUEUE.splice(existing, 1);
    toast('已从打印列表移除');
  } else {
    PRINT_QUEUE.push(item);
    toast(`已加入打印列表（共 ${PRINT_QUEUE.length} 题）`);
  }
  savePrintQueue();
  renderPrintFAB();
}
function renderPrintFAB() {
  const fab = document.getElementById('printFab');
  if (!fab) return;
  const n = PRINT_QUEUE.length;
  fab.style.display = n > 0 ? 'flex' : 'none';
  document.getElementById('printFabCount').textContent = n;
}
function openPrintQueueModal() {
  // 复用 openPrintModal：把队列项作为 qList，按学科自动分组
  if (!PRINT_QUEUE.length) return;
  openPrintModal(PRINT_QUEUE, {
    title: '打印列表 · 按学科分组',
    sub: `共 ${PRINT_QUEUE.length} 题 · 请作答后对照答案批改`,
    groupBySubject: true,
    onClear: () => { PRINT_QUEUE = []; savePrintQueue(); renderPrintFAB(); closePrintModal(); toast('已清空打印列表'); },
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
  // 打印按钮要按 id 反查完整题目对象（content 等），缓存本次渲染的列表
  REVIEW_ITEMS_CACHE = (due || []).concat(done || []);
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
      <button class="btn btn-sm" data-answer="${r.id}" title="展开/收起这题的答案">👁 看答案</button>
      <button class="btn btn-sm" data-printq="${r.id}" data-wq="${r.wrong_question_id}" title="把这题加入「打印列表」。加完可在右下角浮动按钮一键按学科排版打印。同一题再点会从列表移除。">📋 加入打印列表</button>
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

  // 「加入打印列表」（复习板块）：点一下加入队列，再点同一题会从队列移除（toggle）
  document.querySelectorAll('[data-printq]').forEach(btn => {
    btn.onclick = () => {
      const item = REVIEW_ITEMS_CACHE.find(x => String(x.id) === String(btn.dataset.printq));
      if (!item) { toast('找不到这道题，请刷新后重试'); return; }
      addToPrintQueue({
        ...item,
        wq_id: btn.dataset.wq || item.wrong_question_id,
      });
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
    // V1.22 聚合视图：同一篇课文在校内精练/听写/作文等板块各存一份，
    // 这里按「学科 → 单元 → 课文」合并，一课只显示一行，后面挂各作业类型的徽章。
    const boardsById = {};
    boards.forEach(b => boardsById[b.id] = b);
    const hwCount = {};
    (STATE.data.homeworks || []).forEach(hw => {
      if (hw.kp_id) hwCount[hw.kp_id] = (hwCount[hw.kp_id] || 0) + 1;
    });

    const tree = {};   // subject -> unitName -> { lessons: { name: [item...] } }
    Object.entries(STATE.data.knowledge_points || {}).forEach(([bid, list]) => {
      const board = boardsById[bid];
      if (!board) return;
      const subjTree = tree[board.subject] = tree[board.subject] || {};
      const byId = {};
      list.forEach(k => byId[k.id] = k);
      list.forEach(k => {
        const hasChildren = list.some(x => x.parent_id === k.id);
        // 纯容器（有子项的单元）不当作课文，避免出现「单元 → 单元」的自指行
        if (!k.parent_id && hasChildren) return;
        const parent = k.parent_id ? byId[k.parent_id] : null;
        const unitName = parent ? parent.name : k.name;
        const lessonName = k.name;
        const u = subjTree[unitName] = subjTree[unitName] || { lessons: {}, parentIds: {} };
        if (parent) u.parentIds[bid] = parent.id;   // 编辑模式新增时要带父级 id
        const arr = u.lessons[lessonName] = u.lessons[lessonName] || [];
        arr.push({ kpId: k.id, boardId: bid, boardName: board.name,
                   n: hwCount[k.id] || 0 });
      });
    });

    // 目录管理（编辑模式）：只有在这里才允许增删改，防止浏览时误删
    const edit = KP_EDIT_MODE;
    h = `<div class="kp-manage-bar">
      <button class="btn btn-sm ${edit ? 'btn-warn' : ''}" id="btnToggleKpEdit">
        ${edit ? '✓ 完成编辑' : '⚙ 目录管理'}
      </button>
      <span class="kp-manage-tip">${edit
        ? '编辑模式：可新增 / 改名 / 删除知识点。改完记得点「完成编辑」'
        : '浏览模式：点击课文查看作业，点类型徽章只看该类作业'}</span>
    </div>`;

    SUBJECT_ORDER.forEach(sub => {
      const units = tree[sub];
      if (!units) return;
      h += `<div class="subject-group"><div class="subject-title">
        <span class="dot ${SUBJECT_CLASS[sub]}"></span>${sub}</div>`;

      Object.keys(units).forEach(unitName => {
        const lessons = units[unitName].lessons;
        const names = Object.keys(lessons);
        if (!names.length) return;
        // 该单元下全部 kpId（点单元名 = 看整个单元的作业）
        const unitKpIds = [];
        names.forEach(n => lessons[n].forEach(it => unitKpIds.push(it.kpId)));
        const unitTotal = names.reduce(
          (s, n) => s + lessons[n].reduce((t, it) => t + it.n, 0), 0);

        // 扁平学科（数学/英语主题制）：单元下只有一项且同名，直接渲染成一行
        if (names.length === 1 && names[0] === unitName) {
          const items = lessons[names[0]];
          h += `<div class="kp-list" style="margin-bottom:8px">
            <div class="kp-chip kp-clickable" data-kpids="${unitKpIds.join(',')}"
                 title="查看作业历史">${esc(unitName)}${typeBadges(items, edit)}
              ${edit ? delBtn(items[0].kpId) : ''}</div>
            ${edit ? `<button class="kp-add" data-kpadd="${items[0].boardId}">+ 新增</button>` : ''}
          </div>`;
          return;
        }

        h += `<div class="kp-unit" data-unit="${esc(unitName)}" data-subject="${esc(sub)}">
          <div class="kp-unit-head">
            <span class="kp-toggle" title="折叠/展开">▼</span>
            <span class="kp-unit-name kp-clickable" data-kpids="${unitKpIds.join(',')}"
                  title="查看整个单元的作业历史">${esc(unitName)}${unitTotal ? `<span class="kp-hw-badge">📚${unitTotal}</span>` : ''}</span>
            <span class="kp-unit-count">${names.length} 项</span>
          </div>
          <div class="kp-list">
            ${names.map(n => {
              const items = lessons[n];
              const total = items.reduce((s, it) => s + it.n, 0);
              return `<div class="kp-chip kp-clickable" data-kpids="${items.map(it => it.kpId).join(',')}"
                   title="查看这一课的作业历史（可反复提交）">${esc(n)}${total ? `<span class="kp-hw-badge">📚${total}</span>` : ''}${typeBadges(items, edit)}
                ${edit ? delBtn(items[0].kpId) : ''}</div>`;
            }).join('')}
            ${edit ? `<button class="kp-add" data-kpadd="${lessons[names[0]][0].boardId}"
              data-kpparent="${units[unitName].parentIds[lessons[names[0]][0].boardId] || ''}"
              >+ 加一项</button>` : ''}
          </div>
        </div>`;
      });
      h += `</div>`;
    });

    // 类型徽章：一课对应多个板块时，按板块分别显示作业数；
    // 点击某个徽章只看那一类（浏览模式），编辑模式下徽章不可点（避免误触删除）
    function typeBadges(items, editMode) {
      if (items.length <= 1) return '';
      return `<span class="kp-types">${items.map(it =>
        `<span class="kp-type ${it.n ? 'has' : ''} ${editMode ? '' : 'kp-type-click'}"
          ${editMode ? '' : `data-kpids="${it.kpId}"`}
          title="只看「${esc(it.boardName)}」这类作业">${esc(it.boardName)}${it.n ? ' ' + it.n : ''}</span>`
      ).join('')}</span>`;
    }
    function delBtn(kid) {
      return `<button class="del" data-kpdel="${kid}" title="删除">×</button>`;
    }

    document.getElementById('kpBody').innerHTML = h;
    bindKpManageEvents();
    // 点课文 / 单元 / 类型 → 打开作业历史（V1.22 支持多个 kpId 聚合）
    document.querySelectorAll('[data-kpids]').forEach(el => {
      el.onclick = e => {
        e.stopPropagation();
        openKpHwModal(el.dataset.kpids);
      };
    });
    // 单元折叠 / 展开
    document.querySelectorAll('.kp-unit').forEach(unit => {
      const key = `kp-collapsed-${unit.dataset.subject}-${unit.dataset.unit}`;
      if (localStorage.getItem(key) === '1') unit.classList.add('collapsed');
      const toggle = unit.querySelector('.kp-toggle');
      if (toggle) {
        toggle.onclick = e => {
          e.stopPropagation();
          unit.classList.toggle('collapsed');
          localStorage.setItem(key, unit.classList.contains('collapsed') ? '1' : '0');
        };
      }
    });
    const btnEdit = document.getElementById('btnToggleKpEdit');
    if (btnEdit) {
      btnEdit.onclick = () => { KP_EDIT_MODE = !KP_EDIT_MODE; showManage(); };
    }
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
        const parentId = btn.dataset.kpparent || null;
        const isUnitBoard = board.track_mode === '单元';
        const label = parentId ? '课文/活动名称' : (isUnitBoard ? '单元名称' : '知识点名称');
        const example = parentId ? '如：28 蟋蟀的住宅' : (isUnitBoard ? '如：第九单元' : '如：行程问题');
        const name = prompt(`新增${label}（${example}）`);
        if (!name || !name.trim()) return;
        const r = await post(`/board/${board.id}/knowledge-points`, {
          name: name.trim(), parent_id: parentId ? parseInt(parentId) : null,
        });
        if (r.ok) { toast('已添加'); await loadState(); }
        else toast(r.error || '添加失败');
      };
    });
    document.querySelectorAll('[data-kpdel]').forEach(btn => {
      btn.onclick = async e => {
        e.stopPropagation();
        const kid = btn.dataset.kpdel;
        const isUnit = btn.classList.contains('kp-unit-del');
        const msg = isUnit
          ? '确定删除整个单元及其下所有课文/活动？（不影响已打卡记录）'
          : '确定删除这个知识点/课文？';
        if (!confirm(msg)) return;
        const r = await del(`/knowledge-point/${kid}`);
        if (r.ok) { toast('已删除'); await loadState(); }
        else toast(r.error || '删除失败');
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
  if (!d.ok) { toast('加载失败：' + (d.error || '网络异常，请稍后再试')); return false; }
  CURRENT_CHECKIN = d.checkin;
  CURRENT_BOARD = d.checkin.board;
  document.getElementById('drawerTitle').textContent =
    `${CURRENT_BOARD.subject} · ${CURRENT_BOARD.name}`;
  openDrawer();
  // 必须 await：renderDrawer 是 async，不 await 会导致抽屉先开（空内容）、
  // 且调用方无法感知渲染失败 —— 表现为"点了审核没反应"（V1.22 修复）
  try {
    await renderDrawer();
  } catch (e) {
    console.error('renderDrawer 失败', e);
    const body = document.getElementById('drawerBody');
    if (body && !body.innerHTML.trim()) {
      body.innerHTML = `<div class="section"><h3>⚠️ 详情加载失败</h3>
        <p style="font-size:13px;color:var(--text-soft)">${esc(String((e && e.message) || e))}</p></div>`;
    }
    toast('详情加载失败，请刷新重试');
  }
  return true;
}

function renderCheckinForm() {
  const b = CURRENT_BOARD;
  const kps = STATE.data.knowledge_points[b.id] || [];
  const noCheckin = b.no_checkin;

  // 考试/测验类板块：不需要每日打卡，直接引导上传作业/试卷
  if (noCheckin) {
    document.getElementById('drawerBody').innerHTML = `
      <div class="section">
        <h3>📝 ${esc(b.name)} <span class="sub">无需每日打卡</span></h3>
        <p style="font-size:13px;color:var(--text-soft);line-height:1.6">
          「${esc(b.name)}」属于考试/测验类板块，不需要点击「今日完成」。<br>
          有试卷或作业需要批改时，直接点击下方「传作业」拍照上传即可。
        </p>
        <button class="btn btn-primary" id="btnNoCheckinUpload" style="width:100%;margin-top:12px">📚 传作业</button>
      </div>`;
    document.getElementById('btnNoCheckinUpload').onclick = () => openHomeworkModal(b.id);
    return;
  }

  document.getElementById('drawerBody').innerHTML = `
    <div class="section">
      <h3>✅ 今日打卡 <span class="sub">${STATE.date}</span></h3>
      <div class="field">
        <label>完成时长（分钟，可选）</label>
        <input type="number" id="fDuration" placeholder="如 20" min="0" max="600">
      </div>
      <div class="field">
        <label>${b.track_mode}（本次内容，可选）</label>
        ${kpSelectHtml(b, null)}
      </div>
      <div class="field">
        <label>备注（可选）</label>
        <textarea id="fNote" placeholder="如：第2课词语，状态不错"></textarea>
      </div>
      <button class="btn btn-primary" id="btnSaveCheckin" style="width:100%">确认打卡</button>
      <p style="font-size:12px;color:var(--text-soft);margin-top:9px;text-align:center">
        打卡后如需上传作业照片识别错题，请在下方「作业」入口操作
      </p>
    </div>`;
  document.getElementById('btnSaveCheckin').onclick = saveCheckin;
}

/* 两级知识点下拉：父级（单元）→ optgroup，子级（课文）→ option */
function kpSelectHtml(b, selectedKpName, selectId) {
  const kps = STATE.data.knowledge_points[b.id] || [];
  const id = selectId || 'fKp';
  const parents = kps.filter(k => !k.parent_id);
  const childrenOf = pid => kps.filter(k => k.parent_id === pid);
  if (!parents.length) {
    // 扁平板块
    return `<select id="${id}">
      <option value="">未指定</option>
      ${kps.map(k => `<option value="${k.id}" ${selectedKpName && selectedKpName.includes(k.name) ? 'selected' : ''}>${esc(k.name)}</option>`).join('')}
    </select>`;
  }
  // 两级板块
  return `<select id="${id}">
    <option value="">未指定</option>
    ${parents.map(p => {
      const kids = childrenOf(p.id);
      if (!kids.length) return `<option value="${p.id}">${esc(p.name)}</option>`;
      return `<optgroup label="${esc(p.name)}">
        ${kids.map(k => {
          const full = `${p.name}·${k.name}`;
          return `<option value="${k.id}" ${selectedKpName && (selectedKpName === full || selectedKpName.includes(k.name)) ? 'selected' : ''}>${esc(k.name)}</option>`;
        }).join('')}
      </optgroup>`;
    }).join('')}
  </select>`;
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
  const pendingQ = latestRun ? latestRun.questions.filter(q => q.status === 'pending' || q.status === 'rerun_requested') : [];
  const hasPendingReview = (ci.status === 'pending_review' || ci.status === 'rerun_requested') && pendingQ.length > 0;
  const isHomework = ci.entry_type === 'homework';

  let html = '';

  /* 打卡信息 */
  html += `<div class="section">
    <h3>${isHomework ? '📚 作业详情' : '✅ 今日打卡'} <span class="sub">${ci.checkin_date} · ${esc(ci.member?.name || '')}</span></h3>
    ${isHomework ? `<div class="hw-tag">作业可滞后补交 · 按知识点归档</div>` : ''}
    <div class="field">
      <label>完成时长（分钟）</label>
      <input type="number" id="dDuration" value="${ci.duration_min ?? ''}" min="0" max="600">
    </div>
    <div class="field">
      <label>${b.track_mode}</label>
      ${kpSelectHtml(b, ci.kp_name || ci.note, 'dKp')}
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
  // V1.21：打卡与作业解耦 —— 只有作业能挂照片；打卡里的照片是历史遗留（可看可删，不能新增）
  const canAddPhoto = ci.entry_type === 'homework';
  html += `<div class="section">
    <h3>📷 作业照片 <span class="sub">${ci.photos.length} 张</span></h3>
    <div class="photo-grid">
      ${ci.photos.map(p => `<div class="photo-item">
        <img src="${p.url || '/uploads/' + p.filename}" onclick="window.open('${p.url || '/uploads/' + p.filename}','_blank')">
        <button class="photo-del" data-photodel="${p.id}">×</button>
      </div>`).join('')}
      ${canAddPhoto ? `<div class="photo-add" id="photoAdd">
        <span class="plus">＋</span><span>拍照上传</span>
      </div>` : ''}
    </div>
    <input type="file" id="photoInput" accept="image/*" multiple capture="environment" style="display:none">
    <p style="font-size:12px;color:var(--text-soft);margin-top:9px">
      ${canAddPhoto
        ? '上传后进入「待识别」队列，AI 识别完成会出现在下方错题区等你审核'
        : '打卡不再挂照片。下面是历史遗留照片（可查看 / 删除，不能新增）；新作业请去「📚 传作业」'}
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
      <h3>❌ 识别出的错题 <span class="sub">共 ${latestRun.questions.length} 题 · 待审 ${pendingQ.length}</span>
        <button class="btn btn-primary btn-sm" id="btnOpenReviewModal">↔ 分屏审核</button>
      </h3>
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

  /* 历史打卡：占位，等主内容渲染完再异步填充（V1.22 —— 避免网络慢时抽屉空白） */
  html += `<div id="drawerHistorySlot"></div>`;

  document.getElementById('drawerBody').innerHTML = html;
  bindDrawerEvents();
  appendBoardHistory(b.id, ci.id);
}

// 历史打卡异步补：失败也不影响主流程（V1.22）
async function appendBoardHistory(boardId, excludeCid) {
  try {
    const history = await loadBoardHistory(boardId);
    const past = (history || []).filter(h => h.id !== excludeCid).slice(0, 10);
    if (!past.length) return;
    const box = document.getElementById('drawerHistorySlot');
    if (!box) return;
    box.innerHTML = `<div class="section">
      <h3>📅 历史打卡</h3>
      ${past.map(h => `<div class="tl-item">
        ${h.checkin_date} · ${h.duration_min ? h.duration_min + '分钟' : '未填时长'} ·
        错题 ${h.wrong_count} 题 ${h.summary ? '· ' + esc(h.summary) : ''}
      </div>`).join('')}
    </div>`;
  } catch (e) {
    console.warn('历史打卡加载失败（不影响主流程）', e);
  }
}

function wrongQuestionCard(q) {
  const stateCls = q.status === 'confirmed' ? 'confirmed' : q.status === 'rejected' ? 'rejected' : q.status === 'rerun_requested' ? 'rerun' : '';
  const stateText = q.status === 'confirmed' ? '✓ 已确认' : q.status === 'rejected' ? '✗ 已驳回' : q.status === 'rerun_requested' ? '🔄 待重新识别' : '待审';
  const isPending = q.status === 'pending' || q.status === 'rerun_requested';
  return `<div class="wq-card ${stateCls}" data-q="${q.id}">
    <div class="wq-top">
      <div class="wq-content">${esc(q.content)}</div>
      <span class="tag">${stateText}</span>
    </div>
    <div class="wq-answers">
      <div>正解：<span class="right">${esc(q.correct_answer || '—')}</span></div>
      ${q.student_answer ? `<div>错答：<span class="wrong">${esc(q.student_answer)}</span></div>` : ''}
    </div>
    <div class="wq-tags">
      ${q.error_type ? `<span class="tag">${esc(q.error_type)}</span>` : ''}
      ${q.knowledge_point ? `<span class="tag unit">${esc(q.knowledge_point)}</span>` : ''}
      <span class="tag">置信度 ${Math.round((q.confidence ?? 1) * 100)}%</span>
    </div>
    ${isPending ? `<div class="wq-actions">
      <button class="btn btn-success btn-sm" data-qact="confirm" data-qid="${q.id}">✓ 正确</button>
      <button class="btn btn-danger btn-sm" data-qact="reject" data-qid="${q.id}">✗ 识别有误</button>
      <button class="btn btn-sm" data-qact="rerun" data-qid="${q.id}">🔄 重新识别</button>
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

  const btnOpenReview = document.getElementById('btnOpenReviewModal');
  if (btnOpenReview) btnOpenReview.onclick = (e) => {
    e.stopPropagation();
    e.preventDefault();
    const realCi = CURRENT_CHECKIN;
    if (!realCi) { toast('请先打开某次打卡详情'); return; }
    const run = (realCi.runs || [])[0];
    if (!run || !run.questions || !run.questions.length) {
      toast('暂无识别结果，无可审核内容');
      return;
    }
    openReviewModal(realCi);
  };

  const btnUpdate = document.getElementById('btnUpdateCI');
  if (btnUpdate) btnUpdate.onclick = async () => {
    const kpSel = document.getElementById('dKp');
    const kpId = kpSel && kpSel.value ? parseInt(kpSel.value) : null;
    const note = document.getElementById('dNote').value;
    await fetch(`${API}/checkin/${ci.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        duration_min: document.getElementById('dDuration').value || null,
        note, kp_id: kpId,
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
      } else if (act === 'rerun') {
        const txt = prompt('请说明需要重新识别的点（可选）：');
        if (txt === null) return;
        await post(`/question/${qid}/request-rerun`, { comment: txt, member_id: STATE.member });
        toast('🔄 已请求重新识别');
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
  // V1.21：打卡与作业彻底解耦，两者后果完全不同，文案必须说清
  //   daily    取消 = 只取消今日完成标记，照片 / 错题 / AI 识别 **一个都不删**
  //   homework 删除 = 完整清理这一次作业（照片 / 错题 / 识别）
  let entryType = 'daily';   // 兜底：旧调用场景默认视为 daily
  if (cid && CURRENT_CHECKIN && CURRENT_CHECKIN.id === cid) {
    entryType = CURRENT_CHECKIN.entry_type || 'daily';
  } else if (!cid) {
    // 从卡片撤：STATE.data.boards[].checkin 必是 daily
    entryType = 'daily';
  }
  const msg = entryType === 'homework'
    ? '确定删除这条作业记录？\n照片和识别结果会一并删除（不可恢复）。'
    : '确定取消今日打卡？\n不会删除任何照片或识别记录，作业也不受影响。';
  if (!confirm(msg)) return;
  const target = cid || (STATE.data.boards.find(b => b.id === boardId)?.checkin?.id);
  if (!target) return;
  const r = await del(`/checkin/${target}?member_id=${STATE.member}&kind=${entryType}`);
  if (r.ok) {
    toast(entryType === 'homework'
      ? '已删除这次作业'
      : '已取消打卡（照片和识别记录均已保留）');
    closeDrawer();
    await loadState();
  } else {
    toast(r.error || '操作失败');
  }
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

  // 打印列表浮动按钮：从 localStorage 恢复 + 渲染 + 绑定点击
  loadPrintQueue();
  renderPrintFAB();
  const printFab = document.getElementById('printFab');
  if (printFab) printFab.onclick = openPrintQueueModal;

  // 作业上传弹窗
  const hwModalMask = document.getElementById('hwModalMask');
  const hwModal = document.getElementById('hwModal');
  if (hwModalMask && hwModal) {
    document.getElementById('btnCloseHwModal').onclick = closeHomeworkModal;
    document.getElementById('btnCancelHw').onclick = closeHomeworkModal;
    hwModalMask.onclick = closeHomeworkModal;
    document.getElementById('btnSubmitHw').onclick = submitHomework;
    document.getElementById('btnHwPickPhoto').onclick = () => document.getElementById('hwPhotoInput').click();
    document.getElementById('hwPhotoInput').onchange = e => {
      for (const f of e.target.files) HW_PHOTOS.push(f);
      renderHwPhotoPreview();
      e.target.value = '';
    };
  }

  // 知识点作业历史弹层（V1.21）
  const kpHwMask = document.getElementById('kpHwMask');
  const kpHwModal = document.getElementById('kpHwModal');
  if (kpHwMask && kpHwModal) {
    document.getElementById('btnCloseKpHw').onclick = closeKpHwModal;
    document.getElementById('btnCloseKpHw2').onclick = closeKpHwModal;
    kpHwMask.onclick = closeKpHwModal;
    // 「上传新作业」：关掉历史弹层，打开上传弹窗并预选当前知识点
    document.getElementById('btnKpHwUpload').onclick = () => {
      if (!KPHW_CTX) return;
      closeKpHwModal();
      openHomeworkModal(KPHW_CTX.board_id, KPHW_CTX.kp_id);
    };
  }

  // 「同步最新版」按钮：家长触发云端从 GitHub 拉取最新代码并重启
  const syncBtn = document.getElementById('syncBtn');
  if (syncBtn) {
    syncBtn.onclick = async () => {
      // 先拉一次最新状态，用于显示提示，但不阻止同步（后端会直接拉 GitHub）
      const s = await get('/status').catch(() => ({ ok: false }));
      if (s && s.ok) {
        STATE.status = s;
        renderStatus();
        if (s.status === 'synced') {
          toast('✓ 当前云端版本已和 GitHub 对齐，无需同步');
          return;
        }
        if (!s.can_sync) {
          toast('⚠ 同步被阻止：' + (s.warning || '无法同步'));
          return;
        }
        if (s.status === 'unknown') {
          toast('⟳ GitHub 状态暂时获取不到，将直接尝试拉取…');
        }
      }
      if (!confirm('确认从 GitHub 拉取最新代码并重启看板？\n（重启期间约 10–30 秒不可用，刷新即可）')) return;
      syncBtn.disabled = true;
      syncBtn.textContent = '同步中…';
      try {
        const r = await post('/sync', { member: STATE.member });
        if (r && r.ok) {
          toast('已触发同步，后台拉取最新代码并重启…');
          pollVersion(r.old_version || null);
        } else {
          // 后端主线程守门拒绝（如 GitHub 未领先 / 已对齐）→ 立刻提示并恢复按钮
          syncBtn.disabled = false;
          syncBtn.textContent = '⟳ 同步最新版';
          toast('⚠ 同步被阻止：' + ((r && r.error) || '未知错误'));
        }
      } catch (e) {
        syncBtn.disabled = false;
        syncBtn.textContent = '⟳ 同步最新版';
        toast('同步请求异常：' + e);
      }
    };
  }

  // 「恢复数据」按钮：家长从备份 zip 恢复云端 instance/ 数据
  const restoreBtn = document.getElementById('restoreBtn');
  const restoreFile = document.getElementById('restoreFile');
  if (restoreBtn && restoreFile) {
    restoreBtn.onclick = () => {
      if (!confirm('此操作会用上传的备份 zip 覆盖云端所有照片和数据库。\n请先确认 zip 是正确的看板备份。继续？')) return;
      restoreFile.click();
    };
    restoreFile.onchange = async () => {
      const file = restoreFile.files[0];
      if (!file) return;
      if (!file.name.toLowerCase().endsWith('.zip')) {
        alert('只接受 .zip 备份文件');
        return;
      }
      restoreBtn.disabled = true;
      restoreBtn.textContent = '恢复中…';
      const form = new FormData();
      form.append('file', file);
      try {
        const r = await fetch('/api/restore?member=' + encodeURIComponent(STATE.member), {
          method: 'POST',
          body: form,
        });
        const data = await r.json().catch(() => ({}));
        if (data && data.ok) {
          alert('数据恢复已触发，服务正在重启。\n约 10–30 秒后刷新页面，检查照片是否回来。');
        } else {
          alert('恢复失败：' + ((data && data.error) || '未知错误'));
          restoreBtn.disabled = false;
          restoreBtn.textContent = '⬆ 恢复数据';
        }
      } catch (e) {
        alert('恢复请求异常：' + e);
        restoreBtn.disabled = false;
        restoreBtn.textContent = '⬆ 恢复数据';
      }
    };
  }

  async function pollVersion(oldVersion) {
    const oldCommit = oldVersion && oldVersion.commit ? oldVersion.commit : null;
    let attempts = 0;
    const maxAttempts = 40; // 最多 40 次 × 3 秒 ≈ 2 分钟
    const interval = setInterval(async () => {
      attempts++;
      const syncBtn = document.getElementById('syncBtn');
      try {
        const s = await get('/status');
        if (s && s.ok) {
          STATE.status = s;
          renderStatus();
          const cloudCommit = s.cloud && s.cloud.commit ? s.cloud.commit : null;

          // 云端已和 GitHub 对齐
          if (s.status === 'synced') {
            clearInterval(interval);
            if (syncBtn) {
              syncBtn.disabled = false;
              syncBtn.textContent = '⟳ 同步最新版';
            }
            // 如果对齐后的版本和触发同步前一样，说明本来就已经是最新版
            if (oldCommit && cloudCommit && cloudCommit === oldCommit) {
              toast('✓ 当前云端版本已和 GitHub 对齐，无需同步');
            } else if (confirm('看板已更新到新版（' + (s.cloud && s.cloud.short || '?') + '），立即刷新？')) {
              location.reload();
            }
            return;
          }

          // 云端版本发生变化但仍未对齐 GitHub：可能是 GitHub 没有更新
          if (oldCommit && cloudCommit && cloudCommit !== oldCommit) {
            clearInterval(interval);
            if (syncBtn) {
              syncBtn.disabled = false;
              syncBtn.textContent = '⟳ 同步最新版';
            }
            alert('云端已重启，但版本与 GitHub 仍未对齐：\n云端 ' + (s.cloud && s.cloud.short || '?') + ' / GitHub ' + (s.github && s.github.short || '?') + '\n请检查 GitHub 是否已 push 最新代码。');
            return;
          }
        }
      } catch (e) {
        // 服务重启中，忽略
      }
      if (attempts >= maxAttempts) {
        clearInterval(interval);
        if (syncBtn) {
          syncBtn.disabled = false;
          syncBtn.textContent = '⟳ 同步最新版';
        }
        alert('同步等待超时。可能的原因：\n1. 服务仍在重启，请过 30 秒手动刷新页面；\n2. GitHub 版本未 push；\n3. 若刷新后顶栏显示“已对齐”，则同步实际已成功。');
      }
    }, 3000);
  }

  loadState();
});

/* ---------- 左右分屏错题审核弹窗 ---------- */
let REVIEW_MODAL_DATA = null; // { checkin, questions }
const RQE_UNDO = new Map();   // idx -> UndoManager

class UndoManager {
  constructor(el, max = 50) {
    this.el = el;
    this.stack = [];
    this.idx = -1;
    this.max = max;
    this._lock = false;
    this.save(true);
    el.addEventListener('input', () => this.save());
    el.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.shiftKey ? this.redo() : this.undo();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        this.redo();
      }
    });
  }
  save(force) {
    if (this._lock) return;
    const v = this.el.value;
    if (!force && this.idx >= 0 && this.stack[this.idx] === v) return;
    this.stack = this.stack.slice(0, this.idx + 1);
    this.stack.push(v);
    if (this.stack.length > this.max) this.stack.shift();
    this.idx = this.stack.length - 1;
  }
  undo() {
    if (this.idx > 0) { this.idx--; this._set(); }
  }
  redo() {
    if (this.idx < this.stack.length - 1) { this.idx++; this._set(); }
  }
  _set() {
    this._lock = true;
    this.el.value = this.stack[this.idx];
    this._lock = false;
  }
}

function openReviewModal(ci) {
  try {
    REVIEW_MODAL_DATA = { checkin: ci, questions: JSON.parse(JSON.stringify((ci.runs || [])[0]?.questions || [])) };
    RQE_UNDO.clear();
    renderReviewModal();
    // 关掉抽屉遮罩避免挡住 review-modal（drawer 本身保留，关闭 reviewModal 时无需恢复）
    const drawerMask = document.getElementById('drawerMask');
    if (drawerMask) drawerMask.style.pointerEvents = 'none';
    document.getElementById('reviewModalMask').classList.add('show');
    document.getElementById('reviewModal').classList.add('show');
  } catch (e) {
    console.error('[review-modal] open failed:', e);
    toast('打开分屏审核失败：' + (e.message || e));
  }
}

function closeReviewModal() {
  document.getElementById('reviewModalMask').classList.remove('show');
  document.getElementById('reviewModal').classList.remove('show');
  // 恢复抽屉遮罩
  const drawerMask = document.getElementById('drawerMask');
  if (drawerMask) drawerMask.style.pointerEvents = '';
  REVIEW_MODAL_DATA = null;
  RQE_UNDO.clear();
}

function renderReviewModal() {
  const { checkin, questions } = REVIEW_MODAL_DATA;
  const board = CURRENT_BOARD;
  const pending = questions.filter(q => q.status === 'pending' || q.status === 'rerun_requested').length;

  document.getElementById('reviewModalSubject').textContent = board?.subject || '科目';
  document.getElementById('reviewModalBoard').textContent = board?.name || '板块';
  document.getElementById('reviewModalMeta').textContent =
    `${checkin.checkin_date} · ${checkin.photos.length} 张照片 · ${questions.length} 题 · 待审/待重识别 ${pending} 题`;

  // 左侧照片区
  const left = document.getElementById('reviewModalLeft');
  left.innerHTML = checkin.photos.length
    ? checkin.photos.map((p, i) => `
        <div class="photo-page">
          <img src="${p.url || '/uploads/' + p.filename}" alt="作业照片 ${i + 1}">
          <div class="photo-page-num">照片 ${i + 1} / ${checkin.photos.length}</div>
        </div>`).join('')
    : '<p style="color:var(--text-soft);text-align:center">没有照片</p>';

  // 右侧错题编辑区
  const right = document.getElementById('reviewModalRight');
  if (!questions.length) {
    right.innerHTML = '<p style="color:var(--text-soft)">没有识别出错题</p>';
    return;
  }

  let html = `<div class="rqe-print-hint">
    💡 <b>使用提示</b>：左侧看原图，右侧改识别结果。「题目原文」必须从照片中原样提取印刷字，不要改写；「正确答案」可由 AI 给出候选，家长选择或手动修改；「学生当时写的答案」可选填。
  </div>`;

  questions.forEach((q, idx) => {
    const stateCls = q.status === 'confirmed' ? 'confirmed' : q.status === 'rejected' ? 'rejected' : q.status === 'rerun_requested' ? 'rerun' : '';
    const stateText = q.status === 'confirmed' ? '✓ 已确认' : q.status === 'rejected' ? '✗ 已驳回' : q.status === 'rerun_requested' ? '🔄 待重新识别' : '待审';
    const candidates = q.answer_candidates || [];
    html += `<div class="review-question-edit ${stateCls}" data-qidx="${idx}">
      <div class="rqe-header">
        <div><span class="rqe-num">${idx + 1}</span> <span class="rqe-status">${stateText}</span></div>
        <button class="btn btn-sm" data-ract="printSingle" data-qidx="${idx}" title="把这题加入「打印列表」（右下角浮动按钮一键按学科排版打印）。同一题再点会从列表移除。">📋 加入打印列表</button>
      </div>
      <div class="rqe-field">
        <label>题目原文（必须从照片中原样提取印刷体，不要改写）<span class="tip">可编辑 · Ctrl+Z 撤销</span></label>
        <textarea id="rqe-content-${idx}">${esc(q.content)}</textarea>
      </div>
      <div class="rqe-field rqe-optional">
        <label>学生当时写的答案 <span class="tip">可选，用于了解孩子错在哪里</span></label>
        <textarea id="rqe-stu-${idx}">${esc(q.student_answer || '')}</textarea>
      </div>
      <div class="rqe-field">
        <label>正确答案 <span class="tip">下方有 AI 候选，可选择或手动修改</span></label>
        ${renderAnswerCandidates(idx, candidates)}
        <textarea id="rqe-ans-${idx}">${esc(q.correct_answer || '')}</textarea>
      </div>
      <div class="rqe-row">
        <div class="rqe-field">
          <label>错误类型</label>
          <input type="text" id="rqe-type-${idx}" value="${esc(q.error_type || '')}">
        </div>
        <div class="rqe-field">
          <label>知识点</label>
          <input type="text" id="rqe-kp-${idx}" value="${esc(q.knowledge_point || '')}">
        </div>
      </div>
      <div class="rqe-actions">
        <button class="btn btn-primary" data-ract="save" data-qidx="${idx}" title="只保存你手动改的文字，不改变题的状态（仍是待审）">💾 保存修改</button>
        <button class="btn btn-success" data-ract="confirm" data-qidx="${idx}" title="确认这题是对的（不改 AI 识别结果，或保存你改完的结果），确认后进入错题本并安排复习">✓ 确认错题</button>
        <button class="btn btn-danger" data-ract="reject" data-qidx="${idx}" title="标记这题识别错误（不会让 AI 重跑，由你自己手动改题）。适合「AI 识别错了但我不想再花积分调 AI」">✗ 识别有误</button>
        <button class="btn btn-sm" data-ract="rerun" data-qidx="${idx}" title="让 AI 重新看照片识别这题（会进入待重识别队列，等外部 AI 回填）。单题漏识别用这个，整批漏题请用顶部「🔄 全部重新识别」">🔄 重新识别</button>
        <button class="btn btn-sm" data-ract="blank" data-qidx="${idx}" title="OCR 输出常带括号答案（如「潮来时的情景」），此按钮一键把答案与学生作答处替换为 ______，方便打印给孩子重做。手动改具体文字请直接编辑「题目原文」框">⬜ 一键整理为印刷体</button>
      </div>
      ${q.review_comment ? `<div class="wq-comment">💬 ${esc(q.review_comment)}</div>` : ''}
    </div>`;
  });

  right.innerHTML = html;

  // 绑定 UndoManager 到每个 textarea
  questions.forEach((q, idx) => {
    ['content', 'stu', 'ans'].forEach(suffix => {
      const el = document.getElementById(`rqe-${suffix}-${idx}`);
      if (el) RQE_UNDO.set(`${idx}-${suffix}`, new UndoManager(el));
    });
  });

  // 绑定候选答案 radio：选中后回填到正确答案框
  right.querySelectorAll('input[name^="rqe-cand-"]').forEach(radio => {
    radio.onchange = () => {
      const idx = parseInt(radio.dataset.qidx);
      const value = radio.value;
      const ansEl = document.getElementById(`rqe-ans-${idx}`);
      const q = questions[idx];
      const candidates = q.answer_candidates || [];
      if (value === 'custom') return;
      const c = candidates[parseInt(value)];
      if (c && c.answer != null) ansEl.value = c.answer;
    };
  });

  // 绑定操作按钮
  right.querySelectorAll('[data-ract]').forEach(btn => {
    btn.onclick = () => handleReviewModalAction(btn.dataset.ract, parseInt(btn.dataset.qidx));
  });

  // 顶部按钮
  document.getElementById('btnPrintPreview').onclick = () => openPrintModal(questions);
  document.getElementById('btnCloseReviewModal').onclick = closeReviewModal;
  document.getElementById('reviewModalMask').onclick = closeReviewModal;

  // 整批打回重识别：AI 漏题时用（单题打回不够）
  // ——用内联表单代替 window.prompt()，保证左侧照片永远可见，方便对照原图写意见
  const btnRerunAll = document.getElementById('btnRerunAll');
  const rerunBox = document.getElementById('rerunAllBox');
  if (btnRerunAll && rerunBox) {
    btnRerunAll.onclick = () => {
      // 切换显示：第一次点显示，再次点收起
      rerunBox.classList.toggle('show');
      if (rerunBox.classList.contains('show')) {
        const ta = document.getElementById('rerunAllComment');
        if (ta) { ta.value = ''; ta.focus(); }
        btnRerunAll.textContent = '🔄 收起整批打回';
      } else {
        btnRerunAll.textContent = '🔄 全部重新识别';
      }
    };
    document.getElementById('rerunAllCancel').onclick = () => {
      rerunBox.classList.remove('show');
      btnRerunAll.textContent = '🔄 全部重新识别';
    };
    document.getElementById('rerunAllConfirm').onclick = async () => {
      const c = (document.getElementById('rerunAllComment').value || '').trim();
      if (!confirm(
        `将把这份作业的 ${questions.length} 题全部打回，让 AI 重新识别。\n\n` +
        '· 当前这一版的审核结果会归档为历史版本，不会丢\n' +
        '· AI 重跑后题目回到「待审」，需要你重新过一遍\n\n' +
        '确定打回吗？'
      )) return;
      const r = await post(`/checkin/${checkin.id}/request-rerun`, { comment: c, member_id: STATE.member });
      if (!r.ok) { toast('打回失败：' + (r.error || '未知')); return; }
      toast(`🔄 已打回为第 ${r.version} 版，等待 AI 重新识别`);
      closeReviewModal();
      await loadState();
      // 抽屉里的数据要跟着刷新，否则看到的还是旧题
      const d = await get(`/checkin/${checkin.id}`);
      if (d.ok) { CURRENT_CHECKIN = d.checkin; renderDrawer(); }
    };
  }
}

function renderAnswerCandidates(idx, candidates) {
  // 兜底：万一 candidates 是字符串/对象（历史脏数据）也不会崩
  if (!Array.isArray(candidates) || !candidates.length) return '';
  const safe = arr => arr.map(c => esc(String(c.answer || ''))).filter(Boolean);
  const vals = safe(candidates);
  if (!vals.length) return '';
  let html = `<div class="rqe-candidates">`;
  candidates.forEach((c, i) => {
    const label = c.source === 'web' ? '网络搜索答案' : (c.source === 'ai' ? 'AI 识别答案' : `候选 ${i + 1}`);
    html += `<label class="rqe-candidate">
      <input type="radio" name="rqe-cand-${idx}" value="${i}" data-qidx="${idx}">
      <span><b>${esc(label)}</b>：${esc(String(c.answer || ''))}</span>
    </label>`;
  });
  html += `<label class="rqe-candidate">
    <input type="radio" name="rqe-cand-${idx}" value="custom" data-qidx="${idx}" checked>
    <span><b>手动输入</b></span>
  </label></div>`;
  return html;
}

function getQuestionFormData(idx) {
  const q = REVIEW_MODAL_DATA.questions[idx];
  return {
    content: document.getElementById(`rqe-content-${idx}`).value.trim(),
    student_answer: document.getElementById(`rqe-stu-${idx}`).value.trim(),
    correct_answer: document.getElementById(`rqe-ans-${idx}`).value.trim(),
    error_type: document.getElementById(`rqe-type-${idx}`).value.trim(),
    knowledge_point: document.getElementById(`rqe-kp-${idx}`).value.trim(),
    answer_candidates: q.answer_candidates || [],
  };
}

async function handleReviewModalAction(act, idx) {
  const { checkin, questions } = REVIEW_MODAL_DATA;
  const q = questions[idx];

  if (act === 'save') {
    const payload = getQuestionFormData(idx);
    const r = await post(`/question/${q.id}/update`, { ...payload, member_id: STATE.member });
    if (!r.ok) { toast('保存失败：' + (r.error || '未知')); return; }
    Object.assign(q, payload);
    toast('✓ 已保存');
    await loadState();
    await loadCheckin(checkin.id);
    renderDrawer();
    return;
  }

  if (act === 'confirm') {
    await post(`/question/${q.id}/update`, { ...getQuestionFormData(idx), member_id: STATE.member });
    const r = await post(`/question/${q.id}/review`, { action: 'confirm', member_id: STATE.member });
    if (!r.ok) { toast('确认失败：' + (r.error || '未知')); return; }
    q.status = 'confirmed';
    toast('✓ 已确认');
    await loadState();
    await loadCheckin(checkin.id);
    renderReviewModal();
    renderDrawer();
    return;
  }

  if (act === 'reject') {
    const comment = prompt('请说明哪里识别错了（会记录并打回给 AI 重跑）：');
    if (comment === null) return;
    await post(`/question/${q.id}/update`, { ...getQuestionFormData(idx), member_id: STATE.member });
    const r = await post(`/question/${q.id}/review`, { action: 'reject', comment, member_id: STATE.member });
    if (!r.ok) { toast('驳回失败：' + (r.error || '未知')); return; }
    q.status = 'rejected';
    q.review_comment = comment;
    toast('✗ 已驳回');
    await loadState();
    await loadCheckin(checkin.id);
    renderReviewModal();
    renderDrawer();
    return;
  }

  if (act === 'rerun') {
    const comment = prompt('请说明需要重新识别的点（可选）：');
    if (comment === null) return;
    const r = await post(`/question/${q.id}/request-rerun`, { comment, member_id: STATE.member });
    if (!r.ok) { toast('请求重新识别失败：' + (r.error || '未知')); return; }
    q.status = 'rerun_requested';
    q.review_comment = comment || '已请求重新识别';
    toast('🔄 已请求重新识别，AI 处理后会更新');
    await loadState();
    await loadCheckin(checkin.id);
    renderReviewModal();
    renderDrawer();
    return;
  }

  if (act === 'blank') {
    // 一键整理为印刷体：把正确答案/学生答案从题目中移除，替换为下划线空白
    const contentEl = document.getElementById(`rqe-content-${idx}`);
    const ans = document.getElementById(`rqe-ans-${idx}`).value.trim();
    const stu = document.getElementById(`rqe-stu-${idx}`).value.trim();
    let content = contentEl.value;
    if (ans) content = content.split(ans).join('________');
    if (stu && stu !== ans) content = content.split(stu).join('________');
    // 兜底：把常见手写答案格式（括号内内容）也清空
    content = content.replace(/（[^）]{1,20}）/g, '（________）');
    content = content.replace(/\([^)]{1,20}\)/g, '(________)');
    contentEl.value = content;
    RQE_UNDO.get(`${idx}-content`)?.save();
    toast('已把答案处替换为空白，请再检查题目是否通顺');
    return;
  }

  if (act === 'printSingle') {
    const b = CURRENT_BOARD;
    addToPrintQueue({
      q_id: q.id,
      subject: b?.subject || '',
      board_name: b?.name || '',
      kp_name: q.knowledge_point || '',
      content: q.content,
      correct_answer: q.correct_answer,
      student_answer: q.student_answer,
      error_type: q.error_type,
    });
  }
}

/* ---------- 打印版预览 ---------- */
function openPrintModal(qList, opts) {
  opts = opts || {};
  // 注意：REVIEW_MODAL_DATA 只在分屏审核打开时才有。复习板块调本函数时它是 null，
  // 所以标题/副标题允许调用方自定义（opts.title / opts.sub），否则会套用上一次审核的板块名。
  const { checkin } = REVIEW_MODAL_DATA || { checkin: { checkin_date: '' } };
  const board = CURRENT_BOARD;
  const title = opts.title
    || `${board?.subject || ''} · ${board?.name || '错题'} 打印版`;
  const sub = opts.sub
    || `${esc(checkin.checkin_date || '')} · 共 ${qList.length} 题 · 请作答后对照答案批改`;
  let html = `<div class="print-sheet-title">${esc(title)}</div>
    <div class="print-sheet-sub">${sub}</div>`;

  // 按学科分组（自动排版）：相同 subject 合并、学科内部按 board_name 排序、题号连续
  if (opts.groupBySubject) {
    const groups = {};
    qList.forEach((q, i) => {
      const sub = q.subject || '其他';
      if (!groups[sub]) groups[sub] = [];
      groups[sub].push({ ...q, _originalIdx: i });
    });
    Object.keys(groups).sort().forEach((sub, gi) => {
      html += `<div class="print-subject-block">
        <div class="print-subject-title">${esc(sub)}（${groups[sub].length} 题）</div>`;
      // 学科内按 board_name 分小标题
      const byBoard = {};
      groups[sub].forEach(q => {
        const bn = q.board_name || '其他';
        if (!byBoard[bn]) byBoard[bn] = [];
        byBoard[bn].push(q);
      });
      Object.keys(byBoard).forEach(bn => {
        html += `<div class="print-board-title">📘 ${esc(bn)}</div>`;
        byBoard[bn].forEach(q => {
          html += `<div class="print-question">
            <div class="print-question-num">${q._originalIdx + 1}.</div>
            <div class="print-question-content">${esc(q.content)}</div>
            <div class="print-question-answer-line"></div>
          </div>`;
        });
      });
      html += `</div>`;
    });
  } else {
    qList.forEach((q, i) => {
      html += `<div class="print-question">
        <div class="print-question-num">${i + 1}.</div>
        <div class="print-question-content">${esc(q.content)}</div>
        <div class="print-question-answer-line"></div>
      </div>`;
    });
  }

  html += `<div style="margin-top:30px;font-size:12px;color:#999;text-align:center">— 答案见家长端「错题本」—</div>`;
  // 「清空打印列表」按钮（仅当从队列预览打开时显示）
  if (opts.onClear) {
    html += `<div class="print-queue-actions">
      <button class="btn btn-sm" id="btnClearPrintQueue">🗑 清空打印列表</button>
      <button class="btn btn-sm" onclick="closePrintModal()">关闭</button>
    </div>`;
  }
  document.getElementById('printModalBody').innerHTML = html;
  document.getElementById('printModalMask').classList.add('show');
  document.getElementById('printModal').classList.add('show');
  if (opts.onClear) {
    const btn = document.getElementById('btnClearPrintQueue');
    if (btn) btn.onclick = opts.onClear;
  }
}

function closePrintModal() {
  document.getElementById('printModalMask').classList.remove('show');
  document.getElementById('printModal').classList.remove('show');
}

// 打印按钮用 window.print 触发浏览器的打印对话框（CSS @media print 控制只打印弹窗内容）
document.addEventListener('DOMContentLoaded', () => {
  const btnPrint = document.getElementById('btnDoPrint');
  if (btnPrint) btnPrint.onclick = () => window.print();
  const close1 = document.getElementById('btnClosePrintModal');
  const close2 = document.getElementById('btnClosePrintModal2');
  if (close1) close1.onclick = closePrintModal;
  if (close2) close2.onclick = closePrintModal;
  document.getElementById('printModalMask').onclick = closePrintModal;
});
