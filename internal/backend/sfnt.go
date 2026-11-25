package backend

import (
	"encoding/binary"
	"errors"
	"io"
	"unicode/utf16"
)

// 极简 OpenType/TrueType 解析：只读表目录、name 表和 OS/2 表。
// 不用 x/image/sfnt 是因为它对部分 TTC（含位图表等）会报 invalid table offset。

type faceInfo struct {
	Family, FamilyZH, Full, FullZH, PSName, Subfamily string
	Bold, Italic, CJK                                 bool
	Outline                                           string // "truetype" 或 "cff"
}

var errNotFont = errors.New("not a font")

func readAt(r io.ReaderAt, off int64, n int) ([]byte, error) {
	b := make([]byte, n)
	_, err := r.ReadAt(b, off)
	return b, err
}

// faceOffsets 返回每个子字体的表目录偏移。普通字体返回 [0]。
func faceOffsets(r io.ReaderAt) ([]int64, error) {
	h, err := readAt(r, 0, 12)
	if err != nil {
		return nil, err
	}
	switch string(h[:4]) {
	case "ttcf":
		n := binary.BigEndian.Uint32(h[8:12])
		if n == 0 || n > 256 {
			return nil, errNotFont
		}
		b, err := readAt(r, 12, int(n)*4)
		if err != nil {
			return nil, err
		}
		offs := make([]int64, n)
		for i := range offs {
			offs[i] = int64(binary.BigEndian.Uint32(b[i*4:]))
		}
		return offs, nil
	case "\x00\x01\x00\x00", "OTTO", "true":
		return []int64{0}, nil
	}
	return nil, errNotFont
}

func parseFace(r io.ReaderAt, off int64) (*faceInfo, error) {
	h, err := readAt(r, off, 12)
	if err != nil {
		return nil, err
	}
	num := int(binary.BigEndian.Uint16(h[4:6]))
	if num == 0 || num > 512 {
		return nil, errNotFont
	}
	dir, err := readAt(r, off+12, num*16)
	if err != nil {
		return nil, err
	}
	tables := map[string][2]uint32{}
	for i := 0; i < num; i++ {
		e := dir[i*16:]
		tables[string(e[:4])] = [2]uint32{binary.BigEndian.Uint32(e[8:12]), binary.BigEndian.Uint32(e[12:16])}
	}
	fi := &faceInfo{Outline: "truetype"}
	if _, ok := tables["glyf"]; !ok {
		if _, cff := tables["CFF "]; cff {
			fi.Outline = "cff"
		} else if _, cff2 := tables["CFF2"]; cff2 {
			fi.Outline = "cff"
		}
	}
	if t, ok := tables["name"]; ok && t[1] < 1<<20 {
		if b, err := readAt(r, int64(t[0]), int(t[1])); err == nil {
			parseNames(b, fi)
		}
	}
	if t, ok := tables["OS/2"]; ok && t[1] >= 78 {
		if b, err := readAt(r, int64(t[0]), int(t[1])); err == nil {
			fsSel := binary.BigEndian.Uint16(b[62:64])
			fi.Italic = fsSel&1 != 0
			fi.Bold = fsSel&(1<<5) != 0
			uni2 := binary.BigEndian.Uint32(b[46:50]) // ulUnicodeRange2，bit 59-32=27 为 CJK 统一汉字
			fi.CJK = uni2&(1<<27) != 0
			if len(b) >= 86 && binary.BigEndian.Uint16(b[0:2]) >= 1 {
				cp1 := binary.BigEndian.Uint32(b[78:82]) // bit 18 简体中文 GBK，bit 20 繁体中文 Big5
				if cp1&(1<<18) != 0 || cp1&(1<<20) != 0 {
					fi.CJK = true
				}
			}
		}
	}
	if fi.Family == "" && fi.PSName == "" {
		return nil, errNotFont
	}
	return fi, nil
}

func parseNames(b []byte, fi *faceInfo) {
	if len(b) < 6 {
		return
	}
	count := int(binary.BigEndian.Uint16(b[2:4]))
	strOff := int(binary.BigEndian.Uint16(b[4:6]))
	for i := 0; i < count; i++ {
		rec := 6 + i*12
		if rec+12 > len(b) {
			return
		}
		plat := binary.BigEndian.Uint16(b[rec:])
		enc := binary.BigEndian.Uint16(b[rec+2:])
		lang := binary.BigEndian.Uint16(b[rec+4:])
		id := binary.BigEndian.Uint16(b[rec+6:])
		ln := int(binary.BigEndian.Uint16(b[rec+8:]))
		so := strOff + int(binary.BigEndian.Uint16(b[rec+10:]))
		if so+ln > len(b) {
			continue
		}
		raw := b[so : so+ln]
		var s string
		switch {
		case plat == 3 && (enc == 1 || enc == 10 || enc == 0):
			u := make([]uint16, len(raw)/2)
			for j := range u {
				u[j] = binary.BigEndian.Uint16(raw[j*2:])
			}
			s = string(utf16.Decode(u))
		case plat == 1 && enc == 0:
			s = string(raw)
			lang = 0x409 // 按英文处理
		default:
			continue
		}
		en := lang == 0x409
		zh := lang == 0x804 || lang == 0x404 || lang == 0xC04 || lang == 0x1004
		set := func(dst *string, ok bool) {
			if ok && *dst == "" {
				*dst = s
			}
		}
		switch id {
		case 1:
			set(&fi.Family, en)
			set(&fi.FamilyZH, zh)
		case 2:
			set(&fi.Subfamily, en)
		case 4:
			set(&fi.Full, en)
			set(&fi.FullZH, zh)
		case 6:
			set(&fi.PSName, true)
		}
	}
}
