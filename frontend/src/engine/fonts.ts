// 字体匹配：把 PDF 里的字体名对应到系统字体；缺字时回退。
import * as mupdf from "mupdf"
import type { CharStyle, FontFace } from "./types.ts"

export interface FontProvider {
  list(): Promise<FontFace[]>
  load(id: string): Promise<Uint8Array>
}

const norm = (s: string) =>
  s
    .replace(/^[A-Z]{6}\+/, "")
    .toLowerCase()
    .replace(/[\s\-_,.]/g, "")
    .replace(/(regular|bold|italic|oblique|psmt|mt|std|pro)+$/g, "")

// Windows 常见中文字体的别名（PDF 中可能出现英文名、中文名或 GB2312 后缀名）
const ALIASES: Record<string, string[]> = {
  simsun: ["宋体", "simsun", "nsimsun", "新宋体", "songti", "宋体gb2312"],
  simhei: ["黑体", "simhei", "heiti"],
  microsoftyahei: ["微软雅黑", "microsoftyahei", "microsoftyaheiui", "msyh", "yahei"],
  kaiti: ["楷体", "kaiti", "楷体gb2312", "kaitigb2312", "stkaiti", "华文楷体"],
  fangsong: ["仿宋", "fangsong", "仿宋gb2312", "fangsonggb2312", "stfangsong", "华文仿宋"],
  dengxian: ["等线", "dengxian"],
}

const SERIF_PREFS = ["simsun", "nsimsun", "notoserifcjksc", "sourcehanserifsc", "arplumingcn", "umingcn"]
const SANS_PREFS = ["microsoftyahei", "dengxian", "simhei", "notosanscjksc", "sourcehansanssc", "wenquanyizenhei"]
const KAI_PREFS = ["kaiti", "stkaiti", "arplukaicn", "ukaicn"]

export class FontResolver {
  private faces: FontFace[] = []
  private keys = new Map<string, FontFace>() // 规范化名称 → 字体
  private fontCache = new Map<string, Promise<mupdf.Font>>()

  private provider: FontProvider

  constructor(provider: FontProvider) {
    this.provider = provider
  }

  async init() {
    this.faces = await this.provider.list()
    for (const f of this.faces) {
      for (const n of [f.psName, f.family, f.familyZh, f.full, f.fullZh]) {
        if (!n) continue
        const k = norm(n)
        // 同名时优先常规体
        const prev = this.keys.get(k)
        if (!prev || (prev.bold && !f.bold)) this.keys.set(k, f)
      }
    }
  }

  get count() {
    return this.faces.length
  }

  private byKey(k: string): FontFace | undefined {
    return this.keys.get(k)
  }

  /** 为原字体名找系统字体；找不到返回 undefined */
  match(pdfName: string): FontFace | undefined {
    const n = norm(pdfName)
    if (!n) return undefined
    const direct = this.byKey(n)
    if (direct) return direct
    for (const [canon, alias] of Object.entries(ALIASES)) {
      if (canon === n || alias.some((a) => norm(a) === n)) {
        for (const a of [canon, ...alias]) {
          const f = this.byKey(norm(a))
          if (f) return f
        }
      }
    }
    if (n.length >= 5) {
      for (const [k, f] of this.keys) if (k.includes(n) || (k.length >= 5 && n.includes(k))) return f
    }
    return undefined
  }

  /** 找同一家族的粗体 */
  boldOf(face: FontFace): FontFace | undefined {
    if (face.bold) return face
    return this.faces.find((f) => f.bold && !f.italic && f.family === face.family && f.outline === face.outline)
  }

  /**
   * 选择写入用的字体：优先与原字体同名的系统字体；
   * 同名字体是 CFF 轮廓时换成 TrueType 的相近字体（避免整个字体被嵌入）。
   */
  pick(style: CharStyle): { face: FontFace | undefined; substituted: boolean } {
    const m = this.match(style.font)
    if (m && m.outline !== "cff") return { face: m, substituted: false }
    const chain = this.fallbackChain(style)
    const tt = chain.find((f) => f.outline !== "cff")
    return { face: tt ?? m ?? chain[0], substituted: true }
  }

  fallbackChain(style: CharStyle): FontFace[] {
    const n = norm(style.font)
    const kai = /kai|楷/.test(n)
    const serifName = /song|ming|serif|宋|明|fang|仿/.test(n)
    const sansName = /hei|gothic|sans|yahei|黑|雅黑|dengxian/.test(n)
    const serif = serifName || (!sansName && style.serif)
    const prefs = kai ? [...KAI_PREFS, ...SERIF_PREFS, ...SANS_PREFS] : serif ? [...SERIF_PREFS, ...SANS_PREFS] : [...SANS_PREFS, ...SERIF_PREFS]
    const out: FontFace[] = []
    for (const p of prefs) {
      const f = this.byKey(p) || [...this.keys.entries()].find(([k]) => k.includes(p))?.[1]
      if (f && f.cjk && !out.includes(f)) out.push(f)
    }
    for (const f of this.faces) if (f.cjk && !f.bold && !out.includes(f)) out.push(f)
    // MuPDF 无法对 CFF（OpenType/PostScript 轮廓）字体做子集化，会整个嵌入导致文件巨大，优先 TrueType
    return [...out.filter((f) => f.outline !== "cff"), ...out.filter((f) => f.outline === "cff")]
  }

  load(face: FontFace): Promise<mupdf.Font> {
    let p = this.fontCache.get(face.id)
    if (!p) {
      p = this.provider.load(face.id).then((buf) => new mupdf.Font(face.psName || face.family, buf, face.index))
      this.fontCache.set(face.id, p)
    }
    return p
  }
}

/** 通过 Go 后端的 /api/fonts、/api/font 接口提供字体 */
export function httpFontProvider(base = ""): FontProvider {
  return {
    async list() {
      const r = await fetch(base + "/api/fonts")
      if (!r.ok) throw new Error("读取字体列表失败")
      return r.json()
    },
    async load(id) {
      const r = await fetch(base + "/api/font?id=" + encodeURIComponent(id))
      if (!r.ok) throw new Error("读取字体失败：" + id)
      return new Uint8Array(await r.arrayBuffer())
    },
  }
}
