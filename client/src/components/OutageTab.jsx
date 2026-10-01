import React, { useMemo, useState } from 'react';
import { api } from '../api.js';
import { buildTree, circuitPath, durationText, kW, mdhm, toMinutes } from '../utils.js';

const LABEL_W = 232;
const ROW_H = 64;
const PLOT_W = 1080;
const PAD_T = 10;
const PAD_B = 18;
const PLOT_H = ROW_H - PAD_T - PAD_B;

/** 深度优先顺序（含缩进层级），与树展示一致 */
function dfs(circuits, children) {
  const out = [];
  const visit = (pid, depth) => {
    for (const id of children.get(pid) ?? []) {
      out.push({ id, depth });
      visit(id, depth + 1);
    }
  };
  visit(0, 0);
  const byId = new Map(circuits.map((c) => [c.id, c]));
  return out.map(({ id, depth }) => ({ ...byId.get(id), depth }));
}

/** 合并重叠/相邻窗口 */
function mergeWindows(ws) {
  const sorted = [...ws].sort((a, b) => (a.start < b.start ? -1 : 1));
  const merged = [];
  for (const w of sorted) {
    const last = merged[merged.length - 1];
    if (last && w.start <= last.end) {
      if (w.end > last.end) last.end = w.end;
    } else {
      merged.push({ ...w });
    }
  }
  return merged;
}

/**
 * 停电检修影响预演：
 * 为多个配电箱 / 末级回路分别填写停电窗口 → 调后端纯计算接口 →
 * 按时间段展示各回路的原负载（灰虚线）、剩余供电负载（蓝线）与失供负载（红区），
 * 并列出受影响设备的累计失供时长。预演不改变任何配置。
 */
export default function OutageTab({ state }) {
  const tree = useMemo(() => buildTree(state.circuits), [state.circuits]);
  const ordered = useMemo(() => dfs(state.circuits, tree.children), [state.circuits, tree.children]);

  const [rows, setRows] = useState([{ circuit_id: '', start: '', end: '' }]);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const updateRow = (i, patch) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const runPreview = async () => {
    setBusy(true);
    setErr(null);
    try {
      const outages = rows
        .filter((r) => r.circuit_id || r.start || r.end)
        .map((r) => ({ circuit_id: Number(r.circuit_id), start: r.start, end: r.end }));
      if (outages.length === 0) throw new Error('停电方案为空：至少填写一条停电安排');
      for (const o of outages) {
        if (!o.circuit_id) throw new Error('每条停电安排都必须选择配电箱或末级回路');
        if (!o.start || !o.end) throw new Error('每条停电安排都必须填写停电起点和终点');
        if (!(o.start < o.end)) throw new Error('存在起点不早于终点的停电窗口（时间左闭右开）');
      }
      const r = await api.outagePreview(outages);
      setResult(r);
    } catch (e) {
      setResult(null);
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  // 每个回路实际生效的停电窗口：选自身或任一祖先被停的窗口合并而来
  const windowsByCircuit = useMemo(() => {
    const map = new Map();
    if (!result) return map;
    const byTarget = new Map();
    for (const o of result.outages) {
      if (!byTarget.has(o.circuit_id)) byTarget.set(o.circuit_id, []);
      byTarget.get(o.circuit_id).push({ start: o.start, end: o.end });
    }
    for (const c of state.circuits) {
      const ws = [];
      let cur = c.id;
      while (cur != null) {
        if (byTarget.has(cur)) ws.push(...byTarget.get(cur));
        const node = tree.byId.get(cur);
        cur = node ? node.parent_id : null;
      }
      if (ws.length) map.set(c.id, mergeWindows(ws));
    }
    return map;
  }, [result, state.circuits, tree.byId]);

  const model = useMemo(() => {
    if (!result || !result.range) return null;
    // 视图范围：原运行时段范围并上停电窗口范围（窗口可能落在运行时段之外）
    let t0s = result.range.start;
    let t1s = result.range.end;
    for (const o of result.outages) {
      if (o.start < t0s) t0s = o.start;
      if (o.end > t1s) t1s = o.end;
    }
    const t0 = toMinutes(t0s);
    const t1 = toMinutes(t1s);
    const span = Math.max(t1 - t0, 1);
    const x = (t) => LABEL_W + ((toMinutes(t) - t0) / span) * PLOT_W;

    const ticks = [];
    for (let i = 0; i <= 5; i++) {
      const ms = new Date((t0 + (span * i) / 5) * 60000);
      const pad = (n) => String(n).padStart(2, '0');
      ticks.push({
        x: LABEL_W + (PLOT_W * i) / 5,
        label: `${pad(ms.getUTCMonth() + 1)}-${pad(ms.getUTCDate())} ${pad(ms.getUTCHours())}:${pad(ms.getUTCMinutes())}`,
        key: i,
      });
    }

    const rowsView = result.circuits.map((c) => {
      const maxLoad = Math.max(c.peak_original, c.rated_power) * 1.12;
      const y = (w) => PAD_T + PLOT_H * (1 - w / maxLoad);
      const yRated = y(c.rated_power);
      const segs = c.timeline;
      const line = (pick) => {
        if (!segs.length) return '';
        let d = `M ${x(segs[0].start)} ${y(pick(segs[0]))}`;
        for (const s of segs) d += ` L ${x(s.start)} ${y(pick(s))} L ${x(s.end)} ${y(pick(s))}`;
        return d;
      };
      // 剩余供电负载与原负载之间的区域即失供负载
      const lostAreas = segs
        .filter((s) => s.lost > 0)
        .map((s) => ({
          x: x(s.start),
          width: Math.max(x(s.end) - x(s.start), 1),
          y: y(s.original),
          height: Math.max(y(s.remaining) - y(s.original), 0),
          start: s.start,
          end: s.end,
          original: s.original,
          remaining: s.remaining,
        }));
      const bands = (windowsByCircuit.get(c.id) ?? []).map((w) => ({
        x: x(w.start),
        width: Math.max(x(w.end) - x(w.start), 1),
        start: w.start,
        end: w.end,
      }));
      return {
        c,
        yRated,
        originalPath: line((s) => s.original),
        remainingPath: line((s) => s.remaining),
        areaPath: buildArea(segs, x, (s) => y(s.remaining)),
        lostAreas,
        bands,
      };
    });

    return { x, ticks, rowsView, totalH: ROW_H * rowsView.length + PAD_B };
  }, [result, windowsByCircuit]);

  const hasPeriods = state.devices.some((d) => (state.periods[d.id] ?? []).length > 0);

  return (
    <div>
      <div className="section-head"><h2>停电检修影响预演</h2></div>

      <div className="card">
        <div className="period-head">
          <span>为配电箱或末级回路分别填写停电窗口（停电作用于所选节点及其全部后代设备）</span>
          <button className="btn-mini" onClick={() => setRows([...rows, { circuit_id: '', start: '', end: '' }])}>
            + 停电安排
          </button>
        </div>
        {rows.map((r, i) => (
          <div className="outage-row" key={i}>
            <select value={r.circuit_id} onChange={(e) => updateRow(i, { circuit_id: e.target.value })}>
              <option value="">选择配电箱 / 回路…</option>
              {ordered.map((c) => (
                <option key={c.id} value={c.id}>
                  {'　'.repeat(c.depth)}{c.depth > 0 ? '└ ' : ''}{c.name}
                </option>
              ))}
            </select>
            <input type="datetime-local" value={r.start} onChange={(e) => updateRow(i, { start: e.target.value })} />
            <span className="muted">至</span>
            <input type="datetime-local" value={r.end} onChange={(e) => updateRow(i, { end: e.target.value })} />
            <button className="btn-mini danger" disabled={rows.length === 1} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
              移除
            </button>
          </div>
        ))}
        <div className="rehearse-actions">
          <button className="btn primary" onClick={runPreview} disabled={busy || ordered.length === 0}>
            {busy ? '预演中…' : '预演停电影响'}
          </button>
          {result && (
            <button className="btn ghost" onClick={() => { setResult(null); setErr(null); }} disabled={busy}>
              清空结果
            </button>
          )}
        </div>
        {err && <div className="inline-error">{err}</div>}
        <p className="muted small">
          时间左闭右开；设备仅在其原运行时段与停电窗口的交集内失供，同一设备受祖先 / 子节点 /
          重叠窗口影响时先合并失供区间、不重复计入。预演不会改变配电树、设备接线或运行时段。
        </p>
      </div>

      {result && (
        <>
          <div className="card over-summary">
            <div className="over-title">预演结果（仅为假设，配置未改动）</div>
            <div className="outage-summary">
              <span className="chip">停电节点 {result.summary.targeted_circuit_count} 个</span>
              <span className="chip">受影响回路 {result.summary.affected_circuit_count} 个</span>
              <span className="chip-danger">受影响设备 {result.summary.affected_device_count} 台</span>
              <span className="chip-danger">累计失供 {durationText(result.summary.total_lost_seconds)}</span>
            </div>
            {result.summary.affected_device_count === 0 && hasPeriods && (
              <div className="muted small">所有停电窗口与设备运行时段均无交集：各回路保持原负载，没有设备失供。</div>
            )}
          </div>

          {!hasPeriods && (
            <div className="banner-warn">当前没有任何设备运行时段，无法生成负载时间线。</div>
          )}

          {model && hasPeriods && (
            <>
              <div className="legend">
                <span><i className="lg lg-remaining" />剩余供电负载</span>
                <span><i className="lg lg-lost" />失供负载</span>
                <span><i className="lg lg-original" />原负载</span>
                <span><i className="lg lg-band" />停电窗口</span>
                <span><i className="lg lg-rated" />额定功率</span>
              </div>
              <div className="timeline-scroll">
                <div className="timeline" style={{ width: LABEL_W + PLOT_W + 8 }}>
                  <div className="tl-col-labels" style={{ width: LABEL_W }}>
                    {model.rowsView.map(({ c }) => (
                      <div key={c.id} className="tl-label" style={{ height: ROW_H }}>
                        <div className="tl-label-name" title={c.path}>
                          <span className={c.kind === 'box' ? 'icon-box' : 'icon-cct'}>{c.kind === 'box' ? '▦' : '●'}</span>
                          {c.name}
                          {c.targeted && <span className="tag" title="本节点安排了停电">停</span>}
                        </div>
                        <div className={c.affected ? 'tl-sub danger-text' : 'tl-sub muted'}>
                          额定 {kW(c.rated_power)} / 原峰 {kW(c.peak_original)} / 剩余峰 {kW(c.peak_remaining)} kW
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="tl-col-plot" style={{ width: PLOT_W + 8 }}>
                    <svg width={PLOT_W + 8} height={model.totalH + 26} className="tl-svg">
                      {model.rowsView.map(({ c }, i) => (
                        <g key={c.id}>
                          <rect x={LABEL_W} y={i * ROW_H} width={PLOT_W} height={ROW_H - 1} fill={i % 2 ? '#f7f8fb' : '#ffffff'} />
                          <line x1={LABEL_W} y1={i * ROW_H} x2={LABEL_W + PLOT_W} y2={i * ROW_H} stroke="#e5e8ef" />
                        </g>
                      ))}
                      {model.ticks.map((t) => (
                        <g key={t.key}>
                          <line x1={t.x} y1={0} x2={t.x} y2={model.totalH} stroke="#eef1f6" />
                          <text x={t.x} y={model.totalH + 18} textAnchor="middle" className="axis-text">{t.label}</text>
                        </g>
                      ))}
                      {model.rowsView.map(({ c, yRated, originalPath, remainingPath, areaPath, lostAreas, bands }, i) => (
                        <g key={c.id} transform={`translate(0, ${i * ROW_H})`}>
                          {bands.map((b, j) => (
                            <rect key={`b${j}`} x={b.x} y={0} width={b.width} height={ROW_H - 1} fill="rgba(180,83,9,0.10)" />
                          ))}
                          <path d={areaPath} fill="rgba(37,99,235,0.10)" />
                          {lostAreas.map((a, j) => (
                            <g key={`l${j}`}>
                              <rect x={a.x} y={a.y} width={a.width} height={Math.max(a.height, 0)} fill="rgba(225,29,72,0.28)" />
                              <title>{`${mdhm(a.start)} – ${mdhm(a.end)}，失供 ${kW(a.original - a.remaining)} kW（原 ${kW(a.original)} → 剩余 ${kW(a.remaining)}）`}</title>
                            </g>
                          ))}
                          <line x1={LABEL_W} y1={yRated} x2={LABEL_W + PLOT_W} y2={yRated} stroke="#e11d48" strokeWidth={1.2} strokeDasharray="6 4" />
                          <path d={originalPath} fill="none" stroke="#94a3b8" strokeWidth={1.4} strokeDasharray="5 3" />
                          <path d={remainingPath} fill="none" stroke="#2563eb" strokeWidth={1.8} />
                        </g>
                      ))}
                    </svg>
                  </div>
                </div>
              </div>
            </>
          )}

          {result.affected_devices.length > 0 && (
            <div className="card">
              <h3 className="outage-h3">受影响设备及累计失供时长（{result.affected_devices.length} 台）</h3>
              <table className="grid compact">
                <thead>
                  <tr><th>设备</th><th>功率</th><th>接入回路</th><th>失供区间（已合并，左闭右开）</th><th>累计失供</th></tr>
                </thead>
                <tbody>
                  {result.affected_devices.map((d) => (
                    <tr key={d.id}>
                      <td>{d.name}</td>
                      <td>{kW(d.power_w)} kW</td>
                      <td className="muted">{d.path ?? `回路#${d.circuit_id}`}</td>
                      <td>
                        {d.lost_periods.map((p, i) => (
                          <span key={i} className="chip-danger">{mdhm(p.start)} – {mdhm(p.end)}</span>
                        ))}
                      </td>
                      <td className="danger-text nowrap"><b>{durationText(d.lost_seconds)}</b></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function buildArea(segs, x, y) {
  if (!segs.length) return '';
  const base = PAD_T + PLOT_H;
  let d = `M ${x(segs[0].start)} ${base}`;
  for (const s of segs) d += ` L ${x(s.start)} ${y(s)} L ${x(s.end)} ${y(s)}`;
  d += ` L ${x(segs[segs.length - 1].end)} ${base} Z`;
  return d;
}
