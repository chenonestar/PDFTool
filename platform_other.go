//go:build !windows

package main

import (
	"fmt"
	"os"
)

// 非 Windows 平台只用于开发编译检查，不作为发布目标。
func findWebView2(string) (string, bool) { return "", true }

func fatal(title, msg string) { fmt.Fprintf(os.Stderr, "%s: %s\n", title, msg) }
