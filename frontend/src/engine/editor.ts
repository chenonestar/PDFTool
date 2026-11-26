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
    let lines = layoutParagraph(layoutChars, measure, width, indent)

    // 表格单元格：一行放不下时缩小字号，保持单行，不写到下一格
    let shrink = 1
    if (para.cell && para.lines.length === 1 && lines.length > 1 && !chars.includes("\n")) {
      const natural = layoutChars.reduce((w, c) => w + measure(c.ch, c.style), 0)
      shrink = Math.max(0.4, Math.min(1, ((width - indent) / natural) * 0.995))
      for (const rs of runStyles) rs.size *= shrink
      lines = layoutParagraph(layoutChars, measure, width, indent)
    }

    // 段落高度变了：下方内容跟着上移 / 下移（表格单元格除外）
    const empty = chars.every((c) => /\s/.test(c))
    const plan = para.cell ? null : this.planShift(pageIndex, para, empty ? 0 : lines.length)

    // 3–4. 删除原文字并写回新文字（一次 journal 操作）
    this.doc.beginOperation("编辑段落")
    try {
      const move = plan && !plan.blocked && plan.members.length ? plan : null
      const form = move ? this.captureRegion(pageIndex, move.region) : null
      this.redactParagraph(pageIndex, para, move?.region)
      if (!empty) this.writeLines(pageIndex, para, lines, runStyles)
      if (move && form) this.drawShifted(pageIndex, form, move.region, move.delta)
      this.doc.endOperation()
    } catch (e) {
      this.doc.abandonOperation()
      throw e
    }
    this.paraCache.delete(pageIndex)

    const moved = plan && !plan.blocked ? plan.members.length : 0
    return {
      lines: lines.length,
      overflow: lines.length > para.lines.length && !moved && shrink === 1,
      shrink,
      moved,
      movedBy: moved ? plan!.delta : 0,
      shiftBlocked: plan?.blocked ?? "",
      fonts: [...base.entries()].map(([si, r]) => ({ style: styles[si], face: r.face.fullZh || r.face.full || r.face.family, fallbackChars: fallbackChars.get(si) ?? "", substituted: r.substituted })),
      synthBold: runStyles.some((r) => r.synthBold),
      missingChars: missing,
    }
  }

  /**
   * 计算段落高度变化后，下方需要移动的内容：同一栏里、紧接着的段落，
   * 遇到线条 / 图片 / 色块、跨栏内容或很大的空白（页脚）就停下。
   */
  private planShift(pageIndex: number, para: Paragraph, newLineCount: number): ShiftPlan | null {
    const { paragraphs, obstacles } = this.paragraphs(pageIndex)
    const n = para.lines.length
    const last = para.lines[n - 1]
    const descent = last.bbox[3] - last.baseline
    const colL = Math.min(para.left, para.bbox[0])
    const colR = Math.max(para.right, para.bbox[2])
    const xOverlap = (b: Rect4) => Math.min(b[2], colR) - Math.max(b[0], colL)
    const below = paragraphs.filter((p) => p.id !== para.id && p.bbox[1] >= para.bbox[3] - 1).sort((a, b) => a.bbox[1] - b.bbox[1])
    const inCol = below.filter((p) => xOverlap(p.bbox) > (p.bbox[2] - p.bbox[0]) * 0.5)
    // 障碍：线条/图片（包住本段的背景色块除外）、横跨本栏但不属于本栏的段落
    const obs: Rect4[] = obstacles.filter((o) => xOverlap(o) > 0 && o[3] > para.bbox[3] && !(o[1] <= para.bbox[1] + 1 && o[3] >= para.bbox[3] - 1))
    for (const p of below) if (!inCol.includes(p) && xOverlap(p.bbox) > 0) obs.push(p.bbox)

    const members: Paragraph[] = []
    let bottom = para.bbox[3]
    let limit = this.pageBounds(pageIndex)[3] - 15
    for (const p of inCol) {
      const gap = p.bbox[1] - bottom
      if (gap > Math.max(p.size * 4, 40) || obs.some((o) => o[1] < p.bbox[3] && o[3] > bottom)) {
        limit = Math.min(limit, p.bbox[1])
        break
      }
      members.push(p)
      bottom = p.bbox[3]
    }
    for (const o of obs) if (o[1] >= bottom - 0.5) limit = Math.min(limit, o[1])

    let delta: number
    if (newLineCount === 0) {
      // 整段删除：下方内容上移到本段原来的位置
      delta = members.length ? -(members[0].bbox[1] - para.bbox[1]) : 0
    } else {
      const base = newLineCount <= n ? para.lines[newLineCount - 1].baseline : last.baseline + para.pitch * (newLineCount - n)
      delta = base + descent - para.bbox[3]
    }
    if (Math.abs(delta) < 0.5 || !members.length) return { members: [], region: [0, 0, 0, 0], delta: 0 }

    const x0 = Math.min(colL, ...members.map((m) => m.bbox[0])) - 2
    const x1 = Math.max(colR, ...members.map((m) => m.bbox[2])) + 2
    const y0 = (para.bbox[3] + members[0].bbox[1]) / 2
    const y1 = Math.min(bottom + 2, (bottom + limit) / 2)
    const plan: ShiftPlan = { members, region: [x0, y0, x1, y1], delta }
    if (delta > 0 && bottom + delta > limit - 1) plan.blocked = "下方空间不够，后面的内容没有移动，可能重叠"
    return plan
  }

  /** 把页面上 region 区域内的原始内容（保留原字体）复制成一个 Form XObject */
  private captureRegion(pageIndex: number, region: Rect4): mupdf.PDFObject {
    const page = this.doc.loadPage(pageIndex)
    const pageObj = page.getObject()
    const mb = pageObj.getInheritable("MediaBox")
    const mediabox = [0, 1, 2, 3].map((i) => mb.get(i).asNumber()) as mupdf.Rect
    // 资源复制两层，避免临时页面上的 redaction 改到原页面共用的资源
    const res = this.doc.newDictionary()
    const src = pageObj.getInheritable("Resources")
    if (!src.isNull())
      src.forEach((v, k) => {
        const r = v.resolve()
        if (r.isDictionary()) {
          const d = this.doc.newDictionary()
          r.forEach((vv, kk) => d.put(kk, vv))
          res.put(k, d)
        } else res.put(k, v)
      })
    const tmpRef = this.doc.addPage(mediabox, 0, res, readContents(pageObj))
    this.doc.insertPage(-1, tmpRef)
    const ti = this.doc.countPages() - 1
    try {
      const tp = this.doc.loadPage(ti)
      const toTmp = mupdf.Matrix.concat(mupdf.Matrix.invert(page.getTransform()), tp.getTransform())
      const [rx0, ry0, rx1, ry1] = transformRect(region, toTmp)
      const [bx0, by0, bx1, by1] = tp.getBounds()
      const quads: number[][] = []
      const add = (a: number, b: number, c: number, d: number) => {
        if (c - a > 0.1 && d - b > 0.1) quads.push([a, b, c, b, a, d, c, d])
      }
      add(bx0, by0, bx1, ry0)
      add(bx0, ry1, bx1, by1)
      add(bx0, ry0, rx0, ry1)
      add(rx1, ry0, bx1, ry1)
      if (quads.length) {
        const annot = tp.createAnnotation("Redact")
        annot.setRect([bx0, by0, bx1, by1])
        annot.setQuadPoints(quads as unknown as mupdf.Quad[])
        annot.applyRedaction(0, mupdf.PDFPage.REDACT_IMAGE_REMOVE, mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED, mupdf.PDFPage.REDACT_TEXT_REMOVE)
      }
      const tpObj = this.doc.loadPage(ti).getObject()
      return this.doc.addStream(readContents(tpObj), {
        Type: "XObject",
        Subtype: "Form",
        BBox: mediabox,
        Resources: tpObj.get("Resources"),
      })
    } finally {
      this.doc.deletePage(ti)
    }
  }

  /** 在页面上按 delta 平移绘制复制出来的区域（并裁剪到平移后的区域） */
  private drawShifted(pageIndex: number, form: mupdf.PDFObject, region: Rect4, delta: number) {
    const page = this.doc.loadPage(pageIndex)
    const pageObj = page.getObject()
    const res = ownResources(this.doc, pageObj)
    let xo = res.get("XObject")
    if (xo.isNull()) {
      xo = this.doc.newDictionary()
      res.put("XObject", xo)
    }
    let i = 1
    while (!xo.get("PTX" + i).isNull()) i++
    const name = "PTX" + i
    xo.put(name, form)
    const ctm = page.getTransform()
    const inv = mupdf.Matrix.invert(ctm)
    const m = mupdf.Matrix.concat(mupdf.Matrix.concat(ctm, mupdf.Matrix.translate(0, delta)), inv)
    const [cx0, cy0, cx1, cy1] = transformRect([region[0], region[1] + delta, region[2], region[3] + delta], inv)
    const f = (v: number) => (Math.abs(v) < 1e-6 ? "0" : v.toFixed(3).replace(/\.?0+$/, ""))
    appendContent(this.doc, pageObj, `q ${f(cx0)} ${f(cy0)} ${f(cx1 - cx0)} ${f(cy1 - cy0)} re W n ${m.map(f).join(" ")} cm /${name} Do Q\n`)
  }

  /** 用 redaction 删除段落文字：只删文字，不动图片和线条 */
  private redactParagraph(pageIndex: number, para: Paragraph, extra?: Rect4) {
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
    // 要移动的区域：原位置的文字也删掉（之后由复制出的 Form 在新位置绘制）
    if (extra) quads.push([extra[0], extra[1], extra[2], extra[1], extra[0], extra[3], extra[2], extra[3]])
    const all = extra ? [Math.min(para.bbox[0], extra[0]), Math.min(para.bbox[1], extra[1]), Math.max(para.bbox[2], extra[2]), Math.max(para.bbox[3], extra[3])] : para.bbox
    annot.setRect(all as unknown as mupdf.Rect)
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
    const res = ownResources(this.doc, pageObj)
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
    appendContent(this.doc, pageObj, out.join("\n") + "\n")
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

interface ShiftPlan {
  members: Paragraph[]
  region: Rect4
  delta: number
  blocked?: string
}

function transformRect(r: Rect4 | number[], m: mupdf.Matrix): Rect4 {
  const pts = [
    [r[0], r[1]],
    [r[2], r[1]],
    [r[0], r[3]],
    [r[2], r[3]],
  ].map(([x, y]) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]])
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

/** 页面自己的 Resources（继承来的先复制一份到页面上） */
function ownResources(doc: mupdf.PDFDocument, pageObj: mupdf.PDFObject): mupdf.PDFObject {
  let res = pageObj.get("Resources")
  if (res.isNull()) {
    const inherited = pageObj.getInheritable("Resources")
    res = doc.newDictionary()
    if (!inherited.isNull()) inherited.forEach((v, k) => res.put(k, v))
    pageObj.put("Resources", res)
  }
  return res
}

function readContents(pageObj: mupdf.PDFObject): string {
  const c = pageObj.get("Contents")
  const parts: string[] = []
  if (c.isArray()) c.forEach((v) => parts.push(v.readStream().asString()))
  else if (!c.isNull()) parts.push(c.readStream().asString())
  return parts.join("\n")
}

/** 在页面内容末尾追加一段内容流；原内容包在 q/Q 里，避免图形状态影响新内容 */
function appendContent(doc: mupdf.PDFDocument, pageObj: mupdf.PDFObject, content: string) {
  const contents = pageObj.get("Contents")
  const arr = doc.newArray()
  arr.push(doc.addStream("q\n", {}))
  if (contents.isArray()) contents.forEach((v) => arr.push(v))
  else if (!contents.isNull()) arr.push(contents)
  arr.push(doc.addStream("\nQ\n", {}))
  arr.push(doc.addStream(content, {}))
  pageObj.put("Contents", arr)
}

export type { Rect4 }
