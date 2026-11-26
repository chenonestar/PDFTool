// 浏览器端到端测试：用 Playwright 驱动 frontend/dist（由 Go 开发服务器提供 /api/）。
import { createRequire } from "node:module"
const { chromium } = createRequire(import.meta.url)("playwright") // 使用环境中预装的 Playwright
import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "../..")
const OUT = path.join(ROOT, "testdata/out/e2e")
const BASE = process.env.BASE ?? "http://127.0.0.1:34115"
fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })
// 每次用新文件名：开发服务器在一次运行中对同一路径只备份一次
const work = path.join(OUT, `通知-${Date.now()}.pdf`)
fs.copyFileSync(path.join(ROOT, "testdata/samples/01-通知-混合字体.pdf"), work)

let fails = 0
const check = (ok, msg) => {
  console.log(ok ? "  ✓" : "  ✗", msg)
  if (!ok) fails++
}
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.on("pageerror", (e) => console.log("PAGE ERROR", e.message))
page.on("console", (m) => m.type() === "error" && console.log("CONSOLE", m.text()))
const status = () => page.getByTestId("status").innerText()
const seq = () => page.getByTestId("status").getAttribute("data-seq").then(Number)
// 执行操作并等待状态栏出现新的、匹配的消息
async function act(fn, re, timeout = 30000) {
  const s0 = await seq()
  await fn()
  await page.waitForFunction(
    ([s0, src]) => {
      const el = document.querySelector('[data-testid="status"]')
      return Number(el.dataset.seq) > s0 && new RegExp(src).test(el.innerText)
    },
    [s0, re.source],
    { timeout },
  )
}

console.log("== 打开与渲染")
let t = Date.now()
await page.goto(`${BASE}/?open=${encodeURIComponent(work)}`)
await page.waitForSelector('[data-page="0"] canvas[data-rendered]', { timeout: 30000 })
check(true, `首屏渲染 ${Date.now() - t} ms（含加载 WASM）`)
await page.screenshot({ path: path.join(OUT, "1-打开.png") })

console.log("== 段落编辑")
await page.waitForSelector('[data-page="0"] .para')
const paraCount = await page.locator('[data-page="0"] .para').count()
check(paraCount >= 8, `识别到 ${paraCount} 个段落`)
await page.locator('[data-page="0"] .para[aria-label*="为贯彻落实"]').click()
const ta = page.getByTestId("para-editor")
await ta.waitFor()
const orig = await ta.inputValue()
await page.screenshot({ path: path.join(OUT, "2-编辑框.png") })
await ta.fill(orig.replace("年度工作部署", "2027年度重点工作部署"))
t = Date.now()
await act(() => page.getByTestId("para-apply").click(), /已修改/)
check(true, `应用修改 ${Date.now() - t} ms：${await status()}`)
await page.waitForFunction(() => document.querySelectorAll('[data-page="0"] canvas[data-rendered="1.25|1"]').length === 1)
await page.screenshot({ path: path.join(OUT, "3-修改后.png") })
check((await page.title()).startsWith("●"), "标题显示未保存标记")

console.log("== 用快捷键编辑第二段（Ctrl+Enter）")
await page.locator('[data-page="0"] .para[aria-label*="特别提醒"]').click()
await ta.waitFor()
await ta.press("End")
const v2 = (await ta.inputValue()).replace("签字确认", "签字并盖章确认")
await ta.fill(v2)
await act(() => ta.press("Control+Enter"), /已修改/)
check(true, "Ctrl+Enter 应用")

console.log("== 撤销 / 重做")
await act(() => page.keyboard.press("Control+z"), /已撤销/)
await act(() => page.keyboard.press("Control+z"), /已撤销/)
check(await page.getByTestId("undo").isDisabled(), "撤销两步后无法继续撤销")
await page.keyboard.press("Control+y")
await act(() => page.keyboard.press("Control+y"), /已重做/)
await page.waitForTimeout(300)
check(await page.getByTestId("redo").isDisabled(), "重做两步后无法继续重做")

console.log("== 保存（覆盖 + 自动备份）")
const before = fs.readFileSync(work)
t = Date.now()
await act(() => page.keyboard.press("Control+s"), /已保存/)
const msg = await status()
check(true, `保存 ${Date.now() - t} ms：${msg}`)
const after = fs.readFileSync(work)
check(!before.equals(after), "原文件已被覆盖")
const backup = msg.match(/备份到 (.+)$/)?.[1]
check(!!backup && fs.readFileSync(backup).equals(before), "备份文件与原文件一致")
check(!(await page.title()).startsWith("●"), "保存后未保存标记消失")
await page.getByTestId("save").isDisabled()
// 再次修改并保存：本次运行中不应重复备份
await page.locator('[data-page="0"] .para[aria-label*="办公室"]').last().click()
await ta.fill("综合办公室")
await act(() => ta.press("Control+Enter"), /已修改/)
await act(() => page.keyboard.press("Control+s"), /已保存/)
check(!(await status()).includes("备份"), "同一文件第二次保存不重复备份")

console.log("== 加密文件")
await page.goto(`${BASE}/?open=${encodeURIComponent(path.join(ROOT, "testdata/samples/06-加密-密码1234.pdf"))}`)
await page.getByTestId("password").fill("0000")
await page.keyboard.press("Enter")
await page.waitForSelector("text=密码不正确")
check(true, "错误密码有提示")
await page.getByTestId("password").fill("1234")
await page.keyboard.press("Enter")
await page.waitForSelector('[data-page="0"] canvas[data-rendered]')
check(true, "输入正确密码后打开")

console.log("== 大文件（600 页）")
t = Date.now()
await page.goto(`${BASE}/?open=${encodeURIComponent(path.join(ROOT, "testdata/samples/07-大文件-600页.pdf"))}`)
await page.waitForSelector('[data-page="0"] canvas[data-rendered]', { timeout: 60000 })
check(true, `打开并显示第 1 页 ${Date.now() - t} ms：${await status()}`)
const rendered = await page.locator("canvas[data-rendered]").count()
check(rendered < 20, `只渲染了可见附近的 ${rendered} 页（按需渲染）`)
t = Date.now()
await page.locator('[data-page="599"]').scrollIntoViewIfNeeded()
await page.waitForSelector('[data-page="599"] canvas[data-rendered]', { timeout: 30000 })
check(true, `跳到第 600 页并渲染 ${Date.now() - t} ms`)
t = Date.now()
await page.locator('[data-page="599"] .para').first().click()
await ta.waitFor()
await ta.fill((await ta.inputValue()) + "（已修改）")
await act(() => ta.press("Control+Enter"), /已修改/)
check(true, `第 600 页段落编辑 ${Date.now() - t} ms`)
await page.screenshot({ path: path.join(OUT, "4-大文件.png") })

await browser.close()
console.log(fails ? `\n失败 ${fails} 项` : "\n全部通过")
process.exit(fails ? 1 : 0)
