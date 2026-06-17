# Git 仓库管理记录

## ragenteval 的管理方式

`ragenteval/` 现在作为主仓库的 subtree 管理，而不是独立嵌套 Git 仓库或 submodule。

采用 subtree 的原因：

- 主仓库可以直接跟踪 `ragenteval/` 下的源码、数据集、示例和文档。
- 克隆主仓库后不需要额外执行 `git submodule update --init`。
- 后续仍然可以从 `git@gitcode.net:nageoffer/ragenteval.git` 拉取上游更新。
- 避免 `ragenteval/` 目录内部残留 `.git` 时，父仓库只记录一个 gitlink，导致内容没有真正进入主仓库。

当前集成记录：

```bash
git subtree add --prefix=ragenteval git@gitcode.net:nageoffer/ragenteval.git main --squash
```

对应的主仓库提交：

```text
6a45598 Merge commit '73a13b4fb76c84ed2dbd5c3aab9aadeae8cbc5dd' as 'ragenteval'
73a13b4 Squashed 'ragenteval/' content from commit 8eb4d2c
```

## 日常修改

平时修改 `ragenteval/` 下的文件时，按主仓库普通目录处理：

```bash
git add ragenteval/eval/xxx.py
git commit -m "feat(eval): update evaluation logic"
git push origin main
```

不要在 `ragenteval/` 目录里初始化新的 Git 仓库，也不要把 `ragenteval/.git` 提交进来。如果发现 `ragenteval/.git` 又出现了，先确认 `git status --short ragenteval` 能看到普通文件状态，再删除这个内部 `.git` 目录。

## 拉取 ragenteval 上游更新

从 `gitcode.net` 上游同步时使用：

```bash
git subtree pull --prefix=ragenteval git@gitcode.net:nageoffer/ragenteval.git main --squash
```

也可以设置别名：

```bash
git config alias.eval-pull "subtree pull --prefix=ragenteval git@gitcode.net:nageoffer/ragenteval.git main --squash"
git eval-pull
```

## 本地文件约定

`ragenteval/.env` 是本地运行配置，已被 `ragenteval/.gitignore` 忽略，不应该提交。

`ragenteval/.venv/` 是本地 Python 虚拟环境，也不应该提交。需要重建时执行：

```powershell
cd .\ragenteval
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install requests "python-dotenv[cli]" boto3
```

