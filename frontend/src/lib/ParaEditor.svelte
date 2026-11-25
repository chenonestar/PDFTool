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

  const autosize = () => {
    ta.style.height = "auto"
    ta.style.height = ta.scrollHeight + 2 + "px"
  }
  onMount(async () => {
    await tick()
    autosize()
    ta.focus()
    ta.setSelectionRange(text.length, text.length)
  })

  function onkey(e: KeyboardEvent) {
    if (e.key === "Escape") {
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
    style="font-family:{family};font-size:{p.size * zoom}px;line-height:{p.pitch * zoom}px;text-indent:{p.align === 'left' || p.align === 'justify'
      ? p.firstIndent * zoom
      : 0}px;text-align:{p.align === 'justify' ? 'justify' : p.align};color:{color};font-weight:{s.bold ? 700 : 400}"
  ></textarea>
  <div class="bar">
    <span class="hint">{p.lines} 行 · {s.font} {s.size}pt{s.bold ? " 粗体" : ""}</span>
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
  .bar {
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
  }
  kbd {
    font-family: inherit;
    font-size: 11px;
    opacity: 0.7;
  }
</style>
