export type Rect4 = [number, number, number, number] // x0, y0, x1, y1（页面坐标，y 向下）
export type RGB = [number, number, number]

export interface FontFace {
  id: string
  file: string
  index: number
  family: string
  familyZh: string
  full: string
  fullZh: string
  psName: string
  cjk: boolean
  outline: "truetype" | "cff"
  bold: boolean
  italic: boolean
  size: number
}

export interface CharStyle {
  font: string // PDF 中的字体名（去掉子集前缀）
  size: number
  color: RGB
  bold: boolean
  italic: boolean
  serif: boolean
}

export interface PChar {
  c: string
  style: number
  bbox: Rect4
  ox: number
  oy: number
}

export interface PLine {
  chars: PChar[]
  bbox: Rect4
  baseline: number
  size: number
}

export type Align = "left" | "justify" | "center" | "right"

export interface Paragraph {
  id: number
  lines: PLine[]
  bbox: Rect4
  text: string
  /** [...text] 中每个字符（码点）对应的样式索引 */
  textStyles: number[]
  align: Align
  left: number
  right: number
  firstIndent: number
  pitch: number // 行距（基线间距）
  size: number // 主要字号
  cell: boolean // 是否位于表格单元格内（左右都有框线）
}

export interface PageParagraphs {
  styles: CharStyle[]
  paragraphs: Paragraph[]
  /** 线条、色块、图片的范围（移动后续内容时不能越过它们） */
  obstacles: Rect4[]
}

export interface EditReport {
  lines: number
  overflow: boolean // 排版后超出原段落区域，且没能移动下方内容
  shrink: number // 表格单元格放不下时的缩小比例（1 表示没缩小）
  moved: number // 随之移动的下方段落数
  movedBy: number // 移动距离（正数向下）
  shiftBlocked: string // 下方内容需要移动但没能移动的原因
  fonts: { style: CharStyle; face: string; fallbackChars: string; substituted: boolean }[]
  synthBold: boolean
  /** 所有可用 TrueType 字体里都没有、因此被省略的字符 */
  missingChars: string
}
