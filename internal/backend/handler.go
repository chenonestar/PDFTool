package backend

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
)

// Server 把后端能力以 /api/ 下的 HTTP 接口暴露给前端。
// 二进制数据（PDF、字体）一律走这里，不经过 Wails 绑定的 base64 JSON。
type Server struct {
	Store        *Store
	Fonts        *FontIndex
	StartupFiles []string
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	switch r.URL.Path {
	case "/api/file":
		s.getFile(w, r)
	case "/api/save":
		s.save(w, r)
	case "/api/fonts":
		writeJSON(w, s.Fonts.Faces())
	case "/api/font":
		s.getFont(w, r)
	case "/api/startup":
		files := s.StartupFiles
		if files == nil {
			files = []string{}
		}
		writeJSON(w, files)
	default:
		http.NotFound(w, r)
	}
}

func (s *Server) getFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	p := r.URL.Query().Get("path")
	if p == "" {
		http.Error(w, "缺少 path", http.StatusBadRequest)
		return
	}
	f, err := os.Open(p)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		http.Error(w, "不是文件", http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/pdf")
	http.ServeContent(w, r, filepath.Base(p), st.ModTime(), f)
}

func (s *Server) save(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	p := r.URL.Query().Get("path")
	if p == "" {
		http.Error(w, "缺少 path", http.StatusBadRequest)
		return
	}
	defer r.Body.Close()
	backup, err := s.Store.Save(p, r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]string{"path": p, "backup": backup})
}

func (s *Server) getFont(w http.ResponseWriter, r *http.Request) {
	face, ok := s.Fonts.Lookup(r.URL.Query().Get("id"))
	if !ok {
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(face.File)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	defer f.Close()
	st, _ := f.Stat()
	w.Header().Set("Content-Type", "application/octet-stream")
	http.ServeContent(w, r, filepath.Base(face.File), st.ModTime(), f)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(v)
}
