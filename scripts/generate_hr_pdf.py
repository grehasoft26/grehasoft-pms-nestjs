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

    try:
        pdfmetrics.registerFontFamily('Poppins', normal='Poppins', bold='Poppins-Bold')
    except Exception:
        pass

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
DEFAULT_OFFER_SECTIONS = [
    {
        "id": 1,
        "title": "1. Joining and Place of Work",
        "content": "Your initial place of work will be Grehasoft’s office at Infopark, Kakkanad, Ernakulam, Kerala.\n\nThis is a full-time, work-from-office position. Your normal working hours will be 9:00 AM to 6:00 PM, Monday to Saturday, with one Saturday off per month, together with Sundays and applicable holidays, subject to the internal policies and business requirements."
    },
    {
        "id": 2,
        "title": "2. Compensation",
        "content": "Your monthly gross salary will be INR {salary_monthly}/- ({salary_in_words}). Statutory deductions, taxes and other deductions, wherever applicable, will be made in accordance with applicable law and internal policy of Grehasoft."
    },
    {
        "id": 3,
        "title": "3. Probation and Confirmation",
        "content": "You will be on probation for three (3) months from your date of joining. Based on your performance and suitability, Grehasoft may confirm your employment or extend the probation period at its discretion.\n\nDuring probation, Grehasoft reserves the right to terminate your employment, with or without notice, subject to applicable law."
    },
    {
        "id": 4,
        "title": "4. Notice Period and Separation",
        "content": "Following confirmation, either party may initiate separation from employment by giving 45 days’ written notice, subject to applicable internal policies and completion of a proper handover of assigned work, projects, clients and responsibilities."
    },
    {
        "id": 5,
        "title": "5. Duties, Conduct and Outside Engagements",
        "content": "You shall diligently and professionally perform the duties assigned to you and comply with the internal policies, reasonable management instructions, applicable laws and applicable client requirements.\n\nDuring your employment, you shall devote your working time and attention to you work related engagements and shall not undertake any other employment, freelance, consultancy or business activity which conflicts with your duties or the interests of Grehasoft, without prior written approval."
    },
    {
        "id": 6,
        "title": "6. Confidentiality",
        "content": "You shall not disclose any proprietary information, client data, business strategies, trade secrets, or confidential materials of Grehasoft to any third party during or after your employment, without prior written consent from management. This obligation continues even after termination of employment."
    },
    {
        "id": 7,
        "title": "7. Intellectual Property and Work Product",
        "content": "All software, source code, designs, content, graphics, documents, strategies, processes, materials, inventions, developments and other work products created, developed or contributed to by you in the course of your employment or using Grehasoft resources shall, to the extent permitted by law, belong exclusively to Grehasoft.\n\nYou shall promptly disclose and hand over such work products to Grehasoft and shall not use or reproduce them for personal, external or competing purposes without prior written authorisation."
    },
    {
        "id": 8,
        "title": "8. Data Protection & Privacy Compliance",
        "content": "All Grehasoft equipment, documents, records, software, access credentials and other assets provided to you shall remain the property of Grehasoft and shall be used only for authorised purposes.\n\nYou shall safeguard Grehasoft and client data and comply with Grehasoft’s information-security and data-protection requirements, including compliance with all data protection regulations, applicable privacy laws and industry standards. Upon request or cessation of employment, all properties, records, data and materials of Grehasoft in your possession or control shall be immediately returned or handed over, and you shall not retain unauthorised copies."
    },
    {
        "id": 9,
        "title": "9. Performance and Responsibilities",
        "content": "You are expected to maintain appropriate standards of accuracy, quality, professionalism and accountability in your work. Any wilful misconduct, material breach of duty, serious negligence, unauthorised act or violation of internal policies may result in appropriate disciplinary action, including termination, in accordance with applicable law.\n\nWhere any loss is caused to Grehasoft by proven fraud, wilful misconduct, unauthorised acts or other actionable conduct on your part, Grehasoft reserves its rights to take appropriate action and seek recovery in accordance with applicable law."
    },
    {
        "id": 10,
        "title": "10. Background Information",
        "content": "This offer is based on the information and documents provided by you. Any material misrepresentation, falsification or wilful suppression of relevant information may result in withdrawal of the offer or appropriate disciplinary action, including termination, subject to applicable law."
    },
    {
        "id": 11,
        "title": "11. Conflict of Interest and Client Non-Solicitation",
        "content": "You shall not use Grehasoft resources, confidential information or business relationships for any unauthorised personal or external purpose or engage in activities that create a conflict of interest with Grehasoft.\n\nDuring your employment and for a period of one year following your departure, you agree not to directly or indirectly solicit, contact, or provide similar or competing services to any clients of Grehasoft that you handled, worked with, or had knowledge of during your tenure."
    },
    {
        "id": 12,
        "title": "12. Leave and Holidays",
        "content": "Leave, weekly offs and holidays will be governed by the internal policies and applicable law."
    },
    {
        "id": 13,
        "title": "13. Performance Review and Compensation",
        "content": "Your performance may be reviewed periodically. Any salary revision or other compensatory benefits will be subject to your performance, internal policy, business conditions and management discretion and shall not be deemed automatic."
    },
    {
        "id": 14,
        "title": "14. Termination",
        "content": "Grehasoft may terminate your employment for unsatisfactory performance, misconduct, material breach of internal policies or obligations, or other legitimate grounds, subject to applicable law and the terms of this letter.\n\nIn cases of serious misconduct or other circumstances permitting immediate termination under applicable law, Grehasoft may terminate the employment without notice or payment in lieu thereof."
    },
    {
        "id": 15,
        "title": "15. Compliance and Regulatory Adherence",
        "content": "You shall comply with all applicable laws, internal policies, code of conduct, information-security requirements and other reasonable operational guidelines, as amended and communicated from time to time."
    },
    {
        "id": 16,
        "title": "16. General",
        "content": "This offer letter, together with the internal policies, constitutes the terms governing your employment unless superseded by a subsequent written employment agreement.\n\nAny amendment to the terms of employment will be communicated to you in writing. This letter shall be governed by applicable laws of India, and courts at Kochi, Kerala shall have jurisdiction, subject to applicable law."
    },
    {
        "id": 17,
        "title": "17. Acceptance",
        "content": "We are pleased to have you join Grehasoft and look forward to a successful and rewarding association with you.\n\nPlease sign below as confirmation of your acceptance of this offer."
    }
]

def replace_offer_placeholders(text: str, context: dict) -> str:
    if not text:
        return ""
    sal_monthly = float(context.get("salary_monthly", 0) or 0)
    emp_name = str(context.get("employee_name", ""))
    address = str(context.get("address", ""))
    position = str(context.get("position", ""))
    dept = str(context.get("department", ""))
    joining = str(context.get("joining_date", ""))
    sal_words = str(context.get("salary_in_words", ""))
    sal_annual = _money(sal_monthly * 12)
    sal_str = _money(sal_monthly)
    dt = str(context.get("date", ""))
    issue_dt = str(context.get("date") or context.get("issue_date") or "")
    hr = str(context.get("hr_name", "HR Manager"))
    comp = str(context.get("company_name", "Grehasoft"))

    replacements = {
        "{employee_name}": emp_name,
        "{{employee_name}}": emp_name,
        "[Employee Name]": emp_name,

        "{address}": address,
        "{{address}}": address,
        "[Employee Address]": address,

        "{position}": position,
        "{{position}}": position,
        "[Position Title]": position,

        "{department}": dept,
        "{{department}}": dept,

        "{joining_date}": joining,
        "{{joining_date}}": joining,
        "[Joining Date]": joining,
        "[Date]": joining,

        "{salary_monthly}": sal_str,
        "{{salary_monthly}}": sal_str,
        "[Amount]": sal_str,

        "{salary_in_words}": sal_words,
        "{{salary_in_words}}": sal_words,
        "[Amount in Words Only]": sal_words,

        "{salary_annual}": sal_annual,
        "{{salary_annual}}": sal_annual,

        "{date}": dt,
        "{{date}}": dt,

        "{issue_date}": issue_dt,
        "{{issue_date}}": issue_dt,

        "{hr_name}": hr,
        "{{hr_name}}": hr,

        "{company_name}": comp,
        "{{company_name}}": comp,
        "[Firm Name]": comp,
    }
    for k, v in replacements.items():
        text = text.replace(k, v)
    return text

def build_custom_offer_letter_pdf(context, media_root, custom_sections):
    setup_poppins_fonts()
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, KeepTogether, Table, TableStyle, Image, PageBreak
    from reportlab.lib.styles import ParagraphStyle
    buf = BytesIO()
    width, height = A4

    def on_page(canvas_obj, doc_obj):
        draw_hr_document_template(canvas_obj, width, height, media_root)

    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=50,
        rightMargin=50,
        topMargin=95,
        bottomMargin=75
    )

    styles = getSampleStyleSheet()

    title_style = ParagraphStyle(
        "TitleStyle",
        parent=styles["Normal"],
        fontName="Poppins-Bold",
        fontSize=16,
        leading=22,
        textColor=HexColor("#05044A"),
        spaceAfter=12
    )

    sub_style = ParagraphStyle(
        "SubStyle",
        parent=styles["Normal"],
        fontName="Poppins",
        fontSize=10,
        leading=14,
        textColor=HexColor("#333333"),
        spaceAfter=12
    )

    sec_title_style = ParagraphStyle(
        "SecTitleStyle",
        parent=styles["Normal"],
        fontName="Poppins-Bold",
        fontSize=11,
        leading=16,
        textColor=HexColor("#05044A"),
        spaceBefore=10,
        spaceAfter=4,
        keepWithNext=True
    )

    sec_body_style = ParagraphStyle(
        "SecBodyStyle",
        parent=styles["Normal"],
        fontName="Poppins",
        fontSize=10,
        leading=15,
        textColor=HexColor("#222222"),
        spaceAfter=8
    )

    story = []

    header_info = f"""
    <b>Date:</b> {context.get('date', '')}<br/><br/>
    <b>To:</b><br/>
    {context.get('employee_name', '')}<br/>
    {context.get('address', '')}<br/><br/>
    <b>Subject: Offer of Employment – {context.get('position', '')}</b><br/><br/>
    Dear {context.get('employee_name', '')},<br/><br/>
    We are pleased to offer you the position of <b>{context.get('position', '')}</b> with <b>Grehasoft</b>, with effect from <b>{context.get('joining_date', '')}</b>, on the following terms and conditions:
    """
    story.append(Paragraph(replace_offer_placeholders(header_info, context), sub_style))
    story.append(Spacer(1, 10))

    is_customized = False
    if custom_sections and isinstance(custom_sections, list) and len(custom_sections) > 0:
        if len(custom_sections) != len(DEFAULT_OFFER_SECTIONS):
            is_customized = True
        else:
            for s1, s2 in zip(custom_sections, DEFAULT_OFFER_SECTIONS):
                if s1.get("title", "").strip() != s2.get("title", "").strip() or s1.get("content", "").strip() != s2.get("content", "").strip():
                    is_customized = True
                    break

    sections_to_render = custom_sections if is_customized else DEFAULT_OFFER_SECTIONS

    for sec in sections_to_render:
        t_raw = sec.get("title", "")
        c_raw = sec.get("content", "")
        t_proc = replace_offer_placeholders(t_raw, context)
        c_proc = replace_offer_placeholders(c_raw, context).replace("\n", "<br/>")

        sec_flowables = []
        if t_proc:
            sec_flowables.append(Paragraph(t_proc, sec_title_style))
        if c_proc:
            sec_flowables.append(Paragraph(c_proc, sec_body_style))

        if sec_flowables:
            story.append(KeepTogether(sec_flowables))

    story.append(Spacer(1, 15))

    grehasoft_sig_text = f"""
    <b>For Grehasoft</b><br/><br/><br/>
    <b>Ms. Raji T Skariah</b><br/>
    Founder & CEO<br/>
    Grehasoft, Infopark, Kochi
    """

    seal_path = os.path.join(media_root, 'icons', 'seal.png')
    sig_flowables = []
    if os.path.exists(seal_path):
        seal_img = Image(seal_path, width=110, height=90)
        table_data = [[Paragraph(grehasoft_sig_text, sub_style), seal_img]]
        sig_table = Table(table_data, colWidths=[280, 150])
        sig_table.setStyle(TableStyle([
            ('VALIGN', (0,0), (-1,-1), 'BOTTOM'),
            ('LEFTPADDING', (0,0), (-1,-1), 0),
            ('RIGHTPADDING', (0,0), (-1,-1), 0),
        ]))
        sig_flowables.append(sig_table)
    else:
        sig_flowables.append(Paragraph(grehasoft_sig_text, sub_style))

    sig_flowables.append(Spacer(1, 15))

    emp_name = str(context.get('employee_name', '_________________________'))
    joining_dt = str(context.get('joining_date', '________________________'))

    emp_acceptance_text = f"""
    <b>Employee Acceptance</b><br/><br/>
    I, <b>{emp_name}</b>, have read and understood the terms of this offer and hereby confirm my acceptance of the offer. I confirm that I will join at the offered location on <b>{joining_dt}</b>.<br/><br/><br/>
    <b>Employee Signature:</b> _________________________<br/><br/>
    <b>Date:</b> _________________________<br/><br/>
    <b>Contact Number:</b> _________________________
    """
    sig_flowables.append(Paragraph(emp_acceptance_text, sub_style))

    story.append(KeepTogether(sig_flowables))

    doc.build(story, onFirstPage=on_page, onLaterPages=on_page)
    buf.seek(0)
    return buf.getvalue()


def build_offer_letter_pdf(context, media_root):
    custom_sections = context.get('custom_sections')
    return build_custom_offer_letter_pdf(context, media_root, custom_sections)


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
