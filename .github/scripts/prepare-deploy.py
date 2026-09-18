#!/usr/bin/env python3
"""部署前准备：把 wrangler.toml 渲染成可部署的形态，并按 STORAGE_BACKEND 裁剪绑定。

## 为什么要有这一步

wrangler.toml 在版本库里。它一旦写死某个账号下的 D1 / KV 资源 ID，fork 的人不改就
部署失败 —— 而「知道要去改哪里」这件事本身得先读一遍源码。仓库里因此留着一套占位符，
由本脚本在部署前渲染成真实值：

  1. 仓库 Variables 配了 → 用你配的（想复用已有资源时用）
  2. 没配 → 调 Cloudflare 接口**自动创建**（D1 数据库 / KV 命名空间 / R2 桶），拿了 ID 回填
  3. R2 是唯一允许失败的资源：建不出来（账号没开通）就删掉整个 [[r2_buckets]]，
     Worker 本来就有「未绑定则降级为纯 Cache API」的路径，不该因为它卡住部署
  4. 健康检查链接按 GITHUB_REPOSITORY 拼成你自己仓库的地址

结果：fork 完不用改任何文件，也不用去控制台抄 ID。

## 顺序有讲究

先裁剪、再渲染。用不到的后端整段删掉之后，它的占位符一起消失 —— 于是 kv 模式根本
不需要 D1 的 ID，反过来也一样。「缺哪个资源就报错」的判定因此只对真正用到的后端生效。

用法：
  python3 .github/scripts/prepare-deploy.py           # CI：按环境变量渲染，缺的自动创建
  python3 .github/scripts/prepare-deploy.py --local    # 本地：占位 ID，不碰云端资源、不跑迁移
"""
import json
import os
import re
import subprocess
import sys
import urllib.request

D1_NAME = 'any-proxy-db'
KV_TITLE = 'SITES'
R2_NAME = 'anyproxy-media'
DEFAULT_WORKER = 'any-proxy'
HEALTHCHECK_FILE = 'healthcheck.yml'
# 本地模式的占位 ID：wrangler dev 用本地模拟的存储，不看这个值；
# 但 wrangler 仍要求字段非空，所以给一个形态合法的 UUID。
LOCAL_ID = '00000000-0000-0000-0000-000000000000'

# 本脚本认领的占位符。wrangler.toml 里出现这张表之外的 __XXX__ 会被当成错误拦下 ——
# 否则某个占位符没人管，就会原样交给 wrangler，表现为「部署失败但看不出为什么」。
MANAGED_PLACEHOLDERS = [
    'WORKER_NAME',
    'D1_DATABASE_ID',
    'KV_NAMESPACE_ID',
    'R2_BUCKET_NAME',
    'GH_ACTIONS_URL',
]

PLACEHOLDER_RE = re.compile(r'__[A-Z0-9_]+__')


def log(msg):
    print('[prepare-deploy] ' + msg)


def envOr(name, fallback=''):
    return os.environ.get(name, '').strip() or fallback


# ===================== Cloudflare 接口 =====================

def cfApi(path, method='GET', payload=None):
    token = os.environ.get('CLOUDFLARE_API_TOKEN', '').strip()
    account = os.environ.get('CLOUDFLARE_ACCOUNT_ID', '').strip()
    if not token or not account:
        raise RuntimeError('缺少 CLOUDFLARE_API_TOKEN 或 CLOUDFLARE_ACCOUNT_ID')
    url = 'https://api.cloudflare.com/client/v4/accounts/%s/%s' % (account, path)
    body = json.dumps(payload).encode('utf-8') if payload is not None else None
    req = urllib.request.Request(url, data=body, method=method, headers={
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def cfList(path):
    return cfApi(path).get('result') or []


def resolveD1():
    """D1 数据库：配了就用，没配就查同名的，还没有就建一个"""
    given = envOr('D1_DATABASE_ID')
    if given:
        return given
    for db in cfList('d1/database'):
        if db.get('name') == D1_NAME:
            return db.get('uuid') or ''
    created = cfApi('d1/database', 'POST', {'name': D1_NAME}).get('result') or {}
    log('已创建 D1 数据库 %s' % D1_NAME)
    return created.get('uuid') or ''


def resolveKv():
    """KV 命名空间：同上，绑定名固定是 SITES（代码里就找这个名字）"""
    given = envOr('KV_NAMESPACE_ID')
    if given:
        return given
    for ns in cfList('storage/kv/namespaces'):
        if ns.get('title') == KV_TITLE:
            return ns.get('id') or ''
    created = cfApi('storage/kv/namespaces', 'POST', {'title': KV_TITLE}).get('result') or {}
    log('已创建 KV 命名空间 %s' % KV_TITLE)
    return created.get('id') or ''


def resolveR2():
    """R2 桶：唯一允许失败的资源。建不出来返回空，调用方据此删掉绑定"""
    given = envOr('R2_BUCKET_NAME')
    if given:
        return given
    try:
        for bucket in cfList('r2/buckets'):
            if bucket.get('name') == R2_NAME:
                return R2_NAME
        cfApi('r2/buckets', 'POST', {'name': R2_NAME})
        log('已创建 R2 桶 %s' % R2_NAME)
        return R2_NAME
    except Exception as exc:  # noqa: BLE001 —— 失败要响，但这里是「降级」而不是「中断」
        log('R2 桶不可用（%s）：移除 R2 绑定，媒体分片缓存降级为纯 Cache API' % exc)
        return ''


def resolveActionsUrl():
    """健康检查链接：配了就用，没配按当前仓库地址拼（GitHub Actions 自带 GITHUB_REPOSITORY）"""
    given = envOr('GH_ACTIONS_URL')
    if given:
        return given
    repo = os.environ.get('GITHUB_REPOSITORY', '').strip()
    if not repo:
        return ''
    return 'https://github.com/%s/actions/workflows/%s' % (repo, HEALTHCHECK_FILE)


# ===================== 裁剪与渲染 =====================

def cutSection(text, header):
    return re.sub(re.escape(header) + r'.*?(?=\n\[\[|\n\[|\Z)', '', text, flags=re.S)


def render(text, values):
    for key, value in values.items():
        text = text.replace('__%s__' % key, value)
    # 只查「真正生效的配置值」：注释里也会写 __XXX__ 这种泛指的说明文字，
    # 拿它当判据会让每次部署都失败在一个根本不存在的占位符上。
    effective = re.sub(r'#[^\n]*', '', text)
    leftover = sorted(set(PLACEHOLDER_RE.findall(effective)))
    if leftover:
        sys.exit('[prepare-deploy] 还有没人管的占位符：%s（本脚本只认：%s）'
                 % ('、'.join(leftover), '、'.join(MANAGED_PLACEHOLDERS)))
    return text


def main():
    local = '--local' in sys.argv[1:]
    backend = os.environ.get('STORAGE_BACKEND', 'd1').strip().lower()
    path = 'wrangler.toml'
    with open(path, encoding='utf-8') as fh:
        text = fh.read()

    # ---- 1. 裁剪：只留实际使用的后端 ----
    if backend == 'kv':
        text = cutSection(text, '[[d1_databases]]')
        log('kv 模式：已移除 D1 绑定，保留 KV')
    else:
        text = cutSection(text, '[[kv_namespaces]]')
        log('d1 模式：已移除 KV 绑定，保留 D1')

    # ---- 2. 取值 ----
    values = {'WORKER_NAME': envOr('WORKER_NAME', DEFAULT_WORKER)}
    values['GH_ACTIONS_URL'] = resolveActionsUrl()
    if local:
        values['D1_DATABASE_ID'] = LOCAL_ID
        values['KV_NAMESPACE_ID'] = LOCAL_ID
        values['R2_BUCKET_NAME'] = R2_NAME
    else:
        if backend == 'kv':
            values['KV_NAMESPACE_ID'] = resolveKv()
        else:
            values['D1_DATABASE_ID'] = resolveD1()
        r2 = resolveR2()
        if r2:
            values['R2_BUCKET_NAME'] = r2
        else:
            text = cutSection(text, '[[r2_buckets]]')

    # ---- 3. 渲染 ----
    text = render(text, values)

    # ---- 4. d1 模式：建表。放在渲染之后，wrangler 此刻读到的是最终配置 ----
    if backend == 'd1' and not local and not os.environ.get('ANYPROXY_SKIP_MIGRATIONS'):
        subprocess.run(
            ['npx', 'wrangler', 'd1', 'migrations', 'apply', D1_NAME, '--remote'],
            check=True,
        )
        log('d1 模式：迁移已应用')

    with open(path, 'w', encoding='utf-8') as fh:
        fh.write(text)
    log('已渲染 %s（Worker 名 %s）' % (path, values['WORKER_NAME']))


if __name__ == '__main__':
    main()
