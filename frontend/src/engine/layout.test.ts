import assert from "node:assert/strict"
import { test } from "node:test"
import { layoutParagraph, justifySpacing, NO_LINE_START } from "./layout.ts"

const chars = (s: string) => [...s].map((ch) => ({ ch, style: 0 }))
// CJK 宽 10，西文/数字/空格宽 5
const measure = (ch: string) => (/[\x00-\x7f]/.test(ch) ? 5 : 10)
const text = (l: { chars: { ch: string }[] }) => l.chars.map((c) => c.ch).join("")

test("中文按字断行", () => {
  const lines = layoutParagraph(chars("一二三四五六七八九十"), measure, 40)
  assert.deepEqual(lines.map(text), ["一二三四", "五六七八", "九十"])
  assert.equal(lines[2].hard, true)
  assert.equal(lines[0].hard, false)
})

test("首行缩进", () => {
  const lines = layoutParagraph(chars("一二三四五六七八"), measure, 40, 20)
  assert.deepEqual(lines.map(text), ["一二", "三四五六", "七八"])
})

test("避头：句号不出现在行首，悬挂在行尾", () => {
  const lines = layoutParagraph(chars("一二三四。五六"), measure, 40)
  assert.deepEqual(lines.map(text), ["一二三四。", "五六"])
  for (const l of lines) assert.ok(!NO_LINE_START.has(l.chars[0].ch))
})

test("避尾：左括号不出现在行尾", () => {
  const lines = layoutParagraph(chars("一二三（四五）"), measure, 40)
  assert.deepEqual(lines.map(text), ["一二三", "（四五）"])
})

test("西文单词不拆开", () => {
  const lines = layoutParagraph(chars("中文Windows11"), measure, 50)
  assert.deepEqual(lines.map(text), ["中文", "Windows11"])
})

test("超长单词按字符拆开", () => {
  const lines = layoutParagraph(chars("abcdefghijkl"), measure, 30)
  assert.deepEqual(lines.map(text), ["abcdef", "ghijkl"])
})

test("空格处断行且行首行尾空格被去掉", () => {
  const lines = layoutParagraph(chars("hello world again"), measure, 30)
  assert.deepEqual(lines.map(text), ["hello", "world", "again"])
})

test("硬换行", () => {
  const lines = layoutParagraph(chars("一二\n三四"), measure, 100, 20)
  assert.deepEqual(lines.map(text), ["一二", "三四"])
  assert.equal(lines[0].hard, true)
  assert.equal(lines[1].indent, 20)
})

test("两端对齐间距", () => {
  const lines = layoutParagraph(chars("一二三四五六七"), measure, 45)
  assert.equal(text(lines[0]), "一二三四")
  assert.ok(Math.abs(justifySpacing(lines[0], 45) - 5 / 3) < 1e-9)
  assert.equal(justifySpacing(lines[1], 45), 0) // 最后一行不拉伸
})

test("段末标点悬挂后不多出空行", () => {
  const lines = layoutParagraph(chars("一二三四。"), measure, 40)
  assert.deepEqual(lines.map(text), ["一二三四。"])
  assert.equal(lines[0].hard, true)
})

test("空段落得到一个空行", () => {
  const lines = layoutParagraph([], measure, 40)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].chars.length, 0)
})
