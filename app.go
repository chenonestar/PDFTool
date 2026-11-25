package main

import (
	"context"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App 提供原生对话框等少量控制类绑定。文件字节流不走这里。
type App struct {
	ctx context.Context
}

func NewApp() *App { return &App{} }

func (a *App) startup(ctx context.Context) { a.ctx = ctx }

var pdfFilter = []runtime.FileFilter{{DisplayName: "PDF 文件 (*.pdf)", Pattern: "*.pdf"}}

// OpenPDFDialog 打开文件对话框，可多选。
func (a *App) OpenPDFDialog() ([]string, error) {
	return runtime.OpenMultipleFilesDialog(a.ctx, runtime.OpenDialogOptions{
		Title:   "打开 PDF",
		Filters: pdfFilter,
	})
}

// SaveAsDialog 另存为对话框，返回空字符串表示取消。
func (a *App) SaveAsDialog(defaultName string) (string, error) {
	return runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           "另存为",
		DefaultFilename: defaultName,
		Filters:         pdfFilter,
	})
}

// SetTitle 设置窗口标题。
func (a *App) SetTitle(title string) { runtime.WindowSetTitle(a.ctx, title) }
