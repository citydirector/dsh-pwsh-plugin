/**
 * 「子进程起不来」提示的单元测试 —— 纯 node，不 spawn 任何东西，
 * 所以在这种受限会话里也能跑（受限令牌建不了匿名管道，任何 spawn 都是 EPERM）。
 */
import { describeExecDenial } from '../plugin/index.mjs'

let pass = 0
let fail = 0
const problems = []

function check(label, ok, detail) {
  if (ok) {
    pass += 1
    console.log('  PASS  ' + label)
  } else {
    fail += 1
    problems.push(label + (detail === undefined ? '' : ' :: ' + detail))
    console.log('  FAIL  ' + label + (detail === undefined ? '' : ' :: ' + detail))
  }
}

const DENIED = "Program 'node.exe' failed to run: 拒绝访问。At line:3 char:12"
const DENIED_EN = "Program 'git.exe' failed to run: Access is denied."
const ENCODING = "Program 'node.exe' failed to run: StandardOutputEncoding is only supported when standard output is redirected."

const sample = describeExecDenial(DENIED)
check('中文拒绝被识别', sample !== null)
check('提到受限令牌', sample.includes('restricted token'), sample)
check('点出 & exe 也不行', sample.includes('& exe'), sample)
check('给出三条可用走法',
  sample.includes('Start-Process') && sample.includes('Diagnostics.Process') && sample.includes('.cmd'),
  sample)
check('英文报错同样命中', describeExecDenial(DENIED_EN) !== null)
check('NUL 槽位的变体同样命中', describeExecDenial(ENCODING) !== null)

// 不相关的报错不能被误判成沙箱边界，否则会给出误导性的建议。
check('普通报错不触发', describeExecDenial('Cannot find path C:\\nope') === null)
check('只有前半句不触发', describeExecDenial("Program 'node.exe' failed to run: 找不到文件。") === null)
check('空输出不触发', describeExecDenial('') === null)

console.log('')
console.log('TOTAL pass=' + pass + ' fail=' + fail)
if (fail > 0) {
  console.log(problems.join('\n'))
  process.exit(1)
}
