<script lang="ts">
  import { onMount, tick } from "svelte"
  import type { EditTarget, Rect4 } from "./types"

  interface Props {
    target: EditTarget
    bounds: Rect4
    zoom: number
    busy: boolean
    onapply: (text: string) => void
    oncancel: () => void
  }
  let { target, bounds, zoom, busy, onapply, oncancel }: Props = $props()
  // 编辑器按段落 {#key} 重建，这里只需要初始值
  // svelte-ignore state_referenced_locally
  let text = $state(target.para.text)
  let ta: HTMLTextAreaElement

  const p = $derived(target.para)
  const s = $derived(target.style)
  const family = $derived(
    /kai|楷/i.test(s.font) ? '"KaiTi","楷体",serif' : s.serif || /song|ming|宋|serif/i.test(s.font) ? '"SimSun","宋体",serif' : '"Microsoft YaHei","微软雅黑",sans-serif',
  )
  const color = $derived(`rgb(${s.color.map((v) => Math.round(v * 255)).join(",")})`)
  const left = $derived((p.align === "center" || p.align === "right" ? Math.min(p.left, p.bbox[0]) : p.left) - bounds[0])
  const width = $derived(Math.max(p.right, p.bbox[2]) - bounds[0] - left)
  // 靠页面右侧的编辑框，按钮条向左展开，避免超出页面
  const flip = $derived(left > (bounds[2] - bounds[0]) / 2)

  // 编辑框背景取页面上段落周围的颜色（例如表格单元格的底色），保证白字等也能看清
  let bg = $state("#ffffff")
  function sampleBackground() {
    const canvas = document.querySelector<HTMLCanvasElement>(`[data-page="${target.page}"] canvas`)
    const ctx = canvas?.getContext("2d", { willReadFrequently: true })
    if (!canvas || !ctx || !canvas.width) return
    const k = canvas.width / (bounds[2] - bounds[0])
    const b = p.bbox
    // 在文字外围一圈取多个点，取出现最多的颜色（少数点落在表格线上也不影响）
    const pts: number[][] = []
    for (let i = 0; i <= 6; i++) {
      const x = b[0] + ((b[2] - b[0]) * i) / 6
      pts.push([x, b[1] - 1.2], [x, b[3] + 1.2])
    }
    for (const y of [b[1], (b[1] + b[3]) / 2, b[3]]) pts.push([b[0] - 1.2, y], [b[2] + 1.2, y])
    const count = new Map<string, number>()
    for (const [x, y] of pts) {
      const px = Math.round((x - bounds[0]) * k)
      const py = Math.round((y - bounds[1]) * k)
      if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) continue
      const d = ctx.getImageData(px, py, 1, 1).data
      const key = `${d[0]},${d[1]},${d[2]}`
      count.set(key, (count.get(key) ?? 0) + 1)
    }
    const best = [...count.entries()].sort((a, b) => b[1] - a[1])[0]
    if (!best) return
    const [r, g, bl] = best[0].split(",").map(Number)
    const lumBg = (0.299 * r + 0.587 * g + 0.114 * bl) / 255
    const lumText = 0.299 * s.color[0] + 0.587 * s.color[1] + 0.114 * s.color[2]
    // 背景和文字颜色太接近时还是用白底
    if (Math.abs(lumBg - lumText) > 0.3) bg = `rgb(${r},${g},${bl})`
  }

  const autosize = () => {
    if (p.cell) {
      // 表格单元格单行编辑：内容变长时编辑框跟着变宽（确定后会缩小字号放进单元格）
      ta.style.width = ""
      if (ta.scrollWidth > ta.clientWidth) ta.style.width = ta.scrollWidth + 8 + "px"
    }
    ta.style.height = "auto"
    ta.style.height = ta.scrollHeight + 2 + "px"
  }
  onMount(async () => {
    sampleBackground()
    await tick()
    autosize()
    ta.focus()
    ta.setSelectionRange(text.length, text.length)
  })

  function onkey(e: KeyboardEvent) {
    if (e.key === "Enter" && p.cell && !(e.ctrlKey || e.metaKey)) {
      // 单元格内容保持单行：回车直接确定
      e.preventDefault()
      onapply(text)
    } else if (e.key === "Escape") {
      e.preventDefault()
      oncancel()
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      onapply(text)
    }
    e.stopPropagation()
  }
</script>

<div class="editor" style="left:{left * zoom - 4}px;top:{(p.bbox[1] - bounds[1]) * zoom - 4}px;width:{width * zoom + 8}px">
  <textarea
    bind:this={ta}
    bind:value={text}
    oninput={autosize}
    onkeydown={onkey}
    disabled={busy}
    spellcheck="false"
    data-testid="para-editor"
    class:cell={p.cell}
    style="background:{bg};font-family:{family};font-size:{p.size * zoom}px;line-height:{p.pitch * zoom}px;text-indent:{p.align === 'left' || p.align === 'justify'
      ? p.firstIndent * zoom
      : 0}px;text-align:{p.align === 'justify' ? 'justify' : p.align};color:{color};font-weight:{s.bold ? 700 : 400}"
  ></textarea>
  <div class="bar" class:flip>
    <span class="hint">{p.cell ? "表格单元格" : `${p.lines} 行`} · {s.font} {s.size}pt{s.bold ? " 粗体" : ""}</span>
    <button class="ghost" onclick={oncancel} disabled={busy}>取消 <kbd>Esc</kbd></button>
    <button class="primary" onclick={() => onapply(text)} disabled={busy || text === p.text} data-testid="para-apply">
      {busy ? "正在写入…" : "确定"} <kbd>Ctrl+Enter</kbd>
    </button>
  </div>
</div>

<style>
  .editor {
    position: absolute;
    z-index: 10;
  }
  textarea {
    display: block;
    width: 100%;
    box-sizing: border-box;
    resize: none;
    overflow: hidden;
    padding: 3px;
    border: 1.5px solid var(--accent);
    border-radius: 3px;
    background: #fff;
    box-shadow: 0 0 0 4px rgba(31, 111, 235, 0.15);
    outline: none;
    word-break: break-all;
  }
  textarea.cell {
    white-space: pre;
    min-width: 100%;
  }
  .bar {
    width: max-content;
    min-width: 100%;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 6px;
    justify-content: flex-end;
    margin-top: 4px;
    padding: 4px;
    font-size: 12px;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
  }
  .hint {
    color: var(--muted);
    margin-right: auto;
    padding: 0 6px;
    white-space: nowrap;
  }
  .bar.flip {
    position: absolute;
    right: 0;
  }
  .bar button {
    white-space: nowrap;
  }
  kbd {
    font-family: inherit;
    font-size: 11px;
    opacity: 0.7;
  }
</style>
