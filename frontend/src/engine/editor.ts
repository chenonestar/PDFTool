// 文档编辑核心：在 Worker 中运行，也可以在 Node 中直接测试。
import * as mupdf from "mupdf"
import { FontResolver } from "./fonts.ts"
import { justifySpacing, layoutParagraph, type LayoutChar } from "./layout.ts"
import { extractLines, groupParagraphs } from "./paragraphs.ts"
import type { CharStyle, EditReport, FontFace, PageParagraphs, Paragraph, Rect4 } from "./types.ts"

export interface RenderResult {
  width: number
  height: number
  data: Uint8ClampedArray // RGBA
}

interface RunStyle {
  face: FontFace
  font: mupdf.Font
  size: number
  color: [number, number, number]
  synthBold: boolean
}

/** 新旧文本做前后缀比对，把原样式映射到新文本上：没改动的字保留原样式，新插入的字沿用前一个字的样式 */
export function mapStyles(oldText: string, oldStyles: number[], newText: string): number[] {
  const a = [...oldText]
  const b = [...newText]
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  let s = 0
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  const out: number[] = []
  for (let i = 0; i < p; i++) out.push(oldStyles[i])
  const fill = oldStyles[p - 1] ?? oldStyles[p] ?? oldStyles[0] ?? 0
  for (let i = p; i < b.length - s; i++) out.push(fill)
  for (let i = a.length - s; i < a.length; i++) out.push(oldStyles[i])
  return out
}

export class EditorDoc {
  readonly doc: mupdf.PDFDocument
  private password = ""
  private paraCache = new Map<number, PageParagraphs>()
  private fontRefs = new Map<string, mupdf.PDFObject>()
  private savedPosition = 0

  private fonts: FontResolver

  constructor(bytes: Uint8Array, fonts: FontResolver) {
    this.fonts = fonts
    this.doc = new mupdf.PDFDocument(bytes)
  }

  needsPassword() {
    return this.doc.needsPassword()
  }

  authenticate(pw: string): boolean {
    const ok = this.doc.authenticatePassword(pw) !== 0
    if (ok) this.password = pw
    return ok
  }

  /** 认证（如需要）后调用 */
  ready() {
    this.doc.enableJournal()
    this.savedPosition = this.doc.getJournal().position
  }

  get pageCount() {
    return this.doc.countPages()
  }

  pageBounds(i: number): Rect4 {
    const b = this.doc.loadPage(i).getBounds()
    return [b[0], b[1], b[2], b[3]]
  }

  render(i: number, scale: number): RenderResult {
    const page = this.doc.loadPage(i)
    const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true)
    const w = pix.getWidth()
    const h = pix.getHeight()
    const n = pix.getNumberOfComponents()
    const stride = pix.getStride()
    const src = pix.getPixels()
    const data = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) {
      let si = y * stride
      let di = y * w * 4
      for (let x = 0; x < w; x++, si += n, di += 4) {
        data[di] = src[si]
        data[di + 1] = src[si + 1]
        data[di + 2] = src[si + 2]
        data[di + 3] = 255
      }
    }
    pix.destroy()
    return { width: w, height: h, data }
  }

  paragraphs(i: number): PageParagraphs {
    let p = this.paraCache.get(i)
    if (!p) {
      const page = this.doc.loadPage(i)
      const b = page.getBounds()
      p = groupParagraphs(extractLines(page), [b[0], b[1], b[2], b[3]])
      this.paraCache.set(i, p)
    }
    return p
  }

  private async resolveRunStyle(style: CharStyle): Promise<{ face: FontFace; font: mupdf.Font; synthBold: boolean; substituted: boolean }> {
    const picked = this.fonts.pick(style)
    let face = picked.face
    if (!face) throw new Error("系统中没有可用的中文字体")
    let synthBold = false
    if (style.bold && !face.bold) {
      const b = this.fonts.boldOf(face)
      if (b) face = b
      else synthBold = true
    }
    return { face, font: await this.fonts.load(face), synthBold, substituted: picked.substituted }
  }

  /** 段落编辑：提取 → 只删文字 → 排版 → 写回。整个过程是一次可撤销操作。 */
  async editParagraph(pageIndex: number, paraId: number, newText: string): Promise<EditReport> {
    const { styles, paragraphs } = this.paragraphs(pageIndex)
    const para = paragraphs.find((p) => p.id === paraId)
    if (!para) throw new Error("段落不存在")
    const chars = [...newText.replace(/\r\n?/g, "\n")]
    const charStyles = mapStyles(para.text, para.textStyles, chars.join(""))

    // 1. 为每种原样式解析字体，并为缺字找回退字体
    const base = new Map<number, Awaited<ReturnType<EditorDoc["resolveRunStyle"]>>>()
    for (const si of new Set(charStyles)) base.set(si, await this.resolveRunStyle(styles[si]))
    const runStyles: RunStyle[] = []
    const runIndex = new Map<string, number>()
    const fallbackChars = new Map<number, string>()
    let missing = ""
    const layoutChars: LayoutChar[] = []
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i]
      const si = charStyles[i]
      const st = styles[si]
      let { face, font, synthBold } = base.get(si)!
      const cp = ch.codePointAt(0)!
      if (ch !== "\n" && font.encodeCharacter(cp) === 0) {
        let found = false
        // 缺字回退：只用 TrueType 字体（CFF 字体无法子集化，嵌入后文件会大几十 MB）
        for (const f of this.fonts.fallbackChain(st)) {
          if (f.outline === "cff") continue
          const ff = await this.fonts.load(f)
          if (ff.encodeCharacter(cp) !== 0) {
            face = f
            font = ff
            synthBold = st.bold && !f.bold
            fallbackChars.set(si, (fallbackChars.get(si) ?? "") + ch)
            found = true
            break
          }
        }
        if (!found) {
          missing += ch
          continue
        }
      }
      const key = `${face.id}|${st.size}|${st.color.join(",")}|${synthBold}`
      let ri = runIndex.get(key)
      if (ri === undefined) {
        ri = runStyles.length
        runStyles.push({ face, font, size: st.size, color: st.color, synthBold })
        runIndex.set(key, ri)
      }
      layoutChars.push({ ch, style: ri })
    }

    // 2. 排版
    const measure = (ch: string, ri: number) => {
      const rs = runStyles[ri]
      return rs.font.advanceGlyph(rs.font.encodeCharacter(ch.codePointAt(0)!)) * rs.size
    }
    const width = para.right - para.left
    const indent = para.align === "left" || para.align === "justify" ? para.firstIndent : 0
    const lines = layoutParagraph(layoutChars, measure, width, indent)

    // 3–4. 删除原文字并写回新文字（一次 journal 操作）
    this.doc.beginOperation("编辑段落")
    try {
      this.redactParagraph(pageIndex, para)
      this.writeLines(pageIndex, para, lines, runStyles)
      this.doc.endOperation()
    } catch (e) {
      this.doc.abandonOperation()
      throw e
    }
    this.paraCache.delete(pageIndex)

    return {
      lines: lines.length,
      overflow: lines.length > para.lines.length,
      fonts: [...base.entries()].map(([si, r]) => ({ style: styles[si], face: r.face.fullZh || r.face.full || r.face.family, fallbackChars: fallbackChars.get(si) ?? "", substituted: r.substituted })),
      synthBold: runStyles.some((r) => r.synthBold),
      missingChars: missing,
    }
  }

  /** 用 redaction 删除段落文字：只删文字，不动图片和线条 */
  private redactParagraph(pageIndex: number, para: Paragraph) {
    const page = this.doc.loadPage(pageIndex)
    const annot = page.createAnnotation("Redact")
    const quads: number[][] = []
    for (const l of para.lines) {
      // 只覆盖每行中间一条带，避免误删上下相邻行的字
      const h = l.bbox[3] - l.bbox[1]
      const x0 = l.bbox[0] - 0.5
      const x1 = l.bbox[2] + 0.5
      const y0 = l.bbox[1] + h * 0.3
      const y1 = l.bbox[3] - h * 0.3
      quads.push([x0, y0, x1, y0, x0, y1, x1, y1])
    }
    annot.setRect(para.bbox as unknown as mupdf.Rect)
    annot.setQuadPoints(quads as unknown as mupdf.Quad[])
    annot.applyRedaction(0, mupdf.PDFPage.REDACT_IMAGE_NONE, mupdf.PDFPage.REDACT_LINE_ART_NONE, mupdf.PDFPage.REDACT_TEXT_REMOVE)
  }

  private fontRef(rs: RunStyle): mupdf.PDFObject {
    let ref = this.fontRefs.get(rs.face.id)
    if (!ref) {
      ref = this.doc.addFont(rs.font)
      this.fontRefs.set(rs.face.id, ref)
    }
    return ref
  }

  private writeLines(pageIndex: number, para: Paragraph, lines: ReturnType<typeof layoutParagraph>, runStyles: RunStyle[]) {
    const page = this.doc.loadPage(pageIndex)
    const pageObj = page.getObject()
    let res = pageObj.get("Resources")
    if (res.isNull()) {
      const inherited = pageObj.getInheritable("Resources")
      res = this.doc.newDictionary()
      if (!inherited.isNull()) inherited.forEach((v, k) => res.put(k, v))
      pageObj.put("Resources", res)
    }
    let fontDict = res.get("Font")
    if (fontDict.isNull()) {
      fontDict = this.doc.newDictionary()
      res.put("Font", fontDict)
    }
    const used = new Set<string>()
    fontDict.forEach((_v, k) => used.add(String(k)))
    const names = new Map<string, string>()
    const nameFor = (rs: RunStyle) => {
      let n = names.get(rs.face.id)
      if (!n) {
        let i = 1
        while (used.has("PTF" + i)) i++
        n = "PTF" + i
        used.add(n)
        fontDict.put(n, this.fontRef(rs))
        names.set(rs.face.id, n)
      }
      return n
    }

    // 伪粗体的描边线宽：用 ExtGState（/LW）设置。直接写 w 操作符会在之后的 redaction 内容过滤中被丢掉。
    let gsDict = res.get("ExtGState")
    if (gsDict.isNull()) {
      gsDict = this.doc.newDictionary()
      res.put("ExtGState", gsDict)
    }
    const gsUsed = new Set<string>()
    gsDict.forEach((_v, k) => gsUsed.add(String(k)))
    const gsNames = new Map<string, string>()
    const boldGs = (size: number) => {
      const lw = (size * 0.03).toFixed(3)
      let n = gsNames.get(lw)
      if (!n) {
        let i = 1
        while (gsUsed.has("PTB" + i)) i++
        n = "PTB" + i
        gsUsed.add(n)
        gsDict.put(n, this.doc.addObject({ Type: "ExtGState", LW: Number(lw) }))
        gsNames.set(lw, n)
      }
      return n
    }

    const inv = mupdf.Matrix.invert(page.getTransform())
    const f = (v: number) => (Math.abs(v) < 1e-6 ? "0" : v.toFixed(3).replace(/\.?0+$/, ""))
    const out: string[] = []
    const lastBase = para.lines[para.lines.length - 1].baseline
    lines.forEach((line, li) => {
      if (!line.chars.length) return
      const baseline = li < para.lines.length ? para.lines[li].baseline : lastBase + para.pitch * (li - para.lines.length + 1)
      let x0: number
      if (para.align === "center") x0 = (para.left + para.right) / 2 - line.width / 2
      else if (para.align === "right") x0 = para.right - line.width
      else x0 = para.left + line.indent
      const spacing = para.align === "justify" ? justifySpacing(line, para.right - para.left) : 0
      // 按样式分组输出
      let k = 0
      while (k < line.chars.length) {
        const ri = line.chars[k].style
        let e = k
        while (e < line.chars.length && line.chars[e].style === ri) e++
        const rs = runStyles[ri]
        const x = x0 + line.chars[k].x + k * spacing
        const m = mupdf.Matrix.concat([1, 0, 0, -1, x, baseline], inv)
        const hex = line.chars
          .slice(k, e)
          .map((c) => rs.font.encodeCharacter(c.ch.codePointAt(0)!).toString(16).padStart(4, "0"))
          .join("")
        const [r, g, b] = rs.color
        if (rs.synthBold) out.push(`q /${boldGs(rs.size)} gs ${f(r)} ${f(g)} ${f(b)} RG`)
        out.push("BT")
        out.push(`/${nameFor(rs)} ${f(rs.size)} Tf`)
        out.push(`${f(r)} ${f(g)} ${f(b)} rg`)
        out.push(rs.synthBold ? "2 Tr" : "0 Tr")
        out.push(`${f(spacing)} Tc`)
        out.push(`${m.map(f).join(" ")} Tm`)
        out.push(`<${hex}> Tj`)
        out.push("ET")
        if (rs.synthBold) out.push("Q")
        k = e
      }
    })
    if (!out.length) return

    const contents = pageObj.get("Contents")
    const arr = this.doc.newArray()
    arr.push(this.doc.addStream("q\n", {}))
    if (contents.isArray()) contents.forEach((v) => arr.push(v))
    else if (!contents.isNull()) arr.push(contents)
    arr.push(this.doc.addStream("\nQ\n", {}))
    arr.push(this.doc.addStream(out.join("\n") + "\n", {}))
    pageObj.put("Contents", arr)
  }

  canUndo() {
    return this.doc.canUndo()
  }
  canRedo() {
    return this.doc.canRedo()
  }
  undo() {
    this.doc.undo()
    this.afterHistoryChange()
  }
  redo() {
    this.doc.redo()
    this.afterHistoryChange()
  }
  private afterHistoryChange() {
    this.paraCache.clear()
    this.fontRefs.clear()
  }

  get dirty() {
    return this.doc.getJournal().position !== this.savedPosition
  }

  /** 保存：在副本上做字体子集化和垃圾回收，不影响当前文档和撤销记录 */
  save(): Uint8Array {
    const tmp = this.doc.saveToBuffer("") // 临时副本不压缩，更快
    const copy = new mupdf.PDFDocument(tmp)
    if (copy.needsPassword()) copy.authenticatePassword(this.password)
    copy.subsetFonts()
    const out = copy.saveToBuffer("garbage,compress").asUint8Array().slice()
    copy.destroy()
    tmp.destroy()
    this.savedPosition = this.doc.getJournal().position
    return out
  }
}

export type { Rect4 }
