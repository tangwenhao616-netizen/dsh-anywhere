# dsh-fs-ssh-poc

POC:把 dsh 的 `ctx.fs`(FileSystem 能力 seam)换成一个 **SSH 后端**——agent 的
`read/write/edit/ls` 工具透明地作用在**一台远程机器**的文件上。这是"dsh 工作区落在
一台 fleet 机器上(SSH 执行世界)"的地基。

- `lib/ssh-fs-core.js` —— 无 cordis 依赖的核心:用系统 `ssh` CLI 实现 FileSystem 契约
  (resolve/stat/lstat/readText/streamText/readBytes/listDir/writeText/editText)。
  路径与写入内容全部 base64 进远程脚本,零引号/注入风险,零 npm 依赖。
- `lib/index.js` —— `SshFileSystem extends @deepseek-ai/dsh-fs` 的 Service 包装(注册 ctx.fs)。
- `cordis.patch.yml` —— 在一个独立 POC profile 里禁 fs-sandbox、挂 fs-ssh。
- `test/probe-relay.mjs` —— Level-1 活探针,对着一台真实远程机跑通全部方法。

## 进度

- **Level-1(远程读写)✅ 已证**:`node test/probe-relay.mjs` 对着远程机跑通
  resolve/write/stat/read/listDir/editText + 版本守卫(FS_STALE_VERSION),读改真在远程生效。
- **Level-2(dsh 集成)待做**:挂进 POC profile 替换 fs-sandbox,启 dsh 让 agent 的
  read/write 工具在远程文件上生效。
- 之后:shell-ssh(bash 也远程)、每会话选执行世界、远程目录选择器 → 产品化。
