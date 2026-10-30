# 更新机制核对（2026-10-29）

本插件不再带自己的更新器：版本完全交给 DSH 原生更新管理。

- [plugin/index.mjs](../plugin/index.mjs) 不注册 `pwsh_run_update`，也没有 `autoUpdate` / `updateCheck` 配置项。
  工具面只有 `pwsh_run` 一个。
- `plugin/auto-update.mjs`、`plugin/update-check.mjs`、`plugin/update-apply.mjs` 已删除，
  对应的 `test/autoupdatetest.mjs`、`test/updatetest.mjs`、`test/wiringtest.mjs` 一并删除。
- 版本来源是 npm；profile 记录裸 registry 规格（`"dsh-pwsh-plugin": "X.Y.Z"`），
  DSH 的 `listVersions` / `updateBundle` 因此可用 —— 与其余插件同一条路径。
- DSH 拒绝更新非 registry 来源的 bundle（`github:`、`file:`、git 范围、非本 profile 的第三方依赖、
  没有 semver 版本号），所以用这几种方式装的实例不会自动更新。
- pnpm 的 `minimumReleaseAge` 默认 1440 分钟：当天发布的版本当天装不上，页面会说明实际装的是哪个版本。
- 更新仍然会换掉常驻会话，且没有人检查当前是否有调用在跑。详见
  [运行边界](runtime-notes.zh-CN.md) 与 [英文版](runtime-notes.md)。

详见 [FINDINGS.md](../FINDINGS.md) 第三十四节。
