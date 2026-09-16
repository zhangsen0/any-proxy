import { json, esc, kvKey, validTarget } from './util.js';
import { runtime } from './runtime.js';
import { listSites, getSite, autoSlug, validSlug, buildTarget, addSite } from './sites.js';
import { autoUpdatePreferredDns, filterUsableIps, applyDnsWithSelfCheck, proxyHost, targetHost } from './dns.js';
import { subscriptionUrl, fetchSubscriptionCandidates } from './subs.js';
import * as tempsubs from './tempsubs.js';

// 站点管理：REST API + 服务端渲染的管理页

/**
 * 从请求推导优选所需上下文（目标域名 + 总预算）。
 * 目标域名不再写死：PROXY_HOST 变量优先，否则用当前请求的 hostname。
 */
async function dnsContext(request, url, env) {
  return {
    host: await targetHost(env, url.hostname),
    origin: url.origin,
    deadlineMs: Date.now() + (Number(env && env.DNS_BUDGET_MS) || 22000),
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

  // DNS 自动优选更新频率（分钟）：GET 读取（未登录可读）
  if (path === '/__api/dns-config') {
    if (request.method === 'GET') {
      let interval = 720;
      try {
        const c = await runtime.KV.get('DNS_CONFIG');
        if (c) interval = parseInt(c, 10) || 720;
      } catch {}
      return json({ ok: true, interval_minutes: interval });
    }
    if (request.method === 'POST') {
      // 登录校验已由 router.js 统一拦截，此处不再重复判断
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'invalid json' }, 400);
      }
      const interval = parseInt(body.interval_minutes, 10);
      if (!interval || interval < 5 || interval > 1440) {
        return json({ error: '更新频率需在 5 ~ 1440 分钟之间' }, 400);
      }
      await runtime.KV.put('DNS_CONFIG', String(interval));
      return json({ ok: true, interval_minutes: interval });
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

  // 优选 IP 池（PREF_IPS，仅 DNS 自动优选用，与 edgetunnel 的 ADD.txt 解耦）：GET 读取 / POST 保存（apply=true 时先测通再更新 DNS A 记录）
  if (path === '/__api/preferred-ips') {
    if (request.method === 'GET') {
      let ips = [];
      try {
        const add = await runtime.KV.get('PREF_IPS');
        if (add) ips = add.split(/\r?\n/).map(s => s.trim()).filter(s => /^\d{1,3}(\.\d{1,3}){3}$/.test(s));
      } catch {}
      return json({ ok: true, ips });
    }
    if (request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'invalid json' }, 400);
      }
      const ips = String(body.ips || '').split(/\r?\n|,|;|\s+/).map(s => s.trim()).filter(s => /^\d{1,3}(\.\d{1,3}){3}$/.test(s));
      if (!ips.length) return json({ error: '没有有效的 IP（每行一个 IPv4 地址）' }, 400);
      const uniq = [...new Set(ips)].slice(0, 30);
      await runtime.KV.put('PREF_IPS', uniq.join('\n'));
      let updated = null;
      if (body.apply && uniq.length) {
        // 立即应用：并发 HTTP 探测过滤不可达 IP，再写入 A 记录（应用后自检，不可用自动回滚）
        const ctx = await dnsContext(request, url, env);
        if (!ctx.host) {
          updated = { ok: false, error: '无法确定优选目标域名：请配置 PROXY_HOST' };
        } else {
          const usable = await filterUsableIps(uniq, { host: ctx.host, deadlineMs: ctx.deadlineMs, budgetMs: 10000 });
          const res = await applyDnsWithSelfCheck(env, usable, ctx);
          updated = { ok: res.ok, ips: res.ips || [], changed: res.changed || 0, verified: res.verified, error: res.error, note: res.note || '', host: ctx.host };
        }
      }
      return json({ ok: true, count: uniq.length, updated });
    }
  }

  // GET /__api/preferred-candidates -> 从**订阅链接**拉取节点 IP 作为浏览器优选候选
  // 来源优先级：面板配置（KV SUB_URL）→ 环境变量 SUB_URL → 自动推导的本机 /sub（token 口径与 edgetunnel 一致）。
  // 默认只返回归属边缘网络的 IP：订阅里常混入第三方节点，不筛会让优选池被无用 IP 占满、
  // 并让「立即更新优选 IP」逐个探测这些不可达地址直到超时。可用 SUB_STRICT=0 关闭筛选。
  if (request.method === 'GET' && path === '/__api/preferred-candidates') {
    const strictCfg = String((env && env.SUB_STRICT) || '').trim().toLowerCase();
    const strict = strictCfg === '0' || strictCfg === 'false' ? false : true;
    const limit = Number(env && env.SUB_CANDIDATE_LIMIT) || 40;
    let res;
    try {
      res = await fetchSubscriptionCandidates(env, {
        origin: url.origin,
        hostname: proxyHost(env, url.hostname) || url.hostname,
        limit,
        strict,
        signal: AbortSignal.timeout(9000),
      });
    } catch (e) {
      return json({ ok: false, ips: [], error: '候选拉取异常：' + (e && e.message ? e.message : e) }, 502);
    }
    return json({
      ok: true,
      ips: res.ips,
      source: res.source,
      note: res.note || '',
      stats: { addresses: res.addresses || 0, filtered: res.filtered || 0, ranges: res.ranges || '' },
    });
  }

  // GET / POST /__api/sub-config -> 订阅链接配置（面板可填，存 KV；留空则回退环境变量 SUB_URL）
  if (path === '/__api/sub-config') {
    if (request.method === 'GET') {
      const saved = await runtime.KV.get('SUB_URL').catch(() => null);
      return json({
        ok: true,
        sub_url: saved || '',
        env: String((env && (env.SUB_URL || env.sub_url)) || ''),
        effective: (await subscriptionUrl(env, url.origin)) || '',
      });
    }
    if (request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      const v = String(body.sub_url || '').trim();
      if (!v) {
        try { await runtime.KV.delete('SUB_URL'); } catch {}
        return json({ ok: true, sub_url: '' });
      }
      if (!/^https?:\/\//i.test(v) && !v.startsWith('/')) {
        return json({ error: '请填写完整 URL（http(s)://…）或以 / 开头的路径（如 /tsub/xxx）' }, 400);
      }
      await runtime.KV.put('SUB_URL', v);
      return json({ ok: true, sub_url: v });
    }
  }

  // GET /__api/pool-config -> 优选池 & 健康检查配置（GOOD_IPS / 候选域名池 / 上次健康检查时间），需登录
  // POST /__api/pool-config -> 保存候选域名池（PREF_DOMAINS）或写回 GOOD_IPS（healthcheck 自愈结果），需登录
  if (path === '/__api/pool-config') {
    if (request.method === 'GET') {
      const good = []; let domains = [];
      try { const g = await runtime.KV.get('GOOD_IPS'); if (g) good.push(...g.split(/\r?\n/).map(s => s.trim()).filter(Boolean)); } catch {}
      try {
        const d = await runtime.KV.get('PREF_DOMAINS');
        if (d) domains.push(...d.split(/\r?\n/).map(s => s.trim()).filter(Boolean));
        else {
          // KV 无配置时用环境变量做种子（wrangler.toml / Actions 变量可配），而不是在代码里写死一份域名清单。
          // 都没配就返回空数组并带提示，由面板引导用户填写，保证 fork 后不会出现「改不到却又悄悄生效」的兜底行为。
          const seed = String((env && (env.PREF_DOMAINS || env.pref_domains)) || '')
            .split(/\r?\n|,|;|\s+/).map(s => s.trim().toLowerCase())
            .filter(s => /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(s));
          domains.push(...seed);
          if (seed.length) {
            try { await runtime.KV.put('PREF_DOMAINS', seed.join('\n')); } catch {}
          }
        }
      } catch {}
      let last = 0;
      try { const l = await runtime.KV.get('HC_LAST_RUN'); if (l) last = parseInt(l, 10) || 0; } catch {}
      return json({ ok: true, good_ips: good, pref_domains: domains, last_run: last });
    }
    if (request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
      const out = { ok: true };
      // 写回已验证可用集 GOOD_IPS（healthcheck 自愈结果，存后端由 runtime.KV 统一决定）；与 PREF_DOMAINS 可独立更新
      if (body.good_ips !== undefined) {
        const ips = String(body.good_ips).split(/\r?\n|,|;|\s+/).map(s => s.trim()).filter(s => /^\d{1,3}(\.\d{1,3}){3}$/.test(s));
        if (!ips.length) return json({ error: '没有有效的 IP（每行一个 IPv4 地址）' }, 400);
        await runtime.KV.put('GOOD_IPS', [...new Set(ips)].slice(0, 30).join('\n'));
        out.good_ips = ips;
      }
      if (body.pref_domains !== undefined) {
        const domains = String(body.pref_domains || '').split(/\r?\n|,|;|\s+/).map(s => s.trim().toLowerCase()).filter(s => /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(s));
        if (!domains.length) return json({ error: '请输入有效域名（每行一个）' }, 400);
        await runtime.KV.put('PREF_DOMAINS', domains.join('\n'));
        out.pref_domains = domains;
      }
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
      if (body.slug !== undefined && String(body.slug).trim() !== '' && String(body.slug).trim() !== id) {
        const ns = String(body.slug).trim();
        if (!validSlug(ns)) return json({ error: '后缀格式不合法（字母数字 - _，最长 40）' }, 400);
        if (await getSite(ns)) return json({ error: '该后缀已被占用' }, 400);
        site.id = ns;
        await runtime.KV.put(kvKey(ns), JSON.stringify(site));
        await runtime.KV.delete(kvKey(id));
        keyId = ns;
      }
      if (body.name !== undefined) site.name = String(body.name).trim();
      const wantTarget = body.target !== undefined || body.port !== undefined;
      if (wantTarget) {
        const built = buildTarget(body.target !== undefined ? body.target : site.target, body.port !== undefined ? body.port : site.port);
        if (!built) return json({ error: '网址不合法' }, 400);
        site.target = built.url;
        site.host = built.host;
        site.scheme = built.scheme;
        site.port = built.port;
      }
      await runtime.KV.put(kvKey(keyId), JSON.stringify(site));
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

async function adminPage(authed, origin, env) {
  // 服务端直接渲染站点列表（首屏秒开，不依赖前端 fetch；前端 load() 仅用于增删/操作后刷新）
  // 页面上展示的「优选目标域名」由配置推导，不写死任何域名
  const pageHost = proxyHost(env, String(origin || '').replace(/^https?:\/\//i, '').split(/[/?#]/)[0].split(':')[0]);
  let listHtml = '<div class="empty">加载中…</div>';
  try {
    const sites = await listSites();
    listHtml = sites.length
      ? sites.map(s => `<div class="site">
      <div class="site-head">
        <span class="site-name">${esc(s.name)} <span class="tag">${esc(s.id)}</span></span>
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
    </div>`).join('')
      : `<div class="empty">${authed ? '还没有站点，先在上方添加一个。' : '还没有代理站点。'}</div>`;
  } catch {}
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Any-Proxy · 统一代理管理</title>
  <style>
  :root { --bg:#f4f6fb; --card:#ffffff; --line:#e2e8f0; --txt:#0f172a; --muted:#64748b; --accent:#2563eb; --accent-hover:#1d4ed8; --ok:#16a34a; --err:#dc2626; --input:#f1f5f9; --on-accent:#ffffff; --radius:14px; --radius-sm:10px; --radius-xs:8px; --shadow:0 1px 2px rgba(15,23,42,.04), 0 6px 18px rgba(15,23,42,.06); --ring:0 0 0 3px rgba(37,99,235,.18); --ok-bg:rgba(22,163,74,.10); --err-bg:rgba(220,38,38,.10); --hover:rgba(100,116,139,.06); --sp-1:8px; --sp-2:12px; --sp-3:16px; --sp-4:24px; }
  :root[data-theme="dark"] { --bg:#0f172a; --card:#1e293b; --line:#334155; --txt:#e2e8f0; --muted:#94a3b8; --accent:#38bdf8; --accent-hover:#7dd3fc; --ok:#4ade80; --err:#f87171; --input:#0b1220; --on-accent:#06283d; --shadow:0 1px 2px rgba(0,0,0,.30), 0 8px 24px rgba(0,0,0,.35); --ring:0 0 0 3px rgba(56,189,248,.25); --ok-bg:rgba(74,222,128,.12); --err-bg:rgba(248,113,113,.12); --hover:rgba(148,163,184,.08); }
  @media (prefers-color-scheme: dark) { :root[data-theme="auto"] { --bg:#0f172a; --card:#1e293b; --line:#334155; --txt:#e2e8f0; --muted:#94a3b8; --accent:#38bdf8; --accent-hover:#7dd3fc; --ok:#4ade80; --err:#f87171; --input:#0b1220; --on-accent:#06283d; --shadow:0 1px 2px rgba(0,0,0,.30), 0 8px 24px rgba(0,0,0,.35); --ring:0 0 0 3px rgba(56,189,248,.25); --ok-bg:rgba(74,222,128,.12); --err-bg:rgba(248,113,113,.12); --hover:rgba(148,163,184,.08); } }
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
  .card { background:var(--card); border:1px solid var(--line); border-radius:var(--radius); padding:20px; margin-bottom:var(--sp-3); box-shadow:var(--shadow); transition:border-color .15s, box-shadow .15s; }
  .card > h2:first-child { margin-top:0; }
  .card h2 { font-size:15px; margin:0 0 var(--sp-3); font-weight:600; }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:0 var(--sp-3); }
  @media (max-width:560px){ .grid2{ grid-template-columns:1fr; gap:0; } }
  label { display:block; font-size:13px; color:var(--muted); margin:var(--sp-3) 0 6px; }
  input, textarea { width:100%; padding:10px 12px; border-radius:var(--radius-sm); border:1px solid var(--line); background:var(--input); color:var(--txt); font-size:14px; outline:none; transition:border-color .15s, box-shadow .15s, background .15s; }
  input:focus, textarea:focus, input:focus-visible, textarea:focus-visible { border-color:var(--accent); box-shadow:var(--ring); }
  input:hover:not(:focus), textarea:hover:not(:focus) { border-color:var(--muted); }
  textarea { resize:vertical; line-height:1.5; }
  .row { display:flex; gap:var(--sp-2); margin-top:var(--sp-3); flex-wrap:wrap; align-items:center; }
  button { padding:10px 18px; border:none; border-radius:var(--radius-sm); font-size:14px; cursor:pointer; background:var(--accent); color:var(--on-accent); font-weight:600; transition:background .15s, transform .05s, box-shadow .15s; }
  button:hover { background:var(--accent-hover); }
  button:active { transform:translateY(1px); }
  button:focus-visible { outline:none; box-shadow:var(--ring); }
  button.danger { background:transparent; color:var(--err); border:1px solid var(--err); }
  button.danger:hover { background:var(--err-bg); }
  button:disabled { opacity:.5; cursor:not-allowed; transform:none; }
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
  .notice { color:var(--muted); font-size:13px; line-height:1.6; }
  .notice a { color:var(--accent); }
  @media (max-width:640px) {
    .wrap { padding:20px 12px 48px; }
    .card { padding:16px; }
    .topbar { margin-bottom:var(--sp-3); }
    .row { gap:var(--sp-1); }
    button { padding:10px 14px; }
  }
</style>
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
  <div class="card" style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
    <div>
      <h2 style="margin:0 0 4px;">代理管理面板</h2>
      <div class="notice" style="font-size:12px;">VLESS / Trojan / SS 节点订阅、流量日志与优选 IP 配置（edgetunnel），与站点管理共用同一套登录。</div>
    </div>
    <a class="ghost-link" href="/admin" target="_blank" rel="noopener">打开代理面板 →</a>
  </div>` : ''}

  ${authed ? `
  <div class="card" style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
    <div>
      <h2 style="margin:0 0 4px;">临时订阅管理</h2>
      <div class="notice" style="font-size:12px;">创建限时有效的临时订阅链接（独立 UUID，默认 1 天到期），可改有效期、手动置为失效或删除；节点配置与代理面板一致。</div>
    </div>
    <a class="ghost-link" href="/__tsub" target="_blank" rel="noopener">打开临时订阅管理 →</a>
  </div>` : ''}

  ${authed ? `
  <div class="card" id="addCard">
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
    <div class="row">
      <button type="button" id="addBtn">添加站点</button>
    </div>
    <div class="msg" id="addMsg"></div>
  </div>` : ''}

  ${authed ? `
  <div class="card" id="dnsCard">
    <h2>DNS 自动优选</h2>
    <div class="hint" style="margin:-8px 0 8px;">定时从 <span class="tag">sub 订阅节点</span> + 优选池测速排序，HTTP 探测过滤不可达后写入 A 记录，域名始终指向可用的 CF 泛播边缘。反代链接自动走优选 IP，浏览器直连、客户端零配置。</div>
    <label for="dnsInterval">自动更新频率（分钟）</label>
    <div class="row" style="margin-top:6px;">
      <input id="dnsInterval" type="number" min="5" max="1440" style="max-width:220px;" placeholder="默认 720（12 小时）">
      <button type="button" id="dnsBtn">保存频率</button>
      <button type="button" id="dnsRunBtn" class="ghost">立即更新优选 IP</button>
    </div>
    <div class="hint" style="margin-top:6px;">范围 5 ~ 1440 分钟（12 小时 = 720）；保存后立即生效，下一个检查周期按新频率执行。立即更新不等待周期，马上测通并切换 A 记录。</div>
    <label for="subUrl" style="margin-top:14px;">订阅链接（浏览器优选从这里拉取候选 IP）</label>
    <input id="subUrl" placeholder="粘贴完整订阅链接，或以 / 开头的路径如 /tsub/xxxx">
    <div class="row" style="margin-top:6px;">
      <button type="button" id="subBtn">保存订阅链接</button>
      <span class="hint" id="subState" style="margin:0;"></span>
    </div>
    <div class="hint" style="margin-top:6px;">留空则回退到本机 <span class="tag">/sub</span>（token 按代理引擎同一口径推导）。第三方订阅常混入非边缘网络的节点，候选会按官方 IP 段过滤后再参与测速——否则这些不可达地址会占满优选池，还会拖慢「立即更新优选 IP」。</div>
    <label for="prefIps" style="margin-top:14px;">优选 IP 列表（订阅候选 / 本地测速结果，每行一个）</label>
    <textarea id="prefIps" rows="5" placeholder="每行一个 IPv4，例如 104.17.109.97" style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;"></textarea>
    <div class="row" style="margin-top:8px;">
      <button type="button" id="prefBtn">保存优选池</button>
      <button type="button" id="autoBtn" class="ghost">浏览器自动优选</button>
    </div>
    <div class="hint" style="margin-top:6px;">「保存优选池」仅保存 IP 列表（不更新 DNS，不影响 edgetunnel 代理入口）；需要立即切换 A 记录请点上方「立即更新优选 IP」。「浏览器自动优选」先从上面的订阅链接拉候选并发测速（约 5~15 秒），最快的自动填入，再点「保存优选池」。</div>
    <div class="msg" id="subMsg"></div>
    <div class="msg" id="dnsMsg"></div>
    <div class="msg" id="dnsRunMsg"></div>
    <div class="msg" id="prefMsg"></div>
  </div>
  <div class="card" id="poolCard">
    <h2>优选池 &amp; 健康检查</h2>
    <div class="hint" style="margin:-8px 0 4px;">已验证可用集（GOOD_IPS，自动优选 / 健康检查优先使用的 CF 泛播 IP）：<b id="poolGood" style="color:var(--ok);font-family:ui-monospace,Menlo,Consolas,monospace;font-weight:600;">加载中…</b></div>
    <div class="hint" style="margin:6px 0 4px;">健康检查：GitHub Actions 每 12 小时自动检测 A 记录，发现 1034 / 不可达时从可用集自愈（Actions 页可手动触发「Health Check &amp; Auto Repair」）。上次执行：<b id="poolLast">—</b></div>
    <label for="poolDomains" style="margin-top:10px;">候选域名池（健康检查兜底解析 CF 泛播 IP 的域名，每行一个）</label>
    <textarea id="poolDomains" rows="4" placeholder="www.cloudflare.com&#10;speed.cloudflare.com&#10;time.cloudflare.com" style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;"></textarea>
    <div class="row" style="margin-top:8px;">
      <button type="button" id="poolSaveBtn">保存域名池</button>
      ${env && env.GH_ACTIONS_URL ? `<a class="ghost-link" href="${esc(env.GH_ACTIONS_URL)}" target="_blank" rel="noopener" style="padding:10px 14px;display:inline-block;">手动触发健康检查 →</a>` : ''}
    </div>
    <div class="hint" style="margin-top:6px;">域名池用于健康检查兜底：当优选池不足时，解析这些域名得到当前 CF 泛播 IP 再扫描可用性。保存后即时生效，无需重新部署。</div>
    <div class="msg" id="poolMsg"></div>
  </div>` : `
  <div class="card" id="dnsCard">
    <h2>DNS 自动优选</h2>
    <div class="hint" style="margin:-8px 0 4px;">定时从优选池测速后更新 <span class="tag">${esc(pageHost || '未配置')}</span> 的 A 记录（HTTP 探测过滤不可达），反代自动走优选 IP。当前频率：<b id="dnsCur">加载中…</b>。登录后可修改。</div>
  </div>`}

  <div class="card">
    <h2>已添加的站点</h2>
    <div class="hint" style="margin:-8px 0 12px;">点击链接访问代理后的页面；复制按钮可复制代理后/代理前两种链接；「编辑」可修改名称、网址、端口、访问后缀（修改后缀后旧链接将失效）。</div>
    <div id="list">${listHtml}</div>
  </div>
</div>

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
    <div class="msg" id="editMsg" style="min-height:18px;margin:0 0 6px;"></div>
    <div style="display:flex;gap:10px;">
      <button type="button" id="editSave" style="flex:1;">保存</button>
      <button type="button" id="editCancel" class="ghost" style="flex:1;">取消</button>
    </div>
  </div>
</div>` : ''}

<script>
const THEMES = ['auto', 'light', 'dark'];
const THEME_LABEL = { auto: '跟随系统', light: '亮色', dark: '暗色' };
const savedTheme = localStorage.getItem('ap_theme') || 'auto';
document.documentElement.dataset.theme = savedTheme;
const themeBtn = document.getElementById('themeBtn');
if (themeBtn) {
  themeBtn.textContent = THEME_LABEL[savedTheme];
  themeBtn.onclick = () => {
    const next = THEMES[(THEMES.indexOf(document.documentElement.dataset.theme) + 1) % 3];
    document.documentElement.dataset.theme = next;
    localStorage.setItem('ap_theme', next);
    themeBtn.textContent = THEME_LABEL[next];
  };
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

// DNS 自动优选频率：读取当前值 + 保存
(async () => {
  const r = await api('/__api/dns-config');
  if (r.ok && r.data.interval_minutes) {
    const cur = document.getElementById('dnsCur');
    if (cur) cur.textContent = r.data.interval_minutes + ' 分钟';
    const inp = document.getElementById('dnsInterval');
    if (inp) inp.value = r.data.interval_minutes;
  }
})();
const dnsBtn = document.getElementById('dnsBtn');
if (dnsBtn) {
  dnsBtn.onclick = async () => {
    const inp = document.getElementById('dnsInterval');
    const v = parseInt(inp.value, 10);
    if (!v || v < 5 || v > 1440) { setMsg('dnsMsg', '请输入 5 ~ 1440 之间的分钟数', true); return; }
    const r = await api('/__api/dns-config', { method: 'POST', body: JSON.stringify({ interval_minutes: v }) });
    setMsg('dnsMsg', r.ok ? '已保存：每 ' + v + ' 分钟自动更新一次' : (r.data.error || '保存失败'), !r.ok);
  };
}
const dnsRunBtn = document.getElementById('dnsRunBtn');
if (dnsRunBtn) {
  dnsRunBtn.onclick = async () => {
    const btn = dnsRunBtn;
    btn.disabled = true;
    btn.textContent = '正在测通并更新…';
    setMsg('dnsRunMsg', '', false);
    try {
      const r = await api('/__api/dns-run', { method: 'POST' });
      if (r.ok) {
        let msg = r.data.message || '更新完成';
        if (r.data.verified === false) msg += '（A 记录已写入但未通过访问校验）';
        setMsg('dnsRunMsg', msg, false);
      } else {
        // 拿不到 JSON 详情说明请求在平台侧就失败了（超时被杀 / 边缘错误），把状态码暴露出来便于定位
        const detail = (r.data && (r.data.error || r.data.message)) || '';
        setMsg('dnsRunMsg', detail ? detail : ('执行失败（HTTP ' + r.status + '）' + (r.status >= 500 ? '：Worker 可能已超时，请减少优选池里的无效 IP 后重试' : '')), true);
      }
    } catch (err) {
      setMsg('dnsRunMsg', '请求失败：' + (err && err.message ? err.message : err), true);
    }
    btn.disabled = false;
    btn.textContent = '立即更新优选 IP';
  };
}
// 优选池 & 健康检查配置：加载 GOOD_IPS / 上次执行时间 / 候选域名池 + 保存
const poolGood = document.getElementById('poolGood');
if (poolGood) {
  api('/__api/pool-config').then(r => {
    if (!r.ok || !r.data) return;
    if (poolGood) poolGood.textContent = r.data.good_ips && r.data.good_ips.length ? r.data.good_ips.join('  ') : '（空）';
    const last = document.getElementById('poolLast');
    if (last) last.textContent = r.data.last_run ? new Date(r.data.last_run * 1000).toLocaleString() : '从未';
    const ta = document.getElementById('poolDomains');
    if (ta) ta.value = (r.data.pref_domains || []).join('\\n');
  });
  const saveBtn = document.getElementById('poolSaveBtn');
  if (saveBtn) {
    saveBtn.onclick = async () => {
      const ta = document.getElementById('poolDomains');
      const msg = document.getElementById('poolMsg');
      if (!ta || !msg) return;
      msg.textContent = '保存中…';
      msg.className = 'msg';
      const r = await api('/__api/pool-config', { method: 'POST', body: JSON.stringify({ pref_domains: ta.value }) });
      msg.textContent = r.ok ? '已保存' : (r.data.error || '保存失败');
      msg.className = 'msg ' + (r.ok ? 'ok' : 'err');
    };
  }
}
// 优选 IP 池：读取当前 + 保存并立即更新
const prefIps = document.getElementById('prefIps');
const prefBtn = document.getElementById('prefBtn');
if (prefIps) {
  api('/__api/preferred-ips').then(r => {
    if (r.ok && r.data.ips && r.data.ips.length) prefIps.value = r.data.ips.join('\\n');
  }).catch(() => {});
}
if (prefBtn) {
  prefBtn.onclick = async () => {
    const btn = prefBtn;
    btn.disabled = true;
    setMsg('prefMsg', '', false);
    try {
      // 仅保存优选池（PREF_IPS，DNS 优选用），不触发 DNS A 记录更新、也不写 edgetunnel 的 ADD.txt——避免连带切换 edgetunnel 代理入口
      const r = await api('/__api/preferred-ips', { method: 'POST', body: JSON.stringify({ ips: prefIps.value }) });
      if (r.ok) {
        setMsg('prefMsg', '已保存 ' + r.data.count + ' 个 IP 到优选池，下个 DNS 更新周期自动应用；如需立即生效请点「立即更新优选 IP」', false);
      } else {
        setMsg('prefMsg', r.data.error || '保存失败', true);
      }
    } catch (err) {
      setMsg('prefMsg', '请求失败：' + (err && err.message ? err.message : err), true);
    }
    btn.disabled = false;
  };
}

// 确认制测速：no-cors 计时近似「你网络→节点」延迟。
// 首测 2 次取最短；resolve 快（<200ms）的 IP 可能隐藏 1034/假快（TLS 成功但 HTTP 被拒），
// 自动复测 2 次取中位数；波动大（>150ms）的降权，避免抖动假快污染排序。
async function measureIp(ip) {
  let first = Infinity;
  for (let t = 0; t < 2; t++) {
    const t0 = performance.now();
    try {
      await fetch('https://' + ip + '/__api/config', { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(3500) });
    } catch (e) {}
    const ms = performance.now() - t0;
    if (ms < first) first = ms;
  }
  if (first >= 5000) return null;
  if (first < 200) {
    const samples = [first];
    for (let t = 0; t < 2; t++) {
      const t0 = performance.now();
      try {
        await fetch('https://' + ip + '/__api/config', { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(3500) });
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

// 订阅链接配置：浏览器优选的候选来源（存在 KV，留空则回退环境变量 / 本机 /sub）
const subUrl = document.getElementById('subUrl');
const subState = document.getElementById('subState');
if (subUrl) {
  api('/__api/sub-config').then(r => {
    if (!r.ok || !r.data) return;
    if (r.data.sub_url) subUrl.value = r.data.sub_url;
    else if (subState) subState.textContent = r.data.env ? '当前使用环境变量 SUB_URL' : '未配置，将回退本机 /sub';
  }).catch(() => {});
  const subBtn = document.getElementById('subBtn');
  if (subBtn) {
    subBtn.onclick = async () => {
      subBtn.disabled = true;
      setMsg('subMsg', '保存中…', false);
      try {
        const r = await api('/__api/sub-config', { method: 'POST', body: JSON.stringify({ sub_url: subUrl.value }) });
        if (!r.ok) { setMsg('subMsg', r.data.error || '保存失败', true); }
        else setMsg('subMsg', r.data.sub_url ? '已保存订阅链接，浏览器优选将从这里拉候选' : '已清空，将回退环境变量 SUB_URL 或本机 /sub', false);
      } catch (err) {
        setMsg('subMsg', '请求失败：' + (err && err.message ? err.message : err), true);
      }
      subBtn.disabled = false;
    };
  }
}

// 浏览器自动优选：候选统一从**订阅链接**拉取（服务端已按地址归属过滤），失败才用当前池兜底
const autoBtn = document.getElementById('autoBtn');
if (autoBtn) {
  autoBtn.onclick = async () => {
    const btn = autoBtn;
    btn.disabled = true;
    setMsg('prefMsg', '', false);
    btn.textContent = '正在拉取订阅节点…';
    let cands = [];
    let note = '';
    try {
      const r = await api('/__api/preferred-candidates');
      if (r.ok && r.data) {
        cands = r.data.ips || [];
        const s = r.data.stats || {};
        note = r.data.note || (s.filtered ? '订阅共 ' + s.addresses + ' 个节点，已过滤非边缘网络 ' + s.filtered + ' 个' : '');
      } else {
        note = (r.data && r.data.error) || '订阅拉取失败';
      }
    } catch (e) { note = '订阅拉取异常'; }
    if (!cands.length) {
      try {
        const r = await api('/__api/preferred-ips');
        if (r.ok && r.data.ips && r.data.ips.length) { cands = r.data.ips; note = '订阅无候选，改用当前优选池'; }
      } catch {}
    }
    cands = [...new Set(cands.filter(ip => /^\\d{1,3}(\\.\\d{1,3}){3}$/.test(ip)))].slice(0, 40);
    if (!cands.length) {
      setMsg('prefMsg', '没有可用候选：请先在上方填写订阅链接并保存' + (note ? '（' + note + '）' : ''), true);
      btn.disabled = false;
      btn.textContent = '浏览器自动优选';
      return;
    }
    const results = [];
    let done = 0;
    const CONC = 8;
    const ping = async (ip) => {
      const t = await measureIp(ip);
      if (t !== null) results.push({ ip, t });
      done++;
      btn.textContent = '自动优选中 ' + done + '/' + cands.length + '…（已测 ' + results.length + '）';
    };
    for (let i = 0; i < cands.length; i += CONC) {
      await Promise.all(cands.slice(i, i + CONC).map(ping));
    }
    results.sort((a, b) => a.t - b.t);
    const best = results.slice(0, 15);
    if (!best.length) {
      setMsg('prefMsg', '全部节点超时（网络受限？），请稍后重试', true);
    } else {
      prefIps.value = best.map(r => r.ip).join('\\n');
      setMsg('prefMsg', '优选完成：测 ' + cands.length + ' 个，最快 ' + Math.round(best[0].t) + 'ms，前 ' + best.length + ' 个已填入' + (note ? '｜' + note : '') + '，点「保存优选池」写入优选池（不自动改 DNS，可再点「立即更新优选 IP」应用）', false);
    }
    btn.disabled = false;
    btn.textContent = '浏览器自动优选';
  };
}

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
        <span class="site-name">\${escapeHtml(s.name)} <span class="tag">\${escapeHtml(s.id)}</span></span>
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
  document.getElementById('editMsg').textContent = '';
  m.style.display = 'flex';
  const f = document.getElementById('editSlug');
  f.value = site.id;
}
function closeEditModal() { document.getElementById('editModal').style.display = 'none'; }

const editModal = document.getElementById('editModal');
if (editModal) {
  editModal.addEventListener('click', (e) => { if (e.target === editModal) closeEditModal(); });
  document.getElementById('editSave').addEventListener('click', async (e) => {
    e.preventDefault();
    const oldId = document.getElementById('editId').value;
    const name = document.getElementById('editName').value.trim();
    const target = document.getElementById('editTarget').value.trim();
    const port = document.getElementById('editPort').value.trim();
    const slug = document.getElementById('editSlug').value.trim();
    if (!name || !target) { document.getElementById('editMsg').textContent = '请填写名称和网址'; document.getElementById('editMsg').style.color = 'var(--err)'; return; }
    const body = { name, target, port, slug };
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
  if (!name || !target) { setMsg('addMsg', '请填写中文名称和网址', true); return; }
  setMsg('addMsg', '正在添加…');
  addBtn.disabled = true;
  try {
    const r = await api('/__api/sites', { method: 'POST', body: JSON.stringify({ name, slug, target, port }) });
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
} catch (e) { console.error('admin init:', e); }
` : ''}

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
