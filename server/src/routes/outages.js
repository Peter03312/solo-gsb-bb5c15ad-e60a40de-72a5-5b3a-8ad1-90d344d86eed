import { Router } from 'express';
import { listCircuits, listDevices, periodsByDevice } from '../state.js';
import { dfsOrder } from '../load.js';
import { simulateOutage } from '../outage.js';
import { normalizeTime } from '../validators.js';
import HttpError from '../httpError.js';

const router = Router();

/** 回路自顶向下的路径名，便于在结果中指认 */
function circuitPath(circuitId, byId) {
  const names = [];
  let cur = byId.get(circuitId);
  while (cur) {
    names.unshift(cur.name);
    cur = cur.parent_id != null ? byId.get(cur.parent_id) : null;
  }
  return names.join(' / ');
}

/**
 * 解析并校验停电方案：
 * - 必须是非空数组，每项含 circuit_id / start / end；
 * - 回路必须存在（缺失回路明确报错），时间格式与左闭右开由 normalizeTime 校验；
 * - 同一节点可出现多个窗口，窗口之间允许重叠（计算时统一合并）。
 */
function parseOutages(body) {
  if (!body || !Array.isArray(body.outages)) {
    throw new HttpError('请求体必须包含 outages 数组', 'INVALID_OUTAGE', 400);
  }
  if (body.outages.length === 0) {
    throw new HttpError('停电方案为空：至少填写一个配电箱或末级回路的停电起止时间', 'EMPTY_OUTAGE', 400);
  }
  const allCircuits = listCircuits();
  const exists = new Set(allCircuits.map((c) => c.id));
  const outages = body.outages.map((raw, i) => {
    const where = `第 ${i + 1} 条停电安排`;
    if (!raw || typeof raw !== 'object') {
      throw new HttpError(`${where}格式非法，必须是对象`, 'INVALID_OUTAGE', 400);
    }
    const circuitId = Number(raw.circuit_id);
    if (!Number.isInteger(circuitId) || circuitId <= 0) {
      throw new HttpError(`${where}缺少有效的回路 id`, 'MISSING_CIRCUIT', 400);
    }
    if (!exists.has(circuitId)) {
      throw new HttpError(`${where}指定的回路 ${circuitId} 不存在（缺失回路）`, 'MISSING_CIRCUIT', 400, {
        index: i,
        circuit_id: circuitId,
      });
    }
    if (raw.start === undefined || raw.start === null || raw.end === undefined || raw.end === null) {
      throw new HttpError(`${where}必须填写停电起点与终点`, 'INVALID_TIME', 400);
    }
    const start = normalizeTime(raw.start, `${where}停电起点`);
    const end = normalizeTime(raw.end, `${where}停电终点`);
    if (!(start < end)) {
      throw new HttpError(`${where}停电起点必须早于终点（左闭右开，窗口不可为空）`, 'INVALID_OUTAGE', 400, {
        index: i,
        circuit_id: circuitId,
        start,
        end,
      });
    }
    return { circuit_id: circuitId, start, end };
  });
  return outages;
}

/**
 * POST /api/outages/preview
 * 停电检修影响预演：纯计算接口，不写入、不改变任何配置。
 * 返回按时间段的各回路原负载 / 剩余供电负载 / 失供负载，以及受影响设备清单。
 */
router.post('/preview', (req, res) => {
  const outages = parseOutages(req.body);

  const circuits = listCircuits();
  const devices = listDevices();
  const periods = periodsByDevice();
  const sim = simulateOutage(circuits, devices, periods, outages);
  const { byId } = sim;

  const order = dfsOrder(circuits);
  const circuitResults = order.map((c) => {
    const r = sim.circuits.get(c.id);
    return {
      id: c.id,
      name: c.name,
      kind: c.kind,
      parent_id: c.parent_id,
      path: circuitPath(c.id, byId),
      rated_power: c.rated_power,
      targeted: sim.targetedIds.has(c.id),
      affected: sim.affectedCircuitIds.has(c.id),
      peak_original: r.peak_original,
      peak_remaining: r.peak_remaining,
      peak_lost: r.peak_lost,
      timeline: r.timeline,
    };
  });

  const totalLostSeconds = sim.affectedDevices.reduce((sum, d) => sum + d.lost_seconds, 0);

  res.json({
    outages,
    range: sim.range,
    segments: sim.segments,
    summary: {
      targeted_circuit_count: sim.targetedIds.size,
      affected_circuit_count: sim.affectedCircuitIds.size,
      affected_device_count: sim.affectedDevices.length,
      total_lost_seconds: totalLostSeconds,
      total_lost_minutes: Math.round(totalLostSeconds / 60),
    },
    circuits: circuitResults,
    affected_devices: sim.affectedDevices.map((d) => ({
      ...d,
      circuit_name: byId.get(d.circuit_id)?.name ?? null,
      path: byId.has(d.circuit_id) ? circuitPath(d.circuit_id, byId) : null,
    })),
  });
});

export default router;
