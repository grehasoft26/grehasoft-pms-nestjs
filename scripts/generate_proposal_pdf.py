import sys
import os
import json
import tempfile
import re
import shutil

from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, Frame
)
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.utils import ImageReader

TEMPLATES = {
    'corporate': {
        'primary': '#0753F6',
        'secondary': '#6B7280',
        'accent': '#1AB728',
        'font_title': 'Helvetica-Bold',
        'font_body': 'Helvetica',
        'spacing': 15,
        'bg_card': '#f8fafc',
    },
    'modern': {
        'primary': '#0f172a',
        'secondary': '#3b82f6',
        'accent': '#10b981',
        'font_title': 'Helvetica-Bold',
        'font_body': 'Helvetica',
        'spacing': 18,
        'bg_card': '#f1f5f9',
    },
    'enterprise': {
        'primary': '#1e3a8a',
        'secondary': '#3b82f6',
        'accent': '#047857',
        'font_title': 'Helvetica-Bold',
        'font_body': 'Helvetica',
        'spacing': 20,
        'bg_card': '#eff6ff',
    },
    'minimal': {
        'primary': '#000000',
        'secondary': '#4b5563',
        'accent': '#1f2937',
        'font_title': 'Helvetica-Bold',
        'font_body': 'Helvetica',
        'spacing': 12,
        'bg_card': '#ffffff',
    },
    'classic': {
        'primary': '#701a75',
        'secondary': '#a21caf',
        'accent': '#b5179e',
        'font_title': 'Helvetica-Bold',
        'font_body': 'Helvetica',
        'spacing': 16,
        'bg_card': '#fae8ff',
    }
}

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
        pass

def escape_html_except_tags(text):
    if not text:
        return ""
    text = text.replace("&", "&amp;")
    text = text.replace("<", "&lt;")
    text = text.replace(">", "&gt;")
    
    supported_tags = [
        ("b", "b"), ("i", "i"), ("u", "u"),
        ("strong", "b"), ("em", "i"),
        ("p", "p"), ("li", "li"), ("div", "div"),
        ("h1", "h1"), ("h2", "h2"), ("h3", "h3"), ("h4", "h4"), ("h5", "h5"), ("h6", "h6")
    ]
    for tag_name, target in supported_tags:
        text = text.replace(f"&lt;{tag_name}&gt;", f"<{target}>")
        text = text.replace(f"&lt;/{tag_name}&gt;", f"</{target}>")
        text = text.replace(f"&lt;{tag_name} /&gt;", f"<{target}/>")
        text = text.replace(f"&lt;{tag_name}/&gt;", f"<{target}/>")
        
    text = text.replace("&lt;br&gt;", "<br/>")
    text = text.replace("&lt;br/&gt;", "<br/>")
    text = text.replace("&lt;br /&gt;", "<br/>")
    return text

def parse_html_to_flowables(html_text, style):
    if not html_text:
        return []
    text = escape_html_except_tags(html_text.strip())
    flowables = []
    
    if not any(tag in text for tag in ['<p>', '<li>', '<div>', '<h1>', '<h2>', '<h3>', '<h4>', '<h5>', '<h6>']):
        blocks = text.split('\n')
        for block in blocks:
            block = block.strip()
            if not block:
                flowables.append(Spacer(1, 6))
                continue
            try:
                flowables.append(Paragraph(block, style))
            except Exception:
                block_clean = re.sub(r'<[^>]+>', '', block)
                try:
                    flowables.append(Paragraph(block_clean, style))
                except Exception:
                    pass
        return flowables

    blocks = re.split(r'</?(p|li|div|h1|h2|h3|h4|h5|h6)>\s*', text)
    for block in blocks:
        block = block.strip()
        if not block or block in ['p', 'li', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']:
            continue
            
        block_clean = re.sub(r'<[^>]+>', '', block)
        if not block_clean.strip():
            continue
            
        try:
            if '<' not in block:
                block = block.replace('\n', '<br/>')
            flowables.append(Paragraph(block, style))
        except Exception:
            flowables.append(Paragraph(block_clean, style))
            
    return flowables

def find_asset(media_root, filename):
    paths = [
        os.path.join(media_root, filename),
        os.path.join(media_root, "logo", filename),
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "media", filename),
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "media", "logo", filename),
        os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "grehasoft-pythonpms", "backend", "media", filename),
        os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "grehasoft-pythonpms", "backend", "media", "logo", filename)
    ]
    for p in paths:
        if os.path.exists(p):
            return p
    return None

def draw_background_factory(media_root):
    def draw_background(canvas_obj, doc):
        width, height = doc.pagesize
        watermark_path = find_asset(media_root, "grehasoftwatermark.png")
        if watermark_path and os.path.exists(watermark_path):
            canvas_obj.saveState()
            try:
                canvas_obj.setFillAlpha(0.15)
                canvas_obj.setStrokeAlpha(0.15)
            except AttributeError:
                pass
            
            try:
                from PIL import Image as PILImage
                img = PILImage.open(watermark_path)
                img_w, img_h = img.size
                
                draw_w = width * 0.65
                scale = draw_w / img_w
                draw_h = img_h * scale
                
                if draw_h > height * 0.65:
                    draw_h = height * 0.65
                    scale = draw_h / img_h
                    draw_w = img_w * scale
                
                x = (width - draw_w) / 2.0
                y = (height - draw_h) / 2.0
                
                watermark = ImageReader(watermark_path)
                canvas_obj.drawImage(watermark, x, y, width=draw_w, height=draw_h, preserveAspectRatio=True, mask='auto')
            except Exception as e:
                print("Watermark draw error:", e, file=sys.stderr)
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
                print("Header banner draw error:", e, file=sys.stderr)
            canvas_obj.restoreState()
    return draw_background_later

class ProposalDocTemplate(SimpleDocTemplate):
    def __init__(self, *args, media_root="", **kwargs):
        super().__init__(*args, **kwargs)
        self.media_root = media_root

    def build(self, flowables, onFirstPage=None, onLaterPages=None, canvasmaker=None):
        self._calc()
        frame_first = Frame(
            self.leftMargin, self.bottomMargin, 
            self.width, self.height, 
            id='first_frame',
            leftPadding=6, rightPadding=6, topPadding=6, bottomPadding=6
        )
        
        width, height = self.pagesize
        header_path = find_asset(self.media_root, "invoice_header.png")
        banner_h = 78
        if header_path and os.path.exists(header_path):
            try:
                from PIL import Image as PILImage
                img = PILImage.open(header_path)
                banner_h = width * (img.size[1] / img.size[0])
            except Exception as e:
                print("Error calculating header aspect ratio:", e, file=sys.stderr)
                
        later_top_margin = banner_h + 30
        
        frame_later = Frame(
            54, 54, width - 108, height - 54 - later_top_margin, 
            id='later_frame',
            leftPadding=6, rightPadding=6, topPadding=6, bottomPadding=6
        )
        
        from reportlab.platypus import PageTemplate
        self.addPageTemplates([
            PageTemplate(id='First', frames=frame_first, onPage=onFirstPage, pagesize=self.pagesize),
            PageTemplate(id='Later', frames=frame_later, onPage=onLaterPages, pagesize=self.pagesize)
        ])
        
        from reportlab.platypus import BaseDocTemplate
        BaseDocTemplate.build(self, flowables, canvasmaker=canvasmaker)

class ClientMock:
    def __init__(self, data):
        self.name = data.get('name', '')
        self.company_name = data.get('company_name', '')

class LeadMock:
    def __init__(self, data):
        self.name = data.get('name', '')
        self.company_name = data.get('company_name', '')

class ItemMock:
    def __init__(self, item):
        self.service = item.get('service', 'Service')
        self.description = item.get('description', '-')
        self.cost = item.get('cost', 0)

class ItemsMock:
    def __init__(self, items):
        self._items = [ItemMock(i) for i in items]
    def all(self):
        return self._items

class ProposalMock:
    def __init__(self, data):
        self.id = data.get('id')
        self.title = data.get('title', 'Project Proposal')
        self.subtotal = data.get('subtotal', 0)
        self.discount = data.get('discount', 0)
        self.amount = data.get('amount', 0)
        self.project_overview = data.get('project_overview', '')
        self.description = data.get('description', '')
        
        client_data = data.get('client')
        if isinstance(client_data, dict) and client_data:
            self.client = ClientMock(client_data)
        elif data.get('leadName') or data.get('leadEmail') or data.get('client_name'):
            self.client = ClientMock({
                'name': data.get('leadName') or data.get('client_name') or 'Valued Client',
                'company_name': data.get('leadCompany') or data.get('client_name') or 'Client Company'
            })
        else:
            self.client = None

        lead_data = data.get('lead')
        if isinstance(lead_data, dict) and lead_data:
            self.lead = LeadMock(lead_data)
        elif data.get('leadName'):
            self.lead = LeadMock({
                'name': data.get('leadName'),
                'company_name': data.get('leadCompany') or ''
            })
        else:
            self.lead = None

        items_list = data.get('items', [])
        self.items = ItemsMock(items_list)

class ProposalPDFGenerator:
    def __init__(self, proposal, builder_config=None, media_root=""):
        self.proposal = proposal
        self.builder_config = builder_config or {}
        self.media_root = media_root
        
        template_name = self.builder_config.get('template', 'corporate')
        if template_name not in TEMPLATES:
            template_name = 'corporate'
        self.tpl = dict(TEMPLATES[template_name])
        
        custom_colors = self.builder_config.get('colors', {})
        if custom_colors.get('primary'):
            self.tpl['primary'] = custom_colors['primary']
        if custom_colors.get('secondary'):
            self.tpl['secondary'] = custom_colors['secondary']

        self.styles = getSampleStyleSheet()
        
        self.title_style = ParagraphStyle(
            'PropTitle',
            parent=self.styles['Normal'],
            fontName=self.tpl['font_title'],
            fontSize=28,
            leading=32,
            textColor=colors.HexColor(self.tpl['primary'])
        )
        
        self.heading1_style = ParagraphStyle(
            'PropH1',
            parent=self.styles['Heading1'],
            fontName=self.tpl['font_title'],
            fontSize=22,
            leading=26,
            textColor=colors.HexColor(self.tpl['primary']),
            spaceAfter=12
        )

        self.heading2_style = ParagraphStyle(
            'PropH2',
            parent=self.styles['Heading2'],
            fontName=self.tpl['font_title'],
            fontSize=16,
            leading=20,
            textColor=colors.HexColor(self.tpl['secondary']),
            spaceAfter=8
        )
        
        self.body_style = ParagraphStyle(
            'PropBody',
            parent=self.styles['Normal'],
            fontName=self.tpl['font_body'],
            fontSize=12,
            leading=16,
            textColor=colors.HexColor('#2d3748'),
            spaceAfter=10
        )

        self.meta_style = ParagraphStyle(
            'PropMeta',
            parent=self.body_style,
            fontSize=11,
            leading=15,
            textColor=colors.HexColor('#718096')
        )

        self.cover_title_style = ParagraphStyle(
            'CoverTitle',
            parent=self.styles['Normal'],
            fontName=self.tpl['font_title'],
            fontSize=44,
            leading=50,
            alignment=1, 
            textColor=colors.HexColor(self.tpl['primary']),
            spaceAfter=30
        )
        
        self.cover_subtitle_style = ParagraphStyle(
            'CoverSubtitle',
            parent=self.styles['Normal'],
            fontName=self.tpl['font_body'],
            fontSize=24,
            leading=28,
            alignment=1,
            textColor=colors.HexColor(self.tpl['secondary']),
            spaceAfter=30
        )
        
        self.meta_label_style = ParagraphStyle(
            'CoverMetaLabel',
            parent=self.styles['Normal'],
            fontName=self.tpl['font_title'],
            fontSize=16,
            leading=20,
            alignment=0, 
            textColor=colors.HexColor('#1F2937'),
            spaceAfter=6
        )
        
        self.meta_content_style = ParagraphStyle(
            'CoverMetaContent',
            parent=self.styles['Normal'],
            fontName=self.tpl['font_body'],
            fontSize=13,
            leading=17,
            alignment=0, 
            textColor=colors.HexColor('#6B7280')
        )

    def draw_cover_page(self):
        story = []
        cover_conf = self.builder_config.get('cover_page', {})
        
        logo_path = find_asset(self.media_root, "grehasoftlogo.png")
        try:
            if logo_path and os.path.exists(logo_path):
                from PIL import Image as PILImage
                from reportlab.platypus import Image
                
                img = PILImage.open(logo_path)
                original_width, original_height = img.size
                
                logo_width = 320
                logo_height = logo_width * (original_height / original_width)
                
                logo = Image(logo_path, width=logo_width, height=logo_height)
                logo.hAlign = 'CENTER'
                story.append(logo)
            else:
                story.append(Spacer(1, 60))
        except Exception as e:
            print("Logo drawing error:", e, file=sys.stderr)
            story.append(Spacer(1, 60))

        cover_title = cover_conf.get('title', '').strip()
        if not cover_title:
            project_title = (self.proposal.title or "").strip()
            if project_title.lower().endswith("proposal"):
                cover_title = project_title
            else:
                cover_title = f"{project_title} Proposal"

        green_color = '#047857'
        blue_color = '#0753F6'

        title_style = ParagraphStyle(
            'CoverTitleCustom',
            parent=self.cover_title_style,
            textColor=colors.HexColor(green_color)
        )
        story.append(Paragraph(f"<u>{cover_title}</u>", title_style))
        
        show_sub = cover_conf.get('showSubtitle', True)
        sub_text = cover_conf.get('subtitle', '').strip()
        if show_sub and sub_text:
            sub_style = ParagraphStyle(
                'CoverSubtitleCustom',
                parent=self.cover_subtitle_style,
                textColor=colors.HexColor(blue_color)
            )
            story.append(Spacer(1, 10))
            story.append(Paragraph(sub_text, sub_style))
            
        story.append(Spacer(1, 60))
        
        client_name = cover_conf.get('preparedForName', '').strip()
        if not client_name:
            client_name = self.proposal.client.name if self.proposal.client else ((self.proposal.lead.name if self.proposal.lead else None) or "Valued Client")
            
        client_company = cover_conf.get('preparedForCompany', '').strip()
        if not client_company:
            client_company = self.proposal.client.company_name if self.proposal.client else ""
            if not client_company:
                client_company = "Client Company"

        by_company = cover_conf.get('preparedByCompany', '').strip() or "Grehasoft Smart IT Solutions"
        by_address = cover_conf.get('preparedByAddress', '').strip() or "Kochi, Kerala"
        by_email = cover_conf.get('preparedByEmail', '').strip() or "info@grehasoft.com"
        by_website = cover_conf.get('preparedByWebsite', '').strip() or "www.grehasoft.com"

        doc_date = cover_conf.get('proposalDate', '').strip()
        if not doc_date:
            import datetime
            doc_date = datetime.date.today().strftime("%d-%m-%Y")
            
        place = cover_conf.get('place', '').strip() or "Kochi"

        lbl_style = ParagraphStyle(
            'CoverLblBlack',
            parent=self.meta_label_style,
            alignment=0,
            textColor=colors.HexColor('#1F2937'),
            spaceAfter=4
        )
        content_blue_style = ParagraphStyle(
            'CoverContentBlue',
            parent=self.meta_content_style,
            alignment=0,
            textColor=colors.HexColor(blue_color),
            spaceAfter=20
        )
        content_green_style = ParagraphStyle(
            'CoverContentGreen',
            parent=self.meta_content_style,
            alignment=0,
            textColor=colors.HexColor(green_color),
            spaceAfter=25
        )

        story.append(Paragraph("<u>Prepared For:</u>", lbl_style))
        prepared_for_text = f"<b>{client_company}</b><br/>{client_name}" if client_name != client_company else f"<b>{client_company}</b>"
        if client_name.lower() in client_company.lower():
            prepared_for_text = f"<b>{client_company}</b>"
        story.append(Paragraph(prepared_for_text, content_blue_style))
        
        story.append(Paragraph("<u>Prepared By:</u>", lbl_style))
        by_details = f"<b>{by_company}</b>,<br/>{by_address}.<br/>Website: {by_website}<br/>Email: {by_email}"
        story.append(Paragraph(by_details, content_green_style))
        
        date_place_style = ParagraphStyle(
            'CoverDatePlace',
            parent=self.meta_content_style,
            alignment=0,
            textColor=colors.HexColor('#1F2937'),
            spaceAfter=4
        )
        story.append(Paragraph(f"<b>DATE:</b> <font color='{blue_color}'>{doc_date}</font>", date_place_style))
        story.append(Paragraph(f"<b>PLACE:</b> <font color='{blue_color}'>{place}</font>", date_place_style))

        return story

    def draw_cover_letter(self):
        story = []
        letter_content = self.builder_config.get('cover_letter', "")
        if not letter_content:
            letter_content = (
                "<p>Dear Sir/Madam,</p>"
                "<p>Thank you for considering Grehasoft for your website development needs. As discussed, we have reviewed your requirements and are pleased to submit this proposal for your consideration.</p>"
                "<p>At Grehasoft, we understand the challenges of finding the right technology partner for branding, website development, digital marketing, and software solutions. Our top priority is client satisfaction, and we are committed to delivering high-quality, scalable, and future-ready solutions using the latest technologies and industry best practices.</p>"
                "<p>Throughout the project, our experienced team will work closely with you to ensure that every requirement is understood and implemented with precision. We are also committed to providing dedicated support during our working hours, ensuring that your queries and concerns are addressed promptly and professionally.</p>"
                "<p>Thank you for considering Grehasoft as your technology partner. We look forward to the opportunity to collaborate with you and build a successful long-term business relationship.</p>"
                "<p>Best Regards,</p>"
                "<p>Raji T. Skariah<br/>"
                "Grehasoft<br/>"
                "+91 89215 40 183 | +91 98950 72 145<br/>"
                "info@grehasoft.com | grehasoft@gmail.com</p>"
            )
            
        client_name = ""
        company_name = ""
        if self.proposal.client:
            client_name = self.proposal.client.name or ""
            company_name = self.proposal.client.company_name or ""
        elif self.proposal.lead:
            client_name = self.proposal.lead.name or ""
            company_name = self.proposal.lead.company_name or ""
            
        project_name = self.proposal.title or "Project"
        proposal_title = self.proposal.title or "Proposal"
        
        letter_content = letter_content.replace("{client_name}", client_name or "Client")
        letter_content = letter_content.replace("{company_name}", company_name or "Client Company")
        letter_content = letter_content.replace("{project_name}", project_name)
        letter_content = letter_content.replace("{proposal_title}", proposal_title)
            
        story.extend(parse_html_to_flowables(letter_content, self.body_style))
        return story

    def draw_company_profile(self):
        story = []
        story.append(Paragraph("Company Profile", self.heading1_style))
        story.append(Spacer(1, 10))
        
        profile_content = self.builder_config.get('company_profile', "")
        if not profile_content:
            profile_content = (
                "<p>Grehasoft Smart IT Solutions is an enterprise software development agency based in Kochi, Infopark. "
                "We provide comprehensive mobile app, web application, branding, and digital marketing services to clients worldwide.</p>"
                "<p>Our dedicated team of professionals strives to build scalable solutions using state-of-the-art frameworks.</p>"
            )
            
        story.extend(parse_html_to_flowables(profile_content, self.body_style))
        return story

    def draw_project_overview(self):
        story = []
        story.append(Paragraph("Project Overview", self.heading1_style))
        story.append(Spacer(1, 10))
        
        overview_content = self.builder_config.get('project_overview', self.proposal.project_overview)
        if not overview_content:
            overview_content = "<p>Provide a brief outline of the project objectives and scope here.</p>"
            
        story.extend(parse_html_to_flowables(overview_content, self.body_style))
        return story

    def draw_scope_of_work(self):
        story = []
        story.append(Paragraph("Scope of Work", self.heading1_style))
        story.append(Spacer(1, 10))
        
        scope_content = self.builder_config.get('scope_of_work', self.proposal.description)
        if not scope_content:
            scope_content = "<p>Outline the features, architecture, and constraints of the work to be completed here.</p>"
            
        story.extend(parse_html_to_flowables(scope_content, self.body_style))
        return story

    def draw_website_structure(self):
        story = []
        story.append(Paragraph("Proposed Website Structure & Pages", self.heading1_style))
        story.append(Spacer(1, 10))
        
        content = self.builder_config.get('website_structure', "")
        if content:
            story.extend(parse_html_to_flowables(content, self.body_style))
        return story

    def draw_deliverables(self):
        story = []
        story.append(Paragraph("Project Deliverables & Milestones", self.heading1_style))
        story.append(Spacer(1, 10))
        
        delivs = self.builder_config.get('deliverables', [])
        if not delivs:
            delivs = [
                {"phase": "Phase 1: Wireframes", "timeline": "Week 1", "details": "Initial layout mockups, user flow, and design review."},
                {"phase": "Phase 2: Core Development", "timeline": "Week 2-3", "details": "Frontend UI elements, backend database, and REST APIs."},
                {"phase": "Phase 3: UAT & Launch", "timeline": "Week 4", "details": "Unit testing, client acceptance testing, server deployment."}
            ]
            
        table_data = [["Phase / Milestone", "Timeline", "Deliverables / Details"]]
        for d in delivs:
            d_phase = escape_html_except_tags(d.get('phase', ''))
            d_timeline = escape_html_except_tags(d.get('timeline', ''))
            d_details = escape_html_except_tags(d.get('details', ''))
            table_data.append([
                Paragraph(f"<b>{d_phase}</b>", self.body_style),
                Paragraph(d_timeline, self.body_style),
                Paragraph(d_details, self.body_style)
            ])
            
        delivs_table = Table(table_data, colWidths=[120, 80, 280])
        delivs_table.setStyle(TableStyle([
            ('GRID', (0,0), (-1,-1), 0.5, colors.HexColor('#cbd5e1')),
            ('BACKGROUND', (0,0), (-1,0), colors.HexColor(self.tpl['primary'])),
            ('TEXTCOLOR', (0,0), (-1,0), colors.white),
            ('FONTNAME', (0,0), (-1,0), self.tpl['font_title']),
            ('VALIGN', (0,0), (-1,-1), 'TOP'),
            ('BOTTOMPADDING', (0,0), (-1,-1), 6),
            ('TOPPADDING', (0,0), (-1,-1), 6),
        ]))
        
        story.append(delivs_table)
        return story

    def draw_timeline(self):
        story = []
        story.append(Paragraph("Implementation Timeline", self.heading1_style))
        story.append(Spacer(1, 10))
        
        timeline_text = self.builder_config.get('timeline', "")
        if not timeline_text:
            timeline_text = (
                "<p>The estimated delivery timeline is 4-6 weeks upon contract signoff and advance payment. "
                "Any change in scope may affect this estimate.</p>"
            )
            
        story.extend(parse_html_to_flowables(timeline_text, self.body_style))
        return story

    def draw_pricing(self):
        story = []
        story.append(Paragraph("Financial Investment", self.heading1_style))
        story.append(Spacer(1, 10))
        
        pricing_data = [["Service Item", "Description", "Cost (INR)"]]
        
        pricing_conf = self.builder_config.get('pricing', {})
        custom_items = pricing_conf.get('items', [])
        
        subtotal = float(pricing_conf.get('subtotal', self.proposal.subtotal or 0))
        discount = float(pricing_conf.get('discount', self.proposal.discount or 0))
        grand_total = float(pricing_conf.get('amount', self.proposal.amount or 0))
        
        if custom_items:
            for item in custom_items:
                cost_val = float(item.get('cost', 0))
                service_val = escape_html_except_tags(item.get('service', 'Service'))
                desc_val = escape_html_except_tags(item.get('description') or "-")
                pricing_data.append([
                    Paragraph(f"<b>{service_val}</b>", self.body_style),
                    Paragraph(desc_val, self.body_style),
                    f"Rs {cost_val:,.2f}"
                ])
        else:
            for item in self.proposal.items.all():
                service_val = escape_html_except_tags(item.service)
                desc_val = escape_html_except_tags(item.description or "-")
                pricing_data.append([
                    Paragraph(f"<b>{service_val}</b>", self.body_style),
                    Paragraph(desc_val, self.body_style),
                    f"Rs {float(item.cost):,.2f}"
                ])
                
        if not custom_items and len(self.proposal.items.all()) == 0:
            title_val = escape_html_except_tags(self.proposal.title)
            pricing_data.append([
                Paragraph(f"<b>{title_val}</b>", self.body_style),
                Paragraph("Professional development services", self.body_style),
                f"Rs {grand_total:,.2f}"
            ])
            
        pricing_data.append(["", "Subtotal", f"Rs {subtotal:,.2f}"])
        pricing_data.append(["", "Discount", f"Rs {discount:,.2f}"])
        pricing_data.append(["", "Grand Total", f"Rs {grand_total:,.2f}"])
        
        pricing_table = Table(pricing_data, colWidths=[150, 230, 100])
        pricing_table.setStyle(TableStyle([
            ('GRID', (0,0), (-1, -4), 0.5, colors.HexColor('#cbd5e1')),
            ('BACKGROUND', (0,0), (-1,0), colors.HexColor(self.tpl['primary'])),
            ('TEXTCOLOR', (0,0), (-1,0), colors.white),
            ('FONTNAME', (0,0), (-1,0), self.tpl['font_title']),
            ('ALIGN', (2, 1), (2, -1), 'RIGHT'),
            ('VALIGN', (0,0), (-1,-1), 'TOP'),
            ('FONTNAME', (1, -3), (2, -1), self.tpl['font_title']),
            ('BACKGROUND', (1, -1), (2, -1), colors.HexColor(self.tpl['bg_card'])),
            ('BOX', (1, -1), (2, -1), 1, colors.HexColor(self.tpl['primary'])),
            ('BOTTOMPADDING', (0,0), (-1,-1), 8),
            ('TOPPADDING', (0,0), (-1,-1), 8),
        ]))
        
        story.append(pricing_table)
        return story

    def draw_payment_terms(self):
        story = []
        story.append(Paragraph("Payment Terms & Schedule", self.heading1_style))
        story.append(Spacer(1, 10))
        
        schedule = self.builder_config.get('payment_terms', {})
        adv = schedule.get('advance', 50)
        dev = schedule.get('development', 30)
        dep = schedule.get('deployment', 20)
        
        story.append(Paragraph(
            f"The payment for the project is scheduled as follows:<br/>"
            f"• <b>{adv}% Advance:</b> payable immediately to kick off the development.<br/>"
            f"• <b>{dev}% Development Milestone:</b> payable upon completion of core modules.<br/>"
            f"• <b>{dep}% Final Deployment:</b> payable prior to launching the production workspace.",
            self.body_style
        ))
        return story

    def draw_additional_charges(self):
        story = []
        story.append(Paragraph("Additional Charges", self.heading1_style))
        story.append(Spacer(1, 15))
        
        table_data = [
            ["Item", "Description", "Cost"],
            [
                Paragraph("<b>1. Domain & Hosting</b>", self.body_style),
                Paragraph(
                    "• The client may independently purchase the domain name and provide the login credentials for deployment.<br/>"
                    "• Alternatively, Grehasoft can register the domain on behalf of the client.<br/>"
                    "• Website hosting will be provided through Grehasoft's reseller hosting infrastructure.<br/>"
                    "• The website will be securely deployed, maintained and hosted.",
                    self.body_style
                ),
                Paragraph("Starts from ₹5,000 per year.", self.body_style)
            ],
            [
                Paragraph("<b>2. SSL Certificate</b>", self.body_style),
                Paragraph(
                    "If a free SSL certificate is used, no additional charge applies.<br/>"
                    "If the client requires a premium SSL certificate, it must be purchased separately by the client.",
                    self.body_style
                ),
                Paragraph("-", self.body_style)
            ]
        ]
        
        charges_table = Table(table_data, colWidths=[120, 240, 120])
        charges_table.setStyle(TableStyle([
            ('GRID', (0,0), (-1,-1), 0.5, colors.HexColor('#cbd5e1')),
            ('BACKGROUND', (0,0), (-1,0), colors.HexColor(self.tpl['primary'])),
            ('TEXTCOLOR', (0,0), (-1,0), colors.white),
            ('FONTNAME', (0,0), (-1,0), self.tpl['font_title']),
            ('VALIGN', (0,0), (-1,-1), 'TOP'),
            ('BOTTOMPADDING', (0,0), (-1,-1), 8),
            ('TOPPADDING', (0,0), (-1,-1), 8),
            ('LEFTPADDING', (0,0), (-1,-1), 8),
            ('RIGHTPADDING', (0,0), (-1,-1), 8),
        ]))
        
        story.append(charges_table)
        return story

    def draw_maintenance_cost(self):
        story = []
        story.append(Paragraph("3. Maintenance Cost", self.heading1_style))
        
        grey_style = ParagraphStyle(
            'MaintSubtitle',
            parent=self.body_style,
            fontName=f"{self.tpl['font_body']}-Oblique" if self.tpl['font_body'] == 'Helvetica' else self.tpl['font_body'],
            textColor=colors.HexColor('#6B7280'),
            spaceAfter=15
        )
        story.append(Paragraph("(* If required by the client only)", grey_style))
        
        services_text = (
            "Maintenance services include:<br/>"
            "• Security Updates<br/>"
            "• Plugin Updates<br/>"
            "• Theme Updates<br/>"
            "• Content Updates<br/>"
            "• Backup & Disaster Recovery<br/>"
            "• User Management"
        )
        story.append(Paragraph(services_text, self.body_style))
        story.append(Spacer(1, 10))
        
        pricing_text = (
            "<b>Pricing</b><br/>"
            "• Yearly Advance: ₹25,000<br/>"
            "• Quarterly Advance: ₹7,000<br/>"
            "• Monthly: ₹3,000"
        )
        story.append(Paragraph(pricing_text, self.body_style))
        story.append(Spacer(1, 15))
        
        note_style = ParagraphStyle(
            'MaintNote',
            parent=self.body_style,
            fontName=self.tpl['font_body'],
            backColor=colors.HexColor(self.tpl['bg_card']),
            borderColor=colors.HexColor('#cbd5e1'),
            borderWidth=1,
            borderPadding=10,
            spaceBefore=10,
            spaceAfter=10
        )
        note_text = (
            "If the client does not opt for any maintenance plan, "
            "future maintenance requests will be charged based on functionality "
            "or development time at ₹500/hour."
        )
        story.append(Paragraph(note_text, note_style))
        
        return story

    def draw_terms_conditions(self):
        story = []
        story.append(Paragraph("TERMS AND CONDITIONS", self.heading1_style))
        story.append(Spacer(1, 10))
        
        pt = self.builder_config.get('payment_terms', {'advance': 50, 'development': 30, 'deployment': 20})
        adv = pt.get('advance', 50)
        dev = pt.get('development', 30)
        dep = pt.get('deployment', 20)
        
        clauses = [
            (
                "1. Payment Terms",
                f"The payment for the project is scheduled as follows:<br/>"
                f"• <b>{adv}% Advance:</b> payable immediately to kick off the development.<br/>"
                f"• <b>{dev}% Development Milestone:</b> payable upon completion of core modules.<br/>"
                f"• <b>{dep}% Final Deployment:</b> payable prior to launching the production workspace."
            ),
            (
                "2. Project Scope & Costs",
                "• The costs outlined in this proposal are based on the requirements discussed. Any changes, additions, or modifications to the scope of work after the commencement of the project will be treated as extra work and charged separately.<br/>"
                "• In case of scope changes, a revised quote will be provided for approval before implementation."
            ),
            (
                "3. Scope Limitation",
                "• Information Website only.<br/>"
                "• No custom systems.<br/>"
                "• Additional features will be quoted separately."
            ),
            (
                "4. Design & Banner Images Policy",
                "• Royalty-free images will be utilized for website design.<br/>"
                "• AI-generated images may be used to enhance the website aesthetics.<br/>"
                "• Homepage banner revisions are limited to the revision cycle.<br/>"
                "• Section image revisions will be handled as part of the overall design revisions."
            ),
            (
                "5. Client Provided Images",
                "• The client must provide high-quality images and assets.<br/>"
                "• Grehasoft is not responsible for the poor rendering of low-resolution or poor-quality client-provided images.<br/>"
                "• Any necessary edits or replacements of client-provided images must be supplied by the client."
            ),
            (
                "6. Design",
                "• One initial design concept will be presented to the client.<br/>"
                "• Up to two free revisions are included in the project cost.<br/>"
                "• Additional revisions beyond the two free rounds are chargeable."
            ),
            (
                "7. Client Responsibilities",
                "• The client must provide all content, text, logos, branding assets, images, and other materials in a timely manner.<br/>"
                "• Delays in providing materials or feedback will result in corresponding delays in the project timeline.<br/>"
                "• The client must verify and approve milestones promptly to ensure progress."
            ),
            (
                "8. E-Commerce Website Requirements",
                "• Client provides the product list, description, pricing, and images.<br/>"
                "• For e-commerce websites, initial upload includes a maximum of 50 products. Extra products will be charged at ₹75 per product."
            ),
            (
                "9. Third-Party Integrations",
                "• Third-party integrations such as CRM integrations and marketing tools will be configured as per requirements.<br/>"
                "• All third-party subscription costs (e.g., APIs, CRM licenses, premium tools) are to be borne directly by the client.<br/>"
                "• SSL integration is included. Premium SSL certificates must be purchased separately by the client."
            ),
            (
                "10. Multimedia & Content Embeds",
                "• Multimedia content like videos should be uploaded by the client to third-party platforms (e.g., YouTube).<br/>"
                "• Grehasoft will embed these videos on the website using YouTube URLs provided by the client."
            ),
            (
                "11. Legal & Copyright Compliance",
                "• The client is responsible for obtaining necessary licenses and permissions for all content, text, images, and logos supplied to Grehasoft.<br/>"
                "• Grehasoft is not liable for any copyright infringement or legal issues arising from client-provided materials.<br/>"
                "• The website will include standard copyright notice and disclaimer unless otherwise specified."
            ),
            (
                "12. Project Timeline & Communication",
                "• The project timeline is dependent on prompt communication and feedback from the client.<br/>"
                "• Approvals for designs or milestones must be provided within 3 business days. Delays in communication will extend the project timeline."
            ),
            (
                "13. Portfolio Rights",
                "• Grehasoft reserves the right to showcase the completed website, design, and case study in its portfolio, website, marketing materials, and social media channels unless otherwise agreed in writing."
            ),
            (
                "14. Proposal Validity",
                "• This proposal remains valid for three (3) months from submission."
            ),
            (
                "15. Support & Availability",
                "• Support channels: Phone, WhatsApp, Botim, Email, Messenger.<br/>"
                "• Support Hours: 9:00 AM – 6:00 PM IST.<br/>"
                "• Working Days only."
            )
        ]
        
        for title, text in clauses:
            clause_style_title = ParagraphStyle(
                'ClauseTitle',
                parent=self.heading2_style,
                fontSize=13,
                leading=16,
                spaceBefore=8,
                spaceAfter=4,
                keepWithNext=True
            )
            story.append(Paragraph(title, clause_style_title))
            story.append(Paragraph(text, self.body_style))
            
        story.append(Spacer(1, 20))
        
        wish_style = ParagraphStyle(
            'WishHeading',
            parent=self.heading1_style,
            fontSize=16,
            leading=20,
            textColor=colors.HexColor(self.tpl['primary']),
            spaceBefore=15,
            spaceAfter=15,
            keepWithNext=True
        )
        story.append(Paragraph("WISHING YOU A GREAT DAY!!", wish_style))
        
        doc_date = self.builder_config.get('cover_page', {}).get('proposalDate', '').strip()
        if not doc_date:
            import datetime
            doc_date = datetime.date.today().strftime("%d-%m-%Y")
            
        left_text = (
            "<b>RAJI T. SKARIAH</b><br/>"
            "+91 89215 40 183 | +91 98950 72 145<br/>"
            "info@grehasoft.com | grehasoft@gmail.com"
        )
        right_text = f"<b>{doc_date}</b>"
        
        sig_col_style = ParagraphStyle(
            'SigColumn',
            parent=self.body_style,
            fontSize=11,
            leading=15,
            textColor=colors.HexColor('#2d3748')
        )
        right_align_style = ParagraphStyle(
            'SigColumnRight',
            parent=sig_col_style,
            alignment=2
        )
        
        sig_table = Table([[
            Paragraph(left_text, sig_col_style),
            Paragraph(right_text, right_align_style)
        ]], colWidths=[320, 160])
        
        sig_table.setStyle(TableStyle([
            ('VALIGN', (0,0), (-1,-1), 'TOP'),
            ('LEFTPADDING', (0,0), (-1,-1), 0),
            ('RIGHTPADDING', (0,0), (-1,-1), 0),
            ('BOTTOMPADDING', (0,0), (-1,-1), 0),
            ('TOPPADDING', (0,0), (-1,-1), 0),
        ]))
        
        story.append(sig_table)
            
        return story

    def generate_pdf(self):
        tmp_file = tempfile.NamedTemporaryFile(delete=False, suffix=".pdf")
        tmp_file.close()
        
        doc = ProposalDocTemplate(
            tmp_file.name,
            pagesize=A4,
            leftMargin=54,
            rightMargin=54,
            topMargin=54,
            bottomMargin=54,
            media_root=self.media_root
        )
        
        story = []
        raw_sections = self.builder_config.get('sections', [])
        
        sections = []
        def was_enabled(sid):
            if not raw_sections:
                return True
            return sid in raw_sections
            
        if was_enabled("cover"):
            sections.append("cover")
        if was_enabled("cover_letter"):
            sections.append("cover_letter")
        if was_enabled("overview") or was_enabled("project_overview"):
            sections.append("project_overview")
        if was_enabled("scope") or was_enabled("scope_of_work"):
            sections.append("scope_of_work")
        if was_enabled("features") or was_enabled("website_structure"):
            sections.append("website_structure")
        if was_enabled("deliverables"):
            sections.append("deliverables")
        if was_enabled("pricing"):
            sections.append("pricing")
            
        sections.extend(["additional_charges", "maintenance_cost", "terms_conditions"])
        
        for section_id in sections:
            section_story = []
            if section_id == "cover":
                section_story = self.draw_cover_page()
            elif section_id == "cover_letter":
                section_story = self.draw_cover_letter()
            elif section_id == "project_overview":
                section_story = self.draw_project_overview()
            elif section_id == "scope_of_work":
                section_story = self.draw_scope_of_work()
            elif section_id == "website_structure":
                section_story = self.draw_website_structure()
            elif section_id == "deliverables":
                section_story = self.draw_deliverables()
            elif section_id == "pricing":
                section_story = self.draw_pricing()
            elif section_id == "additional_charges":
                section_story = self.draw_additional_charges()
            elif section_id == "maintenance_cost":
                section_story = self.draw_maintenance_cost()
            elif section_id == "terms_conditions":
                section_story = self.draw_terms_conditions()
                
            if section_story:
                story.extend(section_story)
                if section_id != sections[-1]:
                    story.append(PageBreak())
                    
        doc.build(
            story, 
            onFirstPage=draw_background_factory(self.media_root), 
            onLaterPages=draw_background_later_factory(self.media_root), 
            canvasmaker=NumberedCanvas
        )
        
        return tmp_file.name

def main():
    if len(sys.argv) < 3:
        print("Usage: python generate_proposal_pdf.py <json_input_file> <output_pdf_file>", file=sys.stderr)
        sys.exit(1)
        
    input_file = sys.argv[1]
    output_file = sys.argv[2]
    
    with open(input_file, 'r', encoding='utf-8') as f:
        data = json.load(f)
        
    proposal_data = data.get('proposal', {})
    builder_config = data.get('builder_config', {})
    media_root = data.get('media_root', '')
    
    proposal_mock = ProposalMock(proposal_data)
    generator = ProposalPDFGenerator(proposal_mock, builder_config, media_root=media_root)
    
    pdf_temp_path = generator.generate_pdf()
    shutil.copyfile(pdf_temp_path, output_file)
    try:
        os.remove(pdf_temp_path)
    except Exception:
        pass
    print("SUCCESS")

if __name__ == '__main__':
    main()
