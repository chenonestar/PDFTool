import fs from "node:fs"
import { EditorDoc } from "../src/engine/editor.ts"
import { FontResolver, httpFontProvider } from "../src/engine/fonts.ts"
const fonts = new FontResolver(httpFontProvider("http://127.0.0.1:34115"))
await fonts.init()
for (const f of process.argv.slice(2)) {
  const d = new EditorDoc(fs.readFileSync(f), fonts)
  if (d.needsPassword()) d.authenticate("1234")
  d.ready()
  const { styles, paragraphs } = d.paragraphs(0)
  console.log("==", f.split("/").pop(), "styles:", styles.map((s) => `${s.font}/${s.size}${s.bold ? "/B" : ""}`).join(", "))
  for (const p of paragraphs)
    console.log(`#${p.id} ${p.align.padEnd(7)} lines=${p.lines.length} L=${p.left.toFixed(0)} R=${p.right.toFixed(0)} ind=${p.firstIndent.toFixed(0)} | ${p.text.slice(0, 40)}${p.text.length > 40 ? "…" : ""}`)
}
