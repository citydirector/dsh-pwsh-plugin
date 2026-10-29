# 更新机制核对（2026-10-29）

当前 main 与 npm 0.2.14 仍保留插件自身的 npm 更新器，尚未完全交由 DSH 原生更新管理。

- [plugin/index.mjs](../plugin/index.mjs) 默认将 autoUpdate 设为 true，创建 UpdateChecker，并在 apply 路径调用 startAutoUpdate；同时注册 pwsh_run_update。
- [plugin/auto-update.mjs](../plugin/auto-update.mjs) 实现定时检查、空闲安装与失败退避。
- [plugin/update-check.mjs](../plugin/update-check.mjs) 查询 npm；[plugin/update-apply.mjs](../plugin/update-apply.mjs) 将安装交给 DSH。
- 关闭 autoUpdate 和 updateCheck 可停用这些更新行为，但不会移除工具注册或源码文件。

本轮仅更新文档，未更改这些运行路径。
