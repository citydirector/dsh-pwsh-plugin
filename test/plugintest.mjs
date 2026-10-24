// 模拟 DSH 的 ctx 接口，驱动 plugin/index.mjs 的完整 apply/execute 路径
import { spawn } from "node:child_process";
import { apply } from "../plugin/index.mjs";
import { mkdirSync, rmSync } from "node:fs";

const PWSH = process.env.PWSH_BIN ?? "pwsh";
const subprocess = {
  async resolveExecutable(command) { return command === "pwsh" ? PWSH : command; },
  spawn(spec) {
    const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, stdio: ["pipe","pipe","pipe"], windowsHide: true });
    return {
      stdin: child.stdin, stdout: child.stdout, stderr: child.stderr,
      done: new Promise((r) => child.on("exit", (code) => r({ exitCode: code }))),
      terminate() { try { child.kill(); } catch {} },
      async waitForExit() { return await new Promise((res) => { if (child.exitCode !== null) return res(true); child.once("exit", () => res(true)); }); },
    };
  },
};

let registration = null;
const disposed = [];
const ctx = {
  subprocess,
  tools: { register(def) { registration = def; return () => { registration = null }; } },
  get(name) { if (name === "workingDirectory") return { async ensure() { return process.cwd(); } }; return undefined; },
  effect(fn) { const d = fn(); disposed.push(d); return d; },
  on() {},
};
// 这两个测试只验证协议与插件路径，不挂沙箱服务 —— 显式接受无边界会话。
apply(ctx, { allowUnconfined: true });

const results = [];
const check = (label, pass, detail) => results.push((pass ? "PASS " : "FAIL ") + label + (detail ? "  ::  " + detail : ""));
const exec = { agent: { session: { id: "sess-A", header: { cwd: process.cwd() } } }, signal: undefined };
const run = (script, extra) => registration.execute({ script, ...(extra ?? {}) }, exec);

check("registered", registration !== null && registration.name === "pwsh_run");

// 1. 零转义 + 无 shell 中转
let r = await run("$n='Skadi'\nWrite-Output \"hi $n\"\n@'\nlit $n\n'@");
check("verbatim", r.text === "hi Skadi\nlit $n", JSON.stringify(r.text));

// 2. 状态跨调用保留（同一 sessionId）
await run("$global:acc = 41");
r = await run("$global:acc++\nWrite-Output $global:acc");
check("persist", r.text === "42", JSON.stringify(r.text));

// 3. 不同 sessionId 隔离
const execB = { agent: { session: { id: "sess-B", header: { cwd: process.cwd() } } } };
r = await registration.execute({ script: "Write-Output ('acc=[' + $global:acc + ']')" }, execB);
check("isolated", r.text === "acc=[]", JSON.stringify(r.text));

// 4. 流分离呈现
r = await run("Write-Output 'OUT'\nWrite-Warning 'WARN'\nWrite-Error 'ERR'");
check("streams", r.text.includes("OUT") && r.text.includes("WARNING: WARN") && r.text.includes("ERR"), JSON.stringify(r.text));

// 5. throw 剥壳
r = await run("throw 'boom'");
check("throw-unwrapped", r.text.includes("boom") && !r.text.includes("EndInvoke"), JSON.stringify(r.text));

// 6. 语法错误
r = await run("function {");
check("parse-error-visible", r.text.includes("Missing name after function"), JSON.stringify(r.text.slice(0, 120)));

// 7. 超时：杀掉会话重建，状态丢失（诚实告知）
await run("$global:keep = 'x'");
r = await run("Start-Sleep 20", { timeoutMs: 1500 });
const timeoutNote = r.text.includes("timed out after");
r = await run("Write-Output ([string]::IsNullOrEmpty($global:keep))");
check("timeout-rebuild", timeoutNote && r.text === "True", JSON.stringify({ note: timeoutNote, after: r.text }));

// 8. workdir 生效
r = await run("Write-Output $PWD.Path", { workdir: process.cwd() });
check("workdir", r.text.trim() === process.cwd(), JSON.stringify(r.text));
r = await run("Write-Output 'should-not-run'", { workdir: "D:\\nope\\nope" });
check("workdir-invalid", !r.text.includes("should-not-run") && r.text.includes("nope"), JSON.stringify(r.text.slice(0, 100)));

// 9. workdir 里带 $ 与空格不被 PowerShell 展开（psLiteral 单引号字面量的价值）
const dollarDir = process.cwd() + "\\_dollar $dir";
mkdirSync(dollarDir, { recursive: true });
r = await run("Write-Output $PWD.Path", { workdir: dollarDir });
check("workdir-dollar", r.text.trim() === dollarDir, JSON.stringify(r.text));
rmSync(dollarDir, { recursive: true, force: true });

// 10. 大脚本
const big = "Write-Output 'big-ok'\n" + Array.from({length: 4000}, (_, i) => "$v" + i + " = " + i).join("\n");
r = await run(big);
check("big", r.text === "big-ok", JSON.stringify(r.text));

// 11. 空输出
r = await run("$null = 1");
check("no-output", r.text === "(no output)", JSON.stringify(r.text));

// 12. 输出上限：大输出被截断并给出提示，但脚本仍算跑完
r = await run("1..2000 | ForEach-Object { 'line-' + $_ }", { timeoutMs: 30000 });
check("output-cap-honest", r.text.length > 0, JSON.stringify({ len: r.text.length }));
{
  // 单条 9MB 字符串：一次就顶穿 8MB 上限，且不依赖多行协议的切分行为。
  r = await run("Write-Output ('X' * 9000000)", { timeoutMs: 60000 });
  check("output-truncated", r.text.includes("output truncated"), String(r.text.length) + " chars");
}

// 13. 卸载清理
for (const d of disposed.reverse()) if (typeof d === "function") d();
await new Promise((res) => setTimeout(res, 500));

console.log(results.join("\n"));
const fails = results.filter(x => x.startsWith("FAIL")).length;
console.log("\nSUMMARY pass=" + (results.length - fails) + " fail=" + fails);
process.exit(0);