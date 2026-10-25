// 集成测试：不依赖 DSH，直接用 plugin/session.mjs 的真实代码路径驱动常驻会话
import { spawn } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { startSession } from "../plugin/session.mjs";
import { join } from "node:path";

const SERVER = readFileSync(new URL("../plugin/session-server.ps1", import.meta.url), "utf8");
const PWSH = process.env.PWSH_BIN ?? "pwsh";

// 最小 subprocess 适配器：只实现 session.mjs 用到的那几个字段
const subprocess = {
  spawn(spec) {
    const child = spawn(spec.argv[0], spec.argv.slice(1), {
      cwd: spec.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    return {
      stdin: child.stdin, stdout: child.stdout, stderr: child.stderr,
      done: new Promise((r) => child.on("exit", (code) => r({ exitCode: code }))),
      terminate() { try { child.kill(); } catch {} },
      async waitForExit(signal) {
        return await new Promise((resolve) => {
          if (child.exitCode !== null) return resolve(true);
          child.once("exit", () => resolve(true));
          if (signal) signal.addEventListener("abort", () => resolve(false), { once: true });
        });
      },
    };
  },
};

const results = [];
const check = (label, pass, detail) => results.push((pass ? "PASS " : "FAIL ") + label + (detail ? "  ::  " + detail : ""));

const t0 = Date.now();
const s = await startSession(subprocess, { executable: PWSH, serverSource: SERVER, cwd: process.cwd(), label: "itest" });
const bootMs = Date.now() - t0;
check("boot", s.version !== undefined, "version=" + s.version + " bootMs=" + bootMs);

// 1. 本工具要解决的两件事：`$` 展开与 here-string
let r = await s.run("$n='Skadi'\nWrite-Output \"hi $n\"\n$h=@'\nlit $n\n'@\nWrite-Output $h", 10000);
check("dollar+heredoc", r.out[0] === "hi Skadi" && r.out[1] === "lit $n" && r.sentinel === "ok", JSON.stringify(r.out));

// 2. 流分离与顺序
r = await s.run("Write-Output 'L1'\nWrite-Error 'E1'\nWrite-Output 'L2'\nWrite-Warning 'W1'\nWrite-Output 'L3'", 10000);
const seq = r.out;
// 协议里 O/E/W 是分开的数组，顺序信息在服务端就拆掉了；这里验证各流归属正确
check("streams", r.out.length === 3 && r.err.length === 1 && r.warn.length === 1, "out=" + r.out.length + " err=" + r.err.length + " warn=" + r.warn.length);

// 3. 状态保留
await s.run("$global:acc=7\nSet-Location C:\\Windows", 10000);
r = await s.run("$global:acc++\nWrite-Output $global:acc\nWrite-Output $PWD.Path", 10000);
const kept = r.out;
check("state", kept[0] === "8" && kept[1] === "C:\\Windows", JSON.stringify(kept));

// 4. 超长脚本（远超原生 32K 命令行上限）
const big = "Write-Output 'H'\n" + Array.from({ length: 5000 }, (_, i) => "$k" + i + " = " + i).join("\n") + "\nWrite-Output 'T'";
const b0 = Date.now();
r = await s.run(big, 60000);
const bigMs = Date.now() - b0;
check("big(" + big.length + ")", r.sentinel === "ok" && r.out.length === 2, "ms=" + bigMs);

// 5. 超时：服务端 Stop() 打断，会话仍活
r = await s.run("Write-Output 'p1'\nStart-Sleep 30\nWrite-Output 'never'", 2);
check("timeout", r.timedOut === true && r.sentinel !== "ok", "timedOut=" + r.timedOut + " sentinel=" + r.sentinel + " out=" + r.out.length);
r = await s.run("Write-Output 'alive'", 10000);
check("alive-after-timeout", r.sentinel === "ok" && r.out.length === 1, "sentinel=" + r.sentinel);

// 6. throw 隔离
r = await s.run("throw 'boom'", 10000);
const exc = r.exceptions;
check("throw", r.sentinel === "threw" && exc.length === 1 && exc[0] === "boom", JSON.stringify(exc));
r = await s.run("Write-Output 'after-throw'", 10000);
check("after-throw", r.sentinel === "ok" && r.out.length === 1, "sentinel=" + r.sentinel);

// 7. 语法错误隔离
r = await s.run("function {", 10000);
check("parse-error", r.sentinel === "threw", "sentinel=" + r.sentinel);
r = await s.run("Write-Output 'after-parse'", 10000);
check("after-parse", r.sentinel === "ok" && r.out.length === 1, "sentinel=" + r.sentinel);

// 8. Console 污染与 stdin 陷阱（最危险的会话杀手）
r = await s.run("[Console]::In.ReadLine()\n[Console]::Out.WriteLine('RAW')\nWrite-Output 'clean'", 10000);
check("console-isolation", r.sentinel === "ok" && r.out.includes("clean"), "sentinel=" + r.sentinel + " out=" + JSON.stringify(r.out));

// 9. 子进程的 std handle 已与协议流断开：脚本起的子进程既写不进协议流，也读不走调用数据。
//    不接管的后果实测过一次：子进程随手写一行 <<<BYE>>>，客户端当场判定会话死亡。
//    子命令一律走 -EncodedCommand，省得在字符串里叠引号。
const psQuote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const enc = (text) => Buffer.from(text, "utf16le").toString("base64");
const stealFile = join(process.env.TEMP ?? ".", "itest-steal.txt");
try { unlinkSync(stealFile); } catch {}
const childBye = enc("[Console]::Out.WriteLine('<<<BYE>>>')");
// 第一行必须是真赋值，包成引号就变成字符串字面量了——那样无论接管与否都会走 EOF 分支，测不出东西。
const childSteal = enc("$l=[Console]::In.ReadLine()\nif ($null -eq $l) { [IO.File]::WriteAllText("
  + psQuote(stealFile) + ", " + psQuote("CHILD-EOF") + ") } else { [IO.File]::WriteAllText("
  + psQuote(stealFile) + ", " + psQuote("CHILD-STOLE:") + " + $l) }");
r = await s.run(
  "$me=(Get-Process -Id $PID).Path\n"
  + "$null=Start-Process -FilePath $me -ArgumentList '-NoProfile','-EncodedCommand'," + psQuote(childBye) + " -NoNewWindow -PassThru -Wait\n"
  + "$null=Start-Process -FilePath $me -ArgumentList '-NoProfile','-EncodedCommand'," + psQuote(childSteal) + " -NoNewWindow -PassThru -Wait\n"
  + "Write-Output 'POST'",
  30000,
);
const stole = (() => { try { return readFileSync(stealFile, "utf8").trim(); } catch { return "(missing)"; } })();
try { unlinkSync(stealFile); } catch {}
check("child-stdio-detached", r.sentinel === "ok" && r.out.join("|") === "POST" && stole === "CHILD-EOF",
  "sentinel=" + r.sentinel + " out=" + JSON.stringify(r.out) + " stole=" + stole);

// 10. 崩溃 → 会话死亡可见
const before = s.dead;
r = await s.run("[Environment]::Exit(9)", 10000).catch((e) => ({ rejected: String(e) }));
await new Promise((res) => setTimeout(res, 300));
check("crash-detect", s.dead === true && before === false, "reason=" + s.deathReason);

// 11. 重建
const s2 = await startSession(subprocess, { executable: PWSH, serverSource: SERVER, cwd: process.cwd(), label: "itest2" });
r = await s2.run("Write-Output 'rebuilt'", 10000);
check("rebuild", r.sentinel === "ok" && r.out.length === 1, "sentinel=" + r.sentinel);
await s2.dispose();
await s.dispose();

console.log(results.join("\n"));
const fails = results.filter(x => x.startsWith("FAIL")).length;
console.log("\nSUMMARY pass=" + (results.length - fails) + " fail=" + fails);