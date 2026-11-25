//go:build windows

package main

import (
	"os"
	"path/filepath"

	"github.com/wailsapp/go-webview2/webviewloader"
	"golang.org/x/sys/windows"
)

// findWebView2 先找系统安装的 WebView2；没有时找程序目录下的 webview2/。
// 返回值 browserPath 为空表示使用系统 WebView2。
func findWebView2(exeDir string) (browserPath string, ok bool) {
	if v, err := webviewloader.GetAvailableCoreWebView2BrowserVersionString(""); err == nil && v != "" {
		return "", true
	}
	local := filepath.Join(exeDir, "webview2")
	if st, err := os.Stat(local); err == nil && st.IsDir() {
		if v, err := webviewloader.GetAvailableCoreWebView2BrowserVersionString(local); err == nil && v != "" {
			return local, true
		}
	}
	return "", false
}

func fatal(title, msg string) {
	t, _ := windows.UTF16PtrFromString(title)
	m, _ := windows.UTF16PtrFromString(msg)
	windows.MessageBox(0, m, t, windows.MB_OK|windows.MB_ICONERROR)
}
