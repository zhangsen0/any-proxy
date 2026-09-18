/**
 * 延迟实测：给「能用」补上「多快」这一个维度。
 *
 * 原先的可用性探测是**二值**的 —— 连得上就进可用集，连不上就丢，至于这一批里
 * 谁快谁慢，完全没人管：顺序其实是「哪个 worker 协程先摸到它」，近似随机。
 * 于是「优选」选出来的常常只是「能通」，而不是「最快」。
 *
 * 本模块只做一件事：对每个目标多次取样 → 取中位数 → 按延迟升序排好。
 *
 * 两个刻意的设计选择：
 *
 * 1. **它不知道怎么探测。** `probe` 由调用方传入（本项目里是 dns.js 那套
 *    `http://<ip>/__api/config` 的探活口径）。这样本模块不依赖 dns.js，
 *    也就不存在「dns.js 要用延迟排序 → import latency.js → latency.js 又
 *    import dns.js」的循环依赖。代价是调用方要自己传探测函数，换来的是
 *    探测口径仍然只有一处定义。
 *
 * 2. **单次失败不算失败。** 网络抖一下很常见，取样 N 次只要成功过一次就算通，
 *    延迟取成功那些次的中位数。宁可多花一点时间，也不要把好 IP 误杀掉 ——
 *    误杀的代价（少一个可用节点）远大于多测几次。
 *
 * 预算：并发 + 总预算双保险。预算耗尽立刻返回已测到的结果，绝不把整个请求
 * 拖过 Workers 的 30 秒墙钟。
 */

/** 中位数：比最小值抗抖动，比均值不受极端值拖累。偶数个取中间两个的均值。 */
export function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/**
 * 对一组目标做延迟实测。
 *
 * @param {string[]} targets 待测目标（IP 或域名，调用方保证格式）
 * @param {object} opts
 *   - probe        {function(string): Promise} 必填；抛错表示这一次不通
 *   - concurrency  {number} 并发路数
 *   - samples      {number} 每个目标取样次数（1~5）
 *   - maxTargets   {number} 最多测多少个
 *   - timeoutMs    {number} 单次探测超时（交给 probe 自己用，这里只透传）
 *   - budgetMs     {number} 总预算（毫秒）
 *   - deadlineMs   {number} 绝对截止时间戳（来自上游更大的预算，会更早生效）
 * @returns {Promise<{items: Array, ok: string[], stats: object}>}
 *   items 含全部目标（包括不通的），供诊断展示；
 *   ok   只含通的、且已按延迟升序排好。
 */
export async function measureTargets(targets, opts = {}) {
  const probe = opts.probe;
  if (typeof probe !== 'function') throw new Error('measureTargets 需要 opts.probe');

  const concurrency = Math.max(1, Math.min(64, opts.concurrency || 4));
  const samples = Math.max(1, Math.min(5, opts.samples || 1));
  const maxTargets = Math.max(1, opts.maxTargets || 50);

  const budgetEnd = opts.budgetMs ? Date.now() + opts.budgetMs : 0;
  const deadline = opts.deadlineMs || 0;
  // 两个截止里取更早的那个：上游预算（deadline）通常比本模块自己的预算更早到
  const hardEnd = (budgetEnd && deadline) ? Math.min(budgetEnd, deadline)
    : (deadline || budgetEnd || 0);

  const queue = [...new Set(targets)].slice(0, maxTargets);
  const items = [];
  let stoppedEarly = false;

  const worker = async () => {
    while (queue.length) {
      if (hardEnd && Date.now() > hardEnd) { stoppedEarly = true; return; }
      const target = queue.shift();
      const hits = [];
      for (let i = 0; i < samples; i++) {
        if (hardEnd && Date.now() > hardEnd) { stoppedEarly = true; break; }
        const t0 = Date.now();
        try {
          await probe(target, opts.timeoutMs);
          hits.push(Date.now() - t0);
        } catch {
          // 这一趟没通：可能是抖动，继续取下一趟；全部失败才算不通
        }
      }
      items.push({
        target,
        ok: hits.length > 0,
        ms: hits.length ? median(hits) : null,
        hits: hits.length,
      });
    }
  };

  const lanes = Math.min(concurrency, queue.length) || 1;
  await Promise.all(Array.from({ length: lanes }, () => worker().catch(() => {})));

  const good = items.filter((x) => x.ok).sort((a, b) => (a.ms ?? Infinity) - (b.ms ?? Infinity));

  return {
    items,
    ok: good.map((x) => x.target),
    stats: {
      total: items.length,
      good: good.length,
      bad: items.length - good.length,
      fastest: good.length ? good[0].ms : null,
      slowest: good.length ? good[good.length - 1].ms : null,
      stoppedEarly,
    },
  };
}
