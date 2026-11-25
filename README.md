# PDFTool

个人自用的 Windows 离线 PDF 编辑工具。需求见 [PDFTool-需求文档.html](PDFTool-需求文档.html)，阶段 0 结果见 [PDFTool-阶段0验证报告.html](PDFTool-阶段0验证报告.html)。

技术栈：Wails v2（Go）+ Svelte 5 + TypeScript + mupdf.js（WASM，运行在 Web Worker 中）。

## 目录

| 路径 | 内容 |
| --- | --- |
| `main.go`、`app.go`、`platform_*.go` | 程序入口：便携数据目录、WebView2 查找顺序、对话框绑定 |
| `internal/backend/` | Go 后端：安全保存与备份、系统字体枚举（含 TTC）、`/api/` 接口 |
| `cmd/devserver/` | 开发服务器：在 Linux/普通浏览器里提供同样的 `/api/`，用于调试和自动化测试 |
| `frontend/src/engine/` | PDF 引擎（Worker）：段落识别、断行、字体匹配、段落编辑、保存 |
| `frontend/src/lib/`、`App.svelte` | 界面 |
| `testdata/gen_samples.py` | 生成测试样本（输出到 `testdata/samples/`，不入库） |

## 构建 Windows 版

在 Windows 上（需要 Go 1.24+、Node 22、Wails CLI v2.17.1）：

```
go install github.com/wailsapp/wails/v2/cmd/wails@v2.17.1
wails build -webview2 error -skipbindings -trimpath
```

输出 `build/bin/PDFTool.exe`。也可以在 Linux 上交叉编译：加 `-platform windows/amd64`。
每次推送后 GitHub Actions 也会构建一份，可在 Actions 页面的 `PDFTool-windows-amd64` 产物中下载。

## 开发与测试（Linux）

```
cd frontend && npm install && npm run build && cd ..
go build -o build/devserver ./cmd/devserver && ./build/devserver    # http://127.0.0.1:34115
python3 testdata/gen_samples.py                                     # 生成样本
cd frontend
npm test            # 断行单元测试
npm run test:edit   # 引擎端到端：编辑 / 撤销 / 保存 / 重新打开（需先启动 devserver）
npm run test:e2e    # 浏览器端到端（Playwright）
```

`go test ./internal/...` 运行后端测试。

## 许可

MuPDF（mupdf.js）为 AGPL 许可，本项目仅个人自用、不分发。
