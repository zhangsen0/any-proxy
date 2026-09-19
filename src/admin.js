import { json, esc, kvKey, validTarget, parseIpv4List, parseDomainList } from './util.js';
import { toBool } from './config.js';
import { runtime } from './runtime.js';
import { listSites, getSite, autoSlug, validSlug, buildTarget, addSite, invalidateSite } from './sites.js';
import { DEFAULT_SITE_MODES, getSiteModes, saveSiteModes, resolveEngine, siteBadge, SITE_ENGINES, BADGE_CLASSES } from './site-modes.js';
import { readR2Config, saveR2Config, R2_CACHE_SPEC, R2_PREFIX } from './media-r2.js';
import { sweepMediaR2 } from './proxy.js';
import {
  autoUpdatePreferredDns, filterUsableIps, applyDnsWithSelfCheck, resolveProxyHost, targetHost,
  probeLatency, DNS_INTERVAL,
} from './dns.js';
import { subscriptionUrl, fetchSubscriptionCandidates, CANDIDATE_LIMIT } from './subs.js';
import {
  SETTINGS_SPEC, readSettings, safeSettings, saveSettings, clearSetting,
  settingsSources, settingsSource, describeGroups,
  panelSpecOf, nodeIdentity,
} from './settings.js';
import * as tempsubs from './tempsubs.js';
import { readConfig, saveConfig, sanitize, isActive, renderHome, listTemplates } from './disguise.js';
import { VISIT_SCOPES } from './scopes.js';
import {
  readThemeConfig, saveThemeConfig, listThemes, upsertCustom, removeCustom,
  themeCss, baseVarsCss, applyScript, THEME_STORAGE_KEY, DEFAULT_PRESET_ID,
  rotatingTheme, rotatePool, themeFieldBounds,
} from './themes.js';
import { readStatsConfig, saveStatsConfig, summarize, clearAll, STATS_SPEC, STATS_RANGES } from './stats.js';
import {
  readLimitConfig, saveLimitConfig, listBans, clearBans, RATELIMIT_SPEC,
} from './ratelimit.js';
import {
  readAlertConfig, saveAlertConfig, safeAlertConfig, testAlert, recentAlerts,
  ALERT_SPEC, ALERT_EVENTS,
} from './alert.js';
import {
  readShareConfig, saveShareConfig, createShare, listShares,
  revokeShare, enableShare, deleteShare, linkPath, SHARE_SPEC,
} from './share.js';
import { renderConfigPanels, settingFormById, toolItemsForTab, CONFIG_JS, CONFIG_CSS } from './config-ui.js';
import { renderStatsPane, STATS_JS, STATS_CSS } from './stats-ui.js';
import { renderCfPane, CF_JS, CF_CSS } from './cf-panel.js';
import { cfAnalytics } from './cf-analytics.js';
import { readTagSettings } from './nodetag.js';
import { readPickSpeed, savePickSpeed, rankByPickSpeed, readSlowIps, computeSlowIps, spread } from './pickspeed.js';

/**
 * 输入是不是「一个字都没填」。
 *
 * 只判断空，**不参与解析也不参与校验** —— 合法性与归一化只有 util.js 那一份解析器。
 * 用途：区分「用户明确清空列表」与「填了一堆但一条有效的都没有」。后者必须当场报错，
 * 否则就是我们踩过的那个坑：提示保存成功，池子其实是空的。
 */
function blankList(v) {
  if (Array.isArray(v)) v = v.join('\n');
  return String(v == null ? '' : v).replace(/[\s,;]+/g, '') === '';
}

// 站点管理：REST API + 服务端渲染的管理页

/**
 * 从请求推导优选所需上下文（目标域名 + 总预算）。
 * 目标域名不再写死：面板「优选目标域名」优先，其次 PROXY_HOST 环境变量，否则用当前请求的 hostname。
 * 预算同样走运行参数（面板可调），默认值只在 settings.js 的 SPEC 里写一次。
 */
async function dnsContext(request, url, env) {
  const cfg = await readSettings(env);
  return {
    host: await targetHost(env, url.hostname),
    origin: url.origin,
    deadlineMs: Date.now() + (cfg.dns_budget_ms || SETTINGS_SPEC.dns_budget_ms.default),
  };
}

/**
 * 浏览器自动优选「怎么跑」的运行参数：一次测几个、留几条、几路并发、单次等多久。
 * 这五个数字以前写死在面板脚本里（40 / 15 / 8 / 3500），注册表里改「订阅候选上限」不生效 ——
 * 面板上有开关、行为不变，属于最难查的一类问题。现在只有这一处定义：
 * 服务端接口把它回带给前端，前端照单执行，自己不再留任何数字。
 */
function pickLimits(cfg) {
  const num = (key) => Number(cfg[key]) || SETTINGS_SPEC[key].default;
  return {
    scan_limit: num('pick_scan_limit'),
    keep: num('pick_keep'),
    concurrency: num('pick_concurrency'),
    timeout_ms: num('pick_timeout_ms'),
  };
}

async function handleAdmin(request, url, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  const path = url.pathname;

  // GET /__api/config
  if (request.method === 'GET' && path === '/__api/config') {
    return json({ ok: true });
  }

  // GET / POST /__api/settings -> 统一运行参数（配置中心）
  //
  // 这一块是「所有非部署形态的配置都能在页面改」的落点：字段表在 src/settings.js，
  // 这里只负责读写与脱敏，不写任何字段名 —— 加一个参数只需要在 SPEC 里加一条。
  // 返回里带 source（panel / env / legacy / default），面板据此说明「这个值现在从哪来」，
  // 避免出现「我在环境变量里改过，怎么面板不显示」这类来回排查。
  if (path === '/__api/settings') {
    if (request.method === 'GET') {
      const cfg = await readSettings(env);
      return json({
        ok: true,
        config: await safeSettings(env),
        groups: describeGroups(),
        sources: await settingsSources(env),
        effective: { proxy_host: cfg.proxy_host || '', sub_url: cfg.sub_url || '' },
      });
    }
    if (request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      // 前端把整块表单一次提交。字段名只有 SPEC 一套，出现不认识的键 saveSettings 会报错
      // （以前是静默忽略：名字写错也返回「已保存」，值却没变）。
      const r = await saveSettings(env, body);
      if (r && r.error) return json({ error: r.error }, 400);
      return json({
        ok: true,
        config: r.safe,
        saved: r.saved || [],
        sources: await settingsSources(env),
        message: '已保存并生效（无需重新部署）',
      });
    }
  }

  // DNS 自动优选更新频率（分钟）：GET 读取（未登录可读）
  // 默认值与允许区间都取 DNS_INTERVAL —— 调度器用的是同一份，
  // 不再在这里另写一个 720 / 5~1440（写两处就会有一天两边对不上）；
  // 值本身存进统一运行参数（历史独立键 DNS_CONFIG 由 settings.js 兜底迁移）
  // 字段名只有一套：面板渲染出的 data-key、本接口收发的键、注册表里的键，都是
  // dns_interval_minutes。曾经这里是 interval_minutes —— 面板发 dns_interval_minutes，
  // 接口读 interval_minutes，parseInt(undefined) 得到 NaN，于是「填了合法值却报范围错」，
  // 永远保存不上。只读的 min / max 是给控件的区间提示，不参与读写。
  if (path === '/__api/dns-config') {
    if (request.method === 'GET') {
      const cfg = await readSettings(env);
      return json({
        ok: true,
        dns_interval_minutes: cfg.dns_interval_minutes,
        min: DNS_INTERVAL.min,
        max: DNS_INTERVAL.max,
      });
    }
    if (request.method === 'POST') {
      // 登录校验已由 router.js 统一拦截，此处不再重复判断
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'invalid json' }, 400);
      }
      const interval = parseInt(body.dns_interval_minutes, 10);
      if (!interval || interval < DNS_INTERVAL.min || interval > DNS_INTERVAL.max) {
        return json({ error: `更新频率需在 ${DNS_INTERVAL.min} ~ ${DNS_INTERVAL.max} 分钟之间` }, 400);
      }
      const r = await saveSettings(env, { dns_interval_minutes: interval });
      if (r && r.error) return json({ error: r.error }, 400);
      return json({ ok: true, dns_interval_minutes: r.values.dns_interval_minutes });
    }
  }

  // POST /__api/dns-run  -> 手动立即执行一次优选：并发测通后把可用 IP 写入 A 记录（需登录）
  // 目标域名与预算由 dnsContext 统一给出，避免再出现「域名写死 / 预算失控导致请求超时」的情况。
  if (request.method === 'POST' && path === '/__api/dns-run') {
    const ctx = await dnsContext(request, url, env);
    if (!ctx.host) return json({ error: '无法确定优选目标域名：请配置 PROXY_HOST' }, 500);
    const result = await autoUpdatePreferredDns(env, ctx);
    if (!result || !result.ok) {
      return json({ error: (result && result.error) || '执行失败', note: (result && result.note) || '' }, 500);
    }
    const msg = `优选完成：测通 ${(result.ips || []).length} 个，已更新 ${result.changed} 条 A 记录 → ${(result.ips || []).join(' / ')}（候选 ${result.pool} 个，目标 ${ctx.host}）`;
    return json({
      ok: true, ips: result.ips, pool: result.pool, changed: result.changed, verified: result.verified,
      host: ctx.host, note: result.note || '',
      message: result.note ? msg + `｜${result.note}` : msg,
    });
  }

  // POST /__api/latency-probe -> 逐个实测候选 IP 的真实延迟、按快慢排序（需登录）
  // 只测量、不写任何配置 —— 想让「自动优选」按延迟挑，去「配置中心 → 优选与候选」
  // 打开「按实测延迟排序」。故意分成两步：先让人看清「谁快」，再决定要不要据此改规则。
  if (request.method === 'POST' && path === '/__api/latency-probe') {
    const ctx = await dnsContext(request, url, env);
    if (!ctx.host) return json({ error: '无法确定探测目标域名：请配置 PROXY_HOST' }, 500);
    let body = {};
    try { body = await request.json(); } catch { /* 允许空 body：默认测当前优选池 */ }
    let targets = Array.isArray(body.targets)
      ? body.targets.map((x) => String(x || '').trim()).filter(Boolean)
      : [];
    if (!targets.length) {
      const cfg = await readSettings(env);
      targets = [...new Set([...(cfg.pool_good_ips || []), ...(cfg.preferred_ips || [])])];
    }
    if (!targets.length) {
      return json({ error: '没有可测的目标：先在优选池里填 IP，或在请求里给 targets' }, 400);
    }
    const r = await probeLatency(targets, { ...ctx, env });
    if (r.error) return json({ error: r.error }, 500);
    const s = r.stats || {};
    const msg = s.good
      ? `实测 ${s.total} 个：通 ${s.good} 个（最快 ${s.fastest} ms，最慢 ${s.slowest} ms）`
        + (s.bad ? `，不通 ${s.bad} 个` : '')
        + (s.stoppedEarly ? '｜预算用尽，只测了部分' : '')
      : `实测 ${s.total} 个：没有一个连通`;
    return json({
      ok: true, host: ctx.host, items: r.items, ranked: r.ok, stats: s, message: msg,
    });
  }

  // 优选 IP 池（PREF_IPS，仅 DNS 自动优选用，与 edgetunnel 的 ADD.txt 解耦）：
  // GET 读取 / POST 保存（apply=true 时先测通再更新 DNS A 记录）。
  //
  // 字段、解析口径与条数上限全部来自运行参数注册表（settings.js 的 preferred_ips，store: 'kv'）：
  // 这里不再自己读 KV、也不再自己写上限判断 —— 面板存进去的、运行时读出来的、这个接口返回的，
  // 必然是同一批 IP（见 check-single-source 的「落盘条数 = 面板上限」用例）。
  // 同上，键名与面板/注册表一致：preferred_ips。
  // 曾经这里收 ips —— 面板发 preferred_ips，接口取到 undefined，blankList(undefined) 为真
  // 于是跳过校验直接把空值写进去：返回「已保存」，池子却被清空（或什么都没变）。
  if (path === '/__api/preferred-ips') {
    if (request.method === 'GET') {
      const cfg = await readSettings(env);
      // 顺带回带浏览器测速的运行参数：订阅拉不到候选时前端走「当前池」兜底，
      // 那条路同样要按注册表里的数字来跑 —— 兜底路径写死一份就等于另一套真源。
      return json({ ok: true, preferred_ips: cfg.preferred_ips, limit: cfg.pool_limit, limits: pickLimits(cfg) });
    }
    if (request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'invalid json' }, 400);
      }
      // 「非空输入却一条都没留下」要当场说清楚：否则就是「提示保存成功、池子其实是空的」。
      // 用 util.js 的同一个解析器做这个判断（它就是注册表读写共用的那一份），不另立规则。
      if (!blankList(body.preferred_ips) && !parseIpv4List(body.preferred_ips).length) {
        return json({ error: '没有有效的 IP（每行一个 IPv4 地址，每段需在 0~255）' }, 400);
      }
      const r = await saveSettings(env, { preferred_ips: body.preferred_ips });
      if (r && r.error) return json({ error: r.error }, 400);
      const uniq = r.values.preferred_ips;
      let updated = null;
      if (body.apply && uniq.length) {
        // 立即应用：并发 HTTP 探测过滤不可达 IP，再写入 A 记录（应用后自检，不可用自动回滚）
        const ctx = await dnsContext(request, url, env);
        if (!ctx.host) {
          updated = { ok: false, error: '无法确定优选目标域名：请配置 PROXY_HOST' };
        } else {
          const usable = await filterUsableIps(uniq, { host: ctx.host, deadlineMs: ctx.deadlineMs, budgetMs: 10000 });
          // 与「立即更新优选 IP」（/__api/dns-run）同一套排序：通断过滤之后按浏览器测速表重排。
          // 少了这一步，手动应用这条路就会退回「谁先探到谁在前」—— 两条入口一个口径，才不会
          // 出现「点按钮 A 有序、点按钮 B 乱序」这种查不出来的偏差。
          const ranked = await rankByPickSpeed(env, usable, {});
          const pickNote = ranked.applied ? `按浏览器测速排序（命中 ${ranked.matched}/${usable.length} 个）`
            : (ranked.reason === 'stale' ? '浏览器测速结果已过期，本次按服务端探测顺序' : '');
          const res = await applyDnsWithSelfCheck(env, ranked.ips, ctx);
          updated = {
            ok: res.ok, ips: res.ips || [], changed: res.changed || 0, verified: res.verified,
            error: res.error, host: ctx.host,
            note: [pickNote, res.note || ''].filter(Boolean).join('｜'),
          };
        }
      }
      // 回带落盘后的值，面板才能立刻把「保存后的真值」显示出来（而不是留着用户填的原文）
      return json({ ok: true, preferred_ips: uniq, count: uniq.length, updated });
    }
  }

  // GET /__api/preferred-candidates -> 从**订阅链接**拉取节点 IP 作为浏览器优选候选
  // 来源优先级：面板「订阅链接」→ 环境变量 SUB_URL → 自动推导的本机 /sub（token 口径与 edgetunnel 一致）。
  // 默认只返回归属边缘网络的 IP：订阅里常混入第三方节点，不筛会让优选池被无用 IP 占满、
  // 并让「立即更新优选 IP」逐个探测这些不可达地址直到超时。过滤开关与条数上限都是运行参数，面板可改。
  if (request.method === 'GET' && path === '/__api/preferred-candidates') {
    const cfg = await readSettings(env);
    const limits = pickLimits(cfg);
    let res;
    try {
      res = await fetchSubscriptionCandidates(env, {
        origin: url.origin,
        hostname: (await resolveProxyHost(env, url.hostname)) || url.hostname,
        limit: cfg.candidate_limit || CANDIDATE_LIMIT,
        strict: cfg.sub_strict !== false,
        signal: AbortSignal.timeout(
          Number(cfg.pick_candidate_timeout_ms) || SETTINGS_SPEC.pick_candidate_timeout_ms.default
        ),
      });
    } catch (e) {
      // 失败也要回带 limits：前端这条报错分支后面还会走「当前池」兜底，拿不到参数就跑不动
      return json({ ok: false, ips: [], limits, error: '候选拉取异常：' + (e && e.message ? e.message : e) }, 502);
    }
    return json({
      ok: true,
      ips: res.ips,
      limits,
      source: res.source,
      note: res.note || '',
      stats: { addresses: res.addresses || 0, filtered: res.filtered || 0, ranges: res.ranges || '' },
    });
  }

  // GET / POST /__api/pick-speed -> 浏览器测速结果（{ip: 毫秒}）的读写
  //
  // 为什么要单独存一份：浏览器自动优选是全局唯一能从**用户网络**出发测量的入口，
  // 但它测完只把 IP 名单填进优选池，延迟数字当场丢掉 —— 服务端自动优选走二值判定，
  // 顺序又变回「谁先探到谁在前」，用户测出来的快慢等于白测。
  // 存下这张表之后，自动优选在**通断过滤之后**用它重排一次，快慢才真的落到 A 记录上。
  // 这是运行数据而非配置项，所以不进运行参数注册表（与 HC_LAST_RUN 同一类）。
  if (path === '/__api/pick-speed') {
    if (request.method === 'GET') {
      const { ts, ms } = await readPickSpeed(env);
      const cfg = await readSettings(env);
      const ttl = Number(cfg.pick_speed_ttl_ms) || SETTINGS_SPEC.pick_speed_ttl_ms.default;
      const items = Object.entries(ms).map(([ip, msec]) => ({ ip, ms: msec })).sort((a, b) => a.ms - b.ms);
      return json({
        ok: true, ts, ttl, items,
        enabled: cfg.pick_speed_enabled !== false,
        stale: !ts || Date.now() - ts > ttl,
        spread: spread(items.map((x) => x.ms)),
      });
    }
    if (request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      const r = await savePickSpeed(env, body.items);
      if (!r.ok) return json({ error: '没有有效条目：需要 [{ip, ms}]，ip 为 IPv4、ms 为非负数' }, 400);
      return json({
        ok: true, n: r.n, total: r.total || r.n, ts: r.ts,
        message: `已记住 ${r.n} 个 IP 的延迟，下次自动优选按它排序`,
      });
    }
  }

  // GET / POST /__api/pool-slow -> 慢节点名单（用户侧实测明显慢、不进候选的 IP）
  //
  // 健康检查以前只判通不通：一个 800ms 才响应的节点只要返回 200，就能一直占着 A 记录。
  // 这里补上快慢这一维，但**只用浏览器测速的数字**（服务端探测的快慢跟用户网络无关，
  // 拿它淘汰会把「对你最快」的节点误杀 —— 实测两个视角的排序近似零相关）。
  if (path === '/__api/pool-slow') {
    if (request.method === 'GET') {
      const s = await readSlowIps(env);
      const cfg = await readSettings(env);
      return json({
        ok: true, ts: s.ts, ips: s.ips, enabled: cfg.hc_slow_evict !== false,
        thresholds: {
          factor: cfg.hc_slow_factor, floor_ms: cfg.hc_slow_floor_ms, keep_min: cfg.hc_keep_min,
        },
      });
    }
    if (request.method === 'POST') {
      const r = await computeSlowIps(env);
      return json({
        ok: true, ts: r.ts || 0, ips: r.slow || [], kept: r.kept || [],
        threshold: r.threshold || 0, fastest: r.fastest, reason: r.reason,
        message: r.reason === 'ok'
          ? `判定 ${(r.slow || []).length} 个慢节点（快于 ${Math.round(r.threshold || 0)}ms 的保留 ${(r.kept || []).length} 个）`
          : (r.reason === 'stale' ? '测速结果已过期，慢名单已清空' : (r.reason === 'disabled' ? '开关已关闭，慢名单已清空' : `样本不足，不判定（${r.reason}）`)),
      });
    }
  }

  // GET / POST /__api/sub-config -> 订阅链接
  //
  // 这一项已经并入统一运行参数（settings.js 的 sub_url），接口保留只为兼容既有页面脚本
  // 与外部调用方：读写都转发到同一份真源，历史独立 KV 键 SUB_URL 由 settings 兜底读取。
  if (path === '/__api/sub-config') {
    if (request.method === 'GET') {
      const cfg = await readSettings(env);
      return json({
        ok: true,
        sub_url: cfg.sub_url,
        env: String((env && (env.SUB_URL || env.sub_url)) || ''),
        effective: (await subscriptionUrl(env, url.origin)) || '',
      });
    }
    if (request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      const v = String(body.sub_url === undefined ? '' : body.sub_url).trim();
      if (v && !/^https?:\/\//i.test(v) && !v.startsWith('/')) {
        return json({ error: '请填写完整 URL（http(s)://…）或以 / 开头的路径（如 /tsub/xxx）' }, 400);
      }
      // 空串在这里有明确语义 = 清空（回退到本机 /sub）：走 clearSetting，
      // 而不是把空值塞进 saveSettings（后者是「留空保持不变」的防误删语义）
      if (v) {
        const r = await saveSettings(env, { sub_url: v });
        if (r && r.error) return json({ error: r.error }, 400);
      } else {
        const r = await clearSetting(env, 'sub_url');
        if (r && r.error) return json({ error: r.error }, 400);
      }
      return json({ ok: true, sub_url: (await readSettings(env)).sub_url });
    }
  }

  // GET / POST /__api/disguise -> 首页伪装配置（模板 / 文案 / 隐蔽入口 / 严格模式）
  // 读取时不返回入口口令明文（sanitize 已剔除），避免口令通过前端或日志二次泄漏。
  if (path === '/__api/disguise') {
    if (request.method === 'GET') {
      const cfg = await readConfig(env);
      return json({ ok: true, config: sanitize(cfg), active: isActive(cfg) });
    }
    if (request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      const patch = {};
      // enabled / strict 用可选布尔，避免前端漏传时被当成 false 静默关闭
      if (body.enabled !== undefined) patch.enabled = body.enabled === true;
      if (body.strict !== undefined) patch.strict = body.strict !== false;
      for (const k of ['template', 'title', 'subtitle', 'contact', 'custom_html', 'path']) {
        if (body[k] !== undefined) patch[k] = String(body[k]).trim();
      }
      if (body.token !== undefined) {
        const t = String(body.token).trim();
        // 传空串表示清空口令；非空才覆盖，避免误操作把已配好的口令抹掉
        if (t) patch.token = t;
        else patch.token = '';
      }
      if (body.items !== undefined) patch.items = Array.isArray(body.items) ? body.items : [];
      if (body.posts !== undefined) patch.posts = Array.isArray(body.posts) ? body.posts : [];
      const r = await saveConfig(env, patch);
      if (r && r.error) return json({ error: r.error }, 400);
      return json({ ok: true, config: r, active: isActive(r) });
    }
  }

  // ---- 站点模式注册表：展示文案 / 徽标 / 说明 / 执行引擎（KV 可编辑，未配置用默认） ----
  if (path === '/__api/site-modes') {
    if (request.method === 'GET') {
      return json({ ok: true, modes: await getSiteModes(), engines: SITE_ENGINES, badgeClasses: BADGE_CLASSES, builtin: ['normal', 'media', 'ai'] });
    }
    if (request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      try {
        const saved = await saveSiteModes(body.modes);
        return json({ ok: true, modes: saved });
      } catch (e) {
        return json({ error: '保存失败：' + String(e && e.message || e).slice(0, 200) }, 400);
      }
    }
  }

  // ---- R2 媒体缓存策略：保留天数（KV 可编辑）+ 立即清理过期分片 ----
  if (path === '/__api/r2-cache') {
    if (request.method === 'GET') {
      // 顺带统计当前缓存用量（遍历 R2 对象汇总，最多扫 200 页防止面板被拖垮；量大时标注约数）
      let stat = null;
      if (env && env.MEDIA_R2) {
        let bytes = 0, count = 0, cursor, pages = 0;
        do {
          const l = await env.MEDIA_R2.list({ prefix: R2_PREFIX, cursor, limit: 1000 }).catch(() => null);
          if (!l || !l.objects || !l.objects.length) break;
          for (const o of l.objects) { bytes += o.size; count++; }
          cursor = l.truncated ? l.cursor : undefined;
          pages++;
        } while (cursor && pages < 200);
        stat = { count, bytesMB: Math.round(bytes / 1048576), truncated: pages >= 200 };
      }
      return json({ ok: true, config: await readR2Config(), spec: R2_CACHE_SPEC, bound: !!(env && env.MEDIA_R2), stat });
    }
    if (request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      if (body && body.action === 'clean') {
        try { await sweepMediaR2(env); return json({ ok: true, cleaned: true }); }
        catch (e) { return json({ error: '清理失败：' + String(e && e.message || e).slice(0, 200) }, 400); }
      }
      try {
        const saved = await saveR2Config({
          enabled: body.enabled,
          ttlDays: body.ttlDays,
          maxObjectMB: body.maxObjectMB,
          maxTotalMB: body.maxTotalMB,
        });
        return json({ ok: true, config: saved });
      } catch (e) {
        return json({ error: '保存失败：' + String(e && e.message || e).slice(0, 200) }, 400);
      }
    }
  }

  // GET / POST /__api/node-config -> 代理节点身份（UUID / 地址 / 路径 / 协议 / 传输 / 指纹 / 订阅名…）
  //
  // 这一组字段在注册表里标了 `store: 'engine'`：它们落在**代理引擎自己的配置文档**
  // （KV config.json）里，因为引擎每次请求都直接读那份文档，搬走就等于同一个设定两份存储。
  // 接口本身不写任何字段名 —— 字段清单取自 panelSpecOf('node-config')，读走 readSettings、
  // 写走 saveSettings（整份读改写，保留引擎的其它键：订阅转换 / 反代 / TG…）。
  //
  // 保存后 router.js 会在把请求交给引擎之前用 engineEnvFor 把有效值回灌成环境变量。
  // 不加这一步，引擎每次请求都会用自己的上下文覆盖 config.json 里的 UUID / HOSTS / PATH，
  // 面板上「保存成功」而订阅输出毫无变化 —— 这正是最初要修的那个「改了不生效」。
  //
  // 订阅 TOKEN 刻意**不在**字段表里：它由 MD5MD5(节点地址 + 节点 ID) 派生，引擎与本项目的
  // subs.js / tempsubs.js 共用同一口径（见 util.md5md5）。旧接口曾提供一个可填的 sub_token，
  // 填了也不生效（引擎每次请求重算 TOKEN），属于典型的「假配置」。这里只如实报出派生结果。
  if (path === '/__api/node-config') {
    const spec = panelSpecOf('node-config');
    if (request.method === 'GET') {
      const cfg = await readSettings(env);
      const values = {};
      const sources = {};
      for (const key of Object.keys(spec)) {
        values[key] = cfg[key];
        sources[key] = await settingsSource(env, key);
      }
      return json({ ok: true, config: values, sources, identity: await nodeIdentity(env, url.hostname) });
    }
    if (request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      const r = await saveSettings(env, body);
      if (r && r.error) return json({ error: r.error }, 400);
      const values = {};
      for (const key of Object.keys(spec)) values[key] = r.values[key];
      return json({
        ok: true,
        config: values,
        saved: (r.saved || []).filter(k => k in spec),
        message: '已保存；下一个订阅请求立即按新值输出（无需重新部署）',
      });
    }
  }

  // ---- 主题：外观统一由 src/themes.js 管理 ----
  // 列表 + 默认主题（读写都需登录）：actors note 面板上有 10 套预设，也可自定义第 11 套。
  if (path === '/__api/themes') {
    if (request.method === 'GET') return json(await listThemes(env));
    if (request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      const patch = {};
      // 只接受认识的配置项：前端多传一个字段不该静默写进存储
      for (const k of ['default_theme', 'rotate_mode', 'rotate_pool', 'rotate_ignore_choice']) {
        if (body[k] !== undefined) patch[k] = String(body[k]).trim();
      }
      if (body.rotate_interval_minutes !== undefined) patch.rotate_interval_minutes = body.rotate_interval_minutes;
      const r = await saveThemeConfig(env, patch);
      if (r && r.error) return json({ error: r.error }, 400);
      return json(await listThemes(env));
    }
  }

  // ---- 自定义主题：新增 / 更新 / 删除（单独的 key，避免与整体配置互相覆盖） ----
  if (path.startsWith('/__api/themes')) {
    const sub = path.replace('/__api/themes', '');
    if (sub === '/custom' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      const r = await upsertCustom(env, { id: body.id, name: body.name, vars: body.vars, extra: body.extra });
      if (r && r.error) return json({ error: r.error }, 400);
      return json({ ok: true, themes: (await listThemes(env)).themes });
    }
    if (sub.startsWith('/custom/') && request.method === 'DELETE') {
      const id = decodeURIComponent(sub.slice('/custom/'.length));
      const r = await removeCustom(env, id);
      if (r && r.error) return json({ error: 'not found' }, 404);
      return json({ ok: true, themes: (await listThemes(env)).themes });
    }
  }

  // ---- 访问统计：开关与保留策略（开关注定影响所有请求的 Shirtidi Launch dimensions） ----
  if (path === '/__api/stats-config') {
    if (request.method === 'GET') {
      return json({ ok: true, config: await readStatsConfig(env) });
    }
    if (request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      const patch = {};
      // 只挑 SPEC 里认识的字段：前端多传一个字段不该写进存储，也不该默默改到别的配置
      for (const k of Object.keys(STATS_SPEC)) {
        if (body[k] !== undefined) patch[k] = body[k];
      }
      const r = await saveStatsConfig(env, patch);
      if (r && r.error) return json({ error: r.error }, 400);
      return json({ ok: true, config: r.values });
    }
  }

  // ---- 访问统计数据：?days=N 指定天数（默认 7，上限为配置的保留天数） ----
  if (request.method === 'GET' && path === '/__api/stats') {
    return json(await summarize(env, url.searchParams.get('days')));
  }
  // ---- 清空统计数据（保留配置）：驾驶舱上的「清空数据」按钮 ----
  if (request.method === 'POST' && path === '/__api/stats/clear') {
    const r = await clearAll();
    return json({ ok: true, removed: r.removed });
  }

  // ---- Cloudflare 用量驾驶舱：直接查 CF 边缘统计（登录保护由 router.js 统一拦截） ----
  if (request.method === 'GET' && path === '/__api/cf-analytics') {
    return json(await cfAnalytics(env));
  }

  // ---- 限流与防滥用 ----
  if (path === '/__api/ratelimit') {
    if (request.method === 'GET') return json({ ok: true, config: await readLimitConfig(env) });
    if (request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      const patch = {};
      for (const k of Object.keys(RATELIMIT_SPEC)) {
        if (body[k] !== undefined) patch[k] = body[k];
      }
      const r = await saveLimitConfig(env, patch);
      if (r && r.error) return json({ error: r.error }, 400);
      return json({ ok: true, config: r.values });
    }
  }
  if (request.method === 'GET' && path === '/__api/ratelimit/bans') {
    return json({ ok: true, bans: await listBans() });
  }
  if (request.method === 'POST' && path === '/__api/ratelimit/clear') {
    return json({ ok: true, cleared: await clearBans() });
  }

  // ---- 告警通知 ----
  if (path === '/__api/alert') {
    if (request.method === 'GET') {
      const cfg = await readAlertConfig(env);
      return json({ ok: true, config: safeAlertConfig(cfg), events: ALERT_EVENTS });
    }
    if (request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      const patch = {};
      for (const k of Object.keys(ALERT_SPEC)) {
        if (body[k] === undefined) continue;
        // 空串表示「不修改」：避免面板漏填把已配好的地址抹掉
        if (k === 'webhook_url' && String(body[k]).trim() === '') continue;
        patch[k] = body[k];
      }
      const r = await saveAlertConfig(env, patch);
      if (r && r.error) return json({ error: r.error }, 400);
      return json({ ok: true, config: safeAlertConfig(r.values) });
    }
  }
  if (request.method === 'POST' && path === '/__api/alert/test') {
    return json({ ok: true, result: await testAlert(env) });
  }
  if (request.method === 'GET' && path === '/__api/alert/recent') {
    return json({ ok: true, items: recentAlerts(), events: ALERT_EVENTS });
  }

  // ---- 站点临时访问链接 ----
  if (path === '/__api/share-config') {
    if (request.method === 'GET') return json({ ok: true, config: await readShareConfig(env) });
    if (request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      const patch = {};
      for (const k of Object.keys(SHARE_SPEC)) {
        if (body[k] !== undefined) patch[k] = body[k];
      }
      const r = await saveShareConfig(env, patch);
      if (r && r.error) return json({ error: r.error }, 400);
      return json({ ok: true, config: r.values });
    }
  }
  if (path === '/__api/shares') {
    if (request.method === 'GET') {
      // 顺带把可直接复制的完整路径拼好：前缀可配，前端不该自己拼
      const cfg = await readShareConfig(env);
      const shares = (await listShares(env)).map(s => ({ ...s, path: linkPath(cfg, s.token) }));
      return json({ ok: true, config: cfg, shares });
    }
    if (request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      const r = await createShare(env, body);
      if (r && r.error) return json({ error: r.error }, 400);
      return json({ ok: true, share: r.share, path: r.path });
    }
  }
  if (path.startsWith('/__api/shares/')) {
    const rest = path.slice('/__api/shares/'.length);
    const [token, action] = rest.split('/');
    if (request.method === 'DELETE' && token) {
      const r = await deleteShare(decodeURIComponent(token));
      if (r && r.error) return json({ error: r.error }, 404);
      return json({ ok: true, shares: await listShares(env) });
    }
    if (request.method === 'POST' && action === 'revoke') {
      const r = await revokeShare(decodeURIComponent(token));
      if (r && r.error) return json({ error: r.error }, 404);
      return json({ ok: true, shares: await listShares(env) });
    }
    if (request.method === 'POST' && action === 'enable') {
      const r = await enableShare(decodeURIComponent(token));
      if (r && r.error) return json({ error: r.error }, 404);
      return json({ ok: true, shares: await listShares(env) });
    }
  }

  // GET / POST /__api/node-tag -> 节点备注的国家标注（开关 + 样式）
  //
  // 两个字段都是注册表成员（settings.js 的 node_tag_enabled / node_tag_style，store: 'kv'），
  // 所以这里既不写真名也不写映射表：请求体就是注册表的字段名，写入直接走 saveSettings。
  // 曾经这里有一层 {enabled, style} → KV 的翻译，而 nodetag.js 那边又只认环境变量 ——
  // 于是「面板改了样式、订阅输出没变」。现在取值只有 readSettings 一条路。
  //
  // 保存其实是成功的，但 GET 返回的是领域里的短名（enabled / style）而不是注册表字段名
  // （node_tag_enabled / node_tag_style）：面板按 data-key 取值，一个都匹配不上，
  // 于是两个控件永远显示空白 —— 用户看到的就是「保存了，但没保存上」。
  // 这里把返回值投影回注册表字段名，来源标注作为附带信息保留。
  async function tagPanelConfig(env) {
    const t = await readTagSettings(env);
    return {
      node_tag_enabled: t.enabled,
      node_tag_style: t.style,
      sourceOn: t.sourceOn,
      sourceStyle: t.sourceStyle,
    };
  }

  if (path === '/__api/node-tag') {
    if (request.method === 'GET') return json({ ok: true, config: await tagPanelConfig(env) });
    if (request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      const r = await saveSettings(env, body);
      if (r && r.error) return json({ error: r.error }, 400);
      return json({ ok: true, config: await tagPanelConfig(env) });
    }
  }

  // GET /__api/disguise-preview -> 伪装页预览（需登录）。
  // 带 gate cookie 的管理员平时看到的是真面板，用这个端点才能自查访客视角。
  if (request.method === 'GET' && path === '/__api/disguise-preview') {
    const cfg = await readConfig(env);
    return renderHome(cfg, request);
  }

  // GET /__api/pool-config -> 可用集 & 候选域名池 & 上次健康检查时间，需登录
  // POST /__api/pool-config -> 保存候选域名池（{pref_domains}）或写回可用集（{good_ips}，healthcheck 自愈用），需登录
  //
  // 两个池子都是注册表成员（settings.js 的 pool_good_ips / pref_domains，store: 'kv'），
  // 条数上限来自 pool_limit / domain_pool_limit。返回结构保持不变：healthcheck.yml 依赖
  // {good_ips, pref_domains, limits}；env 变量 PREF_DOMAINS 作为种子由注册表三级取值处理
  // （旧实现在 GET 里顺手把种子写回 KV —— 读接口不该有写副作用，已去掉）。
  if (path === '/__api/pool-config') {
    if (request.method === 'GET') {
      const cfg = await readSettings(env);
      let last = 0;
      try { const l = await runtime.KV.get('HC_LAST_RUN'); if (l) last = parseInt(l, 10) || 0; } catch {}
      return json({
        ok: true,
        pool_good_ips: cfg.pool_good_ips,
        pref_domains: cfg.pref_domains,
        last_run: last,
        limits: { ips: cfg.pool_limit, domains: cfg.domain_pool_limit },
      });
    }
    if (request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      const patch = {};
      // 非空输入却一条都没留下 = 直接说清楚（与 preferred-ips 同一条判断，都走 util.js 的解析器）
      // 键名同样只用注册表那一套（pool_good_ips）：旧的 good_ips 与面板发的 pool_good_ips
      // 对不上，导致「可用集」这一栏存不进去，而同表单里的候选域名池（pref_domains 同名）能存 ——
      // 同一张卡片一半生效一半不生效，最难排查的那种。
      if (body.pool_good_ips !== undefined) {
        if (!blankList(body.pool_good_ips) && !parseIpv4List(body.pool_good_ips).length) {
          return json({ error: '没有有效的 IP（每行一个 IPv4 地址，每段需在 0~255）' }, 400);
        }
        patch.pool_good_ips = body.pool_good_ips;
      }
      if (body.pref_domains !== undefined) {
        if (!blankList(body.pref_domains) && !parseDomainList(body.pref_domains).length) {
          return json({ error: '请输入有效域名（每行一个）' }, 400);
        }
        patch.pref_domains = body.pref_domains;
      }
      if (!Object.keys(patch).length) return json({ error: '没有可保存的字段（pool_good_ips / pref_domains）' }, 400);
      const r = await saveSettings(env, patch);
      if (r && r.error) return json({ error: r.error }, 400);
      const out = { ok: true };
      if (body.pool_good_ips !== undefined) out.pool_good_ips = r.values.pool_good_ips;
      if (body.pref_domains !== undefined) out.pref_domains = r.values.pref_domains;
      return json(out);
    }
  }

  // GET /__api/speedtest -> 从 Worker 侧测各站点上游「代理服务器→目标站」延迟，定位瓶颈段
  if (request.method === 'GET' && path === '/__api/speedtest') {
    const sites = await listSites();
    const results = await Promise.all(sites.map(async (s) => {
      const base = s.target.replace(/\/+$/, '');
      const t0 = performance.now();
      let latency = null, status = 'timeout';
      try {
        const r = await fetch(base + '/', { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(6000) });
        latency = Math.round(performance.now() - t0);
        status = r.status;
      } catch {
        latency = Math.round(performance.now() - t0);
        status = 'unreachable';
      }
      return { id: s.id, name: s.name, host: s.host, latency_ms: latency, status };
    }));
    return json({ ok: true, results });
  }

  // GET /__api/sites
  if (request.method === 'GET' && path === '/__api/sites') {
    try {
      const resp = json({ ok: true, sites: await listSites() });
      // 边缘缓存 3s：KV list 回源较慢，避免每次请求都回源（写操作后前端带 ?t= 刷新，3s 内可能旧，可接受）
      resp.headers.set('Cache-Control', 'max-age=3');
      return resp;
    } catch (err) {
      // 不让 KV 瞬时故障变成 Worker 1101；前端可显示明确错误并提供重试。
      return json({ ok: false, error: '站点列表暂时不可用，请稍后重试' }, 503);
    }
  }

  // POST /__api/sites  -> 添加站点
  if (request.method === 'POST' && path === '/__api/sites') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'invalid json' }, 400);
    }
    const name = (body.name || '').trim();
    let slug = (body.slug || '').trim();
    const target = (body.target || '').trim();
    const port = (body.port || '').trim();

    if (!name) return json({ error: '缺少中文名称' }, 400);

    // 访问后缀：自定义或自动生成
    if (slug) {
      if (!validSlug(slug)) return json({ error: '访问后缀仅限字母/数字/-/_，且不超过40位' }, 400);
      if (await getSite(slug)) return json({ error: `访问后缀 ${slug} 已存在，请换一个` }, 400);
    } else {
      slug = await autoSlug();
    }

    const built = buildTarget(target, port);
    if (!built) return json({ error: '网址不合法（请填写域名或 http/https 完整地址）' }, 400);

    // 同 host+port 已存在则直接复用，避免重复站点
    const existing = await listSites();
    const dup = existing.find(s => s.host === built.host && (s.port || '') === (built.port || ''));
    if (dup) return json({ ok: true, site: dup, reused: true }, 200);

    const site = await addSite(name, slug, built);
    // 站点模式字段（新增时可选传入，默认 normal）：模式键白名单 = 注册表（含自定义键），
    // 并把「键 → 执行引擎」解析结果冗余进 site.engine（proxy.js 运行期零 KV 依赖）
    if (body.proxyMode !== undefined) {
      const mode = String(body.proxyMode);
      const all = await getSiteModes().catch(() => DEFAULT_SITE_MODES);
      if (Object.prototype.hasOwnProperty.call(all, mode)) {
        site.proxyMode = mode;
        site.engine = resolveEngine(site, all);
      }
    }
    if (body.mediaCacheAuthBind) site.mediaCacheAuthBind = true;
    if (body.mediaSkipDetailLog) site.mediaSkipDetailLog = true;
    if (site.proxyMode === 'ai') {
      if (body.aiKey !== undefined) site.aiKey = String(body.aiKey).trim();
      if (body.aiKeys !== undefined) site.aiKeys = String(body.aiKeys).trim();
    }
    if (site.proxyMode || site.mediaCacheAuthBind || site.mediaSkipDetailLog) {
      await runtime.KV.put(kvKey(slug), JSON.stringify(site));
      // 这是**第二次** put（补写 mode 字段），addSite() 里那次作废已经用掉了，
      // 不清的话缓存窗口里读到的还是没带这些字段的那一版。
      //
      // ⚠️ 如实标注：这一处**目前没有检查盯住**。它藏在「站点运行在错误的引擎上」这一类
      // 静默行为里，需要在反代链路上观测才能显形，`check-smoke` 第 [10] 段验到的那三条
      // （列表 / 打开 / 改 slug）都够不到这里。留下它是因为它防的问题是真实的，
      // 但请不要以为它被覆盖着 —— 要让一个防御真的算数，得有意识地给它写检查。
      invalidateSite(slug);
    }
    return json({ ok: true, site }, 201);
  }

  // /__api/sites/:id  -> 更新 / 删除
  const m = path.match(/^\/__api\/sites\/([^/]+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const site = await getSite(id);
    if (!site) return json({ error: 'not found' }, 404);

    if (request.method === 'DELETE') {
      await runtime.KV.delete(kvKey(id));
      invalidateSite(id);
      return json({ ok: true });
    }

    if (request.method === 'PUT') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'invalid json' }, 400);
      }
      // 编辑访问后缀（slug / id）：变更则迁移 KV（新 key 写入 + 旧 key 删除）
      let keyId = id;
      let renamedFrom = '';
      if (body.slug !== undefined && String(body.slug).trim() !== '' && String(body.slug).trim() !== id) {
        const ns = String(body.slug).trim();
        if (!validSlug(ns)) return json({ error: '后缀格式不合法（字母数字 - _，最长 40）' }, 400);
        if (await getSite(ns)) return json({ error: '该后缀已被占用' }, 400);
        site.id = ns;
        await runtime.KV.put(kvKey(ns), JSON.stringify(site));
        await runtime.KV.delete(kvKey(id));
        renamedFrom = id;
        keyId = ns;
      }
      if (body.name !== undefined && String(body.name).trim() !== '') site.name = String(body.name).trim();
      // 站点模式字段（编辑弹窗新增）：模式键白名单 = 注册表（含自定义键），
      // 并把「键 → 执行引擎」解析结果冗余进 site.engine（proxy.js 运行期零 KV 依赖）
      if (body.proxyMode !== undefined && String(body.proxyMode).trim() !== '') {
        const mode = String(body.proxyMode);
        const all = await getSiteModes().catch(() => DEFAULT_SITE_MODES);
        if (Object.prototype.hasOwnProperty.call(all, mode)) {
          site.proxyMode = mode;
          site.engine = resolveEngine(site, all);
        }
      }
      if (body.mediaCacheAuthBind !== undefined) site.mediaCacheAuthBind = !!body.mediaCacheAuthBind;
      if (body.mediaSkipDetailLog !== undefined) site.mediaSkipDetailLog = !!body.mediaSkipDetailLog;
      if (site.proxyMode === 'ai') {
        if (body.aiKey !== undefined && String(body.aiKey).trim() !== '') site.aiKey = String(body.aiKey).trim();
        if (body.aiKeys !== undefined && String(body.aiKeys).trim() !== '') site.aiKeys = String(body.aiKeys).trim();
      }
      const wantTarget = (body.target !== undefined && String(body.target).trim() !== '') || (body.port !== undefined && String(body.port).trim() !== '');
      if (wantTarget) {
        const built = buildTarget(
          (body.target !== undefined && String(body.target).trim() !== '') ? body.target : site.target,
          (body.port !== undefined && String(body.port).trim() !== '') ? body.port : site.port);
        if (!built) return json({ error: '网址不合法' }, 400);
        site.target = built.url;
        site.host = built.host;
        site.scheme = built.scheme;
        site.port = built.port;
      }
      await runtime.KV.put(kvKey(keyId), JSON.stringify(site));
      // 写入后统一清理：所有分支的缓存作废都收在这一处。
      // 曾经散成三份（改名分支里「清新 + 清旧」，末尾再清一次 keyId）——
      // 三选二就够用，于是砍掉任何一份检查都不会红：看着是双保险，实际谁都没被验住。
      // 收拢之后，下面每一行被删掉都立刻有对应的检查变红。
      invalidateSite(keyId);
      if (renamedFrom) invalidateSite(renamedFrom);   // 旧 slug 只在这里有机会被摘掉
      return json({ ok: true, site });
    }
  }

  // ===================== 临时订阅管理 API（均需登录，已由 router.js 拦截）=====================
  // 列表：返回每条记录及其当前状态与完整订阅链接
  if (path === '/__api/tempsubs') {
    if (request.method === 'GET') {
      const items = await tempsubs.listAll();
      const out = items.map((r) => ({
        ...r,
        active: tempsubs.isActive(r),
        sub_url: `${url.origin}/tsub/${encodeURIComponent(r.id)}`,
      }));
      return json({ ok: true, items: out });
    }
    if (request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch {}
      const rec = await tempsubs.create({ name: body.name, days: body.days });
      return json({ ok: true, item: { ...rec, active: true, sub_url: `${url.origin}/tsub/${encodeURIComponent(rec.id)}` } }, 201);
    }
  }

  const tm = path.match(/^\/__api\/tempsubs\/([^/]+)$/);
  if (tm) {
    const id = decodeURIComponent(tm[1]);
    const rec = await tempsubs.get(id);
    if (!rec) return json({ error: '临时订阅不存在或已删除' }, 404);

    if (request.method === 'DELETE') {
      await tempsubs.remove(id);
      return json({ ok: true });
    }

    if (request.method === 'PUT') {
      let body = {};
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      const updated = await tempsubs.update(id, { name: body.name, days: body.days, disabled: body.disabled });
      return json({ ok: true, item: { ...updated, active: tempsubs.isActive(updated), sub_url: `${url.origin}/tsub/${encodeURIComponent(updated.id)}` } });
    }
  }

  return json({ error: 'not found' }, 404);
}

// ===================== 登录 / 鉴权 =====================

/** 站点徽标：从注册表取展示文案与样式类，未登记的模式回退普通 */
async function renderSiteBadge(mode, modes) {
  const m = modes[mode] || modes.normal || DEFAULT_SITE_MODES.normal;
  return `<span class="tag ${esc(m.badgeClass)}">${esc(m.badge)}</span>`;
}

async function adminPage(authed, origin, env) {
  // 站点模式注册表（KV 可编辑，未配置用默认）：编辑弹窗选项、站点列表徽标都由它渲染
  const modes = await getSiteModes().catch(() => DEFAULT_SITE_MODES);
  const modeOptions = Object.entries(modes)
    .map(([k, v]) => `<option value="${esc(k)}">${esc(v.label)}</option>`)
    .join('');
  // 系统配置字典（代码级真源，只读）：集中列出系统所有字典 / 注册表的当前可用项
  // 真源位置在标注的模块文件里，面板只读展示；可编辑的注册表（站点模式）在配置中心单独维护
  let dictHtml = '<div class="empty">字典加载失败</div>';
  let dictGroups = 0;
  try {
    const dicts = [
      { title: '访问渠道注册表', src: 'src/scopes.js', items: VISIT_SCOPES.map(s => `${s.id} · ${s.label}（${s.prefixes.join(' ')}）`) },
      { title: '统计档位（天）', src: 'src/stats.js', items: STATS_RANGES.map(d => `${d} 天`) },
      { title: '告警事件', src: 'src/alert.js', items: ALERT_EVENTS.map(e => `${e.id} · ${e.label}：${e.desc}`) },
      { title: '伪装模板', src: 'src/disguise.js', items: listTemplates().map(t => `${t.id}：${t.desc}`) },
      { title: '执行引擎词表', src: 'src/site-modes.js', items: SITE_ENGINES },
      { title: '徽标色板', src: 'src/site-modes.js', items: BADGE_CLASSES },
    ];
    dictGroups = dicts.length;
    dictHtml = dicts.map(g => `
    <div class="dict-group" style="margin:12px 0 0;">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px;">
        <b>${esc(g.title)}</b><span class="tag" style="font-weight:400;">真源 ${esc(g.src)}</span>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">${g.items.map(i => `<span class="tag">${esc(i)}</span>`).join('')}</div>
    </div>`).join('');
  } catch {}
  // 服务端直接渲染站点列表（首屏秒开，不依赖前端 fetch；前端 load() 仅用于增删/操作后刷新）
  // 页面上展示的「优选目标域名」由配置推导，不写死任何域名
  const pageHost = await resolveProxyHost(env, String(origin || '').replace(/^https?:\/\//i, '').split(/[/?#]/)[0].split(':')[0]);
  // 统一运行参数：面板里的运维入口（健康检查按钮）与各处默认值都从这一份取，不再只认环境变量
  let runCfg = {};
  try { runCfg = await readSettings(env); } catch {}
  const ghActionsUrl = String(runCfg.gh_actions_url || '');
  // 首页伪装配置：面板里展示当前状态；口令是否已设置只给出布尔，不把明文带上管理页 HTML
  let dgCfg = null;
  try { dgCfg = await readConfig(env); } catch {}
  // R2 媒体缓存策略（KV 可编辑）：面板展示当前值并可在配置中心修改
  let r2Cfg = null;
  try { r2Cfg = await readR2Config(); } catch {}
  const r2Bound = !!(env && env.MEDIA_R2);
  const hasToken = !!(dgCfg && dgCfg.token);
  let listHtml = '<div class="empty">加载中…</div>';
  try {
    const sites = await listSites();
    listHtml = sites.length
      ? (await Promise.all(sites.map(async s => `<div class="site">
      <div class="site-head">
        <span class="site-name">${esc(s.name)} <span class="tag">${esc(s.id)}</span>${await renderSiteBadge(s.proxyMode, modes)}</span>
        ${authed ? `<span style="display:inline-flex;gap:6px;"><button type="button" class="mini" data-edit="${esc(s.id)}">编辑</button><button type="button" class="danger mini" data-del="${esc(s.id)}">删除</button></span>` : ''}
      </div>
      <div class="site-target">目标：${esc(s.target)}${s.port ? `（端口 ${esc(s.port)}）` : ''} <span class="tag latency" data-id="${esc(s.id)}">上游测速中…</span></div>
      <div class="site-actions">
        <a class="site-link" href="/p/${esc(s.id)}/" target="_blank" rel="noopener">访问链接：${origin}/p/${esc(s.id)}/</a>
      </div>
      <div class="site-actions">
        <button type="button" class="mini" data-copy="${origin}/p/${esc(s.id)}/" data-copymsg="copyMsg-${esc(s.id)}">复制代理后链接</button>
        <button type="button" class="mini" data-copy="${esc(s.target)}" data-copymsg="copyMsg-${esc(s.id)}">复制代理前链接</button>
        <span class="msg" id="copyMsg-${esc(s.id)}"></span>
      </div>
    </div>`))).join('')
      : `<div class="empty">${authed ? '还没有站点，先在上方添加一个。' : '还没有代理站点。'}</div>`;
  } catch {}
  // 外观主题：可用清单、默认主题、配套 CSS 与「首屏防闪」脚本全部由 src/themes.js 给出，
  // 这里只把色卡渲染成页面上的选择项。以后增删主题不需要改这个文件。
  const themeView = await listThemes(env).catch(() => ({
    themes: [],
    default_theme: DEFAULT_PRESET_ID,
    allow_switch: true,
    allow_custom: true,
    remember_user: true,
    auto_dark_theme: '',
  }));
  const themeIds = themeView.themes.map(t => t.id);
  // 轮换间隔的默认值与区间不在这里写死：从 themes.js 的字段声明取，面板与运行期共用一份
  const rtBounds = themeFieldBounds('rotate_interval_minutes');
  // 轮换：interval 模式由服务端按时间片算出「这一刻该用哪套」（与地域无关，全球一致）；
  // visit 模式服务端先随机一套，客户端脚本在每次加载时再抽一次（不写进存储，纯新鲜感）。
  const rotateId = rotatingTheme(themeView, themeIds);
  const effectiveTheme = rotateId || themeView.default_theme;
  const themeScript = applyScript(
    { ...themeView, default_theme: effectiveTheme },
    themeIds,
    rotatePool(themeView, themeIds)
  );
  // 「跟随系统」要落到具体主题 id 上：浅色用当前生效主题，深色用配置的夜间主题
  const themePreview = {
    lightId: effectiveTheme,
    darkId: themeView.auto_dark_theme
      || (themeView.themes.find(t => t.scheme === 'dark') || themeView.themes[0] || {}).id
      || effectiveTheme,
  };
  const themeCards = themeView.themes.length
    ? themeView.themes.map(t => `
      <button type="button" class="theme-card${t.id === themeView.default_theme ? ' active' : ''}" data-theme-id="${esc(t.id)}" data-custom="${t.custom ? '1' : '0'}">
        <span class="swatch" style="background:${esc(t.swatch.card)}">
          <i style="background:${esc(t.swatch.bg)}"></i>
          <i style="background:${esc(t.swatch.accent)}"></i>
          <i style="background:${esc(t.swatch.txt)}"></i>
        </span>
        <span class="meta"><b>${esc(t.name)}</b><em>${esc(t.desc)}</em></span>
      </button>`).join('')
    : '<div class="empty">没有可用主题</div>';
  const html = `<!DOCTYPE html>
<html lang="zh-CN" data-theme="${esc(effectiveTheme)}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Any-Proxy · 统一代理管理</title>
  <style>
  ${baseVarsCss()}
  ${await themeCss(env)}
  * { box-sizing:border-box; }
  html, body { -webkit-text-size-adjust:100%; }
  body { margin:0; font-family:-apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif; background:var(--bg); color:var(--txt); min-height:100vh; font-size:14px; line-height:1.6; -webkit-font-smoothing:antialiased; }
  .wrap { max-width:860px; margin:0 auto; padding:32px 16px 64px; }
  .topbar { display:flex; align-items:flex-start; justify-content:space-between; gap:var(--sp-3); margin-bottom:var(--sp-4); flex-wrap:wrap; }
  .auth-box { display:flex; gap:var(--sp-1); align-items:center; flex-wrap:wrap; }
  button, input, textarea, select { font-family:inherit; }
  button.ghost { background:transparent; color:var(--muted); border:1px solid var(--line); padding:8px 14px; border-radius:var(--radius-sm); font-size:13px; cursor:pointer; transition:color .15s, border-color .15s, background .15s; }
  button.ghost:hover { color:var(--txt); border-color:var(--muted); background:var(--hover); }
  a.ghost-link { display:inline-flex; align-items:center; background:transparent; color:var(--muted); border:1px solid var(--line); padding:8px 14px; border-radius:var(--radius-sm); text-decoration:none; font-size:13px; transition:color .15s, border-color .15s, background .15s; }
  a.ghost-link:hover { color:var(--txt); border-color:var(--muted); background:var(--hover); }
  h1 { font-size:22px; margin:0 0 6px; letter-spacing:-.01em; }
  .sub { color:var(--muted); font-size:13px; margin:0 0 var(--sp-4); line-height:1.7; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:var(--radius); padding:var(--card-pad); margin-bottom:var(--sp-3); box-shadow:var(--shadow); transition:border-color .15s, box-shadow .15s; }
  .card > h2:first-child { margin-top:0; }
  .card h2 { font-size:15px; margin:0 0 var(--sp-3); font-weight:600; }
  /* 站点/代理等页的栅格与配置页 .cfg-grid 用同一套列公式（都走 --field-min），
     因此无论窗口多宽，各选项卡的字段宽度都一致 —— 不再出现「某个选项卡比别的窄」 */
  .grid2 { display:grid; grid-template-columns:repeat(auto-fit, minmax(min(var(--field-min), 100%), 1fr)); gap:var(--grid-gap); }
  @media (max-width:560px){ .grid2{ grid-template-columns:1fr; gap:0; } }
  label { display:block; font-size:13px; color:var(--muted); margin:var(--sp-3) 0 6px; }
  input, textarea, select { width:100%; padding:10px 12px; border-radius:var(--radius-sm); border:1px solid var(--line); background:var(--input); color:var(--txt); font-size:14px; outline:none; transition:border-color .15s, box-shadow .15s, background .15s; }
  input:focus, textarea:focus, select:focus, input:focus-visible, textarea:focus-visible, select:focus-visible { border-color:var(--accent); box-shadow:var(--ring); }
  input:hover:not(:focus), textarea:hover:not(:focus), select:hover:not(:focus) { border-color:var(--muted); }
  select { cursor:pointer; }
  textarea { resize:vertical; line-height:1.5; }
  .row { display:flex; gap:var(--sp-2); margin-top:var(--sp-3); flex-wrap:wrap; align-items:center; }
  button { padding:10px 18px; border:none; border-radius:var(--radius-sm); font-size:14px; cursor:pointer; background:var(--accent); color:var(--on-accent); font-weight:600; transition:background .15s, transform .05s, box-shadow .15s; }
  button:hover { background:var(--accent-hover); }
  button:active { transform:translateY(1px); }
  button:focus-visible { outline:none; box-shadow:var(--ring); }
  button.danger { background:transparent; color:var(--err); border:1px solid var(--err); }
  button.danger:hover { background:var(--err-bg); }
  button:disabled { opacity:.5; cursor:not-allowed; transform:none; }
  .badge-ai { background:#dbeafe; color:#1e40af; border-color:#bfdbfe; }
  .badge-blue { background:#dbeafe; color:#1e40af; border-color:#bfdbfe; }
  .badge-purple { background:#ede9fe; color:#5b21b6; border-color:#ddd6fe; }
  .badge-orange { background:#ffedd5; color:#9a3412; border-color:#fed7aa; }
  .badge-red { background:#fee2e2; color:#991b1b; border-color:#fecaca; }
  .mode-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .mode-row > * { min-width:0; }
  .mode-row input, .mode-row select { width:auto; flex:0 1 150px; padding:6px 10px; border-radius:6px; border:1px solid var(--line); background:var(--input); color:var(--txt); font-size:13px; box-sizing:border-box; }
  .mode-key { font-weight:600; min-width:92px; font-size:13px; }
  .site { border:1px solid var(--line); border-radius:var(--radius-sm); padding:var(--sp-3); margin-bottom:var(--sp-2); background:var(--card); transition:border-color .15s, box-shadow .15s; }
  .site:hover { border-color:var(--muted); box-shadow:var(--shadow); }
  .site-head { display:flex; align-items:center; justify-content:space-between; gap:var(--sp-2); flex-wrap:wrap; }
  .site-name { font-weight:600; font-size:14px; }
  .site-target { color:var(--muted); font-size:12px; margin-top:6px; word-break:break-all; }
  .site-link { display:inline-block; margin-top:10px; color:var(--accent); font-size:13px; text-decoration:none; word-break:break-all; transition:color .15s; }
  .site-link:hover { text-decoration:underline; color:var(--accent-hover); }
  .site-actions { display:flex; gap:var(--sp-1); margin-top:var(--sp-2); flex-wrap:wrap; align-items:center; }
  button.mini { min-height:30px; padding:7px 14px; font-size:12px; background:transparent; color:var(--accent); border:1px solid var(--accent); border-radius:var(--radius-xs); cursor:pointer; transition:background .15s, color .15s, border-color .15s; }
  button.mini:hover { background:rgba(37,99,235,.10); }
  button.mini:focus-visible { outline:none; box-shadow:var(--ring); }
  button.danger.mini { color:var(--err); border-color:var(--err); }
  button.danger.mini:hover { background:var(--err-bg); }
  .empty { color:var(--muted); text-align:center; padding:24px 0; font-size:14px; }
  .msg { font-size:12px; margin:4px 0 0; line-height:1.5; min-height:16px; }
  .msg.ok { color:var(--ok); } .msg.err { color:var(--err); }
  .hint { font-size:12px; color:var(--muted); margin:6px 0 0; line-height:1.6; }
  .tag { font-family:ui-monospace,Menlo,Consolas,monospace; font-size:12px; color:var(--muted); background:var(--input); padding:2px 6px; border-radius:6px; border:1px solid var(--line); }
  /* 站点代理类型徽标：流媒体（绿）/ 普通（灰），列表里一眼区分两种模式 */
  .badge-media { background:#dcfce7; color:#166534; border-color:#86efac; }
  .badge-normal { color:var(--muted); background:var(--input); border-color:var(--line); }
  .notice { color:var(--muted); font-size:13px; line-height:1.6; }
  .notice a { color:var(--accent); }
  @media (max-width:640px) {
    .wrap { padding:20px 12px 48px; }
    /* 窄屏卡片略收内边距，但仍由 --card-pad 派生，跟主题一起变 */
    .card { padding:calc(var(--card-pad) - 4px); }
    .topbar { margin-bottom:var(--sp-3); }
    .row { gap:var(--sp-1); }
    button { padding:10px 14px; }
  }
.tabs { display:flex; flex-wrap:wrap; gap:6px; margin:16px 0 2px; padding:4px; background:var(--input); border:1px solid var(--line); border-radius:var(--radius-sm); overflow-x:auto; scrollbar-width:none; }
.tabs::-webkit-scrollbar { display:none; }
.tab { padding:8px 14px; margin:0; width:auto; background:transparent; color:var(--muted); border:none; border-radius:var(--radius-xs); cursor:pointer; font-size:14px; font-weight:500; white-space:nowrap; transition:color .15s, background .15s; }
.tab:hover { background:transparent; color:var(--txt); transform:none; }
.tab:active { transform:none; }
.tab.active { background:var(--card); color:var(--txt); box-shadow:var(--shadow); }
  /* 主题卡片：色卡 + 名称。间距沿用 --sp-*，跟着主题一起变密/变松 */
  .theme-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(180px, 1fr)); gap:var(--sp-2); margin-top:var(--sp-3); }
  .theme-card { display:flex; align-items:center; gap:10px; text-align:left; padding:10px 12px; background:var(--input); color:var(--txt); border:1px solid var(--line); border-radius:var(--radius-sm); cursor:pointer; font-weight:500; transition:border-color .15s, box-shadow .15s; }
  .theme-card:hover { background:var(--hover); border-color:var(--muted); }
  .theme-card.active { border-color:var(--accent); box-shadow:var(--ring); }
  .theme-card .swatch { flex:none; display:flex; width:44px; height:26px; border-radius:6px; overflow:hidden; border:1px solid var(--line); }
  .theme-card .swatch i { flex:1; }
  .theme-card .meta { min-width:0; }
  .theme-card .meta b { display:block; font-size:13px; font-weight:600; }
  .theme-card .meta em { display:block; font-style:normal; font-size:11px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .theme-rows { display:grid; grid-template-columns:1fr; gap:0; }
  /* 配置页：设置表单 / 工具 / 跳转行。样式与渲染同源于 src/config-ui.js，
     布局细节随主题变量走，换主题时这一屏跟着一起变 */
${CONFIG_CSS}
  /* 数据驾驶舱（KPI / 趋势图 / 通道排行），同样只走主题变量 */
${STATS_CSS}
  /* CF 用量驾驶舱（数据来自 Cloudflare 边缘统计，复用 st-* 布局类） */
${CF_CSS}
</style>
${themeScript}
</head>
<body>
<div class="wrap">
  <div class="topbar">
    <div>
      <h1>Any-Proxy · 统一代理管理</h1>
      <div class="sub">一个域名，多站反代 + 优选 IP 代理。添加站点自动生成专属代理前缀 <span class="tag">/p/&lt;id&gt;/...</span>，改配置无需重新部署；登录后同时管理 <b>反代站点</b> 与 <b>代理面板</b>（VLESS 节点/订阅/日志/优选 IP）。</div>
    </div>
    <div class="auth-box">
      <button type="button" class="ghost" id="themeBtn"></button>
      ${authed
        ? '<button type="button" class="ghost" id="logoutBtn">登出</button>'
        : '<a class="ghost-link" href="/__login">登录</a>'}
    </div>
  </div>

  ${authed ? `
  <nav class="tabs" id="paneTabs">
    <button type="button" class="tab" data-tab="sites">站点</button>
    <button type="button" class="tab" data-tab="stats">数据驾驶舱</button>
    <button type="button" class="tab" data-tab="edge">CF 用量</button>
    <button type="button" class="tab" data-tab="proxy">代理节点</button>
    <button type="button" class="tab" data-tab="preferred">优选 IP</button>
    <button type="button" class="tab" data-tab="security">伪装与安全</button>
    <button type="button" class="tab" data-tab="theme">外观主题</button>
    <button type="button" class="tab" data-tab="share">临时链接</button>
    <button type="button" class="tab" data-tab="registry">配置中心</button>
    <button type="button" class="tab" data-tab="config">配置</button>
  </nav>` : ''}

  ${authed ? renderStatsPane() : ''}

  ${authed ? renderCfPane() : ''}

  ${authed ? `
  <div class="card" data-pane="proxy" style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
    <div>
      <h2 style="margin:0 0 4px;">代理管理面板</h2>
      <div class="notice" style="font-size:12px;">VLESS / Trojan / SS 节点订阅、流量日志与优选 IP 配置（edgetunnel），与站点管理共用同一套登录。</div>
    </div>
    <a class="ghost-link" href="/admin" target="_blank" rel="noopener">打开代理面板 →</a>
  </div>` : ''}

  ${authed ? `
  <div class="card" data-pane="proxy">
    <h2>代理节点</h2>
    <div class="hint" style="margin:-8px 0 4px;">订阅里出现的节点身份。字段与取值范围来自运行参数注册表（<span class="tag">src/settings.js</span>），
      与引擎共读同一份配置文档；保存后<b>下一个订阅请求立即按新值输出</b>，不需要重新部署。</div>
    ${settingFormById('node-config')}
    ${settingFormById('sub-config')}
    ${settingFormById('node-tag')}
    ${toolItemsForTab('proxy')}
  </div>` : ''}

  ${authed ? `
  <div class="card" data-pane="proxy" style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
    <div>
      <h2 style="margin:0 0 4px;">临时订阅管理</h2>
      <div class="notice" style="font-size:12px;">创建限时有效的临时订阅链接（独立 UUID，默认 1 天到期），可改有效期、手动置为失效或删除；节点配置与代理面板一致。</div>
    </div>
    <a class="ghost-link" href="/__tsub" target="_blank" rel="noopener">打开临时订阅管理 →</a>
  </div>` : ''}

  ${authed ? `
  <div class="card" id="addCard" data-pane="sites">
    <h2>添加代理站点</h2>
    <div class="hint" style="margin:-8px 0 4px;">填好名称和网址即可，代理前缀自动生成；同域名重复添加会自动复用已有站点。</div>
    <div class="grid2">
      <div>
        <label for="siteName">中文名称</label>
        <input id="siteName" placeholder="例如：我的博客">
      </div>
      <div>
        <label for="siteSlug">访问后缀（可选）</label>
        <input id="siteSlug" placeholder="自定义如 blog；留空自动生成">
      </div>
    </div>
    <label for="siteTarget">网址</label>
    <input id="siteTarget" placeholder="example.com 或 https://example.com（自动识别协议）">
    <div class="hint">协议自动判断：域名→https；IP/带端口→http；也可手动填 http(s):// 指定</div>
    <label for="sitePort">端口（可选）</label>
    <input id="sitePort" placeholder="如 8080，留空则使用默认端口">
    <label for="addProxyMode">代理类型</label>
    <select id="addProxyMode" style="width:100%;box-sizing:border-box;margin:4px 0 10px;padding:9px 12px;border-radius:8px;border:1px solid var(--line);background:var(--input);color:var(--txt);font-size:14px;">
      ${modeOptions}
    </select>
    <div class="row">
      <button type="button" id="addBtn">添加站点</button>
    </div>
    <div class="msg" id="addMsg"></div>
  </div>` : ''}

  ${authed ? `
  <div class="card" data-pane="preferred">
    <h2>DNS 自动优选</h2>
    <div class="hint" style="margin:-8px 0 8px;">定时从 <span class="tag">sub 订阅节点</span> + 优选池测速排序，HTTP 探测过滤不可达后写入 A 记录，
      域名始终指向可用的 CF 泛播边缘。反代链接自动走优选 IP，浏览器直连、客户端零配置。
      下面每个字段都来自运行参数注册表，保存后立即生效、不需要重新部署（订阅链接在「代理节点」页配置）。</div>
    ${settingFormById('dns-config')}
    ${toolItemsForTab('preferred')}
    ${settingFormById('preferred-ips')}
    <div class="row" style="margin-top:8px;">
      <button type="button" id="autoBtn" class="ghost">浏览器自动优选</button>
      <span class="hint" style="margin:0;">从订阅链接拉候选，在<b>你的浏览器</b>里测速（约 5~15 秒）；最快的自动写入上面的优选池，
        延迟数字一并存下来 —— 自动优选按它排序（服务端只负责剔掉不通的）。测速时请<b>不要开着代理访问本页</b>，
        否则测到的是「出口节点 → CF」，不是「你 → CF」。</span>
      <div class="hint" style="margin:4px 0 0;">上次测速：<b id="pickLast">—</b></div>
    </div>
    <div class="msg" id="autoMsg"></div>
    ${settingFormById('pool-config')}
    <div class="hint" style="margin:6px 0 4px;">健康检查：GitHub Actions 每 12 小时检测 A 记录，发现 1034 / 不可达时用「已验证可用集」自愈。
      上次执行：<b id="poolLast">—</b>
      ${ghActionsUrl ? `<a class="ghost-link" href="${esc(ghActionsUrl)}" target="_blank" rel="noopener" style="margin-left:8px;">手动触发健康检查 →</a>` : ''}</div>
  </div>` : `
  <div class="card" id="dnsCard">
    <h2>DNS 自动优选</h2>
    <div class="hint" style="margin:-8px 0 4px;">定时从优选池测速后更新 <span class="tag">${esc(pageHost || '未配置')}</span> 的 A 记录（HTTP 探测过滤不可达），反代自动走优选 IP。当前频率：<b id="dnsCur">加载中…</b>。登录后可修改。</div>
  </div>`}

  <div class="card" data-pane="sites">
    <h2>已添加的站点</h2>
    <div class="hint" style="margin:-8px 0 12px;">点击链接访问代理后的页面；复制按钮可复制代理后/代理前两种链接；「编辑」可修改名称、网址、端口、访问后缀（修改后缀后旧链接将失效）。</div>
    <div id="list">${listHtml}</div>
  </div>

  ${authed ? `
  <div class="card" data-pane="registry">
    <h2>运行参数</h2>
    <div class="hint" style="margin:-8px 0 4px;">全站唯一的一份可运营参数表：原先只能靠环境变量改（要重新部署）的取值，现在都在这里改，保存即生效。字段、取值范围与默认值来自 <span class="tag">src/settings.js</span>，界面与操作手册同源生成。</div>
    ${settingFormById('settings-runtime')}
  </div>

  <div class="card" data-pane="registry">
    <h2>站点模式（注册表）</h2>
    <div class="hint" style="margin:-8px 0 4px;">站点列表徽标与编辑弹窗的类型选项都来自这里。内置 normal / media / ai 三种不可删除、引擎不可修改；可自定义模式（自定义标签 / 徽标 / 说明 + 三选一执行引擎），自定义模式的站点按所选引擎执行，新增模式无需改代码。列表支持新增 / 查看 / 编辑 / 删除（仅自定义）。</div>
    <div id="modesEditor">加载中…</div>
  </div>

  <div class="card" data-pane="registry">
    <h2>R2 媒体缓存</h2>
    <div class="hint" style="margin:-8px 0 4px;">流媒体模式下播放器拉的 206 视频分片会持久落 R2，命中即零回源满速返回。缓存按「网址 + 鉴权 + 区间」去重，热门视频只存一份；关闭总开关后不再写入也不命中，链路回到 Cache API + 透传。${r2Bound ? '' : '当前未绑定 R2（环境缺少 MEDIA_R2），此卡片仅展示默认策略。'}</div>
    <div class="grid2">
      <div>
        <label for="r2Enabled">总开关</label>
        <select id="r2Enabled" style="width:100%;box-sizing:border-box;margin:4px 0 10px;padding:9px 12px;border-radius:8px;border:1px solid var(--line);background:var(--input);color:var(--txt);font-size:14px;">
          <option value="true"${r2Cfg && r2Cfg.enabled ? ' selected' : ''}>开启</option>
          <option value="false"${r2Cfg && !r2Cfg.enabled ? ' selected' : ''}>关闭</option>
        </select>
      </div>
      <div>
        <label for="r2TtlDays">分片保留天数（${R2_CACHE_SPEC.ttlDays.min}~${R2_CACHE_SPEC.ttlDays.max}）</label>
        <input id="r2TtlDays" type="number" min="${R2_CACHE_SPEC.ttlDays.min}" max="${R2_CACHE_SPEC.ttlDays.max}" style="width:100%;box-sizing:border-box;margin:4px 0 10px;padding:9px 12px;border-radius:8px;border:1px solid var(--line);background:var(--input);color:var(--txt);font-size:14px;" placeholder="默认 ${R2_CACHE_SPEC.ttlDays.default} 天" value="${r2Cfg ? r2Cfg.ttlDays : ''}">
      </div>
      <div>
        <label for="r2MaxMB">单分片缓存上限 MB（${R2_CACHE_SPEC.maxObjectMB.min}~${R2_CACHE_SPEC.maxObjectMB.max}）</label>
        <input id="r2MaxMB" type="number" min="${R2_CACHE_SPEC.maxObjectMB.min}" max="${R2_CACHE_SPEC.maxObjectMB.max}" style="width:100%;box-sizing:border-box;margin:4px 0 10px;padding:9px 12px;border-radius:8px;border:1px solid var(--line);background:var(--input);color:var(--txt);font-size:14px;" placeholder="默认 ${R2_CACHE_SPEC.maxObjectMB.default} MB" value="${r2Cfg ? r2Cfg.maxObjectMB : ''}">
      </div>
      <div>
        <label for="r2MaxTotal">缓存总量上限 MB（0 不限，${R2_CACHE_SPEC.maxTotalMB.min}~${R2_CACHE_SPEC.maxTotalMB.max}）</label>
        <input id="r2MaxTotal" type="number" min="${R2_CACHE_SPEC.maxTotalMB.min}" max="${R2_CACHE_SPEC.maxTotalMB.max}" style="width:100%;box-sizing:border-box;margin:4px 0 10px;padding:9px 12px;border-radius:8px;border:1px solid var(--line);background:var(--input);color:var(--txt);font-size:14px;" placeholder="默认 ${R2_CACHE_SPEC.maxTotalMB.default} MB（10GB）" value="${r2Cfg ? r2Cfg.maxTotalMB : ''}">
      </div>
    </div>
    <div class="hint" id="r2Stat" style="margin:0 0 6px;">${r2Bound ? '正在读取当前用量…' : ''}</div>
    <div class="row">
      <button type="button" id="r2TtlBtn">保存缓存策略</button>
      <button type="button" id="r2CleanBtn" class="ghost">立即清理过期分片</button>
    </div>
    <div class="hint" style="margin-top:6px;">保存后立即生效：开关即时切换，上限影响之后的写入，保留天数影响之后每个清理周期；「立即清理」马上删除当前已过期的分片，不等待周期。</div>
    <div class="msg" id="r2Msg"></div>
  </div>

  <div class="card" data-pane="registry">
    <h2>系统配置字典（只读）</h2>
    <div class="hint" style="margin:-8px 0 4px;">系统内所有注册表 / 字典的集中查看。标记「真源」的是代码级定义（改代码后重新部署生效，运行逻辑依赖它们的键值，请勿在面板直接改）；可编辑的注册表（如上方站点模式）在面板内单独维护。</div>
    <details class="cfg-more"><summary>展开 ${dictGroups} 组字典（平时用不上，改代码对照时才看）</summary>${dictHtml}</details>
  </div>` : ''}

  ${authed ? `
  <div class="card" id="disguiseCard" data-pane="security">
    <h2>首页伪装</h2>
    <div class="hint" style="margin:-8px 0 4px;">启用后，没通过隐蔽入口的访客访问根路径 <span class="tag">/</span> 只会看到下面的普通站点页面；管理面板与全部 <span class="tag">/__api</span> 接口改为必须登录。</div>

    <label for="dgEnabled" style="margin-top:14px;">状态</label>
    <select id="dgEnabled">
      <option value="0">关闭（根路径照常显示管理面板）</option>
      <option value="1">启用伪装</option>
    </select>

    <label for="dgTemplate">伪装模板</label>
    <select id="dgTemplate"></select>
    <div class="hint" id="dgTplDesc" style="margin-top:4px;"></div>

    <label for="dgTitle">站点标题</label>
    <input type="text" id="dgTitle" placeholder="留空则使用当前域名">
    <label for="dgSubtitle">副标题 / 说明</label>
    <input type="text" id="dgSubtitle" placeholder="留空则不显示该区块">
    <label for="dgContact">联系方式（页脚，邮箱 / 备案号均可）</label>
    <input type="text" id="dgContact" placeholder="留空则不显示页脚">

    <div class="grid2">
      <div>
        <label for="dgItems" style="margin-top:12px;">服务 / 特性（每行一条）</label>
        <textarea id="dgItems" rows="4" placeholder="技术支持 | 7x24 小时响应"></textarea>
      </div>
      <div>
        <label for="dgPosts" style="margin-top:12px;">文章列表（每行一条）</label>
        <textarea id="dgPosts" rows="4" placeholder="2026-01-01 | 标题 | 摘要"></textarea>
      </div>
    </div>

    <label for="dgHtml">自定义 HTML（模板选「自定义」时整页直出，其余模板忽略）</label>
    <textarea id="dgHtml" rows="4" placeholder="粘贴完整 HTML" style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;"></textarea>

    <h2 style="margin:18px 0 0;">隐蔽入口（至少填一项）</h2>
    <div class="hint" style="margin:0 0 4px;">两者都能单独进门：访问「隐蔽路径」任意路径，或在任意地址后加 <span class="tag">?k=口令</span>。进门后仍是登录页 —— 真正的门是访问口令。</div>
    <div class="grid2">
      <div>
        <label for="dgPath" style="margin-top:10px;">隐蔽路径</label>
        <input type="text" id="dgPath" placeholder="/mypanel">
      </div>
      <div>
        <label for="dgToken" style="margin-top:10px;">URL 口令（已保存则不显示）</label>
        <input type="text" id="dgToken" placeholder="${hasToken ? '已设置，留空保持不变' : '留空则不启用该方式'}">
      </div>
    </div>

    <label for="dgStrict" style="margin-top:12px;">严格模式</label>
    <select id="dgStrict">
      <option value="1">启用（推荐：未登录一律拿不到任何 API 数据）</option>
      <option value="0">关闭（保留原有的匿名只读接口）</option>
    </select>

    <div class="row">
      <button type="button" id="dgSaveBtn">保存伪装配置</button>
      <button type="button" id="dgPreviewBtn" class="ghost">预览伪装页</button>
    </div>
    <div class="msg" id="dgMsg"></div>
    <div class="hint" style="margin-top:4px;">保存后 <b>当前浏览器</b> 会记住进门状态，所以根路径仍显示管理面板；用无痕窗口或清掉 Cookie 才能看到访客视角。</div>
  </div>` : ''}

  ${authed ? `
  <div class="card" id="themeCard" data-pane="theme">
    <h2>外观主题</h2>
    <div class="hint" style="margin:-8px 0 0;">每套主题会整体替换配色、字体、圆角与阴影强度。当前选择只存在这台浏览器；要给别人也用这套，点「设为全站默认」。</div>
    <div class="theme-grid" id="themeGrid">${themeCards}</div>
    <div class="row">
      <button type="button" id="themeAutoBtn" class="ghost">跟随系统</button>
      <button type="button" id="themeDefaultBtn" class="ghost">设为全站默认</button>
      <span class="hint" id="themeHint" style="margin:0;">全站默认：<span class="tag">${esc(themeView.default_theme)}</span>${themeView.rotating_theme ? `　轮换中：<span class="tag">${esc(themeView.rotating_theme)}</span>` : ''}</span>
    </div>

    <h2 style="margin:18px 0 0;">自动轮换</h2>
    <div class="hint" style="margin:0 0 4px;">长期不换会审美疲劳：可以每次访问随机，或每隔一段时间整体换一套（同一时刻所有人看到的是同一套）。</div>
    <label for="rtMode" style="margin-top:12px;">轮换方式</label>
    <select id="rtMode">
      ${(themeView.rotate_modes || []).map(m => `<option value="${esc(m.id)}"${m.id === themeView.rotate_mode ? ' selected' : ''}>${esc(m.label)} — ${esc(m.desc)}</option>`).join('')}
    </select>
    <label for="rtMinutes" style="margin-top:12px;">轮换间隔（分钟，「按时轮换」时生效）</label>
    <input type="number" id="rtMinutes" min="${esc(String(rtBounds.min))}" max="${esc(String(rtBounds.max))}" value="${esc(String(themeView.rotate_interval_minutes || rtBounds.default))}" style="max-width:220px;">
    <label for="rtPool" style="margin-top:12px;">参与轮换的主题（留空 = 全部）</label>
    <input id="rtPool" placeholder="aurora nord terminal" value="${esc(String(themeView.rotate_pool || ''))}">
    <div class="row">
      <button type="button" id="rtSaveBtn">保存轮换设置</button>
      <button type="button" id="rtRollBtn" class="ghost">立刻换一套</button>
    </div>
    <div class="msg" id="rtMsg"></div>
    <div class="msg" id="themeMsg"></div>

    <h2 style="margin:18px 0 0;">自定义主题</h2>
    <div class="hint" style="margin:0 0 4px;">只填要覆盖的变量，其余自动继承（常用：主色 <span class="tag">--accent</span>、背景 <span class="tag">--bg</span>、卡片 <span class="tag">--card</span>、字体 <span class="tag">--font</span>、圆角 <span class="tag">--radius</span>）。</div>
    <div class="grid2">
      <div>
        <label for="ctId" style="margin-top:12px;">标识（英文小写 / 数字 / 短横线）</label>
        <input id="ctId" placeholder="mytheme">
      </div>
      <div>
        <label for="ctName" style="margin-top:12px;">显示名称</label>
        <input id="ctName" placeholder="我的主题">
      </div>
    </div>
    <label for="ctVars" style="margin-top:12px;">CSS 变量（JSON 对象）</label>
    <textarea id="ctVars" rows="5" placeholder='{"--accent":"#ff6600","--radius":"18px"}' style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;"></textarea>
    <div class="row">
      <button type="button" id="ctSaveBtn">保存为主题</button>
    </div>
    <div class="msg" id="ctMsg"></div>
    ${themeView.themes.filter(t => t.custom).length ? `
    <div class="hint" style="margin-top:6px;">已保存的自定义主题：${themeView.themes.filter(t => t.custom).map(t => `<span style="display:inline-flex;gap:6px;align-items:center;margin-right:10px;"><span class="tag">${esc(t.id)}</span><button type="button" class="danger mini" data-del-theme="${esc(t.id)}">删除</button></span>`).join('')}</div>` : ''}
  </div>` : ''}

${authed ? `
<!-- 编辑站点弹窗 -->
<div id="editModal" style="display:none;position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:1000;align-items:center;justify-content:center;backdrop-filter:blur(2px);">
  <div style="background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px;width:min(92vw,460px);box-sizing:border-box;box-shadow:0 20px 60px rgba(0,0,0,.3);">
    <h2 style="margin:0 0 14px;font-size:18px;">编辑站点</h2>
    <input type="hidden" id="editId">
    <label for="editName">名称（中文/英文）</label>
    <input type="text" id="editName" placeholder="我的站点" style="width:100%;box-sizing:border-box;margin:4px 0 10px;padding:9px 12px;border-radius:8px;border:1px solid var(--line);background:var(--input);color:var(--txt);font-size:14px;">
    <label for="editSlug">访问后缀</label>
    <input type="text" id="editSlug" placeholder="自定义如 blog；留空自动生成" style="width:100%;box-sizing:border-box;margin:4px 0 10px;padding:9px 12px;border-radius:8px;border:1px solid var(--line);background:var(--input);color:var(--txt);font-size:14px;">
    <label for="editTarget">网址</label>
    <input type="text" id="editTarget" placeholder="example.com 或 https://example.com" style="width:100%;box-sizing:border-box;margin:4px 0 10px;padding:9px 12px;border-radius:8px;border:1px solid var(--line);background:var(--input);color:var(--txt);font-size:14px;">
    <label for="editPort">端口（可空）</label>
    <input type="text" id="editPort" placeholder="如 8080，留空使用默认端口" style="width:100%;box-sizing:border-box;margin:4px 0 12px;padding:9px 12px;border-radius:8px;border:1px solid var(--line);background:var(--input);color:var(--txt);font-size:14px;">
    <label for="editProxyMode">代理类型（<span id="editModeHint" style="font-weight:400;color:var(--dim,#64748b);">普通反代</span>）</label>
    <select id="editProxyMode" style="width:100%;box-sizing:border-box;margin:4px 0 10px;padding:9px 12px;border-radius:8px;border:1px solid var(--line);background:var(--input);color:var(--txt);font-size:14px;">
      ${modeOptions}
    </select>
    <div id="editMediaFields">
    <label style="display:flex;align-items:center;gap:8px;margin:2px 0 6px;font-size:13px;cursor:pointer;">
      <input type="checkbox" id="editMediaAuthBind" style="width:16px;height:16px;">
      盗链保护（分片缓存按 api_key/token 隔离，不同用户不共享缓存）
    </label>
    <label style="display:flex;align-items:center;gap:8px;margin:2px 0 12px;font-size:13px;cursor:pointer;">
      <input type="checkbox" id="editMediaSkipLog" style="width:16px;height:16px;">
      媒体流跳过明细日志（省 CPU，默认关闭=记录）
    </label>
    </div>
    <div id="editAiFields" style="display:none;">
      <label for="editAiKey">入口密钥（可选，留空 = 公开端点）</label>
      <input type="text" id="editAiKey" placeholder="客户端请求必须带此 key 才能访问" style="width:100%;box-sizing:border-box;margin:4px 0 10px;padding:9px 12px;border-radius:8px;border:1px solid var(--line);background:var(--input);color:var(--txt);font-size:14px;">
      <label for="editAiKeys">上游 Key 列表（逗号 / 换行分隔，请求随机轮换；留空 = 透传客户端自己的 key）</label>
      <textarea id="editAiKeys" rows="3" placeholder="sk-xxx1&#10;sk-xxx2" style="width:100%;box-sizing:border-box;margin:4px 0 12px;padding:9px 12px;border-radius:8px;border:1px solid var(--line);background:var(--input);color:var(--txt);font-size:14px;resize:vertical;"></textarea>
    </div>
    <div class="msg" id="editMsg" style="min-height:18px;margin:0 0 6px;"></div>
    <div style="display:flex;gap:10px;">
      <button type="button" id="editSave" style="flex:1;">保存</button>
      <button type="button" id="editCancel" class="ghost" style="flex:1;">取消</button>
    </div>
  </div>
</div>` : ''}

  ${authed ? renderConfigPanels() : ''}

  ${authed ? `
  <div class="card" id="shareCard" data-pane="share">
    <h2>站点临时访问链接</h2>
    <div class="hint" style="margin:-8px 0 12px;">给某个站点开一条到期自动作废的短链，适合「发给别人看一眼」。有效期与访问次数任一先到即失效，随时可以停用或删除。</div>
    ${settingFormById('share-config')}
    <h2 style="margin:18px 0 0;">生成链接</h2>
    <div class="row" style="margin-top:10px;">
      <select id="shSite" style="flex:1;min-width:150px;"><option value="">选择站点…</option></select>
      <input type="number" id="shDays" placeholder="天数" min="1" style="width:88px;">
      <input type="number" id="shHits" placeholder="次数 0=不限" min="0" style="width:130px;">
      <input type="text" id="shNote" placeholder="备注（可选）" style="flex:1;min-width:130px;">
      <button type="button" id="shCreate">生成链接</button>
    </div>
    <div class="msg" id="shMsg" style="min-height:18px;"></div>
    <div id="shList" style="margin-top:8px;"><div class="empty">加载中…</div></div>
  </div>` : ''}
</div>

<script>
// 顶栏「外观」按钮：跳到主题分区，选主题在那一屏里做（不再三档循环 —— 主题多了循环点不过来）
const themeBtn = document.getElementById('themeBtn');
if (themeBtn) {
  themeBtn.textContent = '外观';
  themeBtn.onclick = () => { if (typeof switchPane === 'function') switchPane('theme'); };
}
const AUTHED = ${authed ? 'true' : 'false'};
const $ = s => document.querySelector(s);

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  // GET 读接口加时间戳，防止浏览器启发式缓存拿到旧数据
  let p = path;
  if (!opts.method || opts.method === 'GET') {
    p = path + (path.includes('?') ? '&' : '?') + 't=' + Date.now();
  }
  const res = await fetch(p, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function setMsg(id, text, isErr) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = 'msg ' + (isErr ? 'err' : 'ok');
}

function copyText(text, btn, doneMsgId) {
  const done = () => {
    if (btn) { const old = btn.textContent; btn.textContent = '已复制'; setTimeout(() => { btn.textContent = old; }, 1500); }
    if (doneMsgId) setMsg(doneMsgId, '已复制到剪贴板', false);
  };
  const fallback = () => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      done();
    } catch (e) {
      if (doneMsgId) setMsg(doneMsgId, '复制失败，请手动复制：' + text, true);
    }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(fallback);
  } else {
    fallback();
  }
}

// 首屏：站点列表已由服务端渲染，这里只异步填充上游测速延迟
api('/__api/speedtest').then(r => {
  if (!r.ok || !r.data || !r.data.results) return;
  const map = {};
  r.data.results.forEach(x => { map[x.id] = x; });
  document.querySelectorAll('.latency').forEach(el => {
    const x = map[el.dataset.id];
    if (!x) return;
    el.textContent = x.status === 'unreachable' ? '上游不可达' : (x.latency_ms != null ? '上游 ' + x.latency_ms + 'ms' : '');
    el.style.color = x.status === 'unreachable' ? 'var(--err)' : 'var(--ok)';
  });
});

// 未登录访客看到的「当前频率」只读展示（登录后由通用设置表单读写同一个接口）
(async () => {
  const cur = document.getElementById('dnsCur');
  if (!cur) return;
  const r = await api('/__api/dns-config');
  if (r.ok && r.data.dns_interval_minutes) cur.textContent = r.data.dns_interval_minutes + ' 分钟';
})();
// ===== R2 媒体缓存策略：总开关 / 保留天数 / 单分片上限 / 总量上限 + 用量展示 + 立即清理 =====
const r2Stat = document.getElementById('r2Stat');
if (r2Stat && document.getElementById('r2TtlBtn')) {
  api('/__api/r2-cache').then(function (r) {
    if (!r.ok || !r.data || !r.data.stat) return;
    const s = r.data.stat;
    r2Stat.textContent = '当前用量：约 ' + s.count + ' 个分片 / ' + s.bytesMB + ' MB' + (s.truncated ? '（对象较多，为约数）' : '');
  }).catch(function () {});
}
const r2TtlBtn = document.getElementById('r2TtlBtn');
if (r2TtlBtn) {
  r2TtlBtn.onclick = async () => {
    const en = document.getElementById('r2Enabled');
    const ttl = document.getElementById('r2TtlDays');
    const mx = document.getElementById('r2MaxMB');
    const tot = document.getElementById('r2MaxTotal');
    // 「留空保持不变」：空输入框不提交对应字段；区间校验只针对填了的字段
    const body = {};
    if (en) body.enabled = en.value === 'true';
    const v = ttl ? ttl.value.trim() : '';
    const m = mx ? mx.value.trim() : '';
    const t = tot ? tot.value.trim() : '';
    if (v !== '') {
      const n = parseInt(v, 10);
      if (!n || n < Number(ttl.min) || n > Number(ttl.max)) { setMsg('r2Msg', '保留天数需在 ' + ttl.min + ' ~ ' + ttl.max + ' 之间', true); return; }
      body.ttlDays = n;
    }
    if (m !== '') {
      const n = parseInt(m, 10);
      if (!n || n < Number(mx.min) || n > Number(mx.max)) { setMsg('r2Msg', '单分片上限需在 ' + mx.min + ' ~ ' + mx.max + ' MB 之间', true); return; }
      body.maxObjectMB = n;
    }
    if (t !== '') {
      const n = parseInt(t, 10);
      if (Number.isNaN(n) || n < Number(tot.min) || n > Number(tot.max)) { setMsg('r2Msg', '总量上限需在 ' + tot.min + ' ~ ' + tot.max + ' MB 之间（0 表示不限）', true); return; }
      body.maxTotalMB = n;
    }
    setMsg('r2Msg', '正在保存…');
    r2TtlBtn.disabled = true;
    try {
      const r = await api('/__api/r2-cache', { method: 'POST', body: JSON.stringify(body) });
      setMsg('r2Msg', r.ok ? '已保存' : (r.data.error || '保存失败'), !r.ok);
    } catch (e) {
      setMsg('r2Msg', '请求失败：' + String(e && e.message || e), true);
    }
    r2TtlBtn.disabled = false;
  };
}
const r2CleanBtn = document.getElementById('r2CleanBtn');
if (r2CleanBtn) {
  r2CleanBtn.onclick = async () => {
    setMsg('r2Msg', '正在清理…');
    r2CleanBtn.disabled = true;
    try {
      const r = await api('/__api/r2-cache', { method: 'POST', body: JSON.stringify({ action: 'clean' }) });
      setMsg('r2Msg', r.ok ? '已清理当前过期的分片' : (r.data.error || '清理失败'), !r.ok);
    } catch (e) {
      setMsg('r2Msg', '请求失败：' + String(e && e.message || e), true);
    }
    r2CleanBtn.disabled = false;
  };
}

// 候选域名池 / 优选池 / 自动优选频率都已经是注册表字段，读写与校验全部交给通用设置表单
// （renderSettingForm / settingFormById，见 src/config-ui.js）—— 这里只剩下「不是配置」的那部分：
// 健康检查的上次执行时间（运行状态，存在 KV HC_LAST_RUN，不是可配项）。
const poolLastEl = document.getElementById('poolLast');
if (poolLastEl) {
  api('/__api/pool-config').then(r => {
    if (!r.ok || !r.data) return;
    poolLastEl.textContent = r.data.last_run ? new Date(r.data.last_run * 1000).toLocaleString() : '从未';
  }).catch(() => {});
}
// 上次「浏览器自动优选」的结果摘要：没有它，自动优选就只能按服务端视角的快慢排
// （而那个排序跟你的网络基本无关）。过期/区分度不足都要直接说，别让人以为优选过了。
const pickLastEl = document.getElementById('pickLast');
if (pickLastEl) {
  api('/__api/pick-speed').then(r => {
    if (!r.ok || !r.data) { pickLastEl.textContent = '—'; return; }
    const d = r.data;
    if (!d.ts || !d.items.length) { pickLastEl.textContent = '从未（自动优选按服务端探测顺序）'; return; }
    const mins = Math.round((Date.now() - d.ts) / 60000);
    const ago = mins < 60 ? mins + ' 分钟前' : Math.round(mins / 60) + ' 小时前';
    const parts = [ago + '，' + d.items.length + ' 个 IP，最快 ' + Math.round(d.items[0].ms) + 'ms'];
    if (d.stale) parts.push('已过期，本次优选将不用它');
    else if (d.spread && d.spread.ok === false) parts.push('区分度不足（可能是在代理状态下测的）');
    if (d.enabled === false) parts.push('开关已关闭');
    pickLastEl.textContent = parts.join('｜');
  }).catch(() => {});
}
// 确认制测速：no-cors 计时近似「你网络→节点」延迟。
// 首测 2 次取最短；resolve 快（<200ms）的 IP 可能隐藏 1034/假快（TLS 成功但 HTTP 被拒），
// 自动复测 2 次取中位数；波动大（>150ms）的降权，避免抖动假快污染排序。
// 探活目标改用根路径：伪装开启后 /__api/config 要求登录，跨站 no-cors 请求带不上 cookie，
// 继续打它会全部超时。根路径在伪装状态下始终返回 200 的伪装页，且「根路径」是所有网站都有的，
// 不引入任何新指纹。代价：no-cors 模式本就无法读取状态码，1034 仍要靠服务端优选（dns.js）判定。
// timeoutMs 由运行参数（单次测速超时）下发，这里不再自带数字。
// 「作废阈值」跟着超时走：超时是一次 fetch 的上限，超时两次的量级就是 2×timeoutMs，
// 若另写一个固定值（曾经是 5000），把超时调大到 8000 就会把正常慢节点全部误判为不可用。
async function measureIp(ip, timeoutMs) {
  let first = Infinity;
  for (let t = 0; t < 2; t++) {
    const t0 = performance.now();
    try {
      await fetch('https://' + ip + '/', { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {}
    const ms = performance.now() - t0;
    if (ms < first) first = ms;
  }
  // +1500 是给「浏览器 abort + 计时开销」留的余量，超过才说明这次测量本身不可信
  if (first >= timeoutMs + 1500) return null;
  if (first < 200) {
    const samples = [first];
    for (let t = 0; t < 2; t++) {
      const t0 = performance.now();
      try {
        await fetch('https://' + ip + '/', { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {}
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    let med = samples[1];
    if (samples[2] - samples[0] > 150) med += 300; // 抖动大 → 降权
    return med;
  }
  return first;
}

// 浏览器自动优选：候选统一从**订阅链接**拉取（服务端已按地址归属过滤），失败才用当前池兜底
const autoBtn = document.getElementById('autoBtn');
if (autoBtn) {
  // 优选池的输入框由通用设置表单渲染（目录项 preferred-ips）。这里按**目录契约**取元素，
  // 不去猜生成出来的 id：只要目录里那张表单还在，这个按钮就还能用；
  // 未保存态也交给表单自己的 refresh（派发一次 input 事件），不另写一套脏值判断。
  function prefIpsField() {
    return document.querySelector('[data-uid="preferred-ips"] [data-key="preferred_ips"]');
  }
  autoBtn.onclick = async () => {
    const btn = autoBtn;
    const field = prefIpsField();
    if (!field) { setMsg('autoMsg', '找不到优选池输入框（页面结构已变），请刷新后重试', true); return; }
    btn.disabled = true;
    setMsg('autoMsg', '', false);
    btn.textContent = '正在拉取订阅节点…';
    let cands = [];
    let note = '';
    // 测速口径（测几个 / 留几条 / 几路并发 / 单次等多久）由服务端从注册表下发。
    // 前端不自带任何数字：写死一份就等于第二套真源，面板上改了也不生效。
    let limits = null;
    try {
      const r = await api('/__api/preferred-candidates');
      if (r.ok && r.data) {
        cands = r.data.ips || [];
        limits = r.data.limits || null;
        const s = r.data.stats || {};
        note = r.data.note || (s.filtered ? '订阅共 ' + s.addresses + ' 个节点，已过滤非边缘网络 ' + s.filtered + ' 个' : '');
      } else {
        limits = (r.data && r.data.limits) || null; // 失败分支也带，后面兜底路径要用
        note = (r.data && r.data.error) || '订阅拉取失败';
      }
    } catch (e) { note = '订阅拉取异常'; }
    if (!cands.length) {
      try {
        const r = await api('/__api/preferred-ips');
        if (r.ok && r.data.preferred_ips && r.data.preferred_ips.length) {
          cands = r.data.preferred_ips;
          limits = limits || r.data.limits || null;
          note = '订阅无候选，改用当前优选池';
        }
      } catch {}
    }
    if (!limits) {
      // 拿不到口径就直接停：宁可不测，也不用一套「看起来能跑」的写死数字把池子改掉
      setMsg('autoMsg', '拿不到浏览器测速的运行参数（刷新页面重试）' + (note ? '（' + note + '）' : ''), true);
      btn.disabled = false;
      btn.textContent = '浏览器自动优选';
      return;
    }
    cands = [...new Set(cands.filter(ip => /^\\d{1,3}(\\.\\d{1,3}){3}$/.test(ip)))].slice(0, limits.scan_limit);
    if (!cands.length) {
      setMsg('autoMsg', '没有可用候选：请先在「代理节点」页填写订阅链接并保存' + (note ? '（' + note + '）' : ''), true);
      btn.disabled = false;
      btn.textContent = '浏览器自动优选';
      return;
    }
    const results = [];
    let done = 0;
    const CONC = limits.concurrency;
    const ping = async (ip) => {
      const t = await measureIp(ip, limits.timeout_ms);
      if (t !== null) results.push({ ip, t });
      done++;
      btn.textContent = '自动优选中 ' + done + '/' + cands.length + '…（已测 ' + results.length + '）';
    };
    for (let i = 0; i < cands.length; i += CONC) {
      await Promise.all(cands.slice(i, i + CONC).map(ping));
    }
    results.sort((a, b) => a.t - b.t);
    const best = results.slice(0, limits.keep);
    if (!best.length) {
      setMsg('autoMsg', '全部节点超时（网络受限？），请稍后重试', true);
    } else {
      field.value = best.map(r => r.ip).join('\\n');
      field.dispatchEvent(new Event('input', { bubbles: true }));
      // 1) 池子直接落库（以前只填进输入框，忘了点「保存」就等于白测）
      let savedNote = '';
      try {
        const sr = await api('/__api/preferred-ips', {
          method: 'POST', body: JSON.stringify({ preferred_ips: best.map(r => r.ip) }),
        });
        savedNote = sr.ok ? '优选池已保存' : ('保存失败：' + ((sr.data && sr.data.error) || sr.status));
      } catch (e) { savedNote = '保存失败：' + String((e && e.message) || e); }
      // 2) 延迟数值存回服务端 —— 这一步才是「优选」的本体。
      //    只存 IP 名单的话，服务端自动优选走二值判定（谁先探到谁在前），
      //    用户侧测出来的快慢会在那一步被丢掉，最后写进 A 记录的跟测的结果无关。
      let pickNote = '';
      try {
        const pr = await api('/__api/pick-speed', {
          method: 'POST',
          body: JSON.stringify({ items: results.map(r => ({ ip: r.ip, ms: Math.round(r.t) })) }),
        });
        pickNote = pr.ok ? '延迟已记录（' + pr.data.n + ' 个，自动优选按它排序）'
          : ('延迟记录失败：' + ((pr.data && pr.data.error) || pr.status));
      } catch (e) { pickNote = '延迟记录失败：' + String((e && e.message) || e); }
      // 3) 区分度自检：全部挤在一起说明这次测量没有信息量 ——
      //    最常见的成因是**开着代理访问本页**，此时测的是「出口节点 → CF」而不是「你 → CF」。
      const vs = best.map(r => r.t).sort((a, b) => a - b);
      const range = vs.length ? vs[vs.length - 1] - vs[0] : 0;
      const flatNote = vs.length >= 3 && (range < 20 || (vs[vs.length - 1] > 0 && range / vs[vs.length - 1] < 0.1))
        ? '⚠️ 这批结果几乎没有区分度（极差 ' + Math.round(range) + 'ms）：如果你现在开着代理访问本页，测到的是「出口节点→CF」而非「你→CF」，请断开代理后重测'
        : '';
      setMsg('autoMsg', '优选完成：测 ' + cands.length + ' 个，最快 ' + Math.round(best[0].t) + 'ms，前 ' + best.length + ' 个已填入优选池｜'
        + savedNote + '｜' + pickNote + (flatNote ? '｜' + flatNote : '')
        + (note ? '｜' + note : '') + '，点「立即更新优选 IP」写入 A 记录', false);
    }
    btn.disabled = false;
    btn.textContent = '浏览器自动优选';
  };
}

// 首页伪装：模板清单由服务端下发（config.templates），前端不内置任何模板名，
// 保证以后新增模板不需要同时改前后端。
function dgJoin(rows, keys) {
  return (rows || []).map(function (row) {
    return keys.map(function (k) { return row && row[k] ? String(row[k]) : ''; }).join(' | ').replace(/(\\s*\\|\\s*)+$/, '');
  }).join('\\n');
}
function dgSplit(text, keys) {
  return String(text || '').split(/\\r?\\n/).map(function (s) { return s.trim(); }).filter(Boolean).map(function (line) {
    const parts = line.split('|').map(function (s) { return s.trim(); });
    const out = {};
    keys.forEach(function (k, i) { out[k] = parts[i] || ''; });
    return out;
  });
}
const dgSaveBtn = document.getElementById('dgSaveBtn');
if (dgSaveBtn) {
  const dgTpl = document.getElementById('dgTemplate');
  const dgTplDesc = document.getElementById('dgTplDesc');
  let dgTpls = [];
  api('/__api/disguise').then(function (r) {
    if (!r.ok || !r.data) return;
    const cfg = r.data.config || {};
    dgTpls = cfg.templates || [];
    dgTpls.forEach(function (t) {
      const o = document.createElement('option');
      o.value = t.id;
      o.textContent = t.id;
      dgTpl.appendChild(o);
    });
    dgTpl.value = cfg.template || (dgTpls[0] && dgTpls[0].id) || '';
    document.getElementById('dgEnabled').value = cfg.enabled ? '1' : '0';
    document.getElementById('dgStrict').value = cfg.strict === false ? '0' : '1';
    document.getElementById('dgTitle').value = cfg.title || '';
    document.getElementById('dgSubtitle').value = cfg.subtitle || '';
    document.getElementById('dgContact').value = cfg.contact || '';
    document.getElementById('dgPath').value = cfg.path || '';
    document.getElementById('dgHtml').value = cfg.custom_html || '';
    document.getElementById('dgItems').value = dgJoin(cfg.items, ['title', 'desc']);
    document.getElementById('dgPosts').value = dgJoin(cfg.posts, ['date', 'title', 'summary']);
    const hit = dgTpls.filter(function (t) { return t.id === dgTpl.value; })[0];
    dgTplDesc.textContent = hit ? hit.desc : '';
  }).catch(function () {});
  dgTpl.onchange = function () {
    const hit = dgTpls.filter(function (t) { return t.id === dgTpl.value; })[0];
    dgTplDesc.textContent = hit ? hit.desc : '';
  };
  dgSaveBtn.onclick = async function () {
    dgSaveBtn.disabled = true;
    setMsg('dgMsg', '保存中…', false);
    const body = {
      enabled: document.getElementById('dgEnabled').value === '1',
      strict: document.getElementById('dgStrict').value === '1',
      template: dgTpl.value,
      title: document.getElementById('dgTitle').value,
      subtitle: document.getElementById('dgSubtitle').value,
      contact: document.getElementById('dgContact').value,
      custom_html: document.getElementById('dgHtml').value,
      path: document.getElementById('dgPath').value,
      items: dgSplit(document.getElementById('dgItems').value, ['title', 'desc']),
      posts: dgSplit(document.getElementById('dgPosts').value, ['date', 'title', 'summary']),
    };
    // 口令留空 = 保持原值（面板永远读不到明文，不能拿空串去覆盖）
    const tk = document.getElementById('dgToken').value;
    if (tk) body.token = tk;
    try {
      const r = await api('/__api/disguise', { method: 'POST', body: JSON.stringify(body) });
      if (!r.ok) setMsg('dgMsg', r.data.error || '保存失败', true);
      else setMsg('dgMsg', r.data.active ? '已保存，伪装已生效' : '已保存，但伪装未启用（需开启状态并至少配置一种隐蔽入口）', false);
    } catch (err) {
      setMsg('dgMsg', '请求失败：' + (err && err.message ? err.message : err), true);
    }
    dgSaveBtn.disabled = false;
  };
  const dgPrev = document.getElementById('dgPreviewBtn');
  if (dgPrev) dgPrev.onclick = function () { window.open('/__api/disguise-preview', '_blank', 'noopener'); };
}

// ===== 站点模式注册表编辑器（列表 CRUD：查看 / 新增 / 编辑 / 删除，自包含不依赖模块导入） =====
(function () {
  const box = document.getElementById('modesEditor');
  if (!box) return;
  var modes = null;
  var engines = ['normal', 'media', 'ai'];
  var builtinKeys = ['normal', 'media', 'ai'];
  var dirty = false;
  var badgeOpts = [
    ['badge-normal', '灰（普通）'], ['badge-media', '绿（流媒体）'], ['badge-ai', '蓝（AI）'],
    ['badge-blue', '蓝'], ['badge-purple', '紫'], ['badge-orange', '橙'], ['badge-red', '红'],
  ];
  function esc2(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function badgeLabel(cls) {
    const hit = badgeOpts.filter(function (b) { return b[0] === cls; })[0];
    return hit ? hit[1] : cls;
  }
  // 弹窗表单（新增 / 编辑共用；查看走只读弹窗）
  function openModal(editKey) {
    const isEdit = !!editKey && modes[editKey];
    const v = isEdit ? modes[editKey] : { label: '', badge: '', badgeClass: 'badge-blue', hint: '', engine: 'normal' };
    const builtin = isEdit && builtinKeys.indexOf(editKey) >= 0;
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:1100;display:flex;align-items:center;justify-content:center;';
    ov.innerHTML = '<div style="background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px;width:min(92vw,440px);box-sizing:border-box;box-shadow:0 20px 60px rgba(0,0,0,.3);">'
      + '<h2 style="margin:0 0 14px;font-size:18px;">' + (isEdit ? '编辑模式' : '新增自定义模式') + '</h2>'
      + '<label>模式键（' + (isEdit ? '保存后不可修改' : '仅小写字母/数字/-，如 custom-1') + '）</label>'
      + '<input id="mdKey" ' + (isEdit ? 'readonly style="background:var(--input);"' : '') + ' value="' + esc2(isEdit ? editKey : '') + '" placeholder="custom-1" style="width:100%;box-sizing:border-box;margin:4px 0 10px;padding:9px 12px;border-radius:8px;border:1px solid var(--line);background:var(--input);color:var(--txt);font-size:14px;">'
      + '<label>标签（编辑弹窗选项显示名）</label>'
      + '<input id="mdLabel" value="' + esc2(v.label) + '" placeholder="我的影视" style="width:100%;box-sizing:border-box;margin:4px 0 10px;padding:9px 12px;border-radius:8px;border:1px solid var(--line);background:var(--input);color:var(--txt);font-size:14px;">'
      + '<div class="grid2">'
      + '<div><label>徽标文字</label><input id="mdBadge" value="' + esc2(v.badge) + '" placeholder="影视" style="width:100%;box-sizing:border-box;margin:4px 0 10px;padding:9px 12px;border-radius:8px;border:1px solid var(--line);background:var(--input);color:var(--txt);font-size:14px;"></div>'
      + '<div><label>徽标颜色</label><select id="mdBadgeClass" style="width:100%;box-sizing:border-box;margin:4px 0 10px;padding:9px 12px;border-radius:8px;border:1px solid var(--line);background:var(--input);color:var(--txt);font-size:14px;">'
      + badgeOpts.map(function (b) { return '<option value="' + b[0] + '"' + (v.badgeClass === b[0] ? ' selected' : '') + '>' + b[1] + '</option>'; }).join('')
      + '</select></div>'
      + '</div>'
      + (builtin ? '' : '<label>执行引擎</label><select id="mdEngine" style="width:100%;box-sizing:border-box;margin:4px 0 10px;padding:9px 12px;border-radius:8px;border:1px solid var(--line);background:var(--input);color:var(--txt);font-size:14px;">'
        + engines.map(function (e) { return '<option value="' + e + '"' + (v.engine === e ? ' selected' : '') + '>' + e + '</option>'; }).join('')
        + '</select>')
      + '<label>说明（编辑弹窗展示）</label>'
      + '<input id="mdHint" value="' + esc2(v.hint) + '" placeholder="这个模式是做什么的" style="width:100%;box-sizing:border-box;margin:4px 0 12px;padding:9px 12px;border-radius:8px;border:1px solid var(--line);background:var(--input);color:var(--txt);font-size:14px;">'
      + '<div class="row"><button type="button" id="mdOk">' + (isEdit ? '保存修改' : '新增') + '</button><button type="button" id="mdCancel" class="ghost">取消</button></div>'
      + '<div class="msg" id="mdMsg" style="min-height:18px;margin:0 0 6px;"></div>'
      + '</div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) { if (e.target === ov) ov.remove(); });
    document.getElementById('mdCancel').onclick = function () { ov.remove(); };
    document.getElementById('mdOk').onclick = function () {
      const k = document.getElementById('mdKey').value.trim();
      const label = document.getElementById('mdLabel').value.trim();
      const badge = document.getElementById('mdBadge').value.trim();
      const badgeClass = document.getElementById('mdBadgeClass').value;
      const hint = document.getElementById('mdHint').value.trim();
      const engineEl = document.getElementById('mdEngine');
      const engine = engineEl ? engineEl.value : (isEdit ? v.engine : 'normal');
      const msg = document.getElementById('mdMsg');
      if (!/^[a-z0-9-]{1,32}$/.test(k)) { msg.textContent = '模式键仅限小写字母 / 数字 / 短横线，1~32 位'; msg.style.color = 'var(--err)'; return; }
      if (!label) { msg.textContent = '标签不能为空'; msg.style.color = 'var(--err)'; return; }
      if (!isEdit && modes[k]) { msg.textContent = '模式键 ' + k + ' 已存在'; msg.style.color = 'var(--err)'; return; }
      modes[k] = { label: label, badge: badge || k, badgeClass: badgeClass, hint: hint, engine: engine };
      if (isEdit && editKey !== k) { delete modes[editKey]; }
      dirty = true;
      ov.remove();
      render();
    };
  }
  function openView(key) {
    const v = modes[key];
    if (!v) return;
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:1100;display:flex;align-items:center;justify-content:center;';
    ov.innerHTML = '<div style="background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px;width:min(92vw,440px);box-sizing:border-box;box-shadow:0 20px 60px rgba(0,0,0,.3);">'
      + '<h2 style="margin:0 0 12px;font-size:18px;">模式详情：' + esc2(key) + '</h2>'
      + '<div style="display:flex;flex-direction:column;gap:8px;font-size:14px;">'
      + '<div>标签：<b>' + esc2(v.label) + '</b></div>'
      + '<div>徽标：<span class="tag ' + esc2(v.badgeClass) + '">' + esc2(v.badge) + '</span>（' + esc2(badgeLabel(v.badgeClass)) + '）</div>'
      + '<div>执行引擎：<b>' + esc2(v.engine) + '</b>' + (builtinKeys.indexOf(key) >= 0 ? '（内置，不可修改）' : '') + '</div>'
      + '<div>说明：' + esc2(v.hint || '（无）') + '</div>'
      + '</div>'
      + '<div class="row"><button type="button" id="mdClose" class="ghost">关闭</button></div>'
      + '</div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) { if (e.target === ov) ov.remove(); });
    document.getElementById('mdClose').onclick = function () { ov.remove(); };
  }
  function render() {
    const rows = Object.keys(modes).map(function (k) {
      const v = modes[k];
      const builtin = builtinKeys.indexOf(k) >= 0;
      return '<div class="mode-row" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;border:1px solid var(--line);border-radius:8px;">'
        + '<span class="mode-key" style="font-weight:600;min-width:92px;">' + esc2(k) + '</span>'
        + '<span style="flex:1 1 160px;">' + esc2(v.label) + '</span>'
        + '<span class="tag ' + esc2(v.badgeClass) + '">' + esc2(v.badge) + '</span>'
        + '<span class="tag" style="font-weight:400;">' + esc2(v.engine) + '</span>'
        + (builtin ? '<span class="tag" title="内置模式不可删除" style="font-weight:400;">内置</span>' : '')
        + '<span style="display:inline-flex;gap:6px;">'
        + '<button type="button" class="mini" data-view="' + esc2(k) + '">查看</button>'
        + '<button type="button" class="mini" data-edit="' + esc2(k) + '">编辑</button>'
        + (builtin ? '' : '<button type="button" class="danger mini" data-del="' + esc2(k) + '">删除</button>')
        + '</span>'
        + '</div>';
    }).join('');
    box.innerHTML = '<div style="display:flex;flex-direction:column;gap:8px;">' + (rows || '<div class="empty">还没有自定义模式</div>') + '</div>'
      + '<div class="row" style="margin-top:12px;">'
      + '<button type="button" id="modesAddBtn" class="ghost">+ 新增自定义模式</button>'
      + '<button type="button" id="modesSaveBtn"' + (dirty ? '' : ' disabled') + '>保存注册表</button>'
      + (dirty ? '<span class="msg" style="color:var(--accent);">有未保存的修改</span>' : '')
      + '</div>'
      + '<div class="msg" id="modesMsg"></div>';
    box.querySelectorAll('[data-view]').forEach(function (b) { b.onclick = function () { openView(b.getAttribute('data-view')); }; });
    box.querySelectorAll('[data-edit]').forEach(function (b) { b.onclick = function () { openModal(b.getAttribute('data-edit')); }; });
    box.querySelectorAll('[data-del]').forEach(function (b) {
      b.onclick = function () {
        if (!confirm('确认删除模式 ' + b.getAttribute('data-del') + '？已使用该模式的站点将回退为普通反代。')) return;
        delete modes[b.getAttribute('data-del')];
        dirty = true;
        render();
      };
    });
    const addBtn = document.getElementById('modesAddBtn');
    if (addBtn) addBtn.onclick = function () { openModal(null); };
    const saveBtn = document.getElementById('modesSaveBtn');
    if (saveBtn) saveBtn.onclick = function () {
      saveBtn.disabled = true;
      api('/__api/site-modes', { method: 'POST', body: JSON.stringify({ modes: modes }) }).then(function (r) {
        const msg = document.getElementById('modesMsg');
        if (r.ok) { modes = r.data.modes; dirty = false; render(); msg.textContent = '已保存'; msg.style.color = ''; }
        else { msg.textContent = (r.data && r.data.error) || '保存失败'; msg.style.color = 'var(--err)'; saveBtn.disabled = false; }
      }).catch(function (e) {
        const msg = document.getElementById('modesMsg');
        msg.textContent = '请求失败：' + String(e && e.message || e);
        msg.style.color = 'var(--err)';
        saveBtn.disabled = false;
      });
    };
  }
  api('/__api/site-modes').then(function (r) {
    if (!r.ok || !r.data || !r.data.modes) return;
    modes = r.data.modes;
    engines = r.data.engines || engines;
    render();
  }).catch(function () { box.innerHTML = '<div class="empty">加载失败，请刷新重试</div>'; });
})();

async function load() {
  const box = $('#list');
  let r;
  try {
    r = await api('/__api/sites');
  } catch (err) {
    box.innerHTML = '<div class="empty">加载失败（' + escapeHtml(err && err.message ? err.message : '网络错误') + '）<br><button type="button" class="ghost" style="margin-top:10px;" onclick="load()">点击重试</button></div>';
    return;
  }
  if (r.status === 401) { location.href = '/__login'; return; }
  if (!r.ok || !r.data) {
    box.innerHTML = '<div class="empty">加载失败，请稍后重试<br><button type="button" class="ghost" style="margin-top:10px;" onclick="load()">点击重试</button></div>';
    return;
  }
  // 站点徽标从注册表渲染（KV 可编辑，未配置用默认），注册表拉取失败回退普通徽标
  let modeMap = null;
  try {
    const mr = await api('/__api/site-modes');
    if (mr.ok && mr.data && mr.data.modes) modeMap = mr.data.modes;
  } catch {}
  function renderBadge(mode) {
    const m = (modeMap && (modeMap[mode] || modeMap.normal)) || { badge: '普通', badgeClass: 'badge-normal' };
    return '<span class="tag ' + escapeHtml(m.badgeClass) + '">' + escapeHtml(m.badge) + '</span>';
  }
  const sites = r.data.sites || [];
  if (!sites.length) {
    box.innerHTML = AUTHED
      ? '<div class="empty">还没有站点，先在上方添加一个。</div>'
      : '<div class="empty">还没有代理站点。</div>';
    return;
  }
  const origin = location.origin;
  box.innerHTML = sites.map(s => \`
    <div class="site">
      <div class="site-head">
        <span class="site-name">\${escapeHtml(s.name)} <span class="tag">\${escapeHtml(s.id)}</span>\${renderBadge(s.proxyMode)}</span>
        \${AUTHED ? '<span style="display:inline-flex;gap:6px;"><button type="button" class="mini" data-edit="' + s.id + '">编辑</button><button type="button" class="danger mini" data-del="' + s.id + '">删除</button></span>' : ''}
      </div>
      <div class="site-target">目标：\${escapeHtml(s.target)}\${s.port ? '（端口 ' + escapeHtml(s.port) + '）' : ''} <span class="tag latency" data-id="\${s.id}">上游测速中…</span></div>
      <div class="site-actions">
        <a class="site-link" href="/p/\${s.id}/" target="_blank" rel="noopener">访问链接：\${origin}/p/\${s.id}/</a>
      </div>
      <div class="site-actions">
        <button type="button" class="mini" data-copy="\${origin}/p/\${s.id}/" data-copymsg="copyMsg-\${s.id}">复制代理后链接</button>
        <button type="button" class="mini" data-copy="\${escapeHtml(s.target)}" data-copymsg="copyMsg-\${s.id}">复制代理前链接</button>
        <span class="msg" id="copyMsg-\${s.id}"></span>
      </div>
    </div>\`).join('');
  box.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      if (!confirm('确认删除该站点？')) return;
      await api('/__api/sites/' + encodeURIComponent(btn.dataset.del), { method: 'DELETE' });
      load();
    });
  });
  box.querySelectorAll('[data-edit]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const site = sites.find(x => x.id === btn.dataset.edit);
      if (site) openEditModal(site);
    });
  });
  box.querySelectorAll('[data-copy]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      copyText(btn.dataset.copy, btn, btn.dataset.copymsg);    });
  });

  // 上游测速：代理服务器→目标站延迟（异步，不阻塞列表）
  api('/__api/speedtest').then(r => {
    if (!r.ok || !r.data.results) return;
    const map = {};
    r.data.results.forEach(x => { map[x.id] = x; });
    box.querySelectorAll('.latency').forEach(el => {
      const x = map[el.dataset.id];
      if (!x) return;
      el.textContent = (x.status === 'unreachable' || x.status === 'timeout')
        ? '上游不可达'
        : '上游 ' + x.latency_ms + 'ms';
      el.style.color = x.latency_ms <= 300 ? 'var(--ok)' : (x.latency_ms <= 800 ? 'var(--accent)' : 'var(--err)');
    });
  }).catch(() => {});
}

load();

${authed ? `
try {
const logoutBtn = document.getElementById('logoutBtn');
if (logoutBtn) logoutBtn.addEventListener('click', async (e) => {
  e.preventDefault();
  try { await api('/__api/logout', { method: 'POST' }); } catch (e2) {}
  location.href = '/__admin';
});

// ===== 编辑站点弹窗 =====
function openEditModal(site) {
  const m = document.getElementById('editModal');
  document.getElementById('editId').value = site.id;
  document.getElementById('editName').value = site.name || '';
  document.getElementById('editTarget').value = site.target || '';
  document.getElementById('editPort').value = site.port || '';
  document.getElementById('editProxyMode').value = site.proxyMode === 'media' || site.proxyMode === 'ai' ? site.proxyMode : 'normal';
  document.getElementById('editMediaAuthBind').checked = !!site.mediaCacheAuthBind;
  document.getElementById('editMediaSkipLog').checked = !!site.mediaSkipDetailLog;
  document.getElementById('editAiKey').value = site.aiKey || '';
  document.getElementById('editAiKeys').value = site.aiKeys || '';
  syncEditModeFields(document.getElementById('editProxyMode').value);
  document.getElementById('editMsg').textContent = '';
  m.style.display = 'flex';
  const f = document.getElementById('editSlug');
  f.value = site.id;
}
/** 代理类型切换：联动模式说明与专属字段显隐（media 字段 / ai 字段） */
function syncEditModeFields(mode) {
  const hint = document.getElementById('editModeHint');
  const media = document.getElementById('editMediaFields');
  const ai = document.getElementById('editAiFields');
  if (mode === 'media') { hint.textContent = '视频分片走边缘缓存，加载像直连一样快'; media.style.display = ''; ai.style.display = 'none'; }
  else if (mode === 'ai') { hint.textContent = 'OpenAI 兼容接口转发，可配多上游 key 轮换与入口密钥'; media.style.display = 'none'; ai.style.display = ''; }
  else { hint.textContent = '通用网页 / 接口反代'; media.style.display = 'none'; ai.style.display = 'none'; }
}
function closeEditModal() { document.getElementById('editModal').style.display = 'none'; }

const editModal = document.getElementById('editModal');
if (editModal) {
  editModal.addEventListener('click', (e) => { if (e.target === editModal) closeEditModal(); });
  document.getElementById('editProxyMode').addEventListener('change', (e) => syncEditModeFields(e.target.value));
  document.getElementById('editSave').addEventListener('click', async (e) => {
    e.preventDefault();
    const oldId = document.getElementById('editId').value;
    const name = document.getElementById('editName').value.trim();
    const target = document.getElementById('editTarget').value.trim();
    const port = document.getElementById('editPort').value.trim();
    const slug = document.getElementById('editSlug').value.trim();
    // 名称是站点标识必须填写；网址/端口留空 = 保持不变（服务端同样忽略空值）
    if (!name) { document.getElementById('editMsg').textContent = '请填写名称'; document.getElementById('editMsg').style.color = 'var(--err)'; return; }
    const body = {
      name,
      proxyMode: document.getElementById('editProxyMode').value,
      mediaCacheAuthBind: document.getElementById('editMediaAuthBind').checked,
      mediaSkipDetailLog: document.getElementById('editMediaSkipLog').checked,
      aiKey: document.getElementById('editAiKey').value,
      aiKeys: document.getElementById('editAiKeys').value,
    };
    if (target) body.target = target;
    if (port) body.port = port;
    if (slug) body.slug = slug;
    const btn = document.getElementById('editSave');
    btn.disabled = true;
    try {
      const r = await api('/__api/sites/' + encodeURIComponent(oldId), { method: 'PUT', body: JSON.stringify(body) });
      if (r.ok) {
        closeEditModal();
        load();
      } else {
        const msg = document.getElementById('editMsg');
        msg.textContent = r.data.error || '保存失败';
        msg.style.color = 'var(--err)';
      }
    } catch (err) {
      const msg = document.getElementById('editMsg');
      msg.textContent = '请求失败：' + (err && err.message ? err.message : err);
      msg.style.color = 'var(--err)';
    }
    btn.disabled = false;
  });
  document.getElementById('editCancel').addEventListener('click', closeEditModal);
}

const addBtn = document.getElementById('addBtn');
if (addBtn) addBtn.addEventListener('click', async (e) => {
  e.preventDefault();
  const name = document.getElementById('siteName').value.trim();
  const slug = document.getElementById('siteSlug').value.trim();
  const target = document.getElementById('siteTarget').value.trim();
  const port = document.getElementById('sitePort').value.trim();
  const addModeEl = document.getElementById('addProxyMode');
  const proxyMode = addModeEl ? addModeEl.value : 'normal';
  if (!name || !target) { setMsg('addMsg', '请填写中文名称和网址', true); return; }
  setMsg('addMsg', '正在添加…');
  addBtn.disabled = true;
  try {
    const r = await api('/__api/sites', { method: 'POST', body: JSON.stringify({ name, slug, target, port, proxyMode }) });
    if (r.ok) {
      setMsg('addMsg', '添加成功');
      document.getElementById('siteName').value = '';
      document.getElementById('siteSlug').value = '';
      document.getElementById('siteTarget').value = '';
      document.getElementById('sitePort').value = '';
      load();
    } else {
      setMsg('addMsg', r.data.error || '添加失败', true);
    }
  } catch (err) {
    setMsg('addMsg', '请求失败：' + (err && err.message ? err.message : err), true);
  }
  addBtn.disabled = false;
});

// ---- 外观主题：选主题 / 跟随系统 / 设为全站默认 / 自定义 ----
const THEME_KEY = '${THEME_STORAGE_KEY}';
function setTheme(id) {
  document.documentElement.dataset.theme = id;
  try { localStorage.setItem(THEME_KEY, id); } catch (e) {}
  document.querySelectorAll('.theme-card').forEach(function (el) {
    el.classList.toggle('active', el.getAttribute('data-theme-id') === id);
  });
}
const themeGrid = document.getElementById('themeGrid');
if (themeGrid) themeGrid.addEventListener('click', function (e) {
  const card = e.target.closest('.theme-card');
  if (!card) return;
  setTheme(card.getAttribute('data-theme-id'));
  setMsg('themeMsg', '已切换到「' + card.querySelector('.meta b').textContent + '」（仅本机生效）', false);
});
const themeAutoBtn = document.getElementById('themeAutoBtn');
if (themeAutoBtn) themeAutoBtn.onclick = function () {
  try { localStorage.setItem(THEME_KEY, 'auto'); } catch (e) {}
  const dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? '${esc(themePreview.darkId)}' : '${esc(themePreview.lightId)}';
  document.querySelectorAll('.theme-card').forEach(function (el) { el.classList.remove('active'); });
  setMsg('themeMsg', '已跟随系统（深色用 ${esc(themePreview.darkId)}，浅色用 ${esc(themePreview.lightId)}）', false);
};
const themeDefaultBtn = document.getElementById('themeDefaultBtn');
if (themeDefaultBtn) themeDefaultBtn.onclick = async function () {
  const cur = document.documentElement.dataset.theme;
  themeDefaultBtn.disabled = true;
  try {
    const r = await api('/__api/themes', { method: 'POST', body: JSON.stringify({ default_theme: cur }) });
    setMsg('themeMsg', r.ok ? '已设为全站默认：' + cur : (r.data && r.data.error ? r.data.error : '保存失败'), !r.ok);
  } catch (e) { setMsg('themeMsg', '请求失败：' + (e && e.message ? e.message : e), true); }
  themeDefaultBtn.disabled = false;
};
const ctSaveBtn = document.getElementById('ctSaveBtn');
if (ctSaveBtn) ctSaveBtn.onclick = async function () {
  const id = document.getElementById('ctId').value.trim();
  const name = document.getElementById('ctName').value.trim();
  const raw = document.getElementById('ctVars').value.trim();
  let vars = null;
  try { vars = JSON.parse(raw); } catch (e) { setMsg('ctMsg', 'JSON 格式不对：' + (e && e.message ? e.message : e), true); return; }
  if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(id)) { setMsg('ctMsg', '标识只能是小写字母 / 数字 / 短横线，最长 24 位', true); return; }
  ctSaveBtn.disabled = true;
  try {
    const r = await api('/__api/themes/custom', { method: 'POST', body: JSON.stringify({ id: id, name: name, vars: vars }) });
    if (r.ok) { setMsg('ctMsg', '已保存，正在刷新…', false); setTimeout(function () { location.reload(); }, 400); }
    else setMsg('ctMsg', (r.data && r.data.error) ? r.data.error : '保存失败', true);
  } catch (e) { setMsg('ctMsg', '请求失败：' + (e && e.message ? e.message : e), true); }
  ctSaveBtn.disabled = false;
};
// ---- 自动轮换：设置保存 + 立刻换一套 ----
const rtSaveBtn = document.getElementById('rtSaveBtn');
if (rtSaveBtn) rtSaveBtn.onclick = async function () {
  rtSaveBtn.disabled = true;
  try {
    const r = await api('/__api/themes', { method: 'POST', body: JSON.stringify({
      rotate_mode: document.getElementById('rtMode').value,
      // 留空/填 0 时落回的默认值来自 SCHEMA（渲染时注入），脚本里不再写死 60
      rotate_interval_minutes: Number(document.getElementById('rtMinutes').value) || ${rtBounds.default},
      rotate_pool: document.getElementById('rtPool').value.trim(),
    }) });
    setMsg('rtMsg', r.ok ? '轮换设置已保存' : ((r.data && r.data.error) || '保存失败'), !r.ok);
  } catch (e) { setMsg('rtMsg', '请求失败：' + (e && e.message ? e.message : e), true); }
  rtSaveBtn.disabled = false;
};
const rtRollBtn = document.getElementById('rtRollBtn');
if (rtRollBtn) rtRollBtn.onclick = function () {
  const raw = document.getElementById('rtPool').value.trim().toLowerCase();
  const want = raw ? raw.split(/[\s,;]+/).filter(Boolean) : [];
  const all = [].map.call(document.querySelectorAll('.theme-card'), function (el) { return el.getAttribute('data-theme-id'); });
  let pool = want.filter(function (id) { return all.indexOf(id) >= 0; });
  if (!pool.length) pool = all;
  if (!pool.length) { setMsg('rtMsg', '没有可用主题', true); return; }
  setTheme(pool[Math.floor(Math.random() * pool.length)]);
  setMsg('rtMsg', '已随机换一套（仅本机，刷新还会再换）', false);
};
document.querySelectorAll('[data-del-theme]').forEach(function (btn) {
  btn.onclick = async function () {
    const id = btn.getAttribute('data-del-theme');
    btn.disabled = true;
    try {
      const r = await api('/__api/themes/custom/' + encodeURIComponent(id), { method: 'DELETE' });
      if (r.ok) location.reload(); else setMsg('ctMsg', (r.data && r.data.error) ? r.data.error : '删除失败', true);
    } catch (e) { setMsg('ctMsg', '请求失败', true); }
  };
});
} catch (e) { console.error('admin init:', e); }
` : ''}


// 面板分区切换：面板原本把站点、代理、优选、伪装全堆在一屏，首屏元素太多。
// 这里按 data-pane 归类成标签页，一次只显示一屏；元素本身不销毁，
// 所以所有既有 id 与「加载 / 保存」逻辑完全不用改。
// 当前分区记在 URL hash 里，刷新和分享链接都能回到同一屏。
const paneTabs = document.querySelectorAll('#paneTabs .tab');
const paneEls = document.querySelectorAll('[data-pane]');
function switchPane(name) {
  paneEls.forEach(function (el) {
    el.style.display = el.getAttribute('data-pane') === name ? '' : 'none';
  });
  paneTabs.forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-tab') === name);
  });
  // 驾驶舱要给全部历史做聚合，切到它才取数（脚本未就绪时它是空函数，直接跳过）
  if (name === 'stats' && typeof window.__statsEnsure === 'function') window.__statsEnsure();
  if (name === 'edge' && typeof window.__cfEnsure === 'function') window.__cfEnsure();
  try { history.replaceState(null, '', '#' + name); } catch (e) {}
}
if (paneTabs.length) {
  const tabNames = [].map.call(paneTabs, function (b) { return b.getAttribute('data-tab'); });
  const initial = String(location.hash || '').replace('#', '');
  switchPane(tabNames.indexOf(initial) >= 0 ? initial : tabNames[0]);
  paneTabs.forEach(function (b) {
    b.onclick = function () { switchPane(b.getAttribute('data-tab')); };
  });
  window.addEventListener('hashchange', function () {
    const n = String(location.hash || '').replace('#', '');
    if (tabNames.indexOf(n) >= 0) switchPane(n);
  });
}
${authed ? CONFIG_JS : ''}
${authed ? STATS_JS : ''}
${authed ? CF_JS : ''}

/* ===== 站点临时访问链接：列表 + 生成 + 停用 / 启用 + 删除 ===== */
(function () {
  var shSite = document.getElementById('shSite');
  if (!shSite) return;
  var shList = document.getElementById('shList');
  var shMsg = document.getElementById('shMsg');

  function fmtLeft(s) {
    if (s.disabled) return '已停用';
    if (s.expired_by_time) return '已过期';
    if (s.expired_by_hits) return '次数用尽';
    return '还剩 ' + s.left_hours + ' 小时';
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function render(list) {
    if (!list.length) { shList.innerHTML = '<div class="empty">还没有临时链接</div>'; return; }
    shList.innerHTML = list.map(function (s) {
      var hits = (s.hits || 0) + (s.max_hits > 0 ? ' / ' + s.max_hits : ' 次');
      return '<div class="site" data-token="' + esc(s.token) + '" data-path="' + esc(s.path) + '">'
        + '<div class="site-head"><span class="site-name">' + esc(s.note || '临时链接')
        + ' <span class="tag">' + esc(s.site) + '</span> <span class="tag">' + fmtLeft(s) + '</span></span></div>'
        + '<div class="site-target">' + esc(s.path) + '　访问 ' + hits + '</div>'
        + '<div class="site-actions">'
        + '<button type="button" class="mini" data-act="copy">复制链接</button>'
        + (s.disabled ? '<button type="button" class="mini" data-act="enable">启用</button>'
                      : '<button type="button" class="mini" data-act="revoke">停用</button>')
        + '<button type="button" class="danger mini" data-act="del">删除</button>'
        + '</div></div>';
    }).join('');
  }
  // api() 返回包装结构 { ok, status, data }，业务字段一律在 r.data 里（与页面其他区块一致）
  function gotoLoginIf401(r) { if (r && r.status === 401) { location.href = '/__login'; return true; } return false; }
  function loadShares() {
    return api('/__api/shares').then(function (r) {
      if (gotoLoginIf401(r)) return;
      render((r.data && r.data.shares) || []);
    });
  }
  function loadSites() {
    return api('/__api/sites').then(function (r) {
      if (gotoLoginIf401(r)) return;
      var sites = (r.data && r.data.sites) || [];
      shSite.innerHTML = '<option value="">选择站点…</option>'
        + sites.map(function (s) { return '<option value="' + esc(s.id) + '">' + esc(s.name || s.id) + '</option>'; }).join('');
    });
  }
  shList.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-act]');
    if (!btn) return;
    var row = e.target.closest('.site');
    var token = row.getAttribute('data-token');
    var act = btn.getAttribute('data-act');
    if (act === 'copy') {
      // 完整 URL 直接取行上的 data-path 拼 origin，不从展示文本反解析
      // （展示文案一改 split 就解析错）；copyText 自带 execCommand 降级，
      // navigator.clipboard 不可用/被拒时也能复制成功
      var full = location.origin + (row.getAttribute('data-path') || '');
      copyText(full, btn);
      setMsg('shMsg', '已复制：' + full, false);
      return;
    }
    var call = act === 'del'
      ? api('/__api/shares/' + encodeURIComponent(token), { method: 'DELETE' })
      : api('/__api/shares/' + encodeURIComponent(token) + '/' + act, { method: 'POST', body: JSON.stringify({}) });
    call.then(function (r) {
      if (gotoLoginIf401(r)) return;
      var err = r.data && r.data.error;
      setMsg('shMsg', err ? err : '已更新', !!err);
      render((r.data && r.data.shares) || []);
    }).catch(function (err) { setMsg('shMsg', String(err && err.message || err), true); });
  });
  document.getElementById('shCreate').onclick = function () {
    var site = shSite.value;
    if (!site) { setMsg('shMsg', '请先选择站点', true); return; }
    api('/__api/shares', {
      method: 'POST',
      body: JSON.stringify({
        site: site,
        days: document.getElementById('shDays').value,
        max_hits: document.getElementById('shHits').value,
        note: document.getElementById('shNote').value,
      }),
    }).then(function (r) {
      if (gotoLoginIf401(r)) return;
      var err = r.data && r.data.error;
      if (err) { setMsg('shMsg', err, true); return; }
      setMsg('shMsg', '已生成：' + location.origin + (r.data && r.data.path), false);
      loadShares();
    }).catch(function (e) { setMsg('shMsg', String(e && e.message || e), true); });
  };
  loadSites();
  loadShares();
})();
</script>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
  });
}

// ===================== 临时订阅管理页 =====================
// 独立页面 /__tsub：创建 / 改有效期 / 停用启用 / 删除临时订阅链接。
// 服务端先渲染首屏列表，前端 JS 负责增删改后刷新，与主页风格一致。

function statusBadge(rec) {
  if (rec.disabled) return '<span class="badge off">已停用</span>';
  if (!tempsubs.isActive(rec)) return '<span class="badge off">已过期</span>';
  const left = new Date(rec.expires_at).getTime() - Date.now();
  const d = Math.floor(left / 86400000);
  const h = Math.floor((left % 86400000) / 3600000);
  const remain = d > 0 ? `剩 ${d} 天 ${h} 时` : `剩 ${h} 时 ${Math.floor((left % 3600000) / 60000)} 分`;
  return `<span class="badge on">有效 · ${remain}</span>`;
}

// 记录存的是 UTC ISO 串；按浏览器本地时区展示，避免把 13:15 UTC 误读成本地时间。
function fmtLocal(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function tempSubPage(origin) {
  let listHtml = '<div class="empty">加载中…</div>';
  try {
    const items = await tempsubs.listAll();
    listHtml = items.length ? items.map((r) => {
      const url = `${origin}/tsub/${encodeURIComponent(r.id)}`;
      return `<div class="tsub">
  <div class="tsub-head">
    <span class="tsub-name">${esc(r.name)} ${statusBadge(r)}</span>
    <span style="display:inline-flex;gap:6px;flex-wrap:wrap;">
      <button type="button" class="mini" data-renew="${esc(r.id)}">改有效期</button>
      <button type="button" class="mini" data-toggle="${esc(r.id)}" data-disabled="${r.disabled ? '1' : '0'}">${r.disabled ? '恢复启用' : '置为失效'}</button>
      <button type="button" class="danger mini" data-del="${esc(r.id)}">删除</button>
    </span>
  </div>
  <div class="tsub-meta">UUID：<code>${esc(r.uuid)}</code></div>
  <div class="tsub-meta">创建：${esc(fmtLocal(r.created_at))} · 到期：${esc(fmtLocal(r.expires_at))}（本地时间）</div>
  <div class="tsub-meta">订阅链接：<code class="sub-url">${esc(url)}</code></div>
  <div class="tsub-actions">
    <button type="button" class="mini" data-copy="${esc(url)}" data-msg="m-${esc(r.id)}">复制订阅链接</button>
    <span class="msg" id="m-${esc(r.id)}"></span>
  </div>
</div>`;
    }).join('') : '<div class="empty">还没有临时订阅，创建一个吧。</div>';
  } catch {
    listHtml = '<div class="empty">列表加载失败，请刷新重试。</div>';
  }

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>临时订阅管理 · Any-Proxy</title>
<style>
:root { --bg:#f4f6fb; --card:#fff; --line:#e2e8f0; --txt:#0f172a; --muted:#64748b; --accent:#2563eb; --accent-hover:#1d4ed8; --ok:#16a34a; --err:#dc2626; --input:#f1f5f9; --radius:14px; --radius-sm:10px; --shadow:0 1px 2px rgba(15,23,42,.04),0 6px 18px rgba(15,23,42,.06); }
:root[data-theme="dark"] { --bg:#0f172a; --card:#1e293b; --line:#334155; --txt:#e2e8f0; --muted:#94a3b8; --accent:#38bdf8; --accent-hover:#7dd3fc; --ok:#4ade80; --err:#f87171; --input:#0b1220; }
* { box-sizing:border-box; }
body { margin:0; font-family:-apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif; background:var(--bg); color:var(--txt); min-height:100vh; font-size:14px; line-height:1.6; }
.wrap { max-width:860px; margin:0 auto; padding:32px 16px 64px; }
.topbar { display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:20px; flex-wrap:wrap; }
h1 { font-size:20px; margin:0; }
a.back { color:var(--accent); text-decoration:none; font-size:13px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:var(--radius); padding:20px; margin-bottom:16px; box-shadow:var(--shadow); }
.card h2 { font-size:15px; margin:0 0 10px; }
.hint { font-size:12px; color:var(--muted); margin:4px 0 0; }
label { display:block; font-size:13px; color:var(--muted); margin:12px 0 6px; }
input { width:100%; padding:10px 12px; border-radius:var(--radius-sm); border:1px solid var(--line); background:var(--input); color:var(--txt); font-size:14px; outline:none; }
.row { display:flex; gap:10px; margin-top:14px; flex-wrap:wrap; align-items:center; }
button { padding:9px 16px; border:none; border-radius:var(--radius-sm); font-size:14px; cursor:pointer; background:var(--accent); color:#fff; font-weight:600; }
button:hover { background:var(--accent-hover); }
button.mini { padding:6px 12px; font-size:12px; background:transparent; color:var(--accent); border:1px solid var(--accent); font-weight:400; }
button.mini:hover { background:rgba(37,99,235,.1); }
button.danger.mini { color:var(--err); border-color:var(--err); }
button.danger.mini:hover { background:rgba(220,38,38,.1); }
button.ghost { background:transparent; color:var(--muted); border:1px solid var(--line); }
.tsub { border:1px solid var(--line); border-radius:var(--radius-sm); padding:14px; margin-bottom:12px; }
.tsub-head { display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap; align-items:center; }
.tsub-name { font-weight:600; }
.tsub-meta { color:var(--muted); font-size:12px; margin-top:6px; word-break:break-all; }
.tsub-actions { display:flex; gap:8px; margin-top:10px; align-items:center; }
code { font-family:ui-monospace,Menlo,Consolas,monospace; font-size:12px; }
.sub-url { color:var(--accent); }
.badge { display:inline-block; font-size:11px; padding:2px 8px; border-radius:999px; margin-left:6px; vertical-align:middle; }
.badge.on { background:rgba(22,163,74,.12); color:var(--ok); }
.badge.off { background:rgba(220,38,38,.12); color:var(--err); }
.msg { font-size:12px; min-height:16px; }
.msg.ok { color:var(--ok); } .msg.err { color:var(--err); }
.empty { color:var(--muted); text-align:center; padding:24px 0; }
</style>
</head>
<body>
<div class="wrap">
  <div class="topbar">
    <h1>临时订阅管理</h1>
    <a class="back" href="/__admin">← 返回主页</a>
  </div>

  <div class="card">
    <h2>创建临时订阅</h2>
    <div class="hint">新建一条独立 UUID 的订阅链接，默认 1 天后到期；节点配置与代理面板完全一致。</div>
    <label for="newName">备注名称（可选）</label>
    <input id="newName" placeholder="例如：同事小王">
    <label for="newDays">有效期（天，默认 1）</label>
    <input id="newDays" type="number" min="1" max="3650" value="1" style="max-width:220px;">
    <div class="row">
      <button type="button" id="createBtn">创建</button>
      <span class="msg" id="createMsg"></span>
    </div>
  </div>

  <div class="card">
    <h2>订阅列表</h2>
    <div class="hint">「改有效期」可按天数重置到期时间；「置为失效」立即停用该链接（可再启用）；删除后链接永久失效。</div>
    <div id="list" style="margin-top:12px;">${listHtml}</div>
  </div>
</div>

<script>
const $ = s => document.querySelector(s);
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const res = await fetch(path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
// 客户端：把 UTC ISO 串格式化为浏览器本地时间展示
function fmtLocal(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function setMsg(id, text, isErr) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text; el.className = 'msg ' + (isErr ? 'err' : 'ok');
}
function copyText(text, btn, msgId) {
  const done = () => { if (btn) { const o = btn.textContent; btn.textContent = '已复制'; setTimeout(() => btn.textContent = o, 1500); } };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(()=>{});
  else { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); done(); }
}
async function load() {
  const box = $('#list');
  const r = await api('/__api/tempsubs?t=' + Date.now());
  if (r.status === 401) { location.href = '/__login'; return; }
  if (!r.ok || !r.data) { box.innerHTML = '<div class="empty">加载失败，请刷新重试。</div>'; return; }
  const items = r.data.items || [];
  if (!items.length) { box.innerHTML = '<div class="empty">还没有临时订阅，创建一个吧。</div>'; return; }
  box.innerHTML = items.map(x => {
    const url = x.sub_url;
    const badge = x.disabled ? '<span class="badge off">已停用</span>'
      : (!x.active ? '<span class="badge off">已过期</span>'
      : '<span class="badge on">有效</span>');
    return '<div class="tsub">'
      + '<div class="tsub-head"><span class="tsub-name">' + esc(x.name) + ' ' + badge + '</span>'
      + '<span style="display:inline-flex;gap:6px;flex-wrap:wrap;">'
      + '<button type="button" class="mini" data-renew="' + esc(x.id) + '">改有效期</button>'
      + '<button type="button" class="mini" data-toggle="' + esc(x.id) + '" data-disabled="' + (x.disabled?'1':'0') + '">' + (x.disabled?'恢复启用':'置为失效') + '</button>'
      + '<button type="button" class="danger mini" data-del="' + esc(x.id) + '">删除</button>'
      + '</span></div>'
      + '<div class="tsub-meta">UUID：<code>' + esc(x.uuid) + '</code></div>'
      + '<div class="tsub-meta">创建：' + esc(fmtLocal(x.created_at)) + ' · 到期：' + esc(fmtLocal(x.expires_at)) + '（本地时间）</div>'
      + '<div class="tsub-meta">订阅链接：<code class="sub-url">' + esc(url) + '</code></div>'
      + '<div class="tsub-actions"><button type="button" class="mini" data-copy="' + esc(url) + '" data-msg="m-' + esc(x.id) + '">复制订阅链接</button><span class="msg" id="m-' + esc(x.id) + '"></span></div>'
      + '</div>';
  }).join('');
  bindActions(box);
}
function bindActions(box) {
  box.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => copyText(b.dataset.copy, b, b.dataset.msg));
  box.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('确认删除该临时订阅？链接将立即永久失效。')) return;
    await api('/__api/tempsubs/' + encodeURIComponent(b.dataset.del), { method: 'DELETE' });
    load();
  });
  box.querySelectorAll('[data-toggle]').forEach(b => b.onclick = async () => {
    const disable = b.dataset.disabled !== '1';
    await api('/__api/tempsubs/' + encodeURIComponent(b.dataset.toggle), { method: 'PUT', body: JSON.stringify({ disabled: disable }) });
    load();
  });
  box.querySelectorAll('[data-renew]').forEach(b => b.onclick = async () => {
    const v = prompt('设为几天后到期？（从现在开始计算）', '1');
    if (v === null) return;
    const days = parseInt(v, 10);
    if (!days || days < 1) { alert('请输入大于 0 的天数'); return; }
    await api('/__api/tempsubs/' + encodeURIComponent(b.dataset.renew), { method: 'PUT', body: JSON.stringify({ days }) });
    load();
  });
}
$('#createBtn').onclick = async () => {
  const btn = $('#createBtn');
  btn.disabled = true;
  setMsg('createMsg', '创建中…');
  try {
    const r = await api('/__api/tempsubs', { method: 'POST', body: JSON.stringify({ name: $('#newName').value, days: $('#newDays').value }) });
    if (r.ok) { setMsg('createMsg', '已创建', false); $('#newName').value=''; load(); }
    else setMsg('createMsg', r.data.error || '创建失败', true);
  } catch (e) { setMsg('createMsg', '请求失败', true); }
  btn.disabled = false;
};
load();
</script>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
  });
}

export { handleAdmin, adminPage, tempSubPage };
