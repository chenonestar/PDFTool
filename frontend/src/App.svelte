<script lang="ts">
  import { onMount } from "svelte"
  import { pickPDF, pickSavePath, readFile, saveFile, setTitle, startupFiles } from "./lib/backend"
  import { createEngine } from "./lib/engine"
  import Page from "./lib/Page.svelte"
  import ParaEditor from "./lib/ParaEditor.svelte"
  import type { EditTarget, Rect4 } from "./lib/types"

  const engine = createEngine()

  interface Doc {
    id: number
    path: string
    name: string
    bounds: Rect4[]
  }
  let doc: Doc | null = $state(null)
  let zoom = $state(1.25)
  let versions: number[] = $state([])
  let editMode = $state(true)
  let editing: EditTarget | null = $state(null)
  let busy = $state(false)
  let hist = $state({ canUndo: false, canRedo: false, dirty: false })
  let status = $state("")
  let warn = $state("")
  let statusSeq = $state(0) // 每次更新状态栏都 +1，方便自动化测试等待
  let pw: { resolve: (v: string | null) => void; error: string } | null = $state(null)
  let pwValue = $state("")

  const baseName = (p: string) => p.split(/[\\/]/).pop() || p

  $effect(() => {
    setTitle(doc ? `${hist.dirty ? "● " : ""}${doc.name} - PDFTool` : "PDFTool")
  })

  function say(msg: string, warning = "") {
    status = msg
    warn = warning
    statusSeq++
  }

  function askPassword(error = ""): Promise<string | null> {
    pwValue = ""
    return new Promise((resolve) => (pw = { resolve, error }))
  }

  async function open(path?: string | null) {
    path = path ?? (await pickPDF())
    if (!path) return
    if (doc && hist.dirty && !confirm(`「${doc.name}」有未保存的修改，确定放弃并打开其他文件？`)) return
    try {
      busy = true
      say("正在打开…")
      const bytes = await readFile(path)
      const t0 = performance.now()
      const { id, needsPassword } = await engine.open(bytes)
      if (needsPassword) {
        let err = ""
        for (;;) {
          const p = await askPassword(err)
          if (p === null) {
            await engine.close(id)
            say("已取消")
            return
          }
          if (await engine.authenticate(id, p)) break
          err = "密码不正确，请重试"
        }
      }
      const info = await engine.info(id)
      if (doc) await engine.close(doc.id)
      editing = null
      doc = { id, path, name: baseName(path), bounds: info.bounds }
      versions = info.bounds.map(() => 0)
      hist = { canUndo: info.canUndo, canRedo: info.canRedo, dirty: info.dirty }
      say(`已打开 ${info.pages} 页（${Math.round(performance.now() - t0)} ms）`)
    } catch (e) {
      say("", (e as Error).message)
    } finally {
      busy = false
    }
  }

  function bump(page?: number) {
    versions = versions.map((v, i) => (page === undefined || i === page ? v + 1 : v))
  }

  async function applyEdit(text: string) {
    if (!doc || !editing) return
    const t = editing
    busy = true
    try {
      const t0 = performance.now()
      const r = await engine.edit(doc.id, t.page, t.para.id, text)
      hist = { canUndo: r.canUndo, canRedo: r.canRedo, dirty: r.dirty }
      editing = null
      bump(t.page)
      const notes: string[] = []
      const rep = r.report
      if (rep.overflow) notes.push(`文字排成 ${rep.lines} 行，超出原段落区域，可能与下方内容重叠`)
      if (rep.shiftBlocked) notes.push(rep.shiftBlocked)
      if (rep.shrink < 1) notes.push(`单元格放不下，字号已缩小到 ${Math.round(rep.shrink * 100)}%`)
      if (rep.missingChars) notes.push(`系统字体中找不到「${rep.missingChars}」，已省略`)
      const fb = rep.fonts.filter((f) => f.fallbackChars).map((f) => `「${f.fallbackChars}」`)
      if (fb.length) notes.push(`原字体缺字 ${fb.join("")}，已用其他字体补上`)
      const sub = rep.fonts.filter((f) => f.substituted).map((f) => `${f.style.font} → ${f.face}`)
      if (sub.length) notes.push(`字体已替换：${sub.join("，")}`)
      const moved = rep.moved ? `，下方 ${rep.moved} 段内容已${rep.movedBy > 0 ? "下移" : "上移"}` : ""
      say(`已修改（${Math.round(performance.now() - t0)} ms${moved}），字体：${[...new Set(rep.fonts.map((f) => f.face))].join("、")}`, notes.join("；"))
    } catch (e) {
      say("", "修改失败：" + (e as Error).message)
    } finally {
      busy = false
    }
  }

  async function history(kind: "undo" | "redo") {
    if (!doc || busy) return
    editing = null
    const r = kind === "undo" ? await engine.undo(doc.id) : await engine.redo(doc.id)
    hist = r
    bump()
    say(kind === "undo" ? "已撤销" : "已重做")
  }

  async function save(as = false) {
    if (!doc || busy) return
    let path = doc.path
    if (as) {
      const p = await pickSavePath(doc.name)
      if (!p) return
      path = p
    }
    busy = true
    try {
      const t0 = performance.now()
      const r = await engine.save(doc.id)
      const res = await saveFile(path, r.bytes)
      hist = { canUndo: r.canUndo, canRedo: r.canRedo, dirty: r.dirty }
      doc.path = path
      doc.name = baseName(path)
      say(`已保存（${Math.round(performance.now() - t0)} ms，${(r.bytes.length / 1024).toFixed(0)} KB）${res.backup ? "，原文件已备份到 " + res.backup : ""}`)
    } catch (e) {
      say("", (e as Error).message)
    } finally {
      busy = false
    }
  }

  function setZoom(z: number) {
    zoom = Math.min(4, Math.max(0.25, Math.round(z * 100) / 100))
  }

  function onkey(e: KeyboardEvent) {
    const mod = e.ctrlKey || e.metaKey
    if (!mod) return
    const k = e.key.toLowerCase()
    if (k === "o") open()
    else if (k === "s") save(e.shiftKey)
    else if (k === "z" && !e.shiftKey) history("undo")
    else if (k === "y" || (k === "z" && e.shiftKey)) history("redo")
    else if (k === "=" || k === "+") setZoom(zoom + 0.25)
    else if (k === "-") setZoom(zoom - 0.25)
    else return
    e.preventDefault()
  }

  onMount(() => {
    const q = new URLSearchParams(location.search).get("open")
    ;(q ? Promise.resolve([q]) : startupFiles()).then((files) => {
      if (files.length) open(files[0])
    })
    const before = (e: BeforeUnloadEvent) => {
      if (hist.dirty) e.preventDefault()
    }
    window.addEventListener("beforeunload", before)
    return () => window.removeEventListener("beforeunload", before)
  })
</script>

<svelte:window onkeydown={onkey} />

<div class="app">
  <header class="toolbar">
    <div class="brand">PDFTool</div>
    <button onclick={() => open()} disabled={busy} title="打开 (Ctrl+O)">打开</button>
    <button onclick={() => save()} disabled={!doc || busy || !hist.dirty} title="保存 (Ctrl+S)" data-testid="save">保存</button>
    <button onclick={() => save(true)} disabled={!doc || busy} title="另存为 (Ctrl+Shift+S)">另存为</button>
    <span class="sep"></span>
    <button onclick={() => history("undo")} disabled={!hist.canUndo || busy} title="撤销 (Ctrl+Z)" data-testid="undo">撤销</button>
    <button onclick={() => history("redo")} disabled={!hist.canRedo || busy} title="重做 (Ctrl+Y)" data-testid="redo">重做</button>
    <span class="sep"></span>
    <button onclick={() => setZoom(zoom - 0.25)} disabled={!doc} title="缩小 (Ctrl+-)">−</button>
    <span class="zoom">{Math.round(zoom * 100)}%</span>
    <button onclick={() => setZoom(zoom + 0.25)} disabled={!doc} title="放大 (Ctrl+=)">+</button>
    <span class="sep"></span>
    <label class="toggle" title="开启后，点击页面上的文字段落即可修改">
      <input type="checkbox" bind:checked={editMode} onchange={() => (editing = null)} />
      编辑文字
    </label>
    {#if doc}<span class="docname">{hist.dirty ? "● " : ""}{doc.name}</span>{/if}
  </header>

  <main class="viewer">
    {#if doc}
      {#each doc.bounds as b, i (i)}
        <div class="page-wrap">
          <Page {engine} docId={doc.id} index={i} bounds={b} {zoom} version={versions[i]} {editMode} {editing} onpick={(t) => (editing = t)} />
          {#if editing && editing.page === i}
            <div class="overlay" style="width:{(b[2] - b[0]) * zoom}px">
              {#key editing.para.id}
                <ParaEditor target={editing} bounds={b} {zoom} {busy} onapply={applyEdit} oncancel={() => (editing = null)} />
              {/key}
            </div>
          {/if}
        </div>
      {/each}
    {:else}
      <div class="empty">
        <h1>PDFTool</h1>
        <p>打开一个 PDF，开启"编辑文字"后点击段落即可直接修改。</p>
        <button class="primary" onclick={() => open()}>打开 PDF</button>
        <p class="keys">Ctrl+O 打开 · Ctrl+S 保存 · Ctrl+Z 撤销 · Ctrl+Y 重做</p>
      </div>
    {/if}
  </main>

  <footer class="statusbar" data-testid="status" data-seq={statusSeq}>
    {#if warn}<span class="warn" data-testid="warn">⚠ {warn}</span>{/if}
    <span>{status}</span>
  </footer>
</div>

{#if pw}
  <div class="modal-bg">
    <form
      class="modal"
      onsubmit={(e) => {
        e.preventDefault()
        pw!.resolve(pwValue)
        pw = null
      }}
    >
      <h3>这个文件有密码保护</h3>
      <!-- svelte-ignore a11y_autofocus -->
      <input type="password" bind:value={pwValue} placeholder="请输入打开密码" autofocus data-testid="password" />
      {#if pw.error}<p class="err">{pw.error}</p>{/if}
      <div class="row">
        <button
          type="button"
          class="ghost"
          onclick={() => {
            pw!.resolve(null)
            pw = null
          }}>取消</button
        >
        <button type="submit" class="primary">打开</button>
      </div>
    </form>
  </div>
{/if}

<style>
  .app {
    display: grid;
    grid-template-rows: auto 1fr auto;
    height: 100vh;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 10px;
    background: var(--panel);
    border-bottom: 1px solid var(--line);
  }
  .brand {
    font-weight: 700;
    color: var(--brand);
    margin-right: 10px;
    letter-spacing: 0.5px;
  }
  .sep {
    width: 1px;
    height: 20px;
    background: var(--line);
    margin: 0 6px;
  }
  .zoom {
    min-width: 46px;
    text-align: center;
    font-variant-numeric: tabular-nums;
    font-size: 13px;
  }
  .toggle {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 13px;
    cursor: pointer;
    user-select: none;
  }
  .docname {
    margin-left: auto;
    color: var(--muted);
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .viewer {
    overflow: auto;
    background: var(--canvas);
    padding: 20px 16px;
  }
  .page-wrap {
    position: relative;
    width: fit-content;
    margin: 0 auto;
  }
  .overlay {
    position: absolute;
    top: 0;
    left: 0;
    height: 0;
  }
  .empty {
    text-align: center;
    margin-top: 18vh;
    color: var(--muted);
  }
  .empty h1 {
    color: var(--brand);
    margin-bottom: 4px;
  }
  .keys {
    font-size: 12px;
    margin-top: 18px;
  }
  .statusbar {
    display: flex;
    gap: 14px;
    align-items: center;
    padding: 4px 12px;
    font-size: 12px;
    min-height: 26px;
    background: var(--panel);
    border-top: 1px solid var(--line);
    color: var(--muted);
  }
  .warn {
    color: var(--warn);
  }
  .modal-bg {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.3);
    display: grid;
    place-items: center;
    z-index: 100;
  }
  .modal {
    background: var(--bg);
    padding: 20px 22px;
    border-radius: 8px;
    width: 320px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
  }
  .modal h3 {
    margin: 0 0 12px;
    font-size: 15px;
  }
  .modal input {
    width: 100%;
    box-sizing: border-box;
    padding: 6px 8px;
    border: 1px solid var(--line);
    border-radius: 4px;
    font-size: 14px;
  }
  .err {
    color: var(--warn);
    font-size: 13px;
    margin: 8px 0 0;
  }
  .row {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 16px;
  }
</style>
