import sys
import os
import json
import re
import tempfile
import shutil
from num2words import num2words

from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.platypus import Paragraph, Table, TableStyle
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

# Brand palette (unchanged from the previous receipt / invoice design)
BRAND_NAVY = colors.HexColor("#1f4e79")
BRAND_DARK = colors.HexColor("#05044A")
BRAND_GREEN = colors.HexColor("#1AB728")
PAID_GREEN = colors.HexColor("#28a745")
TEXT_DARK = colors.HexColor("#1e293b")
TEXT_MUTED = colors.HexColor("#64748b")
RULE_GREY = colors.HexColor("#e2e8f0")
PANEL_BG = colors.HexColor("#f8fafc")
RECEIVED_BG = colors.HexColor("#eaf7ee")
RECEIVED_TEXT = colors.HexColor("#155724")
BALANCE_RED = colors.HexColor("#b91c1c")

MARGIN = 50


def find_asset(media_root, filename):
    paths = [
        os.path.join(media_root, filename),
        os.path.join(media_root, "logo", filename),
        os.path.join(media_root, "icons", filename),
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "media", filename),
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "media", "logo", filename),
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "media", "icons", filename),
        os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "grehasoft-pythonpms", "backend", "media", filename),
        os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "grehasoft-pythonpms", "backend", "media", "logo", filename),
        os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "grehasoft-pythonpms", "backend", "media", "icons", filename)
    ]
    for p in paths:
        if os.path.exists(p):
            return p
    return None


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


def format_date_ddmmyyyy(date_str):
    if not date_str:
        return ""
    s = str(date_str).strip()
    if "T" in s:
        s = s.split("T")[0]
    parts = s.split("-")
    if len(parts) == 3 and len(parts[0]) == 4:  # YYYY-MM-DD
        return f"{parts[2]}-{parts[1]}-{parts[0]}"
    return s


def format_receipt_number(rct_str, invoice_number=None):
    """Display-only receipt number. Prefer the invoice-derived base; never mutate stored values.

    Invoice GSI/2026-27/001 -> RCT-2026-27-001
    Stored RCT-2026-27-001-2 / RCT/GSI-2026-27-001/01 -> RCT-2026-27-001
    Invoice suffixes are not stripped; only receipt payment suffixes are.
    """
    inv = str(invoice_number or "").strip()
    if inv:
        sanitized = re.sub(r"^GSI[/\-_]?", "", inv, flags=re.I)
        sanitized = sanitized.replace("/", "-")
        return f"RCT-{sanitized}"

    if not rct_str:
        return ""
    s = str(rct_str).strip().replace("/", "-")
    if s.upper().startswith("RCT-GSI-"):
        s = "RCT-" + s[8:]
    payment_suffix = re.match(r"^(RCT-\d{4}-\d{2}-[A-Za-z0-9]+)-\d+$", s)
    if payment_suffix:
        return payment_suffix.group(1)
    return s


def format_inr(amount):
    """Format a number as Indian currency, e.g. Rs. 1,23,456.00"""
    try:
        value = float(amount or 0)
    except (TypeError, ValueError):
        value = 0.0
    negative = value < 0
    value = abs(value)
    whole, frac = f"{value:.2f}".split(".")
    if len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        whole = ",".join(groups) + "," + tail
    return f"{'-' if negative else ''}Rs. {whole}.{frac}"


def amount_in_words(amount):
    rupees = int(amount)
    paise = int(round((amount - rupees) * 100))
    try:
        words = num2words(rupees, lang="en_IN").replace(",", "")
    except Exception:
        words = str(rupees)
    if paise > 0:
        try:
            paise_words = num2words(paise, lang="en_IN")
        except Exception:
            paise_words = str(paise)
        text = f"Rupees {words} and {paise_words} paise only"
    else:
        text = f"Rupees {words} only"
    return text[:1].upper() + text[1:]


PAYMENT_MODE_LABELS = {
    "cash": "Cash",
    "upi": "UPI",
    "bank": "Bank Transfer",
    "bank_transfer": "Bank Transfer",
    "neft": "NEFT",
    "rtgs": "RTGS",
    "imps": "IMPS",
    "cheque": "Cheque",
    "card": "Card",
    "advance": "Advance",
}


def format_payment_mode(mode):
    m = str(mode or "").strip()
    if not m:
        return ""
    return PAYMENT_MODE_LABELS.get(m.lower(), m.replace("_", " ").title())


def esc(text):
    return (str(text or "")
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;"))


def _opt_float(value):
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


class MockClient:
    def __init__(self, data):
        self.company_name = (data.get('company_name') or '').strip()
        self.name = (data.get('name') or data.get('contact_person') or data.get('client_name') or '').strip()
        self.email = (data.get('email') or '').strip()
        self.phone = (data.get('phone') or '').strip()
        self.address = (data.get('address') or '').strip()
        self.country = (data.get('country') or '').strip()
        self.gst_no = (data.get('gst_no') or data.get('gst_number') or '').strip()


class MockReceiptData:
    def __init__(self, data):
        self.receipt_number = str(data.get('receipt_number') or '')
        self.payment_date = str(data.get('payment_date') or '')
        self.payment_amount = float(data.get('payment_amount') or data.get('amount') or 0.0)
        self.payment_mode = format_payment_mode(data.get('payment_mode'))
        self.notes = str(data.get('notes') or '').strip()

        self.invoice_number = str(data.get('invoice_number') or '')
        self.invoice_date = str(data.get('invoice_date') or '')
        self.invoice_total = float(data.get('invoice_total') or 0.0)
        # Supplied by the backend; None means "not available" and the row is hidden.
        self.previously_paid = _opt_float(data.get('previously_paid'))
        self.balance_due = _opt_float(data.get('balance_due'))

        client_data = data.get('client') or {}
        if not isinstance(client_data, dict):
            client_data = {}
        if not client_data.get('name') and data.get('client_name'):
            client_data['name'] = data.get('client_name')
        if not client_data.get('phone') and data.get('client_phone'):
            client_data['phone'] = data.get('client_phone')
        self.client = MockClient(client_data)


def draw_watermark(p, width, height):
    p.saveState()
    p.setFont("Poppins-Bold", 80)
    p.setFillGray(0.95, 0.15)
    p.drawCentredString(width / 2, height / 2, "GREHASOFT")
    p.restoreState()


def draw_footer(p, width):
    p.setStrokeColor(BRAND_GREEN)
    p.setLineWidth(2)
    p.line(MARGIN, 60, width - MARGIN, 60)
    p.setFillColor(BRAND_DARK)
    p.setFont("Poppins", 9)
    p.drawCentredString(width / 2, 40, "Grehasoft | Infopark, Kochi | www.grehasoft.com")


def generate_receipt_pdf(receipt, media_root=""):
    setup_poppins_fonts()

    tmp_file = tempfile.NamedTemporaryFile(delete=False, suffix=".pdf")
    tmp_file.close()

    p = canvas.Canvas(tmp_file.name, pagesize=A4)
    width, height = A4
    content_w = width - 2 * MARGIN

    styles = getSampleStyleSheet()
    label_style = ParagraphStyle(
        'Label', parent=styles['Normal'],
        fontName='Poppins-Medium', fontSize=8, leading=11, textColor=TEXT_MUTED)
    body_style = ParagraphStyle(
        'Body', parent=styles['Normal'],
        fontName='Poppins', fontSize=9, leading=13, textColor=TEXT_DARK)
    name_style = ParagraphStyle(
        'Name', parent=body_style,
        fontName='Poppins-Bold', fontSize=10.5, leading=14)
    small_style = ParagraphStyle(
        'Small', parent=body_style, fontSize=8.5, leading=12, textColor=TEXT_DARK)

    # ---------- 1. Header banner ----------
    header_path = find_asset(media_root, "invoice_header.png")
    if header_path:
        try:
            p.drawImage(ImageReader(header_path), 0, height - 90, width=width, height=90)
        except Exception as e:
            print("Header image error:", e, file=sys.stderr)

    draw_watermark(p, width, height)

    # ---------- 2. Title (centered, no PAID badge) ----------
    y = height - 118
    p.setFillColor(BRAND_NAVY)
    p.setFont("Poppins-Bold", 17)
    p.drawCentredString(width / 2, y, "PAYMENT RECEIPT")

    # Thin rule below title
    y -= 10
    p.setStrokeColor(RULE_GREY)
    p.setLineWidth(0.8)
    p.line(MARGIN, y, width - MARGIN, y)
    y -= 14

    # ---------- 3. Receipt No & Payment Date (left-aligned, below title) ----------
    display_receipt_number = format_receipt_number(receipt.receipt_number, receipt.invoice_number)
    display_payment_date = format_date_ddmmyyyy(receipt.payment_date)

    p.setFont("Poppins-Medium", 9)
    p.setFillColor(TEXT_DARK)
    if display_receipt_number:
        p.drawString(MARGIN, y, f"Receipt No: {display_receipt_number}")
        y -= 14
    if display_payment_date:
        p.drawString(MARGIN, y, f"Payment Date: {display_payment_date}")
        y -= 14

    y -= 8  # breathing room before FROM/TO

    # ---------- 4. FROM / TO two-column layout ----------
    col_gap = 20
    col_w = (content_w - col_gap) / 2

    # --- FROM: GrehaSoft company details ---
    from_parts = [
        Paragraph("FROM", label_style),
        Paragraph("Grehasoft", name_style),
        Paragraph("Infopark Phase I, Kakkanad, Kochi,", small_style),
        Paragraph("Kerala, India - 682 042", small_style),
    ]

    # --- TO: customer details (only populate what's present) ---
    client = receipt.client
    primary_name = client.company_name or client.name
    to_parts = [Paragraph("TO", label_style)]
    if primary_name:
        to_parts.append(Paragraph(esc(primary_name), name_style))
    if client.address:
        addr = esc(client.address).replace("\r", "").replace("\n", "<br/>")
        to_parts.append(Paragraph(addr, small_style))
    to_contact = []
    
    if client.name and client.company_name and client.name != client.company_name:
        to_parts.append(Paragraph(f"Contact: {esc(client.name)}", small_style))
    if client.phone:
        to_contact.append(f"Phone: {esc(client.phone)}")
    if to_contact:
        to_parts.append(Paragraph(" &nbsp;|&nbsp; ".join(to_contact), small_style))
    if client.gst_no:
        to_parts.append(Paragraph(f"GSTIN: {esc(client.gst_no)}", small_style))

    # Payment reference below customer details (Invoice No + Mode)
   
    # if receipt.payment_mode:
    #     to_parts.append(Paragraph(f"Payment Mode: {esc(receipt.payment_mode)}", small_style)

    from_to_table = Table([[from_parts, to_parts]], colWidths=[col_w, col_w])
    from_to_table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (0, 0), col_gap),
        ("RIGHTPADDING", (1, 0), (1, 0), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    _, ft_h = from_to_table.wrap(content_w, height)
    from_to_table.drawOn(p, MARGIN, y - ft_h)
    y -= ft_h + 14

    # Thin rule after FROM/TO
    p.setStrokeColor(RULE_GREY)
    p.setLineWidth(0.8)
    p.line(MARGIN, y, width - MARGIN, y)
    y -= 14

    # ---------- 5. Amount Received highlight ----------
    box_h = 50
    p.setFillColor(RECEIVED_BG)
    p.roundRect(MARGIN, y - box_h, content_w, box_h, 6, fill=1, stroke=0)
    p.setFillColor(RECEIVED_TEXT)
    p.setFont("Poppins-Medium", 8.5)
    p.drawString(MARGIN + 14, y - 19, "AMOUNT RECEIVED")
    p.setFont("Poppins-Bold", 17)
    p.drawString(MARGIN + 14, y - 39, format_inr(receipt.payment_amount))
    y -= box_h + 6

    words_par = Paragraph(
        f"<font color='#64748b'>Amount in words:</font> {esc(amount_in_words(receipt.payment_amount))}",
        body_style)
    _, wh = words_par.wrap(content_w, height)
    words_par.drawOn(p, MARGIN, y - wh)
    y -= wh + 14

    # ---------- 6. Payment Summary ----------
    p.setFillColor(BRAND_NAVY)
    p.setFont("Poppins-Bold", 10)
    p.drawString(MARGIN, y, "Payment Summary")
    y -= 8

    rows = [["Invoice Total", format_inr(receipt.invoice_total)]]
    if receipt.previously_paid is not None and receipt.previously_paid > 0.004:
        rows.append(["Previously Paid", format_inr(receipt.previously_paid)])
    received_idx = len(rows)
    rows.append([f"Amount Received Against Invoice No. {esc(receipt.invoice_number)}", format_inr(receipt.payment_amount)])
    balance_idx = None
    if receipt.balance_due is not None:
        balance_idx = len(rows)
        rows.append(["Balance Due", format_inr(receipt.balance_due)])

    summary = Table(rows, colWidths=[content_w - 160, 160])
    ts = [
        ("FONTNAME", (0, 0), (-1, -1), "Poppins"),
        ("FONTSIZE", (0, 0), (-1, -1), 9.5),
        ("TEXTCOLOR", (0, 0), (-1, -1), TEXT_DARK),
        ("ALIGN", (1, 0), (1, -1), "RIGHT"),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LINEBELOW", (0, 0), (-1, -2), 0.6, RULE_GREY),
        ("BOX", (0, 0), (-1, -1), 0.8, RULE_GREY),
        ("BACKGROUND", (0, 0), (-1, -1), PANEL_BG),
        ("FONTNAME", (0, received_idx), (-1, received_idx), "Poppins-Bold"),
        ("TEXTCOLOR", (0, received_idx), (-1, received_idx), RECEIVED_TEXT),
        ("BACKGROUND", (0, received_idx), (-1, received_idx), RECEIVED_BG),
    ]
    if balance_idx is not None:
        bal_color = BALANCE_RED if receipt.balance_due > 0.004 else RECEIVED_TEXT
        ts += [
            ("FONTNAME", (0, balance_idx), (-1, balance_idx), "Poppins-Bold"),
            ("TEXTCOLOR", (0, balance_idx), (-1, balance_idx), bal_color),
            ("BACKGROUND", (0, balance_idx), (-1, balance_idx), colors.white),
        ]
    summary.setStyle(TableStyle(ts))
    _, sh = summary.wrap(content_w, height)
    summary.drawOn(p, MARGIN, y - sh)
    y -= sh + 12

    if receipt.notes:
        notes_par = Paragraph(
            f"<font color='#64748b'>Notes:</font> {esc(receipt.notes)}", body_style)
        _, nh = notes_par.wrap(content_w, height)
        notes_par.drawOn(p, MARGIN, y - nh)
        y -= nh + 12

    # ---------- 7. Seal + Place / Date ----------
    seal_w, seal_h = 90, 75
    block_h = seal_h + 34
    if y - block_h < 75:
        draw_footer(p, width)
        p.showPage()
        draw_watermark(p, width, height)
        y = height - 80

    y -= 6
    seal_path = find_asset(media_root, "seal.png")
    if seal_path:
        try:
            p.drawImage(ImageReader(seal_path), MARGIN, y - seal_h,
                        width=seal_w, height=seal_h, mask='auto')
        except Exception as e:
            print("Seal image error:", e, file=sys.stderr)

    p.setFillColor(TEXT_DARK)
    p.setFont("Poppins", 9)
    p.drawString(MARGIN, y - seal_h - 14, "Place: Kochi")
    if display_payment_date:
        p.drawString(MARGIN, y - seal_h - 27, f"Date: {display_payment_date}")

    # p.setFillColor(TEXT_MUTED)
    # p.setFont("Poppins", 8)
    # p.drawRightString(width - MARGIN, y - seal_h - 27,
    #                   "This is a computer-generated receipt.")

    # ---------- 8. Footer ----------
    draw_footer(p, width)

    p.save()
    return tmp_file.name


def main():
    if len(sys.argv) < 3:
        print("Usage: python generate_receipt_pdf.py <json_input_file> <output_pdf_file>", file=sys.stderr)
        sys.exit(1)

    input_file = sys.argv[1]
    output_file = sys.argv[2]

    with open(input_file, 'r', encoding='utf-8') as f:
        data = json.load(f)

    receipt_data = data.get('receipt', {})
    media_root = data.get('media_root', '')

    mock_receipt = MockReceiptData(receipt_data)
    pdf_temp_path = generate_receipt_pdf(mock_receipt, media_root=media_root)

    shutil.copyfile(pdf_temp_path, output_file)
    try:
        os.remove(pdf_temp_path)
    except Exception:
        pass
    print("SUCCESS")


if __name__ == '__main__':
    main()
