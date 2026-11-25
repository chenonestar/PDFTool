// PDF 引擎 Worker：所有 mupdf 操作都在这里执行，界面线程不卡。
import { EditorDoc } from "./editor.ts"
import { FontResolver, httpFontProvider } from "./fonts.ts"
import type { Rect4 } from "./types.ts"

const docs = new Map<number, EditorDoc>()
let nextId = 1
let fontsReady: Promise<FontResolver> | null = null
const fonts = () => {
  if (!fontsReady) {
    const r = new FontResolver(httpFontProvider(""))
    fontsReady = r.init().then(() => r)
  }
  return fontsReady
}

const state = (d: EditorDoc) => ({ canUndo: d.canUndo(), canRedo: d.canRedo(), dirty: d.dirty })
const get = (id: number) => {
  const d = docs.get(id)
  if (!d) throw new Error("文档已关闭")
  return d
}

const methods = {
  async open(bytes: ArrayBuffer) {
    const d = new EditorDoc(new Uint8Array(bytes), await fonts())
    const id = nextId++
    docs.set(id, d)
    const needsPassword = d.needsPassword()
    if (!needsPassword) d.ready()
    return { id, needsPassword }
  },
  authenticate(id: number, password: string) {
    const d = get(id)
    const ok = d.authenticate(password)
    if (ok) d.ready()
    return ok
  },
  info(id: number) {
    const d = get(id)
    const bounds: Rect4[] = []
    for (let i = 0; i < d.pageCount; i++) bounds.push(d.pageBounds(i))
    return { pages: d.pageCount, bounds, ...state(d) }
  },
  render(id: number, page: number, scale: number) {
    return get(id).render(page, scale)
  },
  paragraphs(id: number, page: number) {
    const { styles, paragraphs } = get(id).paragraphs(page)
    return {
      styles,
      paragraphs: paragraphs.map((p) => ({
        id: p.id,
        bbox: p.bbox,
        text: p.text,
        align: p.align,
        left: p.left,
        right: p.right,
        firstIndent: p.firstIndent,
        pitch: p.pitch,
        size: p.size,
        style: p.textStyles[0] ?? 0,
        lines: p.lines.length,
      })),
    }
  },
  async edit(id: number, page: number, paraId: number, text: string) {
    const d = get(id)
    const report = await d.editParagraph(page, paraId, text)
    return { report, ...state(d) }
  },
  undo(id: number) {
    const d = get(id)
    if (d.canUndo()) d.undo()
    return state(d)
  },
  redo(id: number) {
    const d = get(id)
    if (d.canRedo()) d.redo()
    return state(d)
  },
  save(id: number) {
    const d = get(id)
    const bytes = d.save()
    return { bytes, ...state(d) }
  },
  close(id: number) {
    docs.get(id)?.doc.destroy()
    docs.delete(id)
  },
}
export type EngineMethods = typeof methods

self.onmessage = async (e: MessageEvent) => {
  const { seq, method, args } = e.data as { seq: number; method: keyof typeof methods; args: unknown[] }
  try {
    const result = await (methods[method] as (...a: unknown[]) => unknown)(...args)
    const transfer: Transferable[] = []
    const r = result as { data?: Uint8ClampedArray; bytes?: Uint8Array } | undefined
    if (r?.data?.buffer) transfer.push(r.data.buffer as ArrayBuffer)
    if (r?.bytes?.buffer) transfer.push(r.bytes.buffer as ArrayBuffer)
    ;(self as unknown as Worker).postMessage({ seq, result }, transfer)
  } catch (err) {
    ;(self as unknown as Worker).postMessage({ seq, error: err instanceof Error ? err.message : String(err) })
  }
}
;(self as unknown as Worker).postMessage({ ready: true })
