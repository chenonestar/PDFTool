// 从 mupdf 结构化文字中提取行，并把行合并成段落。
import * as mupdf from "mupdf"
import type { Align, CharStyle, PChar, PLine, PageParagraphs, Paragraph, Rect4, RGB } from "./types.ts"

export const STEXT_OPTIONS = "inhibit-spaces"

const stripSubset = (n: string) => n.replace(/^[A-Z]{6}\+/, "")

function styleKey(s: CharStyle) {
  return `${s.font}|${s.size.toFixed(2)}|${s.color.map((v) => v.toFixed(3)).join(",")}|${s.bold}|${s.italic}`
}

export interface PageText {
  styles: CharStyle[]
  lines: PLine[]
  vectors: Rect4[] // 线条、色块
  images: Rect4[]
}

export function extractLines(page: mupdf.Page): PageText {
  const vectors: Rect4[] = []
  const images: Rect4[] = []
  const stroked = collectGraphics(page, vectors, images)
  const st = page.toStructuredText(STEXT_OPTIONS)
  const styles: CharStyle[] = []
  const index = new Map<string, number>()
  const lines: PLine[] = []
  let cur: PChar[] | null = null
  let horizontal = true
  st.walk({
    beginLine(_bbox, wmode, dir) {
      cur = []
      horizontal = wmode === 0 && Math.abs(dir[1]) < 0.05 && dir[0] > 0
    },
    onChar(c, origin, font, size, quad, color) {
      if (!cur) return
      const name = stripSubset(font.getName())
      const style: CharStyle = {
        font: name,
        size: Math.round(size * 100) / 100,
        color: toRGB(color),
        // 伪粗体：字体没有粗体时，Word/WPS/LibreOffice 常用"填充 + 描边"模拟
        bold: font.isBold() || /bold|black|heavy|semibold|demibold|w[6-9]/i.test(name) || stroked.has(glyphKey(origin[0], origin[1])),
        italic: font.isItalic() || /italic|oblique/i.test(name),
        serif: font.isSerif(),
      }
      const k = styleKey(style)
      let si = index.get(k)
      if (si === undefined) {
        si = styles.length
        styles.push(style)
        index.set(k, si)
      }
      const xs = [quad[0], quad[2], quad[4], quad[6]]
      const ys = [quad[1], quad[3], quad[5], quad[7]]
      cur.push({
        c,
        style: si,
        bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
        ox: origin[0],
        oy: origin[1],
      })
    },
    endLine() {
      if (cur && cur.length && horizontal) {
        const chars = cur.filter((ch) => ch.c !== "\n")
        // MuPDF 会把紧挨着的表格单元格文字合成一行，这里按竖线和大间距再切开
        for (const seg of splitAtRules(chars, styles, vectors)) lines.push(makeLine(seg, styles))
      }
      cur = null
    },
  })
  st.destroy()
  return { styles, lines, vectors, images }
}

const glyphKey = (x: number, y: number) => `${Math.round(x * 2)},${Math.round(y * 2)}`

/**
 * 用自定义 Device 遍历页面：
 * - 收集线条/色块范围（用于找表格框线；mupdf.js 的 stext 选项不提供这项）
 * - 收集描边文字的字形原点（用于识别伪粗体）
 */
function collectGraphics(page: mupdf.Page, out: Rect4[], images: Rect4[]): Set<string> {
  const stroked = new Set<string>()
  const push = (r: number[]) => {
    if (r[2] - r[0] < 1e4 && r[3] - r[1] < 1e4) out.push([r[0], r[1], r[2], r[3]])
  }
  const dev = new mupdf.Device({
    fillPath(path, _eo, ctm) {
      push(path.getBounds(null as unknown as mupdf.StrokeState, ctm))
    },
    strokePath(path, stroke, ctm) {
      push(path.getBounds(stroke, ctm))
    },
    fillImage(_img, ctm) {
      images.push(unitRect(ctm))
    },
    fillImageMask(_img, ctm) {
      images.push(unitRect(ctm))
    },
    strokeText(text, _stroke, ctm) {
      text.walk({
        showGlyph(_font, trm) {
          const m = mupdf.Matrix.concat(trm, ctm)
          stroked.add(glyphKey(m[4], m[5]))
        },
      })
    },
  })
  try {
    page.runPageContents(dev, mupdf.Matrix.identity)
  } finally {
    dev.close()
    dev.destroy()
  }
  return stroked
}

function unitRect(m: number[]): Rect4 {
  const xs = [m[4], m[0] + m[4], m[2] + m[4], m[0] + m[2] + m[4]]
  const ys = [m[5], m[1] + m[5], m[3] + m[5], m[1] + m[3] + m[5]]
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

/** 与给定纵向范围重叠的竖向边界：细竖线，以及纵向覆盖该范围的色块的左右边 */
export function verticalRules(vectors: Rect4[], y0: number, y1: number): number[] {
  const h = y1 - y0
  const xs: number[] = []
  for (const v of vectors) {
    const overlap = Math.min(v[3], y1) - Math.max(v[1], y0)
    if (v[2] - v[0] < 3) {
      if (overlap >= h * 0.6) xs.push((v[0] + v[2]) / 2)
    } else if (overlap >= h * 0.9) {
      xs.push(v[0], v[2])
    }
  }
  return xs
}

function splitAtRules(chars: PChar[], styles: CharStyle[], vectors: Rect4[]): PChar[][] {
  if (chars.length < 2) return [chars]
  const y0 = Math.min(...chars.map((c) => c.bbox[1]))
  const y1 = Math.max(...chars.map((c) => c.bbox[3]))
  const rules = verticalRules(vectors, y0, y1)
  const out: PChar[][] = [[chars[0]]]
  for (let i = 1; i < chars.length; i++) {
    const a = chars[i - 1]
    const b = chars[i]
    const ca = (a.bbox[0] + a.bbox[2]) / 2
    const cb = (b.bbox[0] + b.bbox[2]) / 2
    const size = styles[b.style].size
    const gap = b.bbox[0] - a.bbox[2]
    if (gap > size * 2.5 || rules.some((x) => x > ca && x < cb)) out.push([b])
    else out[out.length - 1].push(b)
  }
  return out.filter((seg) => seg.some((c) => !/\s/.test(c.c)))
}

function toRGB(color: number[]): RGB {
  if (color.length >= 3) return [color[0], color[1], color[2]]
  if (color.length === 1) return [color[0], color[0], color[0]]
  return [0, 0, 0]
}

function makeLine(chars: PChar[], styles: CharStyle[]): PLine {
  // 去掉行首行尾空白（行尾空格会让行宽偏大，影响对齐判断）
  let a = 0
  let b = chars.length
  while (a < b && /\s/.test(chars[a].c)) a++
  while (b > a && /\s/.test(chars[b - 1].c)) b--
  if (a < b) chars = chars.slice(a, b)
  const bbox: Rect4 = [Infinity, Infinity, -Infinity, -Infinity]
  const sizeCount = new Map<number, number>()
  for (const ch of chars) {
    bbox[0] = Math.min(bbox[0], ch.bbox[0])
    bbox[1] = Math.min(bbox[1], ch.bbox[1])
    bbox[2] = Math.max(bbox[2], ch.bbox[2])
    bbox[3] = Math.max(bbox[3], ch.bbox[3])
    const s = styles[ch.style].size
    sizeCount.set(s, (sizeCount.get(s) || 0) + 1)
  }
  const size = [...sizeCount.entries()].sort((a, b) => b[1] - a[1])[0][0]
  // 行基线取出现最多的基线
  return { chars, bbox, baseline: median(chars.map((c) => c.oy)), size }
}

function median(a: number[]) {
  const s = [...a].sort((x, y) => x - y)
  return s[Math.floor(s.length / 2)]
}

const isAsciiWord = (c: string | undefined) => !!c && /[A-Za-z0-9]/.test(c)

/** 把行合并为段落 */
export function groupParagraphs(pt: PageText, pageBounds: Rect4): PageParagraphs {
  const { lines, styles } = pt
  const groups: PLine[][] = []
  for (const line of lines) {
    const g = groups[groups.length - 1]
    if (g && continues(g, line)) g.push(line)
    else groups.push([line])
  }
  // 页面正文范围（用于判断单行段落的对齐方式）
  const textLeft = Math.min(...lines.map((l) => l.bbox[0]), pageBounds[2])
  const textRight = Math.max(...lines.map((l) => l.bbox[2]), pageBounds[0])
  const paragraphs = groups.map((g, id) => buildParagraph(id, g, pt, textLeft, textRight))
  return { styles, paragraphs, obstacles: [...pt.vectors, ...pt.images] }
}

function continues(g: PLine[], line: PLine): boolean {
  const prev = g[g.length - 1]
  const size = prev.size
  if (Math.abs(line.size - size) > size * 0.15) return false
  const gap = line.baseline - prev.baseline
  if (gap <= size * 0.5 || gap > size * 2.4) return false
  if (g.length >= 2) {
    const pitch = g[1].baseline - g[0].baseline
    if (Math.abs(gap - pitch) > size * 0.25) return false
  }
  const left = g.length >= 2 ? Math.min(...g.slice(1).map((l) => l.bbox[0])) : prev.bbox[0]
  // 续行应从段落左边界开始（第一行可以有缩进）
  if (g.length >= 2) {
    if (Math.abs(line.bbox[0] - left) > size * 0.6) return false
  } else if (line.bbox[0] > prev.bbox[0] + size * 0.6 || line.bbox[0] < prev.bbox[0] - size * 4.5) {
    return false
  }
  // 上一行应该排满（否则上一行就是段落最后一行）
  const right = Math.max(...g.map((l) => l.bbox[2]), line.bbox[2])
  if (prev.bbox[2] < right - size * 1.5) return false
  // 下一行必须从上一行范围内开始（排除相邻栏）
  if (line.bbox[0] > prev.bbox[2] - size) return false
  return true
}

function buildParagraph(id: number, lines: PLine[], pt: PageText, textLeft: number, textRight: number): Paragraph {
  const bbox: Rect4 = [Infinity, Infinity, -Infinity, -Infinity]
  for (const l of lines) {
    bbox[0] = Math.min(bbox[0], l.bbox[0])
    bbox[1] = Math.min(bbox[1], l.bbox[1])
    bbox[2] = Math.max(bbox[2], l.bbox[2])
    bbox[3] = Math.max(bbox[3], l.bbox[3])
  }
  let text = ""
  const textStyles: number[] = []
  lines.forEach((l, i) => {
    if (i > 0) {
      const prevLast = lines[i - 1].chars[lines[i - 1].chars.length - 1]
      if (isAsciiWord(prevLast.c) && isAsciiWord(l.chars[0].c)) {
        text += " "
        textStyles.push(prevLast.style)
      }
    }
    for (const ch of l.chars) {
      for (const cp of ch.c) {
        text += cp
        textStyles.push(ch.style) // 按码点对应，与 [...text] 一一对应
      }
    }
  })
  const size = median(lines.map((l) => l.size))
  const pitch = lines.length >= 2 ? (lines[lines.length - 1].baseline - lines[0].baseline) / (lines.length - 1) : size * 1.5

  let align: Align = "left"
  let cell = false
  let left: number
  let right: number
  let firstIndent = 0
  if (lines.length >= 2) {
    left = Math.min(...lines.slice(1).map((l) => l.bbox[0]))
    right = Math.max(...lines.map((l) => l.bbox[2]))
    firstIndent = Math.max(0, lines[0].bbox[0] - left)
    const body = lines.slice(0, -1)
    const centers = lines.map((l) => (l.bbox[0] + l.bbox[2]) / 2)
    if (body.every((l) => Math.abs(l.bbox[2] - right) < size * 0.3)) align = "justify"
    else if (centers.every((c) => Math.abs(c - centers[0]) < 1.5) && lines.some((l) => Math.abs(l.bbox[0] - left) > size)) align = "center"
  } else {
    const l = lines[0]
    const mid = (l.bbox[0] + l.bbox[2]) / 2
    // 单行段落：可用宽度扩展到页面正文范围，但遇到竖线（表格框线）或色块边缘就停下
    const lim = horizontalLimits(l, pt.vectors, textLeft, textRight)
    if (lim.boundedL && lim.boundedR) {
      // 表格单元格：对齐方式按单元格判断
      cell = true
      const lpad = l.bbox[0] - lim.left
      const rpad = lim.right - l.bbox[2]
      if (Math.abs(lpad - rpad) < Math.max(2, (lim.right - lim.left) * 0.08) && lpad > 2) {
        align = "center"
        const half = Math.min(mid - lim.left, lim.right - mid) - 1
        left = mid - half
        right = mid + half
      } else if (rpad < lpad) {
        align = "right"
        left = lim.left + 1
        right = l.bbox[2]
      } else {
        left = l.bbox[0]
        right = lim.right - 1
      }
    } else if (Math.abs(mid - (textLeft + textRight) / 2) < 3 && l.bbox[0] - textLeft > size * 2) {
      align = "center"
      const half = Math.min(mid - lim.left, lim.right - mid)
      left = mid - half
      right = mid + half
    } else if (Math.abs(l.bbox[2] - textRight) < 3 && l.bbox[0] - textLeft > size * 4) {
      align = "right"
      left = lim.left
      right = l.bbox[2]
    } else {
      left = l.bbox[0]
      right = Math.max(lim.right, l.bbox[2])
    }
  }
  return { id, lines, bbox, text, textStyles, align, left, right, firstIndent, pitch, size, cell }
}

function horizontalLimits(l: PLine, vectors: Rect4[], textLeft: number, textRight: number) {
  // 先找离文字最近的左右竖线；没有竖线的一侧退回到页面正文范围
  let ruleL = -Infinity
  let ruleR = Infinity
  for (const x of verticalRules(vectors, l.bbox[1], l.bbox[3])) {
    if (x >= l.bbox[2] - 1 && x < ruleR) ruleR = x
    if (x <= l.bbox[0] + 1 && x > ruleL) ruleL = x
  }
  const boundedL = ruleL > -Infinity
  const boundedR = ruleR < Infinity
  const left = boundedL ? ruleL + 1 : Math.min(textLeft, l.bbox[0])
  const right = boundedR ? ruleR - 1 : Math.max(textRight, l.bbox[2])
  return { left, right, boundedL, boundedR }
}
