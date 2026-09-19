#!/usr/bin/env python3
"""部署前准备：把 wrangler.toml 渲染成可部署的形态，并按 STORAGE_BACKEND 裁剪绑定。

## 为什么要有这一步

wrangler.toml 在版本库里。它一旦写死某个账号下的 D1 / KV 资源 ID，fork 的人不改就
部署失败 —— 而「知道要去改哪里」这件事本身得先读一遍源码。仓库里因此留着一套占位符，
由本脚本在部署前渲染成真实值：

  1. 仓库 Variables 配了 → 用你配的（想复用已有资源时用）
  2. 没配 → 调 Cloudflare 接口**自动创建**（D1 数据库 / KV 命名空间 / R2 桶），拿了 ID 回填
  3. 有两处失败是**允许**的，因为它们各自都有降级路径，不该卡住部署：
       - R2 建不出来（账号没开通）→ 删掉 [[r2_buckets]]，Worker 退回纯 Cache API
       - d1 迁移跑不动（配额打满）→ 跳过建表，Worker 起来后自动降级到内存模式，
         靠部署时注入的种子提供服务（见第 4 段的说明）
     「允许失败」不等于「悄悄失败」：两处都会打 error annotation 并写进 job summary。
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
        data = json.load(resp)
    # CF 的 v4 接口失败时也可能回 200，只看 result 会把「权限不够」读成「一个资源都没有」，
    # 然后脚本兴冲冲去新建一个 —— 所以 success 必须当场查。
    if data.get('success') is False:
        raise RuntimeError('接口返回失败：%s' % (data.get('errors') or '未知错误'))
    return data


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
        # R2 的列表接口与 D1 / KV 不是同一种结构：它返回 {"result":{"buckets":[...]}}，
        # 而那两个返回 {"result":[...]}。照搬 cfList 会拿到一个 dict，遍历它得到的是
        # 键名字符串 —— 于是「桶明明在」也被判成不存在，脚本转头去新建并撞上重名错误。
        result = cfApi('r2/buckets').get('result') or {}
        buckets = result.get('buckets') if isinstance(result, dict) else result
        for bucket in (buckets or []):
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


def summarize(lines):
    """写进 Actions 的运行摘要。日志看不看随缘，摘要是这次部署躲不掉的一页。"""
    path = os.environ.get('GITHUB_STEP_SUMMARY')
    if not path:
        return
    with open(path, 'a', encoding='utf-8') as fh:
        fh.write('\n'.join(lines).rstrip() + '\n\n')


def apply_migrations():
    """跑 wrangler d1 migrations apply。

    失败了**不阻断部署** —— 这个决定是踩出来的，别改回 check=True：

    D1 配额打满时，wrangler 连迁移都跑不通，于是整个 workflow 在建表这步就红掉，
    而部署这一步被硬生生卡住的结果是「Worker 没更新，d1 绑定也没上去」，面板上
    还什么都看不出来。可 Worker 自己本来就有退路：读不到存储就降级到内存模式，
    拿部署时注入的种子照常服务（这也是 wrangler.toml 里那段种子的用途）。
    让一次配额超限升级成「发不了版」，不划算。

    代价是必须把它喊够响：error annotation 让运行详情页标红，摘要里写清后果和
    该做什么。静默跳过的下场是 —— 哪天真换了空库，部署一路绿，上去才发现没表。
    """
    proc = subprocess.run(
        ['npx', 'wrangler', 'd1', 'migrations', 'apply', D1_NAME, '--remote'],
        check=False,
        capture_output=True,
        text=True,
    )
    if proc.returncode == 0:
        log('d1 模式：迁移已应用')
        return
    detail = (proc.stderr or '') + (proc.stdout or '')
    tail = [l for l in detail.strip().splitlines() if l.strip()][-6:] or ['(wrangler 没有给出输出)']
    log('d1 迁移失败（exit %d），部署继续 —— 常见原因是 D1 读写配额打满' % proc.returncode)
    for line in tail:
        print('::error::[d1 migrations] ' + line)
    summarize([
        '> ⚠️ **d1 迁移没跑成，本次部署没有建表**（exit %d）' % proc.returncode,
        '',
        'Worker 仍然带着 **d1 绑定** 部署上去了。读不到存储时它会自动降级到内存模式，',
        '用部署时注入的种子提供服务 —— 所以站点与订阅照常可用，只是不落盘。',
        '',
        '最常见的原因是 D1 读写配额超限（连迁移本身也要额度）。配额恢复后的收尾：',
        '',
        '1. 面板「**检测存储**」确认存储可用；',
        '2. 点「**写回存储**」把内存里的数据搬回去；',
        '3. 点「**切回存储模式**」。',
        '',
        '如果这是全新的数据库（表里还没有数据），则必须让迁移跑一次：',
        '等配额恢复后重跑本 workflow（不加任何开关）即可。',
        '',
        'wrangler 输出的最后几行：',
        '```',
    ] + ['    ' + l for l in tail] + ['```'])


def render(text, values):
    for key, value in values.items():
        text = text.replace('__%s__' % key, value)
    # 只查「真正生效的配置值」：注释里也会写 __XXX__ 这种泛指的说明文字，
    # 拿它当判据会让每次部署都失败在一个根本不存在的占位符上。
    # 查只查到这一步为止 —— 后面追加的种子是**数据**不是配置：
    # 站点配置里出现 __XXX__ 这种字面量是完全正常的，不该让整个部署失败。
    effective = re.sub(r'#[^\n]*', '', text)
    leftover = sorted(set(PLACEHOLDER_RE.findall(effective)))
    if leftover:
        sys.exit('[prepare-deploy] 还有没人管的占位符：%s（本脚本只认：%s）'
                 % ('、'.join(leftover), '、'.join(MANAGED_PLACEHOLDERS)))
    return text


# ===================== 内存模式的种子 =====================
#
# D1 / KV 配额打满之后，站点凭什么还能起来：把数据导出成种子、塞进环境变量，
# Worker 启动时直接灌进内存。它绕得开配额，是因为**环境变量不占 D1 / KV 的读写额度**。
#
# 平台有个绕不过去的限制：**单个环境变量上限 5 KB**，所以 `tools/export-seed.mjs`
# 会把种子切成 SEED_JSON / SEED_JSON_01 / SEED_JSON_02 …… 若干段，这里按顺序收进来。
# 最容易犯的错是「一段一段粘贴时漏了其中一段」——那种情况下站点照样起得来、照样返回 200，
# 但读到的内容是残缺的，比起不来更难查。所以编号必须连续，中间断掉就直接报错退出。

SEED_MAX_PARTS = 24


def collectSeedVars(sourceEnv=None):
    """
    收集种子分段。

    有两个来源：**优先**读「仓库变量整份」——CI 把 `toJSON(vars)` 落到一个临时文件里，
    路径放在 REPO_VARS_FILE，这里按名字挑出 SEED_JSON* 那几段；没有这份清单时回落到
    逐个环境变量（本地手动部署属于这一类）。走文件而不走命令行参数，是因为里面有
    站点配置，不该出现在进程列表或日志里。
    """
    env = {}
    path = (sourceEnv or os.environ).get('REPO_VARS_FILE')
    if path and os.path.exists(path):
        try:
            with open(path, encoding='utf-8') as fh:
                loaded = json.load(fh)
            if isinstance(loaded, dict):
                env = {str(k): str(v) for k, v in loaded.items() if isinstance(v, (str, int, float))}
                log('从 %s 读到 %d 个仓库变量' % (path, len(env)))
        except Exception as exc:  # noqa: BLE001 —— 读不出来就当没有，回到环境变量
            log('仓库变量清单读不出来（%s），回落到环境变量' % exc)
    for name, value in (sourceEnv or os.environ).items():
        if name.startswith('SEED_JSON'):
            env[name] = str(value)

    names = ['SEED_JSON'] + ['SEED_JSON_%02d' % i for i in range(1, SEED_MAX_PARTS + 1)]
    found = {}
    for name in names:
        value = str(env.get(name) or '').strip()
        if value:
            found[name] = value
    if not found:
        return []
    used = sorted(int(n[len('SEED_JSON_'):]) for n in found if n != 'SEED_JSON')
    if used:
        missing = [i for i in range(1, max(used) + 1) if i not in used]
        if missing:
            sys.exit('[prepare-deploy] 种子的分段编号不连续，缺 %s。'
                     '请用 node tools/export-seed.mjs --chunk 4096 重新导出，'
                     '再按它的提示把每一段填到对应的变量里。'
                     % '、'.join('SEED_JSON_%02d' % i for i in missing))
    order = ['SEED_JSON'] + ['SEED_JSON_%02d' % i for i in used]
    return [(n, found[n]) for n in order if n in found]


def appendSeedVars(text, pairs):
    if not pairs:
        return text
    lines = ['', '# 内存模式的种子（由仓库 Variables 注入；导出工具 node tools/export-seed.mjs）']
    for name, value in pairs:
        # 变量名这里可以裸写：[vars] 里只会出现 SEED_JSON / SEED_JSON_01 这种受控的名字，
        # 种子内容整体躺在**值**里面，不参与 TOML 结构（一度以为键名里的冒号和点会惹事，
        # 跑真数据验过才知道担心错了，别再往这里加防御）。
        # 值必须用 json.dumps：非 ASCII 会转成 \uXXXX，引号与反斜杠也一并转义好。
        lines.append('%s = %s' % (name, json.dumps(value)))
    block = '\n'.join(lines) + '\n'
    marker = '\n[vars]\n'
    if marker in text:
        # 必须插进已有的 [vars] 表里面：TOML 不允许同名表出现两次
        return text.replace(marker, marker + block, 1)
    return text.rstrip() + '\n\n[vars]\n' + block


def main():
    local = '--local' in sys.argv[1:]
    backend = os.environ.get('STORAGE_BACKEND', 'd1').strip().lower()
    path = 'wrangler.toml'
    with open(path, encoding='utf-8') as fh:
        text = fh.read()

    # ---- 1. 裁剪：只留实际使用的后端 ----
    #
    # memory 是 D1 / KV 配额打满（或资源暂时建不出来）时的退路：两个绑定一起摘掉，
    # Worker 起来后全部读写落在进程内内存里。这一路的收益是**连 D1 迁移都不跑了** ——
    # 配额见底时 migrations apply 自己也会失败，本来学生证都办不下来，更别说部署。
    if backend == 'kv':
        text = cutSection(text, '[[d1_databases]]')
        log('kv 模式：已移除 D1 绑定，保留 KV')
    elif backend == 'memory':
        text = cutSection(text, '[[d1_databases]]')
        text = cutSection(text, '[[kv_namespaces]]')
        log('memory 模式：D1 与 KV 绑定都已移除，全部读写走进程内内存')
    else:
        text = cutSection(text, '[[kv_namespaces]]')
        log('d1 模式：已移除 KV 绑定，保留 D1')

    # ---- 2. 取值 ----
    values = {'WORKER_NAME': envOr('WORKER_NAME', DEFAULT_WORKER)}
    values['GH_ACTIONS_URL'] = resolveActionsUrl()
    if local or backend == 'memory':
        # 这两个占位符在 memory 模式下已经随整段被删掉了，填什么都不会出现在产物里；
        # 但 render() 要求每个占位符都有人管，所以给一个明确的中性值，不留空串。
        values['D1_DATABASE_ID'] = LOCAL_ID
        values['KV_NAMESPACE_ID'] = LOCAL_ID
        values['R2_BUCKET_NAME'] = R2_NAME
    else:
        # 拿不到 ID 就直接说清楚是哪个变量、去哪里填 —— wrangler 那边只会报
        # 「找不到资源」，而真正的原因是这里没拿到，两者差着十万八千里。
        key = 'KV_NAMESPACE_ID' if backend == 'kv' else 'D1_DATABASE_ID'
        resolver = resolveKv if backend == 'kv' else resolveD1
        try:
            got = resolver()
        except Exception as exc:  # noqa: BLE001 —— 这一段就是要把它翻译成人话
            sys.exit('[prepare-deploy] 拿不到 %s：%s\n'
                     '  两个办法：① 在仓库 Settings → Secrets and variables → Actions 的 Variables 里'
                     '直接填 %s；② 确认 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID 有效且有建库权限。'
                     % (key, exc, key))
        if not got:
            sys.exit('[prepare-deploy] %s 解析结果为空，无法渲染 %s（同上，两个办法二选一）' % (key, key))
        values[key] = got
        r2 = resolveR2()
        if r2:
            values['R2_BUCKET_NAME'] = r2
        else:
            text = cutSection(text, '[[r2_buckets]]')

    # ---- 3. 渲染并**立刻落盘** ----
    #
    # 这一步的先后不能换：迁移是另一个进程（wrangler）去读 wrangler.toml，
    # 它读的是磁盘上的文件，不是这里的变量。曾经把迁移排在写盘之前，于是 wrangler
    # 拿到的是还没渲染的占位符，报「Expected "name" to be of type string … but got
    # "__WORKER_NAME__"」—— 而脚本自己的日志一片绿，看着像 wrangler 坏了。
    text = render(text, values)
    # 种子是数据不是配置，所以排在占位符检查之后 —— 站点配置里出现 __XXX__ 不该让部署失败
    seed = collectSeedVars()
    text = appendSeedVars(text, seed)
    with open(path, 'w', encoding='utf-8') as fh:
        fh.write(text)
    log('已渲染 %s（Worker 名 %s）' % (path, values['WORKER_NAME']))
    if seed:
        log('内存模式种子：%d 段，共 %d 字节' % (len(seed), sum(len(v) for _, v in seed)))

    # ---- 4. d1 模式：建表 ----
    if backend == 'd1' and not local:
        if os.environ.get('ANYPROXY_SKIP_MIGRATIONS'):
            # 只能由「手动触发 ＋ 勾选 skip_migrations」走到这里（开关怎么用写在
            # deploy-cloudflare.yml 的 inputs 说明里）。跳过必须在日志里喊一声：
            # 静默跳过的下场是 —— 哪天真的换了新库，部署一片绿，上去才发现没表。
            log('警告：已跳过 d1 迁移（ANYPROXY_SKIP_MIGRATIONS）。')
            summarize([
                '> ⚠️ **本次部署跳过了 d1 迁移**（手动勾选 skip_migrations）',
                '',
                '表必须已经存在。换了新的空库请去掉这个开关重跑一次。',
            ])
        else:
            apply_migrations()


if __name__ == '__main__':
    main()
