import sys
import os
import json
import tempfile
import shutil
from num2words import num2words

from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.platypus import Paragraph, Table, TableStyle, Image
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

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

class MockClient:
    def __init__(self, data):
        self.company_name = data.get('company_name') or ''
        self.name = data.get('name') or data.get('client_name') or ''
        self.email = data.get('email') or ''
        self.phone = data.get('phone') or ''
        self.address = data.get('address') or ''
        self.gst_no = data.get('gst_no') or data.get('gst_number') or ''

class MockItem:
    def __init__(self, item):
        self.description = item.get('description', '')
        self.quantity = item.get('quantity', 1)
        self.rate = float(item.get('rate', 0.0))
        self.amount = float(item.get('amount', 0.0))

class MockReceiptData:
    def __init__(self, data):
        self.receipt_number = data.get('receipt_number') or 'RCT/2026-27/001'
        self.payment_date = str(data.get('payment_date') or '')
        self.payment_amount = float(data.get('payment_amount') or data.get('amount') or 0.0)
        self.payment_mode = str(data.get('payment_mode') or 'cash').capitalize()
        self.notes = str(data.get('notes') or '')

        self.invoice_number = str(data.get('invoice_number') or 'INV-001')
        self.invoice_date = str(data.get('invoice_date') or '')
        self.invoice_total = float(data.get('invoice_total') or 0.0)
        self.service_description = str(data.get('service_description') or f"Payment for Invoice {self.invoice_number}")

        client_data = data.get('client') or {}
        if not isinstance(client_data, dict):
            client_data = {}
        if not client_data.get('name') and data.get('client_name'):
            client_data['name'] = data.get('client_name')
        if not client_data.get('phone') and data.get('client_phone'):
            client_data['phone'] = data.get('client_phone')
        self.client = MockClient(client_data)

        raw_items = data.get('items', [])
        self.items = [MockItem(i) for i in raw_items]

def generate_receipt_pdf(receipt, media_root=""):
    setup_poppins_fonts()

    tmp_file = tempfile.NamedTemporaryFile(delete=False, suffix=".pdf")

    # 1️⃣ Create canvas FIRST
    p = canvas.Canvas(tmp_file.name, pagesize=A4)
    width, height = A4

    # 2️⃣ Draw top header banner image (same as Invoice PDF)
    header_path = find_asset(media_root, "invoice_header.png")
    if header_path and os.path.exists(header_path):
        try:
            header = ImageReader(header_path)
            p.drawImage(header, 0, height-90, width=width, height=90)
        except Exception as e:
            print("Header image error:", e, file=sys.stderr)

    # Start content height
    y = height - 135

    # -----------------------------
    # WATERMARK
    # -----------------------------
    p.saveState()
    p.setFont("Poppins-Bold", 80)
    p.setFillGray(0.95, 0.15)
    p.drawCentredString(width/2, height/2, "GREHASOFT")
    p.restoreState()

    # -----------------------------
    # TITLE & STATUS BADGE
    # -----------------------------
    p.setFont("Poppins-Bold", 16)
    p.drawCentredString(width/2, y, "PAYMENT RECEIPT")
    y -= 25

    # Badge: PAID
    status_display = "PAID"
    badge_color = colors.HexColor("#28a745")
    badge_width = 65
    badge_x = width - 50 - badge_width
    badge_y = y - 3

    # -----------------------------
    # RECEIPT & INVOICE META INFO
    # -----------------------------
    p.setFont("Poppins", 9.0)
    p.drawString(50, y, f"Receipt No : {receipt.receipt_number}")
    p.drawString(195, y, f"Payment Date : {receipt.payment_date}")
    p.drawString(335, y, f"Invoice No : {receipt.invoice_number}")

    p.saveState()
    p.setFillColor(badge_color)
    p.roundRect(badge_x, badge_y, badge_width, 16, 3, fill=1, stroke=0)
    p.setFillColor(colors.white)
    p.setFont("Poppins-Bold", 8)
    p.drawCentredString(badge_x + badge_width/2, badge_y + 4, status_display)
    p.restoreState()

    y -= 15

    # Top separator line
    p.setStrokeColor(colors.HexColor("#e2e8f0"))
    p.setLineWidth(1)
    p.line(50, y, width - 50, y)
    y -= 15

    # -----------------------------
    # ISSUED BY (FROM) & PAID BY (TO)
    # -----------------------------
    styles = getSampleStyleSheet()
    content_style = ParagraphStyle(
        'PanelContent',
        parent=styles['Normal'],
        fontName='Poppins',
        fontSize=9,
        leading=13
    )

    from_html = (
        "<b>GrehaSoft Smart IT Solutions</b><br/>"
        "8th Floor, Vismaya Building,<br/>"
        "Infopark Phase I, Kakkanad,<br/>"
        "Kochi, Kerala - 682 042<br/>"
        "Phone: +91 89215 40183<br/>"
        "Email: info@grehasoft.com<br/>"
        "Website: www.grehasoft.com"
    )

    client = receipt.client
    to_lines = []
    if client.company_name:
        to_lines.append(f"<b>{client.company_name}</b>")
    if client.name:
        to_lines.append(f"Contact: {client.name}")
    if client.email:
        to_lines.append(f"Email: {client.email}")
    if client.phone:
        to_lines.append(f"Phone: {client.phone}")
    if client.address:
        addr_clean = client.address.replace("\n", "<br/>").replace("\r", "")
        to_lines.append(f"Address: {addr_clean}")
    if client.gst_no:
        to_lines.append(f"GSTIN: {client.gst_no}")

    to_html = "<br/>".join(to_lines) if to_lines else "Valued Client"

    left_cell = Paragraph(f"<font color='#1f4e79'><b>FROM:</b></font><br/><br/>{from_html}", content_style)
    right_cell = Paragraph(f"<font color='#1f4e79'><b>TO:</b></font><br/><br/>{to_html}", content_style)

    info_table = Table([[left_cell, right_cell]], colWidths=[265, 265])
    info_table.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
        ('TOPPADDING', (0, 0), (-1, -1), 0),
        ('LEFTPADDING', (0, 0), (-1, -1), 0),
        ('RIGHTPADDING', (0, 0), (-1, -1), 0),
    ]))

    iw, ih = info_table.wrap(width - 100, height)
    info_table.drawOn(p, 50, y - ih)
    y = y - ih - 15

    # Bottom separator line
    p.line(50, y, width - 50, y)
    y -= 20

    # -----------------------------
    # SERVICE / PAYMENT TABLE
    # -----------------------------
    table_data = [
        ["Description of Service", "Amount"]
    ]

    if receipt.items and len(receipt.items) > 0:
        for item in receipt.items:
            table_data.append([
                f"{item.description} (Qty: {item.quantity} @ Rs {item.rate:,.2f})",
                f"Rs {item.amount:,.2f}"
            ])
    else:
        table_data.append([
            receipt.service_description,
            f"Rs {receipt.payment_amount:,.2f}"
        ])

    # Summary Rows
    total_row_idx = len(table_data)
    table_data.append(["Total Invoice Amount", f"Rs {receipt.invoice_total:,.2f}"])

    received_row_idx = len(table_data)
    table_data.append(["Amount Received (Current Payment)", f"Rs {receipt.payment_amount:,.2f}"])

    table = Table(table_data, colWidths=[350, 150])

    items_count = len(receipt.items) if receipt.items else 1
    table_styles = [
        ("GRID", (0, 0), (-1, items_count), 1, colors.grey),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1f4e79")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Poppins-Bold"),
        ("FONTSIZE", (0, 0), (-1, 0), 10),
        ("ALIGN", (1, 1), (1, items_count), "RIGHT"),
        ("FONTNAME", (0, 1), (-1, items_count), "Poppins"),
        ("FONTSIZE", (0, 1), (-1, items_count), 9),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
    ]

    # Style summary rows
    table_styles.extend([
        ("FONTNAME", (0, total_row_idx), (-1, total_row_idx), "Poppins-Medium"),
        ("FONTSIZE", (0, total_row_idx), (-1, total_row_idx), 9.5),
        ("ALIGN", (0, total_row_idx), (-1, -1), "RIGHT"),
        ("LINEABOVE", (0, total_row_idx), (-1, total_row_idx), 1, colors.grey),
        ("FONTNAME", (0, received_row_idx), (-1, received_row_idx), "Poppins-Bold"),
        ("FONTSIZE", (0, received_row_idx), (-1, received_row_idx), 10),
        ("BACKGROUND", (0, received_row_idx), (-1, received_row_idx), colors.HexColor("#d4edda")),
        ("TEXTCOLOR", (0, received_row_idx), (-1, received_row_idx), colors.HexColor("#155724")),
        ("LINEABOVE", (0, received_row_idx), (-1, received_row_idx), 1, colors.grey),
        ("LINEBELOW", (0, received_row_idx), (-1, received_row_idx), 1.5, colors.grey),
    ])

    table.setStyle(TableStyle(table_styles))

    w, h = table.wrap(width - 100, height)
    if y - h < 120:
        p.showPage()
        p.saveState()
        p.setFont("Poppins-Bold", 80)
        p.setFillGray(0.95, 0.15)
        p.drawCentredString(width/2, height/2, "GREHASOFT")
        p.restoreState()
        y = height - 80
        w, h = table.wrap(width - 100, height)

    table.drawOn(p, 50, y - h)
    y = y - h - 15

    # -----------------------------
    # AMOUNT IN WORDS & PAYMENT METHOD
    # -----------------------------
    current_pay_amount = receipt.payment_amount
    rupees = int(current_pay_amount)
    paise = int(round((current_pay_amount - rupees) * 100))

    try:
        amount_words = num2words(rupees, lang="en_IN").replace(",", "")
    except Exception:
        amount_words = str(rupees)

    if paise > 0:
        try:
            paise_words = num2words(paise, lang="en_IN")
        except Exception:
            paise_words = str(paise)
        final_words = f"Rupees {amount_words} and {paise_words} paise only"
    else:
        final_words = f"Rupees {amount_words} only"

    p.setFont("Poppins", 9.5)
    p.drawString(50, y, f"Amount Received in Words: {final_words.capitalize()}")
    y -= 18
    p.drawString(50, y, f"Payment Mode: {receipt.payment_mode}" + (f" | Notes: {receipt.notes}" if receipt.notes else ""))
    y -= 15

    # -----------------------------
    # FOOTER: PLACE, DATE, SEAL & HR STYLE FOOTER BAR
    # -----------------------------
    place_date_y = 120
    p.setFillColor(colors.HexColor("#000000"))
    p.setFont("Poppins", 10)
    p.drawString(50, place_date_y, "Place: Kochi")
    p.drawString(50, place_date_y - 15, f"Date: {receipt.payment_date}")

    # Seal beside Date/Place on the right
    seal_path = find_asset(media_root, "seal.png")
    if seal_path and os.path.exists(seal_path):
        try:
            seal = ImageReader(seal_path)
            p.drawImage(seal, width - 50 - 130, 70, width=130, height=110, mask='auto')
        except Exception as e:
            print("Seal image error:", e, file=sys.stderr)

    # Green Footer Line (matching HR Documents PDF)
    p.setStrokeColor(colors.HexColor("#1AB728"))
    p.setLineWidth(2)
    p.line(50, 60, width - 50, 60)

    # Footer Text (matching HR Documents PDF)
    p.setFillColor(colors.HexColor("#05044A"))
    p.setFont("Poppins", 9)
    p.drawCentredString(width / 2, 40, "Grehasoft | Infopark, Kochi | www.grehasoft.com")

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
