// 用法：node scripts/try-edit.ts <输入.pdf> <输出前缀> <页码> <查找>=<替换> ...
// 按文字找到段落并替换（替换写成 !删除 表示删除整段），输出修改前后的页面图片和修改后的 PDF。
import fs from "node:fs"
import * as mupdf from "mupdf"
import { EditorDoc } from "../src/engine/editor.ts"
import { FontResolver, httpFontProvider } from "../src/engine/fonts.ts"

const [input, prefix, pageArg, ...edits] = process.argv.slice(2)
const page = Number(pageArg)
const fonts = new FontResolver(httpFontProvider(process.env.API ?? "http://127.0.0.1:34115"))
await fonts.init()
const d = new EditorDoc(fs.readFileSync(input), fonts)
d.ready()
const png = (file: string, doc: mupdf.Document) => fs.writeFileSync(file, doc.loadPage(page).toPixmap(mupdf.Matrix.scale(1.5, 1.5), mupdf.ColorSpace.DeviceRGB, false).asPNG())
png(prefix + "-前.png", d.doc)
for (const e of edits) {
  const k = e.indexOf("=")
  const find = e.slice(0, k)
  const rep = e.slice(k + 1)
  const ps = d.paragraphs(page).paragraphs
  const p = ps.find((x) => x.text === find) ?? ps.find((x) => x.text.includes(find))
  if (!p) {
    console.log("✗ 没找到：", find)
    continue
  }
  const nt = rep === "!删除" ? "" : p.text.replace(find, rep)
  const r = await d.editParagraph(page, p.id, nt)
  console.log(`「${find.slice(0, 16)}」→ ${r.lines} 行${r.shrink < 1 ? `，缩小到 ${(r.shrink * 100).toFixed(0)}%` : ""}${r.moved ? `，下方 ${r.moved} 段移动 ${r.movedBy.toFixed(1)}pt` : ""}${r.shiftBlocked ? "，" + r.shiftBlocked : ""}${r.overflow ? "，超出原区域" : ""}`)
}
const bytes = d.save()
fs.writeFileSync(prefix + "-后.pdf", bytes)
png(prefix + "-后.png", mupdf.Document.openDocument(bytes, "application/pdf"))
