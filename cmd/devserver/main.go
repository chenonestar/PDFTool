// devserver 在非 Windows 环境下用普通浏览器调试和自动化测试前端：
// 提供与 Wails AssetServer 相同的 /api/ 接口，并托管 frontend/dist。
package main

import (
	"flag"
	"log"
	"net/http"
	"strings"

	"pdftool/internal/backend"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:34115", "监听地址（只监听本机）")
	dist := flag.String("dist", "frontend/dist", "前端构建目录")
	data := flag.String("data", "build/devdata", "数据目录")
	fonts := flag.String("fonts", "", "字体目录，逗号分隔；默认用系统字体目录")
	flag.Parse()

	store, err := backend.NewStore(*data)
	if err != nil {
		log.Fatal(err)
	}
	dirs := backend.DefaultFontDirs()
	if *fonts != "" {
		dirs = strings.Split(*fonts, ",")
	}
	api := &backend.Server{Store: store, Fonts: &backend.FontIndex{Dirs: dirs}, StartupFiles: flag.Args()}
	files := http.FileServer(http.Dir(*dist))
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			api.ServeHTTP(w, r)
			return
		}
		files.ServeHTTP(w, r)
	})
	log.Printf("devserver: http://%s", *addr)
	log.Fatal(http.ListenAndServe(*addr, nil))
}
