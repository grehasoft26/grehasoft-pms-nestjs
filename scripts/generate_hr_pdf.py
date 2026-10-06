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
        "title": "1. Commencement of Employment",
        "content": "Your scheduled joining date will be {joining_date}."
    },
    {
        "id": 2,
        "title": "2. Compensation",
        "content": "Your monthly gross salary will be INR {salary_monthly} ({salary_in_words}). Any applicable statutory deductions and taxes will be withheld as per government regulations."
    },
    {
        "id": 3,
        "title": "3. Working Hours and Location",
        "content": "This is a Work from Office position at our Infopark, Kochi office. Standard hours are 9:00 AM to 6:00 PM, Monday through Saturday (excluding your designated one Saturday off per month and national holidays)."
    },
    {
        "id": 4,
        "title": "4. Probation and Notice Period",
        "content": "• Probation: You will be on probation for three months from your date of joining. Upon successful completion, your employment will be confirmed based on your performance.\n\n• Resignation: After confirmation, you are required to provide a 45-day notice period or salary in lieu of notice, subject to management approval, to ensure a smooth handover of projects/works/clients and responsibilities."
    },
    {
        "id": 5,
        "title": "5. Intellectual Property (IP) & Work Ownership",
        "content": "All works, deliverables, or outputs created, developed, designed, or conceived by you during your employment—including but not limited to software code, website designs, branding materials, logos, marketing content, graphics, digital assets, strategies, and any other intellectual property—are \"works made for hire\" and shall be the sole and exclusive property of Grehasoft. You shall have no right, title, or interest in any such work and are prohibited from using, copying, reproducing, or claiming ownership of these materials for personal, external, or competitive use."
    },
    {
        "id": 6,
        "title": "6. Professional Accountability & Quality Standards",
        "content": "You are responsible for maintaining high standards of accuracy, quality, and professionalism in all work assigned to you.\n\n• Quality Assurance: You must ensure all deliverables meet company standards and client requirements before submission.\n\n• Accuracy & Correctness: You are expected to verify all information, data, content, and technical work for accuracy and compliance.\n\n• Liability for Negligence: Any loss, damage, financial liability, or client complaint arising from gross negligence, willful misconduct, carelessness, or unauthorized errors in your work—including but not limited to incorrect information in social media posts, development code, strategies, or any other deliverables—will be your professional responsibility. You acknowledge that such failures may result in disciplinary action, including termination, and potential recovery of losses."
    },
    {
        "id": 7,
        "title": "7. Leave and Holiday Policy",
        "content": "• Weekly Off: One Saturday per month will be granted as an additional off day. Regular Sundays remain as weekly offs.\n\n• National & Statutory Holidays: All national holidays and statutory holidays as declared by the Government will be observed."
    },
    {
        "id": 8,
        "title": "8. Confidentiality and Non-Disclosure",
        "content": "You shall not disclose any proprietary information, client data, business strategies, trade secrets, or confidential materials of Grehasoft to any third party during or after your employment, without prior written consent from management. This obligation continues even after termination of employment."
    },
    {
        "id": 9,
        "title": "9. Non-Competition",
        "content": "During your employment and for a period of one year following your departure, you agree not to directly or indirectly solicit, contact, or provide similar or competing services to any clients of Grehasoft that you handled, worked with, or had knowledge of during your tenure."
    },
    {
        "id": 10,
        "title": "10. Code of Conduct & Professional Ethics",
        "content": "You are expected to maintain professional conduct at all times, including:\n\n• Punctuality and regular attendance as per scheduled working hours.\n\n• Professional behavior and respectful communication with colleagues and clients.\n\n• Adherence to company policies and management directives.\n\n• Prohibition of harassment, discrimination, or unethical conduct.\n\n• Maintaining professional standards in all client interactions and deliverables. Violation of conduct standards may result in disciplinary action up to and including termination."
    },
    {
        "id": 11,
        "title": "11. Attendance & Leave Rules",
        "content": "• Punctuality: Repeated tardiness or early departures without authorization may result in salary deduction or disciplinary action.\n\n• Absence: Any unplanned absence must be reported to your manager immediately. Unauthorized absences for more than three consecutive days may be treated as abandonment of employment.\n\n• Leave Application: All leave requests must be submitted in advance through the designated approval process, except in case of medical emergencies."
    },
    {
        "id": 12,
        "title": "12. Data Protection & Privacy Compliance",
        "content": "You are required to:\n\n• Handle all client data, personal information, and confidential business information with utmost care and security.\n\n• Comply with all data protection regulations, including applicable privacy laws and industry standards.\n\n• Never share, store, or transmit client data through unauthorized channels.\n\n• Report any data breaches or security incidents to management immediately. Failure to comply may result in legal action and termination of employment."
    },
    {
        "id": 13,
        "title": "13. Company Assets & Equipment",
        "content": "• All company-provided equipment (laptop, mobile device, access cards, software licenses, etc.) remains the property of Grehasoft.\n\n• You are responsible for safeguarding these assets and using them only for authorized business purposes.\n\n• Upon termination or on request, all company assets must be returned in good condition. Damage due to negligence or theft will be deducted from your final settlement.\n\n• Unauthorized use or loss of company assets may result in disciplinary action or legal proceedings."
    },
    {
        "id": 14,
        "title": "14. Conflict of Interest",
        "content": "You are prohibited from:\n\n• Engaging in any side business, freelancing, or consulting work during office hours is not allowed.\n\n• Providing services to competitors or clients that conflict with Grehasoft's business interests.\n\n• Using company resources, time, or intellectual knowledge for personal or external projects.\n\n• Accepting gifts, favors, or commissions from clients that could compromise your objectivity. Violation may result in termination and recovery of losses incurred by Grehasoft."
    },
    {
        "id": 15,
        "title": "15. Remote Work Policy",
        "content": "Remote or work-from-home arrangements are not part of this offer unless explicitly approved by management. Any future remote work shall be subject to company policy and management discretion, and may be revoked at any time."
    },
    {
        "id": 16,
        "title": "16. Performance Review & Increment Policy",
        "content": "• Performance Reviews: Formal performance reviews will be conducted [quarterly/semi-annually/annually] to assess your contribution, skills, and professional development.\n\n• Salary Increments: Increments, bonuses, or benefits are not guaranteed and are contingent upon satisfactory performance, company financial health, and management discretion.\n\n• Probation Review: At the end of your probation period, your performance will be evaluated to determine confirmation of employment."
    },
    {
        "id": 17,
        "title": "17. Termination of Employment",
        "content": "a) Termination by Grehasoft: Grehasoft may terminate your employment under the following circumstances:\n\n• Completion of probation period with unsatisfactory performance.\n\n• Gross misconduct, theft, or violation of confidentiality.\n\n• Repeated negligence or failures affecting client relationships.\n\n• Breach of code of conduct or company policies.\n\n• Redundancy or business closure (notice or severance as per applicable law).\n\nb) Immediate Termination: Grehasoft reserves the right to terminate employment immediately without notice or severance pay in cases of:\n\n• Theft or dishonesty.\n\n• Breach of confidentiality or IP theft.\n\n• Gross insubordination or misconduct.\n\n• Legal or criminal violations.\n\nc) Termination by Employee: You may terminate employment by providing the 45-day notice period as stated in Section 4, or by paying salary in lieu of notice, subject to management approval and completion of project handover."
    },
    {
        "id": 18,
        "title": "18. Compliance and Regulatory Adherence",
        "content": "You are expected to adhere to all company policies, code of conduct, and operational guidelines as laid out in the company handbook and management directives. You acknowledge that your work must comply with all applicable laws, industry standards, and client contractual obligations."
    },
    {
        "id": 19,
        "title": "19. Amendments to Terms",
        "content": "Grehasoft reserves the right to amend, modify, or update any terms and conditions of this offer letter with prior written notice to the employee. Continuance of employment after such amendments constitutes acceptance of the revised terms."
    },
    {
        "id": 20,
        "title": "20. Governing Law and Jurisdiction",
        "content": "This offer letter and all terms of employment shall be governed by the laws of the Republic of India, specifically the laws of the State of Kerala. Any disputes arising out of this employment shall be subject to the jurisdiction of courts in Kochi, Kerala."
    },
    {
        "id": 21,
        "title": "21. Acknowledgment of Receipt",
        "content": "By signing this offer letter, you confirm that you have received a complete copy, read and understood all terms, and agree to be bound by them. You also confirm that you have disclosed all relevant information about your background and qualifications, and that any false or misleading information may result in immediate termination."
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
    comp = str(context.get("company_name", "GREHASOFT"))

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
        "[Date]": dt,

        "{issue_date}": issue_dt,
        "{{issue_date}}": issue_dt,

        "{hr_name}": hr,
        "{{hr_name}}": hr,

        "{company_name}": comp,
        "{{company_name}}": comp,
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
    <b>To:</b> {context.get('employee_name', '')} {context.get('address', '')}<br/><br/>
    <b>Subject: Offer of Employment – {context.get('position', '')}</b><br/><br/>
    Dear {context.get('employee_name', '')},<br/><br/>
    We are pleased to offer you the position of <b>{context.get('position', '')}</b> at Grehasoft. This letter outlines the terms and conditions of your employment.
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

    acc_title_style = ParagraphStyle(
        "AccTitleStyle",
        parent=title_style,
        fontSize=14,
        leading=18,
        spaceBefore=15,
        spaceAfter=10,
        keepWithNext=True
    )

    acceptance_flowables = [
        Paragraph("Acceptance of Terms", acc_title_style),
        Spacer(1, 6),
        Paragraph(
            "By signing below, you confirm that you have read, understood, and agree to all the terms and conditions outlined in this offer letter.",
            sub_style
        ),
        Spacer(1, 15),
    ]

    grehasoft_sig_text = f"""
    <b>For Grehasoft,</b><br/><br/><br/>
    <b>Raji T Skariah</b><br/>
    Founder & CEO<br/>
    Grehasoft, Infopark, Kochi
    """

    seal_path = os.path.join(media_root, 'icons', 'seal.png')
    if os.path.exists(seal_path):
        seal_img = Image(seal_path, width=110, height=90)
        table_data = [[Paragraph(grehasoft_sig_text, sub_style), seal_img]]
        sig_table = Table(table_data, colWidths=[280, 150])
        sig_table.setStyle(TableStyle([
            ('VALIGN', (0,0), (-1,-1), 'BOTTOM'),
            ('LEFTPADDING', (0,0), (-1,-1), 0),
            ('RIGHTPADDING', (0,0), (-1,-1), 0),
        ]))
        acceptance_flowables.append(sig_table)
    else:
        acceptance_flowables.append(Paragraph(grehasoft_sig_text, sub_style))

    acceptance_flowables.append(Spacer(1, 15))

    emp_name = str(context.get('employee_name', '_________________________'))
    emp_pos = str(context.get('position', '_________________________'))

    emp_acceptance_text = f"""
    <b>Employee Acceptance:</b><br/><br/>
    I, <b>{emp_name}</b>, accept the offer of employment for the position of <b>{emp_pos}</b> under the terms and conditions mentioned above. I confirm that I have read and understood all clauses and agree to be bound by them.<br/><br/><br/>

    <b>Employee Signature:</b> _________________________<br/><br/>
    <b>Date:</b> _________________________<br/><br/>
    <b>Contact Number:</b> _________________________
    """
    acceptance_flowables.append(Paragraph(emp_acceptance_text, sub_style))

    story.append(KeepTogether(acceptance_flowables))

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
