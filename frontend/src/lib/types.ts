import type { CharStyle, EditReport, Rect4 } from "../engine/types.ts"
export type { CharStyle, EditReport, Rect4 }

export interface ParaView {
  id: number
  bbox: Rect4
  text: string
  align: "left" | "justify" | "center" | "right"
  left: number
  right: number
  firstIndent: number
  pitch: number
  size: number
  style: number
  lines: number
}

export interface EditTarget {
  page: number
  para: ParaView
  style: CharStyle
}
