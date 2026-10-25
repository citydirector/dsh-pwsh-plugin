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
// 服务端把异常剥到最内层才交付，所以真实路径上看到的是这两条，没有 "failed to run" 前缀。
const INNER_ENCODING = 'StandardOutputEncoding is only supported when standard output is redirected.'
const INNER_DENIED = '拒绝访问。'

const sample = describeExecDenial(DENIED)
check('中文拒绝被识别', sample !== null)
check('提到受限令牌', sample.includes('restricted token'), sample)
check('点出 & exe 也不行', sample.includes('& exe'), sample)
check('给出两条可用走法',
  sample.includes('Diagnostics.Process') && sample.includes('Start-Process -NoNewWindow'),
  sample)
check('警告 CreateNoWindow 与无 -NoNewWindow 会弹模态框',
  sample.includes('CreateNoWindow=$true') && sample.includes('0xC0000142'),
  sample)
check('英文报错同样命中', describeExecDenial(DENIED_EN) !== null)
check('内层编码文案命中', describeExecDenial(INNER_ENCODING) !== null)
// 光秃秃一句「拒绝访问。」太泛（别的原因也会这么报），不单独当作沙箱边界。
check('只有拒绝访问、没有编码线索时不触发', describeExecDenial(INNER_DENIED) === null)

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
