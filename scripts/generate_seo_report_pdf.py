import sys
import os
import json
import re
import datetime

from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.platypus import (
    SimpleDocTemplate, BaseDocTemplate, PageTemplate, Frame, Paragraph,
    Spacer, Table, TableStyle, PageBreak, KeepTogether, Image, HRFlowable
)
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

def setup_poppins_fonts():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    fonts_dir = os.path.join(script_dir, "fonts")
    
    reg_path = os.path.join(fonts_dir, "Poppins-Regular.ttf")
    med_path = os.path.join(fonts_dir, "Poppins-Medium.ttf")
    bold_path = os.path.join(fonts_dir, "Poppins-Bold.ttf")

    registered = False
    if os.path.exists(reg_path):
        try:
            pdfmetrics.registerFont(TTFont("Poppins", reg_path))
            registered = True
        except Exception:
            pass
    if os.path.exists(med_path):
        try:
            pdfmetrics.registerFont(TTFont("Poppins-Medium", med_path))
        except Exception:
            pass
    if os.path.exists(bold_path):
        try:
            pdfmetrics.registerFont(TTFont("Poppins-Bold", bold_path))
        except Exception:
            pass
    return registered

HAS_POPPINS = setup_poppins_fonts()
FONT_BODY = "Poppins" if HAS_POPPINS else "Helvetica"
FONT_BOLD = "Poppins-Bold" if HAS_POPPINS else "Helvetica-Bold"
FONT_MEDIUM = "Poppins-Medium" if HAS_POPPINS else "Helvetica-Bold"

class NumberedCanvas(canvas.Canvas):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._saved_page_states = []

    def showPage(self):
        self._saved_page_states.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        num_pages = len(self._saved_page_states)
        for state in self._saved_page_states:
            self.__dict__.update(state)
            self.draw_page_decorations(num_pages)
            super().showPage()
        super().save()

    def draw_page_decorations(self, total_pages):
        self.saveState()
        width, height = A4
        
        # Draw header banner on pages after page 1 if available
        # Footer on all pages
        self.setFont(FONT_BODY, 8)
        self.setFillColor(colors.HexColor('#64748b'))
        
        footer_text = f"Grehasoft Smart IT Solutions — Confidential SEO Report"
        self.drawString(54, 30, footer_text)
        
        page_str = f"Page {self._pageNumber} of {total_pages}"
        self.drawRightString(width - 54, 30, page_str)
        
        # Subtle footer divider
        self.setStrokeColor(colors.HexColor('#e2e8f0'))
        self.setLineWidth(0.5)
        self.line(54, 42, width - 54, 42)
        
        self.restoreState()

def find_asset(media_root, filename):
    paths = [
        os.path.join(media_root, filename),
        os.path.join(media_root, "logo", filename),
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "media", filename),
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "media", "logo", filename),
    ]
    for p in paths:
        if os.path.exists(p):
            return p
    return None

def draw_background_factory(media_root):
    def draw_background(canvas_obj, doc):
        width, height = doc.pagesize
        
        # Draw Watermark
        watermark_path = find_asset(media_root, "grehasoftwatermark.png")
        if watermark_path and os.path.exists(watermark_path):
            canvas_obj.saveState()
            try:
                try:
                    canvas_obj.setFillAlpha(0.12)
                    canvas_obj.setStrokeAlpha(0.12)
                except AttributeError:
                    pass
                from PIL import Image as PILImage
                img = PILImage.open(watermark_path)
                img_w, img_h = img.size
                draw_w = width * 0.60
                scale = draw_w / img_w
                draw_h = img_h * scale
                x = (width - draw_w) / 2.0
                y = (height - draw_h) / 2.0
                watermark = ImageReader(watermark_path)
                canvas_obj.drawImage(watermark, x, y, width=draw_w, height=draw_h, preserveAspectRatio=True, mask='auto')
            except Exception as e:
                print("Watermark error:", e, file=sys.stderr)
            canvas_obj.restoreState()
            
    return draw_background

def draw_background_later_factory(media_root):
    draw_bg = draw_background_factory(media_root)
    def draw_background_later(canvas_obj, doc):
        draw_bg(canvas_obj, doc)
        width, height = doc.pagesize
        header_path = find_asset(media_root, "invoice_header.png")
        if header_path and os.path.exists(header_path):
            canvas_obj.saveState()
            try:
                from PIL import Image as PILImage
                img = PILImage.open(header_path)
                img_w, img_h = img.size
                draw_w = width
                draw_h = draw_w * (img_h / img_w)
                x = 0
                y = height - draw_h
                header_img = ImageReader(header_path)
                canvas_obj.drawImage(header_img, x, y, width=draw_w, height=draw_h, preserveAspectRatio=True, mask='auto')
            except Exception as e:
                print("Header banner error:", e, file=sys.stderr)
            canvas_obj.restoreState()
    return draw_background_later

class SEOReportDocTemplate(SimpleDocTemplate):
    def __init__(self, *args, media_root="", **kwargs):
        super().__init__(*args, **kwargs)
        self.media_root = media_root

    def build(self, flowables, onFirstPage=None, onLaterPages=None, canvasmaker=None):
        self._calc()
        width, height = self.pagesize
        
        # First Page Frame
        frame_first = Frame(
            54, 54, width - 108, height - 108,
            id='first_frame',
            leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0
        )
        
        # Later Page Frame
        header_path = find_asset(self.media_root, "invoice_header.png")
        banner_h = 70
        if header_path and os.path.exists(header_path):
            try:
                from PIL import Image as PILImage
                img = PILImage.open(header_path)
                banner_h = width * (img.size[1] / img.size[0])
            except Exception:
                pass
        later_top_margin = banner_h + 20
        
        frame_later = Frame(
            54, 54, width - 108, height - 54 - later_top_margin,
            id='later_frame',
            leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0
        )
        
        from reportlab.platypus import PageTemplate
        self.addPageTemplates([
            PageTemplate(id='First', frames=frame_first, onPage=onFirstPage, pagesize=self.pagesize),
            PageTemplate(id='Later', frames=frame_later, onPage=onLaterPages, pagesize=self.pagesize)
        ])
        
        from reportlab.platypus import BaseDocTemplate
        BaseDocTemplate.build(self, flowables, canvasmaker=canvasmaker)

def parse_bullet_items(raw):
    if not raw:
        return []
    if isinstance(raw, list):
        return [str(x).strip() for x in raw if str(x).strip()]
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                return [str(x).strip() for x in parsed if str(x).strip()]
        except Exception:
            pass
        return [line.strip().lstrip('•-*\t ') for line in raw.split('\n') if line.strip()]
    return []

def safe_val(val, default="-"):
    if val is None:
        return default
    s = str(val).strip()
    return s if s else default

def safe_num(val, suffix="", prefix=""):
    if val is None:
        return "-"
    try:
        f = float(val)
        if f.is_integer():
            return f"{prefix}{int(f):,}{suffix}"
        return f"{prefix}{f:,.1f}{suffix}"
    except Exception:
        return f"{prefix}{val}{suffix}"

class SEOReportPDFGenerator:
    def __init__(self, payload):
        self.payload = payload
        self.report = payload.get('report', {})
        self.media_root = payload.get('media_root', '')
        
        self.primary_color = colors.HexColor('#0f172a')     # Dark Slate
        self.brand_color = colors.HexColor('#0753F6')       # Grehasoft Blue
        self.accent_color = colors.HexColor('#10b981')      # Emerald Green
        self.danger_color = colors.HexColor('#ef4444')      # Red
        self.card_bg = colors.HexColor('#f8fafc')           # Slate light
        self.border_color = colors.HexColor('#e2e8f0')      # Slate border
        
        self.styles = getSampleStyleSheet()
        self.init_styles()

    def init_styles(self):
        self.h1_style = ParagraphStyle(
            'SEO_H1',
            parent=self.styles['Heading1'],
            fontName=FONT_BOLD,
            fontSize=16,
            leading=20,
            textColor=self.primary_color,
            spaceBefore=14,
            spaceAfter=8,
            keepWithNext=True
        )
        self.h2_style = ParagraphStyle(
            'SEO_H2',
            parent=self.styles['Heading2'],
            fontName=FONT_BOLD,
            fontSize=12,
            leading=16,
            textColor=self.brand_color,
            spaceBefore=10,
            spaceAfter=6,
            keepWithNext=True
        )
        self.body_style = ParagraphStyle(
            'SEO_Body',
            parent=self.styles['Normal'],
            fontName=FONT_BODY,
            fontSize=9.5,
            leading=13.5,
            textColor=colors.HexColor('#334155'),
            spaceAfter=6
        )
        self.bullet_style = ParagraphStyle(
            'SEO_Bullet',
            parent=self.body_style,
            leftIndent=12,
            firstLineIndent=-8,
            spaceAfter=4
        )
        self.table_header_style = ParagraphStyle(
            'SEO_THeader',
            parent=self.styles['Normal'],
            fontName=FONT_BOLD,
            fontSize=9,
            leading=12,
            textColor=colors.white,
            alignment=0
        )
        self.table_cell_style = ParagraphStyle(
            'SEO_TCell',
            parent=self.styles['Normal'],
            fontName=FONT_BODY,
            fontSize=8.5,
            leading=11.5,
            textColor=colors.HexColor('#1e293b')
        )
        self.table_cell_bold = ParagraphStyle(
            'SEO_TCellBold',
            parent=self.table_cell_style,
            fontName=FONT_BOLD
        )

    def draw_section_header(self, title, section_num=None):
        prefix = f"{section_num}. " if section_num else ""
        full_title = f"{prefix}{title}"
        
        elements = []
        elements.append(Paragraph(full_title, self.h1_style))
        elements.append(HRFlowable(width="100%", thickness=1.5, color=self.brand_color, spaceBefore=2, spaceAfter=8))
        return elements

    def draw_cover_header(self):
        story = []
        
        # Logo
        logo_path = find_asset(self.media_root, "grehasoftlogo.png")
        if logo_path and os.path.exists(logo_path):
            try:
                from PIL import Image as PILImage
                img = PILImage.open(logo_path)
                orig_w, orig_h = img.size
                logo_w = 200
                logo_h = logo_w * (orig_h / orig_w)
                logo_img = Image(logo_path, width=logo_w, height=logo_h)
                logo_img.hAlign = 'LEFT'
                story.append(logo_img)
            except Exception as e:
                print("Logo error:", e, file=sys.stderr)
                story.append(Spacer(1, 20))
        else:
            story.append(Spacer(1, 20))

        story.append(Spacer(1, 10))

        # Title & Meta Info Card
        report_title = safe_val(self.report.get('report_title'), 'Monthly SEO Performance Report')
        company_name = safe_val(self.report.get('company_name') or self.report.get('client_name'), 'Valued Client')
        domain_url = safe_val(self.report.get('domain_url') or self.report.get('website_name'), 'Website')
        report_month = safe_val(self.report.get('report_month'), 'N/A')
        
        start_date = safe_val(self.report.get('period_start_date'), '')
        end_date = safe_val(self.report.get('period_end_date'), '')
        if start_date and isinstance(start_date, str) and len(start_date) >= 10:
            start_date = start_date[:10]
        if end_date and isinstance(end_date, str) and len(end_date) >= 10:
            end_date = end_date[:10]
            
        period_str = f"{start_date} to {end_date}" if start_date and end_date else "Monthly Period"

        title_p = Paragraph(f"<b>{report_title}</b>", ParagraphStyle('CoverT', fontName=FONT_BOLD, fontSize=20, leading=24, textColor=self.primary_color))
        meta_table_data = [
            [Paragraph("<b>Client Company:</b>", self.body_style), Paragraph(company_name, self.body_style), Paragraph("<b>Reporting Month:</b>", self.body_style), Paragraph(report_month, self.body_style)],
            [Paragraph("<b>Website / Domain:</b>", self.body_style), Paragraph(domain_url, self.body_style), Paragraph("<b>Reporting Period:</b>", self.body_style), Paragraph(period_str, self.body_style)],
        ]
        
        meta_table = Table(meta_table_data, colWidths=[100, 160, 100, 124])
        meta_table.setStyle(TableStyle([
            ('BACKGROUND', (0,0), (-1,-1), self.card_bg),
            ('BOX', (0,0), (-1,-1), 1, self.border_color),
            ('INNERGRID', (0,0), (-1,-1), 0.5, self.border_color),
            ('PADDING', (0,0), (-1,-1), 6),
            ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
        ]))

        story.append(title_p)
        story.append(Spacer(1, 8))
        story.append(meta_table)
        story.append(Spacer(1, 14))
        
        return story

    def embed_evidence(self, section_name):
        story = []
        files = self.report.get('evidence_files', []) or []
        section_files = [f for f in files if f.get('section') == section_name]
        section_files.sort(key=lambda x: x.get('display_order', 0))

        if not section_files:
            return story

        story.append(Paragraph("<b>Evidence & Verification Screenshots:</b>", self.h2_style))

        for f in section_files:
            file_path = f.get('file_path', '')
            filename = f.get('file_name', 'Screenshot')
            caption = f.get('caption', '')
            
            # Resolve image disk path
            resolved_path = None
            candidates = [
                file_path,
                os.path.join(self.media_root, file_path),
                os.path.join(self.media_root, 'seo_reports', 'evidence', filename),
                os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), file_path)
            ]
            for c in candidates:
                if c and os.path.exists(c):
                    resolved_path = c
                    break

            item_flowables = []

            if resolved_path:
                try:
                    from PIL import Image as PILImage
                    img = PILImage.open(resolved_path)
                    orig_w, orig_h = img.size
                    
                    max_w = 460
                    max_h = 300
                    
                    scale = min(max_w / float(orig_w), max_h / float(orig_h))
                    if scale > 1.0:
                        scale = 1.0
                        
                    draw_w = orig_w * scale
                    draw_h = orig_h * scale
                    
                    rl_img = Image(resolved_path, width=draw_w, height=draw_h)
                    rl_img.hAlign = 'CENTER'
                    item_flowables.append(rl_img)
                    
                    if caption:
                        item_flowables.append(Spacer(1, 4))
                        item_flowables.append(Paragraph(f"<i>Caption: {caption}</i>", ParagraphStyle('Cap', fontName=FONT_BODY, fontSize=8, textColor=colors.HexColor('#64748b'), alignment=1)))
                except Exception as e:
                    item_flowables.append(Paragraph(f"<i>[Error rendering screenshot {filename}: {str(e)}]</i>", self.body_style))
            else:
                item_flowables.append(Paragraph(f"<i>[Evidence Screenshot: {filename} (File not found on disk)]</i>", self.body_style))

            item_flowables.append(Spacer(1, 10))
            story.append(KeepTogether(item_flowables))

        return story

    def draw_executive_summary(self):
        story = []
        story.extend(self.draw_section_header("Executive Summary & Brand Highlights", 1))

        exec_text = self.report.get('executive_summary')
        if exec_text:
            story.append(Paragraph(exec_text, self.body_style))
        else:
            story.append(Paragraph("<i>No executive summary provided for this reporting period.</i>", self.body_style))

        achievements = parse_bullet_items(self.report.get('key_achievements'))
        if achievements:
            story.append(Spacer(1, 4))
            story.append(Paragraph("<b>Key Achievements:</b>", self.h2_style))
            for item in achievements:
                story.append(Paragraph(f"• {item}", self.bullet_style))

        challenges = self.report.get('challenges_notes')
        if challenges:
            story.append(Spacer(1, 4))
            story.append(Paragraph("<b>Challenges & Strategic Notes:</b>", self.h2_style))
            story.append(Paragraph(challenges, self.body_style))

        recs = parse_bullet_items(self.report.get('recommendations'))
        if recs:
            story.append(Spacer(1, 4))
            story.append(Paragraph("<b>Recommendations:</b>", self.h2_style))
            for item in recs:
                story.append(Paragraph(f"• {item}", self.bullet_style))

        story.append(Spacer(1, 10))
        return story

    def draw_seo_health(self):
        story = []
        story.extend(self.draw_section_header("SEO Health & Authority Overview", 2))

        da = self.report.get('domain_authority', 0)
        prev_da = self.report.get('previous_da', 0)
        pa = self.report.get('page_authority', 0)
        spam = self.report.get('spam_score', 0)
        health = self.report.get('health_score', 100)
        indexed = self.report.get('total_indexed_pages', 0)
        backlinks = self.report.get('total_backlinks', 0)

        da_diff = da - prev_da if (da is not None and prev_da is not None) else 0
        da_trend = f" (+{da_diff})" if da_diff > 0 else (f" ({da_diff})" if da_diff < 0 else " (=)")

        card_data = [
            [
                Paragraph(f"<b>Domain Authority (DA)</b><br/><font size=14 color='{self.brand_color.hexval()}'><b>{da}</b></font><font size=8 color='#64748b'> Prev: {prev_da}{da_trend}</font>", self.body_style),
                Paragraph(f"<b>Page Authority (PA)</b><br/><font size=14 color='{self.brand_color.hexval()}'><b>{pa}</b></font>", self.body_style),
                Paragraph(f"<b>Spam Score</b><br/><font size=14 color='{'#ef4444' if spam > 5 else '#10b981'}'><b>{spam}%</b></font>", self.body_style),
            ],
            [
                Paragraph(f"<b>Health Score</b><br/><font size=14 color='{self.accent_color.hexval()}'><b>{health}/100</b></font>", self.body_style),
                Paragraph(f"<b>Total Indexed Pages</b><br/><font size=14><b>{safe_num(indexed)}</b></font>", self.body_style),
                Paragraph(f"<b>Total Backlinks</b><br/><font size=14><b>{safe_num(backlinks)}</b></font>", self.body_style),
            ]
        ]

        table = Table(card_data, colWidths=[160, 160, 164])
        table.setStyle(TableStyle([
            ('BACKGROUND', (0,0), (-1,-1), self.card_bg),
            ('BOX', (0,0), (-1,-1), 1, self.border_color),
            ('INNERGRID', (0,0), (-1,-1), 0.5, self.border_color),
            ('PADDING', (0,0), (-1,-1), 8),
            ('VALIGN', (0,0), (-1,-1), 'TOP'),
        ]))

        story.append(table)
        story.append(Spacer(1, 10))
        story.extend(self.embed_evidence('general'))
        return story

    def draw_keyword_rankings(self):
        story = []
        story.extend(self.draw_section_header("Keyword Rankings & SERP Movement", 3))

        keywords = self.report.get('keywords', []) or []
        if not keywords:
            story.append(Paragraph("<i>No keyword rankings provided for this reporting period.</i>", self.body_style))
        else:
            headers = ["Keyword", "Search Engine", "Initial", "Prev", "Curr", "Target", "Change"]
            table_data = [[Paragraph(f"<b>{h}</b>", self.table_header_style) for h in headers]]

            for kw in keywords:
                k_text = safe_val(kw.get('keyword'))
                se_text = safe_val(kw.get('search_engine'), 'Google')
                init_r = safe_val(kw.get('initial_rank'))
                prev_r = safe_val(kw.get('previous_rank'))
                curr_r = safe_val(kw.get('current_rank'))
                targ_r = safe_val(kw.get('target_rank'))
                chg_r = safe_val(kw.get('rank_change'))

                # Color code change
                chg_color = "#475569"
                if chg_r.startswith("+") or "up" in chg_r.lower() or (chg_r.isdigit() and int(chg_r) > 0):
                    chg_color = "#10b981"
                elif chg_r.startswith("-") or "down" in chg_r.lower():
                    chg_color = "#ef4444"

                row = [
                    Paragraph(f"<b>{k_text}</b>", self.table_cell_style),
                    Paragraph(se_text, self.table_cell_style),
                    Paragraph(init_r, self.table_cell_style),
                    Paragraph(prev_r, self.table_cell_style),
                    Paragraph(f"<b>{curr_r}</b>", self.table_cell_style),
                    Paragraph(targ_r, self.table_cell_style),
                    Paragraph(f"<font color='{chg_color}'><b>{chg_r}</b></font>", self.table_cell_style),
                ]
                table_data.append(row)

            kw_table = Table(table_data, colWidths=[154, 75, 45, 45, 45, 50, 70], repeatRows=1)
            kw_table.setStyle(TableStyle([
                ('BACKGROUND', (0,0), (-1,0), self.primary_color),
                ('GRID', (0,0), (-1,-1), 0.5, self.border_color),
                ('PADDING', (0,0), (-1,-1), 5),
                ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
                ('ROWBACKGROUNDS', (0,1), (-1,-1), [colors.white, self.card_bg]),
            ]))
            story.append(kw_table)

        story.append(Spacer(1, 10))
        story.extend(self.embed_evidence('keywords'))
        return story

    def draw_gsc_performance(self):
        story = []
        story.extend(self.draw_section_header("Google Search Console Performance", 4))

        clicks = self.report.get('gsc_clicks', 0)
        prev_clicks = self.report.get('gsc_prev_clicks', 0)
        impressions = self.report.get('gsc_impressions', 0)
        prev_impressions = self.report.get('gsc_prev_impressions', 0)
        ctr = self.report.get('gsc_avg_ctr', 0.0)
        prev_ctr = self.report.get('gsc_prev_avg_ctr', 0.0)
        pos = self.report.get('gsc_avg_position', 0.0)
        prev_pos = self.report.get('gsc_prev_avg_position', 0.0)

        # Calculates
        click_diff = clicks - prev_clicks
        imp_diff = impressions - prev_impressions

        gsc_data = [
            [Paragraph("<b>Metric</b>", self.table_header_style), Paragraph("<b>Current Period</b>", self.table_header_style), Paragraph("<b>Previous Period</b>", self.table_header_style), Paragraph("<b>Growth / Difference</b>", self.table_header_style)],
            [Paragraph("Total Clicks", self.table_cell_bold), Paragraph(safe_num(clicks), self.table_cell_style), Paragraph(safe_num(prev_clicks), self.table_cell_style), Paragraph(f"<font color='{'#10b981' if click_diff>=0 else '#ef4444'}'><b>{'+' if click_diff>0 else ''}{click_diff:,}</b></font>", self.table_cell_style)],
            [Paragraph("Total Impressions", self.table_cell_bold), Paragraph(safe_num(impressions), self.table_cell_style), Paragraph(safe_num(prev_impressions), self.table_cell_style), Paragraph(f"<font color='{'#10b981' if imp_diff>=0 else '#ef4444'}'><b>{'+' if imp_diff>0 else ''}{imp_diff:,}</b></font>", self.table_cell_style)],
            [Paragraph("Average CTR", self.table_cell_bold), Paragraph(f"{ctr:.2f}%", self.table_cell_style), Paragraph(f"{prev_ctr:.2f}%", self.table_cell_style), Paragraph(f"{ctr - prev_ctr:+.2f}%", self.table_cell_style)],
            [Paragraph("Average Position", self.table_cell_bold), Paragraph(f"{pos:.1f}", self.table_cell_style), Paragraph(f"{prev_pos:.1f}", self.table_cell_style), Paragraph(f"{pos - prev_pos:+.1f}", self.table_cell_style)],
        ]

        gsc_table = Table(gsc_data, colWidths=[130, 110, 110, 134])
        gsc_table.setStyle(TableStyle([
            ('BACKGROUND', (0,0), (-1,0), self.primary_color),
            ('GRID', (0,0), (-1,-1), 0.5, self.border_color),
            ('PADDING', (0,0), (-1,-1), 6),
            ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
            ('ROWBACKGROUNDS', (0,1), (-1,-1), [colors.white, self.card_bg]),
        ]))
        story.append(gsc_table)

        story.append(Spacer(1, 10))
        story.extend(self.embed_evidence('gsc'))
        return story

    def draw_gsc_top_queries(self):
        story = []
        story.extend(self.draw_section_header("GSC Top Performing Search Queries", 5))

        queries = self.report.get('top_queries', []) or []
        if not queries:
            story.append(Paragraph("<i>No top queries recorded for this reporting period.</i>", self.body_style))
        else:
            headers = ["Query", "Clicks", "Impressions", "CTR (%)", "Avg Position"]
            table_data = [[Paragraph(f"<b>{h}</b>", self.table_header_style) for h in headers]]

            for q in queries:
                q_text = safe_val(q.get('query'))
                clks = safe_num(q.get('clicks'))
                imps = safe_num(q.get('impressions'))
                ctr_val = safe_num(q.get('ctr'), suffix='%')
                pos_val = safe_num(q.get('position'))

                row = [
                    Paragraph(f"<b>{q_text}</b>", self.table_cell_style),
                    Paragraph(clks, self.table_cell_style),
                    Paragraph(imps, self.table_cell_style),
                    Paragraph(ctr_val, self.table_cell_style),
                    Paragraph(pos_val, self.table_cell_style),
                ]
                table_data.append(row)

            q_table = Table(table_data, colWidths=[184, 75, 85, 70, 70], repeatRows=1)
            q_table.setStyle(TableStyle([
                ('BACKGROUND', (0,0), (-1,0), self.primary_color),
                ('GRID', (0,0), (-1,-1), 0.5, self.border_color),
                ('PADDING', (0,0), (-1,-1), 5),
                ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
                ('ROWBACKGROUNDS', (0,1), (-1,-1), [colors.white, self.card_bg]),
            ]))
            story.append(q_table)

        story.append(Spacer(1, 10))
        return story

    def draw_ga4_traffic(self):
        story = []
        story.extend(self.draw_section_header("Google Analytics 4 Traffic & Channels", 6))

        users = self.report.get('ga4_organic_users', 0)
        prev_users = self.report.get('ga4_prev_users', 0)
        new_users = self.report.get('ga4_new_users', 0)
        sessions = self.report.get('ga4_sessions', 0)
        prev_sessions = self.report.get('ga4_prev_sessions', 0)
        eng_rate = self.report.get('ga4_engagement_rate', 0.0)
        avg_dur = safe_val(self.report.get('ga4_avg_session_duration'), '-')

        user_diff = users - prev_users
        sess_diff = sessions - prev_sessions

        ga4_summary = [
            [
                Paragraph(f"<b>Organic Users</b><br/><font size=13 color='{self.brand_color.hexval()}'><b>{safe_num(users)}</b></font><br/><font size=7.5 color='#64748b'>Prev: {safe_num(prev_users)} ({'+' if user_diff>0 else ''}{user_diff})</font>", self.body_style),
                Paragraph(f"<b>New Users</b><br/><font size=13><b>{safe_num(new_users)}</b></font>", self.body_style),
                Paragraph(f"<b>Total Sessions</b><br/><font size=13 color='{self.brand_color.hexval()}'><b>{safe_num(sessions)}</b></font><br/><font size=7.5 color='#64748b'>Prev: {safe_num(prev_sessions)} ({'+' if sess_diff>0 else ''}{sess_diff})</font>", self.body_style),
            ],
            [
                Paragraph(f"<b>Engagement Rate</b><br/><font size=13 color='{self.accent_color.hexval()}'><b>{eng_rate:.1f}%</b></font>", self.body_style),
                Paragraph(f"<b>Avg Session Duration</b><br/><font size=13><b>{avg_dur}</b></font>", self.body_style),
                Paragraph("", self.body_style),
            ]
        ]
        sum_table = Table(ga4_summary, colWidths=[160, 160, 164])
        sum_table.setStyle(TableStyle([
            ('BACKGROUND', (0,0), (-1,-1), self.card_bg),
            ('BOX', (0,0), (-1,-1), 1, self.border_color),
            ('INNERGRID', (0,0), (-1,-1), 0.5, self.border_color),
            ('PADDING', (0,0), (-1,-1), 6),
        ]))
        story.append(sum_table)
        story.append(Spacer(1, 8))

        # Traffic Sources Table
        sources = self.report.get('traffic_sources', []) or []
        if sources:
            story.append(Paragraph("<b>Traffic Distribution by Channel:</b>", self.h2_style))
            ts_headers = ["Channel / Source", "Users", "Percentage Share"]
            ts_data = [[Paragraph(f"<b>{h}</b>", self.table_header_style) for h in ts_headers]]

            for s in sources:
                ch = safe_val(s.get('channel'))
                u_cnt = safe_num(s.get('users'))
                pct = safe_num(s.get('percentage'), suffix='%')

                ts_data.append([
                    Paragraph(f"<b>{ch}</b>", self.table_cell_style),
                    Paragraph(u_cnt, self.table_cell_style),
                    Paragraph(pct, self.table_cell_style),
                ])

            ts_table = Table(ts_data, colWidths=[224, 130, 130])
            ts_table.setStyle(TableStyle([
                ('BACKGROUND', (0,0), (-1,0), self.primary_color),
                ('GRID', (0,0), (-1,-1), 0.5, self.border_color),
                ('PADDING', (0,0), (-1,-1), 5),
                ('ROWBACKGROUNDS', (0,1), (-1,-1), [colors.white, self.card_bg]),
            ]))
            story.append(ts_table)

        story.append(Spacer(1, 10))
        story.extend(self.embed_evidence('ga4'))
        return story

    def draw_gbp_local_seo(self):
        story = []
        story.extend(self.draw_section_header("Google Business Profile / Local SEO", 3))

        views = self.report.get('gbp_profile_views', 0)
        prev_views = self.report.get('gbp_prev_views', 0)
        interactions = self.report.get('gbp_interactions', 0)
        calls = self.report.get('gbp_phone_calls', 0)
        directions = self.report.get('gbp_direction_requests', 0)
        clicks = self.report.get('gbp_website_clicks', 0)

        view_diff = views - prev_views

        gbp_grid = [
            [
                Paragraph(f"<b>Profile Views</b><br/><font size=13 color='{self.brand_color.hexval()}'><b>{safe_num(views)}</b></font><br/><font size=7.5 color='#64748b'>Prev: {safe_num(prev_views)} ({'+' if view_diff>0 else ''}{view_diff})</font>", self.body_style),
                Paragraph(f"<b>Total Interactions</b><br/><font size=13><b>{safe_num(interactions)}</b></font>", self.body_style),
                Paragraph(f"<b>Phone Calls</b><br/><font size=13 color='{self.accent_color.hexval()}'><b>{safe_num(calls)}</b></font>", self.body_style),
            ],
            [
                Paragraph(f"<b>Direction Requests</b><br/><font size=13><b>{safe_num(directions)}</b></font>", self.body_style),
                Paragraph(f"<b>Website Clicks</b><br/><font size=13 color='{self.brand_color.hexval()}'><b>{safe_num(clicks)}</b></font>", self.body_style),
                Paragraph("", self.body_style),
            ]
        ]
        gbp_table = Table(gbp_grid, colWidths=[160, 160, 164])
        gbp_table.setStyle(TableStyle([
            ('BACKGROUND', (0,0), (-1,-1), self.card_bg),
            ('BOX', (0,0), (-1,-1), 1, self.border_color),
            ('INNERGRID', (0,0), (-1,-1), 0.5, self.border_color),
            ('PADDING', (0,0), (-1,-1), 6),
        ]))
        story.append(gbp_table)

        story.append(Spacer(1, 10))
        story.extend(self.embed_evidence('gbp'))
        return story

    def draw_offpage_deliverables(self):
        story = []
        story.extend(self.draw_section_header("Off-Page SEO Deliverables & Activity Log", 8))

        activities = self.report.get('activity_summaries', []) or []
        if not activities:
            story.append(Paragraph("<i>No off-page deliverables or activity logs recorded for this period.</i>", self.body_style))
        else:
            act_headers = ["Activity / Deliverable", "Completed Count", "Notes / Details"]
            act_data = [[Paragraph(f"<b>{h}</b>", self.table_header_style) for h in act_headers]]

            for act in activities:
                title_val = safe_val(act.get('activity_title'))
                cnt_val = safe_num(act.get('completed_count'))
                notes_val = safe_val(act.get('notes'), '-')

                act_data.append([
                    Paragraph(f"<b>{title_val}</b>", self.table_cell_style),
                    Paragraph(cnt_val, self.table_cell_style),
                    Paragraph(notes_val, self.table_cell_style),
                ])

            act_table = Table(act_data, colWidths=[184, 100, 200], repeatRows=1)
            act_table.setStyle(TableStyle([
                ('BACKGROUND', (0,0), (-1,0), self.primary_color),
                ('GRID', (0,0), (-1,-1), 0.5, self.border_color),
                ('PADDING', (0,0), (-1,-1), 5),
                ('ROWBACKGROUNDS', (0,1), (-1,-1), [colors.white, self.card_bg]),
            ]))
            story.append(act_table)

        story.append(Spacer(1, 10))
        story.extend(self.embed_evidence('deliverables'))
        return story

    def draw_technical_seo(self):
        story = []
        story.extend(self.draw_section_header("Technical SEO Audits & Recommendations", 9))

        tech_evidence = self.embed_evidence('technical')
        if tech_evidence:
            story.extend(tech_evidence)
        else:
            story.append(Paragraph("<i>Technical audit screenshots and recommendations are summarized in the Executive Recommendations section.</i>", self.body_style))

        story.append(Spacer(1, 10))
        return story

    def draw_next_month_plan(self):
        story = []
        story.extend(self.draw_section_header("Next Month Strategic Action Plan", 10))

        plans = parse_bullet_items(self.report.get('next_month_plan'))
        if plans:
            for item in plans:
                story.append(Paragraph(f"• {item}", self.bullet_style))
        else:
            story.append(Paragraph("<i>No strategic action items recorded for next month.</i>", self.body_style))

        story.append(Spacer(1, 10))
        return story

    def generate(self, output_path):
        doc = SEOReportDocTemplate(
            output_path,
            pagesize=A4,
            leftMargin=54,
            rightMargin=54,
            topMargin=54,
            bottomMargin=54,
            media_root=self.media_root
        )

        story = []

        # 1. Cover Header (Logo & Client details)
        story.extend(self.draw_cover_header())

        # 2. Executive Summary
        story.extend(self.draw_executive_summary())

        # 3. SEO Health
        story.extend(self.draw_seo_health())

        # 4. Keyword Rankings
        story.extend(self.draw_keyword_rankings())

        # 5. GSC Performance
        story.extend(self.draw_gsc_performance())

        # 6. GSC Top Queries
        story.extend(self.draw_gsc_top_queries())

        # 7. GA4 Traffic & Channels
        story.extend(self.draw_ga4_traffic())

        # 8. GBP / Local SEO
        story.extend(self.draw_gbp_local_seo())

        # 9. Off-Page Deliverables
        story.extend(self.draw_offpage_deliverables())

        # 10. Technical SEO
        story.extend(self.draw_technical_seo())

        # 11. Next Month Plan
        story.extend(self.draw_next_month_plan())

        # Build PDF
        on_first = draw_background_factory(self.media_root)
        on_later = draw_background_later_factory(self.media_root)

        doc.build(story, onFirstPage=on_first, onLaterPages=on_later, canvasmaker=NumberedCanvas)

def main():
    if len(sys.argv) < 3:
        print("Usage: python generate_seo_report_pdf.py <input_json_path> <output_pdf_path>", file=sys.stderr)
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]

    if not os.path.exists(input_path):
        print(f"Input file not found: {input_path}", file=sys.stderr)
        sys.exit(1)

    with open(input_path, 'r', encoding='utf-8') as f:
        payload = json.load(f)

    generator = SEOReportPDFGenerator(payload)
    generator.generate(output_path)

    print(f"SEO Report PDF generated successfully: {output_path}")

if __name__ == "__main__":
    main()
