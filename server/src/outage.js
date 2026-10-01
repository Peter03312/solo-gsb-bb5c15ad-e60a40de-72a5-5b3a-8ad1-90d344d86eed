/**
 * 停电检修影响预演核心（只做计算，不读不写任何配置）。
 *
 * 规则：
 * - 在指定配电箱/末级回路上填写停电窗口，停电作用于该节点及其全部后代设备；
 * - 一台设备可能被其所在回路的祖先、自身回路的多个停电窗口命中，
 *   先把命中窗口合并（重叠/相邻），再与其原运行时段取交集，得到“失供区间”，
 *   同一设备同一时刻至多计一次，不重复计入；
 * - 时段一律左闭右开 [start,end)；
 * - 原负载沿用 load.js 的事件扫描口径（上级汇总全部后代运行设备），
 *   失供负载 = 在该分段处于失供区间内的设备功率之和，剩余供电负载 = 原负载 − 失供负载；
 * - 预演不改变配电树、设备接线与运行时段。
 */

/** 取某节点的全部后代回路 id（不含自身） */
export function descendantIds(rootId, byId) {
  const out = [];
  const stack = [rootId];
  while (stack.length) {
    const cur = stack.pop();
    for (const c of byId.values()) {
      if (c.parent_id === cur) {
        out.push(c.id);
        stack.push(c.id);
      }
    }
  }
  return out;
}

/** 合并重叠或首尾相接的区间（输入/输出均为 {start,end}，按起点升序） */
export function mergeIntervals(intervals) {
  const sorted = [...intervals].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const merged = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end) {
      if (iv.end > last.end) last.end = iv.end;
    } else {
      merged.push({ ...iv });
    }
  }
  return merged;
}

/** 两组已合并区间的交集（左闭右开，相邻不相交） */
export function intersectIntervals(a, b) {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const start = a[i].start < b[j].start ? b[j].start : a[i].start;
    const end = a[i].end < b[j].end ? a[i].end : b[j].end;
    if (start < end) out.push({ start, end });
    if (a[i].end <= b[j].end) i += 1;
    else j += 1;
  }
  return out;
}

/** 定长时间串（YYYY-MM-DDTHH:MM:SS）之间的秒数；跨天也可正确换算 */
function epochSeconds(t) {
  return Date.UTC(
    Number(t.slice(0, 4)),
    Number(t.slice(5, 7)) - 1,
    Number(t.slice(8, 10)),
    Number(t.slice(11, 13)),
    Number(t.slice(14, 16)),
    Number(t.slice(17, 19)),
  ) / 1000;
}

/** 区间数组的累计时长（秒） */
export function totalSeconds(intervals) {
  return intervals.reduce((sum, iv) => sum + (epochSeconds(iv.end) - epochSeconds(iv.start)), 0);
}

/** 区间内是否覆盖时刻 t（左闭右开） */
function covers(intervals, t) {
  for (const iv of intervals) {
    if (iv.start <= t && t < iv.end) return true;
    if (iv.start > t) break;
  }
  return false;
}

/**
 * 预演停电影响。
 *
 * @param circuits 回路数组（含 id、name、kind、rated_power、parent_id）
 * @param devices  设备数组（含 id、name、power_w、circuit_id）
 * @param periodsByDevice Map<deviceId, [{start,end}]>（已合并）
 * @param outages  已校验的停电窗口 [{ circuit_id, start, end }]
 * @returns {{
 *   range, segments, circuits: Map, affectedDevices, targetedIds, affectedCircuitIds
 * }}
 */
export function simulateOutage(circuits, devices, periodsByDevice, outages) {
  const byId = new Map(circuits.map((c) => [c.id, c]));

  // 1) 每个停电窗口展开到其整棵子树，按叶子回路收集命中窗口
  const windowsByLeaf = new Map();
  const targetedIds = new Set();
  for (const o of outages) {
    targetedIds.add(o.circuit_id);
    const ids = [o.circuit_id, ...descendantIds(o.circuit_id, byId)];
    for (const cid of ids) {
      if (!windowsByLeaf.has(cid)) windowsByLeaf.set(cid, []);
      windowsByLeaf.get(cid).push({ start: o.start, end: o.end });
    }
  }

  // 2) 每台设备：命中窗口（祖先/自身、重叠的多个）先合并，再与原运行时段取交集
  //    lostByDevice 只包含真正会失供的设备
  const lostByDevice = new Map();
  for (const dev of devices) {
    const hit = windowsByLeaf.get(dev.circuit_id);
    if (!hit) continue;
    const runPeriods = periodsByDevice.get(dev.id) ?? [];
    if (runPeriods.length === 0) continue;
    const lost = intersectIntervals(runPeriods, mergeIntervals(hit));
    if (lost.length > 0) lostByDevice.set(dev.id, lost);
  }

  // 3) 事件点：原运行时段边界 + 失供区间边界（失供区间本就是运行时段的子集）
  const pointsSet = new Set();
  for (const periods of periodsByDevice.values()) {
    for (const p of periods) {
      pointsSet.add(p.start);
      pointsSet.add(p.end);
    }
  }
  for (const lost of lostByDevice.values()) {
    for (const p of lost) {
      pointsSet.add(p.start);
      pointsSet.add(p.end);
    }
  }

  let globalSegments = [];
  if (pointsSet.size > 0) {
    const points = [...pointsSet].sort();
    for (let i = 0; i < points.length - 1; i++) {
      const start = points[i];
      const end = points[i + 1];
      const original = new Map(circuits.map((c) => [c.id, 0]));
      const lostLoad = new Map(circuits.map((c) => [c.id, 0]));
      for (const dev of devices) {
        const periods = periodsByDevice.get(dev.id) ?? [];
        let running = false;
        for (const p of periods) {
          if (p.end <= start) continue;
          if (p.start >= end) break; // 时段已按起点排序
          running = true;
          break; // 同一设备重叠时段已合并，一个分段内至多运行一次
        }
        if (!running) continue;
        const isLost = lostByDevice.has(dev.id) && covers(lostByDevice.get(dev.id), start);
        // 累加到接入回路自身及全部祖先
        let node = dev.circuit_id;
        while (node != null && original.has(node)) {
          original.set(node, original.get(node) + dev.power_w);
          if (isLost) lostLoad.set(node, lostLoad.get(node) + dev.power_w);
          const c = byId.get(node);
          node = c ? c.parent_id : null;
        }
      }
      globalSegments.push({ start, end, original, lostLoad });
    }
  }

  // 4) 每个回路的分段结果（相邻三值都相同则合并）与峰值
  const result = new Map();
  const affectedCircuitIds = new Set();
  for (const c of circuits) {
    const segs = [];
    let peakOriginal = 0;
    let peakRemaining = 0;
    let peakLost = 0;
    for (const s of globalSegments) {
      const orig = s.original.get(c.id) ?? 0;
      const lost = s.lostLoad.get(c.id) ?? 0;
      peakOriginal = Math.max(peakOriginal, orig);
      peakRemaining = Math.max(peakRemaining, orig - lost);
      peakLost = Math.max(peakLost, lost);
      if (lost > 0) affectedCircuitIds.add(c.id);
      const seg = { start: s.start, end: s.end, original: orig, remaining: orig - lost, lost };
      const last = segs[segs.length - 1];
      if (last && last.original === seg.original && seg.remaining === last.remaining && last.end === seg.start) {
        last.end = seg.end;
      } else {
        segs.push(seg);
      }
    }
    result.set(c.id, { timeline: segs, peak_original: peakOriginal, peak_remaining: peakRemaining, peak_lost: peakLost });
  }

  // 5) 受影响设备及其累计失供时长（按时长降序，其次 id）
  const affectedDevices = devices
    .filter((d) => lostByDevice.has(d.id))
    .map((d) => {
      const lost = lostByDevice.get(d.id);
      const seconds = totalSeconds(lost);
      return {
        id: d.id,
        name: d.name,
        power_w: d.power_w,
        circuit_id: d.circuit_id,
        lost_periods: lost,
        lost_seconds: seconds,
        lost_minutes: Math.round(seconds / 60),
      };
    })
    .sort((a, b) => b.lost_seconds - a.lost_seconds || a.id - b.id);

  const allPoints = [...pointsSet].sort();
  const range = allPoints.length ? { start: allPoints[0], end: allPoints[allPoints.length - 1] } : null;

  return {
    range,
    segments: globalSegments.map((s) => ({ start: s.start, end: s.end })),
    circuits: result,
    affectedDevices,
    targetedIds,
    affectedCircuitIds,
    byId,
  };
}
