// 阶段 0 端到端检查：段落编辑 → 撤销/重做 → 保存 → 重新打开验证，并输出前后对比图。
import fs from "node:fs"
import path from "node:path"
import * as mupdf from "mupdf"
import { EditorDoc } from "../src/engine/editor.ts"
import { FontResolver, httpFontProvider } from "../src/engine/fonts.ts"

const S = "../testdata/samples/"
const OUT = "../testdata/out/"
fs.mkdirSync(OUT, { recursive: true })
const fonts = new FontResolver(httpFontProvider(process.env.API ?? "http://127.0.0.1:34115"))
await fonts.init()

let failures = 0
const check = (ok: boolean, msg: string) => {
  console.log(ok ? "  ✓" : "  ✗", msg)
  if (!ok) failures++
}
const png = (d: EditorDoc, i: number, file: string) => {
  const r = d.render(i, 1.5)
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, r.width, r.height], false)
  const dst = pix.getPixels()
  for (let k = 0, j = 0; k < r.data.length; k += 4, j += 3) {
    dst[j] = r.data[k]; dst[j + 1] = r.data[k + 1]; dst[j + 2] = r.data[k + 2]
  }
  fs.writeFileSync(path.join(OUT, file), pix.asPNG())
}
const vectorCount = (d: EditorDoc, i: number) => {
  let n = 0
  const dev = new mupdf.Device({ fillPath() { n++ }, strokePath() { n++ } })
  d.doc.loadPage(i).runPageContents(dev, mupdf.Matrix.identity)
  dev.close()
  return n
}
const pageText = (d: EditorDoc | mupdf.Document, i: number) =>
  (d instanceof EditorDoc ? d.doc : d).loadPage(i).toStructuredText("inhibit-spaces").asText().replace(/\s+/g, "")

// replace 写成 "!删除" 表示删除整段；expect 检查排版结果
interface Case { id: number; find: string; replace: string; note: string; expect?: { moved?: boolean; shrink?: boolean } }

async function run(file: string, cases: Case[], password = "") {
  const name = path.basename(file, ".pdf")
  console.log(`\n== ${name}`)
  const d = new EditorDoc(fs.readFileSync(path.join(S, file)), fonts)
  if (d.needsPassword()) check(d.authenticate(password), "密码认证")
  d.ready()
  png(d, 0, `${name}-前.png`)
  const vec0 = vectorCount(d, 0)
  const before = d.paragraphs(0).paragraphs.map((p) => p.text)
  const expected: string[] = []
  const t0 = performance.now()
  for (const c of cases) {
    // 编辑后段落顺序会变（新文字写在内容流末尾），所以按文字查找段落
    const ps = d.paragraphs(0).paragraphs
    const p = ps.find((x) => x.text === c.find) ?? ps.find((x) => x.text.includes(c.find))
    check(!!p, `找到「${c.find}」`)
    if (!p) continue
    const nt = c.replace === "!删除" ? "" : p.text.replace(c.find, c.replace)
    // 同一段改第二次时，前一次的期望结果作废
    const prev = expected.indexOf(p.text)
    if (prev >= 0) expected.splice(prev, 1)
    const rep = await d.editParagraph(0, p.id, nt)
    if (c.expect?.moved) check(rep.moved > 0, `下方内容随之移动（${rep.moved} 段，${rep.movedBy.toFixed(1)}pt）`)
    if (c.expect?.shrink) check(rep.shrink < 1 && rep.lines === 1, `单元格内缩小字号保持单行（${Math.round(rep.shrink * 100)}%）`)
    expected.push(nt)
    console.log(`    ${c.note}：${rep.lines} 行${rep.overflow ? "（超出原区域）" : ""}；字体 ${rep.fonts.map((f) => f.face + (f.substituted ? "[替换]" : "") + (f.fallbackChars ? `（回退：${f.fallbackChars}）` : "")).join("、")}${rep.synthBold ? "；伪粗体" : ""}${rep.missingChars ? `；无字体可用、已省略：${rep.missingChars}` : ""}`)
    expected[expected.length - 1] = [...nt].filter((ch) => !rep.missingChars.includes(ch)).join("")
  }
  console.log(`    编辑耗时 ${(performance.now() - t0).toFixed(0)} ms`)
  const txt = pageText(d, 0)
  for (const e of expected) if (e) check(txt.includes(e.replace(/\s+/g, "")), `新文字已写入：${e.slice(0, 24)}…`)
  // 未修改的段落应保持不变
  const untouched = before.filter((t) => !cases.some((c) => t.includes(c.find)))
  check(untouched.every((t) => txt.includes(t.replace(/\s+/g, ""))), `未修改的 ${untouched.length} 个段落文字保持不变`)
  check(vectorCount(d, 0) === vec0, `线条/色块数量不变（${vec0}）`)
  png(d, 0, `${name}-后.png`)

  // 撤销 / 重做
  const steps = d.doc.getJournal().steps.length
  for (let k = 0; k < cases.length; k++) d.undo()
  check(pageText(d, 0) === pageText(new EditorDoc(fs.readFileSync(path.join(S, file)), fonts).doc.needsPassword() ? (() => { const x = new EditorDoc(fs.readFileSync(path.join(S, file)), fonts); x.authenticate(password); return x })() : new EditorDoc(fs.readFileSync(path.join(S, file)), fonts), 0), `撤销 ${steps} 步后恢复原文`)
  for (let k = 0; k < cases.length; k++) d.redo()
  check(pageText(d, 0) === txt, "重做后恢复修改")

  // 保存并重新打开
  const t1 = performance.now()
  const bytes = d.save()
  const orig = fs.statSync(path.join(S, file)).size
  console.log(`    保存耗时 ${(performance.now() - t1).toFixed(0)} ms，体积 ${(orig / 1024).toFixed(1)} KB → ${(bytes.length / 1024).toFixed(1)} KB`)
  fs.writeFileSync(path.join(OUT, `${name}-已编辑.pdf`), bytes)
  const re = new mupdf.PDFDocument(bytes)
  if (password) {
    check(re.needsPassword(), "保存后仍然加密")
    re.authenticatePassword(password)
  }
  check(pageText(re, 0) === txt, "重新打开后文字一致")
  check(!d.dirty, "保存后不再标记为未保存")
}

await run("01-通知-混合字体.pdf", [
  { id: 0, find: "关于开展文档处理效率提升工作的通知", replace: "关于提升文档效率的通知", note: "居中标题改短" },
  { id: 1, find: "年度工作部署", replace: "2027年度重点工作部署和技术规划", note: "两端对齐段落加长" },
  { id: 3, find: "签字确认", replace: "签字并加盖公章确认", note: "混合样式段落（粗体/红色）" },
  { id: 4, find: "仍有提升空间", replace: "仍有提升空间（含生僻字：𬌗、𫓧、䶮）", note: "楷体段落加生僻字（测试缺字回退）" },
  { id: 6, find: "办公室", replace: "综合办公室", note: "右对齐改长" },
  { id: 0, find: "请各单位于11月30日前", replace: "!删除", note: "删除整段", expect: { moved: true } },
  { id: 0, find: "认真组织实施", replace: "认真组织实施，并于每月底前汇总上报执行情况，由办公室统一督办", note: "段落加长一行", expect: { moved: true } },
])
await run("02-表格.pdf", [
  { id: 8, find: "笔记本电脑", replace: "高性能笔记本电脑（含扩展坞）", note: "表格单元格加长", expect: { shrink: true } },
  { id: 10, find: "6,800", replace: "7,200", note: "改数字" },
  { id: 1, find: "金额单位为元", replace: "金额单位为人民币元", note: "表格上方正文" },
])
await run("03-双栏.pdf", [
  { id: 2, find: "华东、华南两个区域", replace: "华东、华南、西南三个区域", note: "双栏左栏段落" },
  { id: 12, find: "仍有提升空间", replace: "仍有较大提升空间", note: "双栏右栏段落" },
])
await run("06-加密-密码1234.pdf", [
  { id: 1, find: "现将有关事项通知如下", replace: "现将相关事项通知如下", note: "加密文件改字" },
], "1234")

console.log(failures ? `\n失败 ${failures} 项` : "\n全部通过")
process.exit(failures ? 1 : 0)
