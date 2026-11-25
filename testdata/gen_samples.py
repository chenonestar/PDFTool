"""生成阶段 0 的测试 PDF 样本，输出到 testdata/samples/。

依赖：python-docx、reportlab、pypdf、Pillow、LibreOffice（soffice）、中文字体
（文泉驿正黑、AR PL UMing/UKai、Noto CJK）。用法：python3 testdata/gen_samples.py
"""
import os
import random
import shutil
import subprocess
import sys
import tempfile

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor, Cm

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "samples")

SONG = "AR PL UMing CN"      # 近似宋体
HEI = "WenQuanYi Zen Hei"    # 近似黑体
KAI = "AR PL UKai CN"        # 近似楷体
SERIF = "Noto Serif CJK SC"  # 思源宋体

PARAS = [
    "为贯彻落实年度工作部署，进一步提升文档处理效率，现将有关事项通知如下。各部门应结合实际情况，认真组织实施，确保各项任务按期完成。",
    "本项目于2026年3月启动，计划投入资金约120万元，覆盖华东、华南两个区域。项目组由张三、李四等8人组成，负责需求分析、系统设计与上线运维（含 Windows 10/11 环境）。",
    "根据第三方测试报告，系统在100页以内文档的平均打开时间为0.8秒，PDF 渲染准确率达到99.5%。对于扫描件，OCR 识别率约为96%，仍有提升空间。",
    "请各单位于11月30日前将书面材料报送至办公室，联系人：王五，电话：010-12345678。逾期未报送的，视为无异议。",
]


def set_font(run, name, size=None, bold=None, color=None):
    run.font.name = name
    rpr = run._element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.insert(0, rfonts)
    for attr in ("w:ascii", "w:hAnsi", "w:eastAsia", "w:cs"):
        rfonts.set(qn(attr), name)
    if size:
        run.font.size = Pt(size)
    if bold is not None:
        run.font.bold = bold
    if color:
        run.font.color.rgb = RGBColor(*color)


def para(doc, text, font=SONG, size=12, indent=True, align=WD_ALIGN_PARAGRAPH.JUSTIFY, spacing=1.5):
    p = doc.add_paragraph()
    p.alignment = align
    pf = p.paragraph_format
    pf.line_spacing = spacing
    pf.space_after = Pt(6)
    if indent:
        pf.first_line_indent = Pt(size * 2)
    set_font(p.add_run(text), font, size)
    return p


def heading(doc, text, font=HEI, size=18):
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_after = Pt(12)
    set_font(p.add_run(text), font, size, bold=True)


def to_pdf(docx_path, pdf_name):
    tmp = os.path.dirname(docx_path)
    subprocess.run(["soffice", "--headless", "--convert-to", "pdf", "--outdir", tmp, docx_path],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    shutil.move(os.path.splitext(docx_path)[0] + ".pdf", os.path.join(OUT, pdf_name))


def doc_report(tmp):
    doc = Document()
    for s in doc.sections:
        s.left_margin = s.right_margin = Cm(2.5)
    heading(doc, "关于开展文档处理效率提升工作的通知")
    para(doc, PARAS[0])
    para(doc, PARAS[1])
    # 混合格式段落：加粗、红色、不同字号
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    p.paragraph_format.first_line_indent = Pt(24)
    p.paragraph_format.line_spacing = 1.5
    set_font(p.add_run("特别提醒："), HEI, 12, bold=True)
    set_font(p.add_run("涉及合同、财务等重要文件的修改，"), SONG, 12)
    set_font(p.add_run("必须保留原件备份"), SONG, 12, bold=True, color=(0xC0, 0x00, 0x00))
    set_font(p.add_run("，并由经办人签字确认。"), SONG, 12)
    para(doc, PARAS[2], font=KAI)
    para(doc, PARAS[3], font=SERIF, size=10.5)
    para(doc, "办公室", indent=False, align=WD_ALIGN_PARAGRAPH.RIGHT)
    para(doc, "2026年11月25日", indent=False, align=WD_ALIGN_PARAGRAPH.RIGHT)
    path = os.path.join(tmp, "01-report.docx")
    doc.save(path)
    to_pdf(path, "01-通知-混合字体.pdf")


def doc_table(tmp):
    doc = Document()
    heading(doc, "2026年度采购清单", size=16)
    para(doc, "下表列出本年度主要采购项目，金额单位为元。表格内文字修改时，表格框线和底纹不应被删除。")
    rows = [("序号", "项目名称", "数量", "单价", "备注"),
            ("1", "笔记本电脑", "12", "6,800", "研发部使用"),
            ("2", "激光打印机", "3", "2,150", "含三年保修"),
            ("3", "办公软件授权", "50", "399", "按年订阅"),
            ("4", "会议室显示屏", "2", "9,600", "86英寸")]
    t = doc.add_table(rows=len(rows), cols=5)
    t.style = "Table Grid"
    for i, r in enumerate(rows):
        for j, v in enumerate(r):
            cell = t.cell(i, j)
            cell.text = ""
            set_font(cell.paragraphs[0].add_run(v), HEI if i == 0 else SONG, 11, bold=(i == 0))
            if i == 0:
                shd = OxmlElement("w:shd")
                shd.set(qn("w:val"), "clear")
                shd.set(qn("w:fill"), "D9E2F3")
                cell._tc.get_or_add_tcPr().append(shd)
    para(doc, "")
    para(doc, PARAS[3])
    path = os.path.join(tmp, "02-table.docx")
    doc.save(path)
    to_pdf(path, "02-表格.pdf")


def doc_columns(tmp):
    doc = Document()
    heading(doc, "双栏排版示例", size=16)
    sect = doc.sections[0]
    cols = sect._sectPr.find(qn("w:cols"))
    if cols is None:
        cols = OxmlElement("w:cols")
        sect._sectPr.append(cols)
    cols.set(qn("w:num"), "2")
    cols.set(qn("w:space"), "720")
    for i in range(3):
        for t in PARAS:
            para(doc, t, size=10.5)
    path = os.path.join(tmp, "03-columns.docx")
    doc.save(path)
    to_pdf(path, "03-双栏.pdf")


def scan(tmp):
    from PIL import Image, ImageDraw, ImageFilter, ImageFont
    font_path = "/usr/share/fonts/truetype/arphic/uming.ttc"
    W, H = 1654, 2339  # A4 @ 200 DPI
    pages = []
    rnd = random.Random(7)
    for n in range(2):
        img = Image.new("L", (W, H), 245)
        d = ImageDraw.Draw(img)
        title = ImageFont.truetype(font_path, 56)
        body = ImageFont.truetype(font_path, 36)
        d.text((W // 2, 200), "扫描件测试 第%d页" % (n + 1), font=title, fill=20, anchor="mm")
        y = 340
        for t in PARAS * 2:
            line = ""
            for ch in t:
                if d.textlength(line + ch, font=body) > W - 320:
                    d.text((160, y), line, font=body, fill=30)
                    y += 62
                    line = ""
                line += ch
            d.text((160, y), line, font=body, fill=30)
            y += 90
        img = img.rotate(0.8, resample=Image.BICUBIC, fillcolor=245)
        px = img.load()
        for _ in range(W * H // 60):
            x, yy = rnd.randrange(W), rnd.randrange(H)
            px[x, yy] = max(0, px[x, yy] - rnd.randrange(60, 160))
        img = img.filter(ImageFilter.GaussianBlur(0.6))
        pages.append(img.convert("RGB"))
    out = os.path.join(OUT, "04-扫描件.pdf")
    pages[0].save(out, save_all=True, append_images=pages[1:], resolution=200, quality=70)


def form():
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen import canvas
    pdfmetrics.registerFont(TTFont("ZenHei", "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", subfontIndex=0))
    c = canvas.Canvas(os.path.join(OUT, "05-表单.pdf"), pagesize=A4)
    c.setFont("ZenHei", 18)
    c.drawString(72, 770, "员工信息登记表")
    c.setFont("ZenHei", 12)
    f = c.acroForm
    c.drawString(72, 720, "姓名：")
    f.textfield(name="name", x=130, y=712, width=200, height=22, borderWidth=1)
    c.drawString(72, 680, "部门：")
    f.choice(name="dept", x=130, y=672, width=200, height=22, options=["R&D", "Sales", "Admin"], value="R&D")
    c.drawString(72, 640, "性别：")
    f.radio(name="gender", value="m", selected=True, x=130, y=636, size=16)
    c.drawString(152, 640, "男")
    f.radio(name="gender", value="f", selected=False, x=190, y=636, size=16)
    c.drawString(212, 640, "女")
    c.drawString(72, 600, "已阅读规定：")
    f.checkbox(name="agree", x=160, y=596, size=16, checked=False)
    c.drawString(72, 560, "备注：")
    f.textfield(name="memo", x=130, y=500, width=380, height=70, borderWidth=1, fieldFlags="multiline")
    c.save()


def encrypted():
    from pypdf import PdfReader, PdfWriter
    w = PdfWriter(clone_from=PdfReader(os.path.join(OUT, "01-通知-混合字体.pdf")))
    w.encrypt(user_password="1234", owner_password="owner5678", algorithm="AES-256")
    with open(os.path.join(OUT, "06-加密-密码1234.pdf"), "wb") as fp:
        w.write(fp)


def large(pages=600):
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen import canvas
    pdfmetrics.registerFont(TTFont("UMing", "/usr/share/fonts/truetype/arphic/uming.ttc", subfontIndex=0))
    c = canvas.Canvas(os.path.join(OUT, "07-大文件-%d页.pdf" % pages), pagesize=A4)
    for n in range(pages):
        c.setFont("UMing", 16)
        c.drawString(72, 780, "第 %d 页 / 共 %d 页" % (n + 1, pages))
        c.setFont("UMing", 11)
        y = 740
        for k in range(12):
            t = PARAS[(n + k) % len(PARAS)]
            for i in range(0, len(t), 38):
                c.drawString(72, y, t[i:i + 38])
                y -= 17
            y -= 8
            if y < 100:
                break
        c.setStrokeColorRGB(0.2, 0.4, 0.8)
        c.rect(60, 60, 475, 740)
        c.showPage()
    c.save()


def main():
    os.makedirs(OUT, exist_ok=True)
    if not shutil.which("soffice"):
        sys.exit("需要 LibreOffice（soffice）")
    with tempfile.TemporaryDirectory() as tmp:
        steps = [("01 混合字体", lambda: doc_report(tmp)), ("02 表格", lambda: doc_table(tmp)),
                 ("03 双栏", lambda: doc_columns(tmp)), ("04 扫描件", lambda: scan(tmp)),
                 ("05 表单", form), ("06 加密", encrypted), ("07 大文件", large)]
        for name, fn in steps:
            fn()
            print("ok", name)
    for f in sorted(os.listdir(OUT)):
        print("%8.1f KB  %s" % (os.path.getsize(os.path.join(OUT, f)) / 1024, f))


if __name__ == "__main__":
    main()
