// routes/stageplan.js
const express = require('express');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz  = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(tz);
dayjs.tz.setDefault('Asia/Taipei'); // ✅ 台北時區，避免日期少一天

const router = express.Router();
const { pool } = require('../db');
const { attachUser, requireAuth } = require('../middleware/auth');

const TZ = 'Asia/Taipei';

// 預設比例（與 id=1..8 對齊）
const DEFAULT_PCTS = {
  1: 0.03, // 丈量
  2: 0.05, // 案例分析
  3: 0.03, // 平面放樣
  4: 0.10, // 平面圖
  5: 0.20, // 平面系統圖
  6: 0.15, // 立面框體圖
  7: 0.32, // 立面圖
  8: 0.12  // 施工圖
};

// 若讀不到表，就用這些名稱當預設
const DEFAULT_NAMES = {
  1: '丈量',
  2: '案例分析',
  3: '平面放樣',
  4: '平面圖',
  5: '平面系統圖',
  6: '立面框體圖',
  7: '立面圖',
  8: '施工圖'
};

// ---------- helpers ----------
function roundHalfUp(n) {
  const s = n < 0 ? -1 : 1;
  const a = Math.abs(n);
  return s * Math.floor(a + 0.5);
}

/** 依比例將 totalDays 分配到 1..8，總和校正為 totalDays，且每段至少 1 天 */
function allocateDays(totalDays, stages) {
  const raw = stages.map(s => {
    const exact = totalDays * s.pct;
    return { ...s, days: roundHalfUp(exact), frac: exact - Math.floor(exact) };
  });
  let sum = raw.reduce((a, b) => a + b.days, 0);
  let diff = totalDays - sum;

  if (diff > 0) {
    const order = [...raw].sort((a, b) => b.frac - a.frac);
    for (let i = 0; i < diff; i++) order[i % order.length].days += 1;
  } else if (diff < 0) {
    let need = -diff;
    while (need > 0) {
      const order = [...raw].sort((a, b) => (a.frac - b.frac) || (b.days - a.days));
      for (const it of order) {
        if (need > 0 && it.days > 0) { it.days--; need--; }
      }
    }
  }

  raw.forEach(it => { if (it.days <= 0) it.days = 1; });
  return raw.map(({ frac, ...r }) => r);
}

/** 亮燈邏輯：只在超過到期日（>）時亮燈；等待階段完全不亮 */
function computeOverdueStatus(plannedEndYmd, isCompleted, status) {
  // 等待中不亮
  if (status === 'waiting') return { status: 'none', overdue_days: 0 };

  // 完成 → 綠燈
  if (isCompleted) return { status: 'green', overdue_days: 0 };

    const today = dayjs().tz(TZ).startOf('day');
    const due   = dayjs.tz(plannedEndYmd, TZ).startOf('day');

    const overdueDays = today.diff(due, 'day');  // 今天 - 到期日（超過 = 正數）

    if (overdueDays > 0) {
        // > 0 表示「今天已超過到期日」（到期日隔天開始亮）
        return { status: overdueDays >= 7 ? 'red' : 'orange', overdue_days: overdueDays };
    }

    // 到期當天（overdueDays = 0）或未到期（<0）都不亮
    return { status: 'none', overdue_days: 0 };
}

/** 從 project_text 讀取 1..8 的名稱（若缺就用預設），並附上預設比例 */
async function loadStagesMeta() {
  const sql = `SELECT id AS no, project_text AS name FROM project_text ORDER BY id ASC`;
  const { rows } = await pool.query(sql);

  const nameByNo = new Map(rows.map(r => [Number(r.no), r.name]));
  const list = [];
  for (let no = 1; no <= 8; no++) {
    list.push({
      no,
      name: nameByNo.get(no) || DEFAULT_NAMES[no],
      pct: DEFAULT_PCTS[no] ?? 0
    });
  }
  return list;
}

/** 從 project_text_upload 讀取完成集合（以是否存在紀錄判斷完成） */
async function loadCompletedSet(projectIdText) {
  const sql = `
    SELECT DISTINCT text_no
    FROM project_text_upload
    WHERE project_id = $1
  `;
  const { rows } = await pool.query(sql, [String(projectIdText)]);
  return new Set(rows.map(r => Number(r.text_no)));
}

/** 依 start/days 切出每段日期，依 project.stage_id 判斷等待/進行/完成 */
async function buildPlan(projectIdText, startDate, totalDays) {
  const meta = await loadStagesMeta();
  const completed = await loadCompletedSet(projectIdText);

  const allocated = allocateDays(totalDays, meta).sort((a, b) => a.no - b.no);
  const start = dayjs.tz(startDate, TZ).startOf('day');
  let cursor = start;

  // 取出 project.stage_id 並對照 project_stage
  const sql = `
    SELECT p.stage_id, ps.code AS stage_code
    FROM project p
    LEFT JOIN project_stage ps ON ps.id = p.stage_id
    WHERE p.id = $1
    LIMIT 1
  `;
  const { rows } = await pool.query(sql, [projectIdText]);
  let stageCode = rows[0]?.stage_code || 'waiting';

  const stages = allocated.map(s => {
    const dur = Math.max(1, Number(s.days) || 1);
    const ps = cursor;
    const pe = cursor.add(dur - 1, 'day');
    cursor = pe.add(1, 'day');

    // DB 已上傳 → completed
    const isCompleted = completed.has(s.no);

    // 預設：根據整體專案 stage_code 判斷大類型
    let currentStatus = 'waiting';
    switch (stageCode) {
      case 'waiting':
        currentStatus = 'waiting';
        break;
      case 'design':
        // 設計階段：前幾個圖面才算進行中
        currentStatus = s.no <= 8 ? 'doing' : 'waiting';
        break;
      case 'build':
        // 施工階段：全部可亮（只看是否完成）
        currentStatus = 'doing';
        break;
      case 'Finished':
        currentStatus = 'completed';
        break;
      default:
        currentStatus = 'waiting';
    }

    // 若該項有上傳檔案，也視為完成
    if (isCompleted) currentStatus = 'completed';

    const lamp = computeOverdueStatus(pe.format('YYYY-MM-DD'), currentStatus === 'completed', currentStatus);

    return {
      no: s.no,
      name: s.name,
      pct: s.pct,
      days: dur,
      planned_start: ps.format('YYYY-MM-DD'),
      planned_end: pe.format('YYYY-MM-DD'),
      flow_status: currentStatus,  // waiting | doing | completed
      status: lamp.status,         // none | green | orange | red
      overdue_days: lamp.overdue_days
    };
  });

  return stages;
}


// ---------- route ----------
// GET /api/projects/:id/stage-plan
router.get('/projects/:id/stage-plan', attachUser, requireAuth, async (req, res) => {
  try {
    const pidRaw = req.params.id; // project_text_upload 用
    const pidNum = Number(pidRaw); // project 表用

    // 從 project 讀 start_date、estimated_days
    let start = null, days = null;
    if (Number.isFinite(pidNum) && pidNum > 0) {
      const r1 = await pool.query(
        `SELECT start_date, estimated_days FROM project WHERE id = $1 LIMIT 1`,
        [pidNum]
      );
      if (r1.rows[0]) {
        // ✅ 不做任何 toISOString()，確保不會被轉時區
        start = r1.rows[0].start_date
          ? dayjs(r1.rows[0].start_date).format('YYYY-MM-DD')
          : null;
        days = r1.rows[0].estimated_days
          ? Number(r1.rows[0].estimated_days)
          : null;
      }
    }

    // Query 備援
    if (!start) start = req.query.start || null;
    if (!days) days = req.query.days ? Number(req.query.days) : null;

    // 驗證
    if (!start || !dayjs(start, 'YYYY-MM-DD', true).isValid()) {
      return res.status(400).json({ ok: false, msg: 'start(YYYY-MM-DD) 必填/格式錯誤' });
    }
    if (!Number.isFinite(days) || days <= 0) {
      return res.status(400).json({ ok: false, msg: 'days(>0) 必填' });
    }

    const stages = await buildPlan(String(pidRaw), start, days);

    res.json({
      ok: true,
      data: {
        project_id: String(pidRaw),
        start_date: start,
        total_days: days,
        stages
      }
    });
  } catch (err) {
    console.error('[stageplan] error:', err);
    res.status(500).json({ ok: false, msg: 'server error' });
  }
});

module.exports = router;
