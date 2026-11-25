// 段落排版：按宽度断行，处理中文避头尾和西文单词。纯函数，不依赖 mupdf。

/** 不能出现在行首的字符（标点、右括号等） */
export const NO_LINE_START = new Set([..."，。、；：？！）】》」』〕〉｝”’…—–·%‰℃,.;:?!)]}>"])
/** 不能出现在行尾的字符（左括号、左引号等） */
export const NO_LINE_END = new Set([..."（【《「『〔〈｛“‘([{<￥$"])

export interface LayoutChar {
  ch: string
  style: number
}

export interface PlacedChar extends LayoutChar {
  x: number // 相对行起点的偏移（未两端对齐前）
  w: number
}

export interface LayoutLine {
  chars: PlacedChar[]
  width: number // 去掉行尾空格后的宽度
  hard: boolean // 是否以段落结束 / 硬换行结束（两端对齐时不拉伸）
  indent: number // 该行起点相对段落左边界的缩进
}

export type Measure = (ch: string, style: number) => number

const isSpace = (c: string) => c === " " || c === " " || c === "　" || c === "\t"
// 西文"单词"字符：连续时不在中间断行
const isWordChar = (c: string) => /[A-Za-z0-9À-ɏ'’\-_.,:;/%@#&+=*~^]/.test(c) && !NO_LINE_START.has(c) || /[A-Za-z0-9]/.test(c)

interface Unit {
  chars: LayoutChar[]
  width: number
  space: boolean
}

function toUnits(chars: LayoutChar[], measure: Measure): Unit[] {
  const units: Unit[] = []
  let word: Unit | null = null
  const flush = () => {
    if (word) units.push(word)
    word = null
  }
  for (const c of chars) {
    const w = measure(c.ch, c.style)
    if (isSpace(c.ch)) {
      flush()
      units.push({ chars: [c], width: w, space: true })
    } else if (/[A-Za-z0-9]/.test(c.ch) || (word && isWordChar(c.ch))) {
      if (!word) word = { chars: [], width: 0, space: false }
      word.chars.push(c)
      word.width += w
    } else {
      flush()
      units.push({ chars: [c], width: w, space: false })
    }
  }
  flush()
  return units
}

/**
 * 断行。text 中的 "\n" 为硬换行。
 * @param width 段落可用宽度
 * @param firstIndent 第一行（以及每个硬换行后的第一行）相对左边界的缩进
 */
export function layoutParagraph(chars: LayoutChar[], measure: Measure, width: number, firstIndent = 0): LayoutLine[] {
  const lines: LayoutLine[] = []
  // 按硬换行切段
  const segments: LayoutChar[][] = [[]]
  for (const c of chars) {
    if (c.ch === "\n") segments.push([])
    else if (c.ch !== "\r") segments[segments.length - 1].push(c)
  }
  for (const seg of segments) {
    const units = toUnits(seg, measure)
    let cur: Unit[] = []
    let curW = 0
    let indent = firstIndent
    const avail = () => width - indent
    const emit = (hard: boolean) => {
      // 去掉行首、行尾空格
      while (cur.length && cur[cur.length - 1].space) cur.pop()
      const placed: PlacedChar[] = []
      let x = 0
      for (const u of cur) {
        for (const c of u.chars) {
          const w = measure(c.ch, c.style)
          placed.push({ ...c, x, w })
          x += w
        }
      }
      lines.push({ chars: placed, width: x, hard, indent })
      cur = []
      curW = 0
      indent = 0
    }
    for (let i = 0; i < units.length; i++) {
      const u = units[i]
      if (u.space && cur.length === 0 && lines.length > 0 && !lines[lines.length - 1].hard) continue // 软换行后的行首空格
      if (curW + u.width <= avail() + 0.01 || cur.length === 0) {
        if (cur.length === 0 && !u.space && u.width > avail() && u.chars.length > 1) {
          // 超长单词：按字符拆开
          const pieces = u.chars.map((c) => ({ chars: [c], width: measure(c.ch, c.style), space: false }))
          units.splice(i, 1, ...pieces)
          i--
          continue
        }
        cur.push(u)
        curW += u.width
        continue
      }
      if (u.space) {
        // 行尾空格不占宽度，直接换行
        emit(false)
        continue
      }
      // u 放不下，需要换行。处理避头尾：
      // 1) u 是不能出现在行首的标点：允许它悬挂在本行行尾（最多超出一个标点宽度）
      const first = u.chars[0].ch
      if (NO_LINE_START.has(first) && u.chars.length === 1) {
        cur.push(u)
        curW += u.width
        emit(false)
        continue
      }
      // 2) 本行末尾是不能出现在行尾的字符：把它一起挪到下一行
      const carry: Unit[] = []
      while (cur.length > 1) {
        const last = cur[cur.length - 1]
        const lc = last.chars[last.chars.length - 1].ch
        if (last.space || !NO_LINE_END.has(lc)) break
        carry.unshift(cur.pop()!)
      }
      emit(false)
      for (const c of carry) {
        cur.push(c)
        curW += c.width
      }
      i--
    }
    emit(true)
  }
  return lines
}

/** 两端对齐时每个字符间隙需要增加的距离 */
export function justifySpacing(line: LayoutLine, width: number): number {
  const avail = width - line.indent
  if (line.hard || line.chars.length < 2 || line.width >= avail) return 0
  const extra = (avail - line.width) / (line.chars.length - 1)
  // 拉伸过大（例如只有几个字的行）时不拉伸
  const avgW = line.width / line.chars.length
  return extra > avgW * 1.5 ? 0 : extra
}
