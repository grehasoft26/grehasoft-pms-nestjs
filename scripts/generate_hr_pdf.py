import sys
import os
import json
from io import BytesIO
from decimal import Decimal
from typing import Any, Dict

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import Paragraph
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

def setup_poppins_fonts():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    fonts_dir = os.path.join(script_dir, "fonts")
    
    reg_path = os.path.join(fonts_dir, "Poppins-Regular.ttf")
    med_path = os.path.join(fonts_dir, "Poppins-Medium.ttf")
    bold_path = os.path.join(fonts_dir, "Poppins-Bold.ttf")

    if os.path.exists(reg_path):
        pdfmetrics.registerFont(TTFont("Poppins", reg_path))
    if os.path.exists(med_path):
        pdfmetrics.registerFont(TTFont("Poppins-Medium", med_path))
    if os.path.exists(bold_path):
        pdfmetrics.registerFont(TTFont("Poppins-Bold", bold_path))

# ---------------- MONEY FORMAT ----------------
def _money(value: Any) -> str:
    try:
        return f"{Decimal(value):,.2f}"
    except Exception:
        return str(value or 0)

# ---------------- HEADER + WATERMARK + FOOTER ----------------
def draw_hr_document_template(p, width, height, media_root):
    setup_poppins_fonts()
    # Header
    header_path = os.path.join(media_root, 'logo', 'invoice_header.png')
    if os.path.exists(header_path):
        p.drawImage(header_path, 0, height - 90, width=width, height=90, mask='auto')

    # Watermark
    logo_path = os.path.join(media_root, 'icons', 'logo.png')
    if os.path.exists(logo_path):
        p.saveState()
        p.setFillAlpha(0.06)
        p.drawImage(logo_path, width/2 - 220, height/2 - 220, width=420, height=440, mask='auto')
        p.restoreState()

    # Footer line
    p.setStrokeColor(HexColor("#1AB728"))
    p.setLineWidth(2)
    p.line(50, 60, width - 50, 60)

    # Footer text
    p.setFillColor(HexColor("#05044A"))
    p.setFont("Poppins", 9)
    p.drawCentredString(width/2, 40, "Grehasoft | Infopark, Kochi | www.grehasoft.com")

# ---------------- SIGNATURE + SEAL ----------------
def draw_signature_block(p, context, width, media_root):
    SIGN_X = 70
    SIGN_Y = 200

    p.setFillColor(HexColor("#000000"))
    p.setFont("Poppins-Bold", 11)
    p.drawString(SIGN_X, SIGN_Y, str(context.get("hr_name", "Authorized Signatory")))

    p.setFont("Poppins", 11)
    p.drawString(SIGN_X, SIGN_Y - 15, "HR Manager")
    p.drawString(SIGN_X, SIGN_Y - 30, "GREHASOFT, Infopark, Kochi")

    p.drawString(SIGN_X, 120, "Place: Kochi")
    p.drawString(SIGN_X, 105, f"Date: {context.get('date') or context.get('issue_date') or ''}")

    # Seal beside signature
    seal_path = os.path.join(media_root, 'icons', 'seal.png')
    if os.path.exists(seal_path):
        p.drawImage(seal_path, 250, 135, width=130, height=110, mask='auto')

# ---------------- ROLE CONTENT ----------------
def get_role_responsibility(role):
    role = (role or "").lower()

    if "software" in role or "developer" in role:
        return """
The employee was responsible for developing, testing, debugging, and maintaining web applications.
They worked with modern technologies and contributed to various stages of the software development lifecycle.
"""
    elif "seo" in role:
        return """
The employee was responsible for handling Search Engine Optimization (SEO) activities including
keyword research, on-page SEO, off-page SEO, link building, and performance tracking.
"""
    elif "wordpress" in role:
        return """
The employee was responsible for WordPress website development including theme customization,
plugin integration, website maintenance, and website performance optimization.
"""
    elif "digital marketing" in role:
        return """
The employee was responsible for digital marketing activities including social media management,
content marketing, SEO, and online marketing campaigns.
"""
    else:
        return """
The employee handled assigned responsibilities sincerely and professionally and completed all tasks on time.
"""

def get_internship_content(role):
    role = (role or "").lower()

    if "software" in role:
        return """
During the internship period, the intern was involved in software development tasks including coding,
debugging, testing, and assisting in project development activities.
"""
    elif "seo" in role:
        return """
During the internship period, the intern worked on SEO activities including keyword research,
on-page SEO, off-page SEO, and link building.
"""
    elif "wordpress" in role:
        return """
During the internship period, the intern worked on WordPress development including theme customization,
plugin setup, website updates, and optimization.
"""
    elif "digital marketing" in role:
        return """
During the internship period, the intern worked on digital marketing activities including social media
management, content creation, and online marketing support.
"""
    else:
        return """
During the internship period, the intern demonstrated sincerity, dedication, and professionalism in assigned tasks.
"""

# ---------------- INTERNSHIP CERTIFICATE ----------------
def build_internship_certificate_pdf(context, media_root):
    buf = BytesIO()
    p = canvas.Canvas(buf, pagesize=A4)
    width, height = A4
    draw_hr_document_template(p, width, height, media_root)

    LEFT = 70
    CONTENT_WIDTH = width - 140
    y = height - 200

    p.setFillColor(HexColor("#000000"))
    p.setFont("Poppins-Bold", 18)
    p.drawCentredString(width / 2, y, "INTERNSHIP CERTIFICATE")
    y -= 50

    styles = getSampleStyleSheet()
    style = styles["Normal"]
    style.fontName = "Poppins"
    style.fontSize = 12
    style.leading = 18

    role_content = get_internship_content(context.get("position"))

    body_text = f"""
    This is to certify that <b>{context.get('intern_name', '')}</b> from <b>{context.get('college_name', '')}</b> 
    has successfully completed an internship as <b>{context.get('position', '')}</b> at <b>GREHASOFT</b> 
    from <b>{context.get('start_date', '')}</b> to <b>{context.get('end_date', '')}</b>.<br/><br/>

    {role_content}<br/><br/>

    The intern was hardworking, punctual, and showed a positive attitude towards learning and teamwork.<br/><br/>

    We wish them all the very best in their future career and professional endeavors.
    """

    para = Paragraph(body_text, style)
    para.wrapOn(p, CONTENT_WIDTH, height)
    para.drawOn(p, LEFT, y - para.height)

    draw_signature_block(p, context, width, media_root)

    p.showPage()
    p.save()
    buf.seek(0)
    return buf.getvalue()

# ---------------- EXPERIENCE CERTIFICATE ----------------
def build_experience_certificate_pdf(context, media_root):
    buf = BytesIO()
    p = canvas.Canvas(buf, pagesize=A4)
    width, height = A4
    draw_hr_document_template(p, width, height, media_root)

    LEFT = 70
    CONTENT_WIDTH = width - 140
    y = height - 200

    p.setFillColor(HexColor("#000000"))
    p.setFont("Poppins-Bold", 18)
    p.drawCentredString(width / 2, y, "EXPERIENCE CERTIFICATE")
    y -= 50

    styles = getSampleStyleSheet()
    style = styles["Normal"]
    style.fontName = "Poppins"
    style.fontSize = 12
    style.leading = 18

    role_content = get_role_responsibility(context.get("role"))

    body_text = f"""
    This is to certify that <b>{context.get('employee_name', '')}</b> was employed with <b>GREHASOFT</b> 
    as a <b>{context.get('role', '')}</b> from <b>{context.get('start_date', '')}</b> to 
    <b>{context.get('end_date', '')}</b>.<br/><br/>

    {role_content}<br/><br/>

    During the period of employment, the employee showed sincerity, dedication, and professionalism 
    in completing the assigned tasks and responsibilities.<br/><br/>

    We wish them every success in their future career and professional endeavors.
    """

    para = Paragraph(body_text, style)
    para.wrapOn(p, CONTENT_WIDTH, height)
    para.drawOn(p, LEFT, y - para.height)

    draw_signature_block(p, context, width, media_root)

    p.showPage()
    p.save()
    buf.seek(0)
    return buf.getvalue()

# ---------------- OFFER LETTER ----------------
def build_offer_letter_pdf(context, media_root):
    buf = BytesIO()
    p = canvas.Canvas(buf, pagesize=A4)
    width, height = A4
    draw_hr_document_template(p, width, height, media_root)

    LEFT = 70
    CONTENT_WIDTH = width - 140
    y = height - 200

    styles = getSampleStyleSheet()
    style = styles["Normal"]
    style.fontName = "Poppins"
    style.fontSize = 12
    style.leading = 18

    p.setFillColor(HexColor("#000000"))
    # Title
    p.setFont("Poppins-Bold", 16)
    p.drawString(LEFT, y, "Job Offer Letter")
    y -= 30

    # Date
    p.setFont("Poppins", 11)
    p.drawString(LEFT, y, f"Date: {context.get('date', '')}")
    y -= 25

    # To Address
    p.setFont("Poppins-Bold", 11)
    p.drawString(LEFT, y, f"To, {context.get('employee_name', '')}")
    y -= 15
    p.setFont("Poppins", 11)
    p.drawString(LEFT, y, f"Address: {context.get('address', '')}")
    y -= 25

    # Subject
    p.setFont("Poppins-Bold", 11)
    p.drawString(LEFT, y, "Subject: Offer of Employment")
    y -= 25

    # Body
    body_text = f"""
    Dear {context.get('employee_name', '')},<br/><br/>

    We are pleased to offer you the position of <b>{context.get('position', '')}</b> in the 
    <b>{context.get('department', '')}</b> department at <b>GREHASOFT</b>.<br/><br/>

    Your joining date will be <b>{context.get('joining_date', '')}</b> and your monthly salary 
    will be <b>INR {_money(context.get('salary_monthly'))}</b>.<br/><br/>

    We look forward to working with you and wish you a successful career with GREHASOFT.
    """

    para = Paragraph(body_text, style)
    para.wrapOn(p, CONTENT_WIDTH, height)
    para.drawOn(p, LEFT, y - para.height)

    draw_signature_block(p, context, width, media_root)

    p.showPage()
    p.save()
    buf.seek(0)
    return buf.getvalue()

# ---------------- SALARY CERTIFICATE ----------------
def build_salary_certificate_pdf(context, media_root):
    buf = BytesIO()
    p = canvas.Canvas(buf, pagesize=A4)
    width, height = A4
    draw_hr_document_template(p, width, height, media_root)

    LEFT = 70
    CONTENT_WIDTH = width - 140
    y = height - 200

    p.setFillColor(HexColor("#000000"))
    p.setFont("Poppins-Bold", 16)
    p.drawString(LEFT, y, "Salary Certificate")
    y -= 40

    styles = getSampleStyleSheet()
    style = styles["Normal"]
    style.fontName = "Poppins"
    style.fontSize = 12
    style.leading = 18

    body_text = f"""
    This is to certify that <b>{context.get('employee_name', '')}</b> is employed with GREHASOFT 
    as a <b>{context.get('position', '')}</b> since <b>{context.get('joining_date', '')}</b>.<br/><br/>

    The employee is currently drawing a monthly salary of <b>INR {_money(context.get('salary_monthly'))}</b>. 
    This certificate is issued upon the request of the employee for official purposes.
    """

    para = Paragraph(body_text, style)
    para.wrapOn(p, CONTENT_WIDTH, height)
    para.drawOn(p, LEFT, y - para.height)

    draw_signature_block(p, context, width, media_root)

    p.showPage()
    p.save()
    buf.seek(0)
    return buf.getvalue()

# ---------------- APPRAISAL LETTER ----------------
def build_appraisal_letter_pdf(context, media_root):
    buf = BytesIO()
    p = canvas.Canvas(buf, pagesize=A4)
    width, height = A4
    draw_hr_document_template(p, width, height, media_root)

    LEFT = 70
    CONTENT_WIDTH = width - 140
    y = height - 200

    p.setFillColor(HexColor("#000000"))
    p.setFont("Poppins-Bold", 16)
    p.drawString(LEFT, y, "Annual Appraisal Letter")
    y -= 40

    styles = getSampleStyleSheet()
    style = styles["Normal"]
    style.fontName = "Poppins"
    style.fontSize = 12
    style.leading = 18

    body_text = f"""
    We are pleased to inform you that your annual performance appraisal has been completed 
    effective from <b>{context.get('effective_date', '')}</b>.<br/><br/>

    Your previous monthly salary was <b>INR {_money(context.get('old_salary_monthly'))}</b> and 
    your revised monthly salary is <b>INR {_money(context.get('new_salary_monthly'))}</b>.<br/><br/>

    We appreciate your contributions to the organization and wish you continued success in your role.
    """

    para = Paragraph(body_text, style)
    para.wrapOn(p, CONTENT_WIDTH, height)
    para.drawOn(p, LEFT, y - para.height)

    draw_signature_block(p, context, width, media_root)

    p.showPage()
    p.save()
    buf.seek(0)
    return buf.getvalue()

def main():
    if len(sys.argv) < 3:
        sys.exit(1)

    input_json_path = sys.argv[1]
    output_pdf_path = sys.argv[2]

    with open(input_json_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    doc_type = data.get('doc_type', '')
    ctx = data.get('ctx', {})
    media_root = data.get('media_root', '')

    type_key = doc_type.lower()
    if 'offer' in type_key:
        pdf_bytes = build_offer_letter_pdf(ctx, media_root)
    elif 'appraisal' in type_key:
        pdf_bytes = build_appraisal_letter_pdf(ctx, media_root)
    elif 'experience' in type_key:
        pdf_bytes = build_experience_certificate_pdf(ctx, media_root)
    elif 'salary' in type_key:
        pdf_bytes = build_salary_certificate_pdf(ctx, media_root)
    elif 'internship' in type_key:
        pdf_bytes = build_internship_certificate_pdf(ctx, media_root)
    else:
        pdf_bytes = build_offer_letter_pdf(ctx, media_root)

    with open(output_pdf_path, 'wb') as f:
        f.write(pdf_bytes)

if __name__ == '__main__':
    main()
