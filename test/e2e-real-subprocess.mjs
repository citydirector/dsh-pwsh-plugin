
// 端到端：用 DSH 真实的 LocalSubprocessRuntime（Windows Job Object 托管）驱动插件
import { spawn } from "node:child_process";
import { importFromDsh, SKIP_HINT } from "./support.mjs";
const { apply } = await import("../plugin/index.mjs");

const cordis = await importFromDsh("cordis/lib/index.js");
const localSubprocess = await importFromDsh("dsh-subprocess-local/lib/index.js");
if (cordis === undefined || localSubprocess === undefined) {
  console.log(SKIP_HINT);
  process.exit(0);
}
const { Context } = cordis;
const { LocalSubprocessRuntime } = localSubprocess;

const ctxRoot = new Context();
const subprocess = new LocalSubprocessRuntime(ctxRoot);

let registration = null;
const disposed = [];
const pluginCtx = {
  subprocess,
  tools: { register(def) { registration = def; return () => { registration = null }; } },
  get(name) { if (name === "workingDirectory") return { async ensure() { return process.cwd(); } }; return undefined; },
  effect(fn) { const d = fn(); disposed.push(d); return d; },
  on() {},
};
// 本测试验证协议与子进程回收，不挂沙箱服务 —— 显式接受无边界会话。
apply(pluginCtx, { allowUnconfined: true });

const results = [];
const check = (label, pass, detail) => results.push((pass ? "PASS " : "FAIL ") + label + (detail ? "  ::  " + detail : ""));
const exec = { agent: { session: { id: "e2e", header: { cwd: process.cwd() } } }, signal: undefined };
const run = (script, extra) => registration.execute({ script, ...(extra ?? {}) }, exec);

check("registered", registration !== null && registration.name === "pwsh_run");

let r = await run("$n='Skadi'\nWrite-Output \"hi $n\"\n@'\nlit $n\n'@");
check("verbatim", r.text === "hi Skadi\nlit $n", JSON.stringify(r.text));

await run("$global:e2e = 10");
r = await run("$global:e2e += 5\nWrite-Output $global:e2e");
check("persist", r.text === "15", JSON.stringify(r.text));

r = await run("Write-Output $PWD.Path");
check("cwd", r.text.trim() === process.cwd(), JSON.stringify(r.text));

const big = "Write-Output 'big'\n" + Array.from({ length: 6000 }, (_, i) => "$q" + i + " = " + i).join("\n");
r = await run(big);
check("big(" + big.length + ")", r.text === "big", JSON.stringify(r.text));

r = await run("Write-Output 'before'\nStart-Sleep 20", { timeoutMs: 1500 });
check("timeout-note", r.text.includes("timed out after"), JSON.stringify(r.text.slice(-120)));
r = await run("Write-Output ([string]::IsNullOrEmpty($global:e2e))");
check("timeout-rebuilt", r.text === "True", JSON.stringify(r.text));

// 子进程回收：脚本内起 cmd，超时后会话被 terminate，Job Object 应连带清掉子进程
r = await run("$p = Start-Process cmd -ArgumentList '/c','timeout','120' -PassThru\nWrite-Output $p.Id\nStart-Sleep 20", { timeoutMs: 2000 });
const pid = (r.text.match(/^(\d+)/m) ?? [])[1];
await new Promise((res) => setTimeout(res, 1200));
let alive = "no-pid";
if (pid !== undefined) {
  try { process.kill(Number(pid), 0); alive = "ALIVE"; } catch { alive = "gone"; }
}
check("child-reaped", alive === "gone", "pid=" + pid + " " + alive);

for (const d of disposed.reverse()) if (typeof d === "function") d();
await new Promise((res) => setTimeout(res, 600));
console.log(results.join("\n"));
const fails = results.filter((x) => x.startsWith("FAIL")).length;
console.log("\nSUMMARY pass=" + (results.length - fails) + " fail=" + fails);
process.exit(0);
