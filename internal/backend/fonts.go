package backend

import (
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// FontFace 是字体文件中的一个字体（TTC 集合中的每个子字体各算一个）。
type FontFace struct {
	ID       string `json:"id"`    // "文件路径#索引"
	File     string `json:"file"`  // 绝对路径
	Index    int    `json:"index"` // TTC 子字体索引，普通字体为 0
	Family   string `json:"family"`
	FamilyZH string `json:"familyZh"`
	Full     string `json:"full"`
	FullZH   string `json:"fullZh"`
	PSName   string `json:"psName"`
	CJK      bool   `json:"cjk"`     // 是否包含常用汉字
	Outline  string `json:"outline"` // truetype / cff（MuPDF 只能对 TrueType 做子集化）
	Bold     bool   `json:"bold"`
	Italic   bool   `json:"italic"`
	Size     int64  `json:"size"`
}

// FontIndex 枚举字体目录。结果在首次调用后缓存。
type FontIndex struct {
	Dirs []string

	once  sync.Once
	faces []FontFace
	byID  map[string]FontFace
}

func (fi *FontIndex) Faces() []FontFace {
	fi.once.Do(fi.scan)
	return fi.faces
}

func (fi *FontIndex) Lookup(id string) (FontFace, bool) {
	fi.once.Do(fi.scan)
	f, ok := fi.byID[id]
	return f, ok
}

func (fi *FontIndex) scan() {
	fi.byID = map[string]FontFace{}
	for _, dir := range fi.Dirs {
		_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil
			}
			switch strings.ToLower(filepath.Ext(p)) {
			case ".ttf", ".otf", ".ttc", ".otc":
			default:
				return nil
			}
			for _, face := range readFaces(p) {
				if _, dup := fi.byID[face.ID]; dup {
					continue
				}
				fi.byID[face.ID] = face
				fi.faces = append(fi.faces, face)
			}
			return nil
		})
	}
	sort.Slice(fi.faces, func(i, j int) bool {
		if fi.faces[i].CJK != fi.faces[j].CJK {
			return fi.faces[i].CJK
		}
		return fi.faces[i].Full < fi.faces[j].Full
	})
}

func readFaces(path string) []FontFace {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil
	}
	offs, err := faceOffsets(f)
	if err != nil {
		return nil
	}
	var out []FontFace
	for i, off := range offs {
		fi, err := parseFace(f, off)
		if err != nil {
			continue
		}
		out = append(out, FontFace{
			ID: path + "#" + itoa(i), File: path, Index: i,
			Family: fi.Family, FamilyZH: fi.FamilyZH, Full: fi.Full, FullZH: fi.FullZH,
			PSName: fi.PSName, CJK: fi.CJK, Outline: fi.Outline, Bold: fi.Bold, Italic: fi.Italic, Size: st.Size(),
		})
	}
	return out
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b [20]byte
	n := len(b)
	for i > 0 {
		n--
		b[n] = byte('0' + i%10)
		i /= 10
	}
	return string(b[n:])
}

// DefaultFontDirs 返回当前平台的系统字体目录（只读）。
func DefaultFontDirs() []string {
	if win := os.Getenv("WINDIR"); win != "" {
		dirs := []string{filepath.Join(win, "Fonts")}
		if local := os.Getenv("LOCALAPPDATA"); local != "" {
			// 用户级安装的字体，只读取
			dirs = append(dirs, filepath.Join(local, "Microsoft", "Windows", "Fonts"))
		}
		return dirs
	}
	return []string{"/usr/share/fonts", "/usr/local/share/fonts"}
}
