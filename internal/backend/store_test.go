package backend

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSaveBacksUpOnceAndReplaces(t *testing.T) {
	dir := t.TempDir()
	s, err := NewStore(filepath.Join(dir, "data"))
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(dir, "doc.pdf")
	os.WriteFile(target, []byte("v1"), 0o644)

	b1, err := s.Save(target, strings.NewReader("v2"))
	if err != nil || b1 == "" {
		t.Fatalf("first save: backup=%q err=%v", b1, err)
	}
	if got, _ := os.ReadFile(b1); string(got) != "v1" {
		t.Fatalf("backup content %q", got)
	}
	if !strings.HasPrefix(filepath.Base(b1), "doc_") {
		t.Fatalf("backup name %q", b1)
	}
	b2, err := s.Save(target, strings.NewReader("v3"))
	if err != nil || b2 != "" {
		t.Fatalf("second save should not back up: %q %v", b2, err)
	}
	if got, _ := os.ReadFile(target); string(got) != "v3" {
		t.Fatalf("target content %q", got)
	}
	left, _ := filepath.Glob(filepath.Join(dir, ".pdftool-*.tmp"))
	if len(left) != 0 {
		t.Fatalf("temp files left: %v", left)
	}
}

func TestSaveNewFileNoBackup(t *testing.T) {
	dir := t.TempDir()
	s, _ := NewStore(filepath.Join(dir, "data"))
	b, err := s.Save(filepath.Join(dir, "new.pdf"), strings.NewReader("x"))
	if err != nil || b != "" {
		t.Fatalf("b=%q err=%v", b, err)
	}
}

func TestCleanBackups(t *testing.T) {
	dir := t.TempDir()
	s, _ := NewStore(filepath.Join(dir, "data"))
	old := filepath.Join(s.BackupDir(), "old.pdf")
	os.WriteFile(old, []byte("x"), 0o644)
	past := time.Now().AddDate(0, 0, -31)
	os.Chtimes(old, past, past)
	os.WriteFile(filepath.Join(s.BackupDir(), "new.pdf"), []byte("x"), 0o644)
	n, err := s.CleanBackups()
	if err != nil || n != 1 {
		t.Fatalf("removed %d err %v", n, err)
	}
}

func TestFontIndexReadsTTC(t *testing.T) {
	fi := &FontIndex{Dirs: []string{"/usr/share/fonts"}}
	cjk := 0
	for _, f := range fi.Faces() {
		if f.CJK {
			cjk++
			t.Logf("%s idx=%d family=%q ps=%q", filepath.Base(f.File), f.Index, f.Family, f.PSName)
		}
	}
	if cjk == 0 {
		t.Skip("no CJK fonts on this machine")
	}
}
