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

class MockItemsList:
    def __init__(self, items):
        self._items = [MockItem(i) for i in items]
    def all(self):
        return self._items

class MockPayment:
    def __init__(self, pay):
        self.payment_date = str(pay.get('payment_date', ''))
        self.amount = float(pay.get('amount', 0.0))
        self.payment_mode = pay.get('payment_mode', 'cash')
        self.notes = pay.get('notes', '')

class MockPaymentsQuerySet:
    def __init__(self, payments):
        self._payments = [MockPayment(p) for p in payments]
    def all(self):
        return self
    def order_by(self, field):
        return self._payments
    def exists(self):
        return len(self._payments) > 0
    def __iter__(self):
        return iter(self._payments)

class MockInvoice:
    def __init__(self, data):
        self.id = data.get('id')
        self.invoice_number = data.get('invoice_number') or data.get('invoiceNumber') or 'INV-001'
        self.issue_date = str(data.get('issue_date') or data.get('issueDate') or '')
        self.due_date = str(data.get('due_date') or data.get('dueDate') or '')
        self.status = str(data.get('status') or 'unpaid')
        self.subtotal = float(data.get('subtotal', 0.0))
        self.tax = float(data.get('tax', 0.0))
        self.total = float(data.get('total', 0.0))
        self.total_paid = float(data.get('total_paid') or data.get('totalPaid') or 0.0)
        self.balance = float(data.get('balance', 0.0))
        
        client_data = data.get('client') or {}
        if not isinstance(client_data, dict):
            client_data = {}
        if not client_data.get('name') and data.get('client_name'):
            client_data['name'] = data.get('client_name')
        if not client_data.get('phone') and data.get('client_phone'):
            client_data['phone'] = data.get('client_phone')
        self.client = MockClient(client_data)
        
        items_data = data.get('items', [])
        self.items = MockItemsList(items_data)
        
        payments_data = data.get('payments', [])
        self.payments = MockPaymentsQuerySet(payments_data)

def generate_invoice_pdf(invoice, media_root=""):
    setup_poppins_fonts()
    tmp_file = tempfile.NamedTemporaryFile(delete=False, suffix=".pdf")

    # 1️⃣ Create canvas FIRST
    p = canvas.Canvas(tmp_file.name, pagesize=A4)
    width, height = A4

    # 2️⃣ Then draw header
    header_path = find_asset(media_root, "invoice_header.png")
    if header_path and os.path.exists(header_path):
        try:
            header = ImageReader(header_path)
            p.drawImage(header, 0, height-90, width=width, height=90)
        except Exception as e:
            print("Header image error:", e, file=sys.stderr)

    # 3️⃣ Start content lower because header occupies space
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
    # COMPANY INFO / TITLE
    # -----------------------------
    p.setFont("Poppins-Bold", 16)
    p.drawCentredString(width/2, y, "INVOICE BILL")
    y -= 25

    # -----------------------------
    # STATUS BADGE CALCULATION
    # -----------------------------
    status_val = invoice.status.upper()
    if status_val == "PARTIAL":
        status_display = "PARTIALLY PAID"
        badge_color = colors.HexColor("#17a2b8")
    elif status_val == "PAID":
        status_display = "PAID"
        badge_color = colors.HexColor("#28a745")
    elif status_val == "OVERDUE":
        status_display = "OVERDUE"
        badge_color = colors.HexColor("#dc3545")
    else:
        status_display = "UNPAID"
        badge_color = colors.HexColor("#fd7e14")

    # -----------------------------
    # INVOICE INFO HEADER
    # -----------------------------
    p.setFont("Poppins", 10)
    p.drawString(50, y, f"Invoice No : {invoice.invoice_number}")
    p.drawString(190, y, f"Date : {invoice.issue_date}")
    if invoice.due_date:
        p.drawString(320, y, f"Due Date : {invoice.due_date}")

    badge_width = 110 if status_display == "PARTIALLY PAID" else 80
    badge_x = width - 50 - badge_width
    badge_y = y - 4

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
    # ISSUED BY & BILL TO PANELS
    # -----------------------------
    styles = getSampleStyleSheet()
    content_style = ParagraphStyle(
        'PanelContent',
        parent=styles['Normal'],
        fontName='Poppins',
        fontSize=9,
        leading=13
    )

    issued_by_html = (
        "<b>Grehasoft Smart IT Solutions</b><br/>"
        "Vismaya Building, Infopark Phase 1,<br/>"
        "Kakkanad, Kochi, Kerala - 682030<br/>"
        "Phone: +91 89215 40183<br/>"
        "Email: info@grehasoft.com<br/>"
        "Website: www.grehasoft.com<br/>"
        "PAN: ABCDE1234F"
    )

    client = invoice.client
    bill_to_lines = []
    if client.company_name:
        bill_to_lines.append(f"<b>{client.company_name}</b>")
    if client.name:
        bill_to_lines.append(f"Contact: {client.name}")
    if client.email:
        bill_to_lines.append(f"Email: {client.email}")
    if client.phone:
        bill_to_lines.append(f"Phone: {client.phone}")
    if client.address:
        addr_clean = client.address.replace("\n", "<br/>").replace("\r", "")
        bill_to_lines.append(f"Address: {addr_clean}")
    if client.gst_no:
        bill_to_lines.append(f"GSTIN: {client.gst_no}")

    bill_to_html = "<br/>".join(bill_to_lines) if bill_to_lines else "Valued Client"

    left_cell = Paragraph(f"<font color='#1f4e79'><b>ISSUED BY:</b></font><br/><br/>{issued_by_html}", content_style)
    right_cell = Paragraph(f"<font color='#1f4e79'><b>BILL TO:</b></font><br/><br/>{bill_to_html}", content_style)

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
    # TABLE DATA
    # -----------------------------
    data = [
        ["#", "Description", "Qty", "Rate", "Amount"]
    ]

    i = 1
    subtotal = 0.0

    items_list = invoice.items.all()
    for item in items_list:
        subtotal += float(item.amount)
        data.append([
            i,
            item.description,
            item.quantity,
            f"Rs {item.rate:,.2f}",
            f"Rs {item.amount:,.2f}"
        ])
        i += 1

    if not items_list:
        subtotal = invoice.subtotal or invoice.total or 0.0
        data.append([
            1,
            "Professional Services",
            1,
            f"Rs {subtotal:,.2f}",
            f"Rs {subtotal:,.2f}"
        ])

    # -----------------------------
    # SUMMARY ROWS
    # -----------------------------
    subtotal_row_idx = len(data)
    data.append(["", "", "", "Sub Total", f"Rs {subtotal:,.2f}"])

    gst_row_idx = len(data)
    data.append(["", "", "", "GST", f"Rs {float(invoice.tax):,.2f}"])

    grand_total_row_idx = len(data)
    data.append(["", "", "", "Grand Total", f"Rs {float(invoice.total):,.2f}"])

    amount_paid_row_idx = len(data)
    data.append(["", "", "", "Amount Paid", f"Rs {float(invoice.total_paid):,.2f}"])

    balance_due_row_idx = len(data)
    data.append(["", "", "", "Balance Due", f"Rs {float(invoice.balance):,.2f}"])

    # -----------------------------
    # TABLE STYLING
    # -----------------------------
    table = Table(data, colWidths=[40, 250, 60, 80, 100])
    
    items_count = len(items_list) if items_list else 1
    table_styles = [
        ("GRID", (0, 0), (-1, items_count), 1, colors.grey),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1f4e79")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Poppins-Bold"),
        ("ALIGN", (2, 1), (4, items_count), "RIGHT"),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
    ]

    # Style summary rows
    table_styles.extend([
        ("FONTNAME", (3, subtotal_row_idx), (4, subtotal_row_idx), "Poppins"),
        ("FONTNAME", (3, gst_row_idx), (4, gst_row_idx), "Poppins"),
        ("FONTNAME", (3, grand_total_row_idx), (4, grand_total_row_idx), "Poppins-Bold"),
        ("LINEABOVE", (3, grand_total_row_idx), (4, grand_total_row_idx), 1, colors.grey),
        ("FONTNAME", (3, amount_paid_row_idx), (4, amount_paid_row_idx), "Poppins"),
        ("FONTNAME", (3, balance_due_row_idx), (4, balance_due_row_idx), "Poppins-Bold"),
        ("LINEABOVE", (3, balance_due_row_idx), (4, balance_due_row_idx), 1, colors.grey),
        ("LINEBELOW", (3, balance_due_row_idx), (4, balance_due_row_idx), 1.5, colors.grey),
    ])

    # Highlight Balance Due
    if invoice.balance > 0:
        table_styles.extend([
            ("BACKGROUND", (3, balance_due_row_idx), (4, balance_due_row_idx), colors.HexColor("#fff3cd")),
            ("TEXTCOLOR", (3, balance_due_row_idx), (4, balance_due_row_idx), colors.HexColor("#856404")),
        ])
    else:
        table_styles.extend([
            ("BACKGROUND", (3, balance_due_row_idx), (4, balance_due_row_idx), colors.HexColor("#d4edda")),
            ("TEXTCOLOR", (3, balance_due_row_idx), (4, balance_due_row_idx), colors.HexColor("#155724")),
        ])

    table_styles.append(("ALIGN", (3, subtotal_row_idx), (4, -1), "RIGHT"))
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
    # AMOUNT IN WORDS
    # -----------------------------
    grand_total = float(invoice.total)
    rupees = int(grand_total)
    paise = int(round((grand_total - rupees) * 100))

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

    p.setFont("Poppins", 10)
    p.drawString(50, y, f"Amount in Words: {final_words.capitalize()}")
    y -= 30

    # -----------------------------
    # PAYMENT HISTORY
    # -----------------------------
    if y < 150:
        p.showPage()
        p.saveState()
        p.setFont("Poppins-Bold", 80)
        p.setFillGray(0.95, 0.15)
        p.drawCentredString(width/2, height/2, "GREHASOFT")
        p.restoreState()
        y = height - 80

    p.setFont("Poppins-Bold", 12)
    p.drawString(50, y, "Payment History")
    y -= 15

    payments = invoice.payments.all()
    if not payments.exists():
        p.setFont("Poppins", 10)
        p.drawString(50, y, "No payments received yet.")
        y -= 25
    else:
        pay_data = [["Date", "Amount", "Method", "Notes"]]
        for pay in payments:
            mode_display = {
                "cash": "Cash",
                "bank": "Bank Transfer",
                "upi": "UPI",
                "card": "Card"
            }.get(pay.payment_mode, pay.payment_mode.capitalize() if pay.payment_mode else "Cash")

            pay_data.append([
                str(pay.payment_date),
                f"Rs {float(pay.amount):,.2f}",
                mode_display,
                pay.notes or "-"
            ])

        pay_table = Table(pay_data, colWidths=[100, 100, 100, 230])
        pay_table.setStyle(TableStyle([
            ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f1f1f1")),
            ("FONTNAME", (0, 0), (-1, 0), "Poppins-Bold"),
            ("ALIGN", (1, 1), (1, -1), "RIGHT"),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
        ]))

        pw, ph = pay_table.wrap(width - 100, height)
        if y - ph < 120:
            p.showPage()
            p.saveState()
            p.setFont("Poppins-Bold", 80)
            p.setFillGray(0.95, 0.15)
            p.drawCentredString(width/2, height/2, "GREHASOFT")
            p.restoreState()
            y = height - 80
            pw, ph = pay_table.wrap(width - 100, height)

        pay_table.drawOn(p, 50, y - ph)
        y = y - ph - 30

    # -----------------------------
    # DYNAMIC FOOTER TABLE
    # -----------------------------
    bank_html = (
        "<b>Bank Details</b><br/>"
        "Account Name : GREHASOFT<br/>"
        "Bank Name : SBI<br/>"
        "Account Number : 41597828369<br/>"
        "IFSC Code : SBIN0018060"
    )

    terms_html = (
        "<br/><b>Terms & Conditions:</b><br/>"
        "1. Please quote Invoice Number in all payments.<br/>"
        "2. Payments should be made as per the agreed schedule.<br/>"
        "3. All disputes are subject to Kochi jurisdiction."
    )

    left_footer_flowable = Paragraph(f"{bank_html}<br/>{terms_html}", content_style)

    qr_flowable = None
    qr_path = find_asset(media_root, "scanpay.jpeg")
    try:
        if qr_path and os.path.exists(qr_path):
            qr_flowable = Image(qr_path, width=80, height=104)
    except Exception as e:
        print("QR image error:", e, file=sys.stderr)

    sig_html = (
        "<br/><b>For GREHASOFT</b><br/><br/><br/>"
        "_______________________<br/>"
        "Authorized Signature"
    )
    sig_style = ParagraphStyle(
        'SigStyle',
        parent=content_style,
        alignment=2
    )
    sig_flowable = Paragraph(sig_html, sig_style)

    right_cell_content = []
    if qr_flowable:
        right_cell_content.append(qr_flowable)
    right_cell_content.append(sig_flowable)

    footer_table = Table([[left_footer_flowable, right_cell_content]], colWidths=[270, 260])
    footer_table.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('ALIGN', (1, 0), (1, 0), 'RIGHT'),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
        ('TOPPADDING', (0, 0), (-1, -1), 0),
        ('LEFTPADDING', (0, 0), (-1, -1), 0),
        ('RIGHTPADDING', (0, 0), (-1, -1), 0),
    ]))

    fw, fh = footer_table.wrap(width - 100, height)
    if y - fh < 60:
        p.showPage()
        p.saveState()
        p.setFont("Poppins-Bold", 80)
        p.setFillGray(0.95, 0.15)
        p.drawCentredString(width/2, height/2, "GREHASOFT")
        p.restoreState()
        y = height - 60

    footer_table.drawOn(p, 50, y - fh)
    p.save()

    return tmp_file.name

def main():
    if len(sys.argv) < 3:
        print("Usage: python generate_invoice_pdf.py <json_input_file> <output_pdf_file>", file=sys.stderr)
        sys.exit(1)
        
    input_file = sys.argv[1]
    output_file = sys.argv[2]
    
    with open(input_file, 'r', encoding='utf-8') as f:
        data = json.load(f)
        
    invoice_data = data.get('invoice', {})
    media_root = data.get('media_root', '')
    
    mock_invoice = MockInvoice(invoice_data)
    pdf_temp_path = generate_invoice_pdf(mock_invoice, media_root=media_root)
    
    shutil.copyfile(pdf_temp_path, output_file)
    try:
        os.remove(pdf_temp_path)
    except Exception:
        pass
    print("SUCCESS")

if __name__ == '__main__':
    main()
