// 界面线程访问 PDF 引擎 Worker 的 RPC 封装
import type { EngineMethods } from "../engine/worker.ts"

type Async<F> = F extends (...a: infer A) => infer R ? (...a: A) => Promise<Awaited<R>> : never
export type Engine = { [K in keyof EngineMethods]: Async<EngineMethods[K]> }

export function createEngine(): Engine {
  const worker = new Worker(new URL("../engine/worker.ts", import.meta.url), { type: "module" })
  let seq = 0
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  // Worker 里 mupdf 用顶层 await 加载 WASM，加载完成前发出的消息会丢失，所以等它报告 ready 再发
  let markReady: () => void
  const ready = new Promise<void>((r) => (markReady = r))
  worker.onmessage = (e) => {
    if (e.data?.ready) return markReady()
    const { seq: s, result, error } = e.data
    const p = pending.get(s)
    if (!p) return
    pending.delete(s)
    if (error) p.reject(new Error(error))
    else p.resolve(result)
  }
  worker.onerror = (e) => console.error("engine worker error", e.message)
  return new Proxy({} as Engine, {
    get(_t, method: string) {
      return (...args: unknown[]) =>
        ready.then(
          () =>
            new Promise((resolve, reject) => {
              const s = ++seq
              pending.set(s, { resolve, reject })
              const transfer = args.filter((a): a is ArrayBuffer => a instanceof ArrayBuffer)
              worker.postMessage({ seq: s, method, args }, transfer)
            }),
        )
    },
  })
}
