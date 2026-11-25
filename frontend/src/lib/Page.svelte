<script lang="ts">
  import { onMount } from "svelte"
  import type { Engine } from "./engine"
  import type { CharStyle, EditTarget, ParaView, Rect4 } from "./types"

  interface Props {
    engine: Engine
    docId: number
    index: number
    bounds: Rect4
    zoom: number
    version: number
    editMode: boolean
    editing: EditTarget | null
    onpick: (t: EditTarget) => void
  }
  let { engine, docId, index, bounds, zoom, version, editMode, editing, onpick }: Props = $props()

  let el: HTMLDivElement
  let canvas: HTMLCanvasElement
  let visible = $state(false)
  let renderedKey = ""
  let paras: ParaView[] = $state([])
  let styles: CharStyle[] = $state([])
  let parasKey = ""

  const w = $derived((bounds[2] - bounds[0]) * zoom)
  const h = $derived((bounds[3] - bounds[1]) * zoom)

  onMount(() => {
    const io = new IntersectionObserver((es) => (visible = es[0].isIntersecting), { rootMargin: "600px 0px" })
    io.observe(el)
    return () => io.disconnect()
  })

  // 可见时按需渲染；缩放或内容变化后重新渲染
  $effect(() => {
    const key = `${zoom}|${version}`
    if (!visible || key === renderedKey) return
    renderedKey = key
    const dpr = window.devicePixelRatio || 1
    engine.render(docId, index, zoom * dpr).then((r) => {
      if (renderedKey !== key) return
      canvas.width = r.width
      canvas.height = r.height
      canvas.getContext("2d")!.putImageData(new ImageData(r.data as Uint8ClampedArray<ArrayBuffer>, r.width, r.height), 0, 0)
      canvas.dataset.rendered = key
    })
  })

  $effect(() => {
    const key = `${version}`
    if (!visible || !editMode || key === parasKey) return
    parasKey = key
    engine.paragraphs(docId, index).then((r) => {
      if (parasKey !== key) return
      paras = r.paragraphs
      styles = r.styles
    })
  })

  const box = (b: Rect4) =>
    `left:${(b[0] - bounds[0]) * zoom - 2}px;top:${(b[1] - bounds[1]) * zoom - 2}px;width:${(b[2] - b[0]) * zoom + 4}px;height:${(b[3] - b[1]) * zoom + 4}px`
</script>

<div class="page" bind:this={el} style="width:{w}px;height:{h}px" data-page={index}>
  <canvas bind:this={canvas} style="width:{w}px;height:{h}px"></canvas>
  {#if editMode}
    {#each paras as p (p.id)}
      {#if !(editing && editing.page === index && editing.para.id === p.id)}
        <button
          class="para"
          style={box(p.bbox)}
          title="点击编辑这段文字"
          data-para={p.id}
          onclick={() => onpick({ page: index, para: p, style: styles[p.style] })}
          aria-label={"编辑段落：" + p.text.slice(0, 20)}
        ></button>
      {/if}
    {/each}
  {/if}
</div>

<style>
  .page {
    position: relative;
    background: #fff;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18), 0 0 0 1px rgba(0, 0, 0, 0.04);
    margin: 0 auto 16px;
  }
  canvas {
    display: block;
  }
  .para {
    position: absolute;
    border: 1px dashed transparent;
    background: transparent;
    border-radius: 2px;
    padding: 0;
    cursor: text;
  }
  .para:hover {
    border-color: var(--accent);
    background: rgba(31, 111, 235, 0.06);
  }
</style>
