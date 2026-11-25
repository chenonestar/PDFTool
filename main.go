package main

import (
	"embed"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"

	"pdftool/internal/backend"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	exeDir := programDir()

	// 便携性：所有数据都在程序目录下的 data/，不可写时提示并退出，不回退到 AppData。
	store, err := backend.NewStore(filepath.Join(exeDir, "data"))
	if err != nil {
		fatal("PDFTool 无法启动", "程序目录不可写，无法创建 data 文件夹。\n\n"+
			"请把 PDFTool 整个文件夹移动到可写的位置（例如 D:\\Tools\\PDFTool），不要放在 Program Files 下。\n\n详细信息："+err.Error())
		return
	}
	_, _ = store.CleanBackups()

	// WebView2 查找顺序：系统 → 程序目录下的 webview2/ → 提示退出。
	browserPath, ok := findWebView2(exeDir)
	if !ok {
		fatal("PDFTool 无法启动", "没有找到 Microsoft Edge WebView2 运行时。\n\n可以任选一种方式解决：\n"+
			"1. 安装 WebView2 Runtime（微软官网可下载）；\n"+
			"2. 把 WebView2 固定版本（Fixed Version）运行时解压到程序目录下的 webview2 文件夹。")
		return
	}

	api := &backend.Server{
		Store:        store,
		Fonts:        &backend.FontIndex{Dirs: backend.DefaultFontDirs()},
		StartupFiles: pdfArgs(os.Args[1:]),
	}
	app := NewApp()

	err = wails.Run(&options.App{
		Title:     "PDFTool",
		Width:     1280,
		Height:    860,
		MinWidth:  800,
		MinHeight: 560,
		AssetServer: &assetserver.Options{
			Assets: assets,
			Middleware: func(next http.Handler) http.Handler {
				return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if strings.HasPrefix(r.URL.Path, "/api/") {
						api.ServeHTTP(w, r)
						return
					}
					next.ServeHTTP(w, r)
				})
			},
		},
		BackgroundColour: &options.RGBA{R: 255, G: 255, B: 255, A: 1},
		OnStartup:        app.startup,
		Bind:             []interface{}{app},
		Windows: &windows.Options{
			WebviewUserDataPath: filepath.Join(store.DataDir, "webview"),
			WebviewBrowserPath:  browserPath,
		},
	})
	if err != nil {
		fatal("PDFTool 出错", err.Error())
	}
}

// programDir 返回 exe 所在目录（解析符号链接）。
func programDir() string {
	exe, err := os.Executable()
	if err != nil {
		return "."
	}
	if real, err := filepath.EvalSymlinks(exe); err == nil {
		exe = real
	}
	return filepath.Dir(exe)
}

func pdfArgs(args []string) []string {
	var out []string
	for _, a := range args {
		if strings.EqualFold(filepath.Ext(a), ".pdf") {
			if abs, err := filepath.Abs(a); err == nil {
				out = append(out, abs)
			}
		}
	}
	return out
}
