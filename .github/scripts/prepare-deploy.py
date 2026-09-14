#!/usr/bin/env python3
"""部署前准备：按 STORAGE_BACKEND 裁剪 wrangler.toml，只绑定实际使用的后端。

- kv：移除 [[d1_databases]] 段
- d1（默认）：先应用 D1 迁移建表，再移除 [[kv_namespaces]] 段

wrangler-action 的 preCommands 逐行执行，故控制逻辑收敛到本脚本（单行调用）。
"""
import os
import re
import subprocess
import sys

backend = os.environ.get('STORAGE_BACKEND', 'd1').strip().lower()
path = 'wrangler.toml'
with open(path, encoding='utf-8') as fh:
    text = fh.read()

if backend == 'kv':
    text = re.sub(r'\[\[d1_databases\]\].*?(?=\n\[\[|\n\[|\Z)', '', text, flags=re.S)
    print('[prepare-deploy] kv 模式：已移除 D1 绑定，保留 KV')
else:
    subprocess.run(
        ['npx', 'wrangler', 'd1', 'migrations', 'apply', 'any-proxy-db', '--remote'],
        check=True,
    )
    text = re.sub(r'\[\[kv_namespaces\]\].*?(?=\n\[\[|\n\[|\Z)', '', text, flags=re.S)
    print('[prepare-deploy] d1 模式：迁移已应用，已移除 KV 绑定，保留 D1')

with open(path, 'w', encoding='utf-8') as fh:
    fh.write(text)
sys.exit(0)
