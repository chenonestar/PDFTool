// Package backend 提供 PDFTool 的 Go 端能力：数据目录、文件读写与备份、系统字体。
// 通过 Handler 以 HTTP 形式暴露给前端（Wails AssetServer 或开发服务器）。
package backend

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Store 管理程序目录下的 data/。
type Store struct {
	DataDir    string
	BackupDays int

	mu       sync.Mutex
	backedUp map[string]bool // 本次运行中已备份过的文件（绝对路径，小写）
}

// NewStore 创建 data/ 及子目录，并检查是否可写。
func NewStore(dataDir string) (*Store, error) {
	if abs, err := filepath.Abs(dataDir); err == nil {
		dataDir = abs
	}
	for _, sub := range []string{"", "backup", "signatures", "stamps", "webview"} {
		if err := os.MkdirAll(filepath.Join(dataDir, sub), 0o755); err != nil {
			return nil, fmt.Errorf("无法创建数据目录 %s：%w", dataDir, err)
		}
	}
	probe := filepath.Join(dataDir, ".write-test")
	if err := os.WriteFile(probe, []byte("ok"), 0o644); err != nil {
		return nil, fmt.Errorf("数据目录不可写 %s：%w", dataDir, err)
	}
	_ = os.Remove(probe)
	return &Store{DataDir: dataDir, BackupDays: 30, backedUp: map[string]bool{}}, nil
}

func (s *Store) BackupDir() string { return filepath.Join(s.DataDir, "backup") }

// Save 安全写入：先写同目录临时文件，再替换原文件。
// 覆盖已存在的文件时，本次运行中第一次覆盖前先备份原文件。
func (s *Store) Save(path string, r io.Reader) (backup string, err error) {
	path, err = filepath.Abs(path)
	if err != nil {
		return "", err
	}
	if _, statErr := os.Stat(path); statErr == nil {
		key := strings.ToLower(path)
		s.mu.Lock()
		need := !s.backedUp[key]
		s.mu.Unlock()
		if need {
			if backup, err = s.backup(path); err != nil {
				return "", fmt.Errorf("备份失败，未保存：%w", err)
			}
			s.mu.Lock()
			s.backedUp[key] = true
			s.mu.Unlock()
		}
	}

	tmp, err := os.CreateTemp(filepath.Dir(path), ".pdftool-*.tmp")
	if err != nil {
		return backup, err
	}
	tmpName := tmp.Name()
	ok := false
	defer func() {
		if !ok {
			tmp.Close()
			os.Remove(tmpName)
		}
	}()
	if _, err = io.Copy(tmp, r); err != nil {
		return backup, err
	}
	if err = tmp.Sync(); err != nil {
		return backup, err
	}
	if err = tmp.Close(); err != nil {
		return backup, err
	}
	if err = os.Rename(tmpName, path); err != nil {
		return backup, err
	}
	ok = true
	return backup, nil
}

func (s *Store) backup(path string) (string, error) {
	base := filepath.Base(path)
	ext := filepath.Ext(base)
	name := strings.TrimSuffix(base, ext) + "_" + time.Now().Format("20060102-150405") + ext
	dst := filepath.Join(s.BackupDir(), name)
	in, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return "", err
	}
	if _, err = io.Copy(out, in); err != nil {
		out.Close()
		return "", err
	}
	return dst, out.Close()
}

// CleanBackups 删除超过保留天数的备份。
func (s *Store) CleanBackups() (removed int, err error) {
	if s.BackupDays <= 0 {
		return 0, nil
	}
	cutoff := time.Now().AddDate(0, 0, -s.BackupDays)
	entries, err := os.ReadDir(s.BackupDir())
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return 0, nil
		}
		return 0, err
	}
	for _, e := range entries {
		info, ierr := e.Info()
		if ierr != nil || e.IsDir() {
			continue
		}
		if info.ModTime().Before(cutoff) {
			if os.Remove(filepath.Join(s.BackupDir(), e.Name())) == nil {
				removed++
			}
		}
	}
	return removed, nil
}
