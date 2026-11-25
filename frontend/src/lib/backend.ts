// Go 后端访问：二进制数据走 /api/（AssetServer Handler），对话框走 Wails 绑定。
// 在普通浏览器（开发服务器）里没有 Wails 绑定时退回到简单的输入框。

interface WailsApp {
  OpenPDFDialog(): Promise<string[] | null>
  SaveAsDialog(name: string): Promise<string>
  SetTitle(t: string): Promise<void>
}
const wails = (): WailsApp | undefined => (window as unknown as { go?: { main?: { App?: WailsApp } } }).go?.main?.App

export const inWails = () => !!wails()

export async function readFile(path: string): Promise<ArrayBuffer> {
  const r = await fetch("/api/file?path=" + encodeURIComponent(path))
  if (!r.ok) throw new Error(`无法打开文件：${await r.text()}`)
  return r.arrayBuffer()
}

export async function saveFile(path: string, bytes: Uint8Array): Promise<{ backup: string }> {
  const r = await fetch("/api/save?path=" + encodeURIComponent(path), { method: "POST", body: bytes as BodyInit })
  if (!r.ok) throw new Error(`保存失败：${await r.text()}`)
  return r.json()
}

export async function startupFiles(): Promise<string[]> {
  const r = await fetch("/api/startup")
  return r.ok ? r.json() : []
}

export async function pickPDF(): Promise<string | null> {
  const w = wails()
  if (w) {
    const files = await w.OpenPDFDialog()
    return files?.[0] ?? null
  }
  return prompt("输入 PDF 文件的完整路径（开发模式）")
}

export async function pickSavePath(defaultName: string): Promise<string | null> {
  const w = wails()
  if (w) return (await w.SaveAsDialog(defaultName)) || null
  return prompt("另存为：输入完整路径（开发模式）", defaultName)
}

export function setTitle(t: string) {
  document.title = t
  wails()?.SetTitle(t)
}
